// 无条件常驻规则 —— 本插件唯一一处跑在 agent 进程里的代码。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
//
// 宿主把插件的技能目录放进基础系统提示（每轮都在），但那段文本的框架语是**条件式**的：
// "When a task matches a skill's description, load the skill first and follow it"。于是根路由器
// 到底会不会被读到，取决于模型愿不愿意把当前任务读成「匹配」。实测（本机 8 个会话、插件装好后）：
// 只有明说要 spec 的那两次进了工作流链路，连一次「把某个仓库移植到当前项目」的改动请求都没加载任何技能。
//
// ── 上游怎么做，以及这里为什么跟它一样 ───────────────────────────────────────
//
// 上游 ThinkRail 用两条常驻规则解决这件事，各由一个扩展承载，而且**投递方式写进了它的规格**
// （`packages/pi-thinkrail-workflow/SPEC.md:38-41`、`packages/spec-graph/SPEC.md:74-80`）：
// `pi.on("before_agent_start", …)` 里把规则**写进 `event.systemPromptOptions.sections`** 这个命名
// 槽位（`pi-thinkrail-workflow` / `pi-spec-graph`），**并且不返回任何东西**——"so pi patches that one
// section instead of forcing a whole prompt"。上游明确拒绝另一条路：返回 `{ systemPrompt }` 会**强制
// 整条提示**，而宿主在那种情况下的语义是丢掉**所有**结构化 section（包括别的插件贡献的）。
// 上游 `index.test.ts` 把这两件事都钉住了（section 名下的值、返回 undefined、渲染块结尾于提示尾部）。
//
// PI-Desktop 这边的载体：声明 `agent.extension` 权限 + `contributes.agentExtensions` 就能挂同一个
// 钩子，而宿主给插件的事件形状**与上游同源**。已按本机 0.15.6 的 `agent-runtime/sidecar.js` 核实：
//
//   * `emitBeforeAgentStart` 传给每个扩展的是 `{ …, get systemPrompt(), systemPromptOptions }`，
//     其中 `systemPromptOptions` 是经过 clone 的、**可被扩展改写**的那一份，钩子返回后它被采用
//     （`_runSystemPromptOptions = m.systemPromptOptions`）。所以写 `sections[name]` 就是有效投递。
//   * section 名有约束：`/^[a-z][a-z0-9_-]*$/` 且不能叫 `preamble`，违规会在拼装提示时**抛错**
//     （`Invalid system prompt section name`）。`pi-thinkrail-workflow` 合法；带点的插件 id
//     （`pi.thinkrail`）**不能用**。这条约束由 `tests/manifest-host-check.test.mjs` 对着宿主的
//     正则盯住，免得哪天改名把整条提示弄炸。
//   * 扩展贡献的 section 排在宿主内建那些之后，渲染成 `<pi-thinkrail-workflow>…</pi-thinkrail-workflow>`
//     并**结尾于提示尾部** —— 也就是 PI-Desktop 里最强的指令位置，比项目自己的 AGENTS.md 还靠后。
//   * 钩子在**每次 prompt 之前**调用，每轮都由宿主重新拼装，所以写进去不会累积。
//
// 代价（用户批准时看到的就是这条）：这个模块运行在 agent 进程内，权限等同于 agent 自己的工具，
// 不再受本插件的 fs 网关约束。所以它刻意保持可审阅：**没有任何 import**、不碰文件系统、不发起网络
// 请求，剥掉注释后只有十几行代码。宿主若不认识 `contributes.agentExtensions`（或那个宿主版本没有
// section 表），这里就什么都不做、也不抛错——规则静默缺席，而不是退回强制整条提示那条路。
//
// The entry scope is a family contract; see writing-workflow-skills.md, meta-rule 4.
// PI-Desktop needs an explicit Skill id because its skill catalog is addressed by id.
//
// 改动这段规则属于「系统级改动」：按本插件 `skills/writing-workflow-skills.md` 的元规则 13，先改那里
// 的元规则与家族表，再改这里。

/** 规则注入系统提示时占用的 section 名（宿主的约束：小写、`[a-z0-9_-]`、不可为 `preamble`）。 */
export const WORKFLOW_SECTION = "pi-thinkrail-workflow";

/** 每轮注入系统提示的那一节文字。 */
export const WORKFLOW_RULE = [
	"At the start of any new piece of work — a request, feature, change, fix, question, or fresh project idea —",
	"read the `choosing-a-workflow` skill (Skill tool, id `pi.thinkrail/choosing-a-workflow`) FIRST and follow it: it routes the work to the workflow skill",
	"that governs it, or tells you none applies.",
	"At the first request in a project session, if source code exists but no durable spec graph exists, finish project setup before handling that request — whatever it asks — then return to it. A temporary task-spec under `.thinkrail/context/` does not count as a durable graph; a chat without an attached project is not a project session.",
].join("\n");

/**
 * ExtensionAPI 工厂。宿主用 jiti 加载本文件，把默认导出当工厂调用。
 *
 * 只挂一个钩子：`before_agent_start`（在宿主允许返回值的那个事件集里）。
 */
export default function workflowRule(pi) {
	if (typeof pi?.on !== "function") return; // 宿主 API 换了形状：什么都不贡献，也不抛错
	pi.on("before_agent_start", (event) => {
		const sections = event?.systemPromptOptions?.sections;
		// 没有 section 表（老宿主）就什么都不做：另一条路是返回 `{ systemPrompt }`，宿主语义是**强制
		// 整条提示**并丢掉所有结构化 section，上游正是不用那条路——宁可这里静默缺席，不去覆盖别人。
		if (!sections || typeof sections !== "object") return {};
		sections[WORKFLOW_SECTION] = WORKFLOW_RULE;
		return {};
	});
}