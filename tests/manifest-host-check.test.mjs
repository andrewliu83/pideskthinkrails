// 用 PI-Desktop **自己**的 manifest 校验器检查本插件的 manifest。
//
// 校验器住在 app.asar 的 out/main/index.js 里，没有单独导出。这里按名字把需要的那几个声明
// 原样切出来（大括号配对 + 顺着 ReferenceError 补齐依赖）拼成一个临时模块再跑——于是
// 「安装器会不会收下这个 manifest」这个问题得到的是宿主的答案，而不是我的解读。
//
// 机器上没装 PI-Desktop 就跳过。

import assert from "node:assert/strict";
import test from "node:test";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
// 这条测试用 sidecar 自己的渲染函数，把 agent 实际看到的那段文本跑出来检查。

const SIDECAR = "/Applications/PI-Desktop.app/Contents/Resources/agent-runtime/sidecar.js";

/** 从 sidecar 里原样取出一个方法体（大括号配对），交给 new Function 执行。 */
function extractSidecarMethod(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `sidecar no longer contains ${signature}`);
  const body = source.slice(start + signature.length);
  let depth = 1;
  let index = 0;
  for (; index < body.length && depth > 0; index += 1) {
    if (body[index] === "{") depth += 1;
    else if (body[index] === "}") depth -= 1;
  }
  return body.slice(0, index - 1);
}

test("the agent base prompt lists every ThinkRail skill under its host id", { skip: !existsSync(SIDECAR) }, () => {
  const source = readFileSync(SIDECAR, "utf8");
  const render = new Function(
    "SKILL_TOOL_NAME",
    `return function (skills) {${extractSidecarMethod(source, "pluginSkillsPrompt(skills) {")}}`,
  )("Skill");

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
  // 描述没被宿主截断（>240 会被切掉尾部，而尾部正是"不适用时该用什么"的路由信息）。
  for (const skill of skills) {
    assert.ok(skill.description.length <= 240, `${skill.id} description is ${skill.description.length} chars`);
  }
  assert.equal(render([]), undefined, "no skills = no block");
});
