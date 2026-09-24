// pi.thinkrail — 插件契约与端到端行为的测试。
//
// 这里不碰 Electron：`globalThis.pi` 是本插件唯一的宿主接口，所以测试自己造一个。
//
// 假宿主刻意不是「什么都允许」的：它按 manifest 里声明的那份 fs scope 校验每一次
// writeText / remove，于是「插件只会在自己声明的范围内动文件」这条契约真的被测到，
// 而不是靠人读代码相信。

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(here, "../plugins/pi.thinkrail");
const pluginRequire = createRequire(join(PLUGIN_DIR, "package-entry.cjs"));
const main = pluginRequire(join(PLUGIN_DIR, "main.js"));
const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8"));

const TOOL_PREFIX = "plugin_pi_thinkrail_";

// ── 假宿主 ─────────────────────────────────────────────────────────────────

/** manifest 声明的写范围，假宿主照它执行——这是插件自己的契约，不是宿主的实现。 */
const HOST_SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__"]);

function scopeAllows(rel) {
  return rel.endsWith(".md") || rel === ".thinkrail" || rel.startsWith(".thinkrail/");
}

function createHost(projectDir, dataDir, options = {}) {
  const written = new Set();
  const tools = new Map();
  const commands = new Map();
  /** 这个插件进程弹过的 toast —— 命令留下的提示都落在这里。 */
  const toasts = [];
  const settings = { ...(options.settings || {}) };
  const calls = [];

  // 宿主按**发起调用的会话**把 pi.fs.* 定根（ADR 0266）；面板是窗口级视图，跟随可见项目。
  // 假宿主照这条规则来：工具执行期间按 sessionId 定根，其余时候按 workspacePath。
  const sessionProjects = new Map();
  if (options.session) sessionProjects.set(options.session, projectDir);
  let currentSession = null;
  let workspacePath = options.noProject ? null : projectDir;

  const rootFor = (api) => {
    if (currentSession !== null) {
      const dir = sessionProjects.get(currentSession);
      if (!dir) throw Object.assign(new Error("No project for this session"), { code: "NOT_FOUND", api });
      return dir;
    }
    if (!workspacePath) throw Object.assign(new Error("No workspace is open"), { code: "NOT_FOUND", api });
    return workspacePath;
  };
  const abs = (rel) => join(rootFor("fs"), rel);

  const withSession = async (sessionId, run) => {
    const previous = currentSession;
    currentSession = sessionId ?? null;
    try {
      return await run();
    } finally {
      currentSession = previous;
    }
  };

  const fs = {
    /** 宿主 pi.fs.glob：自己走树，最多返回 500 条匹配，且不告诉你被截断了。 */
    async glob(pattern) {
      calls.push(["fs.glob", pattern]);
      const suffix = pattern.slice(pattern.lastIndexOf("**"));
      const base = pattern.slice(0, pattern.length - suffix.length).replace(/\/$/, "");
      const root = base ? abs(base) : rootFor("fs.glob");
      const out = [];
      const visit = (dir, prefix) => {
        if (out.length >= 500) return;
        let names = [];
        try {
          names = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of names) {
          if (out.length >= 500) return;
          if (HOST_SKIP_DIRS.has(entry.name)) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            visit(join(dir, entry.name), rel);
            continue;
          }
          if (rel.endsWith(".md")) out.push(rel);
        }
      };
      visit(root, base);
      return out;
    },
    async stat(rel) {
      calls.push(["fs.stat", rel]);
      const info = statSync(abs(rel));
      if (!info.isFile()) {
        throw Object.assign(new Error("only files can be stated"), { code: "INVALID_ARGUMENT" });
      }
      return { size: info.size, mtimeMs: info.mtimeMs };
    },
    async readText(rel) {
      calls.push(["fs.readText", rel]);
      return readFileSync(abs(rel), "utf8");
    },
    async writeText(rel, content) {
      calls.push(["fs.writeText", rel]);
      assert.ok(scopeAllows(rel), `write outside the declared manifest.fs.write scope: ${rel}`);
      const target = abs(rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      written.add(target);
    },
    async remove(rel) {
      calls.push(["fs.remove", rel]);
      // manifest 声明的是 `"delete": { "own": true }`，也就是只删本插件写过的文件。
      const target = abs(rel);
      assert.ok(written.has(target), `delete outside manifest.fs.delete scope: ${rel}`);
      rmSync(target);
    },
    async list(rel) {
      calls.push(["fs.list", rel]);
      const dir = rel ? abs(rel) : rootFor("fs.list");
      return readdirSync(dir, { withFileTypes: true }).map((entry) => {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return { name: entry.name, path, isDirectory: true };
        const info = statSync(join(dir, entry.name));
        return { name: entry.name, path, isDirectory: false, size: info.size, mtimeMs: info.mtimeMs };
      });
    },
  };

  const pi = {
    app: {
      getLocale: async () => options.locale ?? "en",
      getVersion: async () => "0.0.0-test",
    },
    workspace: {
      get: async () => {
        calls.push(["workspace.get"]);
        if (options.workspaceError) throw options.workspaceError;
        if (!workspacePath) return null;
        return { path: workspacePath, name: basename(workspacePath) };
      },
    },
    plugin: {
      getId: () => manifest.id,
      getManifest: () => manifest,
      getSettings: async () => ({ ...settings }),
      setSettings: async (patch) => Object.assign(settings, patch),
      getDataPath: async () => dataDir,
    },
    fs,
    agent: {
      registerTool: async (tool) => {
        // 宿主调用工具时会带上那个会话的 ctx；假宿主也一样，并据此定根 pi.fs。
        tools.set(tool.name, {
          ...tool,
          execute: (args, ctx) => withSession(ctx?.sessionId, () => tool.execute(args, ctx)),
        });
      },
      unregisterTool: async (name) => {
        tools.delete(name);
      },
    },
    commands: {
      register: async (command) => {
        commands.set(command.id, command);
      },
      unregister: async (id) => {
        commands.delete(id);
      },
    },
    ui: { openPanel: async () => {}, showToast: async (message) => toasts.push(message) },
  };

  globalThis.pi = pi;
  return {
    pi,
    tools,
    commands,
    settings,
    written,
    calls,
    toasts,
    /** 模拟用户切到另一个项目，或落到一个没有项目的临时会话（宿主报 null）。 */
    setWorkspace: (path) => {
      workspacePath = path;
    },
    /** 让某个会话属于某个项目（宿主按会话定根 pi.fs）。 */
    setSessionProject: (sessionId, path) => {
      sessionProjects.set(sessionId, path);
    },
  };
}

function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-thinkrail-"));
  const projectDir = join(root, "project");
  const dataDir = join(root, "data");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  // 每个 setup 一段新的会话：宿主按会话 id 把工具调用定根到项目。
  activeSession = randomUUID();
  const host = createHost(projectDir, dataDir, { ...options, session: activeSession });
  return { root, projectDir, dataDir, host, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}


// 会话 id 每个 setup() 都是新的：宿主按会话 id 把 pi.fs.* 定根到项目，复用同一个 id 会把
// 上一个测试的项目带进来。
let activeSession = "s1";
const call = (tool, args) => tool.execute(args ?? {}, { sessionId: activeSession });
const callAs = (sessionId, tool, args) => tool.execute(args ?? {}, { sessionId });

/**
 * 面板读一次 state，并等索引落定。
 *
 * 首次打开时 `state` 有意**不**等全树枚举（那是几秒的宿主遍历），而是先回一份空快照 +
 * `indexing: true`，让视图立刻开出来。测试里要拿完整结果，就轮询到它落定为止。
 */
async function panelState(payload) {
  for (let i = 0; i < 100; i += 1) {
    const state = await main.onPanelInvoke("state", payload ?? {});
    if (!state.indexing) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the index never settled");
}

// ── manifest ───────────────────────────────────────────────────────────────

test("manifest declares the identity, permissions and engines the installer requires", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.thinkrail");
  assert.equal(basename(PLUGIN_DIR), manifest.id, "manifest id must match the directory name");
  assert.equal(manifest.main, "main.js");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  for (const locale of ["en", "zh-CN"]) {
    const entry = manifest.i18n[locale];
    assert.ok(entry.name && entry.description && entry.safetyNotes, `i18n.${locale} is incomplete`);
  }
  assert.equal(manifest.engines.piDesktop, ">=0.15.6");
  assert.deepEqual(manifest.permissions, [
    "ui.view",
    "agent.tool.register",
    "agent.prompt.inject",
    // 唯一一项会把代码送进 agent 进程的权限：无条件常驻规则用它实现（见下面的扩展测试）。
    "agent.extension",
    "fs.read",
    "fs.write",
    "fs.delete",
  ]);
  assert.deepEqual(manifest.contributes.views, [
    {
      id: "thinkrail",
      title: { en: "ThinkRail", "zh-CN": "ThinkRail" },
      icon: "workflow",
      entry: "renderer/index.html",
      order: 22,
    },
  ]);
  assert.equal(manifest.ui.panel, undefined, "a docked view must not also declare a detached panel");
  assert.ok(existsSync(join(PLUGIN_DIR, manifest.contributes.views[0].entry)));
  assert.deepEqual(manifest.fs.read.scope, ["**/*"]);
  assert.deepEqual(manifest.fs.write.scope, ["**/*.md", ".thinkrail/**"]);
  assert.equal(manifest.fs.delete.own, true);
});

test("every declared skill exists, has frontmatter, and fits the host limits", () => {
  assert.equal(manifest.contributes.skills.length, 10);
  for (const relative of manifest.contributes.skills) {
    const text = readFileSync(join(PLUGIN_DIR, relative), "utf8");
    const match = /^---\nname: (\S+)\ndescription: "(.+)"\n---\n/.exec(text);
    assert.ok(match, `${relative} needs name + description frontmatter`);
    assert.equal(match[1], basename(relative, ".md"));
    assert.ok(match[2].length <= 240, `${relative} description is ${match[2].length} chars`);
    assert.ok(Buffer.byteLength(text, "utf8") <= 128 * 1024, `${relative} is too large`);
    // 技能是单文件：PI-Desktop 的 Skill 只读这一个文件，同级文档取不到。
    assert.ok(!/`(?:creating|syncing|screenshots|checks|review-comments)\.md`/.test(text), `${relative} points at a sibling doc`);
    assert.ok(!/\.dsh-thinkrail/.test(text), `${relative} still references the DSH scratch dir`);
  }
});

test("contributes.agentTools matches the tools the plugin actually registers", async () => {
  const ctx = setup();
  try {
    await main.onLoad();
    const declared = manifest.contributes.agentTools.map((tool) => tool.name);
    assert.deepEqual([...ctx.host.tools.keys()].sort(), [...declared].sort());
    assert.equal(declared.length, 7);
    for (const tool of manifest.contributes.agentTools) {
      assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
      assert.ok(["low", "medium", "high"].includes(tool.risk), `${tool.name} has an invalid risk`);
    }
    for (const registered of ctx.host.tools.values()) {
      assert.equal(registered.schema.type, "object");
      assert.equal(registered.schema.additionalProperties, false);
      assert.equal(typeof registered.execute, "function");
      // 宿主读的是**注册时**描述符里的 risk（`this.tools.set(fullName, { …, risk: descriptor.risk })`）：
      // manifest 里那份是另一份副本（校验器拿它做校验与安装页展示）。两边不一致时，真正决定审批卡
      // 上风险标签的是这里，所以这一条必须比对，而不是只校验 manifest。
      const declaredRisk = manifest.contributes.agentTools.find((entry) => entry.name === registered.name);
      assert.ok(declaredRisk, `${registered.name} is registered but not declared`);
      assert.equal(
        registered.risk,
        declaredRisk.risk,
        `${registered.name}: registered risk (${registered.risk}) must match the manifest (${declaredRisk.risk})`,
      );
    }
  } finally {
    ctx.cleanup();
  }
});

test("onLoad registers two commands and onUnload takes everything back", async () => {
  const ctx = setup();
  try {
    await main.onLoad();
    assert.deepEqual([...ctx.host.commands.keys()].sort(), [
      "thinkrail.open",
      "thinkrail.openSpecs",
    ]);
    assert.equal(ctx.host.tools.size, 7);
    await main.onUnload();
    assert.equal(ctx.host.tools.size, 0);
    assert.equal(ctx.host.commands.size, 0);
  } finally {
    ctx.cleanup();
  }
});

test("a command records the page it wants and tells the user where the view is", async () => {
  const ctx = setup();
  try {
    const toasts = [];
    await main.onLoad();
    ctx.host.pi.ui.showToast = async (message) => {
      toasts.push(message);
    };

    const before = await main.onPanelInvoke("hint", {});
    assert.equal(before.ok, true);
    assert.equal(before.token, 0);
    assert.equal(before.view, "specs");
    assert.equal(typeof before.indexedAt, "number");

    await ctx.host.commands.get("thinkrail.openSpecs").run();
    const after = await main.onPanelInvoke("hint", {});
    assert.equal(after.token, 1, "the token moves so a polling view notices");
    assert.equal(after.view, "specs");
    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /Mod\+J/);
    assert.match(toasts[0], /Spec 图|Specs/);

    // 读到同一个 token 是无害的：视图可能被挂起，也可能不止一个读者。
    const again = await main.onPanelInvoke("hint", {});
    assert.equal(again.token, after.token);
    assert.equal(again.view, after.view);
  } finally {
    main.__test.resetHint();
    ctx.cleanup();
  }
});

test("the hint answers in the app language", async () => {
  const ctx = setup({ locale: "zh-CN" });
  try {
    const toasts = [];
    ctx.host.pi.ui.showToast = async (message) => {
      toasts.push(message);
    };
    await main.onLoad();
    await ctx.host.commands.get("thinkrail.openSpecs").run();
    assert.match(toasts[0], /右侧工作面板/);
    assert.match(toasts[0], /Spec 图/);
  } finally {
    main.__test.resetHint();
    ctx.cleanup();
  }
});

// ── spec tools ─────────────────────────────────────────────────────────────

test("the seven spec tools round-trip a real file through the fs gateway", async () => {
  const ctx = setup();
  try {
    await main.onLoad();
    const tool = (name) => ctx.host.tools.get(name);

    const created = await call(tool("spec_create"), {
      path: "docs/SPEC.md",
      id: "docs",
      type: "module-design",
      title: "Docs",
    });
    assert.match(created.content, /Created docs\/SPEC\.md \(id: docs\)\./);
    const file = readFileSync(join(ctx.projectDir, "docs/SPEC.md"), "utf8");
    assert.equal(
      file,
      "---\nid: docs\ntype: module-design\ntitle: Docs\n---\n\n## 职责\n\n## 边界\n",
    );

    const duplicate = await call(tool("spec_create"), {
      path: "docs/other.md",
      id: "docs",
      type: "module-design",
      title: "Other",
    });
    assert.match(duplicate.error, /already in use/);

    const exists = await call(tool("spec_create"), {
      path: "docs/SPEC.md",
      id: "second",
      type: "module-design",
      title: "Second",
    });
    assert.match(exists.error, /already exists/);

    const bad = await call(tool("spec_create"), {
      path: "../escape.md",
      id: "escape",
      type: "module-design",
      title: "Escape",
    });
    assert.match(bad.error, /must stay inside the project root/);

    await call(tool("spec_create"), {
      path: "goal.md",
      id: "goal",
      type: "goal-and-requirements",
      title: "Goal",
      tags: ["core"],
    });
    await call(tool("spec_update"), { id: "docs", set: { parent: "goal" }, addList: { tags: ["docs"] } });

    const get = await call(tool("spec_get"), { id: "docs" });
    assert.match(get.content, /^docs \[module-design\] — Docs/);
    assert.match(get.content, /links:\n {2}parent -> goal \(goal\.md\)/);
    // 反向边落在父节点上：goal 的 frontmatter 没写 docs，是 docs 的 parent 指过来的。
    const parent = await call(tool("spec_get"), { id: "goal" });
    assert.match(parent.content, /referenced by:\n {2}parent -> docs \(docs\/SPEC\.md\)/);

    const graph = await call(tool("spec_graph"), { root: "goal", direction: "subtree", depth: 2 });
    assert.match(graph.content, /nodes \(2\):/);
    assert.match(graph.content, /docs --parent--> goal|goal --parent--> docs/);

    const grep = await call(tool("spec_grep"), { pattern: "Docs", type: "module-design" });
    assert.match(grep.content, /docs\/SPEC\.md:/);
    assert.equal((await call(tool("spec_grep"), { pattern: "nothing-here" })).content, "No matches.");

    assert.equal((await call(tool("spec_validate"), {})).content, "Spec-graph is valid: no issues found.");

    const updated = readFileSync(join(ctx.projectDir, "docs/SPEC.md"), "utf8");
    assert.match(updated, /^---\nid: docs\ntype: module-design\ntitle: Docs\nparent: goal\ntags: \[docs\]\n---\n/);
    assert.match(updated, /\n## 职责\n/, "prose survives a frontmatter edit");

    const deleted = await call(tool("spec_delete"), { id: "docs" });
    assert.match(deleted.content, /Deleted docs\/SPEC\.md \(id: docs\)\./);
    assert.equal(existsSync(join(ctx.projectDir, "docs/SPEC.md")), false);
  } finally {
    ctx.cleanup();
  }
});

test("the spec tools work while no project is visible in the window", async () => {
  const ctx = setup({ noProject: true });
  try {
    await main.onLoad();
    writeFileSync(join(ctx.projectDir, "a.md"), "---\nid: a\ntype: task-spec\ntitle: A\n---\n");
    const result = await call(ctx.host.tools.get("spec_grep"), { pattern: "A" });
    assert.match(result.content, /a\.md:/);
    assert.doesNotMatch(result.content, /Ran in PI-Desktop's active project/);
    // 没有项目可见不再是插件的失败：宿主按会话定根，工具照常。
    assert.equal(ctx.host.toasts.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("each session's spec tools are rooted by that session, not by the visible project", async () => {
  const ctx = setup();
  try {
    await main.onLoad();
    // 会话 A 属于 ctx.projectDir；另起一个项目与会话 B，窗口里可见的又是第三个项目。
    const projectB = join(ctx.root, "project-b");
    const projectC = join(ctx.root, "project-c");
    mkdirSync(projectB, { recursive: true });
    mkdirSync(projectC, { recursive: true });
    const sessionB = randomUUID();
    ctx.host.setSessionProject(sessionB, projectB);
    writeFileSync(join(ctx.projectDir, "a.md"), "---\nid: a\ntype: task-spec\ntitle: A\n---\n");
    writeFileSync(join(projectB, "b.md"), "---\nid: b\ntype: task-spec\ntitle: B\n---\n");
    ctx.host.setWorkspace(projectC);

    const specGet = ctx.host.tools.get("spec_get");
    const fromA = await callAs(activeSession, specGet, { id: "a" });
    assert.match(fromA.content, /a \[task-spec\] — A/);
    assert.match((await callAs(activeSession, specGet, { id: "b" })).error, /No spec with id "b"/);
    const fromB = await callAs(sessionB, specGet, { id: "b" });
    assert.match(fromB.content, /b \[task-spec\] — B/);
    assert.match((await callAs(sessionB, specGet, { id: "a" })).error, /No spec with id "a"/);

    // 结果不随可见项目变：它只认发起调用的会话。
    assert.doesNotMatch(fromA.content, /Ran in PI-Desktop's active project/);
    assert.equal(fromA.content.includes(projectB), false);
    assert.equal(fromB.content.includes(ctx.projectDir), false);
    assert.equal(fromA.content.includes(projectC), false, "the visible project never leaks into a tool result");
  } finally {
    ctx.cleanup();
  }
});

test("the tools surface the host's own error when it has no root", async () => {
  const ctx = setup();
  try {
    await main.onLoad();
    writeFileSync(join(ctx.projectDir, "a.md"), "---\nid: a\ntype: task-spec\ntitle: A\n---\n");
    // 没有 sessionId 时宿主按窗口里可见的项目定根；真失败时错误原样浮现，不被改写。
    const result = await ctx.host.tools.get("spec_validate").execute({}, {});
    assert.match(result.content, /Spec-graph is valid/);
    assert.doesNotMatch(result.content, /Ran in PI-Desktop's active project/);
    ctx.host.setWorkspace(null);
    const gone = await ctx.host.tools.get("spec_validate").execute({}, {});
    assert.match(gone.error, /No workspace is open/);
  } finally {
    ctx.cleanup();
  }
});

test("an unavailable host surfaces its own error, not a rewritten one", async () => {
  const ctx = setup({ workspaceError: new Error("host unavailable") });
  try {
    await main.onLoad();
    const state = await main.onPanelInvoke("state", {});
    assert.equal(state.ok, false);
    assert.match(state.error, /host unavailable/);
  } finally {
    ctx.cleanup();
  }
});

test("the index only sees .md files and re-reads what changed", async () => {
  const ctx = setup();
  try {
    await main.onLoad();
    writeFileSync(join(ctx.projectDir, "notes.txt"), "id: nope\ntype: x\n");
    writeFileSync(join(ctx.projectDir, "a.md"), "---\nid: a\ntype: task-spec\ntitle: A\n---\n");
    const first = await call(ctx.host.tools.get("spec_get"), { id: "a" });
    assert.match(first.content, /a \[task-spec\] — A/);
    writeFileSync(join(ctx.projectDir, "b.md"), "---\nid: b\ntype: module-design\ntitle: B\n---\n");
    const listed = await call(ctx.host.tools.get("spec_graph"), { root: "b", direction: "subtree" });
    assert.match(listed.content, /b \[module-design\]/);
    rmSync(join(ctx.projectDir, "b.md"));
    const gone = await call(ctx.host.tools.get("spec_get"), { id: "b" });
    assert.match(gone.error, /No spec with id "b"/);
  } finally {
    ctx.cleanup();
  }
});

// ── panel channels ─────────────────────────────────────────────────────────

test("panel state reports the project and the graph", async () => {
  const ctx = setup();
  try {
    writeFileSync(
      join(ctx.projectDir, "SPEC.md"),
      "---\nid: root\ntype: goal-and-requirements\ntitle: Root\n---\nbody\n",
    );
    await main.onLoad();

    const state = await panelState();
    assert.equal(state.ok, true);
    assert.equal(state.project.path, ctx.projectDir);
    assert.equal(state.specRoot, ctx.projectDir);
    assert.equal(state.specError, null);
    assert.equal(state.specs.count, 1);
    assert.equal(state.specs.issues.valid, true);
    assert.equal(state.specs.nodes[0].id, "root");

    // 详情页只要正文 + frontmatter；id/类型/链接来自 state 里已经带下来的节点。
    const detail = await main.onPanelInvoke("spec", { file: "SPEC.md" });
    assert.deepEqual(detail, {
      ok: true,
      file: "SPEC.md",
      body: "body\n",
      frontmatter: { id: "root", type: "goal-and-requirements", title: "Root" },
    });
    assert.equal(state.specs.nodes[0].id, "root");
    assert.deepEqual(state.specs.nodes[0].links, []);

    // 非 .md 路径由路径校验挡下；.md 但不存在则是一次可读的失败，不触发任何枚举。
    assert.match((await main.onPanelInvoke("spec", { file: "notes.txt" })).error, /must end in \.md/);

    const grep = await main.onPanelInvoke("grep", { pattern: "body" });
    assert.equal(grep.ok, true);
    assert.equal(grep.matches.length, 1);

    const unknown = await main.onPanelInvoke("nope", {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /Unsupported panel channel/);
  } finally {
    ctx.cleanup();
  }
});

test("panel state degrades to a message when nothing is open", async () => {
  const ctx = setup({ noProject: true });
  try {
    main.__test.resetProjectMemory();
    await main.onLoad();
    const state = await main.onPanelInvoke("state", {});
    assert.equal(state.ok, true);
    assert.equal(state.project, null);
    assert.equal(state.specs, null);
    assert.match(state.specError, /No project is open/);
    assert.match(state.specError, /activate/i);
    assert.equal(Object.prototype.hasOwnProperty.call(state, "lastProject"), false, "the backend message already names the project");
  } finally {
    ctx.cleanup();
  }
});

test("the panel names the project it last showed when the active one is cleared", async () => {
  const ctx = setup();
  try {
    main.__test.resetProjectMemory();
    await main.onLoad();
    await panelState();
    ctx.host.setWorkspace(null);
    const state = await main.onPanelInvoke("state", {});
    assert.equal(state.project, null, "a project-less host is not a project to read");
    // 面板说的是它**自己**上次显示过的项目（不是某个后台会话最后碰到的那个）。
    assert.ok(state.specError.includes(ctx.projectDir), state.specError);
    assert.equal(Object.prototype.hasOwnProperty.call(state, "lastProject"), false);
  } finally {
    ctx.cleanup();
  }
});

// ── 移植面的边界 ───────────────────────────────────────────────────────────

test("the plugin writes only inside the declared fs scope", async () => {
  const ctx = setup();
  try {
    await main.onLoad();
    await call(ctx.host.tools.get("spec_create"), {
      path: ".thinkrail/context/draft.md",
      id: "draft",
      type: "task-spec",
      title: "Draft",
    });
    const writes = ctx.host.calls.filter(([name]) => name === "fs.writeText").map(([, rel]) => rel);
    assert.deepEqual(writes, [".thinkrail/context/.gitignore", ".thinkrail/context/draft.md"]);
    assert.equal(
      readFileSync(join(ctx.projectDir, ".thinkrail/context/.gitignore"), "utf8"),
      "*\n",
    );
    const removes = ctx.host.calls.filter(([name]) => name === "fs.remove");
    assert.deepEqual(removes, []);
  } finally {
    ctx.cleanup();
  }
});

test("no plugin source outside lib/vendor touches node:fs, child_process or the environment", () => {
  const roots = [join(PLUGIN_DIR, "main.js"), join(PLUGIN_DIR, "lib")];
  const files = [];
  const collect = (path) => {
    if (statSync(path).isDirectory()) {
      // 工作区读写的唯一出口是宿主的 fs 网关（lib/fio.js）；`lib/vendor/**` 是照抄的 yaml
      // 依赖，有它自己的少量 fs 用法，不在本插件的边界之内。
      if (path.includes(`${sep}vendor${sep}`)) return;
      for (const name of readdirSync(path)) collect(join(path, name));
      return;
    }
    if (path.endsWith(".js")) files.push(path);
  };
  roots.forEach(collect);
  assert.ok(files.length >= 8, "expected the whole plugin source to be scanned");

  for (const file of files) {
    // 注释里会提到这些名字（"不再直接 require(\"node:fs\")"），先剥注释再找真调用。
    const source = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const relative = file.slice(PLUGIN_DIR.length + 1);
    assert.ok(!/require\(["']node:fs["']\)/.test(source), `${relative} bypasses the fs gateway`);
    assert.ok(!/require\(["']node:child_process["']\)/.test(source), `${relative} spawns a child process`);
    assert.ok(!/\bprocess\.env\b/.test(source), `${relative} reads the environment`);
  }
});

// ── 无条件常驻规则（agent 进程内扩展） ──────────────────────────────────────
//
// 这是本插件唯一一处跑在 agent 进程里、**不受 fs 网关约束**的代码，所以它比别处更值得被钉住：
// 声明必须与权限配套；文件必须保持可审阅（无 import / 无 require / 不碰文件系统与网络）；
// 它必须只挂 before_agent_start，并且按上游 SPEC 写明的机制**写命名 section**、返回空对象——
// 返回 `{ systemPrompt }` 是"强制整条提示"那条路，宿主语义会丢掉所有结构化 section（含别的插件
// 贡献的），上游正是不用它。

test("the standing-rule module is declared with its permission and stays auditable", async () => {
  const declared = manifest.contributes.agentExtensions;
  assert.deepEqual(declared, ["extensions/workflow-rule.mjs"]);
  assert.ok(manifest.permissions.includes("agent.extension"), "the host rejects the declaration without it");

  const file = join(PLUGIN_DIR, declared[0]);
  assert.ok(existsSync(file), "declared module must exist");
  const source = readFileSync(file, "utf8");
  // 注释里会引用这些名字（"no imports" 之类），所以先剥注释再找真调用。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // 这个模块不受 fs 网关约束，所以它的可审阅性是**唯一**的约束——静态导入/require 之外，
  // 动态 import、eval、new Function、process/Buffer 这些同样是逃逸面，一并钉住。
  assert.doesNotMatch(code, /^\s*import\s/m, "no static import");
  assert.doesNotMatch(code, /\bimport\s*\(/, "no dynamic import");
  assert.doesNotMatch(code, /require\s*\(/, "no require");
  assert.doesNotMatch(code, /\beval\s*\(|new Function\b/, "no eval / Function");
  assert.doesNotMatch(code, /\bprocess\b|\bBuffer\b|globalThis/, "no process, no Buffer, no globals");
  assert.doesNotMatch(code, /node:fs|node:net|node:http|child_process|\bfetch\s*\(/, "no fs, no network");
  assert.ok(source.length < 8 * 1024, "small enough to read before enabling");

  const mod = await import(pathToFileURL(file).href);
  assert.equal(typeof mod.default, "function", "the host calls the default export as the factory");

  const handlers = new Map();
  const pi = { on: (event, handler) => handlers.set(event, handler) };
  mod.default(pi);
  assert.deepEqual([...handlers.keys()], ["before_agent_start"], "one hook, the supported one");

  const base = "# Skills\n\n- `pi.thinkrail/choosing-a-workflow` — …";
  // 投递方式与上游一致：写自己的命名 section，且**不返回 systemPrompt**——后者会被宿主当成强制整条
  // 提示，而那条路的语义是丢掉所有结构化 section（别的插件的贡献也一起没了）。
  const options = { sections: {} };
  const result = handlers.get("before_agent_start")({ systemPrompt: base, systemPromptOptions: options });
  assert.equal(result.systemPrompt, undefined, "never forces the whole prompt");
  assert.equal(
    options.sections[mod.WORKFLOW_SECTION],
    mod.WORKFLOW_RULE,
    "delivers the rule as its own named section, like upstream",
  );

  const rule = options.sections[mod.WORKFLOW_SECTION];
  assert.match(rule, /At the start of any new piece of work/, "every new request enters the root router");
  assert.match(rule, /FIRST and follow it/, "the router runs before work or approach selection");
  assert.doesNotMatch(rule, /before classifying, check whether the project has a spec graph/i, "the root router, not an extension precheck, classifies onboarding");
  assert.doesNotMatch(rule, /only when product scope|otherwise proceed directly without loading/, "the #485 narrow-entry language stays removed");

  const router = readFileSync(join(PLUGIN_DIR, "skills/choosing-a-workflow.md"), "utf8");
  assert.match(router, /Does the work create or change anything in the project/);
  assert.match(router, /At the first user request in a session attached to a project/);
  assert.match(router, /onboarding is automatic and takes priority over the\s+first request, whatever the request asks/);
  assert.match(router, /ignore task-specs under `\.thinkrail\/context\/`/);
  assert.match(router, /return to the original request/);
  assert.match(rule, /At the first request in a project session, if source code exists but no durable spec graph exists/);
  assert.match(rule, /before handling that request.*whatever it asks.*then return to it/);
  assert.match(router, /\*\*Existing source code, no durable spec graph:\*\* onboarding is automatic/);
  assert.match(router, /A durable spec graph exists:\*\* do not run onboarding automatically/);
  assert.match(router, /Do not first answer a question, research another topic, or/);
  const setup = readFileSync(join(PLUGIN_DIR, "skills/setting-up-a-project.md"), "utf8");
  assert.match(setup, /\*\*No durable specs · real source code\*\*.*`importing-a-codebase`/);
  assert.match(setup, /return to that original request in the same session/);
  const importer = readFileSync(join(PLUGIN_DIR, "skills/importing-a-codebase.md"), "utf8");
  assert.match(importer, /automatic first-session prerequisite, return to the queued original request/);
  const specGraph = readFileSync(join(PLUGIN_DIR, "skills/spec-graph.md"), "utf8");
  assert.match(specGraph, /Reach for the spec tools first/);
  assert.doesNotMatch(specGraph, /Keep lookup proportional/);

  // section 名的约束来自宿主（`/^[a-z][a-z0-9_-]*$/`，且不可为 `preamble`）；违规会在拼装提示时抛错，
  // 所以这个名字不能随手改。真机那一侧还有一条对着宿主自己那条正则的检查。
  assert.match(mod.WORKFLOW_SECTION, /^[a-z][a-z0-9_-]*$/, "the host rejects every other section name");
  assert.notEqual(mod.WORKFLOW_SECTION, "preamble", "the host reserves this one");

  // 规则点名的技能 id 必须真的被声明——重命名技能文件会让规则静默指向不存在的 id。
  const ids = [...rule.matchAll(/`(pi\.[a-z0-9-]+\/[a-z0-9-]+)`/g)].map((m) => m[1]);
  assert.ok(ids.length >= 1, "the rule names a skill");
  const declaredIds = new Set(
    manifest.contributes.skills.map((rel) => `${manifest.id}/${basename(rel, ".md")}`),
  );
  for (const id of ids) assert.ok(declaredIds.has(id), `rule points at an undeclared skill: ${id}`);

  // 没有 section 表的宿主（老版本，或事件形状换了）：什么都不贡献、也不抛错——宁可规则缺席，
  // 也不退回"强制整条提示"那条路。
  assert.deepEqual(handlers.get("before_agent_start")({}), {}, "no event: contribute nothing");
  assert.deepEqual(
    handlers.get("before_agent_start")({ systemPrompt: base }),
    {},
    "a host without a section map gets nothing, not a forced prompt",
  );
});

test("the panel page and the panel script agree on ids, channels and safety", () => {
  const html = readFileSync(join(PLUGIN_DIR, "renderer/index.html"), "utf8");
  const script = readFileSync(join(PLUGIN_DIR, "renderer/panel.js"), "utf8");
  const panelApi = readFileSync(join(PLUGIN_DIR, "lib/panel.js"), "utf8");

  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  for (const match of script.matchAll(/getElementById\("([^"]+)"\)/g)) {
    assert.ok(ids.has(match[1]), `panel.js reaches for #${match[1]}, which index.html does not define`);
  }

  // 面板发的 channel 必须有人认领——多一个就是死代码，少一个就是空面板。
  // `hint` 由 main.js 回答（它只跟命令的意向有关），其余四个在 lib/panel.js。
  const mainSource = readFileSync(join(PLUGIN_DIR, "main.js"), "utf8");
  const sent = new Set([...script.matchAll(/invoke\("([a-z]+)"/g)].map((match) => match[1]));
  const served = new Set([
    ...[...panelApi.matchAll(/case "([a-z]+)":/g)].map((match) => match[1]),
    ...[...mainSource.matchAll(/channel === "([a-z]+)"/g)].map((match) => match[1]),
  ]);
  assert.deepEqual([...sent].sort(), ["grep", "hint", "spec", "state"]);
  for (const channel of sent) assert.ok(served.has(channel), `no handler for channel ${channel}`);
  assert.match(mainSource, /channel === "hint"/);
  assert.ok(!panelApi.includes('case "hint"'), "hint belongs to the command layer, not the data layer");

  // 视图没有「被点亮」的 API，只能轮询意向；但轮询必须是便宜的——state 会走 fs 与 git。
  const poll = /setInterval\(function \(\) \{([\s\S]*?)\}\, HINT_POLL_MS\)/.exec(script);
  assert.ok(poll, "the view polls the hint channel");
  assert.match(poll[1], /syncHint\(\)/);
  assert.ok(!/reload\(/.test(poll[1]), "the poll must not reload state on every tick");

  // 宿主给的是一份带 CSP 的隔离页面：不写 HTML 字符串、不外联任何东西。
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script));
  assert.match(html, /<meta name="pi-plugin-chrome" content="v3" \/>/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.ok(!/<script[^>]+src="https?:/.test(html));

  // 外观适配器是上游 plugins/shared/appearance 的照抄件，改它会和宿主主题脱节。
  for (const name of ["appearance-boot.js", "appearance.js"]) {
    const ours = readFileSync(join(PLUGIN_DIR, "renderer", name), "utf8");
    const upstream = readFileSync(join(here, `../reference/appearance/${name}`), "utf8");
    assert.equal(ours, upstream, `${name} drifted from the canonical appearance adapter`);
  }
});

test("no .md file is capped away when the host glob hits its 500-match limit", async () => {
  const ctx = setup();
  try {
    // 宿主的 glob 单次最多 500 条且不报截断，而且**给它加目录前缀并不会让它少走树**
    // （宿主始终从根递归，pattern 只用来过滤）。所以超过 500 个 .md 时改成并发逐目录遍历。
    for (let i = 0; i < 600; i += 1) {
      const dir = join(ctx.projectDir, `pkg-${i % 8}`, `sub-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SPEC.md"), `---\nid: spec-${i}\ntype: module-design\ntitle: S${i}\n---\n`);
    }
    await main.onLoad();
    const state = await panelState();
    assert.equal(state.specs.count, 600);
    assert.equal(state.specs.truncated, false);

    const globs = ctx.host.calls.filter(([api]) => api === "fs.glob").length;
    assert.equal(globs, 1, `one glob, never re-globbed per directory (saw ${globs})`);
    assert.ok(
      ctx.host.calls.filter(([api]) => api === "fs.list").length > 1,
      "the fallback walk lists directories",
    );
  } finally {
    ctx.cleanup();
  }
});

test("a small project costs one glob plus one listing per directory", async () => {
  const ctx = setup();
  try {
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(ctx.projectDir, `s${i}.md`), `---\nid: s${i}\ntype: task-spec\ntitle: S${i}\n---\n`);
    }
    await main.onLoad();
    const state = await panelState();
    assert.equal(state.specs.count, 5);
    assert.equal(ctx.host.calls.filter(([api]) => api === "fs.glob").length, 1, "glob under the cap");
    // 唯一的一次 list 是取元数据（根目录一个），不是分片。
    assert.deepEqual(
      ctx.host.calls.filter(([api]) => api === "fs.list").map(([, rel]) => rel),
      [""],
    );
    assert.equal(ctx.host.calls.filter(([api]) => api === "fs.stat").length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("a single directory holding 500+ specs is still indexed completely", async () => {
  const ctx = setup();
  try {
    for (let i = 0; i < 600; i += 1) {
      writeFileSync(join(ctx.projectDir, `s${i}.md`), `---\nid: s${i}\ntype: task-spec\ntitle: S${i}\n---\n`);
    }
    await main.onLoad();
    const state = await panelState();
    assert.equal(state.specs.count, 600);
    assert.equal(state.specs.truncated, false);
  } finally {
    ctx.cleanup();
  }
});

test("deeply nested specs are found (glob does the walking, not this plugin)", async () => {
  const ctx = setup();
  try {
    let deep = ctx.projectDir;
    for (let i = 0; i < 40; i += 1) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "SPEC.md"), "---\nid: deep\ntype: module-design\ntitle: Deep\n---\n");
    await main.onLoad();
    const state = await panelState();
    assert.equal(state.specs.count, 1);
    assert.equal(state.specs.nodes[0].id, "deep");
  } finally {
    ctx.cleanup();
  }
});

// ── 索引层与上游的逐条对齐 ─────────────────────────────────────────────────
//
// store.js 是照着上游 store.ts 的语义逐条移植的：下面几条钉住「哪些判断必须与上游一致」——
// 忽略目录的判据（逐字节，且两条枚举路径一致）、遍历顺序（目录与文件同列、逐层下降）、
// 以及路径解析遇到一个普通文件时的行为。

/**
 * 直连索引：拿假宿主的 fs 网关造一个 `SpecIndex`，于是枚举的**顺序**与结果都能原样断言
 * （面板的 state 会把节点按 id 重新排过，看不出遍历顺序）。
 */
function indexOf(ctx) {
  const { SpecIndex } = pluginRequire(join(PLUGIN_DIR, "lib/spec/index.js"));
  return new SpecIndex(ctx.projectDir, {
    glob: async (pattern) => ctx.host.pi.fs.glob(pattern),
    list: async (rel) => ctx.host.pi.fs.list(rel),
    stat: async (rel) => ctx.host.pi.fs.stat(rel),
    readText: async (rel) => ctx.host.pi.fs.readText(rel),
  });
}

test("the glob path drops the ignored directories and keeps the rest", async () => {
  const ctx = setup();
  try {
    // 小仓库走「一次 glob + 按目录取元数据」：宿主 glob 不认忽略目录（它只跳 .git / node_modules /
    // .venv / __pycache__），所以忽略判断必须由本模块按段补上，且与上游遍历一样**逐字节**——
    // `dist` 丢掉，`Build`（真名不是 `build`）留下。
    mkdirSync(join(ctx.projectDir, "docs"), { recursive: true });
    mkdirSync(join(ctx.projectDir, "dist"), { recursive: true });
    mkdirSync(join(ctx.projectDir, "Build"), { recursive: true });
    writeFileSync(join(ctx.projectDir, "docs/a.md"), "---\nid: a\ntype: task-spec\ntitle: A\n---\n");
    writeFileSync(join(ctx.projectDir, "dist/SPEC.md"), "---\nid: dist\ntype: module-design\ntitle: Dist\n---\n");
    writeFileSync(join(ctx.projectDir, "Build/SPEC.md"), "---\nid: build\ntype: module-design\ntitle: Build\n---\n");

    const index = indexOf(ctx);
    assert.deepEqual(
      (await index.scan()).map((spec) => spec.rel),
      ["Build/SPEC.md", "docs/a.md"],
    );
    // 走的是 glob 那条路：一次 glob，而不是逐目录 list 遍历。
    assert.equal(ctx.host.calls.filter(([api]) => api === "fs.glob").length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("a directory whose real name is not ignored byte-for-byte survives the list walk", async () => {
  const ctx = setup();
  try {
    // 超过 500 条匹配 → 走并发逐目录 list 那条路。上游的判据是 `IGNORED_DIRS.has(dirent.name)`
    // 的**逐字节**命中，所以 `Build/` 不是一个被忽略的目录（折叠判断会把它静默丢掉）。
    for (let i = 0; i < 600; i += 1) {
      writeFileSync(join(ctx.projectDir, `s${i}.md`), `---\nid: s${i}\ntype: task-spec\ntitle: S${i}\n---\n`);
    }
    mkdirSync(join(ctx.projectDir, "Build"), { recursive: true });
    writeFileSync(join(ctx.projectDir, "Build/SPEC.md"), "---\nid: build\ntype: module-design\ntitle: Build\n---\n");
    // 同一个夹具里放一个真名命中的：两条枚举路径都不该收它。
    mkdirSync(join(ctx.projectDir, "dist"), { recursive: true });
    writeFileSync(join(ctx.projectDir, "dist/SPEC.md"), "---\nid: dist\ntype: module-design\ntitle: Dist\n---\n");

    const index = indexOf(ctx);
    assert.equal((await index.scan()).length, 601);
    assert.equal(await index.pathForId("build"), "Build/SPEC.md");
    assert.equal(await index.pathForId("dist"), undefined);
  } finally {
    ctx.cleanup();
  }
});

test("the index is ordered the way the upstream walk yields paths", async () => {
  const ctx = setup();
  try {
    // 上游每层按 (NFC key, 原始名) 排、目录与文件同列、逐层下降：同一层里目录 `a` 的名字小于
    // 文件 `a.md`（`a` 是 `a.md` 的前缀），所以 `a/x.md` 先被产出。按整串比较会把这个顺序反过来。
    writeFileSync(join(ctx.projectDir, "a.md"), "---\nid: a\ntype: task-spec\ntitle: A\n---\n");
    mkdirSync(join(ctx.projectDir, "a"), { recursive: true });
    writeFileSync(join(ctx.projectDir, "a/x.md"), "---\nid: ax\ntype: module-design\ntitle: AX\n---\n");

    const index = indexOf(ctx);
    assert.deepEqual(
      (await index.scan()).map((spec) => spec.rel),
      ["a/x.md", "a.md"],
    );
  } finally {
    ctx.cleanup();
  }
});

test("a duplicated id is won by the spec the walk order reaches first", async () => {
  const ctx = setup();
  try {
    // 工具与图都取「该顺序里第一个」，所以定序是行为、不只是显示顺序。
    writeFileSync(join(ctx.projectDir, "a.md"), "---\nid: dup\ntype: task-spec\ntitle: Root one\n---\n");
    mkdirSync(join(ctx.projectDir, "a"), { recursive: true });
    writeFileSync(join(ctx.projectDir, "a/x.md"), "---\nid: dup\ntype: module-design\ntitle: Nested one\n---\n");

    const index = indexOf(ctx);
    assert.equal(await index.pathForId("dup"), "a/x.md");
  } finally {
    ctx.cleanup();
  }
});

test("a path that passes through a plain file is refused, not resolved", async () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.projectDir, "README.md"), "---\nid: readme\ntype: task-spec\ntitle: Readme\n---\n");
    await main.onLoad();

    const result = await call(ctx.host.tools.get("spec_create"), {
      path: "README.md/child.md",
      id: "child",
      type: "module-design",
      title: "Child",
    });
    // 上游只要上一段存在过就去 readdir 那一层；那里是个普通文件，readdir 失败（ENOTDIR）→ 报错。
    assert.equal(typeof result, "object", "spec_create must fail rather than write under a file");
    assert.match(result.error, /^Path passes through a directory the index cannot list/);
    assert.equal(existsSync(join(ctx.projectDir, "README.md/child.md")), false);
  } finally {
    ctx.cleanup();
  }
});

test("a root the host cannot list is named as a root problem, not as a bad path", async () => {
  const ctx = setup();
  try {
    await main.onLoad();
    // 无会话的调用跟随窗口里可见的项目；这里没有可见项目，宿主读不到根。
    ctx.host.setWorkspace(null);
    const result = await ctx.host.tools.get("spec_create").execute(
      { path: "a.md", id: "a", type: "task-spec", title: "A" },
      {},
    );
    // 上游会报 `Project root does not exist: ${root}`，但本移植拿不到根路径，只能把宿主自己的
    // 错误带出来——关键是它必须与「某个目录读不动」区分开。
    assert.match(result.error, /^Project root is not readable: No workspace is open$/);
    assert.doesNotMatch(result.error, /cannot list/);
  } finally {
    ctx.cleanup();
  }
});

test("spec_create accepts case-variant directories but rejects exact ignored names", async () => {
  const ctx = setup();
  try {
    await main.onLoad();

    const created = await call(ctx.host.tools.get("spec_create"), {
      path: "Build/SPEC.md",
      id: "build-case-variant",
      type: "module-design",
      title: "Case-variant directory",
    });
    assert.equal(created.content, "Created Build/SPEC.md (id: build-case-variant).");
    assert.ok(existsSync(join(ctx.projectDir, "Build/SPEC.md")), "Build/ remains writable");

    rmSync(join(ctx.projectDir, "Build"), { recursive: true, force: true });
    for (const [index, directory] of ["build", ".git", "node_modules", "dist"].entries()) {
      mkdirSync(join(ctx.projectDir, directory), { recursive: true });
      const rel = `${directory}/blocked-${index}.md`;
      const result = await call(ctx.host.tools.get("spec_create"), {
        path: rel,
        id: `blocked-${index}`,
        type: "module-design",
        title: "Must be rejected",
      });
      assert.equal(typeof result, "object", `${directory}/ must be rejected`);
      assert.match(result.error, /Path is inside an ignored directory/);
      assert.equal(existsSync(join(ctx.projectDir, rel)), false, `${directory}/ must not be written`);
    }
  } finally {
    ctx.cleanup();
  }
});

// ── 面板读路径的性能契约 ───────────────────────────────────────────────────
//
// 宿主的每个 fs API 调用都是一次进程间往返，而且宿主会为它写一条审计日志。所以「一次面板读
// 要发多少次 fs 调用」不是实现细节，是契约：这几条测试就是盯着它的。

test("metadata comes from one listing per directory, not one stat per file", async () => {
  const ctx = setup();
  try {
    for (let i = 0; i < 40; i += 1) {
      const dir = join(ctx.projectDir, `pkg-${i % 4}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `s${i}.md`), `---\nid: s${i}\ntype: task-spec\ntitle: S${i}\n---\n`);
    }
    await main.onLoad();
    const state = await panelState();
    assert.equal(state.specs.count, 40);

    const stats = ctx.host.calls.filter(([api]) => api === "fs.stat").length;
    const lists = ctx.host.calls.filter(([api]) => api === "fs.list").length;
    assert.equal(lists, 4, "one listing per directory holding candidates");
    assert.equal(stats, 0, "no per-file stat: the listing already carried size + mtimeMs");
  } finally {
    ctx.cleanup();
  }
});

test("opening a spec reads that one file and does not re-walk the tree", async () => {
  const ctx = setup();
  try {
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(ctx.projectDir, `s${i}.md`), `---\nid: s${i}\ntype: task-spec\ntitle: S${i}\n---\nbody ${i}\n`);
    }
    await main.onLoad();
    await panelState();
    const baseline = ctx.host.calls.length;

    for (const [id, body] of [["s0", "body 0"], ["s7", "body 7"], ["s19", "body 19"]]) {
      const detail = await main.onPanelInvoke("spec", { file: `${id}.md` });
      assert.equal(detail.ok, true);
      assert.equal(detail.body, `${body}\n`);
    }

    // 每次调用先问一次宿主「现在哪个项目」，那是本插件解析作用目录的代价（一次 IPC），
    // 与仓库大小无关，所以从序列里滤掉。关键是剩下的里面**没有 fs.glob、没有 fs.stat**——
    // 那才是全树枚举的痕迹。
    const after = ctx.host.calls.slice(baseline).filter(([api]) => api !== "workspace.get");
    // 每次点击的代价与仓库大小无关：校验路径逐段 list（根目录一个）+ 读这一个文件。
    assert.deepEqual(
      after.map(([api]) => api),
      ["fs.list", "fs.readText", "fs.list", "fs.readText", "fs.list", "fs.readText"],
      "each click = one path check + one file read; never a tree walk",
    );
  } finally {
    ctx.cleanup();
  }
});

test("fresh bypasses the panel memo, and the memo expires on its own", async () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.projectDir, "a.md"), "---\nid: a\ntype: task-spec\ntitle: A\n---\n");
    await main.onLoad();
    await main.onPanelInvoke("state", {});

    // 窗口过期后点开 spec 依然是常数代价（这条正是「点开还是卡」的回归测试）：
    // 详情页不依赖索引，所以树扫得早扫得晚都不影响点击。
    const { SpecIndex: Index2 } = pluginRequire(join(PLUGIN_DIR, "lib/spec/index.js"));
    void Index2;

    // 外部改动（agent 用通用 write 工具写文件）在窗口内可能还看不到……
    writeFileSync(join(ctx.projectDir, "b.md"), "---\nid: b\ntype: task-spec\ntitle: B\n---\n");
    const memoized = await main.onPanelInvoke("state", {});
    assert.ok(memoized.specs.count <= 2);

    // ……但「刷新」永远给真值。
    const fresh = await main.onPanelInvoke("state", { fresh: true });
    assert.equal(fresh.specs.count, 2);

    // 窗口过去后，普通读也会重新走树。
    const { SpecIndex } = pluginRequire(join(PLUGIN_DIR, "lib/spec/index.js"));
    const index = new SpecIndex(ctx.projectDir, {
      glob: async (pattern) => ctx.host.pi.fs.glob(pattern),
      list: async (rel) => ctx.host.pi.fs.list(rel),
      stat: async (rel) => ctx.host.pi.fs.stat(rel),
      readText: async (rel) => ctx.host.pi.fs.readText(rel),
    });
    assert.equal((await index.scan({ maxAgeMs: 100000 })).length, 2);
    writeFileSync(join(ctx.projectDir, "c.md"), "---\nid: c\ntype: task-spec\ntitle: C\n---\n");
    assert.equal((await index.scan({ maxAgeMs: 100000 })).length, 2, "still inside the window");
    assert.equal((await index.scan({ maxAgeMs: 0 })).length, 3, "maxAgeMs 0 = always fresh");
  } finally {
    ctx.cleanup();
  }
});

test("the tools never take the panel memo: two reads are two walks", async () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.projectDir, "a.md"), "---\nid: a\ntype: task-spec\ntitle: A\n---\n");
    await main.onLoad();
    const tool = ctx.host.tools.get("spec_grep");

    await call(tool, { pattern: "A" });
    const first = ctx.host.calls.filter(([api]) => api === "fs.glob").length;
    await call(tool, { pattern: "A" });
    const second = ctx.host.calls.filter(([api]) => api === "fs.glob").length;
    assert.equal(first, 1);
    assert.equal(second, 2, "the agent's reads are never served from the panel's 3-second memo");

    // agent 用通用 write 工具改完文件，下一次工具读必须看到新内容。
    writeFileSync(join(ctx.projectDir, "a.md"), "---\nid: a\ntype: task-spec\ntitle: A\n---\nfresh body\n");
    const after = await call(tool, { pattern: "fresh body" });
    // frontmatter 4 行 + 空行 = 正文从第 6 行开始
    assert.match(after.content, /a\.md:6: fresh body/);
  } finally {
    ctx.cleanup();
  }
});

test("a spec click costs the same no matter how long ago the tree was scanned", async () => {
  const ctx = setup();
  try {
    for (let i = 0; i < 30; i += 1) {
      const dir = join(ctx.projectDir, `pkg-${i % 3}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `s${i}.md`), `---\nid: s${i}\ntype: module-design\ntitle: S${i}\n---\nbody ${i}\n`);
    }
    await main.onLoad();

    // 冷启动：一次 state（真扫），之后隔了任意久再点开 spec，代价必须一样。
    const cold = await main.onPanelInvoke("state", { fresh: true });
    assert.equal(cold.specs.count, 30);

    const clickOnce = async (file) => {
      const before = ctx.host.calls.length;
      const detail = await main.onPanelInvoke("spec", { file });
      assert.equal(detail.ok, true);
      const calls = ctx.host.calls.slice(before).map(([api]) => api);
      assert.ok(!calls.includes("fs.glob"), `a click must not walk the tree: ${calls.join(",")}`);
      assert.ok(!calls.includes("fs.stat"), `a click must not stat the tree: ${calls.join(",")}`);
      return calls.length;
    };

    // 立刻点一次（记忆窗口内），再让窗口过期后点一次：两者调用数必须完全相同。
    const inside = await clickOnce("pkg-0/s0.md");
    await new Promise((resolve) => setTimeout(resolve, 3200)); // 越过面板记忆的 3 秒窗口
    const after = await clickOnce("pkg-1/s1.md");
    assert.equal(after, inside, "the click cost is independent of when the tree was last scanned");

    // 窗口内点开另一个，仍然是同一代价。
    assert.equal(await clickOnce("pkg-2/s2.md"), inside);
  } finally {
    ctx.cleanup();
  }
});

test("state ships the forward links the detail pane needs to invert", async () => {
  const ctx = setup();
  try {
    writeFileSync(
      join(ctx.projectDir, "child.md"),
      "---\nid: child\ntype: module-design\ntitle: Child\nparent: parent\ndependencies: []\ndepends-on: [other]\n---\n",
    );
    writeFileSync(join(ctx.projectDir, "parent.md"), "---\nid: parent\ntype: goal-and-requirements\ntitle: Parent\n---\n");
    writeFileSync(join(ctx.projectDir, "other.md"), "---\nid: other\ntype: task-spec\ntitle: Other\n---\n");
    await main.onLoad();

    const state = await panelState();
    const child = state.specs.nodes.find((node) => node.id === "child");
    assert.deepEqual(child.links, [
      { kind: "parent", target: "parent" },
      { kind: "depends-on", target: "other" },
    ]);
    // 反向边由面板自己反推，所以 state 只需要正向链接。
    const parent = state.specs.nodes.find((node) => node.id === "parent");
    assert.deepEqual(parent.links, []);
  } finally {
    ctx.cleanup();
  }
});
