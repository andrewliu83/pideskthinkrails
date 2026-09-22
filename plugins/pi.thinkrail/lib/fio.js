// 工作区 I/O 网关的适配层 —— 本插件读写工作区里的一切（spec 文件、草稿目录）都过宿主的
// `pi.fs.*`，不再直接 require("node:fs")。
//
// 为什么值得多这一层：
//   * 权限在 manifest 里是**可审阅的**（fs.read / fs.write / fs.delete + manifest.fs 的 scope），
//     用户装的时候看得到这份契约，运行时宿主的审计日志也记每一笔访问；
//   * 越出 scope 的访问会变成一次原生确认（允许一次 / 本次会话 / 拒绝），而不是静默成功
//     或者直接失败——能力因此是「降级」而不是「消失」；
//   * 宿主先 realpath 再判定，所以指向工作区外的符号链接进不来；`.env*` / `.ssh/` / `*.pem`
//     这类凭据路径无论 manifest 怎么写都会被拒。
//
// 只在这里碰 pi。所有下游模块拿到的都是这个薄对象，因此它们能在测试里被内存实现替换。

/**
 * 把宿主的 pi.fs 包成本插件下游使用的形态。
 *
 * 语义与宿主一致：路径一律是**工作区根相对**的 POSIX 路径；不存在时 stat/readText 抛错。
 */
function createFio(pi) {
	const fs = pi.fs;
	return {
		/** 匹配 pattern 的文件（工作区根相对路径，宿主单次最多给 500 条）。 */
		glob: (pattern) => fs.glob(pattern),
		/** `{ size, mtimeMs }`；目录或缺失都会抛错。 */
		stat: (rel) => fs.stat(rel),
		/** 文件全文。 */
		readText: (rel) => fs.readText(rel),
		/** 覆盖写；父目录由宿主创建。 */
		writeText: (rel, content) => fs.writeText(rel, content),
		/** 删到系统回收站（非递归、有速率刹车）。 */
		remove: (rel) => fs.remove(rel),
		/** 一个目录的条目：`{ name, path, isDirectory, size, mtimeMs }`（一次 IPC 拿全一个目录）。 */
		list: async (rel) => {
			return fs.list(rel);
		},
		/** 只在文件不存在时写入；返回是否真的写了。 */
		async writeIfAbsent(rel, content) {
			try {
				await fs.stat(rel);
				return false;
			} catch {
				await fs.writeText(rel, content);
				return true;
			}
		},
	};
}

module.exports = { createFio };
