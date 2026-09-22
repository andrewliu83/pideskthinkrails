// 7 个模型工具的装配 —— spec_*。

const { SPEC_TOOLS } = require("./spec-tools.js");

/**
 * 全部模型工具，形状可直接交给 `pi.agent.registerTool`。
 *
 * 宿主要求工具名唯一，并且会把它对外暴露成 `plugin_<id>_<name>`（例如
 * `plugin_pi_thinkrail_spec_get`），所以这里用不带前缀的原名。
 */
function createTools() {
	return SPEC_TOOLS;
}

/**
 * 工具名的静态清单 —— 不碰宿主，`onUnload` 与测试用。
 *
 * `createTools` 是纯函数式的装配（只是一堆对象字面量），所以这里再装一遍没有副作用；
 * 这样 onUnload 的清单就不依赖 onLoad 是否走完。
 */
function toolNames() {
	return SPEC_TOOLS.map((tool) => tool.name);
}

module.exports = { createTools, toolNames };
