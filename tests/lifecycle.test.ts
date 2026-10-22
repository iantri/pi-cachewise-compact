import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHarness, holdReply, olderConstraint, olderTask, recent, summary, wrappedSummary } from "./harness.ts";

for (const change of ["thinking", "request settings"] as const) {
  test(`a ${change} change discards the in-flight candidate without native fallback`, async (t) => {
    const h = await createHarness(t, { reasoning: true, replies: ["Recorded.", "Recorded.", "Recent."] });
    h.replies.push({ text: wrappedSummary(summary), beforeReply: () => {
      if (change === "thinking") h.session.setThinkingLevel("low");
      else h.settingsManager.applyOverrides({ thinkingBudgets: { low: 2048 } });
    } });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    await assert.rejects(h.session.compact(), /cancel|abort/i);
    assert.equal(h.requests.length, 4, "No native replacement after stale inference");
    assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  });
}

for (const queue of ["steer", "followUp"] as const) {
  test(`manual compaction preserves accepted ${queue} input and rejects an ordinary prompt`, { timeout: 15000 }, async (t) => {
    const held = holdReply({ text: wrappedSummary(summary) });
    t.after(held.release);
    const queued = `QUEUED_${queue}: add the EOF test exactly once.`;
    const rejected = "REJECTED_PROMPT: this input was not accepted.";
    const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.", held.reply,
      "Processed current work.", "Processed follow-up work."] });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    const before = structuredClone(h.sessionManager.getBranch());
    const operation = h.session.compact();
    await held.started;
    await assert.rejects(h.session.prompt(rejected, { streamingBehavior: "followUp" }), /compaction is in progress/);
    assert.equal(await h.session[queue](queued), "queued");
    assert.equal(h.session.pendingMessageCount, 1);
    assert.deepEqual(h.sessionManager.getBranch(), before, "Accepting queued input does not change the source history");
    held.release();
    const result = await operation;
    await held.completed;
    assert.equal(result.summary, summary, "Queued input alone does not invalidate the candidate");
    assert.equal(h.requests.length, 4, "Manual compaction does not introduce a foreground continuation");
    assert.equal(h.session.pendingMessageCount, 1, "Pi keeps manually queued work for its normal next turn");
    await h.session.prompt("CONTINUE_NOW: process the queued request.");
    assert.equal(h.session.pendingMessageCount, 0);
    const branch = h.sessionManager.getBranch();
    assert.equal(branch.filter((entry) => entry.type === "message" && entry.message.role === "user" &&
      JSON.stringify(entry.message.content).includes(queued)).length, 1);
    assert.ok(!JSON.stringify(branch).includes(rejected));
    assert.ok(!JSON.stringify(h.requests).includes(rejected));
    assert.ok(!JSON.stringify(h.requests[3]).includes(queued));
    assert.equal(h.requests.length, queue === "followUp" ? 6 : 5,
      "Pi delivers steering with the next prompt and follow-up after that prompt finishes");
    if (queue === "followUp") assert.doesNotMatch(JSON.stringify(h.requests[4]), /QUEUED_followUp/,
      "Follow-up must wait until the next prompt has finished");
    const delivered = h.requests[queue === "followUp" ? 5 : 4];
    assert.equal(delivered.messages.filter((message) => message.role === "user" &&
      JSON.stringify(message.content).includes(queued)).length, 1,
      "The accepted input reaches the provider once in Pi's normal queue turn");
    assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, h.session.messages);
    assert.deepEqual(h.extensionErrors, []);
  });
}

test("an accepted model change rejects the old candidate and remains usable after reopen", { timeout: 15000 }, async (t) => {
  const held = holdReply({ text: wrappedSummary("OBSOLETE_MODEL_CANDIDATE") });
  t.after(held.release);
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.", held.reply, "Using the new model."] });
  h.modelRuntime.registerProvider(h.model.provider, {
    api: h.model.api, baseUrl: h.model.baseUrl, apiKey: "dummy-local-test-key",
    models: [{ ...h.model }, { ...h.model, id: "replacement-model" }],
  });
  const next = h.modelRuntime.getModel(h.model.provider, "replacement-model")!;
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const before = structuredClone(h.session.messages);
  const operation = h.session.compact().then(() => "completed", (error: Error) => error.message);
  await held.started;
  await h.session.setModel(next);
  assert.equal(h.session.model?.id, next.id);
  held.release();
  assert.match(await operation, /cancel|abort/i);
  assert.equal(h.requests.length, 4, "A stale candidate must not start native fallback");
  assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.deepEqual(h.session.messages, before);
  const reopened = SessionManager.open(h.sessionManager.getSessionFile()!);
  assert.deepEqual(reopened.buildSessionContext().messages, before);
  assert.equal(reopened.getBranch().findLast((entry) => entry.type === "model_change")?.modelId, next.id);
  await h.session.prompt("NEW_MODEL_WORK: continue with the changed model.");
  assert.equal(h.requests.at(-1)!.model, next.id);
  assert.equal(h.requests.length, 5);
  assert.deepEqual(h.extensionErrors, []);
});

test("accepted source-history edits discard the old candidate without overwriting newer context", { timeout: 15000 }, async (t) => {
  const held = holdReply({ text: wrappedSummary("OBSOLETE_HISTORY_CANDIDATE") });
  t.after(held.release);
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.", held.reply, "Continued after history changed."] });
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const before = structuredClone(h.session.messages);
  const operation = h.session.compact().then(() => "completed", (error: Error) => error.message);
  await held.started;
  await h.session.sendCustomMessage({ customType: "fixture-update", content: "NEW_HISTORY: preserve the updated EOF requirement.", display: false });
  const updated = structuredClone(h.session.messages);
  assert.deepEqual(updated.slice(0, before.length), before);
  assert.equal(updated.length, before.length + 1);
  held.release();
  assert.match(await operation, /cancel|abort/i);
  assert.equal(h.requests.length, 4);
  assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.deepEqual(h.session.messages, updated);
  assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, updated);
  await h.session.prompt("CONTINUE_UPDATED_HISTORY");
  assert.match(JSON.stringify(h.requests.at(-1)), /NEW_HISTORY/);
  assert.doesNotMatch(JSON.stringify(h.requests.at(-1)), /OBSOLETE_HISTORY_CANDIDATE/);
  assert.equal(h.requests.length, 5);
  assert.deepEqual(h.extensionErrors, []);
});

test("busy tree navigation leaves the source intact and succeeds after compaction", { timeout: 15000 }, async (t) => {
  const held = holdReply({ text: wrappedSummary(summary) });
  t.after(held.release);
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.", held.reply, "Continued on the selected branch."] });
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const before = structuredClone(h.sessionManager.getBranch());
  const target = before.find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
  const operation = h.session.compact();
  await held.started;
  await assert.rejects(h.session.navigateTree(target.id), /compaction.*finish/);
  assert.deepEqual(h.sessionManager.getBranch(), before);
  held.release();
  await operation;
  assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.summary, summary);
  assert.equal((await h.session.navigateTree(target.id)).cancelled, false);
  assert.equal(h.sessionManager.getLeafId(), target.id);
  await h.session.prompt("NEW_BRANCH_WORK: continue from the selected node.");
  assert.doesNotMatch(JSON.stringify(h.requests.at(-1)), /B_ONLY_CANARY/);
  assert.equal(h.requests.length, 5);
  assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, h.session.messages);
  assert.deepEqual(h.extensionErrors, []);
});

for (const transition of ["new session", "switch session", "fork"] as const) {
  test(`${transition} cancels delayed maintenance without saving into either session`, { timeout: 15000 }, async (t) => {
    const held = holdReply({ text: wrappedSummary("OBSOLETE_SESSION_CANDIDATE") });
    t.after(held.release);
    const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.", held.reply, "Continued in the destination session."] });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    const originalFile = h.sessionManager.getSessionFile()!;
    const originalMessages = structuredClone(h.session.messages);
    const branchTarget = h.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
    const destination = SessionManager.create(h.cwd, join(h.agentDir, "destination-sessions"));
    if (transition === "switch session") {
      destination.appendMessage({ role: "user", content: "DESTINATION_HISTORY: preserve this separate session.", timestamp: 1 });
      destination.appendMessage(originalMessages.find((message) => message.role === "assistant")!);
    }
    const operation = h.session.compact().then(() => "completed", (error: Error) => error.message);
    await held.started;
    const result = transition === "new session" ? await h.runtime.newSession()
      : transition === "fork" ? await h.runtime.fork(branchTarget.id, { position: "at" })
      : await h.runtime.switchSession(destination.getSessionFile()!);
    assert.equal(result.cancelled, false);
    await held.cancelled;
    held.release();
    assert.match(await operation, /cancel|abort/i);
    assert.equal(h.requests.length, 4, "Replacing the session must not start native fallback");
    const outgoing = SessionManager.open(originalFile);
    assert.equal(outgoing.getBranch().filter((entry) => entry.type === "compaction").length, 0);
    assert.deepEqual(outgoing.buildSessionContext().messages, originalMessages);
    const current = h.runtime.session;
    assert.notEqual(current.sessionFile, originalFile);
    assert.equal(current.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
    assert.doesNotMatch(JSON.stringify(current.messages), /OBSOLETE_SESSION_CANDIDATE/);
    if (transition === "switch session") assert.match(JSON.stringify(current.messages), /DESTINATION_HISTORY/);
    if (transition === "new session") assert.deepEqual(current.messages, []);
    await current.prompt("DESTINATION_WORK: continue using the selected session.");
    assert.equal(h.requests.length, 5);
    assert.deepEqual(SessionManager.open(current.sessionFile!).buildSessionContext().messages, current.messages);
    assert.deepEqual(h.extensionErrors, []);
  });
}

test("pre-commit cancellation discards maintenance, executes no tool, and preserves recoverable input", { timeout: 15000 }, async (t) => {
  const held = holdReply({ tool: { name: "write", arguments: { path: "cancelled-maintenance.txt", content: "must not execute" } } });
  t.after(held.release);
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.", held.reply, "Recovered the queued request."] });
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const before = structuredClone(h.session.messages);
  const operation = h.session.compact().then(() => "completed", (error: Error) => error.message);
  await held.started;
  const queued = "RECOVERABLE_INPUT: finish the EOF test.";
  assert.equal(await h.session.followUp(queued), "queued");
  await h.session.abort();
  await held.cancelled;
  held.release();
  assert.match(await operation, /cancel|abort/i);
  assert.equal(h.requests.length, 4, "Cancellation cannot launch a native substitute");
  assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.deepEqual(h.session.messages, before);
  assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, before);
  await assert.rejects(access(join(h.cwd, "cancelled-maintenance.txt")), { code: "ENOENT" });
  assert.deepEqual(h.session.clearQueue(), { steering: [], followUp: [queued] });
  await h.session.prompt(queued);
  assert.equal(h.requests.length, 5);
  assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user" &&
    JSON.stringify(entry.message.content).includes(queued)).length, 1);
  assert.deepEqual(h.extensionErrors, []);
});

test("cancellation observed after the saved commit preserves the summary and reports completion", { timeout: 15000 }, async (t) => {
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.", wrappedSummary(summary), "Continued after late cancellation."],
    extensionFactories: [(pi) => {
      pi.on("session_compact", () => {
        const committed = h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
        assert.equal(committed?.summary, summary, "The save precedes this public lifecycle event");
        h.session.abortCompaction();
      });
    }],
  });
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const recentEntries = h.sessionManager.getBranch().filter((entry) => entry.type === "message").slice(-2);
  const outcomes: Array<{ aborted: boolean; summary?: string }> = [];
  const unsubscribe = h.session.subscribe((event) => {
    if (event.type === "compaction_end") outcomes.push({ aborted: event.aborted, summary: event.result?.summary });
  });
  t.after(unsubscribe);
  assert.equal((await h.session.compact()).summary, summary);
  assert.deepEqual(outcomes, [{ aborted: false, summary }]);
  const compaction = h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
  assert.equal(compaction.summary, summary);
  assert.equal(compaction.firstKeptEntryId, recentEntries[0].id);
  for (const entry of recentEntries) assert.deepEqual(h.sessionManager.getEntry(entry.id), entry);
  assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, h.session.messages);
  await h.session.prompt("/cachewise-compact status");
  assert.match(h.notifications.at(-1)!.message, /Last: optimized/);
  await h.session.prompt("AFTER_COMMIT_WORK: continue after the completed compaction.");
  assert.match(JSON.stringify(h.requests.at(-1)), /B_ONLY_CANARY/);
  assert.equal(h.requests.length, 5);
  assert.deepEqual(h.extensionErrors, []);
});

for (const optimized of [false, true]) {
  for (const queueInput of [false, true]) {
    test(`${optimized ? "optimized" : "native reference"} automatic threshold${queueInput ? " drains accepted queued input once" : " adds no foreground turn"}`, { timeout: 15000 }, async (t) => {
      const held = holdReply({ text: optimized ? wrappedSummary(summary) : summary });
      t.after(held.release);
      const h = await createHarness(t, { configure: optimized, reserveTokens: 4096, replies: ["Recorded.", "Still below the native threshold.",
        { text: "Crossed the native threshold.", usage: { input: 28653, output: 20 } }, held.reply,
        "Processed the accepted follow-up."] });
      await h.session.prompt(olderConstraint);
      h.session.setAutoCompactionEnabled(true);
      await h.session.prompt(olderTask);
      assert.equal(h.requests.length, 2, "Enabling the extension does not add a proactive compaction trigger");
      assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
      const outcomes: Array<{ reason: string; willRetry: boolean; summary?: string }> = [];
      const foregroundStops: string[] = [];
      const unsubscribe = h.session.subscribe((event) => {
        if (event.type === "compaction_end") outcomes.push({ reason: event.reason, willRetry: event.willRetry, summary: event.result?.summary });
        if (event.type === "message_end" && event.message.role === "assistant") foregroundStops.push(event.message.stopReason);
      });
      t.after(unsubscribe);
      const foreground = h.session.prompt(recent);
      await held.started;
      const before = structuredClone(h.sessionManager.getBranch());
      const retained = before.filter((entry) => entry.type === "message").slice(-2);
      const queued = "AUTO_QUEUED_WORK: add the EOF test exactly once.";
      if (queueInput) {
        let admission: string | undefined;
        await h.session.prompt(queued, { streamingBehavior: "followUp", preflightResult: (result) => { admission = result; } });
        assert.equal(admission, "queued");
        assert.equal(h.session.pendingMessageCount, 1);
        assert.deepEqual(h.sessionManager.getBranch(), before, "Accepted input has not changed the source history");
      }
      held.release();
      await foreground;
      await held.completed;
      assert.equal(Boolean(h.requests[3].tools?.length), optimized, JSON.stringify(h.notifications));
      assert.deepEqual(outcomes, [{ reason: "threshold", willRetry: false, summary }]);
      assert.deepEqual(foregroundStops, queueInput ? ["stop", "stop"] : ["stop"],
        "Maintenance inference is separate from the ordinary foreground turn and its queued continuation");
      assert.equal(h.requests.length, queueInput ? 5 : 4,
        "Only native queue continuation may add a foreground request after threshold compaction");
      assert.doesNotMatch(JSON.stringify(h.requests[3]), /B_ONLY_CANARY|AUTO_QUEUED_WORK/);
      const saved = h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
      assert.equal(saved.fromHook, optimized);
      assert.equal(saved.firstKeptEntryId, retained[0].id);
      for (const entry of retained) assert.deepEqual(h.sessionManager.getEntry(entry.id), entry);
      assert.equal(h.session.pendingMessageCount, 0);
      assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user" &&
        JSON.stringify(entry.message.content).includes(queued)).length, queueInput ? 1 : 0);
      if (queueInput) assert.equal(h.requests[4].messages.filter((message) => message.role === "user" &&
        JSON.stringify(message.content).includes(queued)).length, 1,
        "Pi's automatic continuation delivers the accepted follow-up to the provider once");
      assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, h.session.messages);
      assert.deepEqual(h.extensionErrors, []);
    });
  }
}

test("reaching the exact native threshold does not trigger automatic compaction", async (t) => {
  const h = await createHarness(t, { reserveTokens: 4096, replies: ["Recorded.",
    { text: "Exactly at the native threshold.", usage: { input: 28652, output: 20 } }] });
  await h.session.prompt(olderConstraint);
  h.session.setAutoCompactionEnabled(true);
  await h.session.prompt(olderTask);
  assert.equal(h.requests.length, 2);
  assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.deepEqual(h.extensionErrors, []);
});

for (const path of ["optimized", "native reference", "native fallback"] as const) {
  test(`${path} overflow recovery compacts once and retries the interrupted turn once`, { timeout: 15000 }, async (t) => {
    const held = holdReply({ text: path === "native reference" ? summary
      : wrappedSummary(path === "native fallback" ? "REJECTED_OVERFLOW_SUMMARY" : summary),
      ...(path === "native fallback" ? { stop: "length" as const } : {}) });
    t.after(held.release);
    const h = await createHarness(t, { configure: path !== "native reference", keepRecentTokens: 600, replies: ["Recorded.", "Recorded.",
      { text: "FAILED_OVERFLOW_ATTEMPT: incomplete foreground response.", stop: "length" },
      held.reply, ...(path === "native fallback" ? [summary] : []),
      "RECOVERED_FOREGROUND: the EOF test is complete."] });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    h.session.setAutoCompactionEnabled(true);
    const outcomes: Array<{ reason: string; willRetry: boolean; summary?: string }> = [];
    const foregroundStops: string[] = [];
    const unsubscribe = h.session.subscribe((event) => {
      if (event.type === "compaction_end") outcomes.push({ reason: event.reason, willRetry: event.willRetry, summary: event.result?.summary });
      if (event.type === "message_end" && event.message.role === "assistant") foregroundStops.push(event.message.stopReason);
    });
    t.after(unsubscribe);
    const operation = h.session.prompt(recent);
    await held.started;
    const before = structuredClone(h.sessionManager.getBranch());
    const kept = before.find((entry) => entry.type === "message" && entry.message.role === "user" &&
      JSON.stringify(entry.message.content).includes("A_ONLY_TASK"))!;
    const retained = h.sessionManager.buildSessionProjection().entries
      .slice(h.sessionManager.buildSessionProjection().entries.findIndex((entry) => entry.sourceEntry.id === kept.id))
      .flatMap((entry) => entry.messages);
    held.release();
    await operation;
    assert.deepEqual(outcomes, [{ reason: "overflow", willRetry: true, summary }]);
    assert.deepEqual(foregroundStops, ["length", "stop"],
      "Exactly two logical foreground attempts occur, independently of maintenance transport requests");
    assert.equal(h.requests.length, path === "native fallback" ? 6 : 5,
      "One interrupted foreground attempt, one compaction, and one native recovery attempt");
    const saved = h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
    assert.equal(saved.fromHook, path === "optimized");
    assert.equal(saved.firstKeptEntryId, kept.id);
    for (const entry of before) assert.deepEqual(h.sessionManager.getEntry(entry.id), entry);
    const contextAfter = h.session.messages.filter((message) => message.role !== "system" && message.role !== "compactionSummary");
    assert.deepEqual(contextAfter.slice(0, -1), retained, "Recovery preserves the exact retained message identities");
    assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
    assert.equal(Boolean(h.requests[3].tools?.length), path !== "native reference");
    if (path === "native fallback") assert.equal(h.requests[4].tools, undefined);
    const recovery = h.requests.at(-1)!;
    assert.match(JSON.stringify(recovery), /B_ONLY_CANARY/);
    assert.doesNotMatch(JSON.stringify(recovery), /FAILED_OVERFLOW_ATTEMPT|REJECTED_OVERFLOW_SUMMARY/);
    assert.match(JSON.stringify(h.session.messages), /RECOVERED_FOREGROUND/);
    assert.doesNotMatch(JSON.stringify(h.session.messages), /FAILED_OVERFLOW_ATTEMPT|REJECTED_OVERFLOW_SUMMARY/);
    assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user" &&
      JSON.stringify(entry.message.content).includes("B_ONLY_CANARY")).length, 1);
    assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, h.session.messages);
    assert.deepEqual(h.extensionErrors, []);
  });
}
