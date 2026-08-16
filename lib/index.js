// dsh-update-notifier — hourly checks npm for newer versions of installed dsh
// plugins and pops a dsh-rendered approval bubble asking which to upgrade.
//
// What "installed plugins" means: every npm package that backs a loaded loader
// entry (the same definition dsh-hot-reload uses). Installed versions come from
// the profile's node_modules; latest versions from the registry's `<pkg>/latest`
// dist-tag endpoint.
//
// How it "pops up": `ctx.userQuestions.ask()` attached to the most recently
// active session's live agent — a real question bubble with one multi-select
// option per outdated plugin, rendered proactively by the dsh web UI (replayed
// on reconnect), with NO model turn and zero tokens involved. When no live
// session or no userQuestions provider exists, the offer is held pending and
// retried after the user's next message or on the next hourly cycle.
//
// Manual trigger: `/check-updates` runs a cycle on demand against the session
// it was typed in. It FORCES — the decline memory is ignored, because an
// explicit ask must never settle as "no updates" on account of a remembered
// "no" — and it settles as soon as the registry sweep finishes, leaving the
// bubble to be answered whenever, exactly like an hourly one.
//
// Who upgrades: the AGENT, never this plugin. Ticked plugins become one
// `agent.followup()` message (source.kind "plugin") telling the agent to run
// `pnpm --dir <profileDir> add pkg@ver ...` and report the outcome — followup
// wakes an idle driver immediately, so the click leads straight to action.
//
// Decline memory: unticked plugins are recorded in
// `<profileDir>/.dsh-update-notifier.json` and never re-asked for that exact
// version, across restarts, until a strictly newer version appears. Approvals
// are never persisted (success makes them current; an approved-but-failed
// upgrade was visible in chat and is only re-offered after a restart). An
// unanswered or cancelled bubble is NOT a decline and is re-offered.
//
// Prompt-injection hygiene: only local package names and syntax-validated
// registry version strings ever reach the bubble or the followup message — no
// registry prose (descriptions, changelogs) can reach the UI or the model.

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const name = "dsh-update-notifier";
// Only hard-require what every composition has; `userQuestions` is probed via
// ctx.get() at ask time so headless profiles still load this plugin (this
// cordis treats every `inject` entry as required — a missing one would leave
// the plugin silently pending forever).
export const inject = ["agents"];

const HOUR = 3_600_000;
const STATE_BASENAME = ".dsh-update-notifier.json";
const COMMAND_NAME = "check-updates";
/** A package the registry could not be asked about (offline, timeout, bad body).
 *  Distinct from `null` (no such package) only so the command can say so. */
const UNREACHABLE = Symbol("registry unreachable");

export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console;
  const loader = ctx.loader;
  const agents = ctx.get("agents");
  const registry = String(config.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const interval = Math.max(60_000, Number(config.interval ?? HOUR));
  const initialDelay = Math.max(0, Number(config.initialDelay ?? 10_000));
  const fetchTimeout = Math.max(1_000, Number(config.fetchTimeout ?? 10_000));
  const exclude = new Set(Array.isArray(config.exclude) ? config.exclude : []);

  if (!loader || typeof loader.entries !== "function") {
    log.warn?.("dsh-update-notifier: no loader on context; plugin inactive");
    return;
  }
  const profileDir = resolveProfileDir(ctx, config);
  if (!profileDir) {
    log.warn?.("dsh-update-notifier: could not locate profile dir (set config.profileDir); plugin inactive");
    return;
  }
  const nodeModules = join(profileDir, "node_modules");
  const stateFile = join(profileDir, STATE_BASENAME);

  // ---- installed-plugin enumeration (same technique as dsh-hot-reload) ----

  /** Package name backing a loader entry's module specifier, or null for local/builtin. */
  function pkgOf(specifier) {
    if (typeof specifier !== "string" || !specifier || specifier.startsWith(".") || specifier.startsWith("cordis:")) {
      return null;
    }
    if (specifier.startsWith("@")) {
      const [scope, pkg] = specifier.split("/");
      return scope && pkg ? `${scope}/${pkg}` : null;
    }
    return specifier.split("/")[0];
  }

  function readPkgJson(pkg) {
    try {
      return JSON.parse(readFileSync(join(nodeModules, pkg, "package.json"), "utf8"));
    } catch {
      return null;
    }
  }

  /** pkg -> installed version for every package backing a loaded entry. */
  function installedPlugins() {
    let list;
    try {
      list = [...loader.entries()];
    } catch {
      return null; // degraded — skip this cycle rather than reporting nonsense
    }
    const map = Object.create(null);
    for (const e of list) {
      const pkg = pkgOf(e?.options?.name);
      if (!pkg || pkg in map || exclude.has(pkg)) continue;
      const json = readPkgJson(pkg);
      if (!json?.version) continue; // not installed in this profile (builtin, linked, mid-swap)
      if (json.dsh?.updateNotifier === false) continue; // per-package opt-out
      map[pkg] = json.version;
    }
    return map;
  }

  // ---- registry ----

  async function latestVersion(pkg, signal = null) {
    // Scoped names keep the leading @ but encode the slash — the form every
    // npm-compatible registry accepts for dist-tag endpoints.
    const url = `${registry}/${pkg.replace("/", "%2F")}/latest`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), fetchTimeout);
    // A cancelled sweep must cut the round trip it is inside, not just the gap
    // before the next one — otherwise cancelling costs up to `fetchTimeout`.
    const cancel = () => ac.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
      // 404/403: unpublished/private — silently not our business. 5xx and 429
      // are the registry failing to answer, which must never read as "you are
      // up to date"; they are the common shape of an outage, so an error
      // status has to reach UNREACHABLE just like a thrown fetch does.
      if (!res.ok) return res.status >= 500 || res.status === 429 ? UNREACHABLE : null;
      const version = (await res.json())?.version;
      // Validate before it can ever reach the bubble or a followup message.
      if (typeof version === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(version)) return version;
      // A 200 whose body carries no usable version is not an answer either: a
      // mirror or proxy replying with its own JSON to every request would
      // otherwise sweep the whole profile clean and report "no updates". Only
      // 404/403 above may mean "no such package"; everything else is unknown.
      return UNREACHABLE;
    } catch {
      return UNREACHABLE; // offline / registry down — retry next cycle, never crash dsh
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  // ---- persisted declines ----

  let declines = loadDeclines();
  let stateWritable = true;

  function loadDeclines() {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8"))?.declines;
      const map = Object.create(null);
      if (parsed && typeof parsed === "object") {
        for (const [pkg, v] of Object.entries(parsed)) {
          if (typeof v === "string") map[pkg] = v;
        }
      }
      return map;
    } catch {
      return Object.create(null); // missing or corrupt — start clean
    }
  }

  function persistDeclines() {
    if (!stateWritable) return;
    try {
      // Atomic-ish: write beside, rename over — a crash mid-write never leaves
      // a truncated state file (which loadDeclines would discard anyway).
      const tmp = `${stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ declines }, null, 2));
      renameSync(tmp, stateFile);
    } catch (err) {
      stateWritable = false; // warn once, degrade to in-memory for this run
      log.warn?.(`dsh-update-notifier: cannot write ${stateFile} — declines won't survive a restart`, err);
    }
  }

  // ---- session tracking (same technique as dsh-chrome's page-injector) ----

  let lastActiveSessionId = null;
  let flushTimer = null;

  /** The one place "this session just became active" is recorded — a message
   *  arriving, or the command being typed. Anything else keyed on activity
   *  belongs here, not in one of the two callers. */
  function noteActiveSession(id) {
    lastActiveSessionId = id ?? lastActiveSessionId;
  }

  const offEvent = ctx.on("session/event", (session, event) => {
    try {
      if (event?.type === "user/message" && event.data?.source?.kind === "user") {
        noteActiveSession(session?.id);
        if (pendingOutdated && !asking && !flushTimer) {
          // Retry AFTER the current event dispatch settles, not from inside it.
          flushTimer = setTimeout(() => {
            flushTimer = null;
            const outdated = pendingOutdated;
            pendingOutdated = null;
            if (outdated) offerUpgrade(outdated);
          }, 0);
        }
      }
    } catch {}
  });

  function liveAgent() {
    try {
      return (lastActiveSessionId && agents?.get?.(lastActiveSessionId)) || null;
    } catch {
      return null;
    }
  }

  // ---- the approval bubble ----

  let pendingOutdated = null; // offer awaiting a live session / provider
  let asking = false; // at most ONE outstanding bubble; cycles skip while it's up
  let askAbort = null;
  let askAgent = null;

  // A bubble whose session dies would otherwise dangle forever (the web
  // provider keys pending questions by session) — abort it so the offer is
  // re-made against the next live session instead of wedging `asking`.
  const offDisposed = ctx.on("agent/disposed", (payload) => {
    try {
      if (payload?.agent && payload.agent === askAgent) askAbort?.abort();
    } catch {}
  });

  const labelFor = (o) => `${o.pkg} ${o.current} -> ${o.latest}`;
  const upgradeCommand = (outdated) =>
    `pnpm --dir ${profileDir} add ${outdated.map((o) => `${o.pkg}@${o.latest}`).join(" ")}`;

  /** The asker + agent a bubble needs, resolved once per offer. `asker` is the
   *  userQuestions service, and non-null only when a bubble can really be
   *  raised through it. */
  function askTarget(preferredAgent) {
    let asker = null;
    let agent = null;
    let rooted = true;
    try {
      const userQuestions = ctx.get("userQuestions");
      // The service being composed is NOT enough: `ask()` rejects with
      // `NO_PROVIDER` until a UI package registers the one active provider,
      // and only the web host does. Without this, a profile built on dsh-base
      // alone reports "see the question above" for a bubble that can never
      // appear — and skips the manual-command fallback below, because the
      // service was there. Reading the field fails safe: were it ever renamed,
      // an undefined degrades to printing the command, not to a phantom bubble.
      asker =
        userQuestions && typeof userQuestions.ask === "function" && userQuestions.provider !== undefined
          ? userQuestions
          : null;
      // The invoking agent when there is one — a command's own session beats
      // the tracked-session guess, and can never land the bubble elsewhere.
      agent = preferredAgent ?? liveAgent();
      // `ask()` itself refuses an agent owned by another live agent
      // (`DELEGATED_CALLER`), so reuse the host's own rule instead of a weaker
      // copy: "see the question above" must not be printed for a bubble the
      // provider is going to reject.
      if (typeof agents?.roots === "function") rooted = agents.roots().includes(agent);
    } catch {}
    return { asker, agent, ready: Boolean(asker && agent && rooted) };
  }

  /** Raise an offer without waiting for the answer — the bubble outlives its
   *  caller — while still owning the promise. An un-owned rejection here is an
   *  unhandled rejection, which Node turns into a dead dsh process by default,
   *  and the one thing this plugin must never do is take the host down.
   *
   *  @returns whether a bubble is actually going up, from the very target the
   *    offer uses — a caller reporting that must not predict it separately. */
  function offerUpgrade(outdated, preferredAgent = null) {
    const target = askTarget(preferredAgent);
    void askUpgrade(outdated, target).catch((err) => {
      log.warn?.("dsh-update-notifier: could not raise the upgrade question", err);
    });
    return target.ready;
  }

  async function askUpgrade(outdated, target) {
    if (disposed || asking || !outdated.length) return;
    if (!target.ready) {
      pendingOutdated = outdated; // hold; retried on next user message / cycle
      if (!target.asker) {
        log.info?.(
          `dsh-update-notifier: updates available (${outdated.map(labelFor).join(", ")}) — ` +
            "no userQuestions provider in this composition; upgrade manually with " +
            upgradeCommand(outdated)
        );
      }
      return;
    }
    const { asker: userQuestions, agent } = target;

    asking = true;
    askAbort = new AbortController();
    askAgent = agent;
    try {
      const answer = await userQuestions.ask({
        agent,
        signal: askAbort.signal,
        questions: [
          {
            id: "upgrade",
            header: "Plugin updates",
            question: `Updates are available for ${outdated.length} installed dsh plugin(s) — select which to upgrade:`,
            multiSelect: true,
            options: outdated.map((o) => ({ label: labelFor(o) })),
          },
        ],
      });
      const selected = new Set(answer?.answers?.find((a) => a?.id === "upgrade")?.selected ?? []);
      const approved = outdated.filter((o) => selected.has(labelFor(o)));
      const declined = outdated.filter((o) => !selected.has(labelFor(o)));
      // The user answered: this exact pkg@latest is settled for the whole run...
      for (const o of outdated) announced[o.pkg] = o.latest;
      // ...and unticked entries are settled across restarts too.
      for (const o of declined) declines[o.pkg] = o.latest;
      for (const o of approved) delete declines[o.pkg]; // drop stale older declines
      persistDeclines();
      if (approved.length) dispatchUpgrade(agent, approved);
    } catch (err) {
      // Aborted / cancelled / provider disposed: NOT a decline — hold the offer
      // for the next live session or cycle. (announced was not touched.)
      if (!disposed) {
        pendingOutdated = outdated;
        log.info?.(`dsh-update-notifier: upgrade question not answered (${err?.code ?? err?.message ?? err}) — will re-offer`);
      }
    } finally {
      asking = false;
      askAbort = null;
      askAgent = null;
    }
  }

  /** Hand the approved upgrades to the agent that answered the bubble.
   *  followup() wakes an idle driver, so the click leads straight to action. */
  function dispatchUpgrade(agent, approved) {
    const command = upgradeCommand(approved);
    const text = [
      "[dsh-update-notifier] Via the plugin-update bubble, the user approved upgrading these dsh plugins:",
      ...approved.map((o) => `  - ${labelFor(o)}`),
      "Run exactly this command now and report the outcome briefly:",
      `  ${command}`,
      "If dsh-hot-reload is active the upgrade applies live; otherwise tell the user a dsh restart is needed.",
      "Do not upgrade anything not listed above.",
    ].join("\n");
    try {
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "plugin", plugin: "dsh-update-notifier" },
        })
      );
    } catch (err) {
      // The session vanished between answer and dispatch — surface the command
      // so the approval isn't silently lost.
      log.warn?.(`dsh-update-notifier: could not hand the upgrade to the agent — run manually: ${command}`, err);
    }
  }

  // ---- the check cycle (hourly, or on demand via /check-updates) ----

  const announced = Object.create(null); // pkg -> latest already answered this run
  let checking = false;
  let disposed = false;

  /**
   * One check cycle: `{ ok: true, outdated, ready, attempted, checked,
   * unreachable }` — `attempted` counts the packages the sweep tried, `checked`
   * only the ones the registry answered for — or `{ ok: false, code }` for a
   * cycle that did not produce a verdict. The
   * timers discard it; only `/check-updates` renders it, and only `describe()`
   * turns a code into a sentence — a sweep the timers also run has no business
   * composing English for one surface.
   *
   * @param force  Ignore both decline maps. Only the command sets this: a
   *   remembered "no" must never turn an explicit ask into "no updates".
   * @param agent  Bubble target, when the caller knows it (the command does).
   * @param signal The command's UI request. A sweep is N sequential registry
   *   round trips, so a cancelled row must stop it: finishing would raise a
   *   bubble nothing on screen explains any more.
   */
  async function runCheck({ force = false, agent = null, signal = null } = {}) {
    /** The result that ends this run, or null to carry on. */
    const halted = () => {
      if (disposed) return { ok: false, code: "disposed" };
      if (signal?.aborted) return { ok: false, code: "cancelled" };
      return null;
    };
    const entry = halted();
    if (entry) return entry;
    if (asking) return { ok: false, code: "asking" };
    if (checking) return { ok: false, code: "checking" };
    checking = true;
    // A held offer is dropped for the length of the sweep, because this cycle
    // recomputes one from scratch and a user message landing mid-sweep must not
    // deliver a copy of what is about to be offered. A cycle that never reaches
    // a verdict puts it back (see the `finally`): an abort, an outage or a
    // degraded loader settles nothing, so it must not consume a pending offer
    // that would otherwise be re-delivered on the next user message.
    const held = pendingOutdated;
    pendingOutdated = null;
    let verdict = false;
    try {
      const installed = installedPlugins();
      if (!installed) return { ok: false, code: "loader" };
      const entries = Object.entries(installed);
      const outdated = [];
      let unreachable = 0;
      for (const [pkg, current] of entries) {
        const stop = halted();
        if (stop) return stop;
        const latest = await latestVersion(pkg, signal);
        if (latest === UNREACHABLE) {
          unreachable += 1;
          continue;
        }
        if (!latest || !semverGt(latest, current)) continue; // never suggest a downgrade
        if (!force && (announced[pkg] === latest || declines[pkg] === latest)) continue; // already answered
        outdated.push({ pkg, current, latest });
      }
      // Checked last as well: a cancel during the final fetch must still cost
      // the bubble, not just the row.
      const stop = halted();
      if (stop) return stop;
      // Nothing outdated *and* nothing reachable is not good news — it is a
      // failed sweep, and "no updates" would be the exact lie the UNREACHABLE
      // sentinel exists to prevent.
      if (entries.length > 0 && unreachable === entries.length) {
        return { ok: false, code: "unreachable", attempted: entries.length };
      }
      verdict = true; // past here this cycle has one, and owns the hold
      if (outdated.length) {
        log.info?.(`dsh-update-notifier: updates available — ${outdated.map((o) => `${o.pkg}@${o.latest}`).join(", ")}`);
      }
      // Deliberately not awaited: the bubble outlives this call. A command row
      // must settle on the sweep, not sit pending under the UI request's abort
      // signal until the user gets around to ticking boxes.
      const ready = outdated.length ? offerUpgrade(outdated, agent) : false;
      return {
        ok: true,
        outdated,
        ready,
        attempted: entries.length,
        checked: entries.length - unreachable,
        unreachable,
      };
    } catch (err) {
      log.warn?.("dsh-update-notifier: check failed", err);
      return { ok: false, code: "failed", error: err };
    } finally {
      checking = false;
      // Only ever restores what this cycle took: once there is a verdict the
      // offer above is the current one, and `pendingOutdated` is whatever it
      // decided; a bubble aborting mid-sweep also owns the slot over `held`.
      if (!verdict && pendingOutdated === null) pendingOutdated = held;
    }
  }

  // ---- /check-updates ----

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  /** Why a cycle produced no verdict. A code with no entry here cannot reach
   *  the user: `cancelled` is settled by the host's own abort handling, which
   *  discards whatever the handler returns. */
  const REASONS = {
    disposed: () => "the update notifier is shutting down",
    asking: () => "an upgrade question is already open — answer it first",
    checking: () => "a check is already running",
    loader: () => "the plugin loader is not reporting entries right now",
    unreachable: (r) => `the registry could not be reached (${plural(r.attempted, "plugin")} unchecked)`,
    failed: (r) => `the check failed (${r.error?.message ?? r.error})`,
  };

  /** Render a cycle's outcome as the command row's settlement. Never leads with
   *  this command's own name — the web UI already renders `check-updates · …`. */
  function describe(result) {
    if (!result.ok) {
      return { kind: "error", text: (REASONS[result.code] ?? (() => "the check did not run"))(result) };
    }
    // `checked` counts what the registry answered for, so the two numbers add
    // up to the packages attempted — "7 plugins checked, 2 unreachable" claimed
    // two of them twice.
    const swept = `${plural(result.checked, "plugin")} checked` +
      (result.unreachable ? `, ${result.unreachable} unreachable` : "");
    if (!result.outdated.length) {
      return {
        kind: "success",
        text: result.attempted === 0
          ? "no registry-installed plugins found in this profile"
          : `no updates (${swept})`,
      };
    }
    const count = plural(result.outdated.length, "update");
    return {
      kind: "success",
      text: result.ready
        ? `${count} — see the question above (${swept})`
        : `${count}, but no question bubble can be shown here — upgrade manually: ${upgradeCommand(result.outdated)}`,
    };
  }

  // Registered through ctx.inject so it activates only where a command registry
  // is composed — `export const inject` stays minimal, since every entry there
  // is required and would make this plugin unloadable in a headless
  // composition. The registration rides that child fiber and is withdrawn with
  // the plugin.
  ctx.inject(["commands"], (commandCtx) => {
    // The catch belongs HERE, not around ctx.inject(): cordis defers this
    // callback by a microtask (Fiber._reload awaits before _execute), so by the
    // time register() can throw — a duplicate command name does, from
    // NamedEntries — ctx.inject() has long returned and an outer catch would
    // see nothing. Cordis contains the throw either way, but as a fiber error
    // logged under an empty name; catching it here is what names the plugin.
    try {
      commandCtx.commands.register({
        name: COMMAND_NAME,
        description: "Check npm now for newer versions of the installed dsh plugins",
        handler: async ({ agent, signal }) => {
          // Typing the command is activity: the invoking session is the right
          // target for a held offer too, not just for this bubble.
          noteActiveSession(agent?.session?.id);
          return describe(await runCheck({ force: true, agent, signal }));
        },
      });
    } catch (err) {
      log.warn?.(`dsh-update-notifier: could not register /${COMMAND_NAME}`, err);
    }
  });

  // ---- schedule ----

  const firstTimer = setTimeout(runCheck, initialDelay);
  const everyTimer = setInterval(runCheck, interval);
  firstTimer.unref?.(); // never keep the dsh process alive just for a version check
  everyTimer.unref?.();

  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(firstTimer);
    clearInterval(everyTimer);
    if (flushTimer) clearTimeout(flushTimer);
    try {
      askAbort?.abort(); // settle an outstanding bubble instead of dangling it
    } catch {}
    offEvent?.();
    offDisposed?.();
  }, "dsh-update-notifier: timers + listeners + outstanding question");

  log.info?.(
    `dsh-update-notifier: checking ${registry} every ${Math.round(interval / 60_000)} min (profile: ${profileDir})`
  );
}

/** Strict-enough semver: returns true when a > b. Unparseable versions compare
 *  as "not greater" — an odd registry tag must never trigger an upgrade prompt. */
function semverGt(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i];
  }
  // Equal core: a release outranks any prerelease; two prereleases compare
  // identifier-by-identifier (numeric < alphanumeric, per semver spec).
  if (!pa.pre.length && pb.pre.length) return true;
  if (pa.pre.length && !pb.pre.length) return false;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return false; // shorter prerelease is smaller
    if (y === undefined) return true;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y);
    if (xn !== yn) return !xn; // numeric identifiers sort below alphanumeric
    return x > y;
  }
  return false;
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Profile-dir resolution — identical semantics to dsh-hot-reload: an explicit
 *  config.profileDir always wins; auto-detection from the loader base URL
 *  applies only when config is absent. */
function resolveProfileDir(ctx, config) {
  if (config.profileDir) return config.profileDir;
  try {
    if (ctx.baseUrl) return fileURLToPath(new URL(".", ctx.baseUrl)).replace(/\/$/, "");
  } catch {}
  return null;
}
