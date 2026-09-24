// 用 PI-Desktop **自己**的 manifest 校验器检查本插件的 manifest。
//
// 校验器住在 app.asar 的 out/main/index.js 里，没有单独导出。这里按名字把需要的那几个声明
// 原样切出来（大括号配对 + 顺着 ReferenceError 补齐依赖）拼成一个临时模块再跑——于是
// 「安装器会不会收下这个 manifest」这个问题得到的是宿主的答案，而不是我的解读。
//
// 机器上没装 PI-Desktop 就跳过。

import assert from "node:assert/strict";
import test from "node:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpath as realpathAsync } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(here, "../plugins/pi.thinkrail/manifest.json");
const ASAR = "/Applications/PI-Desktop.app/Contents/Resources/app.asar";
const available = existsSync(ASAR);

function readFromAsar(entry) {
  const fd = openSync(ASAR, "r");
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const header = Buffer.alloc(headerSize);
    readSync(fd, header, 0, headerSize, 16);
    const index = JSON.parse(header.toString("utf8").replace(/\0+$/, ""));
    const base = 16 + headerSize;
    let node = index;
    for (const part of entry.split("/").filter(Boolean)) {
      node = node.files?.[part];
      if (!node) throw new Error(`not in app.asar: ${entry}`);
    }
    const buffer = Buffer.alloc(node.size);
    readSync(fd, buffer, 0, node.size, base + Number(node.offset));
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/** 一个顶层声明的行范围（含首尾行）；esbuild 的输出里它们都在行首。 */
function declSpan(lines, name) {
  const patterns = [
    new RegExp(`^(?:const|let|var)\\s+${name}\\s*=`),
    new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`),
    new RegExp(`^class\\s+${name}\\b`),
  ];
  for (let i = 0; i < lines.length; i++) {
    if (!patterns.some((pattern) => pattern.test(lines[i]))) continue;
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length; j++) {
      for (const character of lines[j]) {
        if (character === "{" || character === "(" || character === "[") {
          depth += 1;
          started = true;
        } else if (character === "}" || character === ")" || character === "]") {
          depth -= 1;
        }
      }
      if (started && depth <= 0 && /[})\]]\s*$/.test(lines[j])) return { start: i, end: j + 1 };
    }
  }
  throw new Error(`declaration not found in the bundle: ${name}`);
}

/** 重叠的声明范围要合并：新 bundle 里两个被抽出的函数各自把同一个顶层 const 圈进了自己的范围。 */
function mergeRanges(ranges) {
  const out = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

test("the host's own manifest validator accepts this manifest", { skip: !available }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-thinkrail-validator-"));
  const lines = readFromAsar("/out/main/index.js").toString("utf8").split("\n");
  const require = createRequire(import.meta.url);

  const wanted = ["validateManifest", "resolveFsAccess", "validateContributions"];
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  for (let round = 0; round < 40; round += 1) {
    const source =
      "// extracted verbatim from PI-Desktop app.asar out/main/index.js\n" +
      mergeRanges(wanted.map((name) => declSpan(lines, name)))
        .map(({ start, end }) => lines.slice(start, end).join("\n"))
        .join("\n\n") +
      `\nmodule.exports = { ${wanted.join(", ")} };\n`;
    // 每轮一个新文件名：CJS 的 require 有缓存，而这一轮和上一轮的依赖集不同。
    const modulePath = join(root, `validator-${round}.cjs`);
    writeFileSync(modulePath, source);
    try {
      // 缺的声明可能到**调用**时才炸（被抽出来的函数引用了一个没抽出来的 helper），
      // 所以 require 与调用必须在同一个 try 里，才能顺着 ReferenceError 补齐。
      const validator = require(modulePath);
      const result = validator.validateManifest(manifest);
      assert.equal(result.ok, true, `the host rejected the manifest: ${result.error}`);
      const access = validator.resolveFsAccess(manifest);
      assert.deepEqual(access.permissions, manifest.permissions);
      assert.deepEqual(access.policy.write, { root: "workspace", scope: ["**/*.md", ".thinkrail/**"] });
      assert.deepEqual(access.policy.delete, { root: "workspace", scope: [], own: true });
      assert.deepEqual(access.legacy, [], "no legacy pre-scope fs permission is declared");
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const missing = /(\w+) is not defined/.exec(error.message);
      if (!missing || wanted.includes(missing[1])) throw error;
      wanted.push(missing[1]);
    }
  }
  throw new Error("the validator never became loadable");
});

// ── agent 到底看到了什么 ───────────────────────────────────────────────────
//
// `agent.prompt.inject` 不是"只给一份目录让模型挑"——sidecar 会把技能目录渲染成一段
// `# Skills` 指令块，塞进**每个会话的基础系统提示**（sidecar 自己的注释：catalog rides in the
// base prompt…stays ahead of the instruction chain so the user's own AGENTS.md keeps the last
// word）。所以技能描述就是常驻指令，而正文由模型按 id 用 `Skill` 工具取。
//
// 这条测试用 sidecar 自己的渲染函数，把 agent 实际看到的那段文本跑出来检查。取那个函数
// **不按名字**——名字是宿主的内部细节（0.15.6 就把它压成了单字母），见 `blockRenderer`。

const SIDECAR = "/Applications/PI-Desktop.app/Contents/Resources/agent-runtime/sidecar.js";

/** 从 `{` 出发做朴素大括号配对 —— sidecar 的模板字符串里大括号是配平的，够用。 */
function blockSpan(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return null;
}

/** `名字(...) {` 也长得像函数头，但控制流不是渲染提示的那个函数。 */
const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "do", "else"]);

/**
 * 取出渲染 `# Skills` 块的那个函数体 —— **按结构找，不按名字找**。
 *
 * 宿主 0.15.6 把 sidecar 压成了单字母名：原来的 `pluginSkillsPrompt(skills) {` 现在是
 * `function qBe(t){…}`，于是按名字切会切空——而这份测试遇到切空是红，不是跳过。函数名是
 * 宿主的内部细节，`# Skills` 这个字面量才是这份契约的锚：它在，块就在；它不在，就该有人
 * 重新读一遍「插件技能是怎么到 agent 手上的」。做法：定位字面量，再往回找最近的、函数体
 * 跨过它的那个函数头；形参名也一起取出来（宿主那一侧叫 `t`，旧版叫 `skills`）。
 */
function blockRenderer(source) {
  const marker = source.indexOf("# Skills");
  assert.ok(
    marker !== -1,
    "the sidecar no longer renders a `# Skills` block — re-read how plugin skills reach the agent",
  );
  // 只有一处 `# Skills` 字面量，这条定位才有唯一解。出现第二处就说明宿主多了一条渲染路径
  // （或者留了一份死代码），测试没法分辨哪一份是活的——那时要人来定，不能猜。
  assert.equal(
    source.lastIndexOf("# Skills"),
    marker,
    "the sidecar now has more than one `# Skills` literal — pin the one the agent actually gets",
  );
  const from = Math.max(0, marker - 4000);
  const heads = [...source.slice(from, marker).matchAll(/([\w$]+)\s*\(([^()]*)\)\s*\{/g)];
  for (let index = heads.length - 1; index >= 0; index -= 1) {
    if (CONTROL_KEYWORDS.has(heads[index][1])) continue;
    const open = from + heads[index].index + heads[index][0].length - 1;
    const end = blockSpan(source, open);
    if (end !== null && end > marker) {
      return { params: heads[index][2], body: source.slice(open + 1, end) };
    }
  }
  throw new Error("could not find the function that renders the `# Skills` block in the sidecar");
}

/**
 * 块里引用 `Skill` 工具名的方式也随压缩变（旧版是 `SKILL_TOOL_NAME`，0.15.6 是 `TF`），
 * 所以按**值**反查标识符，再把 "Skill" 作为那个参数注进 `new Function`。
 */
function skillToolConstant(source) {
  const match = /(?:const|let|var)\s+([\w$]+)\s*=\s*"Skill"/.exec(source);
  assert.ok(match, "the sidecar no longer defines the `Skill` tool name as a constant");
  return match[1];
}

/**
 * 宿主装载插件时执行的那条描述上限（主进程的 `MAX_SKILL_DESCRIPTION_CHARS`）。
 *
 * 不从这个渲染函数里读：截断发生在**注册表**那一层，渲染函数只是把注册表手里的东西拼出来，
 * 所以只跑渲染函数看不见它。读宿主的真值，这条测试才等于「描述能完整到达 agent」。
 */
function hostSkillDescriptionCap() {
  assert.ok(available, "the app bundle is not readable — this check needs the host's own cap");
  const match = /MAX_SKILL_DESCRIPTION_CHARS\s*=\s*(\d+)/.exec(
    readFromAsar("/out/main/index.js").toString("utf8"),
  );
  assert.ok(
    match,
    "the host no longer declares MAX_SKILL_DESCRIPTION_CHARS in out/main/index.js — re-read how skill descriptions are capped",
  );
  return Number(match[1]);
}

test("the agent base prompt lists every ThinkRail skill under its host id", { skip: !existsSync(SIDECAR) }, () => {
  const source = readFileSync(SIDECAR, "utf8");
  const toolName = skillToolConstant(source);
  const { params, body } = blockRenderer(source);
  // 选中的那一份必须**引用了工具名常量**：这是唯一一条把「定位结果」绑到「生产里跑的那个
  // 函数」上的检查。光看「块里有没有这 10 条 id」分不出一个输出相同的平行渲染器。
  assert.ok(
    body.includes(toolName),
    `the located renderer does not reference ${toolName} — the locator grabbed the wrong function`,
  );
  assert.match(params, /^\s*[\w$]+\s*$/, "the host's block renderer takes exactly the skills list");

  // 挡不住的一种形态：宿主把渲染器改写成箭头函数（没有 `名字(...) {` 形态的头），定位于是落到
  // 外层包装函数上；只要那个外层函数恰好原样透传同一份字节相同的块，这几条断言就会全绿。
  // 它要求「改成箭头」与「外层恰好透传」同时成立，比改名罕见得多；而箭头形态最常见的后果是
  // 定位不到、直接 throw（见 blockRenderer 的兜底），那也是响亮失败。
  const render = new Function(toolName, `return function (${params}) {${body}}`)("Skill");

  // 宿主的 id 规则：pluginSkillId(id, skillIdFromPath(rel)) = "<pluginId>/<slug>"
  const slug = (rel) =>
    (rel.split("/").pop() ?? rel)
      .replace(/\.[^.]+$/, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill";

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const skills = manifest.contributes.skills.map((entry) => {
    const rel = typeof entry === "string" ? entry : entry.path;
    const text = readFileSync(join(dirname(MANIFEST), rel), "utf8");
    const match = /^---\nname: (\S+)\ndescription: "(.+)"\n---\n/.exec(text);
    assert.ok(match, `${rel} needs frontmatter`);
    return { id: `${manifest.id}/${slug(rel)}`, name: match[1], description: match[2] };
  });

  const block = render(skills);
  assert.match(block, /^# Skills/);
  assert.match(block, /load the skill first and follow it/, "the block tells the model to load matching skills");
  assert.match(block, /`Skill` tool/, "and how to load them");
  assert.equal(skills.length, 10);
  for (const skill of skills) {
    assert.ok(
      block.includes(`\`${skill.id}\` — ${skill.name}: ${skill.description}`),
      `the prompt is missing ${skill.id} with its full description`,
    );
  }
  // 宿主装载插件时就按它自己那个上限切（切成 cap - 1 + "…"），所以这条线读宿主的真值，
  // 不写死在这里：宿主把上限调小，等于悄悄切掉尾部那段"不适用时该用什么"的路由信息，
  // 而写死的数只会让这条测试继续绿着。
  const cap = hostSkillDescriptionCap();
  for (const skill of skills) {
    assert.ok(
      skill.description.length <= cap,
      `${skill.id} is ${skill.description.length} chars; the host truncates anything past ${cap}`,
    );
  }
  assert.equal(render([]), undefined, "no skills = no block");
});

// ── 常驻规则的投递面 ────────────────────────────────────────────────────────
//
// 规则靠 `before_agent_start` 写 `systemPromptOptions.sections[<name>]` 送进提示（与上游同一机制）。
// 这一侧能真机验的是宿主那两条前提：**名字必须过它自己那条正则**（不合规会在拼装提示时抛错），
// **改写后的 options 必须被采用**（否则写 sections 等于白写）。渲染块的形状也顺带盯一眼。
// 这**不**等于"规则真的进了发给模型的提示"——那条只有跑一轮真会话才看得见（README 的已知缺口）。

/** 宿主校验 section 名用的那个正则（`if(!NAME.test(h)||h==="preamble")throw …`）。 */
function hostSectionNamePattern(source) {
  const check = /if\(!(\w+)\.test\((\w+)\)\|\|\2==="preamble"\)throw new Error\(`Invalid system prompt section name/.exec(source);
  assert.ok(
    check,
    "the host no longer validates section names that way — re-read how it composes prompt sections",
  );
  const literal = new RegExp(`${check[1]}=/(.{0,200}?)/[a-z]*[,;)}]`).exec(source);
  assert.ok(literal, `could not find the pattern assigned to ${check[1]}`);
  return new RegExp(literal[1]);
}

/** 从 bundle 里按名字取出一个方法/函数体（`name(...) { … }`，大括号配对）。 */
function namedBody(source, name) {
  const heads = [...source.matchAll(new RegExp(`\\b${name}\\s*\\([^()]*\\)\\s*\\{`, "g"))];
  for (let index = heads.length - 1; index >= 0; index -= 1) {
    const open = heads[index].index + heads[index][0].length - 1;
    const end = blockSpan(source, open);
    if (end !== null) return source.slice(open + 1, end);
  }
  throw new Error(`not found in the bundle: ${name}`);
}

/** 从宿主 bundle 同时提取真实函数参数、async 标记和函数体。 */
function namedFunction(source, name) {
  const heads = [...source.matchAll(new RegExp(`\\b(async\\s+)?(?:function\\s+)?${name}\\s*\\(([^()]*)\\)\\s*\\{`, "g"))];
  for (let index = heads.length - 1; index >= 0; index -= 1) {
    const open = heads[index].index + heads[index][0].length - 1;
    const end = blockSpan(source, open);
    if (end !== null) {
      return {
        parameters: heads[index][2],
        isAsync: Boolean(heads[index][1]),
        body: source.slice(open + 1, end),
      };
    }
  }
  throw new Error(`function declaration not found in the bundle: ${name}`);
}

/**
 * Find the host's section composer from its rendered tag structure, not its minified function name.
 * The selected function must render a matching opening/closing tag pair while iterating sections and
 * handling the `preamble` section; among enclosing functions, choose the smallest matching body.
 */
function sectionComposerBody(source) {
  const openingTags = [...source.matchAll(/<\$\{([\w$]+)\}>/g)];
  const closingTags = [...source.matchAll(/<\/\$\{([\w$]+)\}>/g)];
  const candidates = new Map();

  for (const openingTag of openingTags) {
    const closingTag = closingTags.find(
      (tag) => tag[1] === openingTag[1] && tag.index > openingTag.index,
    );
    if (!closingTag) continue;

    const from = Math.max(0, openingTag.index - 4000);
    const heads = [...source.slice(from, openingTag.index).matchAll(/([\w$]+)\s*\(([^()]*)\)\s*\{/g)];
    for (let index = heads.length - 1; index >= 0; index -= 1) {
      if (CONTROL_KEYWORDS.has(heads[index][1])) continue;
      const bodyOpen = from + heads[index].index + heads[index][0].length - 1;
      const bodyEnd = blockSpan(source, bodyOpen);
      if (bodyEnd === null || bodyEnd < closingTag.index) continue;

      const body = source.slice(bodyOpen + 1, bodyEnd);
      if (!body.includes("preamble")) continue;
      if (!body.includes(openingTag[0]) || !body.includes(closingTag[0])) continue;
      if (!/(?:Object\.(?:entries|keys)|\.(?:entries|map)\s*\(|\bfor\s*\()/.test(body)) continue;
      candidates.set(`${bodyOpen}:${bodyEnd}`, {
        body,
        size: bodyEnd - bodyOpen,
      });
    }
  }

  assert.ok(candidates.size > 0, "could not locate the host section composer by its tagged-section structure");
  const ordered = [...candidates.values()].sort((left, right) => left.size - right.size);
  assert.notEqual(
    ordered[0].size,
    ordered[1]?.size,
    "the tagged section structure identifies one innermost composer",
  );
  return ordered[0].body;
}

test("the host accepts this plugin's prompt section and adopts the mutated options", { skip: !existsSync(SIDECAR) }, async () => {
  const source = readFileSync(SIDECAR, "utf8");
  const rule = await import(pathToFileURL(join(dirname(MANIFEST), "extensions/workflow-rule.mjs")).href);

  const pattern = hostSectionNamePattern(source);
  assert.match(rule.WORKFLOW_SECTION, pattern, `the host rejects section names outside ${pattern}`);
  assert.notEqual(rule.WORKFLOW_SECTION, "preamble", "the host reserves this name");
  assert.ok(rule.WORKFLOW_RULE.length > 0, "the section has to carry the rule");

  // 自检：抽出来的那条正则必须真的会拒绝一个带点的名字——否则它可能根本没约束任何东西。
  assert.equal(pattern.test("pi.thinkrail"), false, "the extracted pattern must reject a dotted name");

  // 钩子拿到的是**可被改写**的那一份 options，且返回后宿主采用它——这是"写 sections 有效"的全部依据。
  const emit = namedBody(source, "emitBeforeAgentStart");
  assert.match(emit, /systemPromptOptions/, "the runner must hand the options to extensions");
  assert.match(emit, /return\s*\{[\s\S]*?systemPromptOptions[\s\S]*?\}/, "and adopt whatever the hook left in them");
  assert.match(emit, /forceSystemPrompt/, "a returned systemPrompt is the force path — which is why we never return one");

  // 扩展贡献的 section 渲染成 `<name>…</name>` 块（上游自己的测试断言的也是这个形状）。
  const compose = sectionComposerBody(source);
  assert.match(compose, /preamble/, "sanity: this is the section composer, not a call site");
  assert.match(compose, /<\$\{[\w$]+\}>/, "each section renders as an opening tag");
  assert.match(compose, /<\/\$\{[\w$]+\}>/, "and a closing one");
});
test("the host fs request resolver blocks symlink escapes for reads and writes", { skip: !available }, async () => {
  const source = readFromAsar("/out/main/index.js").toString("utf8");
  const bindHostFunction = (name, dependencies = {}) => {
    const declaration = namedFunction(source, name);
    const factory = new Function(
      ...Object.keys(dependencies),
      `return ${declaration.isAsync ? "async " : ""}function ${name}(${declaration.parameters}) { ${declaration.body} }`,
    );
    return factory(...Object.values(dependencies));
  };

  const hostResolveWithinRoot = bindHostFunction("resolveWithinRoot", { resolve, sep });
  const hostPathIsWithin = bindHostFunction("pathIsWithin", { relative, isAbsolute, sep });
  const hostResolveRealPathWithinRoot = bindHostFunction("resolveRealPathWithinRoot", {
    resolveWithinRoot: hostResolveWithinRoot,
    realpath: realpathAsync,
    resolve,
    pathIsWithin: hostPathIsWithin,
  });
  const hostResolveRealPathForCreateWithinRoot = bindHostFunction("resolveRealPathForCreateWithinRoot", {
    resolveWithinRoot: hostResolveWithinRoot,
    realpath: realpathAsync,
    resolve,
    join,
    pathIsWithin: hostPathIsWithin,
    dirname,
    basename,
  });
  const normalizeFsPath = bindHostFunction("normalizeFsPath");
  const isDeniedFsPath = bindHostFunction("isDeniedFsPath", {
    normalizeFsPath,
    FS_DENY_DIR_SEGMENTS: new Set(),
    FS_DENY_FILE_PATTERNS: [],
  });
  const realpathOrSelf = bindHostFunction("realpathOrSelf", { realpathSync, resolve });
  const apiError = (code, message) => Object.assign(new Error(message), { code });
  const hostResolverBody = namedBody(source, "resolveFsRequest");
  assert.match(
    hostResolverBody,
    /options\.create\s*\?\s*await\s+resolveRealPathForCreateWithinRoot\(root,\s*requestPath\)\s*:\s*await\s+resolveRealPathWithinRoot\(root,\s*requestPath\)/,
    "the host request resolver must route reads and creates through its realpath containment helpers",
  );
  const resolveFsRequest = bindHostFunction("resolveFsRequest", {
    apiError,
    isAbsolute,
    resolve,
    realpathSync,
    statSync,
    basename,
    dirname,
    resolveRealPathForCreateWithinRoot: hostResolveRealPathForCreateWithinRoot,
    resolveRealPathWithinRoot: hostResolveRealPathWithinRoot,
    resolveWithinRoot: hostResolveWithinRoot,
    existsSync,
    realpathOrSelf,
    relative,
    normalizeFsPath,
    isDeniedFsPath,
    // Scope and permission handling are deliberately controlled by the fixture; this test isolates
    // the host's actual lexical/canonical containment logic and runs before the scope check.
    isFsPathInScope: (_rel, scope) => scope.includes("**/*"),
  });

  const tempRoot = mkdtempSync(join(tmpdir(), "pi-thinkrail-host-fs-"));
  try {
    const workspace = join(tempRoot, "workspace");
    const outside = join(tempRoot, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(join(workspace, "safe.md"), "inside workspace");
    writeFileSync(join(outside, "secret.md"), "outside secret");
    writeFileSync(join(outside, "sentinel.md"), "unchanged");
    symlinkSync(join(outside, "secret.md"), join(workspace, "file-link.md"), "file");
    symlinkSync(outside, join(workspace, "dir-link"), "dir");

    const loaded = {
      fsPolicy: {
        read: { root: "workspace", scope: ["**/*"] },
        write: { root: "workspace", scope: ["**/*"] },
      },
    };
    const host = {
      assertPermission() {},
      fsRoot() { return workspace; },
      auditFs() {},
      isProtectedPath() { return false; },
      ownsWrite() { return false; },
      requestFsConsent() { throw new Error("the fixture scope should allow in-root paths"); },
      services: {},
    };
    const resolveRequest = (mode, rel, create = false) =>
      resolveFsRequest.call(host, loaded, mode, rel, create ? { create: true } : {});
    const readThroughResolver = async (rel) => {
      const { full } = await resolveRequest("read", rel);
      return readFileSync(full, "utf8");
    };
    const writeThroughResolver = async (rel, content) => {
      const { full } = await resolveRequest("write", rel, true);
      writeFileSync(full, content, "utf8");
    };

    assert.equal(await readThroughResolver("safe.md"), "inside workspace");
    await writeThroughResolver("created.md", "inside write");
    assert.equal(readFileSync(join(workspace, "created.md"), "utf8"), "inside write");

    await assert.rejects(readThroughResolver("file-link.md"), { code: "INVALID_ARGUMENT" });
    await assert.rejects(readThroughResolver("dir-link/secret.md"), { code: "INVALID_ARGUMENT" });
    await assert.rejects(writeThroughResolver("file-link.md", "overwrite"), { code: "INVALID_ARGUMENT" });
    await assert.rejects(writeThroughResolver("dir-link/created.md", "escape"), { code: "INVALID_ARGUMENT" });
    await assert.rejects(writeThroughResolver("../outside/new.md", "escape"), { code: "INVALID_ARGUMENT" });

    assert.equal(readFileSync(join(outside, "secret.md"), "utf8"), "outside secret");
    assert.equal(readFileSync(join(outside, "sentinel.md"), "utf8"), "unchanged");
    assert.equal(existsSync(join(outside, "created.md")), false);
    assert.equal(existsSync(join(outside, "new.md")), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
