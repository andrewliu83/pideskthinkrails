// spec-graph 只读模型 —— 与宿主无关，可被任意一层直接消费。
// 移植自 JetBrains/thinkrail 的 packages/spec-graph/core/index.ts（MIT）。

const { buildGraph, LINK_KINDS, linkTargets } = require("./graph.js");
const {
	FIELD_ORDER,
	FIELDS,
	IDENTITY_FIELDS,
	isSpec,
	LIST_FIELDS,
	LIST_LINK_FIELDS,
	list,
	parseFile,
	REQUIRED_FIELDS,
	SINGLE_LINK_FIELDS,
	SPEC_STATUSES,
	SPEC_TYPES,
	scalar,
	serializeFrontmatter,
	updateFrontmatterText,
} = require("./parse.js");
const { DEFAULT_GREP_LIMIT, graphSlice, grepSpecs, SLICE_DIRECTIONS } = require("./query.js");
const {
	IGNORED_DIRS,
	SPEC_FILE_EXTENSION,
	SpecIndex,
	resolvePathSegment,
	resolveSpecPath,
} = require("./store.js");
const { isValid, validateGraph } = require("./validate.js");

module.exports = {
	// graph
	buildGraph,
	LINK_KINDS,
	linkTargets,
	// parse
	FIELD_ORDER,
	FIELDS,
	IDENTITY_FIELDS,
	isSpec,
	LIST_FIELDS,
	LIST_LINK_FIELDS,
	list,
	parseFile,
	REQUIRED_FIELDS,
	SINGLE_LINK_FIELDS,
	SPEC_STATUSES,
	SPEC_TYPES,
	scalar,
	serializeFrontmatter,
	updateFrontmatterText,
	// query
	DEFAULT_GREP_LIMIT,
	graphSlice,
	grepSpecs,
	SLICE_DIRECTIONS,
	// store
	IGNORED_DIRS,
	SPEC_FILE_EXTENSION,
	SpecIndex,
	resolvePathSegment,
	resolveSpecPath,
	// validate
	isValid,
	validateGraph,
};
