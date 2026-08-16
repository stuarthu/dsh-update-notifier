# dsh-update-notifier

English | [中文](README-zh.md)

Hourly — or on demand, with `/check-updates` — check for newer versions of your
installed [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh) plugins, with a **one-click approval bubble** to upgrade them.

Nothing in dsh tells you a plugin you installed has moved on; you find out by
remembering to run `npm view` yourself. This plugin closes that gap: it compares
every installed plugin against the registry once an hour and, when something is
newer, asks you — in the session, as a real question bubble — which ones to
upgrade. Tick the ones you want and the agent runs the upgrade in front of you.
It **never upgrades anything on its own**.

## Behavior

Once an hour (configurable), for every npm package backing a loaded plugin:

- **Look up the registry's `latest`** and compare it with the version installed
  in your profile's `node_modules`. Comparison is semver-proper — prereleases
  ordered correctly, downgrades never suggested — and a version that isn't a
  strict `X.Y.Z` is skipped rather than guessed at.
- **Ask, in one bubble.** Anything newer becomes a multi-select question
  rendered by dsh itself (`dsh-chrome 0.1.2 -> 0.1.3`, one option per plugin),
  attached to your most recently active session. It costs no model turn and no
  tokens, and it is replayed if you reconnect.
- **Hand the ticked ones to the agent**, as a follow-up message telling it to
  run

  ```sh
  pnpm --dir <profileDir> add <pkg>@<latest> ...
  ```

  The agent wakes immediately and you watch the upgrade happen. Pair this with
  [`dsh-hot-reload`](https://github.com/stuarthu/dsh-hot-reload) and the new
  version applies live, without restarting dsh.

## `/check-updates`

Don't want to wait for the hour to come round? Type `/check-updates` in the
session:

```
/check-updates
check-updates · 2 updates — see the question above (7 plugins checked)
```

It runs a full cycle immediately, against the session you typed it in, and the
row settles as soon as the registry sweep finishes — the bubble it raises is an
ordinary one, answerable whenever, surviving a refresh. Where no bubble can be
shown at all, the settlement carries the `pnpm ... add` command instead, so the
answer is never just "you can't".

Packages the registry could not be reached about — a network failure, a timeout,
a 5xx, a rate-limit — are counted in the settlement rather than passed off as up
to date, and a sweep where *nothing* could be reached settles as an error, not as
"no updates". Cancelling the row stops the sweep, so a check you cancel cannot
pop a bubble at you a minute later.

The manual check **ignores the decline memory below**: you asked, so you get the
full list, including versions you left unticked earlier. It does not disturb the
hourly schedule, and it declines to run — with a reason — while a bubble is
already open or a check is already in flight.

The command appears wherever dsh composes a command registry — which
`@deepseek-ai/dsh-base` does, so any profile built on it has `/check-updates`.
It is registered through `ctx.inject`, so a headless profile without one still
loads the plugin and keeps its hourly checks.

## Asked once

You are asked about a given version **once** (by the hourly cycle — the command
above overrides this):

- **Unticked ones are declines**, recorded in
  `<profileDir>/.dsh-update-notifier.json` and never offered again — across
  restarts — until the registry's `latest` changes to some other version that
  still beats what you have installed. Delete that file to be asked afresh.
- **Approvals are not recorded**: a successful upgrade makes that version
  current anyway, and one that failed is worth re-offering after a restart.
- **A bubble you never answered** (session ended, dsh stopped) is not a
  decline — you will be asked again.

With no live session yet, or in a composition with no `userQuestions` provider
(headless), the offer is held: it is retried right after your next message and
on the next hourly cycle. With no provider at all, the available updates and the
exact upgrade command are written to the log instead.

## Install

```sh
dsh plugin --profile web add dsh-update-notifier
```

Then restart dsh once (bundle patch layers load at boot). Works in **any
profile** — swap `web` for whichever profile you use; it checks the profile it
is loaded into. Needs Node 18+, for global `fetch`; any dsh host has it.

## Compatibility

Built and tested against **dsh `0.1.0-rc.6`** (Node 22 / 24). It uses only
public host services, so it degrades rather than breaks if one is absent:

| Host surface | Used for |
|---|---|
| `loader.entries()` | finding which packages back the loaded plugins |
| `userQuestions.ask()` | rendering the approval bubble |
| `agents.get(sessionId)` | resolving the session's live agent |
| `agent.followup()` | waking that agent to run the upgrade |
| `session/event` (`user/message`) | tracking the most recently active session |
| `agent/disposed` | withdrawing a bubble whose session died |
| `commands.register()` | the `/check-updates` command |
| `agents.roots()` | not promising a bubble `ask()` would refuse |

`userQuestions` and `commands` are resolved when needed rather than declared as
dependencies, so the plugin still loads in a headless profile that has no
provider for either.

## Opting out

A plugin that does not want to be offered for upgrade can say so in its own
`package.json`:

```json
{ "dsh": { "updateNotifier": false } }
```

Use `exclude` (below) to silence a plugin you do not control.

## Configuration

Set on the `update-notifier` row in your profile's `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `interval` | `3600000` | ms between checks (clamped to a 60000 minimum) |
| `initialDelay` | `10000` | ms before the first check after boot |
| `registry` | `https://registry.npmjs.org` | npm-compatible registry to query |
| `exclude` | `[]` | package names to never check or mention |
| `fetchTimeout` | `10000` | per-request registry timeout, ms (minimum 1000) |
| `profileDir` | auto | absolute path to the profile dir (auto-detected from the loader base URL if omitted) |

## Security

- **Nothing is upgraded without your click.** This plugin never spawns a package
  manager. It composes the bubble and, on approval, the instruction the agent
  then executes in plain sight.
- **No registry prose reaches the UI or the model.** Only the package name, read
  from your own profile, and a version string that passes
  `/^[0-9A-Za-z.+-]{1,64}$/` are ever put into the bubble or the agent message —
  never a description, README, or changelog fetched from the registry.
- The follow-up message carries `source.kind: "plugin"`, names exactly the
  approved packages, and tells the agent not to touch anything else.

## Limitations — read this

- **It asks; it does not verify.** Once you approve, the upgrade is the agent's
  to run. A failure is visible in the session, but this plugin neither retries
  it nor checks afterwards that the new version is really installed.
- **Only registry-installed plugins are seen.** A plugin linked from a local
  checkout, or built into dsh, has no package under the profile's
  `node_modules` and is skipped silently — no bubble, no log line.
- **Only the `latest` dist-tag is consulted.** There is no support for pinned
  ranges, `next`/`beta` channels, or holding a package back at a major version;
  a plugin whose newest release you never want should use `exclude`.
- **One bubble at a time.** While a bubble waits for an answer the hourly checks
  skip — and `/check-updates` refuses with "an upgrade question is already open"
  — so anything published meanwhile is picked up on the first cycle after you
  answer.
- **A decline is keyed to that exact version**, not to "anything up to it": if
  the registry's `latest` moves to a different version that still beats yours —
  including a lower one after an unpublish — you are asked again.
- The bubble needs a session that dsh can attach a question to. Registry
  failures, degraded loader state, and an unwritable state file all degrade to
  logging; a profile dir that cannot be located is the one case that disables
  the plugin outright, and it says so in the log.

## License

[MIT](LICENSE) © Stuart Hu
