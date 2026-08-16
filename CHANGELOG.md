# Changelog

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
