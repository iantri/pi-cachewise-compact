import assert from "node:assert/strict";
import { once } from "node:events";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

async function exercise(
  t: TestContext,
  cacheRead: number | null = 10000,
  api = "openai-completions",
  diagnostics = false,
  cacheOverrides: Record<string, unknown> = {},
  scenario = "normal",
  fixtureId?: "100k" | "250k",
) {
  const root = await mkdtemp(join(tmpdir(), "cache-check-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: any[] = [];
  const sentinel = join(root, "tool-sentinel.txt");
  await writeFile(sentinel, "unchanged");
  const toolArguments = { path: sentinel, content: "unexpected write" };
  let inputTokens = 12000;
  const responses = [
    "Recorded.",
    "<compaction-summary>Project Lantern. The cancellation grace period is 36 hours. Preserve the event log.</compaction-summary>",
    "The cancellation grace period is 36 hours.",
  ];
  if (scenario === "fallback") responses[1] = "This is not a wrapped summary.";
  if (scenario === "wrong-fact") responses[2] = "The grace period is 99 years.";
  if (scenario === "summary-omission")
    responses[1] = "<compaction-summary>Project Lantern. Preserve the event log. The design review is ready; implementation remains unfinished.</compaction-summary>";
  const continuationTruncated = () => scenario === "truncated-continuation" && requests.length === 3;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (scenario === "cancel") {
      setTimeout(() => child.kill("SIGTERM"), 10);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const toolCall = requests.length === ["foreground-tool-call", "summary-tool-call", "continuation-tool-call"].indexOf(scenario) + 1;
    if (api === "anthropic-messages") {
      const event = (type: string, data: unknown) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`,
        );
      event("message_start", {
        message: {
          id: "test",
          type: "message",
          role: "assistant",
          model: "fictional-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 4000,
            output_tokens: 0,
            ...(cacheRead === null
              ? {}
              : {
                  cache_read_input_tokens:
                    requests.length === 2 ? cacheRead : 10000,
                  cache_creation_input_tokens: 0,
                }),
          },
        },
      });
      event("content_block_start", {
        index: 0,
        content_block: toolCall
          ? { type: "tool_use", id: "unexpected-write", name: "write", input: {} }
          : { type: "text", text: "" },
      });
      event("content_block_delta", {
        index: 0,
        delta: toolCall
          ? { type: "input_json_delta", partial_json: JSON.stringify(toolArguments) }
          : { type: "text_delta", text: responses[requests.length - 1] },
      });
      event("content_block_stop", { index: 0 });
      event("message_delta", {
        delta: { stop_reason: toolCall ? "tool_use" : continuationTruncated() ? "max_tokens" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 30 },
      });
      event("message_stop", {});
      res.end();
      return;
    }
    const frame = (v: unknown) => res.write(`data: ${JSON.stringify(v)}\n\n`);
    frame({
      id: "test",
      object: "chat.completion.chunk",
      created: 1,
      model: "fictional-model",
      choices: [
        {
          index: 0,
          delta: toolCall
            ? { role: "assistant", tool_calls: [{ index: 0, id: "unexpected-write", type: "function", function: { name: "write", arguments: JSON.stringify(toolArguments) } }] }
            : { role: "assistant", content: responses[requests.length - 1] },
          finish_reason: null,
        },
      ],
    });
    frame({
      id: "test",
      object: "chat.completion.chunk",
      created: 1,
      model: "fictional-model",
      choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : continuationTruncated() ? "length" : "stop" }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: 30,
        total_tokens: inputTokens + 30,
        ...(cacheRead === null
          ? {}
          : scenario === "alias"
            ? {
                prompt_cache_hit_tokens:
                  requests.length === 2 ? cacheRead : 10000,
              }
            : {
                prompt_tokens_details: {
                  cached_tokens: requests.length === 2 ? cacheRead : 10000,
                },
              }),
      },
    });
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const credential = scenario === "quoted-secret" ? '\"' : "AUTH_SECRET_CANARY";
  const modelsPath = join(root, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        fictional: {
          api,
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1${scenario === "query-secret" ? "?token=URL_SECRET_CANARY" : ""}`,
          apiKey: credential,
          models: [
            {
              id: "fictional-model",
              reasoning: false,
              input: ["text"],
              contextWindow: 524288,
              maxTokens: 32768,
            },
          ],
        },
      },
    }),
  );
  const extension = join(root, "noisy-extension.mjs");
  await writeFile(
    extension,
    `export default function(pi){console.log(${JSON.stringify("PRIVATE_EXTENSION_CANARY " + credential + (scenario === "query-secret" ? " URL_SECRET_CANARY" : ""))});${scenario === "missing-tools" ? 'pi.on("before_provider_request", event => { delete event.payload.tools; });' : ""}}`,
  );
  let extensionPath: string | undefined;
  if (["shortened-history", "shortened-wire-history"].includes(scenario)) {
    // Simulate a candidate regression: preserve the early fact and a valid prefix,
    // but omit the final discarded message from the summary request.
    extensionPath = join(root, "faulty-candidate.ts");
    let source = await readFile(
      resolve("extensions/cachewise-compact/index.ts"),
      "utf8",
    );
    source =
      scenario === "shortened-history"
        ? source.replace(
            'messages: [...messages, { role: "user", content: instruction',
            'messages: [...messages.slice(0, -1), { role: "user", content: instruction',
          )
        : source.replace(
            "onPayload: (payload) => {",
            "onPayload: (payload) => { (payload as { messages: unknown[] }).messages.splice(-2, 1);",
          );
    await writeFile(
      extensionPath,
      source
        .replaceAll(
          'from "./',
          `from "${resolve("extensions/cachewise-compact")}/`,
        )
        .replaceAll(
          '"@earendil-works/pi-ai"',
          JSON.stringify(import.meta.resolve("@earendil-works/pi-ai")),
        ),
    );
  }
  if (scenario === "transport-bypass") {
    await writeFile(
      extension,
      `
      import { request } from "node:http";
      import { Readable } from "node:stream";
      export default function(pi) {
        pi.on("session_start", () => {
          globalThis.fetch = async (input, init) => {
            const outgoing = new Request(input, init);
            const body = await outgoing.text();
            return new Promise((resolve, reject) => {
              const call = request(outgoing.url, {
                method: outgoing.method,
                headers: Object.fromEntries(outgoing.headers),
              }, (response) => resolve(new Response(Readable.toWeb(response), {
                status: response.statusCode,
                headers: response.headers,
              })));
              call.on("error", reject);
              call.end(body);
            });
          };
        });
      }
    `,
    );
  }
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await mkdir(join(workspace, "project"));
  await writeFile(
    join(workspace, "project", "AGENTS.md"),
    "PRIVATE_INSTRUCTION_CANARY",
  );
  const messages: any[] = [
    {
      role: "user",
      content:
        "Project Lantern cancellation grace period is 36 hours. Preserve the event log.",
    },
  ];
  // A small public test scenario exercises the same runner; production selection is fixed to the two full fixtures.
  for (let i = 0; i < 12; i++) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            `Module ${i} implements distinct reservation rule ${i}: ` +
            "A reservation records borrower, equipment, explicit timestamps, state transitions, and immutable audit reasons. ".repeat(
              12,
            ),
        },
      ],
      stopReason: "stop",
    });
    messages.push({
      role: "user",
      content: `Please inspect rule ${i + 1}, then document its boundary cases and implementation decisions.`,
    });
  }
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: "The design review is ready." }],
    stopReason: "stop",
  });
  if (scenario === "split-turn") {
    // Keep one long original turn so Pi's retained boundary falls inside it.
    for (let index = messages.length - 1; index > 0; index--)
      if (messages[index].role === "user") messages.splice(index, 1);
  }
  let fixture: any = {
    id: "test",
    version: 1,
    description: "Fictional rules review",
    referenceTokens: 2500,
    tokenizer: "cl100k_base",
    messages,
    facts: [
      {
        sourceMessage: 0,
        question: "What is the cancellation grace period?",
        mustInclude: ["36 hours"],
      },
    ],
  };
  if (scenario === "no-discarded-facts") fixture.facts[0].sourceMessage = messages.length - 1;
  if (fixtureId) {
    fixture = await (
      await import("../scripts/cache-reuse/fixtures.ts")
    ).loadFixture(fixtureId);
    inputTokens = fixture.referenceTokens + 4096;
    const facts =
      fixtureId === "100k"
        ? "Lantern Ledger uses half-open UTC intervals."
        : "Harbor Dispatch uses integer kilograms for vessel capacity.";
    responses[1] = `<compaction-summary>${facts}</compaction-summary>`;
    responses[2] = facts;
  }
  const config = {
    version: 1,
    fixture: "100k",
    provider: "fictional",
    model: "fictional-model",
    modelsPath,
    outputDir: root,
    extensions: [extension],
    extensionPath,
    thinking: "off",
    diagnostics,
    contextTokens: fixtureId ? 524288 : 32768,
    reserveTokens: 2048,
    keepRecentTokens: scenario === "split-turn" ? 1000 : 100,
    maxOutputTokens: 512,
    timeoutSeconds: 30,
    cache: {
      minimumPrefixTokens: 100,
      sharedPrefixUpperBoundTokens: 8192,
      minimumHistoryCacheTokens: 1000,
      retentionSeconds: 300,
      ...cacheOverrides,
    },
  };
  const path = join(root, "input.json");
  await writeFile(path, JSON.stringify({ config, fixture }));
  const cliConfig = join(root, "verification.json");
  await writeFile(cliConfig, JSON.stringify(config));
  const child = fork(
    resolve(
      scenario === "cli"
        ? "scripts/verify-cache-reuse.mjs"
        : "tests/cache-reuse-worker.ts",
    ),
    scenario === "cli" ? ["--live", "--config", cliConfig] : [path, workspace],
    {
      execArgv:
        scenario === "cli" ? [] : ["--import", import.meta.resolve("tsx")],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let result: any;
  let output = "";
  child.stdout?.on("data", (c) => (output += c));
  child.stderr?.on("data", (c) => (output += c));
  child.on("message", (m) => (result = m));
  await once(child, "exit");
  if (scenario === "cli") {
    const entries = await readdir(root);
    const name = entries.find((n) => n.startsWith("cache-check-"));
    if (name) {
      const directory = join(root, name);
      const report = JSON.parse(
        await readFile(join(directory, "result.json"), "utf8"),
      );
      result = { outcome: report.outcome, directory };
    }
  }
  return { root, requests, result, output, workspace, sentinel };
}

for (const api of ["openai-completions", "anthropic-messages"]) {
  test(`${api}: normal coding tools stay in the foreground and summary prefix`, async (t) => {
    const run = await exercise(t, 10000, api);
    assert.equal(run.result.outcome, "passed", await readFile(join(run.result.directory, "result.json"), "utf8"));
    assert.equal(run.requests.length, 3);
    const definitions = run.requests[0].tools;
    assert.deepEqual(definitions.map((tool: any) => tool.function?.name ?? tool.name), ["read", "bash", "edit", "write"]);
    for (const tool of definitions) {
      const schema = tool.function?.parameters ?? tool.input_schema;
      assert.equal(schema.type, "object");
      assert.ok(Object.keys(schema.properties).length > 0);
    }
    assert.deepEqual(run.requests[1].tools, definitions);
    assert.deepEqual(run.requests[2].tools, definitions);
    const report = JSON.parse(await readFile(join(run.result.directory, "result.json"), "utf8"));
    assert.equal(report.checks.prefixFidelity, true);
    assert.equal(report.checks.retainedHistory, true);
  });

  for (const [index, step] of ["foreground", "summary", "continuation"].entries()) {
    test(`${api}: an unexpected ${step} tool call fails without execution or another request`, async (t) => {
      const run = await exercise(t, 10000, api, false, {}, `${step}-tool-call`);
      assert.equal(run.result.outcome, "failed");
      assert.equal(run.requests.length, index + 1);
      assert.equal(await readFile(run.sentinel, "utf8"), "unchanged");
    });
  }

  test(`${api}: stripped coding tools cannot pass the live gate`, async (t) => {
    const run = await exercise(t, 10000, api, false, {}, "missing-tools");
    assert.equal(run.result.outcome, "unverified");
    assert.equal(run.requests.length, 0);
  });
}

test("live checker attributes meaningful cache reuse to optimized compaction through real Pi", async (t) => {
  const run = await exercise(t);
  assert.equal(
    run.result?.outcome,
    "passed",
    run.output +
      (run.result?.directory
        ? await readFile(join(run.result.directory, "result.json"), "utf8")
        : JSON.stringify(run.result)),
  );
  assert.equal(run.requests.length, 3);
  assert.doesNotMatch(
    JSON.stringify(run.requests),
    /PRIVATE_INSTRUCTION_CANARY/,
  );
  await assert.rejects(readdir(run.workspace), { code: "ENOENT" });
  assert.match(JSON.stringify(run.requests[1]), /compaction-summary/);
  const report = JSON.parse(
    await readFile(join(run.result.directory, "result.json"), "utf8"),
  );
  assert.equal(report.requests[1].step, "summary");
  assert.equal(report.requests[1].cacheRead, 10000);
  assert.equal(report.checks.retainedHistory, true);
  assert.deepEqual(await readdir(run.result.directory), ["result.json"]);
  assert.equal((await stat(run.result.directory)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(run.result.directory, "result.json"))).mode & 0o777,
    0o600,
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    /AUTH_SECRET_CANARY|<compaction-summary>/,
  );
});

test("impossible summary cache counters cannot pass even when foreground cache reads are positive", async (t) => {
  const run = await exercise(t, 13000);
  assert.equal(run.result.outcome, "unverified");
});

for (const [count, outcome] of [
  [0, "failed"],
  [100, "failed"],
  [null, "unverified"],
] as const) {
  test(`summary cache count ${count} produces ${outcome}`, async (t) => {
    const run = await exercise(t, count);
    assert.equal(run.result.outcome, outcome);
  });
}
test("Anthropic reports uncached input separately from cache reads", async (t) => {
  const run = await exercise(t, 10000, "anthropic-messages");
  const report = JSON.parse(
    await readFile(join(run.result.directory, "result.json"), "utf8"),
  );
  assert.equal(run.result.outcome, "passed", JSON.stringify(report));
  assert.equal(report.requests[1].input, 14000);
  assert.equal(report.requests[1].cacheRead, 10000);
});

test("diagnostics keep fictional response content private and omit credentials even from extension logs", async (t) => {
  const run = await exercise(t, 10000, "openai-completions", true);
  assert.equal(run.result.outcome, "passed");
  const diagnostics = await readFile(
    join(run.result.directory, "diagnostics.json"),
    "utf8",
  );
  assert.match(diagnostics, /PRIVATE_EXTENSION_CANARY/);
  assert.match(diagnostics, /compaction-summary/);
  assert.doesNotMatch(diagnostics, /AUTH_SECRET_CANARY/);
  assert.doesNotMatch(
    run.output,
    /PRIVATE_EXTENSION_CANARY|AUTH_SECRET_CANARY/,
  );
});

test("a shared-prefix bound too small for the actual request blocks dispatch", async (t) => {
  const run = await exercise(t, 10000, "openai-completions", false, {
    sharedPrefixUpperBoundTokens: 1,
  });
  assert.equal(run.result.outcome, "unverified");
  assert.equal(run.requests.length, 0);
});

test("native fallback is blocked and cannot count as optimized success", async (t) => {
  const run = await exercise(
    t,
    10000,
    "openai-completions",
    false,
    {},
    "fallback",
  );
  assert.equal(run.result.outcome, "failed");
  assert.equal(run.requests.length, 2);
  await assert.rejects(readdir(run.workspace), { code: "ENOENT" });
});
test("cancellation cleans the temporary session and cannot pass", async (t) => {
  const run = await exercise(
    t,
    10000,
    "openai-completions",
    false,
    {},
    "cancel",
  );
  assert.equal(run.result.outcome, "unverified");
  assert.equal(run.requests.length, 1);
  await assert.rejects(readdir(run.workspace), { code: "ENOENT" });
  assert.doesNotMatch(
    run.output,
    /AUTH_SECRET_CANARY|PRIVATE_EXTENSION_CANARY/,
  );
});

test("the complete 100k tool conversation replays and compacts without padding or truncation", async (t) => {
  const run = await exercise(
    t,
    85000,
    "openai-completions",
    false,
    {},
    "normal",
    "100k",
  );
  const report = JSON.parse(
    await readFile(join(run.result.directory, "result.json"), "utf8"),
  );
  assert.equal(run.result.outcome, "passed", JSON.stringify(report));
  assert.ok(run.requests[0].messages.some((m: any) => m.role === "tool"));
  assert.equal(report.fixture.referenceTokens, 94497);
});

test("public live CLI runs the committed fixture and prints only its fixed outcome", async (t) => {
  const run = await exercise(
    t,
    85000,
    "openai-completions",
    false,
    {},
    "cli",
    "100k",
  );
  assert.equal(run.result?.outcome, "passed", run.output);
  assert.equal(run.output, "Cache check: passed.\n");
  assert.equal(run.requests.length, 3);
});

for (const api of ["openai-completions", "anthropic-messages"]) {
  for (const scenario of ["wrong-fact", "summary-omission"]) {
    test(`${api}: ${scenario} is informational when flow and cache reuse pass`, async (t) => {
      const run = await exercise(t, 10000, api, false, {}, scenario);
      const report = JSON.parse(await readFile(join(run.result.directory, "result.json"), "utf8"));
      assert.equal(run.result.outcome, "passed", JSON.stringify(report));
      assert.equal(run.requests.length, 3);
      assert.equal(report.checks.continuationCompleted, true);
      assert.deepEqual(report.observations, {
        discardedFactCount: 1,
        summaryTermsPresent: scenario !== "summary-omission",
        continuationTermsPresent: scenario !== "wrong-fact",
      });
    });
  }

  test(`${api}: no facts in A leaves term observations unknown without failing flow`, async (t) => {
    const run = await exercise(t, 10000, api, false, {}, "no-discarded-facts");
    const report = JSON.parse(await readFile(join(run.result.directory, "result.json"), "utf8"));
    assert.equal(run.result.outcome, "passed", JSON.stringify(report));
    assert.equal(report.checks.continuationCompleted, true);
    assert.deepEqual(report.observations, {
      discardedFactCount: 0,
      summaryTermsPresent: null,
      continuationTermsPresent: null,
    });
  });

  test(`${api}: missing fixture terms do not excuse missing cache reuse`, async (t) => {
    const run = await exercise(t, 0, api, false, {}, "wrong-fact");
    const report = JSON.parse(await readFile(join(run.result.directory, "result.json"), "utf8"));
    assert.equal(run.result.outcome, "failed");
    assert.equal(report.reason, "insufficient-history-reuse");
  });

  test(`${api}: a truncated continuation still fails despite cache reuse`, async (t) => {
    const run = await exercise(t, 10000, api, false, {}, "truncated-continuation");
    const report = JSON.parse(await readFile(join(run.result.directory, "result.json"), "utf8"));
    assert.equal(run.result.outcome, "failed");
    assert.equal(report.reason, "continuation-failed");
  });
}

test("a summary that omits the end of discarded history cannot pass", async (t) => {
  const run = await exercise(
    t,
    10000,
    "openai-completions",
    false,
    {},
    "shortened-history",
  );
  const report = JSON.parse(
    await readFile(join(run.result.directory, "result.json"), "utf8"),
  );
  assert.equal(run.result.outcome, "failed", JSON.stringify(report));
  assert.equal(run.requests.length, 1);
});

test("discarded history verification includes Pi's split-turn prefix", async (t) => {
  const run = await exercise(
    t,
    10000,
    "openai-completions",
    false,
    {},
    "split-turn",
  );
  const report = JSON.parse(
    await readFile(join(run.result.directory, "result.json"), "utf8"),
  );
  assert.equal(run.result.outcome, "passed", JSON.stringify(report));
  assert.equal(report.boundary.isSplitTurn, true);
  assert.equal(report.checks.discardedHistory, true);
});

test("a payload hook cannot shorten serialized discarded history", async (t) => {
  const run = await exercise(
    t,
    10000,
    "openai-completions",
    false,
    {},
    "shortened-wire-history",
  );
  const report = JSON.parse(
    await readFile(join(run.result.directory, "result.json"), "utf8"),
  );
  assert.equal(run.result.outcome, "failed", JSON.stringify(report));
  assert.equal(run.requests.length, 1);
});

test("the checker accepts the Chat Completions cache-counter locations recognized by Pi", async (t) => {
  const run = await exercise(t, 10000, "openai-completions", false, {}, "alias");
  assert.equal(run.result.outcome, "passed");
});

test("credential redaction preserves valid JSON even when a credential contains JSON punctuation", async (t) => {
  const run = await exercise(
    t,
    10000,
    "openai-completions",
    true,
    {},
    "quoted-secret",
  );
  assert.equal(run.result.outcome, "passed");
  const diagnostic = JSON.parse(
    await readFile(join(run.result.directory, "diagnostics.json"), "utf8"),
  );
  assert.match(diagnostic.logs, /PRIVATE_EXTENSION_CANARY \[redacted\]/);
  assert.doesNotMatch(diagnostic.logs, /"/);
});

test("URL credentials are omitted from private diagnostics", async (t) => {
  const run = await exercise(
    t,
    10000,
    "openai-completions",
    true,
    {},
    "query-secret",
  );
  assert.equal(run.result.outcome, "passed");
  const diagnostic = await readFile(
    join(run.result.directory, "diagnostics.json"),
    "utf8",
  );
  assert.doesNotMatch(diagnostic, /URL_SECRET_CANARY|AUTH_SECRET_CANARY/);
});

test("the complete 250k conversation replays through Anthropic Messages", async (t) => {
  const run = await exercise(
    t,
    210000,
    "anthropic-messages",
    false,
    {},
    "normal",
    "250k",
  );
  const report = JSON.parse(
    await readFile(join(run.result.directory, "result.json"), "utf8"),
  );
  assert.equal(run.result.outcome, "passed", JSON.stringify(report));
  assert.ok(
    run.requests[0].messages.some(
      (message: any) =>
        Array.isArray(message.content) &&
        message.content.some((part: any) => part.type === "tool_use"),
    ),
  );
  assert.equal(report.checks.retainedContext, true);
});

test("unobserved provider transport cannot produce a verified pass", async (t) => {
  const run = await exercise(
    t,
    10000,
    "openai-completions",
    false,
    {},
    "transport-bypass",
  );
  const report = JSON.parse(
    await readFile(join(run.result.directory, "result.json"), "utf8"),
  );
  assert.equal(run.requests.length, 3);
  assert.equal(
    report.requests.every((request: any) => !request.sent),
    true,
  );
  assert.equal(run.result.outcome, "unverified", JSON.stringify(report));
  assert.equal(report.reason, "unobserved-transport");
});
