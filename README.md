# pideskthinkrails

把本地的 `dsh-plugin-thinkrail`（DeepSeek Harness 插件，`../dshthinkrailspec`）移植成
PI-Desktop 插件。产物是 `plugins/pi.thinkrail/`（一个**停在右侧工作面板里的视图**），可以直接丢进
[pi-desktop-plugins](https://github.com/vastsa/pi-desktop-plugins) 的 `plugins/`，也可以在
PI-Desktop 里用 **Plugins → Load dev plugin** 直接加载。

本仓库的目录布局与 marketplace 仓库一致，`scripts/` 下的打包与审计脚本是它的原件照抄
（见 `reference/README.md`），所以本地跑出来的 `.piplug` 与官方发布流程产出的东西同构。

## 快速开始

```bash
# 打包（产物：packages/pi.thinkrail-<version>.piplug）
python3 scripts/pack_plugin.py plugins/pi.thinkrail

# 发布前的自动预检：0 blocker 才算过
python3 scripts/security_audit.py --check-packages

# 全部测试
node --test tests/*.test.mjs
```

在 PI-Desktop 里安装：**Plugins → Load dev plugin** 选 `plugins/pi.thinkrail`，
或 **Install plugin package** 选上一步的 `.piplug`，然后**重开应用**（视图是装载时注册的）。

装好之后**怎么看到它**：ThinkRail 不是一个独立窗口，也不在文件树里——它是右侧工作面板里的一个
页签。按 `Mod+J` 打开工作面板，在页签列表里选 **ThinkRail**；或者 `Mod+K` 打开命令面板输入
`ThinkRail`。插件没有任何 API 能点亮自己的页签（宿主的边界），所以两个命令只会记下"你想看哪一页"
并弹一个 toast 指路，视图每 4 秒问一次这个意向，读到就自己切过去。

## 布局

```
plugins/pi.thinkrail/
  manifest.json        身份、权限、fs scope、命令/工具/技能的声明
  main.js              入口（CJS）：onLoad / onUnload / onPanelInvoke
  lib/
    host.js            globalThis.pi 的唯一取值点
    fio.js             工作区 I/O 网关：pi.fs 的薄适配，工作区内读写全走这里
    project.js         面板用的「可见项目」：pi.workspace.get() 的唯一取值点
    spec/              spec-graph 模型（parse / graph / query / store / validate）
    tools/             7 个模型工具
    panel.js           面板后端：state / grep / spec / hint 四个 channel
    vendor/yaml/       随包发布的 yaml（宿主不做 npm install，依赖必须自带）
  renderer/            面板页面（隔离页面，只经 pluginBridge 说话）
  skills/              10 篇技能，每篇一个自足文件
  extensions/          workflow-rule.mjs：唯一跑在 agent 进程内的代码（无条件常驻规则）
tests/                 41 个测试，含宿主装载、manifest 校验、section 投递与 fs 路径 containment 检查
```

## 移植面：什么被搬过来了，什么换了载体

| ThinkRail / DSH | PI-Desktop | 说明 |
|---|---|---|
| `ctx.tools.register` + 原始 JSON Schema | `pi.agent.registerTool` | 现在 7 个工具（`spec_*`）的名字、参数、判据、输出措辞逐字保留；风险分级为 low/medium/high。原版的 6 个 `worktree_*` 工具随 worktree 层主动移除（见下） |
| `ctx.skills.register` + `resourceBase` | `contributes.skills` | 声明式，一个技能一个文件。`shipping-a-pr` 的 5 篇阶段文档折成一篇的分节 |
| 两条常驻 `systemPrompt.section` 规则 | `agent.extension` + `before_agent_start`（`extensions/workflow-rule.mjs`） | 上游把规则写进宿主具名 section，本插件同机制写 `pi-thinkrail-workflow`，不返回 `systemPrompt`。每个新请求先读 router；首条项目请求若有源码但无 durable graph，则先自动 setup/import（忽略 `.thinkrail/context/` 临时 TASK），完成后续接原请求；已有图或无项目聊天跳过。任何项目改动都进入 brainstorming。
| `ctx.workspaceRegistry.create()` | 无 | **主动移除**。worktree 层按作者决定主动移除：宿主改成按发起调用的会话决定 `pi.fs.*` 的根之后，那半边（自己 spawn git、拿窗口可见项目当 `-C`）无法跟随会话，是这份插件里唯一还能作用到错项目的能力 |
| `${DSH_HOME}/thinkrail/*.json` | 无（`contributes.settings` 为空） | **主动移除**（同上，worktree 层）：花名册不再写也不再读；原版这里存的两项设置都是 worktree 专用，插件现在 0 个设置，没有设置页 |
| `/dsh-thinkrail/*` HTTP API | `onPanelInvoke` 的 channel | 只保留面板真正消费的：`state` / `grep` / `spec` / `hint`；`/slice`（客户端从未调用）、`/config`（设置随 worktree 层一起移除）与 `worktree` channel（同上，worktree 层主动移除）删除 |
| 宿主文件页签打开 spec 正文 | 面板内 `spec` channel | PI-Desktop 没有 `openResource`，正文就在面板里读 |
| `node:fs` 直接读写工作区 | `pi.fs.*` | 权限在 manifest 里可审阅；越界的访问降级成一次原生确认而不是静默成功；删除走系统回收站 |
| 会话 cwd | 宿主按发起调用的会话决定 `pi.fs.*` 的根（宿主 ADR 0266） | 每个 `pi.fs.*` 调用都解析到**发起调用的那个会话**所属的项目，所以工具跟着会话走；插件自己不读 `pi.workspace.get()`、不记忆会话见过的项目、不比对、不提示，也不在窗口没有激活项目时报错——那是宿主的失败，让它自己说出来。面板是窗口级视图、没有会话 id，所以仍跟随宿主当前激活的项目（`lib/project.js`） |

移除没有删掉磁盘上的任何东西：已有的 git 工作树仍登记在 git 里，用 `git worktree list` 列出来、`git worktree remove <path>` 删掉；旧的花名册留在插件数据路径（`pi.plugin.getDataPath()`）下的 `workspaces.json`，已经没有代码读它。

DSH 版与上游 ThinkRail 的对应关系（哪些是移植、哪些是有意偏差）记在
`../dshthinkrailspec/SPEC.md` 与各 `lib/*/SPEC.md` 里，本移植不改那些判据。

## 验证

- `node --test tests/*.test.mjs` —— 41 个测试全绿。五项依赖本机 PI-Desktop bundle 的检查在应用缺失时自动跳过：
  - `host-load.test.mjs`：用 PI-Desktop 自己的 `plugin-host-process.js` 装载插件，验证注册与 IPC 转发路径（init → panel.invoke → tool.execute → unload）；测试端模拟宿主 API 响应，包括 `fs.*`。
  - `manifest-host-check.test.mjs`：检查宿主 manifest validator、`# Skills` 渲染器、section runner，以及真实 host bundle 中的 fs resolver。
    新增 symlink fixture 从宿主 main bundle 提取并执行 `resolveFsRequest`、`resolveRealPathWithinRoot` 和 `resolveRealPathForCreateWithinRoot`，对临时 workspace 的文件/目录链接验证项目外读写被拒。
  - `thinkrail.test.mjs`：假宿主按 manifest scope 拒绝越界写入，验证插件声明的调用范围。
- **边界说明：**symlink fixture 执行宿主原始路径 resolver，但将权限/scope 与文件 API 调用端控制在测试中；`host-load` 的 `fs.*` 响应也是 mock。因此它验证 resolver 的真实 realpath containment，不等同于完整 Electron IPC、授权 UI 或并发 symlink race 的端到端测试。
- `python3 scripts/pack_plugin.py plugins/pi.thinkrail` 生成当前包 `packages/pi.thinkrail-1.5.1.piplug`（git 忽略，不随源码提交）。
  130 个文件，ZIP 564807 字节，解压 545465 字节；sha256 `3694c1057f6eb463d566e4758c76f7829386eaf3c03163b570a36303fe4524fe`。
- `python3 scripts/security_audit.py --check-packages` —— 当前 1.5.1 包审计 **0 blocker、4 条 manual-review 信号**；自动检查通过，人工复核信号见下。
  脚本是 marketplace 工具的**原件照抄**，`agent.extension` 会被它作为未知权限报给宿主策略复核——那是预期信号，不是缺陷。
- 索引与面板读路径在真实项目上量过（`直播`，11672 个目录 / 573 个 `.md` / 11 个 spec），
  单位是**宿主的 fs API 调用次数**——每次调用都是一趟进程间往返外加宿主一条审计日志：

  **为什么这里说「一次 glob = 一遍整棵树」**：宿主 `pi.fs.glob` 的实现是
  `visit2(realpathOrSelf(root))` —— 永远从工作区根递归，pattern 只用来过滤结果。所以给 glob
  加目录前缀**不会**让它少走树，而且它满 500 条匹配就提前返回。这就解释了 app 日志里那串
  「每 800 ms 一次 glob」：每个稀疏前缀（`.commandcode/**/*.md` 只有 2 个匹配）都得走完整棵树。
  本机实测一遍完整递归（11678 目录 / 158672 条目，含每个条目 statSync）= **644 ms**，与 800 ms 吻合。

  | 动作 | 修复前 | 现在 |
  |---|---|---|
  | 打开面板 / 刷新时的枚举 | 分片 glob：**13–20 遍整树 ≈ 10–16 s** | **一遍树**（并发 `list`，约 10.6k 次调用 ≈ 1.5–2 s），且在**后台**跑 |
  | 点开一个 spec 读正文 | ~600 次调用（两个全盘扫描，宿主 30 秒超时） | **2–4 次**（路径校验的 1–3 次 list + 1 次 readText），与「上次扫树是多久之前」无关 |
  | 窗口内再次读 state | 一遍树 | **0 次 fs 调用**（直接交出手里的快照；快照过期只在后台补扫，这次调用不等待） |

  **UI 永远不等枚举**：首次 `state` 立刻返回 `{indexing: true}`，视图先开出来并显示「正在建立
  spec 索引…」，后台枚举完成后通过 `hint` 轮询把快照交上来，视图自己重画。

### 审计的 4 条信号

| 信号 | 实际是什么 |
|---|---|
| `unknown permission: fs.delete`、`agent.extension` | 审计脚本的 `KNOWN_PERMISSIONS` 比宿主旧；两个权限宿主都认（`validateManifest` 已过）。`agent.extension` 只用于 `extensions/workflow-rule.mjs`，而那是个无 import、不碰 fs/网络、只写入自己的命名 prompt section 且不返回 `systemPrompt` 的模块——见下文「无条件常驻规则」 |
| `renderer/appearance.js` timer | 上游 `plugins/shared/appearance` 的原件（可见时轮询宿主外观），照抄不改 |
| `renderer/panel.js` timer | 视图每 4 秒问一次「命令想让我显示哪一页」（一次 IPC，不碰 fs / 不跑 git）——插件点不亮自己的页签，只能这样发现命令的意向；官方 `pi.gitlens` 同样在轮询，只是它轮询的是全量状态 |

## 升级已装好的那份

宿主安装插件时会**复制**到 `~/.pi-desktop/plugins/installed/<id>/`，仓库里的改动不会自动过去。1.5.1 修好了常驻规则的投递通道（0.20.x 换了 runner 导致规则静默失效）；若已安装旧版，需要更新安装：

1. **Plugins → Install plugin package** 选择 `packages/pi.thinkrail-1.5.1.piplug`；若不能覆盖，先 Remove 再装。
2. 或用 **Plugins → Load dev plugin** 选择 `plugins/pi.thinkrail`，直接运行当前源码。
3. 安装/加载后按 `Mod+J` 打开 ThinkRail 面板。

## 技能在哪里（为什么"设置 → 技能"里看不到）

**结论：技能已经注入了，只是没有任何 UI 会把插件技能按名字列出来。**

PI-Desktop 有三套技能目录，最后**合并成同一段提示**送给模型：

| 目录 | 来源 | 会出现在「设置 → 技能」吗 |
|---|---|---|
| 用户技能 | `~/.agents/skills/`、`<项目>/.agents/skills/` | **会**（那一页的接口就是 `listUserSkills` / `createUserSkill`…） |
| **插件技能** | 插件 manifest 的 `contributes.skills`（本插件这 10 篇） | **不会**，UI 里只有插件行上的一个 `skills` 能力徽章 |
| 内置技能 | 应用自带（只用于插件开发） | 不会 |

`agent.prompt.inject` 不是"给一份目录让模型自己挑"——sidecar 把三套目录渲染成一段 `# Skills`
指令块，放进**每个会话的基础系统提示**。sidecar 自己的注释写得很清楚：

```js
// Plugin skills (D174): the catalog rides in the base prompt so a
// path-scoped instruction reload never drops it, and it stays ahead of
// the instruction chain so the user's own AGENTS.md keeps the last word.
```

每条是 `- \`id\` — name: description`，并附一句指令：

> When a task matches a skill's description, load the skill first and follow it; do not guess at its
> content.

所以**描述就是常驻指令**（这也是我把 6 条过长的描述改写到 240 字符以内的原因——超出的部分会被
宿主截断，而被截掉的正好是"不适用时该用什么"那半句路由信息），**正文由模型按 id 用 `Skill`
工具按需取**。这一块 + `1.2.0` 起的常驻规则（`extensions/workflow-rule.mjs`，见下节）才是 DSH 常驻规则的等价物。
该规则的**投递通道**随宿主版本二选一：宿主提供具名 prompt section 表时（0.15.x–0.19.x 与上游 pi）写自己的
`pi-thinkrail-workflow` section；宿主没有那张表时（0.20.x 起把 options 硬编码成空对象、只认返回的
`systemPrompt` 字符串）把同一段文字用 `<pi-thinkrail-workflow>` 标签包好追加到提示尾部——1.5.1 之前只写
section，于是在 0.20.x 上静默失效，规则根本没到过模型。当前 1.5.1
开发源恢复 pre-#485 宽入口：每个新请求先过 router，任何项目改动都进入 brainstorming，不因规模小或规格明确
而跳过。另在附加项目会话的首条请求前检查 durable graph：有源码但无图时自动 setup/import，再续接原请求；已有图
或无项目聊天跳过自动 setup。已打包的旧 1.5.0 及更早产物不包含这条通道，安装前请使用 1.5.1 包或 Load dev plugin。

这段块在会话运行时构造时生成，但**不需要新开会话**：sidecar 的 `canReuse(config)` 把技能目录的
digest 也算进"能不能复用这个运行时"的判断里，并注明——

```js
// Enabling a plugin, revoking agent.prompt.inject or renaming a skill
// changes the catalog digest, which retires the runtime and its stale
// prompt. Bodies are excluded: the Skill tool always reads them fresh.
```

所以目录一变（装上插件、改了技能名），**下一条消息就会重建运行时并带上新的提示**。（官方示例插件
`pi.workspace-file-guard` 的 README 说要新开会话，是更保守的说法；代码是自动失效的。）

**但界面上没有任何地方按名字列出插件技能**——这是这一整套的唯一"看不到"的原因：

- 「设置 → 技能」的接口在应用自己的规格里写死了：`spec("skillList", "skill/list", "List user-owned Skills.")`，只列 `~/.agents/skills` 与 `<项目>/.agents/skills`。
- 输入框的 `/` 菜单只有三组：`slashGroupTemplates`（提示词模板）、`slashGroupApp`（应用命令）、`slashGroupPlugins`（**插件命令**）——你看到的 `thinkrail:open` 就在"插件命令"里；**没有技能分组**。
- 121 个渲染层资源里，与技能相关的 UI 只有 `listUserSkills` / `createUserSkill` / `importUserSkill` / `updateUserSkill`（都指向用户技能目录）。

所以想确认这 10 篇在不在，只有两条路：问 agent（它的基础提示里有这段块），或者读源码（见上）。
自己匹配（“帮我给这个项目建 spec 图”）。常驻规则把**每个新请求**都送到 `choosing-a-workflow`。首条项目请求发现
源码且无 durable graph 时，先完成 setup/import，再回到原请求；否则 router 将项目变更交给 brainstorming（无论大小/是否
已明确），并把问答/解释/检查判为无 worker 后直接处理。已有图的首条请求不会自动 setup。
`tests/manifest-host-check.test.mjs` 里有一条测试把这段文本**用 sidecar 自己的渲染函数**跑出来校验——
10 条 id、完整描述、以及"描述不得超过 240 字符"，任何一条退化都会让测试红掉，而不是悄悄把提示变差。
那个渲染函数是**按结构定位的，不按名字**：宿主 0.15.6 就把它压成了单字母名（块里引用的 `Skill`
工具名也换了个标识符），按名字切会让这条真机测试误红——改名是宿主的内部细节，`# Skills` 这个
字面量才是契约的锚。宿主哪天**真的**不再渲染这个块，它会以一句"重新读一遍插件技能怎么到 agent
手上"失败，而不是跳过。（240 字符这条线由主进程装载插件时执行：超长描述会被切成 239 + `…`。）

要在此之上再加项目级规则（比如"本仓库的 spec 在 `crates/*/SPEC.md`"），写进项目的 `AGENTS.md`：
它是技能块**之后**加载的分层指令链（`AGENTS.md` / `CLAUDE.md` / `AGENTS.override.md` /
`.claude/CLAUDE.md` + 全局 `~/.pi/agent/AGENTS.md`，整链 32 KiB 预算），所以用户自己的话有最后
决定权。

## 已知缺口

- **没有在 GUI 里肉眼确认过视图的渲染与主题跟随。** 装载链是拿宿主的
  `plugin-host-process` 真机验的（见上），索引与视图后端在真实项目上量过（见下），但
  「在工作面板里长什么样」只能你自己看一眼。
- **索引枚举是「glob + 按需分片」**：宿主的 glob 单次上限 500 条匹配且不报截断，所以拿到 500 条
  时会按下一层子目录把 pattern 拆小重扫，直到每片都低于上限；拆不动（比如一个目录自己装了 500+
  个 `.md`）或触到递归刹车时会**显式标记** `specs.truncated`，面板上会写「索引可能不全」。
  逐目录 `list` 一遍看似更直接，实测在 11k 目录的仓库上要 11k 次 IPC，比现在贵 200 倍。
- **代码注释是中文**，与 marketplace 仓库 AGENTS.md 的「English only」不一致：注释继承了
  被移植的那份源码的语言。标识符、模型可见的文案、manifest、README 都是英文。
- **没有设置页，也没有任何设置**：原版的两个设置（登记工作树为项目、工作树根目录）只服务
  worktree 层，随它一起移除，manifest 的 `contributes.settings` 现在是空的；deeplink / 快捷键
  也是 DSH 版本来就没有的。

## 文档

- `goal-and-requirements.md` —— 这次移植的目标、范围与验收判据。
- `architecture.md` —— 设计决策与不变量。
