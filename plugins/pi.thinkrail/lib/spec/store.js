// 派生只读索引 —— 移植自 JetBrains/thinkrail 的
// packages/spec-graph/core/store.ts（MIT），再移植到 PI-Desktop。
//
// 文件系统仍然是唯一事实来源；这里的模型依旧是**派生、内存、只读、按需重校验**的：
// 每次读都重跑一遍扫描，按 (mtimeMs, size) 重校验每个文件——没变的复用缓存解析，
// 变了/新增的重新解析，消失的逐出；只有 spec 集合真的变了才重建图。
//
// 与 DSH 版（因而也与 thinkrail）的三处有意偏差，全部来自宿主换了 I/O 网关：
//
//   * 枚举先让宿主的 `pi.fs.glob` 试一次（一次 IPC，宿主在自己的进程里走完整棵树），但单次最多
//     返回 500 条匹配且不告诉你被截断了，所以拿到上限不能当作「就这么多」：顶到 500 条时改用
//     **并发逐目录 `list`** 遍历。给 glob 加目录前缀不会让它少走树（宿主始终从根递归，pattern 只
//     用来过滤），所以「按子目录分片重扫」等于把整棵树走十几遍。并发遍历有深度上限与目录数上限，
//     触到才把结果标成 truncated，而不是无声地少给东西。
//   * 结果按**遍历顺序**显式排出：逐段比较（每段先比 NFC 折叠值，再比原始名），目录与文件同列、
//     逐层下降——与上游的「逐层 readdir + 逐层排序」等价，而宿主的遍历顺序由 readdir 决定，
//     所以顺序必须显式排出来才稳定。
//   * 符号链接不再由本模块识别（pi.fs 不报告它）。越界由宿主的 realpath 检查拦下，判据从
//     「本模块拒绝」变成「宿主拒绝」；递归也必须有深度刹车，否则一个指回上层的链接就是无限递归。

const { isAbsolute, normalize, win32 } = require("node:path");
const { buildGraph } = require("./graph.js");
const { FIELDS, isSpec, parseFile, scalar } = require("./parse.js");

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

/**
 * 工作流草稿目录。
 *
 * `.thinkrail/context/` 下是 `brainstorming` 写的**临时 task-spec**，不是项目的 durable
 * spec graph。路由规则（`choosing-a-workflow` 的 preflight）明确要求：判断有没有 durable
 * graph 时，忽略 `.thinkrail/context/` 下的 task-spec。索引层必须给出同一个答案——否则模型
 * 查到的图和规则说的不是一回事：一个只有草稿的项目会被读成「已有 spec graph」，于是 onboarding
 * 被跳过（这正是 pidesktopsolfi 那次会话发生的事）。
 *
 * 只影响**图与检索**（`spec_graph` / `spec_grep` / `spec_validate` 与面板）：`spec_create`
 * 仍然能把草稿写进这个目录，`spec_update` / `spec_delete` 仍然按 id 找得到它，因为那两个走的是
 * 全量扫描而不是图。把 `.thinkrail` 整个塞进 `IGNORED_DIRS` 会连写入一起挡掉，那不是这里要的。
 */
const WORKSPACE_CONTEXT_DIR = ".thinkrail/context";

/** 这份 spec 是否计入 durable graph：草稿目录下的不算。 */
function isDurable(rel) {
	return !rel.startsWith(`${WORKSPACE_CONTEXT_DIR}/`);
}

const SPEC_FILE_EXTENSION = ".md";

/** 宿主 pi.fs.glob 的单次匹配上限；拿到这么多就当作「可能被截断」而不是「正好这么多」。 */
const GLOB_MATCH_CAP = 500;

/** 并发遍历的刹车：深度挡符号链接环，目录总数挡病态仓库。触到就标 truncated。 */
const MAX_WALK_DEPTH = 24;
const MAX_WALK_DIRS = 40000;

/** 并发遍历的在途请求数。11k 目录的仓库靠它把墙钟时间压到「一遍树的 CPU 时间」。 */
const WALK_CONCURRENCY = 24;

function hasWindowsNamespaceSyntax(path) {
	return win32.parse(path).root !== "" || path.includes(":");
}

function fold(name) {
	return name.normalize("NFC").toLowerCase();
}

/**
 * 候选路径的**目录段**里有没有逐字节命中的忽略目录。
 *
 * 上游遍历在每一层用 `IGNORED_DIRS.has(dirent.name)` 逐字节判断，所以这里也必须逐字节——
 * 折叠判断会把真名叫 `Build/` 的目录静默丢掉，两条枚举路径的结果就会不一致。
 * 最后一段是文件名，只有目录段参与判断。
 */
function passesThroughIgnoredDir(rel) {
	const segments = rel.split("/");
	for (let i = 0; i < segments.length - 1; i += 1) {
		if (IGNORED_DIRS.has(segments[i])) return true;
	}
	return false;
}

/** 宿主抛的东西不一定带 message；没有就明说，不要拼出一个空的冒号尾巴。 */
function hostMessage(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.trim() === "" ? "the host gave no reason" : message;
}

/**
 * 把路径里的一个片段解析成目录里真实存在的那个名字。
 *
 * 大小写/Unicode 折叠只在「该片段当前确实存在但字面不匹配」时启用；
 * 命中多个条目时报错，而不是猜一个。
 */
function resolvePathSegment(entries, segment, exists) {
	let name = segment;
	if (exists && !entries.includes(segment)) {
		const folded = fold(segment);
		const [only, ...rest] = entries.filter((entry) => fold(entry) === folded);
		if (only === undefined) {
			return {
				error: `Path component "${segment}" resolves to no entry its parent directory lists`,
			};
		}
		if (rest.length > 0) {
			return {
				error: `Path component "${segment}" matches more than one entry on this filesystem ("${only}", "${rest.join('", "')}")`,
			};
		}
		name = only;
	}
	// 与枚举保持逐字节一致：`Build` 不是确切忽略名 `build`，所以仍可访问。
	if (IGNORED_DIRS.has(name)) {
		return { error: `Path is inside an ignored directory ("${name}") and would not be indexed` };
	}
	return { name };
}

/**
 * 校验一个 root 相对的 spec 路径能否被索引看见，并解析成规范相对路径。
 *
 * 拒绝：空路径、绝对路径、非 `.md`、含 `..`、穿过被忽略目录、穿过一个列不出来的目录、
 * Windows 盘符/流语法。返回 `{ rel }` 或 `{ error }`。
 *
 * 与上游的两处载体差异：
 *   * 上游先 `existsSync(root)`，不存在时报 `Project root does not exist: ${root}`；本移植
 *     **拿不到根路径**（宿主按会话定根），所以第一段就列不出来时改报
 *     `Project root is not readable: ${宿主错误}`，并把宿主自己的错误文本带出来。
 *   * 上游收尾检查 `isPathInsideRoot(root, walked)`；本移植里所有路径都是工作区根相对的，
 *     越界由宿主的 realpath 拦下，这条检查没有对应物——不是丢了能力。
 */
async function resolveSpecPath(fio, path) {
	if (path.trim() === "") return { error: "Path must not be empty." };
	if (isAbsolute(path)) return { error: `Path must be root-relative, not absolute: ${path}` };
	if (process.platform === "win32" && hasWindowsNamespaceSyntax(path)) {
		return { error: `Path must not use Windows drive or stream syntax: ${path}` };
	}
	if (!path.endsWith(SPEC_FILE_EXTENSION)) {
		return { error: `Spec files must end in ${SPEC_FILE_EXTENSION}: ${path}` };
	}

	const segments = normalize(path)
		.split(/[\\/]/)
		.filter((segment) => segment !== "" && segment !== ".");
	if (segments.length === 0) return { error: "Path must not be empty." };
	if (segments.includes("..")) {
		return { error: `Path must stay inside the project root: ${path}` };
	}

	const canonical = [];
	// 与上游一致：**只要上一段存在过**（不要求它是目录）就 list 那一层。于是「上一段是个普通
	// 文件」不会被放行——list 那个文件会失败（ENOTDIR），这正是上游的判据。
	let walkedExists = true;
	for (const segment of segments) {
		let entries = [];
		if (walkedExists) {
			try {
				entries = await fio.list(canonical.join("/"));
			} catch (error) {
				// 第一段就列不出来 = 这个会话没有可读的根（宿主没有根、或项目目录没了），
				// 那不是「某个目录读不动」。宿主按会话定根，插件手里没有根路径。
				if (canonical.length === 0) {
					return { error: `Project root is not readable: ${hostMessage(error)}` };
				}
				return { error: `Path passes through a directory the index cannot list: ${path}` };
			}
		}
		const match = entries.find((entry) => entry.name === segment) ??
			entries.find((entry) => fold(entry.name) === fold(segment));
		const exists = walkedExists && match !== undefined;
		const resolution = resolvePathSegment(
			entries.map((entry) => entry.name),
			segment,
			exists,
		);
		if ("error" in resolution) return { error: `${resolution.error}: ${path}` };
		canonical.push(resolution.name);
		walkedExists = exists;
	}

	const rel = canonical.join("/");
	if (!rel.endsWith(SPEC_FILE_EXTENSION)) {
		return { error: `Spec files must end in ${SPEC_FILE_EXTENSION}: ${path}` };
	}
	return { rel };
}

/**
 * 比较两个相对路径在**遍历顺序**里的先后。
 *
 * 上游的遍历是「逐层按 (NFC key, 原始名) 排序、目录与文件同列、逐层下降」的 DFS。先把结果
 * 拍平、再按整串 NFC 比较做不到这一点——那会让 `a.md` 排在 `a/x.md` 前面，而上游的目录 `a`
 * 排在文件 `a.md` 之前（同一层里 `a` < `a.md`）。所以这里**逐段**比较，与上游的 DFS 等价。
 */
function compareRel(a, b) {
	const left = a.split("/");
	const right = b.split("/");
	for (let i = 0; i < left.length && i < right.length; i += 1) {
		const order = compareWalkSegment(left[i], right[i]);
		if (order !== 0) return order;
	}
	return left.length - right.length;
}

/** 上游 `compareWalkEntries` 的一段：先比 NFC 折叠值，再比原始串。 */
function compareWalkSegment(a, b) {
	const left = a.normalize("NFC");
	const right = b.normalize("NFC");
	if (left !== right) return left < right ? -1 : 1;
	if (a !== b) return a < b ? -1 : 1;
	return 0;
}

/**
 * 一个 root 的 spec 索引。
 *
 * `fio` 是工作区 I/O 网关（`lib/fio.js`）：把宿主的 pi.fs 注入进来，索引就能在测试里
 * 用内存实现跑。
 */
class SpecIndex {
	constructor(root, fio) {
		this.root = root;
		this.fio = fio;
		this.cache = new Map();
		this.graphCache = null;
		/** 上一次枚举有没有触到分片刹车（= 结果不全）。 */
		this.truncated = false;
		this.lastSpecs = [];
		/** 上一次扫描完成的时间；面板的 maxAgeMs 记忆靠它判断新鲜度。 */
		this.lastScanAt = 0;
	}

	/** 让下一次读一定重新走树（本插件自己写完文件后调用）。 */
	invalidate() {
		this.lastScanAt = 0;
	}

	/** 手里有没有一份可画的快照。 */
	hasSnapshot() {
		return this.graphCache !== null;
	}

	/** 复用最近一次快照（不发任何宿主调用，所以面板可以先画再刷新）。 */
	cachedGraph() {
		return this.graphCache;
	}

	/** 快照是否已经过期（超过 maxAgeMs 没重新枚举过）。 */
	isStale(maxAgeMs) {
		if (this.lastScanAt === 0) return true;
		return Date.now() - this.lastScanAt >= maxAgeMs;
	}

	/**
	 * 枚举工作区里所有 `.md`，返回 `{ rel, size, mtimeMs }`（已排序）。
	 *
	 * 两条路，按仓库大小分：
	 *
	 * 1. **一次 `fs.glob` + 按目录取元数据**（小仓库的常态）。宿主 `pi.fs.glob` 虽然只发一次
	 *    IPC，但它是在宿主主进程里**递归整棵树**做 readdir+stat，代价与树的大小成正比。
	 * 2. 如果 glob 顶到 500 条上限，就走 **并发 `fs.list` 遍历**：宿主自己说 glob 的匹配上限
	 *    是硬性的且不报截断，而**给 glob 加目录前缀并不能让它少走树**（宿主始终从工作区根开始
	 *    递归，pattern 只用来过滤）。所以「按子目录分片重扫」是把整棵树走 20 遍——实测在
	 *    11678 个目录的仓库上，每次 glob 约 800ms，分片总代价 ~16s。逐目录 list 则是每个目录
	 *    一次 IPC（~0.2ms），并发跑完 ≈ 一遍树的 CPU 时间。
	 *
	 * `this.truncated` 记录结果是否不全（遍历触到刹车时）。
	 */
	async walk() {
		this.truncated = false;
		const matches = [];
		// 宿主自己给的回数：上限判据必须用它，不能用过滤后的条数——一个只有 `dist/*.md` 的仓库
		// 过滤完会落到 500 以下，那仍是「宿主截断了」，不能当作「就这么多」。
		let globbed = 0;
		try {
			// 宿主 glob 不看忽略目录，所以这里逐段过滤：上游遍历在每一层用逐字节的
			// `IGNORED_DIRS.has(dirent.name)`，于是小仓库（glob 路）与大仓库（并发 list 路）
			// 看到的是同一棵树。
			for (const rel of await this.fio.glob(`**/*${SPEC_FILE_EXTENSION}`)) {
				globbed += 1;
				if (!rel.endsWith(SPEC_FILE_EXTENSION)) continue;
				if (passesThroughIgnoredDir(rel)) continue;
				matches.push(rel);
			}
		} catch {
			/* 拿不到就让下面的 list 兜底 */
		}
		if (globbed > 0 && globbed < GLOB_MATCH_CAP) {
			return this.metadataFor(matches);
		}
		// 没匹配（空仓库）或顶到上限：用并发遍历拿一份完整的。
		const walked = await this.walkWithList();
		if (walked.length > 0 || matches.length === 0) return walked;
		return this.metadataFor(matches);
	}

	/** 已知路径集合时，按父目录取元数据（一次 list 换一个目录里全部文件的 size/mtime）。 */
	async metadataFor(paths) {
		const byDir = new Map();
		for (const rel of [...paths].sort(compareRel)) {
			const slash = rel.lastIndexOf("/");
			const dir = slash === -1 ? "" : rel.slice(0, slash);
			const bucket = byDir.get(dir);
			if (bucket) bucket.push(rel);
			else byDir.set(dir, [rel]);
		}

		const found = [];
		for (const [dir, rels] of byDir) {
			let listed = null;
			try {
				listed = await this.fio.list(dir);
			} catch {
				listed = null;
			}
			const meta = new Map();
			for (const entry of listed ?? []) {
				if (entry.isDirectory || typeof entry.size !== "number") continue;
				meta.set(entry.path ?? (dir ? `${dir}/${entry.name}` : entry.name), entry);
			}
			for (const rel of rels) {
				const hit = meta.get(rel);
				if (hit) {
					found.push({ rel, size: hit.size, mtimeMs: hit.mtimeMs });
					continue;
				}
				// 目录条目顶到宿主的 1000 条上限、或该文件落在这台目录的读取范围之外：
				// 退回单文件 stat，慢一点但不会漏。
				try {
					const stat = await this.fio.stat(rel);
					found.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
				} catch {
					/* 读不到就当作不存在 */
				}
			}
		}
		found.sort((a, b) => compareRel(a.rel, b.rel));
		return found;
	}

	/**
	 * 并发逐目录遍历（大仓库的完整路径）。
	 *
	 * 目录数上限是刹车：`list` 分不出符号链接，一个指回上层的链接就是无限递归；11k 目录的
	 * 正常仓库远在刹车之下，触到刹车就把结果标成 truncated 而不是无声地少给。
	 */
	async walkWithList() {
		const found = [];
		const queue = [{ rel: "", depth: 0 }];
		let visited = 0;
		let rootError = null;

		const worker = async () => {
			for (;;) {
				const next = queue.shift();
				if (next === undefined) return;
				if (visited >= MAX_WALK_DIRS) {
					this.truncated = true;
					continue;
				}
				visited += 1;
				let entries;
			try {
				entries = await this.fio.list(next.rel);
			} catch (error) {
				// 根目录读不到就是「没有可读的工作区」（宿主没有根、或项目目录没了）：那不是
				// 「某个目录读不动」，当成空仓库会把失败说成成功。其余目录照旧跳过。
				if (next.rel === "") rootError = error;
				continue;
			}
				for (const entry of entries) {
					const child = entry.path ?? (next.rel ? `${next.rel}/${entry.name}` : entry.name);
					if (entry.isDirectory) {
						// 逐字节，与上游遍历一致：折叠过的判断会把真名叫 `Build/` 的目录静默丢掉。
						if (next.depth + 1 <= MAX_WALK_DEPTH && !IGNORED_DIRS.has(entry.name)) {
							queue.push({ rel: child, depth: next.depth + 1 });
						}
						continue;
					}
					if (!child.endsWith(SPEC_FILE_EXTENSION)) continue;
					if (typeof entry.size !== "number" || typeof entry.mtimeMs !== "number") continue;
					found.push({ rel: child, size: entry.size, mtimeMs: entry.mtimeMs });
				}
			}
		};

		await Promise.all(Array.from({ length: WALK_CONCURRENCY }, worker));
		if (rootError) throw rootError;
		if (visited >= MAX_WALK_DIRS) this.truncated = true;
		found.sort((a, b) => compareRel(a.rel, b.rel));
		return found;
	}

	/**
	 * 走一遍工作区并返回 spec 列表。
	 *
	 * `options.maxAgeMs` 是**面板专用**的短期记忆：给了它就允许复用上一次扫描的结果，
	 * 于是「点开一个 spec 读正文」不再触发全树重扫。工具一律不传（见 `lib/tools/index.js`），
	 * 所以 agent 永远读不到过期的图——陈旧窗口只发生在人看的那一侧，且有上限。
	 */
	async scan(options = {}) {
		const maxAgeMs = Number(options.maxAgeMs) || 0;
		if (
			maxAgeMs > 0 &&
			this.graphCache !== null &&
			this.lastScanAt > 0 &&
			Date.now() - this.lastScanAt < maxAgeMs
		) {
			return this.lastSpecs;
		}

		const seen = new Set();
		const specs = [];
		let changed = false;

		for (const { rel, size, mtimeMs } of await this.walk()) {
			seen.add(rel);
			let entry = this.cache.get(rel);
			if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) {
				let content;
				try {
					content = await this.fio.readText(rel);
				} catch {
					if (this.cache.delete(rel)) changed = true;
					continue;
				}
				const { frontmatter } = parseFile(content);
				entry = {
					rel,
					mtimeMs,
					size,
					content: isSpec(frontmatter) ? content : "",
					frontmatter,
				};
				this.cache.set(rel, entry);
				changed = true;
			}
			const fm = entry.frontmatter;
			if (isSpec(fm)) {
				specs.push({ rel: entry.rel, content: entry.content, frontmatter: fm });
			}
		}

		for (const rel of [...this.cache.keys()]) {
			if (!seen.has(rel)) {
				this.cache.delete(rel);
				changed = true;
			}
		}

		this.lastSpecs = specs;
		this.lastScanAt = Date.now();
		if (changed || this.graphCache === null) {
			// 图只收 durable spec：`.thinkrail/context/` 下的草稿是工作中间态，不是项目的
			// spec graph。路由规则也是这么判的（见 WORKSPACE_CONTEXT_DIR 的注释）。
			this.graphCache = buildGraph(
				specs.filter((r) => isDurable(r.rel)).map((r) => ({ path: r.rel, frontmatter: r.frontmatter })),
			);
		}
		return specs;
	}

	async graph(options) {
		await this.scan(options);
		return this.graphCache;
	}

	async contentEntries(options) {
		// 与图同一口径：`spec_grep` 是「在图里搜」，草稿不在图里，也就不该被它搜出来。
		return (await this.scan(options))
			.filter((r) => isDurable(r.rel))
			.map((r) => ({
				path: r.rel,
				content: r.content,
				frontmatter: r.frontmatter,
			}));
	}

	async recordForId(id, options) {
		return (await this.scan(options)).find((r) => scalar(r.frontmatter, FIELDS.id) === id);
	}

	async pathForId(id) {
		return (await this.recordForId(id))?.rel;
	}
}

module.exports = {
	IGNORED_DIRS,
	SPEC_FILE_EXTENSION,
	SpecIndex,
	WORKSPACE_CONTEXT_DIR,
	compareRel,
	hasWindowsNamespaceSyntax,
	isDurable,
	resolvePathSegment,
	resolveSpecPath,
};
