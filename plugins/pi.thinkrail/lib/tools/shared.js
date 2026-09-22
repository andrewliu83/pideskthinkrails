// 工具装配的公共部分。
//
// 宿主的 `pi.agent.registerTool()` 收的是原始 JSON Schema 形态：
// `{ name, description, risk, schema, execute }`，`execute(args, ctx)` 的返回值直接成为
// 工具结果（`{ content }` 是给模型看的那段文字，`{ error }` 是失败）。所以这里把 DSH 版的
// `textTool` 换成一个同形状的适配器：下游只写「返回一段文字 / 返回 { error }」的
// `run(args, ctx)`，其余照旧。
//
// ctx 里只有 `{ sessionId, turnId, mode, modelKey, thinkingLevel, signal, log }` —— 没有工作目录。
// 工具的 I/O 根由宿主按**发起调用的会话**决定，插件不判定也不比对，所以索引身份直接用那个
// 会话 id：`SpecIndex` 的第一个参数只是身份，真正作用的目录由宿主决定。

const { SpecIndex } = require("../spec/index.js");
const { createFio } = require("../fio.js");

/** 每个会话复用一个 SpecIndex，缓存才有意义。 */
const indexes = new Map();

function indexFor(key, pi) {
	let index = indexes.get(key);
	if (!index) {
		index = new SpecIndex(key, createFio(pi));
		indexes.set(key, index);
	}
	return index;
}

/** 一个对象根参数 schema：`props` 是属性表，`required` 是必填键名。 */
function params(props, required = []) {
	return {
		type: "object",
		additionalProperties: false,
		properties: props,
		...(required.length > 0 ? { required } : {}),
	};
}

/**
 * 声明一个只返回文字的工具。
 *
 * `run(args, ctx)` 返回字符串（成功）或 `{ error }`（失败）；抛出的异常也变成 `{ error }`。
 */
function textTool({ name, description, risk = "low", parameters, run }) {
	return {
		name,
		description,
		risk,
		schema: parameters,
		async execute(args, ctx) {
			try {
				const result = await run(args ?? {}, ctx);
				if (result !== null && typeof result === "object" && typeof result.error === "string") {
					return { error: result.error };
				}
				const text = typeof result === "string" ? result : String(result?.text ?? "");
				return { content: text };
			} catch (error) {
				return { error: error?.message ?? String(error) };
			}
		},
	};
}

module.exports = { indexFor, params, textTool };
