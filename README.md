# dsh-update-notifier

[中文](./README.zh.md)

A [DeepSeek Harness (dsh)](https://github.com/deepseek-ai) plugin that **hourly checks npm for newer versions of your installed dsh plugins** and, when it finds any, **pops an approval bubble asking which ones to upgrade**. Tick the ones you want; the agent runs the upgrade. It never upgrades anything on its own.

Think of it as [`update-notifier`](https://www.npmjs.com/package/update-notifier), but for the plugins inside your dsh profile — and with a button.

## How it works

1. Every hour (configurable) it enumerates the npm packages backing your profile's loaded plugins and reads each installed version from the profile's `node_modules`.
2. It asks the registry for each package's `latest` dist-tag (10 s timeout per request; failures are silently retried next cycle).
3. When `latest` is strictly newer (proper semver comparison — prereleases handled, downgrades never suggested), it calls `ctx.userQuestions.ask()` against the **most recently active session's agent**. dsh renders a real multi-select question bubble, one option per plugin (`dsh-chrome 0.1.2 -> 0.1.3`). No model turn, no tokens; the bubble is replayed if you reconnect.
4. Ticked plugins are handed back to that session's agent as a follow-up message telling it to run

   ```sh
   pnpm --dir <profileDir> add <pkg>@<latest> ...
   ```

   The agent wakes immediately and you watch the upgrade happen in the session. Unticked plugins are declined.

Pair it with [`dsh-hot-reload`](https://github.com/stuarthu/dsh-hot-reload) and approved upgrades go live without restarting dsh.

### When you don't get asked twice

- **Declined** (unticked) versions are written to `<profileDir>/.dsh-update-notifier.json` and never offered again — across restarts — until a strictly newer version appears.
- **Approved** versions aren't persisted: a successful upgrade makes them current, and an upgrade that failed is worth re-offering after a restart.
- A bubble you never answered (session ended, dsh stopped) is **not** a decline — you'll be asked again.

### When there's no bubble to show

No live session yet, or a composition without a `userQuestions` provider (headless), holds the offer as pending: it's retried right after your next message, and on the next hourly cycle. With no provider at all, the available updates and the exact upgrade command are logged instead.

## Install

```sh
dsh plugin --profile web add dsh-update-notifier
```

## Configuration

All optional — see `cordis.patch.yml`:

| key | default | meaning |
| --- | --- | --- |
| `interval` | `3600000` | ms between checks (min 60000) |
| `initialDelay` | `10000` | ms before the first check after boot |
| `registry` | `https://registry.npmjs.org` | npm-compatible registry to query |
| `exclude` | `[]` | package names to never check or mention |
| `fetchTimeout` | `10000` | per-request registry timeout (ms) |
| `profileDir` | auto-detected | absolute path to the profile dir |

A plugin can opt itself out with `"dsh": { "updateNotifier": false }` in its own `package.json`.

## Safety notes

- **Nothing is upgraded without your click.** The plugin never spawns a package manager; it only composes the bubble and, on approval, the instruction the agent executes in plain sight.
- Only the package name (from your local profile) and a syntax-validated version string from the registry are ever embedded in the bubble or the agent message — no registry prose (descriptions, changelogs) can reach the UI or the model.
- The follow-up message carries `source.kind: "plugin"` and names exactly the approved packages, with an explicit instruction not to touch anything else.
- Registry/network failures, degraded loader state, an unwritable state file, or a missing profile dir all degrade to logging — never to crashing dsh. Both timers are `unref`ed, so the checker never keeps the process alive.

## License

MIT © Stuart Hu
