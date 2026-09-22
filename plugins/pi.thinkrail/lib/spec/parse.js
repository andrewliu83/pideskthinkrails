// Spec frontmatter 模型 —— 移植自 JetBrains/thinkrail 的
// packages/spec-graph/core/parse.ts（MIT）。行为逐条对齐：
//
//   * 一个文件是 spec，当且仅当它的 frontmatter 同时带有非空 `id` 与 `type`；
//   * `serializeFrontmatter` 用规范字段序写出新 frontmatter，列表用 inline flow；
//   * `updateFrontmatterText` 只重写 frontmatter 块，保留注释 / 字段序 / 嵌套字段，
//     并沿用该块原本的换行风格，正文一个字节都不动。
//
// 唯一的有意偏差：thinkrail 的 frontmatter 用 0 缩进的 `---` 围栏，本移植保持一致。

const { Document, isMap, isScalar, isSeq, parse: parseYaml, parseDocument } = require("../vendor/yaml/dist/index.js");

/** frontmatter 取值：标量或标量列表。 */
const FIELDS = {
	id: "id",
	type: "type",
	status: "status",
	title: "title",
	parent: "parent",
	dependsOn: "depends-on",
	references: "references",
	implements: "implements",
	covers: "covers",
	tags: "tags",
};

const REQUIRED_FIELDS = [FIELDS.id, FIELDS.type, FIELDS.title];

const IDENTITY_FIELDS = [FIELDS.id, FIELDS.type];

const SPEC_TYPES = [
	"goal-and-requirements",
	"architecture-design",
	"module-design",
	"submodule-design",
	"task-spec",
];

const SPEC_STATUSES = ["draft", "active", "stale", "done", "deprecated"];

const SINGLE_LINK_FIELDS = [FIELDS.parent];

const LIST_LINK_FIELDS = [FIELDS.dependsOn, FIELDS.references, FIELDS.implements];

const LIST_FIELDS = [...LIST_LINK_FIELDS, FIELDS.covers, FIELDS.tags];

const FIELD_ORDER = [
	FIELDS.id,
	FIELDS.type,
	FIELDS.status,
	FIELDS.title,
	...SINGLE_LINK_FIELDS,
	...LIST_FIELDS,
];

const FENCE = "---";
const BOM = "\ufeff";
const CRLF = "\r\n";
const TO_STRING = { lineWidth: 0, flowCollectionPadding: false };

function lineEnding(text) {
	const first = text.indexOf("\n");
	return first > 0 && text[first - 1] === "\r" ? CRLF : "\n";
}

function toFrontmatter(loaded) {
	if (loaded === null || loaded === undefined) return {};
	if (typeof loaded !== "object" || Array.isArray(loaded)) return null;
	const fm = {};
	for (const [key, value] of Object.entries(loaded)) {
		if (value === null || value === undefined) continue;
		if (Array.isArray(value)) {
			fm[key] = value.filter((v) => v !== null && v !== undefined).map((v) => String(v));
		} else if (typeof value !== "object") {
			fm[key] = String(value);
		}
	}
	return fm;
}

function splitFrontmatter(content) {
	const normalized = content.startsWith(BOM) ? content.slice(1) : content;
	const lines = normalized.split("\n");
	if ((lines[0] ?? "").trim() !== FENCE) return { fmText: null, body: content };
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if ((lines[i] ?? "").trim() === FENCE) {
			end = i;
			break;
		}
	}
	if (end === -1) return { fmText: null, body: content };
	const body = lines.slice(end + 1).join("\n");
	const fmText = lines
		.slice(1, end)
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
		.join("\n");
	return { fmText, body };
}

/**
 * 解析一个文件：拆出 frontmatter 与正文。
 * frontmatter 缺失或不是合法 YAML 映射时返回 `{ frontmatter: null, body }`。
 */
function parseFile(content) {
	const { fmText, body } = splitFrontmatter(content);
	if (fmText === null) return { frontmatter: null, body };
	let loaded;
	try {
		loaded = parseYaml(fmText);
	} catch {
		return { frontmatter: null, body: content };
	}
	return { frontmatter: toFrontmatter(loaded), body };
}

/** 读一个非空标量字段。 */
function scalar(fm, key) {
	const value = fm[key];
	if (typeof value === "string" && value !== "") return value;
	return undefined;
}

/** 读一个列表字段，标量会被当成单元素列表。 */
function list(fm, key) {
	const value = fm[key];
	if (Array.isArray(value)) return value;
	if (typeof value === "string" && value !== "") return [value];
	return [];
}

/** 「是不是一个 spec」的唯一判据：frontmatter 带非空 id 与 type。 */
function isSpec(fm) {
	return fm !== null && IDENTITY_FIELDS.every((field) => scalar(fm, field) !== undefined);
}

function inlineLists(doc) {
	if (isMap(doc.contents)) {
		for (const pair of doc.contents.items) if (isSeq(pair.value)) pair.value.flow = true;
	}
}

/** 按规范字段序序列化一份 frontmatter（新文件用）。 */
function serializeFrontmatter(fm) {
	const clean = {};
	for (const [key, value] of Object.entries(fm)) {
		if (Array.isArray(value)) {
			if (value.length > 0) clean[key] = value;
		} else if (value !== "") {
			clean[key] = value;
		}
	}
	if (Object.keys(clean).length === 0) return `${FENCE}\n${FENCE}\n`;
	const doc = new Document(clean);
	inlineLists(doc);
	return `${FENCE}\n${doc.toString(TO_STRING)}${FENCE}\n`;
}

function docScalar(doc, key) {
	const node = doc.get(key, true);
	return isScalar(node) && node.value !== null && node.value !== "" ? String(node.value) : undefined;
}

function docList(doc, key) {
	const node = doc.get(key, true);
	if (isSeq(node)) {
		return node.items
			.map((item) => (isScalar(item) ? item.value : item))
			.filter((v) => v !== null && v !== undefined)
			.map((v) => String(v));
	}
	return isScalar(node) && node.value !== null && node.value !== "" ? [String(node.value)] : [];
}

/**
 * 就地改写一份文件文本的 frontmatter。
 *
 * 保留：字段原序、注释、非方言字段、该块原本的行尾、BOM。正文原样保留。
 * 拒绝：改 `id`、移除 `id`/`type`、把列表字段当标量 set、任何会让文件不再是
 * spec 的改动。
 *
 * @returns `{ content }` 或 `{ error }`。
 */
function updateFrontmatterText(fileText, edit) {
	const { fmText, body } = splitFrontmatter(fileText);
	if (fmText === null) return { error: "File has no frontmatter to update." };
	let doc;
	try {
		doc = parseDocument(fmText);
	} catch {
		return { error: "File frontmatter is not valid YAML." };
	}
	if (doc.errors.length > 0 || !isMap(doc.contents)) {
		return { error: "File frontmatter is not valid YAML." };
	}

	for (const [key, value] of Object.entries(edit.set ?? {})) {
		if (key === FIELDS.id) return { error: "Cannot rename a spec's id via set." };
		if (LIST_FIELDS.includes(key)) {
			return { error: `Use addList/removeList to edit the list field "${key}".` };
		}
		doc.set(key, value);
	}
	for (const key of edit.remove ?? []) {
		if (IDENTITY_FIELDS.includes(key)) {
			return { error: `Cannot remove protected field "${key}".` };
		}
		doc.delete(key);
	}
	for (const field of LIST_FIELDS) {
		const add = edit.addList?.[field];
		if (add?.length) doc.set(field, doc.createNode([...new Set([...docList(doc, field), ...add])]));
		const remove = edit.removeList?.[field];
		if (remove?.length) {
			const next = docList(doc, field).filter((v) => !remove.includes(v));
			if (next.length) doc.set(field, doc.createNode(next));
			else doc.delete(field);
		}
	}

	if (IDENTITY_FIELDS.some((field) => docScalar(doc, field) === undefined)) {
		return { error: "Update would leave the file without a valid id and type." };
	}

	inlineLists(doc);
	const block = `${FENCE}\n${doc.toString(TO_STRING)}${FENCE}\n`;
	const rewritten = lineEnding(fileText) === CRLF ? block.replace(/\n/g, CRLF) : block;
	return { content: `${fileText.startsWith(BOM) ? BOM : ""}${rewritten}${body}` };
}

module.exports = {
	FIELDS,
	REQUIRED_FIELDS,
	IDENTITY_FIELDS,
	SPEC_TYPES,
	SPEC_STATUSES,
	SINGLE_LINK_FIELDS,
	LIST_LINK_FIELDS,
	LIST_FIELDS,
	FIELD_ORDER,
	parseFile,
	scalar,
	list,
	isSpec,
	serializeFrontmatter,
	updateFrontmatterText,
};
