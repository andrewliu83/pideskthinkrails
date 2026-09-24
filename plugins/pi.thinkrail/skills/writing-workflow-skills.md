---
name: writing-workflow-skills
description: "Use when adding a workflow skill to this plugin's family, changing an existing one's role, trigger, handoff or structure, or checking one against the family's rules. Not for general-purpose skills outside this family."
---

> 移植自 JetBrains/ThinkRail 的 `packages/pi-thinkrail-workflow/skills/writing-workflow-skills` 与同目录的
> `skills/SPEC.md`（MIT）。上游把「怎么做」放在技能里、「为什么」放在 SPEC 里；本插件的技能一个只有一个
> 文件（宿主一个技能只读这一篇），所以两层折在这里：先是可执行的清单，后半是元规则、角色与家族现状。
> 上游 SPEC 里仓库特有的部分（e2e 工作流测试台、历史 provenance、`/skill:` 命令种子）没有搬；
> 宿主带来的语义差异见 "What this host changes about the rules"。

# Writing Workflow Skills

The authoring checklist for this plugin's workflow family — the skills in `skills/` that codify how the
agent runs a piece of work. It carries the *what to do*; the *why* — the concept model, the three
roles, the meta-rules cited as "(rule N)" — is folded in below, because this host reads exactly one
file per skill: there is no sibling-doc layer to put it in.

**Workspace guard.** This checklist edits the family that ships with this plugin, at
`plugins/pi.thinkrail/skills/`. If that directory is not the current workspace — the common case,
since an installed plugin's skills are a read-only staged copy under the app's plugin directory — the
family cannot be extended from here: say so in one line and stop. That is this checklist's terminal
state for foreign workspaces.

## Design (before writing)

- [ ] Scope the skill to one externally reachable workflow — or, for a concept, one topic (rule 1). A
      workflow's internal shape — forks, branches, stages, revise loops — stays inside the skill's own
      file; a part is promoted to its own skill only when it needs independent addressability (an
      external caller, a genuine self-trigger, a direct entry point) — never for shape or size alone.
- [ ] Pick the role (rule 2): **router** (classification rules + handoffs, nothing else), **worker**
      (one phase's steps), or **concept** (one topic's reusable rules/mental model — no steps, no
      handoffs).
- [ ] For a concept: confirm a second skill needs it (rule 7) — detail with a single consumer stays a
      section of that one skill, not a concept skill.
- [ ] Pick the ending (rule 6): a router ends by naming what runs next; a worker ends with a fixed
      successor, back to its caller, or a declared terminal state; a concept has no ending at all — it
      writes no ending section, control simply returns to its reader. Know the exact wording before
      writing the body.
- [ ] If the change reshapes the system itself — a new role, a new meta-rule, a changed entry model or
      topology — stop: write it into the meta-rules below first (rule 13), then come back here.

## Write

- [ ] Name the skill verb-first, active voice, kebab-case (rule 15): a gerund for process skills, the
      topic for a concept — name the work or the insight, never the artifact or a role. File name =
      frontmatter `name`.
- [ ] Create `skills/<name>.md` with frontmatter `name` + `description`, nothing else. The host reads
      this one file; there are no sibling files to hand to.
- [ ] `description` = triggering conditions only, "Use when …" (plus a "Not for …" negative trigger
      when the boundary is confusable) — never a summary of the steps (rule 5). Skills are reached by
      routing or handoff; a self-trigger `description` is for unmistakable triggers only (rule 4) — and
      for the skills no router classifies (this one and the concept skills) it is the *only* way in, so
      it carries real routing weight. The host caps it at 240 characters; stay under that.
- [ ] Keep it tight — target ~150 lines. Internal workflow nodes (branches, stages, shared tails) and
      heavy reference material become **sections of this same file**, named in the exact step that
      hands to them (progressive disclosure), as `shipping-a-pr` does with its six phases.
- [ ] Say each thing once (rule 7): cross-reference other skills by name; never inline another skill's
      steps, never force-load its file. On this host a skill is one file read on demand by id, so
      "loading" another skill means calling the Skill tool for it — hand off, don't pull it in.
- [ ] Put gates where discipline matters, matching the form to the failure (rule 11): prohibitions +
      red flags for discipline violations, positive recipes for output shape.
- [ ] Durable output goes to the spec graph (rule 8). Ephemeral working files — resume state, scratch
      plans — are declared by naming their shape (rule 9) and live in the workspace's gitignored
      `.thinkrail/context/`: the home for every temp doc, consumed or deleted when the work lands,
      with anything durable promoted to specs before cleanup.
- [ ] End the body by naming the ending chosen in Design (rule 6) — a concept skips this: no ending
      section.

## Register (rule 12)

- [ ] Add the skill's path to `contributes.skills` in `manifest.json`. The host sees only what is
      declared there; a file that is not declared does not exist for the agent.
- [ ] Add one routing line in the router that owns the new skill: the root router
      (`choosing-a-workflow`) by default, or the nearest sub-router when the skill is a branch under an
      already-routed workflow (fractal routing). Exception (rule 4): a skill outside any router's work
      classification — self-trigger-only skills and concept skills — skips the router line. That is a
      designed property of the skill, never a size call, and it is recorded in the family table below.
- [ ] Add or update the skill's row in the family table below, including its **Routed from** entry.
- [ ] Nothing else should have changed shape — if it did, revisit rule 13 in Design.

## Verify by use (rule 14 — suspended)

- [ ] Rule 14 is a known limitation, not a done-gate (see Known gaps). When practical, still run a real
      request through the new or changed skill and watch it flow: the router (or the description)
      triggers it, the body is followed, the ending fires as designed. For a concept: a referencing
      skill loads it and its rules are applied.
- [ ] Either way, keep the family-table row honest: `unverified by use` until a run has been observed;
      update the row when one has.

## Red flags — stop and fix

- The `description` mentions any step of the workflow.
- The name is noun-first, or names an artifact or a role instead of the work (rule 15).
- The body of a router or worker ends without naming a successor or a terminal state.
- A concept skill contains steps, routing, a handoff, or an ending section.
- The same rules are copied into two skills instead of extracted into a concept (rule 7).
- A step restates another skill's content instead of pointing at it.
- An internal node that nothing outside the skill reaches was made its own skill — internal nodes are
  sections of their parent, not skills (rule 1).
- "Too small to need a router line / family-table row." Every skill registers (rule 12); skipping the
  router line is only for self-trigger-only skills and concept skills (rule 4) — size is never the
  reason.
- Calling a skill *verified* without a real request observed flowing through it — rule 14 is suspended
  as a done-gate, but an unobserved skill is still `unverified by use`, never "verified".

## Done (terminal state)

This checklist ends here — no successor skill. Done means: `skills/<name>.md` exists and passes the
checks above, the path is declared in `manifest.json`, the router line (or its deliberate absence) and
the family-table row are in place — the row marked `unverified by use` until a real request has been
observed flowing through the skill (rule 14, currently suspended as a done-gate).

## What this host changes about the rules

The rules below were written for a host with a standing prompt rule, sibling-doc files, and an
in-repo e2e harness. PI-Desktop gives a plugin none of those, so four of them read differently here —
the intent is unchanged:

- **Discovery (rule 4).** PI-Desktop lets this plugin register an agent extension (`agent.extension` +
  `contributes.agentExtensions`). Its `before_agent_start` hook writes into the host's named
  `systemPromptOptions.sections` slot and returns no `systemPrompt`, preserving the rest of the prompt.
  This plugin's pointer applies to first requests in project sessions: when source code exists without a
  durable spec graph (ignoring `.thinkrail/context/` task-specs), complete onboarding before handling the
  request, then resume it. Existing graphs skip automatic setup; chats without a project do not imply an
  empty project. Every new request still enters the root router, and any project change enters
  `brainstorming`, including small or fully specified changes. Continuing work stays in its active
  workflow. Everything below the router is reached by a routing line, a named handoff, or a narrow
  self-trigger `description`.
- **Shape (rules 1, 3).** One skill = one file. Where upstream moved a workflow's internal nodes into
  sibling docs, here they are sections of the skill's own file — or the skill is split when something
  outside must reach a part directly.
- **Registration (rule 12).** The family table in this file replaces the upstream spec's; the manifest
  entry replaces `package.json`'s `pi.skills` glob.
- **Verification (rule 14).** The upstream harness that drove a real agent through a skill does not
  exist here. This plugin's test suite pins contract-level facts instead — the declared skills exist,
  their frontmatter fits the host's limits, no skill points at a sibling file — which is not the same
  as observing a request flow. Rule 14 therefore stays suspended, and rows carry their debt honestly.

## The concept model

- **Workflow** — a repeatable way of running a piece of work, codified as one or more skills.
- **Workflow skill** — one skill = one *externally reachable* workflow *or one shared concept*; short,
  imperative, workflow-focused.
- **Concept** — one topic's reusable rules, conventions, or mental model: shared ground the process
  skills stand on, codified as its own skill when more than one skill needs it.
- **Handoff** — the explicit, by-name transition at the end of a workflow skill, or a declared
  terminal state.
- **Gate** — a hard discipline point (e.g. "no implementation before the design is approved"), written
  with anti-rationalization notes, not soft advice.
- **Artifacts** — the **spec tree** (the durable record: decisions, contracts, limitations, principles
  — everything the code can't reveal) and **temp docs** (scaffolding for one piece of work: a
  task-spec and/or workflow-declared working files), governed by rules 8–9. The split is *lifecycle*,
  not file type. Temp docs have a designated home: the workspace's gitignored `.thinkrail/context/`
  (seeded by `spec_create`, zero git footprint, still scanned by the spec tools), so they are live for the
  agent yet never reach the committed tree.

## The three roles

Every workflow skill takes exactly one of **three roles**; everything richer is a *pattern* built from
them.

| Role | Body contains | Ends by |
|---|---|---|
| **Router** | classification rules + handoffs only | naming what runs next |
| **Worker** | one workflow's steps — in its body's sections | a handoff — fixed successor, back to its caller, or a terminal state (rule 6) |
| **Concept** | one topic's reusable rules, conventions, or mental model — no steps, no routing | nothing — no ending section at all; control simply returns to its reader |

The **root router** is the single entry for every new piece of work; the always-on rule points every
request there (rule 4). Work already routed resumes its active workflow instead of re-entering the
router. Branch skills may route further (fractal routing). A **concept** is not a process building
block — routers and workers name it at the exact step that needs it, and it is never a route: the router
classifies *work*, and a concept is not work.

- **Composer** — a *stateful router*: agrees a per-task pipeline with the user, records it in the
  task-spec's **Pipeline section** (checkboxes = plan + frontier + history), and walks it, adjusting as
  findings land; the workers it launches hand back to it. Its between-stage checking discipline is its
  own design, not a system rule.
- **Stage** — any worker reached from a pipeline: upstream artifacts in, one artifact out, hands back
  to its caller. The same worker can also run standalone — stage-ness is how a worker is *used*, not
  what it *is*.

No runtime machinery: the system is skills-only (no YAML pipelines, DAG tools, or stage sessions) —
pipeline state is task-spec content; stage transitions are ordinary handoffs.

## Meta-rules

**Structure**

1. One *externally reachable* unit per skill — a workflow is one skill if it is reached only as a
   whole (routed to, called by another skill, or self-triggered); one topic per concept skill. **Skill
   boundaries follow external reachability, not workflow shape**: a workflow's internal shape lives
   inside the skill, with the *choice rules staying in the section before the fork*. A part is promoted
   to its own skill when it needs *independent addressability* — an external caller, a genuine
   self-trigger, or a direct entry point. Never promote for shape or size alone.
2. Routers route; workers work; concepts inform. A router contains classification rules + handoffs
   only — never a branch's steps; asking a question or inspecting the workspace *to classify* is
   routing, not work. A worker embeds no routing of *work* beyond its own ending. A concept skill
   contains no steps and no handoffs; it may state norms about its topic, but *when* they are enforced
   belongs to the process skill that references it.
3. Skills are concise and workflow-focused: target < ~150 lines per skill. Rules needed by a *second
   skill* are extracted into a concept skill — no premature extraction.

**Discovery & entry**

4. Every new piece of work — request, feature, change, fix, question, or idea — first goes through the
   root router before the agent starts work or chooses an approach. The always-on rule points every new
   request there; the router then selects a workflow or says none applies. Continuing work already
   routed stays in its active workflow rather than starting over. Skills are otherwise reached by
   routing/handoff, or — when the trigger is unmistakable — by a narrow self-trigger `description`:
   alongside a route (as `setting-up-a-project` does) or, for skills outside the router's work
   classification (meta/authoring skills), self-trigger alone (as this skill does). Concept skills are
   reached by name from the skill step that needs them and may add a narrow self-trigger; they never
   take a routing line (a concept is not work).
5. `description` = triggering conditions only ("Use when …"), never a summary of the workflow's steps
   — a step-summary tempts the agent to follow the description and skip the body.

**Chaining**

6. Explicit endings: every process skill ends by naming its successor skill or its terminal state —
   including every internal stage of a forking worker, whose terminal state is declared in the section
   where the flow actually ends; a concept skill has nothing to run next and writes no ending section.
   Cross-reference skills by name; never inline another skill's steps.
7. Say each thing once: a rule or step lives in exactly one skill; others point at it. A rule needed by
   more than one skill is extracted into a concept skill and pointed at, never copied.

**Artifacts**

8. The spec tree is the only durable record; how and when durable content reaches it is the workflow's
   call — written straight in as decisions land, promoted incrementally from a task-spec, or promoted
   when the work lands. What never varies: durable content is in the tree before its temp doc is
   cleaned up, and there is no parallel durable plan/state format.
9. Temp docs are optional and belong to their workflow. When used, the task-spec is the default spine —
   design, plan, pipeline state, and review notes live as its sections; extra working files are
   declared by naming their shape. **All temp docs live in the workspace's gitignored
   `.thinkrail/context/`.** The owning workflow also owns cleanup — delete when the work lands, by
   default; a temp doc never becomes the record.

**Scaling**

10. Scale the *depth*, not whether project changes use a workflow: route every new piece of work through
    the root router, and send any work that creates or changes the project to `brainstorming`, however
    small. Keep simple work on short paths; deeper work uses the fuller design flow.
11. Gates where discipline matters, matching the form to the failure: prohibitions + red-flags for
    discipline violations; positive recipes for output shape.

**Maintenance**

12. Adding a workflow = add `skills/<name>.md` + declare it in `manifest.json` + one routing line in
    the router that owns it — the root router by default, or the nearest sub-router when the skill is a
    branch under an already-routed workflow — (self-trigger-only skills and concept skills per rule 4
    skip the router line: a designed exception, never a size call) + one row in the family table in
    this file, including its **Routed from** entry. The *entry* itself is not a skill: it is the
    standing rule in `extensions/workflow-rule.mjs`, whose pointer sends every new piece of work to the
    root router (rule 4) — which is why the root router needs no route of its own. Changing that rule
    is a system-shaping change (rule 13) — and it needs the `agent.extension` permission, so it is the
    one place where this family ships code that runs in the agent process.
13. The rules lead: system-shaping changes update the meta-rules in this file first; the checklist
    above carries only the actionable steps and points here for rationale.
14. Verify by use — **suspended: a known limitation, not currently a done-gate**. The intended rule: a
    new or changed skill isn't done until a real request has been observed flowing through it — for a
    concept, observed being loaded through a reference (or its self-trigger) and applied. Until then:
    unverified skills still ship, their verification debt is recorded in the family table
    (`unverified by use`), and observed runs are noted when they happen.

**Naming**

15. Names are verb-first, active voice, kebab-case: gerunds for process skills (`choosing-a-workflow`,
    `setting-up-a-project`); a concept skill is named for its topic (`asking-user-questions`). Name the
    work the skill runs or the insight it carries — never the artifact it produces or the role that
    runs it. File name = frontmatter `name`.

## Workflow family

| Skill | Role — purpose | Routed from | Status |
|---|---|---|---|
| `choosing-a-workflow` | router (root) — first classification and routing for every new piece of work | — (always-on entry rule, rule 4) | active; unverified by use |
| `setting-up-a-project` | router (sub) — dispatcher: detect the workspace's state (specs present / empty / code-only) and route | `choosing-a-workflow` + narrow self-trigger | active; unverified by use |
| `starting-a-new-project` | worker — inception interview (empty repo → goal-and-requirements) | `setting-up-a-project` + narrow self-trigger | active; unverified by use |
| `importing-a-codebase` | worker — existing codebase → first spec graph (derive + adopt existing docs + minimal interview) | `setting-up-a-project` + narrow self-trigger | active; unverified by use |
| `brainstorming` | worker — any project change, however small → validated task-spec before implementation | `choosing-a-workflow` | active; unverified by use |
| `shipping-a-pr` | worker — PR lifecycle (create with gates / body or screenshot maintenance / up-to-date sync / checks / review comments — phases as sections) | `choosing-a-workflow` + narrow self-trigger | active; snapshot-by-default completion and verification reuse unverified by use |
| `asking-user-questions` | concept — `ask_user_question` rounds, options, inference confirmation, degradation | — (reached by name, rule 4) | active; unverified by use |
| `writing-specs` | concept — the spec quality bar for every spec-producing flow | — (reached by name, rule 4) | active; unverified by use |
| `spec-graph` | concept — graph mechanics: what a spec is, frontmatter, link kinds, the `spec_*` tools | — (self-trigger, rule 4) | active; the `spec_*` tools it documents are covered by this plugin's test suite; routing unverified by use |
| `writing-workflow-skills` | worker — authoring checklist for this family | — (self-trigger only, rule 4) | active |

The family is open and grows from real use; candidates (research/spike, refactor, bug-fix, a composing
skill in the composer pattern with its stage workers, and **extending an existing spec graph**) each
get their own task-spec when they earn their place. The concept role has three instances here:
`asking-user-questions`, `writing-specs`, and `spec-graph`.

## Known gaps

The family's known debt, stated honestly and tracked here until each item earns its fix:

- **Rule 14 (verify-by-use) is suspended** — not a done-gate, and in this plugin nothing has been
  observed flowing by use: the rule now routes every new piece of work to the router, but whether the
  router and workers follow their routes has not been watched in a real session. The test suite pins
  contract-level facts (section injection, skill declarations, and frontmatter), not observed routing.
  Process rows carry that verification debt honestly; update them when a real request is observed.
- **Extending an existing spec graph has no worker.** Partial graph → complete graph (a missing
  `architecture.md`, un-specced modules, stale nodes) falls between the two setup workers:
  `importing-a-codebase` refuses specced repos and `brainstorming` designs new work rather than
  documenting existing reality. If the graph-extension offer is accepted, the dispatcher says no
  dedicated skill covers it, then uses its own judgment under the `writing-specs` bar — until the
  `extending-a-spec-graph` candidate earns its place.
- **`writing-specs` overlaps the `spec-graph` skill**: both carry lean/honest spec guidance. The
  declared split — this family owns the quality bar, `spec-graph` owns graph mechanics — is convention
  only, enforced by nothing. As `writing-specs` grows into the home for the family's spec rules, the
  `spec-graph` skill's guidance should slim to mechanics.
- **Most candidates are unbuilt** — deliberate, since each earns its place through real use. Until
  then, every new request still enters the root router; project-changing work goes to `brainstorming`,
  while direct-answer cases are classified there and proceed without a worker. The family still lacks
  a dedicated worker for multi-stage pipelines or extending an existing spec graph.
