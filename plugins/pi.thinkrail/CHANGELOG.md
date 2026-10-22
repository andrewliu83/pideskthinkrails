# ThinkRail for PI-Desktop — Changelog

## 1.5.1

- Deliver the standing workflow rule over whichever channel the running host actually reads. PI-Desktop 0.20.x replaced the extension runner: `emitBeforeAgentStart` now hard-codes `systemPromptOptions` to `{}` and its merger only reads a returned `systemPrompt`, so writing `sections[name]` had become a silent no-op. That is why the router stopped firing: the plugin still loaded, but the rule never reached the model.
- Keep the section channel first for hosts that still expose a section map (PI-Desktop 0.15.x-0.19.x and upstream pi); with no map, append the same rule, wrapped in `<pi-thinkrail-workflow>` tags, to the end of the system prompt and return the combined string. The host prompt is preserved, never replaced, and the append is idempotent.
- Cover both channels in tests: a host with a section map still gets no returned `systemPrompt`, a host without one gets the appended block, an already-appended rule is not appended twice, and an empty or non-string prompt is left alone.

## 1.5.0

- On the first request in an attached project session, automatically run project setup/import before handling the request when source code exists but no durable spec graph is present.
- Ignore temporary task-specs under `.thinkrail/context/` when determining whether initial onboarding is complete.
- Skip automatic onboarding when a durable graph already exists or no project is attached; after import, resume the original request in the same session.
- Restore specs-before-code lookup and the pre-#485 broad workflow entry: every new request reaches the router, and every project change enters brainstorming regardless of size or how fully specified it is.
- Require explicit approval of the brainstorming task-spec design before writing durable SPEC files or implementation source.
- This repository does not contain the upstream `pi-todos` package, tools, or skills; TODO planning behavior is outside this plugin's scope.

## 1.4.1

- Inject the standing rule through the host's named prompt section without replacing the full prompt.
- Align spec indexing order, ignored-directory checks, path resolution, and tool risk metadata with the host/upstream contracts.
- Support PI-Desktop 0.15.6 and newer.
- Add host-bundle symlink containment coverage for the real path resolver.
