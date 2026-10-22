import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

interface Settings {
  enabled: boolean;
  providers: string[];
}

const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(path: string, options: {
    realpath: boolean;
    retries: { retries: number; minTimeout: number; maxTimeout: number; factor: number };
  }): Promise<() => Promise<void>>;
};

function settingsDirectory(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (!override) return join(homedir(), ".pi", "agent");
  // Match Pi's getAgentDir path expansion without loading the SDK at runtime
  // from an extension (the supported root export initializes the host).
  if (override === "~") return homedir();
  if (override.startsWith("~/") || (process.platform === "win32" && override.startsWith("~\\"))) {
    return join(homedir(), override.slice(2));
  }
  return override.startsWith("file://") ? fileURLToPath(override) : override;
}

function loadSettings(path: string): Settings {
  let saved: Partial<Settings>;
  try {
    saved = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false, providers: [] };
    throw error;
  }
  return {
    enabled: saved.enabled === true,
    providers: Array.isArray(saved.providers)
      ? [...new Set(saved.providers.filter((id) => typeof id === "string"))] : [],
  };
}

async function updateSettings(agentDir: string, change: (settings: Settings) => void) {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  // Canonicalize the directory so symlink aliases share the same lock, including
  // the first write, when the settings file does not exist yet.
  const path = join(realpathSync(agentDir), "cachewise-compact.json");
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 8, minTimeout: 25, maxTimeout: 100, factor: 1.3 },
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let committed: { settings: Settings; releaseFailed: boolean } | undefined;
  try {
    const next = loadSettings(path);
    change(next);
    // Keep the protected transaction synchronous: no heartbeat or other command
    // can run between reading fresh settings and replacing the complete file.
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    committed = { settings: next, releaseFailed: false };
  } finally {
    try { if (!committed) rmSync(temporary, { force: true }); }
    finally {
      try { await release(); }
      catch (error) {
        if (!committed) throw error;
        // Replacement is the commit point. Do not claim the save failed or
        // roll it back: that could erase a later process's successful update.
        committed.releaseFailed = true;
      }
    }
  }
  return committed;
}

export interface ControlOptions {
  /** Return a reason when another extension may own summary generation or retention. */
  nativeConflict: (ctx: ExtensionContext) => string | undefined;
  estimateContext: (ctx: ExtensionContext) => number;
}

interface CandidateResult {
  outcome: "optimized" | "fallback" | "cancelled";
  usage?: Usage;
  reason?: string;
}

interface ReportedUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface OperationMetadata {
  version: 1;
  outcome: "optimized" | "native" | "native-requested" | "native-fallback" | "other-extension" | "failed" | "cancelled" | "no-op";
  trigger: SessionBeforeCompactEvent["reason"];
  nativeRequested: boolean;
  durationMs: number | null;
  summaryUsage: ReportedUsage | null;
  discardedAttemptUsage: ReportedUsage | null;
  contextTokensBefore: number | null;
  contextTokensAfter: number | null;
  reason?: string;
}

interface Operation {
  sessionId: string;
  signal: AbortSignal;
  started: number;
  before: number;
  nativeRequested: boolean;
  candidate?: CandidateResult;
}

interface NativeInvocation {
  active: boolean;
  started: number;
  sessionId: string;
  leafId: string | null;
  focus: string;
  operation?: Operation;
}

const metadataType = "cachewise-compact-operation";

function reportedUsage(usage: Usage | undefined): ReportedUsage | null {
  if (!usage) return null;
  // Pi normalizes missing counters to zero. Zero alone is not evidence that the
  // provider measured usage or caching, including on an interrupted stream.
  const measured = (value: number) => Number.isFinite(value) && value > 0 ? value : null;
  return { input: measured(usage.input), output: measured(usage.output),
    cacheRead: measured(usage.cacheRead), cacheWrite: measured(usage.cacheWrite) };
}

function lastStatus(ctx: ExtensionContext): string {
  const entry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === metadataType);
  const last = entry?.type === "custom" ? entry.data as OperationMetadata | undefined : undefined;
  if (last?.version !== 1) return "Last: none";
  const value = (number: number | null | undefined) => number ?? "unknown";
  return `Last: ${last.outcome}${last.nativeRequested ? " (explicit native request)" : ""}\nTrigger: ${last.trigger}` +
    `\nDuration: ${value(last.durationMs)} ms\nSummary usage: input ${value(last.summaryUsage?.input)}, output ${value(last.summaryUsage?.output)}` +
    `\nCache: read ${value(last.summaryUsage?.cacheRead)}, write ${value(last.summaryUsage?.cacheWrite)}` +
    `\nContext tokens (estimated): ${value(last.contextTokensBefore)} before, ${value(last.contextTokensAfter)} after` +
    (last.discardedAttemptUsage ? `\nDiscarded attempt usage (separate from Pi totals): input ${value(last.discardedAttemptUsage.input)}, output ${value(last.discardedAttemptUsage.output)}` : "") +
    (last.reason ? `\nReason: ${last.reason}` : "");
}

const help = `Use these commands in the terminal, or send them as the message of an RPC prompt command.
/cachewise-compact provider add [id] — select an exact existing ID; omitted ID means the current provider now.
/cachewise-compact on — enable for selected providers only.
/cachewise-compact off — disable without clearing selections.
/cachewise-compact providers — list available, selected, current, and unavailable saved IDs.
/cachewise-compact provider remove [id] — remove a selection, including an unavailable saved ID.
/cachewise-compact status — show settings and the last session operation.
/cachewise-compact help — show this help.
/compact [focus] — ordinary Pi compaction, optimized when eligible.
/compact-native [focus] — request built-in compaction once, without changing settings.
Start with provider add, then on. Empty selections mean inactive. Command acceptance is not completion.`;

export function registerControls(pi: ExtensionAPI, options: ControlOptions) {
  const nativeInvocation = new AsyncLocalStorage<NativeInvocation>();
  let nativePending = false;
  let active: Operation | undefined;
  const agentDir = settingsDirectory();
  const settingsPath = join(agentDir, "cachewise-compact.json");
  let settings = loadSettings(settingsPath);

  const selected = () => settings.providers.join(", ") || "none";
  const save = async (change: (settings: Settings) => void, ctx: ExtensionContext) => {
    try {
      const result = await updateSettings(agentDir, change);
      settings = result.settings;
      if (result.releaseFailed) {
        ctx.ui.notify("Cache compaction settings were saved, but the settings lock could not be released. Other processes may need to retry shortly.", "error");
        return false;
      }
      return true;
    } catch {
      ctx.ui.notify("Could not save cache compaction settings. Check directory permissions or retry if another process is updating them.", "error");
      return false;
    }
  };

  pi.registerCommand("cachewise-compact", {
    description: "Configure cache-preserving compaction",
    handler: async (args, ctx) => {
      const [command, action, id] = args.trim().split(/\s+/);
      if (command === "status") {
        const availability = !settings.enabled ? "off" : !settings.providers.length ? "inactive: no providers selected"
          : !ctx.model || !settings.providers.includes(ctx.model.provider) ? "inactive: current provider not selected"
          : options.nativeConflict(ctx) ?? "eligible when request compatibility is established";
        ctx.ui.notify(`Cache compaction: ${settings.enabled ? "on" : "off"}\nSelected: ${selected()}\nCurrent: ${ctx.model?.provider ?? "none"}\nAvailability: ${availability}\n${lastStatus(ctx)}\nPi 1.0.2: built-in failure/cancellation outcomes may be unavailable; see Pi’s operation error.`, "info");
      } else if (command === "providers") {
        const available = new Set(ctx.modelRegistry.getAll().map((model) => model.provider));
        const ids = new Set([...available, ...settings.providers, ...(ctx.model ? [ctx.model.provider] : [])]);
        const lines = [...ids].sort().map((id) => `${id}: ${available.has(id) ? "available" : "unavailable"}` +
          `${settings.providers.includes(id) ? ", selected" : ", unselected"}${ctx.model?.provider === id ? ", current" : ""}`);
        ctx.ui.notify(lines.join("\n") || "No providers available or selected.", "info");
      } else if (command === "on" || command === "off") {
        if (!await save((next) => { next.enabled = command === "on"; }, ctx)) return;
        ctx.ui.notify(!settings.enabled ? "Cache-preserving compaction off. Selections unchanged."
          : settings.providers.length ? "Cache-preserving compaction enabled." : "Enabled but inactive: select a provider first.", "info");
      } else if (command === "provider" && (action === "add" || action === "remove")) {
        const provider = id || ctx.model?.provider;
        if (!provider) {
          ctx.ui.notify("No current provider. Supply an explicit provider ID.", "error");
          return;
        }
        if (action === "add" && !ctx.modelRegistry.getAll().some((model) => model.provider === provider)) {
          ctx.ui.notify("Choose an existing Pi provider ID (exact, case-sensitive).", "error");
          return;
        }
        if (!await save((next) => {
          if (action === "remove") next.providers = next.providers.filter((id) => id !== provider);
          else if (!next.providers.includes(provider)) next.providers.push(provider);
        }, ctx)) return;
        ctx.ui.notify(`Selected: ${selected()}`, "info");
      } else {
        ctx.ui.notify(help, !command || command === "help" ? "info" : "error");
      }
    },
  });

  pi.on("session_compact", (event, ctx) => {
    const operation = active;
    active = undefined;
    if (operation && operation.sessionId !== ctx.sessionManager.getSessionId()) return;
    // Pi 1.0.2 can report an older entry when summary texts match. Read the
    // actual commit from the current branch rather than matching summary text.
    const entry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction") ?? event.compactionEntry;
    const optimized = event.fromExtension && operation?.candidate?.outcome === "optimized" &&
      (entry.details as { cachewiseCompact?: unknown } | undefined)?.cachewiseCompact === 1;
    const outcome = event.fromExtension ? optimized ? "optimized" : "other-extension"
      : operation?.nativeRequested ? "native-requested"
      : operation?.candidate?.outcome === "fallback" ? "native-fallback" : "native";
    const metadata: OperationMetadata = {
      version: 1, outcome, trigger: event.reason, nativeRequested: operation?.nativeRequested ?? false,
      durationMs: operation ? Math.max(0, Math.round(performance.now() - operation.started)) : null,
      summaryUsage: reportedUsage(entry.usage),
      discardedAttemptUsage: optimized ? null : reportedUsage(operation?.candidate?.usage),
      contextTokensBefore: entry.tokensBefore,
      contextTokensAfter: options.estimateContext(ctx),
      ...(operation?.candidate?.reason ? { reason: operation.candidate.reason } : {}),
    };
    pi.appendEntry(metadataType, metadata);
  });

  // Do not subscribe to session_compact_failed on Pi 1.0.2: awaiting that
  // hook exposes a host controller-cleanup race during overlapping compactions.

  pi.registerCommand("compact-native", {
    description: "Use Pi's built-in summarizer once without changing cache-compaction settings",
    handler: async (args, ctx) => {
      if (ctx.isIdle()) active = undefined;
      if (nativePending || active || !ctx.isIdle()) {
        ctx.ui.notify("Busy: wait for the current operation before requesting native compaction.", "warning");
        return;
      }
      nativePending = true;
      const invocation: NativeInvocation = {
        active: true, started: performance.now(), sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId(), focus: args,
      };
      try {
        // Pi 1.0.2 starts compact() in this call's async chain. A scoped marker
        // reaches its hook without arming a flag that another invocation could consume.
        await new Promise<void>((resolve) => nativeInvocation.run(invocation, () => {
          ctx.compact({
            customInstructions: args,
            onComplete: () => {
              const entry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
              ctx.ui.notify(entry?.fromHook ? "Another extension supplied this summary; it was not native compaction."
                : "Native compaction completed.", entry?.fromHook ? "warning" : "info");
              resolve();
            },
            onError: (error) => {
              const operation = invocation.operation;
              const noOp = /Nothing to compact|Already compacted/.test(error.message);
              const aborted = operation?.signal.aborted === true;
              if (ctx.sessionManager.getSessionId() === invocation.sessionId) {
                const metadata: OperationMetadata = {
                  version: 1, outcome: aborted ? "cancelled" : noOp ? "no-op" : "failed",
                  trigger: "manual", nativeRequested: true,
                  durationMs: Math.max(0, Math.round(performance.now() - invocation.started)),
                  summaryUsage: null, discardedAttemptUsage: reportedUsage(operation?.candidate?.usage),
                  contextTokensBefore: operation?.before ?? null, contextTokensAfter: null,
                  reason: aborted ? "Compaction was cancelled." : noOp ? "Pi found no eligible material to compact."
                    : "Native compaction failed. See Pi's operation error.",
                };
                pi.appendEntry(metadataType, metadata);
              }
              if (active === operation) active = undefined;
              ctx.ui.notify("Native compaction did not complete. See /cachewise-compact status and Pi's operation error.", "warning");
              resolve();
            },
          });
        }));
      } finally {
        invocation.active = false;
        nativePending = false;
      }
    },
  });

  return {
    enabledFor: (provider: string | undefined) => settings.enabled && provider !== undefined && settings.providers.includes(provider),
    isNativeBypass: () => active?.nativeRequested === true && !active.signal.aborted &&
      nativeInvocation.getStore()?.operation === active,
    begin: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
      const invocation = nativeInvocation.getStore();
      const nativeRequested = invocation?.active === true && !event.signal.aborted && event.reason === "manual" &&
        invocation.sessionId === ctx.sessionManager.getSessionId() && invocation.leafId === ctx.sessionManager.getLeafId() &&
        invocation.focus === event.customInstructions;
      // Descendant callbacks retain this async scope. Consume it before another
      // compaction can start, and never reuse a stale session/source marker.
      if (invocation) invocation.active = false;
      const operation: Operation = {
        sessionId: ctx.sessionManager.getSessionId(), signal: event.signal, started: performance.now(),
        before: event.preparation.tokensBefore, nativeRequested,
      };
      if (nativeRequested) invocation!.operation = operation;
      active = operation;
      return { finish: (result: CandidateResult) => { operation.candidate = result; } };
    },
  };
}
