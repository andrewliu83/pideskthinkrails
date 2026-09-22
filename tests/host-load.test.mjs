// 真机装载测试：把插件交给 PI-Desktop **自己的** plugin-host-process 去装载。
//
// 前面那份测试用的是自造的假宿主，它证明的是插件的行为；这一份证明的是装载链本身——
// 入口是 CJS、`globalThis.pi` 注入得进来、7 个工具与 2 个命令经宿主真实的注册路径被接受、
// onLoad 不抛、panel.invoke / tool.execute 的往返能用。
//
// plugin-host-process.js 是从本机已安装的 PI-Desktop 的 app.asar 里**照字节**取出来的，
// 未做任何改动；机器上没装 PI-Desktop 就跳过。

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(here, "../plugins/pi.thinkrail");
const ASAR = "/Applications/PI-Desktop.app/Contents/Resources/app.asar";
const HOST_ENTRY = "/out/main/plugin-host-process.js";

/** 从 app.asar 里取出一个文件（asar 就是「8 字节头 + JSON 目录 + 原始字节」）。 */
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

const available = existsSync(ASAR);

test("the real PI-Desktop host process loads the plugin and serves its panel", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-thinkrail-host-"));
  const projectDir = join(root, "project");
  const dataDir = join(root, "data");
  mkdirSync(projectDir);
  mkdirSync(dataDir);
  writeFileSync(join(projectDir, "SPEC.md"), "---\nid: root\ntype: goal-and-requirements\ntitle: Root\n---\nbody\n");

  const hostEntry = join(root, "plugin-host-process.mjs");
  writeFileSync(hostEntry, readFromAsar(HOST_ENTRY));

  const child = spawn(process.execPath, [hostEntry], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const logs = [];
  const registered = { tools: new Map(), commands: new Map() };
  const pending = new Map();
  let nextId = 1;

  const write = (message) => child.send(message);
  const call = (api, args) =>
    new Promise((resolve, reject) => {
      const id = `p${nextId++}`;
      pending.set(id, { resolve, reject });
      write({ t: "call", id, api, args });
    });

  child.on("message", (message) => {
    if (message.t === "log") {
      logs.push(`${message.level}: ${message.message}`);
      return;
    }
    if (message.t !== "call") return;
    const { id, api, args } = message;
    const finish = (value) => write({ t: "res", id, ok: true, value: value ?? null });
    const fail = (error) => write({ t: "res", id, ok: false, error: { code: "TEST", message: String(error) } });
    void (async () => {
      switch (api) {
        case "plugin.getId":
          return "pi.thinkrail";
        case "plugin.getSettings":
          return {};
        case "plugin.getDataPath":
          return dataDir;
        case "workspace.get":
          return { path: projectDir, name: "project" };
        case "agent.registerTool":
          if (!args[0]?.name || typeof args[0]?.name !== "string") throw new Error("tool.name is required");
          registered.tools.set(args[0].name, args[0]);
          return { ok: true };
        case "agent.unregisterTool":
          registered.tools.delete(args[0]);
          return { ok: true };
        case "commands.register":
          registered.commands.set(args[0].id, args[0]);
          return { ok: true };
        case "commands.unregister":
          registered.commands.delete(args[0]);
          return { ok: true };
        case "ui.openPanel":
          return { ok: true };
        case "fs.glob": {
          // The host walks the tree itself and caps at 500 matches; this fixture is small enough
          // that the cap never applies (the sharding path is covered by the unit suite).
          const pattern = String(args[0]);
          const suffix = pattern.slice(pattern.lastIndexOf("**"));
          const base = pattern.slice(0, pattern.length - suffix.length).replace(/\/$/, "");
          const root = base ? join(projectDir, base) : projectDir;
          return walk(root, base).filter((rel) => rel.endsWith(".md"));
        }
        case "fs.stat": {
          const info = statSync(join(projectDir, args[0]));
          return { size: info.size, mtimeMs: info.mtimeMs };
        }
        case "fs.readText":
          return readFileSync(join(projectDir, args[0]), "utf8");
        case "fs.writeText":
          mkdirSync(dirname(join(projectDir, args[0])), { recursive: true });
          writeFileSync(join(projectDir, args[0]), args[1], "utf8");
          return { ok: true };
        case "fs.list": {
          const dir = args[0] ? join(projectDir, args[0]) : projectDir;
          return readdirSync(dir, { withFileTypes: true }).map((entry) => {
            const path = args[0] ? `${args[0]}/${entry.name}` : entry.name;
            if (entry.isDirectory()) return { name: entry.name, path, isDirectory: true };
            const info = statSync(join(dir, entry.name));
            return { name: entry.name, path, isDirectory: false, size: info.size, mtimeMs: info.mtimeMs };
          });
        }
        default:
          throw new Error(`unexpected host api: ${api}`);
      }
    })().then(finish, fail);
  });

  child.on("message", (message) => {
    if (message.t !== "res" || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error?.message ?? "host call failed"));
  });

  try {
    // 1. 装载：宿主读 manifest 之外的一切都由插件自己 require。
    const init = await new Promise((resolve, reject) => {
      const id = "init";
      pending.set(id, { resolve, reject });
      write({ t: "init", id, pluginId: "pi.thinkrail", pluginPath: PLUGIN_DIR, main: "main.js" });
    });
    assert.equal(init.pluginId, "pi.thinkrail");
    assert.equal(registered.tools.size, 7, `tools registered: ${[...registered.tools.keys()].join(", ")}`);
    assert.deepEqual([...registered.commands.keys()].sort(), [
      "thinkrail.open",
      "thinkrail.openSpecs",
    ]);
    for (const [name, tool] of registered.tools) {
      assert.equal(typeof tool.description, "string", `${name} needs a description`);
      assert.equal(tool.schema?.type, "object", `${name} needs an object schema`);
    }

    // 2. 面板：走宿主真实的 panel.invoke 转发。
    // 宿主 0.14.x 起要求工具调用带一个唯一的 invocationId（同一个 id 不能并发两次），
    // 所以这里和真实宿主一样把它放在帧的顶层。
    const invoke = (method, payload) =>
      new Promise((resolve, reject) => {
        const id = `c${nextId++}`;
        pending.set(id, { resolve, reject });
        write({
          t: "call",
          id,
          method,
          payload,
          ...(method === "tool.execute" ? { invocationId: `inv-${id}` } : {}),
        });
      });

    const hint = await invoke("panel.invoke", { channel: "hint", payload: {} });
    assert.equal(hint.ok, true);
    assert.equal(hint.token, 0);
    assert.equal(hint.view, "specs");

    // 首次 state 不等全树枚举：先回空快照 + indexing，让视图立刻开出来（stale-while-revalidate）。
    const first = await invoke("panel.invoke", { channel: "state", payload: {} });
    assert.equal(first.ok, true);
    assert.equal(first.project.path, projectDir);

    let state = first;
    for (let i = 0; i < 100 && state.indexing; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = await invoke("panel.invoke", { channel: "state", payload: {} });
    }
    assert.equal(state.indexing, false, "the background index settles");
    assert.equal(state.specs.count, 1);
    assert.equal(state.specs.nodes[0].id, "root");

    // 3. 工具：走宿主真实的 tool.execute 转发，写下来的文件真的在磁盘上。
    const created = await invoke("tool.execute", {
      name: "spec_create",
      args: { path: "docs/SPEC.md", id: "docs", type: "module-design", title: "Docs" },
      sessionId: "s1",
    });
    assert.match(created.content, /Created docs\/SPEC\.md/);
    assert.match(readFileSync(join(projectDir, "docs/SPEC.md"), "utf8"), /id: docs/);

    // 4. 卸载：宿主把注册表清干净。
    await invoke("lifecycle.unload", {});
    assert.equal(registered.tools.size, 0);
    assert.equal(registered.commands.size, 0);
    assert.deepEqual(logs.filter((line) => line.startsWith("error")), []);
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}
