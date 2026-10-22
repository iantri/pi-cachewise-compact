import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  AgentSessionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionFactory,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

export interface WireRequest {
  model: string;
  messages: Array<{ role: string; content: unknown; [field: string]: unknown }>;
  system?: unknown;
  tools?: unknown[];
  max_tokens?: number;
  max_completion_tokens?: number;
  [field: string]: unknown;
}

export interface Reply {
  text?: string;
  tool?: { name: string; arguments: Record<string, unknown>; id?: string };
  stop?: "stop" | "length" | "incomplete" | "pause_turn";
  thinking?: string;
  beforeReply?: () => void | Promise<void>;
  onCancelled?: () => void;
  onCompleted?: () => void;
  usage?: { input: number; output: number };
}

/** Hold a fake provider response until the test releases it, observing the real transport. */
export function holdReply(content: Omit<Reply, "beforeReply" | "onCancelled" | "onCompleted">) {
  const barrier = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const started = barrier();
  const released = barrier();
  const cancelled = barrier();
  const completed = barrier();
  return {
    reply: { ...content, beforeReply: async () => { started.resolve(); await released.promise; },
      onCancelled: cancelled.resolve, onCompleted: completed.resolve } satisfies Reply,
    started: started.promise, cancelled: cancelled.promise, completed: completed.promise,
    release: () => released.resolve(),
  };
}

export interface HarnessOptions {
  api?: "openai-completions" | "anthropic-messages";
  replies?: Array<string | Reply>;
  reserveTokens?: number;
  keepRecentTokens?: number;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  settings?: Partial<ReturnType<ExtensionAPI["getSettings"]>>;
  extensionFactories?: ExtensionFactory[];
  configure?: boolean;
}

export async function createHarness(t: TestContext, options: HarnessOptions = {}) {
  const api = options.api ?? "openai-completions";
  const root = await mkdtemp(join(tmpdir(), "cachewise-integration-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const requests: WireRequest[] = [];
  const replies = options.replies ?? [];
  const extensionErrors: unknown[] = [];
  const notifications: Array<{ message: string; type: "info" | "warning" | "error" }> = [];
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, "http://localhost").pathname;
    assert.equal(pathname, api === "openai-completions" ? "/v1/chat/completions" : "/v1/messages");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()) as WireRequest);
    const planned = replies[requests.length - 1];
    assert.notEqual(planned, undefined, "Unexpected extra inference request");
    const reply: Reply = typeof planned === "string" ? { text: planned } : planned;
    res.on("close", () => { if (!res.writableFinished) reply.onCancelled?.(); });
    res.on("finish", () => reply.onCompleted?.());
    await reply.beforeReply?.();
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (api === "anthropic-messages") {
      const event = (type: string, data: Record<string, unknown>) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message: {
        id: `reply-${requests.length}`, type: "message", role: "assistant", model: "fixture-model",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: reply.usage?.input ?? 2000, output_tokens: 0 },
      } });
      let index = 0;
      if (reply.thinking !== undefined) {
        event("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
        event("content_block_delta", { index, delta: { type: "thinking_delta", thinking: reply.thinking } });
        event("content_block_stop", { index: index++ });
      }
      if (reply.text !== undefined || (!reply.tool && reply.thinking === undefined)) {
        event("content_block_start", { index, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index, delta: { type: "text_delta", text: reply.text ?? "" } });
        event("content_block_stop", { index: index++ });
      }
      if (reply.tool) {
        event("content_block_start", { index, content_block: {
          type: "tool_use", id: reply.tool.id ?? `call-${requests.length}`, name: reply.tool.name, input: {},
        } });
        event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.tool.arguments) } });
        event("content_block_stop", { index });
      }
      event("message_delta", {
        delta: { stop_reason: reply.tool ? "tool_use" : reply.stop === "length" ? "max_tokens" : reply.stop === "incomplete" ? null : reply.stop === "pause_turn" ? "pause_turn" : "end_turn", stop_sequence: null },
        usage: { output_tokens: reply.usage?.output ?? 20 },
      });
      event("message_stop", {});
      res.end();
      return;
    }
    const frame = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const delta = {
      role: "assistant", content: reply.text,
      reasoning_content: reply.thinking,
      ...(reply.tool ? { tool_calls: [{ index: 0, id: reply.tool.id ?? `call-${requests.length}`, type: "function",
        function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) } }] } : {}),
    };
    frame({ id: `reply-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: null }] });
    frame({ id: `reply-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : reply.stop === "incomplete" ? null : reply.stop ?? "stop" }],
      usage: { prompt_tokens: reply.usage?.input ?? 2000, completion_tokens: reply.usage?.output ?? 20,
        total_tokens: (reply.usage?.input ?? 2000) + (reply.usage?.output ?? 20) } });
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "user-chosen-provider": {
        api,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}${api === "openai-completions" ? "/v1" : ""}`,
        apiKey: "dummy-local-test-key",
        models: [{ id: "fixture-model", reasoning: options.reasoning ?? false, input: ["text", "image"],
          contextWindow: options.contextWindow ?? 32768, maxTokens: options.maxTokens ?? 4096 }],
      },
    },
  }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: options.keepRecentTokens ?? 100, reserveTokens: options.reserveTokens ?? 1024 },
    retry: { enabled: false },
    cacheWarming: "off",
    ...options.settings,
  }));
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-cache.json"), allowModelNetwork: false,
  });
  const model = modelRuntime.getModel("user-chosen-provider", "fixture-model");
  assert.ok(model);
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    extensionFactories: options.extensionFactories,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "You are a coding assistant. Preserve the user's constraints.",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model, thinkingLevel: "off", tools: ["read", "write", "bash"],
    resourceLoader: loader, settingsManager, sessionManager,
  });
  const bind = async (current: AgentSession) => current.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...current.extensionRunner.getUIContext(),
      notify: (message, type = "info") => notifications.push({ message, type }),
    },
    onError: (error) => extensionErrors.push(error),
  });
  const runtime = new AgentSessionRuntime(session,
    { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] },
    async ({ cwd: nextCwd, sessionManager: nextManager, sessionStartEvent }) => {
      const nextLoader = new DefaultResourceLoader({
        cwd: nextCwd, agentDir, settingsManager,
        additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
        extensionFactories: options.extensionFactories,
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: "You are a coding assistant. Preserve the user's constraints.",
      });
      await nextLoader.reload();
      assert.deepEqual(nextLoader.getExtensions().errors, []);
      const result = await createAgentSession({ cwd: nextCwd, agentDir, modelRuntime,
        tools: ["read", "write", "bash"], resourceLoader: nextLoader, settingsManager,
        sessionManager: nextManager, sessionStartEvent });
      return { ...result, services: { cwd: nextCwd, agentDir, modelRuntime, settingsManager,
        resourceLoader: nextLoader, diagnostics: [] }, diagnostics: [] };
    });
  runtime.setRebindSession(bind);
  t.after(() => runtime.dispose());
  await bind(session);
  if (options.configure !== false) {
    await session.prompt("/cachewise-compact provider add");
    await session.prompt("/cachewise-compact on");
  }
  return { session, runtime, sessionManager, settingsManager, modelRuntime, model, requests, replies, extensionErrors, notifications, cwd, agentDir };
}

export const summary = "## Goal\nKeep the parser streaming.\n## Next Steps\nFinish src/parser.ts.";
export const wrappedSummary = (text: string) => `<compaction-summary>\n${text}\n</compaction-summary>`;
export const olderConstraint = "A_ONLY_CONSTRAINT: parser must stream; no whole-file buffering. " + "Earlier context. ".repeat(100);
export const olderTask = "A_ONLY_TASK: finish src/parser.ts and add an EOF test. " + "Earlier discussion. ".repeat(100);
export const recent = "B_ONLY_CANARY: recent material must not reach the summarizer. " + "Recent work. ".repeat(100);
