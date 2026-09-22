// spec 图校验 —— 移植自 JetBrains/thinkrail 的
// packages/spec-graph/core/validate.ts（MIT）。

const { LINK_KINDS, linkTargets } = require("./graph.js");
const { FIELDS, scalar } = require("./parse.js");

function findParentCycles(graph) {
	const cycles = [];
	const seen = new Set();

	for (const startId of graph.nodes.keys()) {
		if (seen.has(startId)) continue;
		const path = [];
		const onPath = new Map();
		let current = startId;

		while (current !== undefined && graph.nodes.has(current)) {
			if (onPath.has(current)) {
				const ring = path.slice(onPath.get(current));
				const key = [...ring].sort().join("\u0000");
				if (!cycles.some((c) => [...c.ids].sort().join("\u0000") === key)) {
					cycles.push({ ids: ring });
				}
				break;
			}
			if (seen.has(current)) break;
			onPath.set(current, path.length);
			path.push(current);
			const node = graph.nodes.get(current);
			current = node ? scalar(node.frontmatter, FIELDS.parent) : undefined;
		}
		for (const id of path) seen.add(id);
	}
	return cycles;
}

/** 报告悬挂链接、重复 id、parent 环三类结构问题。 */
function validateGraph(graph) {
	const danglingLinks = [];
	for (const node of graph.nodes.values()) {
		for (const kind of LINK_KINDS) {
			for (const target of linkTargets(node.frontmatter, kind)) {
				if (!graph.nodes.has(target)) {
					danglingLinks.push({ from: node.id, fromPath: node.path, kind, target });
				}
			}
		}
	}

	const duplicateIds = [...graph.duplicateIds].map(([id, paths]) => ({ id, paths }));

	return { danglingLinks, duplicateIds, parentCycles: findParentCycles(graph) };
}

function isValid(report) {
	return (
		report.danglingLinks.length === 0 &&
		report.duplicateIds.length === 0 &&
		report.parentCycles.length === 0
	);
}

module.exports = { validateGraph, isValid };
