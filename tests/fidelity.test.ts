import assert from "node:assert/strict";
import { test } from "node:test";
import { capturePayload, checkPayload } from "../extensions/cachewise-compact/fidelity.ts";
import { createHarness, olderConstraint, olderTask, recent, summary, wrappedSummary } from "./harness.ts";

for (const api of ["openai-completions", "anthropic-messages"] as const) {
  test(`${api}: a context rewrite falls back before sending a mismatched optimized prefix`, async (t) => {
    const h = await createHarness(t, {
      api,
      extensionFactories: [(pi) => {
        pi.on("context", (event) => ({
          messages: event.messages.map((message) => message.role !== "user" ? message : {
            ...message,
            content: typeof message.content === "string"
              ? message.content.replaceAll("A_ONLY_CONSTRAINT", "TRANSFORMED_A")
              : message.content.map((block) => block.type === "text"
                ? { ...block, text: block.text.replaceAll("A_ONLY_CONSTRAINT", "TRANSFORMED_A") } : block),
          }),
        }));
      }],
      replies: ["Recorded.", "Recorded.", "Recent.", summary],
    });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    assert.ok(JSON.stringify(h.requests[2]).includes("TRANSFORMED_A"));
    assert.ok(!JSON.stringify(h.requests[2]).includes("A_ONLY_CONSTRAINT"));

    await h.session.compact();

    assert.equal(h.requests.length, 4, "The mismatched optimized payload never reaches HTTP");
    assert.equal(h.requests[3].tools, undefined, "Only the native summarization request is dispatched");
    assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, false);
    assert.match(h.notifications.find((notice) => notice.type === "warning")?.message ?? "", /native compaction/i);
    assert.deepEqual(h.extensionErrors, []);
  });

  test(`${api}: image blocking also applies to maintenance over stored image history`, async (t) => {
    const image = "U1RPUkVEX0lNQUdFX0JZX0hJU1RPUlk=";
    const h = await createHarness(t, {
      api, settings: { images: { blockImages: true } },
      replies: ["Recorded.", "Recorded.", "Recent.", summary],
    });
    await h.session.prompt(olderConstraint);
    // Existing sessions can contain attachments saved before image blocking was enabled.
    // Append through Pi's public persistence API; all request conversion remains real.
    h.sessionManager.appendMessage({
      role: "user", timestamp: Date.now(), content: [
        { type: "text", text: "An older image attachment." },
        { type: "image", mimeType: "image/png", data: image },
      ],
    });
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    assert.ok(JSON.stringify(h.requests[2]).includes("Image reading is disabled."));
    assert.ok(!JSON.stringify(h.requests[2]).includes(image));

    await h.session.compact();

    assert.equal(h.requests.length, 4, "No blocked image is dispatched as an optimized request");
    assert.equal(h.requests[3].tools, undefined);
    assert.ok(!JSON.stringify(h.requests[3]).includes(image));
    assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, false);
    assert.deepEqual(h.extensionErrors, []);
  });

  test(`${api}: a split user prefix stays optimized, including a coalesced instruction block`, async (t) => {
    const retained = "B_SPLIT_ONLY: " + "Recent work. ".repeat(100);
    const h = await createHarness(t, { api, replies: [retained, wrappedSummary(summary)] });
    await h.session.prompt(olderConstraint);
    await h.session.compact();
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests[1].tools?.length);
    assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, true);
    assert.ok(!JSON.stringify(h.requests[1]).includes("B_SPLIT_ONLY"));

    const blocks = (value: unknown): Array<Record<string, unknown>> =>
      typeof value === "string" ? [{ type: "text", text: value }] : value as Array<Record<string, unknown>>;
    const maintenance = h.requests[1];
    const instruction = blocks(maintenance.messages.at(-1)!.content).at(-1)!.text as string;
    const foreground = capturePayload(h.requests[0]);
    assert.doesNotThrow(() => checkPayload(foreground, maintenance, instruction));

    // Exercise the same captured wire content with adjacent user blocks coalesced.
    // Dropping the whole final message here would drop A and miss its corruption below.
    const merged = structuredClone(maintenance);
    const suffix = merged.messages.pop()!;
    const last = merged.messages.at(-1)!;
    assert.equal(last.role, "user");
    last.content = [...blocks(last.content), ...blocks(suffix.content)];
    assert.doesNotThrow(() => checkPayload(foreground, merged, instruction));
    blocks(last.content)[0].text = "The discarded user history was rewritten.";
    assert.throws(() => checkPayload(foreground, merged, instruction), /foreground prefix/);
    assert.deepEqual(h.extensionErrors, []);
  });

  test(`${api}: blocked images confined to retained history do not disqualify A`, async (t) => {
    const h = await createHarness(t, {
      api, settings: { images: { blockImages: true } },
      replies: ["Recorded.", "Recorded.", "Recent.", wrappedSummary(summary)],
    });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    h.sessionManager.appendMessage({
      role: "user", timestamp: Date.now(), content: [
        { type: "text", text: "B_IMAGE_ONLY: leave this attachment in retained context." },
        { type: "image", mimeType: "image/png", data: "UkVUQUlORURfSU1BR0U=" },
      ],
    });
    await h.session.prompt("Continue.");
    assert.ok(JSON.stringify(h.requests[2]).includes("Image reading is disabled."));
    await h.session.compact();
    assert.equal(h.requests.length, 4);
    assert.ok(h.requests[3].tools?.length);
    assert.ok(!JSON.stringify(h.requests[3]).includes("B_IMAGE_ONLY"));
    assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, true);
    assert.deepEqual(h.extensionErrors, []);
  });
}

test("Anthropic falls back when tight headroom changes the foreground thinking budget", async (t) => {
  const h = await createHarness(t, {
    api: "anthropic-messages", reasoning: true, contextWindow: 8500,
    settings: { thinkingBudgets: { low: 2048 } },
    replies: ["Recorded.", "Recorded.", "Recent.", summary],
  });
  h.session.setThinkingLevel("low");
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const foreground = h.requests[2].thinking as { budget_tokens: number };
  assert.ok(foreground.budget_tokens > 0 && foreground.budget_tokens < 2048);

  await h.session.compact();

  assert.equal(h.requests.length, 4, "A different serialized thinking budget must be rejected before HTTP");
  assert.equal(h.requests[3].tools, undefined);
  assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, false);
  assert.deepEqual(h.extensionErrors, []);
});

test("Chat Completions rejects a changed serialized thinking-token budget", async (t) => {
  const h = await createHarness(t, {
    reasoning: true, settings: { thinkingBudgets: { low: 2048 } },
    replies: ["Recorded.", "Recorded.", "Recent.", summary],
  });
  h.modelRuntime.registerProvider(h.model.provider, {
    api: h.model.api, baseUrl: h.model.baseUrl, apiKey: "dummy-local-test-key",
    models: [{ ...h.model, compat: { supportsThinkingTokenBudget: true } }],
  });
  await h.session.setModel(h.modelRuntime.getModel(h.model.provider, h.model.id)!);
  h.session.setThinkingLevel("low");
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  assert.equal(h.requests[2].thinking_token_budget, 2048);

  await h.session.compact();

  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3].tools, undefined, "The smaller maintenance cap must not silently remove thinking");
  assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, false);
  assert.deepEqual(h.extensionErrors, []);
});

test("fidelity evidence is detached and preserves cache_control inside tool schemas", () => {
  const foreground = {
    model: "fixture", tools: [{ name: "tool", input_schema: { properties: { cache_control: { type: "string" } } } }],
    messages: [{ role: "user", content: "A" }],
  };
  const evidence = capturePayload(foreground);
  const candidate = structuredClone(foreground);
  candidate.messages.push({ role: "user", content: "Summarize." });
  foreground.messages[0].content = "Later mutation";
  assert.doesNotThrow(() => checkPayload(evidence, candidate, "Summarize."));
  candidate.tools[0].input_schema.properties.cache_control.type = "number";
  assert.throws(() => checkPayload(evidence, candidate, "Summarize."), /request settings/);
});
