---
id: goal-and-requirements
type: goal-and-requirements
status: active
title: pideskthinkrails — 目标与范围
tags: [port, pi-desktop, thinkrail]
---

## 目标

把 `../dshthinkrailspec`（DSH 插件 `dsh-plugin-thinkrail`，本身是 JetBrains ThinkRail 的移植）
变成 PI-Desktop 插件，落在本仓库里，可打包、可加载、行为可与原版对照。

"行为可对照"是这一条的判据，不是"代码能跑"：7 个 `spec_*` 工具的名字、参数、判据与输出措辞，
10 篇技能的内容，spec 的判据（frontmatter 同时有非空 `id` 与 `type`），都必须与 DSH 版一致——除非
载体真的没有那个能力，那就必须在 `architecture.md` 里明说是换载体而不是丢能力。worktree 那一层是
**主动移除**（见"范围之外"），不在此列。

工作流这一侧的参照（1.4.0 起）是**上游 `JetBrains/thinkrail` 本身**，而不是 DSH 那份移植：DSH 副本仍
停在 #485 之前（`brainstorming` 还写着"太小也要过一遍"，`asking-user-questions` 还写着自由文本回复
"取代本轮"），本插件已按 #485/#486/#487/#519/#520/#517 对齐上游。所以这一侧的判据是"与上游一致"，
与 DSH 版的差异是**已知且接受**的分叉（给 DSH 版做修改在范围之外，见下）。

## 范围

在范围内：

1. 7 个模型工具（`spec_*`）接到 `pi.agent.registerTool`；
2. 面板：Specs（图树、筛选、全文检索、正文阅读）；
3. 10 篇技能经 `contributes.skills` 声明——每篇必须自足，PI-Desktop 的技能只有那一个文件；
4. 打包与预检走 marketplace 的原脚本，产物与官方发布流程同构。

范围之外：

- 发布到 marketplace（`catalog.json` 与 `packages/` 只在本地生成，不提交上游仓库）；
- 给 DSH 版做任何修改（它是只读的移植来源）；
- 新增 ThinkRail 上游没有的能力（面板不发明 spec 的写操作：写只发生在 agent 工具里）。
- worktree 层（DSH 版有、本插件曾整份移植）：按作者决定**主动移除**。宿主改成按发起调用的会话决定
  `pi.fs.*` 的根之后，那半边（自己 spawn git、拿窗口可见项目当 `-C`）无法跟随会话，是这份插件里唯一
  还能作用到错项目的能力；现在只保留工作流这一侧。

## 验收判据

- `node --test tests/*.test.mjs` 全绿，且包含三项真机检查：宿主的 `plugin-host-process`
  能装载本插件并跑通 init → panel.invoke → tool.execute → unload；宿主的 `validateManifest`
  对本 manifest 返回 `{ok: true}`；假宿主按 manifest 的 fs scope 执行（写只允许 `.md` 与
  `.thinkrail/**`，删只允许本插件写过的文件）。
- `python3 scripts/pack_plugin.py plugins/pi.thinkrail` 成功，包 < 2000 文件 / 50 MB。
- `python3 scripts/security_audit.py --check-packages` 0 blocker；每条 manual-review 信号
  都要在仓库 README 里有一句可核对的实际行为。
- 与 DSH 版逐项对照的差异表在 README 里，且每一行都能追到一次真实的载体差异。
- 面板的交互延迟以**宿主调用次数**为准来验收，而不是"感觉快"：点开一个 spec 与仓库大小、
  与上次扫描时间都无关（`tests/thinkrail.test.mjs` 里有一条 sleep 3.2 秒越过缓存窗口的回归测试）；
  首次打开面板不得等待全树枚举（`state` 立刻返回 `indexing: true`，结果由后台枚举经 `hint` 补上）。
