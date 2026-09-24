// 七个 spec_* 工具 —— 移植自 JetBrains/thinkrail 的
// packages/spec-graph/tools/*.ts（MIT），经 DSH 版转到 PI-Desktop。
//
// 与 DSH 版的两处差异：
//   * 工作区 I/O 全走宿主的 `pi.fs.*`（经 `lib/fio.js`），所以每个工具都是异步的，
//     且作用目录由宿主按发起调用的会话决定（插件不判定、不比对），不是会话 cwd；
//     路径一律是工作区根相对路径。
//   * `spec_delete` 用宿主的 `fs.remove`，也就是删到**系统回收站**，而不是 `rmSync`
//     直接抹掉。同一件事，但可撤销。
//
// 工具名、参数、判据、输出措辞都逐字对齐上游：模型看到的那份契约没有变。

const {
	DEFAULT_GREP_LIMIT,
	FIELDS,
	LINK_KINDS,
	SLICE_DIRECTIONS,
	SPEC_STATUSES,
	SPEC_TYPES,
	graphSlice,
	grepSpecs,
	isSpec,
	isValid,
	linkTargets,
	parseFile,
	resolveSpecPath,
	serializeFrontmatter,
	updateFrontmatterText,
	validateGraph,
} = require("../spec/index.js");
const { createFio } = require("../fio.js");
const { host } = require("../host.js");
const { indexFor, params, textTool } = require("./shared.js");
const WORKSPACE_INTERNAL_DIR = ".thinkrail";
const WORKSPACE_CONTEXT_DIR = `${WORKSPACE_INTERNAL_DIR}/context`;

// 脚手架标题是**约定**，不是契约：spec 模型只读 frontmatter，正文标题谁都不解析。
// 上游发的是英文（Responsibility / Boundary / …），这里发中文——一个仓库的 spec 应该用
// 这个仓库自己的语言读。要改回去只动这张表。
const SCAFFOLD_HEADINGS = {
	"module-design": ["职责", "边界"],
	"submodule-design": ["职责", "边界"],
	"architecture-design": ["驱动", "决策", "不变量", "范围之外"],
	"goal-and-requirements": ["目标", "范围"],
	"task-spec": ["目的", "待定项"],
};

function scaffoldBody(type) {
	const headings = SCAFFOLD_HEADINGS[type];
	if (!headings || headings.length === 0) return "";
	return `${headings.map((h) => `## ${h}\n`).join("\n")}`;
}

const stringList = (description) => ({
	type: "array",
	items: { type: "string" },
	description,
});

// ── 读 ─────────────────────────────────────────────────────────────────────

const specGrep = textTool({
	name: "spec_grep",
	description:
		"spec_grep — search the project's spec-graph by content (narrowable by metadata); reach for it before grep/read when exploring or planning. " +
		"Matches within spec files only (files whose frontmatter carries `id` + `type`), optionally narrowed by type / tag / parent / depends-on. " +
		"Returns path:line matches with a snippet; read a matched file's body with the normal read tool.",
	parameters: params(
		{
			pattern: { type: "string", description: "Regex or substring to search for within spec files." },
			regex: { type: "boolean", description: "Treat pattern as a regular expression (default: substring)." },
			ignoreCase: { type: "boolean", description: "Case-insensitive match (default: true)." },
			type: { type: "string", description: "Only search specs with this frontmatter type." },
			tag: { type: "string", description: "Only search specs carrying this tag." },
			parent: { type: "string", description: "Only search specs whose parent is this id." },
			dependsOn: { type: "string", description: "Only search specs that depend-on this id." },
			limit: { type: "integer", description: `Max matches to return (default: ${DEFAULT_GREP_LIMIT}).` },
		},
		["pattern"],
	),
	async run(args, exec) {
		const pi = host();
		const index = indexFor(exec.sessionId, pi);
		let result;
		try {
			result = grepSpecs(await index.contentEntries(), {
				pattern: args.pattern,
				...(args.regex !== undefined ? { regex: args.regex } : {}),
				...(args.ignoreCase !== undefined ? { ignoreCase: args.ignoreCase } : {}),
				...(args.type !== undefined ? { type: args.type } : {}),
				...(args.tag !== undefined ? { tag: args.tag } : {}),
				...(args.parent !== undefined ? { parent: args.parent } : {}),
				...(args.dependsOn !== undefined ? { dependsOn: args.dependsOn } : {}),
				...(args.limit !== undefined ? { limit: args.limit } : {}),
			});
		} catch (error) {
			return { error: `Invalid search pattern: ${error.message}` };
		}
		const { matches, truncated } = result;
		const header =
			matches.length === 0
				? "No matches."
				: `${matches.length} match(es)${truncated ? " (truncated)" : ""}:`;
		const body = matches.map((m) => `${m.path}:${m.line}: ${m.snippet}`).join("\n");
		return `${header}\n${body}`.trimEnd();
	},
});

const specGet = textTool({
	name: "spec_get",
	description:
		"spec_get — look up one spec by id: its frontmatter, resolved links, and path (read the body with `read`). " +
		"Resolves forward and reverse edges across parent / depends-on / references / implements. Returns no prose body.",
	parameters: params({ id: { type: "string", description: "The spec id to look up." } }, ["id"]),
	async run(args, exec) {
		const pi = host();
		const graph = await indexFor(exec.sessionId, pi).graph();
		const node = graph.nodes.get(args.id);
		if (!node) return { error: `No spec with id "${args.id}".` };

		const links = [];
		for (const kind of LINK_KINDS) {
			for (const target of linkTargets(node.frontmatter, kind)) {
				links.push({ kind, target, path: graph.nodes.get(target)?.path ?? null });
			}
		}
		const reverseLinks = [];
		for (const kind of LINK_KINDS) {
			for (const source of graph.reverse[kind].get(args.id) ?? []) {
				reverseLinks.push({ kind, target: source, path: graph.nodes.get(source)?.path ?? null });
			}
		}

		const fmt = (l) => `  ${l.kind} -> ${l.target}${l.path ? ` (${l.path})` : " (missing)"}`;
		return [
			`${node.id} [${node.type}]${node.title ? ` — ${node.title}` : ""}`,
			`path: ${node.path}`,
			links.length ? `links:\n${links.map(fmt).join("\n")}` : "links: (none)",
			reverseLinks.length
				? `referenced by:\n${reverseLinks.map(fmt).join("\n")}`
				: "referenced by: (none)",
		].join("\n");
	},
});

const specGraph = textTool({
	name: "spec_graph",
	description:
		"spec_graph — walk a bounded slice of the spec-graph (subtree / ancestors / neighbors) from a node. " +
		"`subtree` goes down the parent tree, `ancestors` up to the tree root, `neighbors` across a chosen edge and its reverse. Bounded by `depth` (default 1).",
	parameters: params(
		{
			root: { type: "string", description: "Id of the node to start from." },
			direction: {
				type: "string",
				enum: [...SLICE_DIRECTIONS],
				description:
					"subtree = down the parent tree; ancestors = up the parent chain; neighbors = across an edge and its reverse.",
			},
			depth: { type: "integer", description: "How many hops to expand (default: 1)." },
			edge: {
				type: "string",
				enum: [...LINK_KINDS],
				description: "For direction=neighbors: which edge kind to traverse (default: depends-on).",
			},
		},
		["root", "direction"],
	),
	async run(args, exec) {
		const pi = host();
		const graph = await indexFor(exec.sessionId, pi).graph();
		if (!graph.nodes.has(args.root)) return { error: `No spec with id "${args.root}".` };
		const slice = graphSlice(graph, {
			root: args.root,
			direction: args.direction,
			...(args.depth !== undefined ? { depth: args.depth } : {}),
			...(args.edge !== undefined ? { edge: args.edge } : {}),
		});
		const nodeLines = slice.nodes.map(
			(n) => `  ${n.id} [${n.type}]${n.title ? ` — ${n.title}` : ""} (${n.path})`,
		);
		const edgeLines = slice.edges.map((e) => `  ${e.from} --${e.kind}--> ${e.to}`);
		return [
			`Slice of "${args.root}" (${args.direction}, depth ${args.depth ?? 1}):`,
			`nodes (${slice.nodes.length}):`,
			...nodeLines,
			`edges (${slice.edges.length}):`,
			...edgeLines,
			slice.missing.length ? `missing targets: ${slice.missing.join(", ")}` : "",
		]
			.filter(Boolean)
			.join("\n");
	},
});

// ── 管理 ───────────────────────────────────────────────────────────────────

const specCreate = textTool({
	name: "spec_create",
	description:
		"spec_create — create a new spec file with scaffolded frontmatter (id/type/title/links) and heading stubs. " +
		"Fails if the file already exists, the id is already in use, or the path is not an indexable root-relative .md path. Edit prose afterward with the write/edit tools.",
	risk: "medium",
	parameters: params(
		{
			path: {
				type: "string",
				description:
					"Root-relative path for the new spec file, ending in .md (e.g. src/foo/SPEC.md). Must stay inside the project root.",
			},
			id: { type: "string", description: "Unique spec id." },
			type: {
				type: "string",
				enum: [...SPEC_TYPES],
				description:
					"Spec type: goal-and-requirements | architecture-design | module-design | submodule-design | task-spec.",
			},
			title: { type: "string", description: "Human-readable title." },
			status: {
				type: "string",
				enum: [...SPEC_STATUSES],
				description: "Lifecycle status: draft | active | stale | done | deprecated.",
			},
			parent: { type: "string", description: "Parent id (the tree edge)." },
			dependsOn: stringList("depends-on link ids."),
			references: stringList("references link ids."),
			implements: stringList("implements link ids."),
			covers: stringList("covers ids."),
			tags: stringList("tags."),
		},
		["path", "id", "type", "title"],
	),
	async run(args, exec) {
		const pi = host();
		const key = exec.sessionId;
		const fio = createFio(pi);
		const resolved = await resolveSpecPath(fio, args.path);
		if ("error" in resolved) return { error: resolved.error };
		const rel = resolved.rel;

		const index = indexFor(key, pi);
		if (await exists(fio, rel)) return { error: `File already exists: ${rel}` };
		if ((await index.graph()).nodes.has(args.id)) {
			return { error: `Spec id "${args.id}" is already in use.` };
		}

		const fm = { [FIELDS.id]: args.id, [FIELDS.type]: args.type };
		if (args.status !== undefined) fm[FIELDS.status] = args.status;
		fm[FIELDS.title] = args.title;
		if (args.parent !== undefined) fm[FIELDS.parent] = args.parent;
		if (args.dependsOn?.length) fm[FIELDS.dependsOn] = args.dependsOn;
		if (args.references?.length) fm[FIELDS.references] = args.references;
		if (args.implements?.length) fm[FIELDS.implements] = args.implements;
		if (args.covers?.length) fm[FIELDS.covers] = args.covers;
		if (args.tags?.length) fm[FIELDS.tags] = args.tags;

		const content = `${serializeFrontmatter(fm)}\n${scaffoldBody(args.type)}`;
		if (!isSpec(parseFile(content).frontmatter)) {
			return {
				error: `Refusing to write ${rel}: the frontmatter would not be a spec (id and type must be non-empty).`,
			};
		}
		// 工作流的草稿目录（brainstorming 把 task-spec 放这里）必须自带 gitignore，
		// 否则一份「零 git 足迹」的草稿会以未跟踪文件的形式出现在 git status 里。
		if (rel === WORKSPACE_INTERNAL_DIR || rel.startsWith(`${WORKSPACE_INTERNAL_DIR}/`)) {
			try {
				await fio.writeIfAbsent(`${WORKSPACE_CONTEXT_DIR}/.gitignore`, "*\n");
			} catch (error) {
				return { error: `Failed to seed ${WORKSPACE_INTERNAL_DIR}/: ${error.message}` };
			}
		}
		try {
			await fio.writeText(rel, content);
		} catch (error) {
			return { error: `Failed to write ${rel}: ${error.message}` };
		}
		return `Created ${rel} (id: ${args.id}).`;
	},
});

const specUpdate = textTool({
	name: "spec_update",
	description:
		"spec_update — edit a spec's frontmatter only (scalar fields + list entries); never its prose. " +
		"Preserves the file's field order, comments, and non-dialect fields. Prose is edited with the write/edit tools.",
	risk: "medium",
	parameters: params(
		{
			id: { type: "string", description: "Id of the spec to update." },
			set: {
				type: "object",
				additionalProperties: true,
				description:
					"Scalar frontmatter fields to set/overwrite (e.g. title, status, parent). For list fields (depends-on/references/implements/covers/tags) use addList/removeList.",
				properties: {
					title: { type: "string" },
					status: { type: "string", enum: [...SPEC_STATUSES] },
					parent: { type: "string" },
				},
			},
			remove: {
				type: "array",
				items: { type: "string" },
				description: "Frontmatter field names to remove entirely.",
			},
			addList: {
				type: "object",
				additionalProperties: false,
				description:
					"List fields whose entries to add. Use the frontmatter key names with dashes.",
				properties: {
					[FIELDS.dependsOn]: stringList("depends-on ids to add."),
					[FIELDS.references]: stringList("references ids to add."),
					[FIELDS.implements]: stringList("implements ids to add."),
					[FIELDS.covers]: stringList("covers ids to add."),
					[FIELDS.tags]: stringList("tags to add."),
				},
			},
			removeList: {
				type: "object",
				additionalProperties: false,
				description: "List fields whose listed entries to remove.",
				properties: {
					[FIELDS.dependsOn]: stringList("depends-on ids to remove."),
					[FIELDS.references]: stringList("references ids to remove."),
					[FIELDS.implements]: stringList("implements ids to remove."),
					[FIELDS.covers]: stringList("covers ids to remove."),
					[FIELDS.tags]: stringList("tags to remove."),
				},
			},
		},
		["id"],
	),
	async run(args, exec) {
		const pi = host();
		const index = indexFor(exec.sessionId, pi);
		const record = await index.recordForId(args.id);
		if (!record) return { error: `No spec with id "${args.id}".` };

		const edit = {
			set: args.set,
			remove: args.remove,
			addList: args.addList,
			removeList: args.removeList,
		};
		const result = updateFrontmatterText(record.content, edit);
		if ("error" in result) return { error: result.error };
		try {
			await createFio(pi).writeText(record.rel, result.content);
		} catch (error) {
			return { error: `Failed to write ${record.rel}: ${error.message}` };
		}
		return `Updated frontmatter of ${record.rel} (id: ${args.id}).`;
	},
});

const specDelete = textTool({
	name: "spec_delete",
	description:
		"spec_delete — delete a spec file by id, to the system trash. Other specs may still reference it afterward — run spec_validate to find dangling links.",
	risk: "high",
	parameters: params({ id: { type: "string", description: "Id of the spec to delete." } }, ["id"]),
	async run(args, exec) {
		const pi = host();
		const index = indexFor(exec.sessionId, pi);
		const rel = await index.pathForId(args.id);
		if (!rel) return { error: `No spec with id "${args.id}".` };
		try {
			await createFio(pi).remove(rel);
		} catch (error) {
			return { error: `Failed to delete ${rel}: ${error.message}` };
		}
		return `Deleted ${rel} (id: ${args.id}).`;
	},
});

const specValidate = textTool({
	name: "spec_validate",
	description:
		"spec_validate — check the spec-graph for dangling links, duplicate ids, and parent cycles.",
	parameters: params({}),
	async run(_args, exec) {
		const pi = host();
		const report = validateGraph(await indexFor(exec.sessionId, pi).graph());
		if (isValid(report)) return "Spec-graph is valid: no issues found.";

		const sections = [];
		if (report.duplicateIds.length) {
			sections.push(
				`Duplicate ids (${report.duplicateIds.length}):\n${report.duplicateIds
					.map((d) => `  ${d.id}: ${d.paths.join(", ")}`)
					.join("\n")}`,
			);
		}
		if (report.danglingLinks.length) {
			sections.push(
				`Dangling links (${report.danglingLinks.length}):\n${report.danglingLinks
					.map((d) => `  ${d.from} (${d.fromPath}) --${d.kind}--> ${d.target} [missing]`)
					.join("\n")}`,
			);
		}
		if (report.parentCycles.length) {
			sections.push(
				`Parent cycles (${report.parentCycles.length}):\n${report.parentCycles
					.map((c) => `  ${c.ids.join(" -> ")} -> ${c.ids[0]}`)
					.join("\n")}`,
			);
		}
		return sections.join("\n\n");
	},
});

/** 文件在不在。宿主的 fs.stat 目录/文件不存在都抛错，所以「抛了就是没有」。 */
async function exists(fio, rel) {
	try {
		await fio.stat(rel);
		return true;
	} catch {
		return false;
	}
}

/** thinkrail 的 `registerSpecTools`。 */
const SPEC_TOOLS = [
	specGrep,
	specGet,
	specGraph,
	specCreate,
	specUpdate,
	specDelete,
	specValidate,
];

module.exports = { SPEC_TOOLS, scaffoldBody };
