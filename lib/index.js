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

  async function latestVersion(pkg) {
    // Scoped names keep the leading @ but encode the slash — the form every
    // npm-compatible registry accepts for dist-tag endpoints.
    const url = `${registry}/${pkg.replace("/", "%2F")}/latest`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), fetchTimeout);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
      if (!res.ok) return null; // unpublished/private/404 — silently not our business
      const version = (await res.json())?.version;
      // Validate before it can ever reach the bubble or a followup message.
      return typeof version === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? version : null;
    } catch {
      return null; // offline / registry down — retry next cycle, never crash dsh
    } finally {
      clearTimeout(timer);
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

  const offEvent = ctx.on("session/event", (session, event) => {
    try {
      if (event?.type === "user/message" && event.data?.source?.kind === "user") {
        lastActiveSessionId = session?.id ?? null;
        if (pendingOutdated && !asking && !flushTimer) {
          // Retry AFTER the current event dispatch settles, not from inside it.
          flushTimer = setTimeout(() => {
            flushTimer = null;
            const outdated = pendingOutdated;
            pendingOutdated = null;
            if (outdated) void askUpgrade(outdated);
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

  async function askUpgrade(outdated) {
    if (disposed || asking || !outdated.length) return;
    const userQuestions = ctx.get("userQuestions");
    const agent = liveAgent();
    if (!userQuestions || typeof userQuestions.ask !== "function" || !agent) {
      pendingOutdated = outdated; // hold; retried on next user message / cycle
      if (!userQuestions) {
        log.info?.(
          `dsh-update-notifier: updates available (${outdated.map(labelFor).join(", ")}) — ` +
            "no userQuestions provider in this composition; upgrade manually with " +
            `pnpm --dir ${profileDir} add ${outdated.map((o) => `${o.pkg}@${o.latest}`).join(" ")}`
        );
      }
      return;
    }

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
    const command = `pnpm --dir ${profileDir} add ${approved.map((o) => `${o.pkg}@${o.latest}`).join(" ")}`;
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

  // ---- hourly check ----

  const announced = Object.create(null); // pkg -> latest already answered this run
  let checking = false;
  let disposed = false;

  async function runCheck() {
    if (checking || asking || disposed) return;
    checking = true;
    try {
      pendingOutdated = null; // recomputed from scratch below — no double-offers
      const installed = installedPlugins();
      if (!installed) return;
      const outdated = [];
      for (const [pkg, current] of Object.entries(installed)) {
        if (disposed) return;
        const latest = await latestVersion(pkg);
        if (!latest || !semverGt(latest, current)) continue; // never suggest a downgrade
        if (announced[pkg] === latest || declines[pkg] === latest) continue; // already answered
        outdated.push({ pkg, current, latest });
      }
      if (!outdated.length || disposed) return;
      log.info?.(`dsh-update-notifier: updates available — ${outdated.map((o) => `${o.pkg}@${o.latest}`).join(", ")}`);
      await askUpgrade(outdated);
    } catch (err) {
      log.warn?.("dsh-update-notifier: check failed", err);
    } finally {
      checking = false;
    }
  }

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
