# ThinkRail for PI-Desktop — Changelog

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
