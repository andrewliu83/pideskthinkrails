# ThinkRail

A spec-graph workbench for PI-Desktop, ported from
[JetBrains ThinkRail](https://github.com/JetBrains/thinkrail) via the DeepSeek Harness plugin
`dsh-plugin-thinkrail`.

Specs are the project's ground truth: durable markdown documents whose frontmatter carries `id`
and `type`, organized as a graph. The agent gets tools to read, query and maintain that graph, in
whichever project the calling session is in -- so they also work while the window shows a temporary
chat. You get a view docked in the right work panel with a specs browser.

## Where to find it

Press `Mod+J` to open the work panel and pick **ThinkRail**, or run `ThinkRail: Open` /
`ThinkRail: Open Specs` from the command palette (`Mod+K`) -- the command points at the work panel
and asks the view to switch to that page.

## What it contributes

- **7 agent tools** -- `spec_grep`, `spec_get`, `spec_graph`, `spec_create`, `spec_update`,
  `spec_delete`, `spec_validate`. Exposed to the model as `plugin_pi_thinkrail_<name>`.
- **10 skills** — `spec-graph` plus the eight workflow skills (`choosing-a-workflow`,
  `setting-up-a-project`, `starting-a-new-project`, `importing-a-codebase`, `brainstorming`,
  `writing-specs`, `asking-user-questions`, `shipping-a-pr`) and `writing-workflow-skills`, the
  authoring checklist and meta-rules for the family itself.
- **One standing rule (an agent-process extension)** — `extensions/workflow-rule.mjs` writes a fixed rule into the host prompt every turn (named section, or appended block on 0.20.x+). Every new request starts at `choosing-a-workflow`; on the first request in an attached project session, existing source code without a durable spec graph triggers setup/import before the request, then the request resumes. Durable specs already present and chats without a project skip automatic setup. This is the only code here outside the fs gateway — see [The standing rule](#the-standing-rule).
- **Version 1.5.1** — the standing rule now reaches the model on PI-Desktop 0.20.x too (dual-channel delivery); carries 1.5.0's automatic first-session onboarding and original-request resumption. See [CHANGELOG.md](CHANGELOG.md) for details.
- **A docked view** -- the list sits on top and the detail (spec body) below it. Specs: graph tree,
  filter, full-text search, spec reader with its links and back-links. It is this plugin's only page.
- **Two commands** -- `ThinkRail: Open`, `ThinkRail: Open Specs`.

## Permissions

| Permission | Why |
|---|---|
| `ui.view` | the ThinkRail tab in the right work panel |
| `agent.tool.register` | the 7 tools |
| `agent.prompt.inject` | the 10 skills |
| `agent.extension` | one module, `extensions/workflow-rule.mjs` — the standing rule. It runs inside the agent process with the agent's tool permissions, so it is **not** covered by the fs gateway below. 93 lines total, no imports, no fs, no network. |
| `fs.read` | index specs anywhere in the project (`scope: ["**/*"]`) |
| `fs.write` | write specs and the `.thinkrail/` scratch dir (`scope: ["**/*.md", ".thinkrail/**"]`) |
| `fs.delete` | `spec_delete`, to the system trash, only files this plugin wrote (`own: true`) |

No network access, no credential reads, and no process at all: nothing in this plugin spawns a child
process. The one exception to the sandbox is the declaration above; the module itself touches nothing.

## The scratch directory

`.thinkrail/context/` is where the workflow skills keep their throwaway documents (`brainstorming`
writes a task-spec there, `shipping-a-pr` writes its PR body and screenshots there). `spec_create`
seeds a `.gitignore` holding `*` next to them the first time it writes a spec inside `.thinkrail/`,
so those drafts leave no git trace.

## Where the skills live (and why Settings → Skills looks empty)

PI-Desktop keeps three separate skill catalogs, and this plugin only feeds the second one:

| Catalog | Source | Shown in Settings → 技能? | Who gets it |
|---|---|---|---|
| **User skills** | `~/.agents/skills/`, `<project>/.agents/skills/` | **yes** — that page is a workbench for exactly these | you, and the agent |
| **Plugin skills** | `contributes.skills` in a plugin manifest (these 10) | **no** | the agent, as a catalog |
| Built-in skill | shipped with the app (plugin authoring only) | no | the agent |

The host accepts plugin skills at load (`plugin.skills.register`, count `10`), gives each one the id
`pi.thinkrail/<filename>`, and sends **id + name + description** to the agent with every prompt
(`resolveAgentRuntimeLaunch` → `pluginSkills`). The document body is fetched on demand when the
model calls the `Skill` tool with that id — so `pi.thinkrail/spec-graph`,
`pi.thinkrail/brainstorming`, … are the ids to ask for in a PI-Desktop session.

So a ThinkRail skill never appears in Settings → 技能, and that is not a loading failure — the app
has no UI that lists plugin-contributed skills by name at all.

### What the agent actually sees

`agent.prompt.inject` is not a passive catalog: the sidecar renders the entries into a `# Skills`
instruction block and puts it in the **base system prompt** of every session, ahead of the user's
own instruction chain. Its own comment in `agent-runtime/sidecar.js`:

```js
// Plugin skills (D174): the catalog rides in the base prompt so a
// path-scoped instruction reload never drops it, and it stays ahead of
// the instruction chain so the user's own AGENTS.md keeps the last word.
```

Each entry is `- \`id\` — name: description`, under this instruction:

> Plugins have taught you the following skills. Each entry is a set of instructions you can load
> with the `Skill` tool by passing its exact id. When a task matches a skill's description, load the
> skill first and follow it; do not guess at its content.

So the **descriptions are always-on instructions** (which is why they were rewritten to carry their
trigger conditions), and the **body is fetched on demand** when the model calls `Skill`.

On top of that catalog this plugin restores the DeepSeek Harness version's standing rule, through the
host's named prompt-section extension point — see [The standing rule](#the-standing-rule)
below. So the comparison is: the **root router** is pushed unconditionally (as upstream's always-on
rule did), and every **leaf skill** still needs either a route to it or a description that matches —
which is where upstream's own rule also landed (its rule named only the router).

The block is built when the session runtime is constructed, but **no new session is needed**: the
sidecar's `canReuse(config)` includes the skill digest in its reuse check, with the note that a
changed catalog "retires the runtime and its stale prompt" — so the next message in any session
already gets the current catalog. (The official `pi.workspace-file-guard` README tells users to open
a new session; that is the conservative phrasing, not what the code requires.)

To use one, just ask: *"load the `pi.thinkrail/setting-up-a-project` skill and follow it"*, or
describe the task and let the description match. There is no UI that lists them — `skill/list` is
specced as "List **user-owned** Skills", and the composer's `/` menu has only prompt-template, app
and **plugin command** groups.

### Adding project rules on top

If you also want project-specific rules (for instance "this repo's specs live under `crates/*/SPEC.md`"),
put them in the project's `AGENTS.md` — it is read as a layered instruction chain after the skills
block. `AGENTS.md`, `CLAUDE.md`, `AGENTS.override.md`, `.claude/CLAUDE.md` are all read, plus the
global `~/.pi/agent/AGENTS.md`, with a 32 KiB budget across the chain:

```markdown
## Spec graph first

This project records its architecture, decisions and contracts as spec documents (markdown whose
frontmatter carries `id` and `type`). Before exploring the code, planning, or implementing anything:

1. Load the `pi.thinkrail/spec-graph` skill and follow it.
2. Use `spec_grep` / `spec_get` / `spec_graph` before `grep` / `read` to find the relevant specs.
3. When work is creative or changes behavior, load `pi.thinkrail/brainstorming` first and record the
   validated design as a task-spec.
4. When you change a boundary, contract or decision, update the spec in the same change
   (`spec_update` for frontmatter, the normal edit tools for prose).
```

A test (`tests/manifest-host-check.test.mjs`) renders this block with the sidecar's own
`pluginSkillsPrompt`, so a skill that loses its id, its description, or slips past 240 characters
fails the suite instead of silently degrading the prompt.

## The standing rule

Everything else in this plugin is sandboxed: file access goes through the host's fs gateway, and no
code of ours runs anywhere but in the plugin process. The skill catalog above does not force anything
either — its framing sentence is conditional ("When a task matches a skill's description…"), so in
practice the agent decides whether to route at all. Measured on one machine, eight sessions after
install: only the two sessions that literally asked for specs ever loaded a skill.

So this plugin also ships **one agent-process extension**, `extensions/workflow-rule.mjs`:

```js
export default function workflowRule(pi) {
  pi.on("before_agent_start", (event) => {
    const sections = event?.systemPromptOptions?.sections;
    if (!sections || typeof sections !== "object") return {};
    sections[WORKFLOW_SECTION] = WORKFLOW_RULE;
    return {};
  });
}
```

`before_agent_start` is a trusted, result-returning hook in the host's sidecar, and writing into a
**named prompt section** is how upstream ThinkRail installs its two always-on rules — returning
nothing ("so pi patches that one section instead of forcing a whole prompt"). This plugin used only
that mechanism until 1.5.1; PI-Desktop 0.20.x replaced the runner, so the rule now travels over
**whichever channel the running host actually reads**:

1. **Section channel** (PI-Desktop 0.15.x–0.19.x, and upstream pi): write into `sections`, which works
   because that runner hands extensions a mutable copy of the prompt options and adopts it afterwards.
   Section names must match the host's own pattern (`/^[a-z][a-z0-9_-]*$/`, never `preamble`; a bad
   name throws while the prompt is composed, so `tests/manifest-host-check.test.mjs` checks ours
   against the host's live regex).
2. **Append channel** (PI-Desktop 0.20.x and newer): that runner hard-codes `systemPromptOptions` to an
   empty object and its merger only reads a returned `systemPrompt` string, so writing `sections` there
   is a silent no-op — which is exactly why the router stopped firing. The module therefore appends the
   same rule, wrapped in `<pi-thinkrail-workflow>` tags, to the end of the prompt and returns the
   combined string. The host prompt is preserved rather than replaced, and the append is idempotent (a
   prompt already holding the block is left untouched). Extensions compose serially, so this does not
   clobber another plugin's contribution.

The composed prompt renders each section as `<pi-thinkrail-workflow>…</pi-thinkrail-workflow>` and
**ends** with it, still the strongest instruction position the app offers, after your `AGENTS.md`.
PI-Desktop 0.15.6 is the supported minimum. With no section map and no prompt to append to, the module
contributes nothing at all, so the rule goes absent rather than corrupting the prompt.

What it says (four lines of rule; the module is 93 lines including comments explaining the host contract):

- at the start of **every new piece of work**, read the `choosing-a-workflow` skill first using its PI skill id;
- on the first request in an attached project session, automatically set up existing source code with no durable spec graph before acting, whatever the request asks;
- after setup, resume the queued original request; any project change goes through brainstorming, **however small or fully specified**;
- chats without an attached project do not trigger setup, and continuations stay in their active workflow.

The durable-graph check ignores temporary task-specs under `.thinkrail/context/`. A project that already has
a durable spec graph skips automatic onboarding. The setup worker drafts the graph, then returns to the
first request rather than consuming it.

This development source deliberately adds automatic first-session onboarding for code-only projects to
the restored pre-#485 broad workflow entry. The behavior is a local workflow choice; it does not revert
the later prompt-section delivery or other carrier/API fixes. The root router still classifies onboarding,
PR lifecycle, project changes, and direct-answer requests. Brainstorming must be explicitly approved before
it writes durable SPECs or implementation code.

**The trade-off, plainly:** a module declared under `contributes.agentExtensions` runs inside the
agent process with the agent's own tool permissions. It is not covered by the fs gateway, so the
plugin's permission story is no longer "only markdown, only through the gateway". That is why the
module imports nothing, touches no filesystem and no network, and is kept small enough to read before
you approve it — and why the install permission review shows `agent.extension` with
the host's own warning ("Enable only code you trust"). If you would rather not grant it, the same
effect is available without any new permission by putting the rule in your `AGENTS.md` (one layer
earlier, and per-project) — see above.


## Behaviour notes

The panel follows the app language (en / zh-CN) live and uses the host appearance adapter, so it
tracks light/dark switches while it stays open.

The panel is a reader: it never writes a spec, so there is no optimistic UI to keep honest. A spec an
agent tool changed shows up on the next read -- the panel's own scan window is 3 seconds, and the
refresh button (or a window that becomes visible again) bypasses it. The only polling is a 4-second
token check for "which page did a command ask for", which touches no files and starts no process.

Opening a spec reads that one file (2–4 host calls) and never re-walks the project, so clicking
around stays instant however large the repository is or however long ago the tree was scanned.

## The tools follow the session, the panel follows the window

Every file the `spec_*` tools touch goes through the host's `pi.fs.*` gateway, and the host resolves
those paths against **the project of the session that made the call** (host ADR 0266). The tools
therefore always land in the project the conversation is working in, and this plugin spends no code
guessing: it does not read the app's active project for them, does not remember which project a
conversation first resolved, does not compare the two, does not print a note naming both, and does not
refuse when no project is open. The case that used to be visible is a temporary chat (a session with
no project): the window may show it, and the tools keep working, because the host resolves their calls
against the session's project and not against what is on screen. When a call really fails, the host's
own error comes back as it was written.

The panel is deliberately different: a docked view is window-wide and has no session id, so it follows
the project PI-Desktop has active right now -- that single lookup is all `lib/project.js` holds. With
no active project the panel says so and names the project it last showed, instead of opening an empty
page. The toast a command shows follows the app language too (en / zh-CN).

## Differences from the DSH version

Everything else this port changed is a carrier adaptation, described above. This section is the one
capability that was dropped on purpose, and the table says so per row rather than pretending the
carrier never had it:

| DSH version | this plugin | status |
|---|---|---|
| 6 `worktree_*` agent tools (`worktree_list`, `worktree_create`, `worktree_open`, `worktree_rename`, `worktree_remove`, `worktree_diff`) -- 13 tools in all | 7 `spec_*` tools | removed on purpose |
| the Worktrees page in the view: roster, diff, create / rename / set base / adopt / remove | the Specs page only | removed on purpose |
| the `ThinkRail: Open Worktrees` command | `ThinkRail: Open`, `ThinkRail: Open Specs` | removed on purpose |
| the `Register worktrees as app projects` and `Worktree root directory` settings | no settings | removed on purpose |
| the `project.create` permission, which listed a new worktree in the app's project list | not requested | removed on purpose |
| the system `git` binary, run through `execFile` with argument arrays | no process of its own: every file access goes through the fs gateway | removed on purpose |

The worktree layer was removed on purpose: on this carrier the host resolves every plugin file call against the project of the session that made the call, and the git half runs its own process outside that gateway, so it could not follow the session; the author chose to keep only the workflow.

**Manual cleanup.** This plugin no longer manages git worktrees, and nothing on disk was deleted with
the feature:

- existing git worktrees stay registered in git: list them with `git worktree list` and remove one with
  `git worktree remove <path>`;
- the plugin's old roster file is left at `<dataDir>/workspaces.json`, where `dataDir` is the plugin
  data path (`pi.plugin.getDataPath()`). Nothing reads it any more.
