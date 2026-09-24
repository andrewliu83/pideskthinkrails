---
id: architecture
type: architecture-design
status: active
title: pideskthinkrails — 架构与决策
parent: goal-and-requirements
tags: [port, pi-desktop, thinkrail]
---

## 驱动

目标与范围见 `goal-and-requirements`。这里只记**设计**上的驱动。

DSH 的载体与 PI-Desktop 完全不同：那边是 cordis 的 `ctx`（tools / systemPrompt / skills /
commands 都是运行时注册表），这边是一个隔离的插件进程，拿到的只有全局 `pi` 对象和
`manifest.json` 声明式贡献。所以移植的问题不是"怎么搬 UI"，而是**哪些语义在宿主里真的
有对应物，没有的那部分该以什么形态留下**。

## 决策

- **工作区内的一切 I/O 走 `pi.fs`，不 require `node:fs`。** 权限因此是 manifest 里一份可审阅
  的契约（`fs.read` 全树读、`fs.write` 只写 `.md` 与 `.thinkrail/**`、`fs.delete` 只删自己
  写过的），越界访问降级成一次原生确认，而且宿主会先 realpath 再判定，指向工作区外的符号
  链接进不来。代价是索引从同步变异步：`SpecIndex` 的扫描变成
  `glob("**/*.md")` → `stat` → `readText`，`(mtimeMs, size)` 的重校验缓存照旧。
- **`yaml` 随包发布。** 宿主明确"依赖必须自带"，且打包器会跳过 `node_modules/`，所以 yaml 的
  node 构建（CJS 的 `dist/`）被放进 `lib/vendor/yaml/`。frontmatter 的注释保留、字段序保留、
  换行风格保留是上游写进 SPEC 的不变量，手写解析器换不来，重写它就是重新发明一个更差的
  parser。
- **技能是单文件，且描述必须 ≤240 字符。** 宿主只把技能的 name/description 编进目录，正文按
  需读取，同级文档取不到。所以 `shipping-a-pr` 的 5 篇阶段文档折成一篇的分节，引用改成
  节名；6 篇超长的 description 被改写到 240 以内——被截断的正好是"不适用于 X，改用 Y"
  那段路由信息，丢了模型就会装错技能。
- **两条常驻规则：一条进技能描述，一条由 agent 扩展还原。** DSH 用 `systemPrompt.section` 每步注入
  "先读 spec 再看代码"与"先说清这是哪一类工作"。PI-Desktop 没有 `systemPrompt.section` 那种注册式 API，
  但有两处等价物：
  ① `# Skills` 块——sidecar 把三套技能目录（内置 / 插件 / 用户）渲染成指令块，放进**每个会话的
  基础系统提示**，位置在用户 `AGENTS.md` 指令链之前（所以用户的话有最后决定权）；这条路径承载了
  "先读 spec 再看代码"（`spec-graph` 的 description）以及"什么时候用哪个技能"。
  ② `extensions/workflow-rule.mjs`（1.2.0 起，需 `agent.extension`）——在 `before_agent_start` 里把
  "入口每次都跑"**写进宿主自己的命名 prompt section**（`pi-thinkrail-workflow`），这正是上游的机制：
  上游 SPEC 写明要写 `systemPromptOptions.sections[<name>]` 且**不返回任何东西**——"so pi patches that
  one section instead of forcing a whole prompt"。宿主（0.15.6）把可改写的 `systemPromptOptions` 交给
  扩展并在钩子返回后采用它，扩展贡献的 section 渲染成 `<name>…</name>` 并**结尾于提示尾部**，所以它
  仍排在技能目录与 `AGENTS.md` 之后。1.2.0–1.4.0 走的是另一条路（返回 `{ systemPrompt }` 追加），
  理由是"宿主不给插件 prompt section"——现在这个前提**不成立**了；而那条路在宿主语义下会**丢掉所有
  结构化 section**（含别的插件贡献的），所以 1.4.1 改回与上游一致。上游的这两条规则
  各由一个扩展承载（workflow 的 `WORKFLOW_RULE`、spec-graph 的 `SPEC_RULE`）；本插件只声明一条，
  spec-graph 那半靠 `spec-graph` 的 description 与正文。两条路径的代价都记在 invariants 里：描述必须
  自带触发条件且 ≤240 字符（宿主会截断，截掉的正是路由信息）；扩展模块必须保持可审阅。技能目录的
  digest 参与 sidecar 的运行时复用判断，目录一变就重建提示，
  另一面：宿主**没有**任何界面按名字列出插件技能（`skill/list` 的规格就是 "List user-owned
  Skills"；`/` 菜单只有提示词模板 / 应用命令 / 插件命令三组），插件技能是纯模型面向的。
- **视图停在右侧工作面板里，命令靠一个 token 意向 + 便宜轮询来联动。** 宿主没有「点亮某个
  页签」的 API（官方 `pi.gitlens` 也只能弹 toast 让用户按 Mod+J），所以命令记下
  `{token, view}`，视图每 2 秒问一次 `hint` channel 并对比 token；用 token 而不是「读一次就
  消费」，是因为视图可能被挂起、也可能不止一个读者，消费式提示漏一次就永远丢了。轮询走的
  是纯内存的一跳，绝不轮询 `state`（那会走 fs 与 git）——这一条由测试盯着。
- **枚举只跑一次 glob；顶到 500 条上限就改用并发 `list` 遍历，而不是分片重扫。** 宿主的 `glob`
  在主进程里递归整棵树、一次 IPC，但单次最多 500 条匹配且**不报截断**；`list` 一次给一个目录的
  全部 size/mtimeMs，代价是每个目录一次 IPC。给 glob 加目录前缀**不会**让它少走树（宿主始终从根
  递归，pattern 只用来过滤），所以「按子目录分片重扫」在这里等于把整棵树走十几遍——实测 11678
  个目录的仓库每遍 glob 约 800 ms，而并发 `list` 跑完一遍约等于一次树遍历的 CPU 时间。上限的
  判据用**宿主原样给的回数**：过滤掉本插件忽略的目录后条数可能落到 500 以下，那也仍是「宿主
  截断了」。只有并发遍历触到深度 / 目录数刹车时才把结果标成 `specs.truncated`——「拆不动」不是
  常态。
- **枚举永不阻塞 UI，且一遍树只走一次。** 宿主的 `pi.fs.glob` 从工作区根无条件递归（pattern
  只过滤结果，满 500 条提前返回），所以「按子目录分片重扫」等于把整棵树走十几遍——实测
  11678 目录的仓库每遍 ~800 ms。因此：小仓库用一次 glob + 按目录取元数据；顶到 500 条上限时
  改用**并发 `list` 遍历**（一遍树，自带 size/mtime）。面板侧再套一层 stale-while-revalidate：
  `state` 立刻交出手里那份快照（或空快照 + `indexing: true`），后台刷新完成后经 `hint` 的
  `indexedAt` 通知视图重画。人永远不会为一次树遍历等待，而 agent 的工具读依然每次都走树。
- **枚举只跑一次 glob，元数据按目录取。** `pi.fs.glob` 给路径，`pi.fs.list` 给「一个目录里所有
  条目的 size + mtimeMs」——而 `pi.fs.stat` 一次只值一个文件。所以拿到候选路径后按父目录分组，
  每个目录 list 一次就够（573 个 .md 散在 235 个目录里 = 235 次调用，而不是 573 次）；目录条目
  顶到宿主的 1000 条上限时，只对漏掉的那几个文件退回 stat。这条把「每次读面板要发的宿主调用
  数」从 ~600 压到 ~300。

- **两条枚举路径必须看见同一棵树：忽略目录逐字节判，而且上限判据用宿主原样给的回数。** 宿主的
  `glob` 不认忽略目录（只跳 `.git/node_modules/.venv/__pycache__`），所以一次 glob 拿回的候选要
  按**段**逐字节过 `IGNORED_DIRS`；并发 `list` 遍历里的目录名同样逐字节判（上游遍历就是
  `IGNORED_DIRS.has(dirent.name)`——真名叫 `Build/` 的目录不是 `build/`，用折叠判断会把它静默
  丢掉）。过滤发生在收下回数之后：判「有没有顶到 500」用的是宿主原样给的回数，否则一个 `.md` 全
  在 `dist/` 下的仓库会把「宿主截断了」当成「就这么多」。
- **定序是逐段的，路径解析要求上一段存在过。** 上游遍历是「每层按 (NFC key, 原始名) 排序、目录与
  文件同列、逐层下降」，拍平后等价于**逐段**比较（每段先比 NFC 折叠值，再比原始名）——同层里 `a`
  小于 `a.md`，所以 `a/x.md` 先于 `a.md`。定序不只是显示顺序：重复 id 的胜者是该顺序里第一个，面板
  与工具的图都建在它之上。`resolveSpecPath` 也照上游：**只要上一段存在过**就 `list` 那一层（不要求
  它是目录），所以 `README.md/child.md` 会因为 `list` 一个普通文件失败（ENOTDIR）被拒，而不是被
  解析成一个真能写过去的 rel。
- **两处上游判据在本移植里没有对应物，只保留它们承载的区分。** ①上游先 `existsSync(root)`，不存在
  时报 `Project root does not exist: ${root}`；本插件**拿不到根路径**（宿主按会话定根，见不变量），
  所以第一段就列不出来时改报 `Project root is not readable: ${宿主自己的错误文本}`——留下的区分是
  「根不可读 ≠ 空仓库 ≠ 某个目录读不动」，代价是文案里只能是宿主的话。②上游收尾的
  `isPathInsideRoot(root, walked)` **不实现**：这里所有路径都是工作区根相对的，越界由宿主的 realpath
  拦下，判据从「本模块拒绝」变成「宿主拒绝」（与符号链接同一条机制）——这是载体差异，不是丢了
  能力。
- **详情页不依赖索引。** 点开一个 spec 只需要「校验这个路径 + 读这个文件」，而「谁引用了它」由面板
  用 state 里带下来的正向链接自己反推（`links` 随节点一起送）。曾经这里是 `index.graph()`，于是
  点击的代价取决于「上一次扫树是多久之前」——人看得越久，点得越慢，这是最难受的一种卡。现在
  点击是常数代价（与仓库大小、与上次扫描时间都无关），这一条由测试直接钉住。
- **面板读有 3 秒短期记忆，工具永远没有。** 面板是给人看的视图：点开一个 spec 只是读那一个
  文件，没有理由为它重走全树，所以面板的 `state`/`spec`/`grep` 允许复用 3 秒内的扫描结果
  （`maxAgeMs`），而工具调用一律不传这个窗口——agent 可能用通用 write/edit 工具改 spec 文件，
  插件无从感知，所以工具的读必须每次重走树。陈旧窗口只存在于人看的那一侧，且有上限；
  「刷新」按钮与窗口重新可见时带 `fresh` 绕过它，用户永远拿得到真值。
- **面板读不碰任何宿主内部对象，也不猜项目状态。** 四个 channel（`state` / `grep` / `spec`，外加只回答
  命令意向的 `hint`）就是 DSH 那条 HTTP API 的对应物，覆盖面按"面板真的消费什么"裁剪：`/slice` 在
  原版里客户端从未调用（能力仍在 `spec_graph` 工具里），`/config` 随设置页一起没了。
- **错误折叠成 `{ ok: false, error }` 返回，不向宿主抛。** 面板只关心"这次操作成不成"，
  抛出只会让 bridge 再包一层；工具侧则折叠成 `{ error }`，也是宿主认的失败形态。

## 与 DSH 版的成本差异（为什么那边"一点卡顿都没有"）

这不是移植写坏了，而是**同一件事的成本模型换了两个数量级**：

| | DSH 版 | PI-Desktop 版 |
|---|---|---|
| 读到文件系统的方式 | 插件进程内 `readdirSync` / `statSync` / `readFileSync` | 宿主的 `pi.fs.*` 网关：每次调用一次进程间往返 + 权限与 realpath 检查 + 一条审计日志 |
| 走一遍整棵树 | 一个进程内循环：**实测 644 ms**（11678 目录 / 158672 条目） | 宿主的 `glob` 也是整树递归（~800 ms，跑在主进程），但没有"顺便带元数据"的返回；要元数据就得每个目录一次 `list` |
| 结果 | 想怎么走就怎么走，没有次数上限 | 单次 glob 上限 500 条匹配且不报截断；`list` 单目录上限 1000 条 |
| 面板拿数据的代价 | 进程内函数调用 | 每次读都是一次 IPC |

所以 DSH 版"零卡顿"的真相是：**它的全树扫描只是一个本地同步循环**，而这里的每一次目录读取
都要过权限网关。移植能做的不是"恢复那个速度"，而是三条：**别在 UI 的临界路径上做它**（后台
枚举 + stale-while-revalidate）、**别重复做它**（快照窗口）、**别把它做第二遍**（一遍树，而不是
分片走十几遍）。工具侧不做任何缓存妥协——agent 可能用通用 write/edit 改文件，插件无从感知，
所以它的读必须每次走树，代价就是每次一两秒，这是宿主沙箱模型的固有价格。

## 不变量

- spec 的判据只有一条：frontmatter 同时带非空 `id` 与 `type`。移植保留判据本身，不保留上游的
  目录结构。
- 索引是派生读缓存；`(mtimeMs, size)` 没变的文件不重解析，变了的重解析，消失的逐出——
  工具永远不会读到陈旧的图。
- 任何对外失败都以工具文本 / `{ ok: false }` 返回，不让插件进程抛。
- 工作区内不发生未经声明的写入；`spec_delete` 只到系统回收站。
- 工具侧不判定项目：`pi.fs.*` 的根由宿主按**发起调用的会话**决定（宿主的 ADR 0266 / PR #427），
  所以插件的工具不读 `pi.workspace.get()`、不记忆会话见过的项目、不比对、不提示，也不在窗口没有
  激活项目时报错——那是宿主的失败，让它自己说出来。索引的身份因此是工具 `ctx` 里的 `sessionId`
  （`SpecIndex` 的第一个参数本来就只是身份，没有第二处读它）。
  宿主说读不到根时索引不把它当成空仓库（那会把失败说成成功），把宿主的错误原样交给模型。
- 面板是窗口级视图：面板调用没有会话 id，继续跟随宿主当前激活的项目，并保留「没有激活项目」的说明。
- 技能的 name 必须等于文件名，description ≤240 字符，单文件 ≤128 KiB。
- 唯一不在沙箱内的代码是 `extensions/workflow-rule.mjs`（声明为 `contributes.agentExtensions`，需要 `agent.extension`）：它在 **agent 进程内**挂 `before_agent_start`，把固定规则写进宿主具名 section `pi-thinkrail-workflow`，返回空对象，绝不返回 `systemPrompt`。宿主要求 section 名匹配 `/^[a-z][a-z0-9_-]*$/` 且不能为 `preamble`；违规会在拼装提示时抛错。
  当前宿主兼容下限是 PI-Desktop `0.15.6`。section 排在宿主内建内容之后并结尾于 prompt 尾部；运行时若无 section map，扩展安全地不贡献规则，不回退到强制整条提示。
  本地路由策略按用户选择恢复 pre-#485 宽入口：每个新请求（含问题）先读 root router；任何项目变更都进入 brainstorming，不因小或约束明确而跳过。另有 PI-Desktop 首会话 onboarding 前置规则：对附加项目的首条请求，若已有源码但不存在 durable spec（Markdown frontmatter 同时含非空 `id`/`type`，且路径不在 `.thinkrail/context/`），先运行 `setting-up-a-project` → `importing-a-codebase`，完成后续接原请求；已有 durable graph 跳过，未附加项目的聊天不触发。
  规格查询遵循 specs-before-code：探索、调查、规划、实现或检查任务时先读相关规格，再读代码。上游第二条 `pi-spec-graph` 常驻规则没有单独扩展，由 `spec-graph` 技能正文承载。
  模块必须可审阅：无 import、无 require、不碰文件系统与网络、只写自己的 section；测试核对宿主 runner、section composer 与入口规则。路由范围是有意的本地分叉，改变时同时更新 `writing-workflow-skills` 元规则、扩展、技能、测试和本文。

## 范围之外

- 不做 DSH workspace 侧栏的等价物（宿主没有让插件开项目页签的 API，只能登记进项目列表）。
- 不在面板里做 spec 的写操作：写只发生在 agent 工具里，与人手编辑文件这两条路上。
- 不引入构建步骤：插件进程直接 require 源码，`pack_plugin.py` 打的就是这些文件。
