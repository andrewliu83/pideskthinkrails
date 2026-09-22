// spec 查询：内容检索与图切片 —— 移植自 JetBrains/thinkrail 的
// packages/spec-graph/core/query.ts（MIT）。

const { FIELDS, list, scalar } = require("./parse.js");

const DEFAULT_GREP_LIMIT = 200;

function matchesFilters(fm, filters) {
	if (filters.type !== undefined && scalar(fm, FIELDS.type) !== filters.type) return false;
	if (filters.parent !== undefined && scalar(fm, FIELDS.parent) !== filters.parent) return false;
	if (filters.tag !== undefined && !list(fm, FIELDS.tags).includes(filters.tag)) return false;
	if (filters.dependsOn !== undefined && !list(fm, FIELDS.dependsOn).includes(filters.dependsOn)) {
		return false;
	}
	return true;
}

function buildMatcher(opts) {
	const ignoreCase = opts.ignoreCase ?? true;
	if (opts.regex) {
		const re = new RegExp(opts.pattern, ignoreCase ? "i" : "");
		return (line) => re.test(line);
	}
	if (ignoreCase) {
		const needle = opts.pattern.toLowerCase();
		return (line) => line.toLowerCase().includes(needle);
	}
	return (line) => line.includes(opts.pattern);
}

/**
 * 在 spec 文件内容里做正则 / 子串检索，可按元数据收窄。
 *
 * 逐行匹配，返回 `path:line: snippet`；达到 limit 立刻返回并标记 truncated。
 */
function grepSpecs(entries, opts) {
	const requested = Math.trunc(opts.limit ?? DEFAULT_GREP_LIMIT);
	const limit = requested > 0 ? requested : DEFAULT_GREP_LIMIT;
	const matcher = buildMatcher(opts);
	const matches = [];
	for (const entry of entries) {
		if (!matchesFilters(entry.frontmatter, opts)) continue;
		const lines = entry.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const raw = i === 0 ? (lines[0] ?? "").replace(/^\ufeff/, "") : (lines[i] ?? "");
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (matcher(line)) {
				if (matches.length >= limit) return { matches, truncated: true };
				matches.push({ path: entry.path, line: i + 1, snippet: line.trim() });
			}
		}
	}
	return { matches, truncated: false };
}

const SLICE_DIRECTIONS = ["subtree", "ancestors", "neighbors"];

/**
 * 取图的一个有界切片。
 *
 * - `subtree`：沿 `parent` 反向边向下；
 * - `ancestors`：沿 `parent` 正向边向上；
 * - `neighbors`：沿指定边（默认 `depends-on`）双向各走 depth 跳。
 */
function graphSlice(graph, opts) {
	const depth = opts.depth ?? 1;
	const included = new Set([opts.root]);
	const edges = [];
	const seenEdges = new Set();
	const missing = new Set();

	const walk = (next) => {
		let frontier = [opts.root];
		for (let d = 0; d < depth; d++) {
			const nextFrontier = [];
			for (const id of frontier) {
				for (const { to, edge } of next(id)) {
					const key = `${edge.from}\u0000${edge.kind}\u0000${edge.to}`;
					if (!seenEdges.has(key)) {
						seenEdges.add(key);
						edges.push(edge);
					}
					if (!graph.nodes.has(to)) missing.add(to);
					if (!included.has(to)) {
						included.add(to);
						nextFrontier.push(to);
					}
				}
			}
			if (nextFrontier.length === 0) break;
			frontier = nextFrontier;
		}
	};

	if (opts.direction === "subtree") {
		walk((id) =>
			(graph.reverse.parent.get(id) ?? []).map((child) => ({
				to: child,
				edge: { from: child, to: id, kind: FIELDS.parent },
			})),
		);
	} else if (opts.direction === "ancestors") {
		walk((id) =>
			(graph.forward.parent.get(id) ?? []).map((parent) => ({
				to: parent,
				edge: { from: id, to: parent, kind: FIELDS.parent },
			})),
		);
	} else {
		const edge = opts.edge ?? FIELDS.dependsOn;
		walk((id) => {
			const out = (graph.forward[edge].get(id) ?? []).map((to) => ({
				to,
				edge: { from: id, to, kind: edge },
			}));
			const inc = (graph.reverse[edge].get(id) ?? []).map((from) => ({
				to: from,
				edge: { from, to: id, kind: edge },
			}));
			return [...out, ...inc];
		});
	}

	const nodes = [];
	for (const id of included) {
		const node = graph.nodes.get(id);
		if (node) nodes.push(node);
	}
	return { root: opts.root, direction: opts.direction, nodes, edges, missing: [...missing] };
}

module.exports = { DEFAULT_GREP_LIMIT, grepSpecs, SLICE_DIRECTIONS, graphSlice };
