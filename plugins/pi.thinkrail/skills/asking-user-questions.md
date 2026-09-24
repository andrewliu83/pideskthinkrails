---
name: asking-user-questions
description: "Use when composing an ask_user_question round inside a workflow, or when a workflow skill names it at a question step. Shared norms for the tool — not a workflow, nothing to execute."
---

> 移植自 JetBrains/ThinkRail 的 `packages/pi-thinkrail-workflow/skills/asking-user-questions`（MIT）。

# Asking User Questions

The workflow family's shared norms for `ask_user_question`: how to compose rounds, shape options, and
degrade when answers don't come. Process skills name this concept at the steps that ask; *when* to ask
— and where the answers get recorded — stays with the referencing skill.

## Rounds, not chat turns

- One call = one **round**: one or more questions with no fixed per-round maximum, 2–4 options each.
  Group everything the current step needs into a single round — never chain a second call straight
  after for a trivial follow-up.
- **The call pauses the run.** The card stays pending until the user submits it; the answers arrive as
  this tool's result, one line per question as `question：answer`, multiple questions separated by
  `\n---\n`, and a skipped or unanswered question leaving an empty value after its separator. Don't
  keep working on the paused step or assume an answer until it arrives — whether that is seconds later
  or days later. Stopping the turn resolves every remaining question as skipped.
- **While the card is open, a message typed into the composer queues behind it.** It neither answers
  nor supersedes the round. Only the card (Next / Skip / Decline all) or stopping the turn resolves it.
- Resolve the round, act on what you learned, and open a new round only when the answers raised a
  genuinely new question.

## Options

- An option is a **plain label**, one string each: the choice and its consequence inside the same
  string (e.g. `A full deletion (Recommended): drop the tools, the panel page and the tests, keep the
  7 spec tools`). This carrier has no separate label/description pair and renders no `Why:` line.
- The card accepts only `question`, `options` (an array of strings, deduplicated) and `multiSelect`.
  Anything else is dropped before it reaches the UI — including upstream's `header` short label and
  its per-option `preview` markdown, which this carrier has no field for.
- Recommended option first, label suffixed "(Recommended)", with the reason that would go in a
  recommended-reason field folded into that option's own text.
- Every option: a concise label (1–5 words, ≤ 60 chars) plus the trade-off or consequence of choosing
  it. Tailor options to the work at hand — never generic placeholders.
- Options must be **decidable by the asked user**: frame them as observable behavior or outcomes
  ("collapsing a project stays collapsed after a rename"), never as implementation mechanics
  ("semantic guard", "activation ref"). If candidate options differ only internally — identical
  observable behavior — don't ask: decide yourself and record the reasoning in the workflow's
  artifact.
- Never author your own "Other", free-text, or escape option — the card always supplies its own
  `Enter another answer` input. That row is *additive*: a typed answer arrives alongside the checked
  options, it does not replace them.
- `multiSelect: true` when several answers are valid at once (feature checklists); single-select when
  confirming something or choosing one path.
- The card shows one question at a time, with an indicator per question (unanswered / answered /
  skipped) and lets the user revisit one. Keep a round small enough to answer without losing the
  thread, and put questions that must be decided together in the same round.

## Confirming an inference

When you have inferred something and need a yes/adjust rather than an open answer: the inferred
statement *is* the question text, with "Looks right" as the first option (description: "accurate as
written") and a genuine rejection option second (e.g. "Off base — ask me directly"). Edits arrive
through the card's automatic `Enter another answer` input — do not author an edit option. Read the
response as:

- **"Looks right"** → the inference holds; continue unchanged.
- **Free-text tweak** (one fact changes) → update that field only; don't re-derive anything else.
- **Substantial rewrite** → re-derive every inference that came from that statement before continuing.
- **Rejection** → discard the inference entirely and ask an open-ended question instead.

## Degradation

- Skipped, declined, or unanswered questions are not blockers: proceed on best-guess assumptions,
  explicitly recorded as unconfirmed in the workflow's artifact (the referencing skill says where).
- If the host reports no interactive UI, state your assumptions the same way instead of blocking.
- "I don't know / help me understand" is a mis-framing signal, not a missing-knowledge one: re-explain
  from user-visible behavior in plain language, then re-ask with behavior-framed options — don't
  repeat the same technical options with more detail.