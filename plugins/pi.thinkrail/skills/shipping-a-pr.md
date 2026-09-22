---
name: shipping-a-pr
description: "Use when finished work needs to ship as a pull request, or when creating, syncing, updating metadata, checking status, monitoring CI, or addressing review comments on a PR. Not for reviewing a PR you are not shipping."
---

> 移植自 JetBrains/ThinkRail 的 `packages/pi-thinkrail-workflow/skills/shipping-a-pr`（MIT）。

# Shipping a PR

The PR lifecycle: ship the workspace's finished work, maintain PR metadata, and keep the PR healthy
when requested. One workflow, six phases as sections below — enter at the phase the ask names.

## Completion modes (applies to every phase)

- **Snapshot mode is the default** for creating, syncing, or updating a PR and for one-time status
  requests. Take one fresh checks and merge-state snapshot, report pending/failing/indeterminate state
  as observed, and stop without polling or fixing unrelated state. A push never upgrades the mode by
  itself.
- **Wait mode requires an explicit remote-completion ask**: monitor or watch checks, investigate CI,
  wait until green, or make the PR merge-ready. Done means every configured check is green, the head
  is current with its base, and GitHub reports an affirmative merge state; a requested draft is
  reported as draft, never merge-ready. A repository with no CI is reported as exactly that, never
  silently green.

## Observed, never assumed (applies to every phase)

Git and GitHub state is concurrent and mutable: the base moves, CI lags, mergeability is computed
lazily, and this workflow's own steps dirty the tree they just checked. Four rules hold at every
step of every phase:

- **Verify at the point of action.** An irreversible step — push, `gh pr create`, `gh pr edit`,
  replying to a thread, declaring done — re-checks the exact state it consumes immediately before
  running. A gate passed earlier does not survive the mutations made since it passed.
- **Keep verification tied to the final tree.** Reuse exact prior results while the inputs they cover
  remain unchanged. Before every code-affecting push, run project-required checks that are missing or
  invalidated by later code, configuration, dependency, base, or conflict-resolution changes. If a
  check, cleanup, or self-review causes another relevant edit, reassess and repeat before pushing.
- **Fetch, don't remember.** Remote state is read fresh and completely at the moment it's needed:
  the current body before editing it, `--paginate` on every listing, `git fetch` before reasoning
  about the base.
- **Indeterminate is not affirmative.** In wait mode, a pending or still-computing answer (an
  `UNKNOWN` merge state, queued checks) is polled until it resolves; done is declared only from
  observed affirmative state. In snapshot mode, report it as indeterminate without turning the
  phase into a watch.

## Classify the ask

| The ask | Phase | Default mode |
|---|---|---|
| Create a PR — the work is finished | Creating a PR | snapshot |
| Bring the PR up to date / resolve conflicts with its base | Syncing | snapshot |
| Update the PR title or body | Body | snapshot |
| Add or refresh screenshots on a PR | Screenshots | snapshot |
| Report the current checks / merge state once | Checks | snapshot |
| Monitor CI / investigate or fix failing checks | Checks | wait |
| Address review comments | Review comments | snapshot |

**Read and follow the selected section below** — the gates and mechanics live only there; never run
a phase from this spine's summary. Carry the completion mode selected above into that section; a later
push does not change it. A compound ask ("rebase, verify, and create a PR") is one flow: start at the
earliest phase named; the sections chain forward on their own. If the work itself isn't finished — the
ask bundles new design or implementation before the ship — that part is not this workflow's; route it
per choosing-a-workflow first and come back here when it lands.

## Working files

Ephemeral files this workflow uses, all under the workspace's gitignored `.thinkrail/context/`:

- `pr-body.md` — the PR body draft; always passed via `--body-file`, never inline.
- `pr-shots/` — staged before/after screenshots awaiting attachment.

Both are deleted when the phase that made them completes (screenshots stay while the user is
uploading by hand — see the Screenshots section).

## Ending

Every phase ends through the Checks section, in the completion mode selected above.

## Creating a PR — gates, then the PR

Entry: finished work on a branch, no PR yet. Saves the body draft at
`.thinkrail/context/pr-body.md`. Creating defaults to snapshot mode; an explicit remote-completion ask
selects wait mode. Control continues with the selected mode at the Screenshots section (UI-visible
change) or the Checks section.

### Gates — all five pass before `gh pr create`, in this order

1. **Committed, clean worktree.** Everything that ships is committed — `git status --porcelain`
   comes back empty. Work git doesn't hold (uncommitted edits, untracked files) will not reach the
   PR, and the rebase in the next gate needs a clean tree anyway.
2. **Fresh base.** `git fetch origin`, then rebase onto the base branch (default `origin/main`).
   Conflicts are resolved now, not after review starts.
3. **Clean branch.** Remove throwaway artifacts — repro tests, capture specs, scratch files, test
   output dirs. Read `git log --oneline <base>..HEAD` and `git status --short` as the reviewer will:
   every file in the diff must be explainable in one line.
4. **Verification evidence.** Apply the spine's final-tree rule: collect the exact checks already run
   during development, reuse results whose covered inputs are unchanged, and run only missing or
   invalidated project gates. Do not rerun a passing command merely because PR creation started.
   Changed commit IDs alone do not invalidate evidence; relevant changes in the resulting tree do.
   Report the exact commands and results in the body's Testing section; a project with no gates is
   verified by hand and reported as exactly that, never silently treated as verified.
5. **Self-review.** Re-read the full diff (`git diff <base>...HEAD` plus working tree) as a
   reviewer, holding the project's handoff-hygiene bar: no silent lint/type suppressions, no comment
   creep, no half-migrated patterns, no leftovers. Fix what you find; don't annotate it.

Red flags — stop, a gate is being rationalized away:

- "PR creation always means rerunning everything" — valid final-change evidence is reusable.
- "That earlier result probably still applies" — later changes may have invalidated it.
- "The rebase can wait until review starts."
- "That file is probably fine" — you couldn't explain it to a reviewer in one line.

### The PR

- **Title**: `scope: imperative summary` — e.g. `feat(web): …`, `fix(website): …`, `ci: …`.
- **Body** → `.thinkrail/context/pr-body.md`. Read the **target repository's** own
  `.github/PULL_REQUEST_TEMPLATE.md` at the point of drafting and preserve its sections, order, and
  every checklist item; replace prompts with concrete content and tick only checks actually completed.
  Drop a related-issues section only when the PR closes nothing. If the target repository has no
  template, use `## Summary` (what and why, plus `Closes #NNN` when issue-driven), `## Changes`
  (including exclusions or migration steps when material), and `## Testing` (exact commands and
  results, never a bare "tests pass").
- **Stabilize the tree, push, then create.** Gates 3–5 may edit the tree gate 1 checked. When they do,
  commit everything, then repeat gates 3–5 against the new head; push only after a pass makes no
  further edits and `git status --porcelain` is empty *now* (the spine's point-of-action rule). Then
  push the reviewed, final-change-verified head —
  `gh pr create --head` does **not** push for you: `git push -u origin <branch>`
  (`--force-with-lease` when the remote branch exists and was rebased) — then
  `gh pr create --base <base> --head <branch> --title "…" --body-file .thinkrail/context/pr-body.md`
  — add `--repo` when the remote is ambiguous; `--draft` only when the user asked for a draft.
  Never pass the body inline: long inline/heredoc bodies have truncated and failed; the body file
  *is* the recipe. Delete the body file once the PR exists.

### Next

- The change is UI-visible → offer screenshots proactively (don't wait to be asked), then read and
  follow the Screenshots section below, carrying the selected completion mode.
- Otherwise → read and follow the Checks section below in the selected completion mode.

## Body — maintain the PR title or body

Entry: an open PR plus a requested title/body change. Saves `.thinkrail/context/pr-body.md` only while
editing the body. Default completion is snapshot mode; preserve wait mode only when selected by this
spine's explicit remote-completion rule.

1. Fetch the current title and body (`gh pr view <n> --json title,body`) and read the target
   repository's `.github/PULL_REQUEST_TEMPLATE.md` when present. Preserve existing sections, issue
   links, checklist items, and unrelated content; apply only the requested mutation.
2. For a body edit, write the complete candidate to `.thinkrail/context/pr-body.md`. Immediately before
   `gh pr edit`, fetch the current body again; if it changed, merge the requested mutation into that
   fresh body instead of overwriting concurrent edits. Use `gh pr edit <n> --body-file ...`, never an
   inline body. For a title edit, immediately re-fetch the current title too; if it changed, reapply
   only the requested mutation to that fresh title before `gh pr edit <n> --title ...`.
3. Fetch the resulting title/body once to verify the requested mutation landed, then delete the body
   file.

### Next

Read and follow the Checks section below in the selected completion mode.

## Syncing — bring the PR up to date

Entry: an open PR has fallen behind its base or has conflicts. Saves nothing. Syncing preserves the
caller's completion mode and defaults to snapshot mode when entered directly; control continues at the
Checks section.

1. `git fetch origin`, then rebase the branch onto the base — or merge, if the PR's existing
   history style is merge-based; follow what the PR already does.
2. Resolve conflicts by understanding both sides: read the conflicting hunks' history
   (`git log -p` on each side) before choosing. A mechanical "take ours" is how freshly merged
   work gets silently reverted.
3. **Reassess verification evidence.** Apply the spine's final-tree rule to the resulting change.
   Inspect conflict resolutions, relevant dependency changes, and base commits touching the change's
   behavior or test surface when deciding which gates were invalidated; use the full bar only when the
   base moved substantially enough to invalidate it. Changed commit ancestry alone does not force a
   rerun.
4. If step 3 causes a fix, commit it and repeat step 3 against the new head. Push only after evidence
   covers the final tree and `git status --porcelain` is empty (the spine's point-of-action rule).
   Use `--force-with-lease` after a rebase, never plain `--force`.

Red flags: "a rebase happened, so rerun everything" ignores valid evidence; "no conflicts, so every
old result still applies" ignores relevant behavior or dependency changes. Reassessing evidence is
unconditional; rerunning commands is not.

### Next

Read and follow the Checks section below in the selected completion mode.

## Screenshots — before/after evidence for reviewers

Entry: a PR exists (or was just created) for a UI-visible change. Saves PNGs under
`.thinkrail/context/pr-shots/` and rewrites the PR body to reference them. Preserve wait mode only
when the caller explicitly requested remote completion; otherwise use snapshot mode, including after
PR creation.

### Capture

- **After** = the scenario on the branch build; **Before** = the *same* scenario at the base branch
  (check out detached, rebuild, capture, return). Same viewport, same scenario — the pair must diff
  visually.
- Capture with whatever drives the app in this project: the e2e harness with a throwaway capture
  spec, or a browser-automation session against a running dev host. A capture spec is a throwaway —
  it never ships, and *this* section owns its cleanup (Next below): the Creating section's clean-branch gate has
  already run on every entry path here and will not catch it.
- Stage the picked shots as `.thinkrail/context/pr-shots/<name>.png` with names a reviewer reads
  (`loader-before-gap.png`, `loader-after-working.png`).

### Attach — review-only assets ref (the default)

Screenshots never enter the PR's file tree. Push them as an orphan ref and reference SHA-pinned
URLs:

```bash
TREE_INPUT=""
for f in .thinkrail/context/pr-shots/*.png; do
  sha=$(git hash-object -w "$f")
  TREE_INPUT+=$(printf '100644 blob %s\t%s' "$sha" "$(basename "$f")")$'\n'
done
TREE=$(printf '%s' "$TREE_INPUT" | git mktree)
COMMIT=$(printf 'PR screenshots (review-only ref)\n' | git commit-tree "$TREE")
git push -f origin "$COMMIT:refs/heads/assets/<topic>"
```

Then update the body — **never rebuild it**: fetch the current one first
(`gh pr view <n> --json body -q .body > .thinkrail/context/pr-body.md`), add or update a
`## Screenshots` section in it referencing each image as
`https://github.com/<owner>/<repo>/blob/<COMMIT>/<name>.png?raw=true` (pinned to the pushed commit
SHA so later branch pushes never break the images), then
`gh pr edit <n> --body-file .thinkrail/context/pr-body.md` and delete the file. A body built from
scratch here would erase the PR's summary, testing notes, and issue links.

Fallback (the user sometimes prefers it): leave the PNGs staged and hand over their paths — the
user drags them into GitHub by hand. Offer the choice only when the user has signaled it; the
assets ref is the default.

### Next

Clean up this phase's throwaways once the body edit lands: delete `.thinkrail/context/pr-shots/`
(unless the user is uploading by hand — then leave it until they confirm) and every capture
scaffold (specs, throwaway builds). If any scaffolding was committed, the commit that removes it
is pushed too — a deletion left in the working tree ships nothing. That push does not change the
completion mode. Read and follow the Checks section below in the selected mode.

## Review comments — address comments, never blindly

Entry: an open PR has review comments to address. Saves nothing. Snapshot mode is the default whether
or not an accepted fix is pushed. Preserve wait mode only when selected by this spine's explicit
remote-completion rule.

1. **Whole-PR read first.** Fetch every comment thread and the full diff (`gh pr view <n>
   --comments`, `gh api repos/<owner>/<repo>/pulls/<n>/comments --paginate`), then re-read the PR's changes
   end to end. Each comment is judged against the whole change, not just its quoted lines.
2. **Verdict per comment, before touching code**: *apply* (it's right), *push back* (it's wrong or
   misreads the design — say why, citing the spec or design), or *clarify* (genuinely ambiguous —
   ask the reviewer or the user). Batch the verdicts; surface them to the user whenever any verdict
   is push-back.
3. Apply the accepted ones as proper changes, then apply the spine's final-tree verification rule.
   Commit everything and repeat that rule if verification causes another fix; push only when evidence
   covers the clean final tree. **Reply to every thread** only after the push lands: what changed and
   where (naming the commit), or the push-back rationale. Resolve only threads actually addressed.

Red flags:

- Patching exactly the quoted line without reading the surrounding design — "do not fix them
  blindly" is this doc's founding requirement.
- Replying "done" without a pushed commit that shows it.
- Silently skipping a comment — every thread gets an answer.

### Next

Read and follow the Checks section below in the selected completion mode, including snapshot mode
after an ordinary pushed fix.

## Checks — watch, react, report (terminal)

Entry: an open PR plus the completion mode selected by the caller. Saves nothing. This section ends
the workflow in one of the two terminal states below.

### Snapshot mode — default delivery and reporting

Use after ordinary PR creation, syncing, screenshots, title/body maintenance, review comments, any
routine head update, or a one-time checks/merge-state request. A push does not imply monitoring; use
this mode whenever the user did not explicitly request remote completion.

1. Run `gh pr checks <n>` once. An empty rollup means only "no checks currently reported" — CI may
   not have registered for a fresh head yet, so report its presence as indeterminate, not green.
   Report pending or failing checks as observed.
2. Query `mergeStateStatus`, `isDraft`, and `reviewDecision` together once. Report every value exactly
   as observed; do not poll, sync, rerun, or repair it.
3. Give the user the PR link, any metadata action completed, and the current checks + merge-state
   snapshot.

**Snapshot terminal state:** the requested PR action is complete and the current PR state is reported.
This is not a claim that the PR is green or merge-ready.

### Wait mode — explicit remote completion

#### Watch

- `gh pr checks <n> --watch` (or `gh run watch <run-id> --exit-status` for one run). When a watch
  is impractical, poll `gh pr checks <n>` with sleeps.
- If no checks are reported, wait briefly and retry until checks register or independently establish
  that the repository has no CI for this PR. Never infer "no checks configured" from one empty rollup;
  carry it into the terminal summary only after confirming it.
- On failure, inspect `gh run view --job <job-id> --log-failed`; reproduce locally when the log is not
  conclusive.

#### React

- Fix failures caused by the branch, commit, push, and restart the loop. A flaky-looking failure is
  investigated rather than rerun into submission; use `gh run rerun --failed` once and only when the
  failure is demonstrably unrelated to the branch.
- If green is unreachable without a user decision or work outside the request, report the blocker and
  stop rather than expanding scope.

#### Verify merge readiness

After checks resolve, query the complete state together:

`gh pr view <n> --json mergeStateStatus,isDraft,reviewDecision`

Handle every state explicitly:

- `isDraft: true` — if the user asked to mark the PR ready, run `gh pr ready` and re-query. Otherwise
  report that it remains a draft; a user-requested draft creation may finish in that expected state,
  but is never called merge-ready.
- `UNKNOWN` — wait briefly and re-query until GitHub computes the state.
- `BEHIND` or `DIRTY` — read and follow the Syncing section below, then return here in wait mode.
- `UNSTABLE` — the commit status is not fully passing. Re-read the current checks and handle the
  branch-caused failure; otherwise report the out-of-scope blocker. Never describe it as green.
- `BLOCKED` — report `reviewDecision` and do not declare success. `CHANGES_REQUESTED` routes to
  the Review comments section when addressing review feedback is in scope; `REVIEW_REQUIRED` needs a
  human review; any other value means another branch-protection rule still blocks the PR.
- `CLEAN` — affirmative: mergeable with passing commit status.
- `HAS_HOOKS` — affirmative with an explicit caveat: checks pass and GitHub considers the PR
  mergeable, but pre-receive hooks still run when the merge is attempted.

**Wait terminal state:** when the user explicitly requested remote completion, the PR exists, is
non-draft, current with its base, every configured check is green (or there is explicitly no CI), and
`mergeStateStatus` is `CLEAN` or `HAS_HOOKS` with the caveat
reported. The user gets the link plus what shipped, what was verified, and any deliberate exclusions.
A requested draft or a blocker that needs a human/out-of-scope decision is an explicit alternative
terminal state, never a merge-ready success.