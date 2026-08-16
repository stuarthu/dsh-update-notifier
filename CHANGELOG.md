# Changelog

All notable changes to `dsh-update-notifier` are documented here. This project
follows semantic versioning.

## 0.2.0

- Added `/check-updates`, a manual trigger for the check that until now only ran on the hourly timer. It sweeps the registry immediately, raises the ordinary approval bubble against the session it was typed in, and settles as soon as the sweep finishes — the bubble outlives the command row rather than holding it pending under the UI request's abort signal.
- The manual check deliberately **forces**: `announced` and the persisted `declines` are both ignored, so an explicit ask can never settle as "no updates" because of a version you left unticked earlier. The hourly cycle's suppression is unchanged.
- Its settlement text reports what was swept (`2 updates — see the question above (7 plugins checked)`), refuses with a reason while a bubble is open or a check is in flight, and falls back to printing the manual `pnpm ... add` command where no bubble can be shown.
- Cancelling the command row stops the sweep, aborting the registry request it is inside rather than waiting it out, so a cancelled check cannot raise a bubble afterwards that nothing on screen explains.
- Where no bubble is possible the settlement now says so for the host's own reason as well: `userQuestions.ask()` refuses a delegated (non-root) caller, so the manual `pnpm ... add` fallback is offered instead of promising a question that would be rejected.
- A registry lookup that fails is no longer indistinguishable from "no such package": a thrown fetch, a timeout, a 5xx or a 429 all count as unreachable and are reported (`7 plugins checked, 2 unreachable`), 404/403 stay silent as before, and a sweep in which nothing at all could be reached settles as an error instead of "no updates".
- Registered via `ctx.inject(["commands"], …)` rather than `export const inject`, which stays `["agents"]`: a composition with no command registry loses the command and keeps its hourly checks. The registration's `try/catch` sits inside the inject callback, since cordis defers it by a microtask and an outer catch would never see a rejected registration.
- Hardening found while reviewing the above: the un-awaited upgrade offer is now raised through `offerUpgrade()`, which owns the promise. Both this path and the pre-existing post-message retry could previously turn a throw outside `askUpgrade`'s own `try` into an unhandled rejection — enough to take the dsh process down.

## 0.1.1

- Fix: the npmjs.com package page rendered the Chinese README. npm's `@npmcli/package-json` globs `{README,README.*}` and takes the first match in unsorted readdir order, so `README.zh.md` could win over `README.md`. Renamed to `README-zh.md`, which cannot match that glob. No code changes — `lib/index.js` is byte-identical to 0.1.0.
- CI: publishing is now trusted-publishing-only — the `NPM_TOKEN` fallback and `setup-node`'s `registry-url` are both gone, so a broken binding fails as a legible `ENEEDAUTH` instead of an opaque 401, and the release steps now reject a reintroduced static credential or a README that could hijack the package page. Rationale lives in `publish.yml`'s comments.

## 0.1.0

Initial release.

- Hourly check (configurable `interval`, first check after `initialDelay`) of every npm package backing a loaded dsh plugin against the registry's `latest` dist-tag.
- Pops a dsh-rendered multi-select approval bubble (`ctx.userQuestions.ask()`) against the most recently active session's agent — one option per outdated plugin, no model turn, zero tokens, replayed on reconnect.
- Approved plugins are handed to that agent via `followup()` (which wakes an idle driver) as a `pnpm --dir <profileDir> add ...` instruction; the plugin never runs a package manager itself.
- Declined versions persist to `<profileDir>/.dsh-update-notifier.json` and are never re-offered across restarts until a strictly newer version appears; unanswered bubbles are not treated as declines.
- No live session or no `userQuestions` provider holds the offer as pending (retried after the next user message and on the next cycle), logging the command in provider-less compositions.
- Proper semver comparison (prerelease-aware, never suggests downgrades).
- Config: `interval`, `initialDelay`, `registry`, `exclude`, `fetchTimeout`, `profileDir`; per-package opt-out via `dsh.updateNotifier: false`.
- Prompt-injection hygiene: only package names and syntax-validated version strings reach the bubble or the agent.
