---
name: setting-up-a-project
description: "At the first request in a project with no durable spec graph, run setup regardless of the request; ignore `.thinkrail/context/` task-specs. Also use when asked to set up, onboard, initialize, or spec a project."
---

> 移植自 JetBrains/ThinkRail 的 `packages/pi-thinkrail-workflow/skills/setting-up-a-project`（MIT）。

# Setting up a project — dispatcher

The single entry point for turning a project into a durable spec graph. Figure out which situation you're in,
then follow the matching skill — don't improvise the flow yourself.

## 1. Detect

Look at the workspace and use the spec tools (`spec_grep` / `spec_graph`):

- Is there a durable spec graph: Markdown specs with non-empty `id` and `type` outside `.thinkrail/context/`?
- Is there real source code, or is the repo empty / near-empty (just a README or scaffolding)?

## 2. Route

| Situation | Follow |
|---|---|
| **Already has a durable spec graph** | Don't redo onboarding. If setup was explicitly requested, briefly offer to review/extend the graph (fill obvious gaps — a missing `architecture.md`, un-specced modules) or point at `brainstorming` for feature work. Declined → stop. Accepted → **Graph extension** below. If this is an automatic first-session check, return to the queued user request without offering unrelated graph work. |
| **No durable specs · empty / near-empty repo** | The **`starting-a-new-project`** skill — interview the user to turn the raw idea into `goal-and-requirements.md`. |
| **No durable specs · real source code** | The **`importing-a-codebase`** skill — analyze the code + agent files and draft the first durable spec graph, asking only for intent the code can't reveal. |

Read and follow that skill's steps.

## Graph extension (no dedicated skill)

No skill covers extending an existing graph. If the offer is accepted: say so in one line, then align
and adapt to the user's request with your own judgment, holding the **writing-specs** bar.

## Automatic first-session handoff

When this dispatcher was entered automatically before the first user request in a project session, finish
any required onboarding, then return to that original request in the same session. Do not ask the user to
repeat it. If the queued request changes the project, it then follows the normal `brainstorming` route.

## Handoff

Ends by naming exactly one of: **starting-a-new-project**, **importing-a-codebase**, or — when a durable
spec graph already exists — the review/extend offer above (declined → stop; accepted → graph extension:
a one-line note that no skill covers it, then judgment against the **writing-specs** bar). For automatic
first-session onboarding, resume the queued original request after the worker completes.
