import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHarness, olderConstraint, olderTask, recent, summary, wrappedSummary, type Reply } from "./harness.ts";

for (const api of ["openai-completions", "anthropic-messages"] as const) {
  test(`${api}: only the enclosed summary is saved and sent on continuation`, async (t) => {
    const candidate = "Sure, I can help with that!\n" + "DISCARDED_PREAMBLE ".repeat(1000) +
      wrappedSummary(summary) + "\nDISCARDED_TRAILING_TEXT";
    const h = await createHarness(t, { api, replies: [
      "Recorded.", "Recorded.", "Recent.", candidate, summary, "Continuing.",
    ] });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    const result = await h.session.compact();
    assert.equal(h.requests.length, 4, "One optimized request, without native fallback");
    assert.equal(result.summary, summary);
    assert.equal(result.usage?.output, 20, "Keep usage for the entire response");
    assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, true);
    assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, h.session.messages);
    await h.session.prompt("Continue.");
    const next = JSON.stringify(h.requests.at(-1));
    assert.match(next, /src\/parser\.ts/);
    assert.match(next, /B_ONLY_CANARY/);
    assert.doesNotMatch(next, /compaction-summary|DISCARDED_PREAMBLE|DISCARDED_TRAILING_TEXT/);
    assert.deepEqual(h.extensionErrors, []);
  });
}

for (const api of ["openai-completions", "anthropic-messages"] as const) {
  for (const candidate of [
    "x", "Sure, I can help with that!", "I'll summarize the conversation for you.", "**Understood!**",
    "I cannot help with that request.", "I'm sorry, but I can't assist with that request.",
    "Je ne peux pas vous aider.",
    "## Goal\n\nKeep  exact spacing.  \n```ts\nconst node = '<item>';\n```\nUse &lt;literal&gt; entities.",
  ]) {
    test(`${api}: valid block preserves its content (${candidate.split("\n")[0]})`, async (t) => {
      const h = await createHarness(t, { api, replies: [
        "Recorded.", "Recorded.", "Recent.", ` \n${wrappedSummary(candidate)}\n\t`, summary,
      ] });
      await h.session.prompt(olderConstraint);
      await h.session.prompt(olderTask);
      await h.session.prompt(recent);
      const result = await h.session.compact();
      assert.equal(result.summary, candidate);
      assert.equal(h.requests.length, 4);
      assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, true);
      assert.deepEqual(h.extensionErrors, []);
    });
  }

  for (const [name, reply] of Object.entries<Reply>({
    unwrapped: { text: summary },
    "missing opening": { text: "Context</compaction-summary>" },
    "missing closing": { text: "<compaction-summary>Context" },
    reversed: { text: "</compaction-summary>Context<compaction-summary>" },
    multiple: { text: wrappedSummary("First") + wrappedSummary("Second") },
    nested: { text: wrappedSummary(wrappedSummary("Nested")) },
    "extra opening": { text: wrappedSummary("Context") + "<compaction-summary>" },
    "extra closing": { text: "</compaction-summary>" + wrappedSummary("Context") },
    "empty block": { text: wrappedSummary("") },
    "whitespace block": { text: wrappedSummary(" \n\t ") },
    capitalization: { text: "<Compaction-Summary>Context</Compaction-Summary>" },
    attributes: { text: '<compaction-summary id="summary">Context</compaction-summary>' },
    "self closing": { text: "<compaction-summary/>" },
    truncation: { text: wrappedSummary("Partial"), stop: "length" },
    "incomplete finish": { text: wrappedSummary("Unfinished"), stop: "incomplete" },
    "reasoning only": { thinking: wrappedSummary("Thinking is not final text") },
    "text with tool call": { text: wrappedSummary("Tool candidate"),
      tool: { name: "write", arguments: { path: "maintenance-side-effect.ts", content: "not allowed" } } },
  })) {
    test(`${api}: ${name} falls back once without saving response text`, async (t) => {
      const rejected = { ...reply, ...(reply.text === undefined ? {} : { text: "REJECTED_RESPONSE_CANARY\n" + reply.text }) };
      const h = await createHarness(t, { api, replies: ["Recorded.", "Recorded.", "Recent.", rejected, summary] });
      await h.session.prompt(olderConstraint);
      await h.session.prompt(olderTask);
      await h.session.prompt(recent);
      const result = await h.session.compact();
      assert.equal(result.summary, summary);
      assert.equal(h.requests.length, 5);
      assert.ok(h.requests[3].tools?.length);
      assert.equal(h.requests[4].tools, undefined);
      assert.doesNotMatch(JSON.stringify(h.requests[4]), /compaction-summary/);
      const compactions = h.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
      assert.equal(compactions.length, 1);
      assert.equal(compactions[0].fromHook, false);
      assert.doesNotMatch(await readFile(h.sessionManager.getSessionFile()!, "utf8"), /REJECTED_RESPONSE_CANARY/);
      assert.doesNotMatch(JSON.stringify(h.notifications), /REJECTED_RESPONSE_CANARY/);
      await assert.rejects(access(join(h.cwd, "maintenance-side-effect.ts")), { code: "ENOENT" });
      assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, h.session.messages);
      assert.deepEqual(h.extensionErrors, []);
    });
  }

  test(`${api}: reasoning delimiters do not compete with the final summary block`, async (t) => {
    const h = await createHarness(t, { api, replies: ["Recorded.", "Recorded.", "Recent.",
      { thinking: wrappedSummary("Reasoning decoy"), text: wrappedSummary(summary) }, summary] });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    assert.equal((await h.session.compact()).summary, summary);
    assert.equal(h.requests.length, 4);
    assert.deepEqual(h.extensionErrors, []);
  });

  for (const maxTokens of [819, 850, 851]) {
    test(`${api}: output limit ${maxTokens} preserves the answer plus wrapper or falls back before dispatch`, async (t) => {
      const optimized = maxTokens === 851;
      const h = await createHarness(t, { api, maxTokens, replies: [
        "Recorded.", "Recorded.", "Recent.", optimized ? wrappedSummary(summary) : summary,
      ] });
      await h.session.prompt(olderConstraint);
      await h.session.prompt(olderTask);
      await h.session.prompt(recent);
      assert.equal((await h.session.compact()).summary, summary);
      assert.equal(h.requests.length, 4, "An insufficient model limit must not dispatch an optimized request");
      const request = h.requests[3];
      assert.equal(request.max_tokens ?? request.max_completion_tokens, optimized ? 851 : 819);
      assert.equal(Boolean(request.tools?.length), optimized);
      assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, optimized);
      assert.deepEqual(h.extensionErrors, []);
    });
  }
}

for (const cause of ["cancel", "stale source"] as const) {
  test(`an invalid block after ${cause} never starts native fallback`, async (t) => {
    const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent."] });
    h.replies.push({ text: "Invalid response without delimiters", beforeReply: () => {
      if (cause === "cancel") h.session.abortCompaction();
      else h.sessionManager.appendCustomMessageEntry("source-changed", "New context", false);
    } });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    await assert.rejects(h.session.compact(), /cancel|abort/i);
    assert.equal(h.requests.length, 4);
    assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
    assert.deepEqual(h.extensionErrors, []);
  });
}

test("Anthropic pause_turn cannot make a complete-looking block acceptable", async (t) => {
  const h = await createHarness(t, { api: "anthropic-messages", replies: [
    "Recorded.", "Recorded.", "Recent.", { text: wrappedSummary("Paused candidate"), stop: "pause_turn" }, summary,
  ] });
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const result = await h.session.compact();
  assert.equal(h.requests.length, 5, "A paused operation needs one native fallback");
  assert.equal(result.summary, summary);
  assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, false);
});
