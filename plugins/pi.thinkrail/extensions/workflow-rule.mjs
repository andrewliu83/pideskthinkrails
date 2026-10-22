// 无条件常驻规则 —— 本插件唯一一处跑在 agent 进程里的代码。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
//
// 宿主把插件的技能目录放进基础系统提示（每轮都在），但那段文本的框架语是**条件式**的：
// "When a task matches a skill's description, load the skill first and follow it"。于是根路由器
// 到底会不会被读到，取决于模型愿不愿意把当前任务读成「匹配」。实测（本机 8 个会话、插件装好后）：
// 只有明说要 spec 的那两次进了工作流链路，连一次「把某个仓库移植到当前项目」的改动请求都没加载任何技能。
//
// ── 两条投递通道，为什么现在必须有第二条 ─────────────────────────────────────
//
// 上游 ThinkRail 把规则写进 `before_agent_start` 的 `event.systemPromptOptions.sections` 命名槽位
// （`packages/pi-thinkrail-workflow/SPEC.md:38-41`），并明确拒绝返回 `{ systemPrompt }`——上游宿主
// 在那种情况下的语义是丢掉所有结构化 section。**通道 1 保留，就是为了那些人。**
//
// 但 PI-Desktop 0.20.x 换了 runner，这条通道已经不通。按本机 0.20.1 的
// `agent-runtime/chunks/runner-4RVVP4BP.js` 核实：
//
//     async emitBeforeAgentStart(e,n){
//       let s={type:"before_agent_start",prompt:e,systemPrompt:n,systemPromptOptions:{}};
//       return (await this.emit("before_agent_start",s,(i,r)=>
//         typeof r.systemPrompt!="string" ? i??{} : (s.systemPrompt=r.systemPrompt,{systemPrompt:r.systemPrompt})
//       ))?.systemPrompt
//     }
//
//   * `systemPromptOptions` 是**硬编码空对象**，宿主从不往里面放 `sections`；
//   * 合并器只认 `r.systemPrompt` 字符串，**完全不读** `s.sections`。
//
// 于是「写 sections」在 0.20.1 上写进了一个每轮新建、随后被丢弃的空对象：钩子返回 `{}`，宿主拿不到
// 任何东西，规则静默缺席。这正是「插件还在、路由却不触发」的成因——不是技能坏了，是注入通道断了。
//
// 0.20.x 里串行合并是**前一个的返回值作为下一个的输入**（已实测：第二个扩展看到的 `systemPrompt`
// 已含第一个追加的块），所以多个插件各自追加自己的块不会互相吃掉。代价是返回 `{ systemPrompt }`
// 意味着整条提示由我们这轮交回——但 0.20.x 里本来就没有任何插件能贡献 section（通道已死），
// 这个代价现在等于零；而通道 1 存在时我们仍然优先走通道 1，不去接管整条提示。
//
// ── 幂等 ─────────────────────────────────────────────────────────────────────
//
// 追加以 `WORKFLOW_SECTION` 包成的块为标记：已经含这个块就原样返回 `{}`。于是宿主重跑钩子、
// 或同一轮被调用两次，都不会堆叠出多份规则。
//
// 代价（用户批准时看到的就是这条）：这个模块运行在 agent 进程内，权限等同于 agent 自己的工具，
// 不再受本插件的 fs 网关约束。所以它刻意保持可审阅：**没有任何 import**、不碰文件系统、不发起网络
// 请求。宿主若不认识 `contributes.agentExtensions`，或连 `before_agent_start` 都没有，
// 这里就什么都不做、也不抛错——规则静默缺席，而不是把整条提示弄坏。
//
// The entry scope is a family contract; see writing-workflow-skills.md, meta-rule 4.
// PI-Desktop needs an explicit Skill id because its skill catalog is addressed by id.
//
// 改动这段规则属于「系统级改动」：按本插件 `skills/writing-workflow-skills.md` 的元规则 13，先改那里
// 的元规则与家族表，再改这里。

/** 规则注入系统提示时占用的 section 名 / 拼接块的标签名（须匹配 `[a-z][a-z0-9_-]*`）。 */
export const WORKFLOW_SECTION = "pi-thinkrail-workflow";

/** 每轮注入系统提示的那一节文字。 */
export const WORKFLOW_RULE = [
	"At the start of any new piece of work — a request, feature, change, fix, question, or fresh project idea —",
	"read the `choosing-a-workflow` skill (Skill tool, id `pi.thinkrail/choosing-a-workflow`) FIRST and follow it: it routes the work to the workflow skill",
	"that governs it, or tells you none applies.",
	"At the first request in a project session, if source code exists but no durable spec graph exists, finish project setup before handling that request — whatever it asks — then return to it. A temporary task-spec under `.thinkrail/context/` does not count as a durable graph; a chat without an attached project is not a project session.",
].join("\n");

/** 通道 2 追加到提示尾部的整块（标签名与 section 名一致，便于幂等判断）。 */
export const WORKFLOW_BLOCK = `<${WORKFLOW_SECTION}>\n${WORKFLOW_RULE}\n</${WORKFLOW_SECTION}>`;

/** 提示里是否已经有这一块——通道 2 的幂等标记。 */
export function hasWorkflowBlock(prompt) {
	return typeof prompt === "string" && prompt.includes(`<${WORKFLOW_SECTION}>`);
}

/**
 * ExtensionAPI 工厂。宿主用 jiti 加载本文件，把默认导出当工厂调用。
 *
 * 只挂一个钩子：`before_agent_start`（宿主允许返回值的那个事件集里）。
 * 两条通道按宿主能力二选一，不叠加。
 */
export default function workflowRule(pi) {
	if (typeof pi?.on !== "function") return; // 宿主 API 换了形状：什么都不贡献，也不抛错
	pi.on("before_agent_start", (event) => {
		// 通道 1（0.15.x–0.19.x，以及上游）：有命名 section 表就只写 section，不接管整条提示。
		const sections = event?.systemPromptOptions?.sections;
		if (sections && typeof sections === "object") {
			sections[WORKFLOW_SECTION] = WORKFLOW_RULE;
			return {};
		}
		// 通道 2（0.20.x 起：sections 通道已不被读取）：追加到本轮提示尾部。
		const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
		if (!base) return {}; // 拿不到提示就什么都不做，绝不凭空造一条
		if (hasWorkflowBlock(base)) return {}; // 已经在里面了：不重复堆叠
		return { systemPrompt: `${base}\n${WORKFLOW_BLOCK}` };
	});
}
