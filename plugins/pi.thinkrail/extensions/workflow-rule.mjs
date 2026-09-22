// 无条件常驻规则 —— 本插件唯一一处跑在 agent 进程里的代码。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
//
// 宿主把插件的技能目录放进基础系统提示（每轮都在），但那段文本的框架语是**条件式**的：
// "When a task matches a skill's description, load the skill first and follow it"。于是根路由器
// 到底会不会被读到，取决于模型愿不愿意把当前任务读成「匹配」。实测（本机 8 个会话、插件装好后）：
// 只有明说要 spec 的那两次进了工作流链路，连一次「把某个仓库移植到当前项目」的改动请求都没加载任何技能。
//
// 上游 ThinkRail 用一条常驻规则解决这件事（`packages/pi-thinkrail-workflow/index.ts` 里的
// `WORKFLOW_RULE`，经 `pi.on("before_agent_start", …)` 追加进 systemPrompt）。PI-Desktop 里插件
// 拿不到 prompt section 的位置，但**有 ExtensionAPI**：声明 `agent.extension` 权限 +
// `contributes.agentExtensions`，就能挂同一个钩子。宿主 sidecar 的实现（`extensionBeforeAgentStart`）
// 是：
//
//   base = this.composeSystemPrompt()   // 运行时规则 → 技能目录 → 可选工具 → AGENTS.md → 项目记忆
//   result = await runner.emit("before_agent_start", { …systemPrompt: base })
//   this.agent.state.systemPrompt = result.systemPrompt ?? base
//
// 它在**每次 agent.prompt() 之前**调用，且每轮的 base 都是重新拼的，所以本模块的追加不会累积
// （下面的幂等判断是给「宿主把追加过的提示又发回来」那种情况兜底）。返回的文本排在技能目录、
// AGENTS.md、项目记忆**之后** —— PI-Desktop 里最强的指令位置，比项目自己的 AGENTS.md 还靠后。
//
// ── 代价（用户批准时看到的就是这条） ──────────────────────────────────────────
//
// 这个模块运行在 agent 进程内，权限等同于 agent 自己的工具：它不再受本插件的 fs 网关约束。所以它
// 刻意保持可审阅：**没有任何 import**、不碰文件系统、不发起网络请求，剥掉注释后只有十几行代码。
// 旧宿主若不认识 `contributes.agentExtensions`，只是静默不生效——宿主的 manifest 校验只读取它认识的
// 键、不枚举多余的键（已用宿主自己的校验器核实），插件照常安装，其余功能不受影响。
//
// ── 规则的来源，以及本地只剩的那一处差异 ─────────────────────────────────────
//
// 规则前三句**逐句照搬上游**：`0a41d5d`（#485）把入口收窄成「onboarding / PR 生命周期 / 仍有产品与
// 设计选择未决」三类，并要求已路由的工作继续做、其余直接做且不做路由声明。本插件曾有两处有意差异，
// 现在只剩一处：
//
//   1. 上游旧规则的触发词是 "a request, feature, change, fix, or fresh project idea"，而路由器自己
//      的 description 声称包含问题——上游 `skills/SPEC.md` 把这处漂移记为已知缺陷。本插件曾让常驻
//      规则显式写出「纯提问不需要路由」来对齐两侧。**#485 已把这处漂移修掉**：规则第三句的
//      "otherwise proceed directly" 就是它，路由器 description 也把问题写进了排除项，所以这里不再重复。
//   2. **要求先确认项目有没有 spec 图。** 这不是给路由器加一条新路由，而是把分类表第一行的前提
//      （"no spec graph yet"）提到分类之前：有代码、没有 spec 的项目，用户应当拿到 onboarding 这个
//      选择，而不是被悄悄当成普通工作。路由仍然由 `choosing-a-workflow` 决定——它的红榜写着
//      "a forced route is worse than none"，所以这里只说「先确认、并把选择交给用户」，不指定结果。
//
// 改动这段规则属于「系统级改动」：按本插件 `skills/writing-workflow-skills.md` 的元规则 13，先改那里
// 的元规则与家族表，再改这里。

/** 每轮追加到系统提示末尾的文字。 */
export const WORKFLOW_RULE = [
	"At the start of a new piece of work, read the `choosing-a-workflow` skill (Skill tool, id `pi.thinkrail/choosing-a-workflow`) for project onboarding or any PR lifecycle work.",
	"For other new changes, read it only when product scope, user-visible behavior, or architecture remains to decide.",
	"Continue work already routed to a workflow without routing it again; otherwise proceed directly without loading or announcing one.",
	"Before classifying, check whether the project has a spec graph at all: an existing codebase with none is the onboarding case, so say so and let the user decide rather than treating the project as ordinary work.",
].join("\n");

/**
 * ExtensionAPI 工厂。宿主用 jiti 加载本文件，把默认导出当工厂调用。
 *
 * 只挂一个钩子：`before_agent_start`（在宿主的 `TRUSTED_EXTENSION_EVENTS` 与 `RESULT_EVENTS` 里，
 * 也就是允许返回值）。
 */
export default function workflowRule(pi) {
	if (typeof pi?.on !== "function") return; // 宿主 API 换了形状：什么都不贡献，也不抛错
	pi.on("before_agent_start", (event) => {
		const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
		// 宿主用返回值**覆盖**系统提示（`result.systemPrompt ?? base`），所以这里有两处必须返回空对象：
		//   * base 不是字符串（宿主换了事件形状）——返回只有规则的那一份会把整串基础提示替换掉；
		//   * 已经追加过（宿主把追加后的提示又发回来）——保持幂等。
		if (!base || base.includes(WORKFLOW_RULE)) return {};
		return { systemPrompt: `${base}\n\n${WORKFLOW_RULE}` };
	});
}