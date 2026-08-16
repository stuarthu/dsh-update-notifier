# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dsh-update-notifier` is a single-file DeepSeek Harness (dsh) plugin, published to npm, that hourly checks the registry for newer versions of the plugins installed in a dsh profile and pops a dsh-rendered approval bubble asking which to upgrade. Approved upgrades are executed by the *agent*, never by this plugin. All logic lives in `lib/index.js` (ESM, Node >= 18 for global `fetch`, zero runtime dependencies; `@deepseek-ai/dsh-llm` is an optional peer dependency provided by the dsh host).

There are no tests, no linter, and no build step — the published `lib/` is the source. Verification is manual, against a real dsh profile.

## How it works (lib/index.js)

- **Enumeration**: "installed plugins" = every npm package backing a loaded `loader.entries()` row (same `pkgOf` technique as `dsh-hot-reload`); installed versions come from `<profileDir>/node_modules/<pkg>/package.json`.
- **Check**: `runCheck()` fires `initialDelay` ms after boot, and the `setInterval` is armed at `apply()` — so cycles land every `interval` ms from *boot*, not from the first check. Each fetches `<registry>/<pkg>/latest` per package (AbortController timeout, all failures → retry next cycle).
- **Bubble**: `askUpgrade()` resolves `ctx.get("userQuestions")` and calls `.ask()` with one multi-select question whose options are `pkg current -> latest`, attached to the most recently active session's live agent (tracked via `session/event` `user/message`, same as dsh-chrome's page-injector). The web provider (`packages/host/apiproxy` in the dsh source) rejects agentless requests and replays pending questions on mux-open, so the bubble survives a refresh.
- **Execution**: ticked options become one `agent.followup()` message (`source.kind: "plugin"`) instructing the agent to run `pnpm --dir <profileDir> add pkg@ver ...`. `followup()` — not `inject()` — is deliberate: it wakes an idle driver, so the click leads straight to action.
- **State**: `<profileDir>/.dsh-update-notifier.json` holds `pkg -> declined version`, written via write-tmp + rename.

Invariants worth preserving when editing:

- **Never upgrade automatically, and never spawn a package manager from this plugin** — the click is the consent, the agent is the executor, and the upgrade stays visible in the session.
- **Prompt-injection hygiene**: only local package names and registry version strings passing `/^[0-9A-Za-z.+-]{1,64}$/` may reach the bubble or the followup text. No registry prose (descriptions, READMEs, changelogs) may ever reach the UI or the model.
- **Only an answered bubble settles anything.** An answer marks every offered `pkg@latest` in `announced` (run-scoped) and persists the *unticked* ones to `declines` (restart-scoped). An abort/cancel/provider-disposal is NOT a decline: it re-holds `pendingOutdated` and leaves both maps untouched. Approvals are never persisted.
- **`semverGt` fails closed**: unparseable versions compare as "not greater" — an odd registry tag must never trigger an upgrade prompt, and downgrades are never suggested.
- **`labelFor()` is the answer key, not just a display string.** The bubble's returned `selected` array carries option *labels*, matched back with `selected.has(labelFor(o))`. Change the format on one side only, or let two entries produce the same label, and approvals are silently dropped — the user ticks a box and nothing upgrades.
- **The pending-offer retry is deferred with `setTimeout(…, 0)`** so it never re-enters the registry from inside `session/event` dispatch, and `runCheck()` clears `pendingOutdated` before recomputing so a held offer can't be delivered twice.
- **Re-offer is keyed on version *inequality*, not on being newer.** `declines[pkg] === latest` suppresses; any other `latest` that still beats the installed version asks again (an unpublish that moves `latest` down can therefore re-ask).
- **At most one outstanding bubble** (`asking`); cycles skip while it is up, and `agent/disposed` for the asking agent aborts it so a dead session can't wedge the flag forever.
- **Fail-safe degradation**: missing loader/profile dir → inactive with a warning; degraded `loader.entries()` or registry failure → skip the cycle; no provider/session → pending offer plus a log line with the manual command; unwritable state file → warn once, degrade to in-memory. Never crash dsh.
- `export const inject` lists only `agents` — this cordis treats every `inject` entry as *required*, so `userQuestions` is probed with `ctx.get()` at ask time to keep the plugin loadable in headless compositions.
- Timers are `unref`ed and `ctx.effect` clears them, both listeners, and any outstanding question on dispose.
- An **explicit `config.profileDir` always wins** over auto-detection (same semantics as dsh-hot-reload).

`cordis.patch.yml` is the bundle patch dsh applies at boot to mount the plugin (referenced from `package.json`'s `dsh.bundle.patch`); its comments document the full config surface, including the per-package `dsh.updateNotifier: false` opt-out, which is read from the *target* plugin's `package.json`, not from this one's config.

## Releasing

Publishing uses npm Trusted Publishing (OIDC) with `npm publish --provenance --access public`. `.github/workflows/publish.yml` runs **only on `v*` tag pushes** — plain pushes to `main` publish nothing. The run fails if the tag doesn't match `package.json`'s version, skips (green) if that version is already on npm, and *fails* rather than skipping when the registry check errors for any non-404 reason, so a release is never lost to a transient 5xx — re-run the workflow once the registry recovers.

`setup-node`'s `node-version: "24"` pin is load-bearing: 24.5.0+ bundles npm ≥ 11.5.1, the trusted-publishing floor, which is why there is no `npm install -g npm@latest` step. Lowering or exact-pinning it to an older 24.x silently breaks OIDC.

Two invariants are enforced by the workflow itself rather than by convention; `publish.yml`'s comments carry the full reasoning, so change them there, not here:

- **No static npm credential.** Neither a `NODE_AUTH_TOKEN` env nor `registry-url` on `setup-node` (which writes one into the npmrc, and is detected via the `NPM_CONFIG_USERCONFIG` it exports) may come back — either turns a broken trusted-publisher binding into an opaque 401 instead of an `ENEEDAUTH`. The **Publish** step fails the run if either reappears; note it is gated on `publish == 'true'`, so re-tagging an already-published version never exercises the check. 0.1.0 bootstrapped with a temporary token, because npm only allows configuring a trusted publisher on a package that already exists; the fallback went away in 0.1.1 and the `NPM_TOKEN` repo secret should stay deleted.
- **The Chinese README must not be named `README.zh.md`.** npm globs `{README,README.*}` and takes the first match, so it can publish the Chinese text as the package page — it did in 0.1.0. The **Verify the release** step rejects any file matching `^README(\..+)?$` (case-insensitive) other than `README.md`; `README-zh.md` is the sanctioned name.

To cut a release: bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, push `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z` — tagging a commit that isn't on `main` publishes code nobody can see. Keep `README.md` and `README-zh.md` in sync — both ship in the package.
