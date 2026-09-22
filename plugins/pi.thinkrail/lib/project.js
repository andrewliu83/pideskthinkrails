// 面板用的「可见项目」。
//
// 面板是窗口级视图，没有会话 id，所以只能讲宿主此刻激活的项目（`pi.workspace.get()`）；没有就用
// 最近一次面板显示过的那个，标上 `stale`，让面板说「没有激活项目，上次显示的是 X」而不是一片空白。

/** 最近一次由面板看到的项目：没有激活项目时用它把「上次显示的是哪个」说出来。 */
let lastPanelProject = null;

/**
 * 宿主此刻激活的项目，`{ path, name }` 或 `null`。
 *
 * 「宿主不可用」与「没有打开项目」是两件事：前者照原样抛出去（那是真故障），后者返回 null 由
 * 调用方决定怎么讲。
 */
async function activeProject(pi) {
	const workspace = await pi.workspace.get();
	const path = workspace?.path;
	if (typeof path !== "string" || path === "") return null;
	const name = typeof workspace.name === "string" && workspace.name !== ""
		? workspace.name
		: (path.split(/[\\/]/).filter(Boolean).at(-1) ?? path);
	return { path, name };
}

/**
 * 面板用的项目。面板没有会话 id，所以只讲「宿主现在激活的项目」；没有就用最近一次面板显示过的
 * 那个，并标上 `stale`。宿主此刻没有工作区根时**不能**再去读文件，所以 stale 只用于说明，不用于取值。
 */
async function panelProject(pi) {
	const active = await activeProject(pi);
	if (active) {
		lastPanelProject = active;
		return { ...active, stale: false };
	}
	return lastPanelProject ? { ...lastPanelProject, stale: true } : null;
}

/** 面板在「没有激活项目」时能说出的那个项目（可能为空）。 */
function lastPanel() {
	return lastPanelProject;
}

/** 测试用：清空进程级记忆。 */
function resetProjects() {
	lastPanelProject = null;
}

module.exports = { activeProject, lastPanel, panelProject, resetProjects };
