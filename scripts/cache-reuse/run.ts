import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type * as Pi from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  capturePayload,
  checkPayload,
} from "../../extensions/cachewise-compact/fidelity.ts";
import { checkBudget, referenceTokens } from "./fixtures.ts";
import { PrivateCapture } from "./privacy.ts";
import { candidateIdentity } from "./identity.ts";
import { recordUsage, type UsageMeasurement } from "./usage.ts";
import { repo, requireCheck, CheckError, type Config } from "./config.ts";

export interface Fixture {
  id: string;
  version: number;
  description: string;
  tokenizer: string;
  referenceTokens: number;
  messages: Array<Record<string, unknown>>;
  facts: Array<{
    sourceMessage: number;
    question: string;
    mustInclude: string[];
  }>;
}
type Step = "foreground" | "summary" | "continuation";
interface Measurement extends UsageMeasurement {
  step: Step;
  durationMs: number;
  sent: boolean;
  responseModel?: string;
}
const SYSTEM =
  "You are assisting with the fictional software project in this conversation. Preserve its decisions and unfinished work. Use only the supplied history. Do not call tools. Keep replies concise.";
const FOREGROUND =
  "Pause implementation. Keep the project decisions in context. Reply only: Recorded.";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textOf = (message: AssistantMessage) =>
  message.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

/** Runs inside the CLI's disposable, quiet worker. Never import this from the extension. */
export async function runCheck(
  config: Config,
  fixture: Fixture,
  workspace: string,
) {
  const started = performance.now();
  const capture = new PrivateCapture(config.diagnostics);
  await capture.credentials(config.authPath);
  await capture.credentials(config.modelsPath);
  const directory = await mkdtemp(join(config.outputDir, "cache-check-"));
  const originalCwd = process.cwd(),
    originalFetch = globalThis.fetch;
  const agentDir = join(workspace, "agent"),
    cwd = join(workspace, "project"),
    sessions = join(workspace, "sessions");
  const diagnosticsErrors: unknown[] = [];
  const measurements: Measurement[] = [],
    payloads: unknown[] = [],
    answers: AssistantMessage[] = [];
  let outcome = "unverified",
    reason = "incomplete-run",
    session: Pi.AgentSession | undefined;
  let step: Step = "foreground",
    preparation: Pi.SessionBeforeCompactEvent["preparation"] | undefined;
  let errors = 0,
    tools = 0,
    boundary: string | undefined,
    oldBranch: ReturnType<Pi.SessionManager["getBranch"]> = [];
  let foregroundFinished = 0;
  let facts = fixture.facts;
  let expectedRetained: unknown[] = [];
  let expectedDiscarded: unknown[] = [];
  const checks: Record<string, boolean> = {};
  const observations: Record<string, boolean | number | null> = {};
  const report: Record<string, unknown> = {
    date: new Date().toISOString(),
    node: process.version,
    fixture: {
      id: fixture.id,
      version: fixture.version,
      referenceTokens: fixture.referenceTokens,
      tokenizer: fixture.tokenizer,
      sha256: hash(fixture.messages),
    },
    configuration: {
      provider: config.provider,
      model: config.model,
      thinking: config.thinking,
      contextTokens: config.contextTokens,
      reserveTokens: config.reserveTokens,
      keepRecentTokens: config.keepRecentTokens,
      maxOutputTokens: config.maxOutputTokens,
      cache: config.cache,
      cacheRetention: config.cacheRetention ?? "short",
      extensions: config.extensions,
      sdkDir: config.sdkDir ?? "development dependency",
      modelsPath: config.modelsPath,
      credentialSource: config.authPath ?? "Pi environment resolution",
      candidate:
        config.extensionPath ??
        join(repo, "extensions/cachewise-compact/index.ts"),
    },
    checks,
    observations,
    requests: measurements,
    limitations: [
      "Reference token counts are estimates for other tokenizers.",
      "Fixture term matches are informational only; they do not establish accuracy or summary quality.",
      "A pass applies only to this configuration and candidate.",
    ],
  };
  const stop = () => {
    reason = "cancelled";
    session?.abortCompaction();
    if (session) void session.abort().catch(() => {});
  };
  const timer = setTimeout(stop, config.timeoutSeconds * 1000);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    checkBudget(config, fixture);
    try {
      const git = promisify(execFile);
      const revision = await git("git", ["rev-parse", "HEAD"], { cwd: repo });
      const state = await git("git", ["status", "--porcelain"], { cwd: repo });
      report.checkout = {
        revision: revision.stdout.trim(),
        dirty: Boolean(state.stdout.trim()),
      };
    } catch {
      report.checkout = { revision: null, dirty: null };
    }
    report.packageVersion = JSON.parse(
      await readFile(join(repo, "package.json"), "utf8"),
    ).version;
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    process.chdir(cwd);
    Object.assign(process.env, {
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    });
    // Resource loading must not refresh catalogs or make hidden warm-up requests.
    globalThis.fetch = async () => {
      throw new CheckError("unexpected-network-request");
    };
    const sdk: typeof Pi = await import(
      config.sdkDir
        ? pathToFileURL(join(config.sdkDir, "dist/index.js")).href
        : "@earendil-works/pi-coding-agent"
    );
    const sdkPackage = config.sdkDir
      ? join(config.sdkDir, "package.json")
      : fileURLToPath(
          new URL(
            "../package.json",
            import.meta.resolve("@earendil-works/pi-coding-agent"),
          ),
        );
    report.pi = JSON.parse(await readFile(sdkPackage, "utf8")).version;
    const candidate =
      config.extensionPath ??
      join(repo, "extensions/cachewise-compact/index.ts");
    report.candidate = await candidateIdentity(candidate);
    const runtime = await sdk.ModelRuntime.create({
      authPath: config.authPath ?? join(agentDir, "auth.json"),
      modelsPath: config.modelsPath ?? join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const settings = sdk.SettingsManager.create(cwd, agentDir);
    const settingsOverrides: Parameters<typeof settings.applyOverrides>[0] = {
      compaction: {
        enabled: false,
        reserveTokens: config.reserveTokens,
        keepRecentTokens: config.keepRecentTokens,
      },
      retry: {
        enabled: false,
        provider: { maxRetries: 0, timeoutMs: config.timeoutSeconds * 1000 },
      },
      cacheWarming: "off",
      enableAnalytics: false,
      enableInstallTelemetry: false,
      packages: [],
      extensions: [],
      defaultTools: [],
    };
    settings.applyOverrides(settingsOverrides);
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime: runtime,
      settingsManager: settings,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: SYSTEM,
        additionalExtensionPaths: [...config.extensions, candidate],
        extensionFactories: [
          {
            name: "cache-check-observer",
            factory(pi) {
              pi.on("tool_call", () => {
                tools++;
                return { block: true, reason: "No tools during verification." };
              });
              pi.on("session_before_compact", (event) => {
                preparation = event.preparation;
                boundary = preparation.firstKeptEntryId;
                const projection = manager.buildSessionProjection();
                const index = projection.entries.findIndex(
                  (e) => e.sourceEntry.id === boundary,
                );
                requireCheck(index > 0, "invalid-boundary");
                // This prefix includes the discarded part of a split turn.
                // Snapshot it before candidate hooks can change preparation.
                expectedDiscarded = structuredClone(
                  sdk
                    .convertToLlm(
                      projection.entries
                        .slice(0, index)
                        .flatMap((e) => e.messages),
                    )
                    .filter((message) => message.role !== "system"),
                );
                expectedRetained = sdk.convertToLlm(
                  projection.entries.slice(index).flatMap((e) => e.messages),
                );
              });
            },
          },
        ],
        extensionsOverride: (base) => ({
          ...base,
          extensions: [
            ...base.extensions.filter(
              (e) => e.path === "<inline:cache-check-observer>",
            ),
            ...base.extensions.filter(
              (e) => e.path !== "<inline:cache-check-observer>",
            ),
          ],
        }),
      },
    });
    settings.applyOverrides(settingsOverrides);
    requireCheck(
      !services.resourceLoader.getExtensions().errors.length,
      "missing-prerequisite",
    );
    const model = runtime.getModel(config.provider, config.model);
    requireCheck(
      model && ["openai-completions", "anthropic-messages"].includes(model.api),
      "missing-prerequisite",
    );
    requireCheck(
      config.contextTokens <= model.contextWindow &&
        config.maxOutputTokens <= model.maxTokens,
      "insufficient-headroom",
    );
    capture.url(model.baseUrl);
    report.protocol = model.api;
    report.modelContextTokens = model.contextWindow;
    // Existing Pi credentials may refresh through their normal resolver during this explicit live run.
    globalThis.fetch = originalFetch;
    capture.collect(await runtime.getAuth(model));
    globalThis.fetch = async () => {
      throw new CheckError("unexpected-network-request");
    };
    const stream = runtime.streamSimple.bind(runtime);
    const responses: Promise<void>[] = [];
    runtime.streamSimple = (requestModel, context, options = {}) => {
      requireCheck(
        requestModel.provider === model.provider &&
          requestModel.id === model.id &&
          requestModel.api === model.api,
        "model-changed",
      );
      requireCheck(reason !== "cancelled", "cancelled");
      requireCheck(
        measurements.length < 3 &&
          ["foreground", "summary", "continuation"][measurements.length] ===
            step,
        "extra-inference-blocked",
      );
      const measurement: Measurement = { step, durationMs: 0, sent: false };
      measurements.push(measurement);
      const start = performance.now();
      const upstream = stream(requestModel, context, {
        ...options,
        maxRetries: 0,
        cacheRetention: config.cacheRetention ?? "short",
        ...(step === "summary" ? {} : { maxTokens: config.maxOutputTokens }),
        fetch: globalThis.fetch,
        onPayload: async (payload, requestModel) => {
          // Keep the adapter's serialized history before candidate payload hooks.
          // capturePayload ignores protocol cache markers but preserves content.
          const adapterHistory =
            step === "summary"
              ? capturePayload(payload)?.messages.filter(
                  (message) =>
                    message.role !== "system" && message.role !== "developer",
                )
              : undefined;
          const replacement = await options.onPayload?.(payload, requestModel);
          const effective = replacement === undefined ? payload : replacement;
          const wire = effective as {
            messages: Array<{ role: string }>;
            system?: unknown;
            tools?: unknown;
            max_tokens?: number;
            max_completion_tokens?: number;
          };
          const outputCap = wire.max_tokens ?? wire.max_completion_tokens;
          requireCheck(
            typeof outputCap === "number" && outputCap > 0,
            "insufficient-headroom",
          );
          const estimate =
            Math.ceil(referenceTokens(effective) * 1.2) + outputCap + 8192;
          requireCheck(
            estimate < config.contextTokens,
            "insufficient-headroom",
          );
          if (step === "foreground") {
            const shared = JSON.stringify({
              system: wire.system,
              tools: wire.tools,
              messages: wire.messages.filter(
                (m) => m.role === "system" || m.role === "developer",
              ),
            });
            const byteBound = Buffer.byteLength(shared, "utf8") + 4096;
            report.sharedPrefixByteScreen = byteBound;
            requireCheck(
              config.cache.sharedPrefixUpperBoundTokens >= byteBound,
              "shared-prefix-bound-too-small",
            );
          }
          if (step === "summary") {
            requireCheck(preparation && boundary, "missing-preparation");
            checks.serializedDiscardedHistory =
              adapterHistory !== undefined &&
              isDeepStrictEqual(
                adapterHistory,
                capturePayload(effective)?.messages.filter(
                  (message) =>
                    message.role !== "system" && message.role !== "developer",
                ),
              );
            requireCheck(
              checks.serializedDiscardedHistory,
              "serialized-history-changed",
            );
            checks.discardedHistory = isDeepStrictEqual(
              context.messages
                .slice(0, -1)
                .filter((message) => message.role !== "system"),
              expectedDiscarded,
            );
            requireCheck(checks.discardedHistory, "discarded-history-changed");
            const last = context.messages.at(-1);
            const instruction =
              last?.role === "user"
                ? typeof last.content === "string"
                  ? last.content
                  : last.content
                      .filter((p) => p.type === "text")
                      .map((p) => p.text)
                      .join("\n")
                : "";
            checkPayload(capturePayload(payloads[0]), effective, instruction);
            checks.prefixFidelity = true;
          }
          if (step === "continuation") {
            checks.retainedContext = isDeepStrictEqual(
              context.messages.slice(-(expectedRetained.length + 1), -1),
              expectedRetained,
            );
            requireCheck(checks.retainedContext, "retained-context-changed");
          }
          payloads.push(structuredClone(effective));
          return effective;
        },
        onProviderStreamEvent: async (data, requestModel) => {
          await options.onProviderStreamEvent?.(data, requestModel);
          recordUsage(measurement, data, model.api);
        },
      });
      responses.push(
        upstream.result().then((answer) => {
          measurement.responseModel = answer.responseModel;
          answers.push(answer);
          measurement.durationMs = performance.now() - start;
          if (
            model.api === "anthropic-messages" &&
            measurement.input !== undefined
          )
            measurement.input +=
              (measurement.cacheRead ?? 0) + (measurement.cacheWrite ?? 0);
        }),
      );
      return upstream;
    };
    // Match actual HTTP bodies to the payload inspected above, and prevent retries/extra calls.
    globalThis.fetch = async (input, init) => {
      const current = measurements.at(-1),
        payload = payloads.at(-1);
      requireCheck(
        current && payload && !current.sent,
        "unexpected-network-request",
      );
      const request = new Request(input, { ...init, redirect: "error" });
      capture.headers(request.headers);
      capture.url(request.url);
      requireCheck(
        request.method === "POST" &&
          new URL(request.url).origin === new URL(model.baseUrl).origin,
        "unexpected-network-request",
      );
      requireCheck(
        isDeepStrictEqual(
          JSON.parse(await request.clone().text()),
          JSON.parse(JSON.stringify(payload)),
        ),
        "transport-payload-mismatch",
      );
      if (current.step === "summary") {
        report.foregroundToSummaryMs = performance.now() - foregroundFinished;
        requireCheck(
          Number(report.foregroundToSummaryMs) <
            config.cache.retentionSeconds * 1000,
          "cache-retention-exceeded",
        );
      }
      current.sent = true;
      return originalFetch(request);
    };
    const manager = sdk.SessionManager.create(cwd, sessions);
    const created = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: config.thinking,
      tools: [],
      resourceLoader: services.resourceLoader,
      settingsManager: settings,
      sessionManager: manager,
    });
    session = created.session;
    requireCheck(
      !created.modelFallbackMessage &&
        session.thinkingLevel === config.thinking,
      "missing-prerequisite",
    );
    await session.bindExtensions({
      mode: "rpc",
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: () => {},
      },
      onError: (error) => {
        errors++;
        if (config.diagnostics)
          diagnosticsErrors.push({ event: error.event, message: error.error });
      },
    });
    // Seed the public prompt state before A, using the selected SDK's own builder.
    const promptModule = new URL(
      "./core/system-prompt.js",
      config.sdkDir
        ? pathToFileURL(join(config.sdkDir, "dist/index.js")).href
        : import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const { buildSystemPromptState } = await import(promptModule.href);
    manager.appendMessage({
      role: "system",
      ...buildSystemPromptState({
        customPrompt: SYSTEM,
        cwd,
        selectedTools: [],
      }),
      timestamp: 0,
    });
    const ids: string[] = [];
    fixture.messages.forEach((message, index) => {
      const m: Record<string, unknown> = {
        ...structuredClone(message),
        timestamp: index + 1,
      };
      if (m.role === "assistant")
        Object.assign(m, {
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        });
      ids.push(
        manager.appendMessage(m as Parameters<typeof manager.appendMessage>[0]),
      );
    });
    session.refreshContext();
    await session.prompt("/cachewise-compact provider add");
    await session.prompt("/cachewise-compact on");
    await session.prompt(FOREGROUND, { expandPromptTemplates: false });
    await session.waitForIdle();
    requireCheck(
      answers[0]?.stopReason === "stop" && !tools && !errors,
      "foreground-failed",
    );
    requireCheck(
      measurements[0].input !== undefined &&
        measurements[0].input + config.reserveTokens + 8192 <
          config.contextTokens,
      "insufficient-headroom",
    );
    foregroundFinished = performance.now();
    oldBranch = structuredClone(manager.getBranch());
    step = "summary";
    requireCheck(
      performance.now() - foregroundFinished <
        config.cache.retentionSeconds * 1000,
      "cache-retention-exceeded",
    );
    await session.compact();
    await Promise.all(responses);
    const compact = manager
      .getBranch()
      .findLast((e) => e.type === "compaction");
    requireCheck(
      compact?.type === "compaction" &&
        (compact.details as { cachewiseCompact?: number })?.cachewiseCompact ===
          1,
      "optimized-compaction-not-committed",
    );
    requireCheck(compact.firstKeptEntryId === boundary, "invalid-boundary");
    checks.optimizedCompaction = true;
    const beforeBoundary = oldBranch.findIndex((e) => e.id === boundary);
    requireCheck(beforeBoundary > 0, "invalid-boundary");
    const oldTail = oldBranch.slice(beforeBoundary);
    const newBranch = manager.getBranch();
    checks.retainedHistory = oldTail.every((entry) =>
      isDeepStrictEqual(
        entry,
        newBranch.find((e) => e.id === entry.id),
      ),
    );
    requireCheck(checks.retainedHistory, "retained-history-changed");
    report.boundary = {
      discardedEntries: beforeBoundary,
      retainedEntries: oldTail.length,
      isSplitTurn: preparation?.isSplitTurn ?? false,
    };
    facts = fixture.facts.filter((f) =>
      oldBranch
        .slice(0, beforeBoundary)
        .some((e) => e.id === ids[f.sourceMessage]),
    );
    observations.discardedFactCount = facts.length;
    observations.summaryTermsPresent = facts.length === 0
      ? null
      : facts.every((f) =>
          f.mustInclude.every((term) =>
            compact.summary.toLowerCase().includes(term.toLowerCase()),
          ),
        );
    step = "continuation";
    await session.prompt(
      facts.length > 0
        ? `Answer these project questions from context, without tools:\n${facts.map((f) => f.question).join("\n")}`
        : "Briefly acknowledge the project context, without tools.",
      { expandPromptTemplates: false },
    );
    await session.waitForIdle();
    await Promise.all(responses);
    requireCheck(
      answers[2]?.stopReason === "stop" && !tools && !errors,
      "continuation-failed",
    );
    checks.continuationCompleted = true;
    observations.continuationTermsPresent = facts.length === 0
      ? null
      : facts.every((f) =>
          f.mustInclude.every((term) =>
            textOf(answers[2]).toLowerCase().includes(term.toLowerCase()),
          ),
        );
    const summary = measurements[1];
    checks.observedTransport =
      measurements.length === 3 && measurements.every((m) => m.sent);
    if (!checks.observedTransport) {
      outcome = "unverified";
      reason = "unobserved-transport";
    } else if (
      summary.invalidCounters ||
      summary.cacheRead === undefined ||
      summary.input === undefined ||
      !Number.isSafeInteger(summary.cacheRead) ||
      summary.cacheRead < 0 ||
      summary.cacheRead > summary.input
    ) {
      outcome = "unverified";
      reason = "cache-counters-missing";
    } else {
      checks.historyCacheReuse =
        summary.input >= config.cache.minimumPrefixTokens &&
        summary.cacheRead >=
          config.cache.sharedPrefixUpperBoundTokens +
            config.cache.minimumHistoryCacheTokens;
      outcome = checks.historyCacheReuse ? "passed" : "failed";
      reason = checks.historyCacheReuse
        ? "meaningful-history-reuse"
        : "insufficient-history-reuse";
    }
  } catch (error) {
    if (config.diagnostics && error instanceof Error)
      diagnosticsErrors.push({
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
    reason =
      reason === "cancelled"
        ? reason
        : error instanceof CheckError
          ? error.message
          : "run-error";
    outcome =
      reason === "cancelled" || !measurements.some((m) => m.sent)
        ? "unverified"
        : "failed";
  } finally {
    clearTimeout(timer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    if (session) {
      session.abortCompaction();
      await session.abort().catch(() => {});
      try {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } catch {
        outcome = "unverified";
        reason = "shutdown-failed";
      } finally {
        session.dispose();
      }
    }
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    await rm(workspace, { recursive: true, force: true });
    Object.assign(report, {
      outcome,
      reason,
      durationMs: performance.now() - started,
    });
    try {
      await writeFile(
        join(directory, "result.json"),
        capture.serialize(report),
        { mode: 0o600, flag: "wx" },
      );
      if (config.diagnostics)
        await writeFile(
          join(directory, "diagnostics.json"),
          capture.serialize(
            capture.diagnosticsData(payloads, answers, diagnosticsErrors),
          ),
          { mode: 0o600, flag: "wx" },
        );
    } finally {
      capture.restore();
    }
  }
  return { outcome, directory };
}
