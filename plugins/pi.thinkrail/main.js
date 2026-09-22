"use strict";

/**
 * ThinkRail —— PI-Desktop 插件入口。
 *
 * 插件 id : pi.thinkrail
 * 命令    : thinkrail.open / thinkrail.openSpecs
 * 视图    : contributes.views 里的 "thinkrail"，停在右侧工作面板（Mod+J）
 * 工具    : 7 个（spec_* × 7），对外是 plugin_pi_thinkrail_<name>
 * 技能    : contributes.skills 里的 10 篇（spec-graph + 8 个工作流 + writing-workflow-skills）
 *
 * 宿主只在装载时给一次 `globalThis.pi`；`onLoad` 里做两件事：
 *   1. 注册 7 个模型工具；
 *   2. 注册 2 个人工命令。
 *
 * `onUnload` 把注册过的东西原样撤掉；视图的 channel 不需要注册，`onPanelInvoke` 由宿主按需调用。
 *
 * ── 为什么命令不能直接开页签，以及 hint 是什么 ──────────────────────────────
 *
 * 视图（contributes.views）由宿主画在工作面板里，插件**没有**任何 API 能点亮自己的页签或
 * 新建一个页签（这是宿主的边界，官方 pi.gitlens 同样只能提示用户按 Mod+J）。于是命令走两步：
 * 记下一个「想让视图显示哪一页」的意向，再弹一个 toast 告诉用户去哪儿找。视图自己每两秒问
 * 一次 `hint`（一次 IPC，不碰文件系统也不跑 git），token 变了就切页并整体重读。
 *
 * hint 用 token 而不是「读一次就消费」：视图可能被挂起、可能有多个读者，而消费式提示只要
 * 漏掉一次就永远丢了。token 单调递增，读者各自记住自己见过的那个，重复读到同一个 token 是
 * 无害的。
 */

const { host } = require("./lib/host.js");
const { createTools, toolNames } = require("./lib/tools/index.js");
const { indexStatus, onPanelInvoke } = require("./lib/panel.js");
const { resetProjects } = require("./lib/project.js");

const VIEW_ID = "thinkrail";

const COMMANDS = [
	{
		id: "thinkrail.open",
		title: "ThinkRail: Open",
		keywords: ["thinkrail", "spec", "规格"],
		category: "Developer",
		view: "specs",
	},
	{
		id: "thinkrail.openSpecs",
		title: "ThinkRail: Open Specs",
		keywords: ["thinkrail", "spec", "graph", "图", "规格"],
		category: "Developer",
		view: "specs",
	},
];

/** 工作面板的默认快捷键，见宿主的 openWorkPanel 绑定。 */
const WORK_PANEL_SHORTCUT = "Mod+J";

const TOOL_NAMES = toolNames();

const MESSAGES = {
	en: {
		specs: "Specs",
		toast: (page) =>
			`ThinkRail lives in the work panel. Press ${WORK_PANEL_SHORTCUT}, then choose ThinkRail (${page}).`,
	},
	"zh-CN": {
		specs: "Spec 图",
		toast: (page) => `ThinkRail 在右侧工作面板里。按 ${WORK_PANEL_SHORTCUT}，再选 ThinkRail（${page}）。`,
	},
};

/** 视图要显示哪一页的意向：token 单调递增，读者各自记住见过的那个。 */
let hint = { token: 0, view: "specs" };
let locale = "en";

async function onLoad() {
	const pi = host();
	locale = await readLocale(pi);
	registerTools(pi);
	registerCommands(pi);
}

async function readLocale(pi) {
	try {
		const value = await pi.app?.getLocale?.();
		if (typeof value === "string" && MESSAGES[value]) return value;
	} catch {
		/* 拿不到就用英文 */
	}
	return "en";
}

function registerTools(pi) {
	for (const tool of createTools()) {
		pi.agent.registerTool(tool).catch((error) => {
			console.warn(`[thinkrail] could not register tool ${tool.name}: ${error?.message ?? error}`);
		});
	}
}

function registerCommands(pi) {
	for (const command of COMMANDS) {
		pi.commands
			.register({
				id: command.id,
				title: command.title,
				keywords: command.keywords,
				category: command.category,
				run: () => announce(pi, command.view),
			})
			.catch((error) => {
				console.warn(`[thinkrail] could not register command ${command.id}: ${error?.message ?? error}`);
			});
	}
}

/** 记下意向 + 告诉用户去哪儿看。两层都尽力而为：toast 失败也不该让命令报错。 */
async function announce(pi, view) {
	hint = { token: hint.token + 1, view };
	const strings = MESSAGES[locale] ?? MESSAGES.en;
	const page = strings.specs;
	console.log(`[thinkrail] ${VIEW_ID}/${view} requested`);
	await pi.ui.showToast(strings.toast(page), "info").catch(() => {});
}

async function onUnload() {
	const pi = host();
	for (const command of COMMANDS) {
		await pi.commands.unregister(command.id).catch(() => {});
	}
	for (const name of TOOL_NAMES) {
		await pi.agent.unregisterTool(name).catch(() => {});
	}
}

/**
 * 视图的每一次调用都从这里进来。
 *
 * `hint` 是唯一由本文件回答的 channel（它只跟命令的意向有关）；其余交给 `lib/panel.js`。
 */
async function onPanelInvokeWithHint(channel, payload) {
	// hint 是视图唯一的轮询入口，所以「索引建好了没」也搭它一起回去：
	// 视图发现 indexedAt 变了就重画，于是后台枚举完成时数据自己出现，不需要用户点刷新。
	if (channel === "hint") return { ok: true, ...hint, ...indexStatus() };
	return onPanelInvoke(channel, payload);
}

module.exports = {
	onLoad,
	onUnload,
	onPanelInvoke: onPanelInvokeWithHint,
	// 只给测试用：把装配面摊开，免得测试去猜名字。
	__test: {
		COMMANDS,
		TOOL_NAMES,
		VIEW_ID,
		panelInvoke: onPanelInvoke,
		// 进程级的记忆：测试要能在用例之间清掉它。
		resetProjectMemory: resetProjects,
		hint: () => ({ ...hint }),
		resetHint: () => {
			hint = { token: 0, view: "specs" };
			locale = "en";
		},
	},
};
