---
name: brainstorming
description: "Use before any work that creates or changes project content: features, added functionality, behavior, docs, config, or design — however small. Record and get explicit approval of a task-spec design before implementation."
---

> 移植自 JetBrains/ThinkRail 的 `packages/pi-thinkrail-workflow/skills/brainstorming`（MIT）。

# Brainstorming

## Brainstorm before you build

- Before starting any work that changes the project — a new feature, added functionality, a behavioral
  change, a documentation or configuration edit, or a nontrivial design decision — stop and run this
  workflow before writing implementation code.
- The aim is to turn the request into a validated design, recorded as a spec-graph `task-spec`, that the
  user has explicitly approved — not a guess you implement and hope lands.
- Never implement during brainstorming. If you catch yourself opening a source file to make a change
  before the design is approved, stop.

## Anti-pattern: "this is too small to need this"

Every project-changing request goes through this, however small it looks. A one-line config change and a
new subsystem both benefit from checking what the user actually wants and why. Scale the *depth* to the
task; never skip the workflow entirely.

## The workflow

1. **Orient.** Use the spec-graph skill's tools first — `spec_grep` / `spec_get` / `spec_graph` — to
   find what the project already says about the area; read code second to confirm details.
2. **Scope check.** If the request bundles independent features or subsystems, separate them and
   brainstorm them one at a time rather than blending unrelated decisions into one task-spec.
3. **Open a task-spec.** As soon as you understand roughly what is being asked, create a `task-spec` at
   **`.thinkrail/context/TASK-<slug>.md`** (id, title, status: draft, parent: the nearest relevant
   module). This gitignored file is the one temporary design artifact; update it as decisions land.
   A `task-spec` only needs frontmatter `id` and `type` to be valid, so this works even when the project
   has no existing spec graph.
4. **Clarify.** Ask what is needed via `ask_user_question`, following the **asking-user-questions**
   concept skill. Resolve a full round, update the task-spec, and ask another round only if the answers
   raise a genuinely new decision. Skipped questions or a host with no UI are not blockers: record
   best-guess assumptions as unconfirmed and continue.
5. **Propose approaches.** Once the request is understood, put viable approaches, trade-offs, and a
   recommendation in the task-spec. When they are easiest to compare side by side, ask one
   `ask_user_question` round with each approach as an option.
6. **Present the design.** Write it into the task-spec in sections scaled to its complexity. Confirm
   decisions with the user as the design develops rather than presenting implementation as a fait
   accompli.
7. **Self-review.** Before asking for final approval, reread the task-spec for placeholders, contradictions,
   accidental scope expansion, unrelated decisions, and ambiguous requirements; fix what you find.
8. **Final review and approval.** Present the task-spec and proposed design to the user and wait for
   explicit approval before changing durable specs or source files. A research request or feature prompt
   alone is not approval of an implementation design.
9. **Promote.** After approval, move any settled boundary, contract, or decision into the relevant durable
   `SPEC.md` — `spec_create` for a new module, `spec_update` for its frontmatter, and the normal edit tools
   for prose. Run `spec_validate` after structural changes.
10. **Build.** Implement directly against the accepted design. Keep the task-spec and durable specs honest
    as the code lands, retire the task-spec when the work itself is done, and self-review the implementation
    diff for correctness, duplicated derivations, stale patterns, and rationale that belongs in a spec.

## What a good task-spec looks like

- Scoped to one piece of work — if it accumulates unrelated decisions, split them.
- States the request, the decisions and why, alternatives considered, and anything the user deferred or
  left unanswered.
- Promotes durable decisions into the owning spec instead of keeping two copies that can drift.

## Ending

Once the accepted design is implemented, verified, reflected in durable specs, and its task-spec is
retired, this workflow ends with no successor. PR lifecycle work, if requested, then enters
**shipping-a-pr** separately.
