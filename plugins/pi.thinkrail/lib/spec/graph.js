// 派生 spec 图 —— 移植自 JetBrains/thinkrail 的
// packages/spec-graph/core/graph.ts（MIT）。

const { FIELDS, LIST_LINK_FIELDS, SINGLE_LINK_FIELDS, list, scalar } = require("./parse.js");

const LINK_KINDS = [...SINGLE_LINK_FIELDS, ...LIST_LINK_FIELDS];

function emptyAdjacency() {
	return Object.fromEntries(LINK_KINDS.map((kind) => [kind, new Map()]));
}

/** 一个节点在某个链接字段上指向的 id 列表。 */
function linkTargets(fm, kind) {
	if (SINGLE_LINK_FIELDS.includes(kind)) {
		const target = scalar(fm, kind);
		return target ? [target] : [];
	}
	return list(fm, kind);
}

function push(map, key, value) {
	const existing = map.get(key);
	if (existing) existing.push(value);
	else map.set(key, [value]);
}

/**
 * 从「路径 + frontmatter」条目构建 spec 图。
 *
 * 同名 id 只保留第一个节点（其余记入 `duplicateIds`），但所有出边都会计入。
 */
function buildGraph(entries) {
	const nodes = new Map();
	const pathsById = new Map();

	for (const entry of entries) {
		const id = scalar(entry.frontmatter, FIELDS.id);
		const type = scalar(entry.frontmatter, FIELDS.type);
		if (id === undefined || type === undefined) continue;
		push(pathsById, id, entry.path);
		if (!nodes.has(id)) {
			nodes.set(id, {
				id,
				type,
				title: scalar(entry.frontmatter, FIELDS.title),
				path: entry.path,
				frontmatter: entry.frontmatter,
			});
		}
	}

	const forward = emptyAdjacency();
	const reverse = emptyAdjacency();
	const edges = [];

	for (const node of nodes.values()) {
		for (const kind of LINK_KINDS) {
			for (const to of linkTargets(node.frontmatter, kind)) {
				edges.push({ from: node.id, to, kind });
				push(forward[kind], node.id, to);
				push(reverse[kind], to, node.id);
			}
		}
	}

	const duplicateIds = new Map();
	for (const [id, paths] of pathsById) {
		if (paths.length > 1) duplicateIds.set(id, paths);
	}

	return { nodes, edges, forward, reverse, duplicateIds };
}

module.exports = { LINK_KINDS, linkTargets, buildGraph };
