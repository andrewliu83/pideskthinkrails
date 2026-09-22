// 宿主句柄。
//
// 宿主在装载 main.js **之前**把 `globalThis.pi` 注入插件进程（见宿主的
// plugin-host-process：`globalThis.pi = buildApi()` 然后才 require 入口），所以被 require
// 的模块拿 `pi` 是安全的。这里把它收成一处，测试里也就只需替换 globalThis.pi 一个东西。

function host() {
	if (!globalThis.pi) {
		throw new Error("thinkrail: the PI-Desktop host API (global `pi`) is not available");
	}
	return globalThis.pi;
}

module.exports = { host };
