import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OperationMetadata } from "../extensions/cachewise-compact/controls.ts";
import { createHarness, olderConstraint, olderTask, recent, summary, wrappedSummary, type WireRequest } from "./harness.ts";

test("installation is off with no provider selections and no Pi settings changes", async (t) => {
  const h = await createHarness(t, { configure: false });
  assert.ok(h.session.extensionRunner.getCommand("cachewise-compact"));
  assert.equal(h.session.extensionRunner.getCommand("cache-compact"), undefined);
  const hostSettings = await readFile(join(h.agentDir, "settings.json"), "utf8");
  await h.session.prompt("/cachewise-compact status");
  assert.match(h.notifications.at(-1)!.message, /off/i);
  assert.match(h.notifications.at(-1)!.message, /selected: none/i);
  assert.match(h.notifications.at(-1)!.message, /current: user-chosen-provider/i);
  assert.equal(await readFile(join(h.agentDir, "settings.json"), "utf8"), hostSettings);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.extensionErrors, []);
});

test("provider listing identifies unavailable saved IDs without leaking endpoint or credentials", async (t) => {
  const h = await createHarness(t, { configure: false });
  await writeFile(join(h.agentDir, "cachewise-compact.json"), JSON.stringify({ enabled: false, providers: ["retired-provider"] }));
  await h.session.reload();
  await h.session.prompt("/cachewise-compact providers");
  const listing = h.notifications.at(-1)!.message;
  assert.match(listing, /user-chosen-provider.*available.*current/i);
  assert.match(listing, /retired-provider.*unavailable.*selected/i);
  assert.doesNotMatch(listing, /dummy-local-test-key|127\.0\.0\.1|https?:/);
  await h.session.prompt("/cachewise-compact provider remove retired-provider");
  await h.session.prompt("/cachewise-compact provider add");
  h.modelRuntime.registerProvider("another-provider", {
    api: h.model.api, baseUrl: h.model.baseUrl, apiKey: "dummy-second-key",
    models: [{ ...h.model, id: "other-model" }],
  });
  const nextModel = h.modelRuntime.getModel("another-provider", "other-model")!;
  assert.ok(nextModel);
  await h.session.setModel(nextModel);
  await h.session.prompt("/cachewise-compact status");
  assert.match(h.notifications.at(-1)!.message, /Selected: user-chosen-provider\n/);
  assert.ok(h.notifications.at(-1)!.message.includes(`Current: ${nextModel.provider}`));
  assert.doesNotMatch(h.notifications.at(-1)!.message, /retired-provider/);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.extensionErrors, []);
});

test("provider selections are exact and idempotent, survive reload, and are preserved by off", async (t) => {
  const h = await createHarness(t, { configure: false });
  const hostSettings = await readFile(join(h.agentDir, "settings.json"), "utf8");
  await h.session.prompt("/cachewise-compact on");
  assert.match(h.notifications.at(-1)!.message, /inactive/i);
  await h.session.prompt("/cachewise-compact provider add");
  await h.session.prompt("/cachewise-compact provider add user-chosen-provider");
  await h.session.prompt("/cachewise-compact provider add USER-CHOSEN-PROVIDER");
  assert.equal(h.notifications.at(-1)!.type, "error");
  await h.session.prompt("/cachewise-compact off");
  await h.session.reload();
  await h.session.prompt("/cachewise-compact status");
  assert.match(h.notifications.at(-1)!.message, /off/i);
  assert.match(h.notifications.at(-1)!.message, /Selected: user-chosen-provider\n/);
  await h.session.prompt("/cachewise-compact provider remove");
  await h.session.prompt("/cachewise-compact provider remove user-chosen-provider");
  await h.session.reload();
  await h.session.prompt("/cachewise-compact status");
  assert.match(h.notifications.at(-1)!.message, /Selected: none/);
  assert.equal(await readFile(join(h.agentDir, "settings.json"), "utf8"), hostSettings);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.extensionErrors, []);
});

test("help explains terminal and RPC commands and status reports inactive selections", async (t) => {
  const h = await createHarness(t, { configure: false });
  await h.session.prompt("/cachewise-compact help");
  const help = h.notifications.at(-1)!.message;
  for (const command of ["on", "off", "providers", "provider add [id]", "provider remove [id]", "status"]) {
    assert.ok(help.includes(`/cachewise-compact ${command}`));
  }
  assert.match(help, /\/compact-native \[focus\]/);
  assert.match(help, /RPC.*prompt/i);
  await h.session.prompt("/cachewise-compact on");
  await h.session.prompt("/cachewise-compact status");
  assert.match(h.notifications.at(-1)!.message, /inactive.*no providers/i);
});

test("native bypass forwards focus exactly, preserves Pi's request, and affects only one invocation", async (t) => {
  const focus = "  Keep  exact spacing.\nFocus on src/parser.ts.  ";
  let nativeRequest: WireRequest;
  await t.test("ordinary Pi reference", async (t) => {
    const h = await createHarness(t, { configure: false, replies: ["Recorded.", "Recorded.", "Recent.", summary] });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    await h.session.compact(focus);
    nativeRequest = h.requests[3];
    assert.doesNotMatch(JSON.stringify(nativeRequest), /compaction-summary/);
  });
  await t.test("one-time bypass", async (t) => {
    const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.", summary,
      "Continued.", "Latest.", wrappedSummary("## Goal\nContinue the parser.")] });
    assert.ok(h.session.extensionRunner.getCommand("compact-native"), "Native bypass command is available");
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    const settings = await readFile(join(h.agentDir, "cachewise-compact.json"), "utf8");
    await h.session.prompt(`/compact-native ${focus}`);
    assert.deepEqual(h.requests[3], nativeRequest);
    assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, false);
    assert.equal(await readFile(join(h.agentDir, "cachewise-compact.json"), "utf8"), settings);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    await h.session.compact();
    assert.ok(h.requests[6].tools?.length, "The next ordinary compaction optimizes");
    assert.equal(h.requests.length, 7);
    assert.deepEqual(h.extensionErrors, []);
  });
});

test("native bypass reports when another extension supplies the summary", async (t) => {
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent."] });
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const extensions = join(h.agentDir, "extensions");
  await mkdir(extensions, { recursive: true });
  // A real loaded extension supplies the summary without making an inference request.
  await writeFile(join(extensions, "other-compaction.ts"), `export default function (pi) {
    pi.on("session_before_compact", (event) => ({ compaction: {
      summary: ${JSON.stringify(summary)},
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    } }));
  }`);
  await h.session.reload();
  await h.session.prompt("/cachewise-compact status");
  assert.match(h.notifications.at(-1)!.message, /Availability: eligible when request compatibility is established/);
  h.notifications.length = 0;
  const settings = await readFile(join(h.agentDir, "cachewise-compact.json"), "utf8");
  await h.session.prompt("/compact-native");
  const entry = h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
  assert.ok(entry, "The other extension can supply the committed summary");
  assert.equal(entry.summary, summary);
  assert.equal(entry.fromHook, true);
  assert.ok(h.notifications.some(({ message }) => /Another extension supplied this summary/.test(message)));
  assert.ok(h.notifications.every(({ type }) => type !== "error"));
  assert.equal(await readFile(join(h.agentDir, "cachewise-compact.json"), "utf8"), settings);
  assert.equal(h.requests.length, 3, "Native bypass makes no optimized inference attempt");
  assert.deepEqual(h.extensionErrors, []);
});

test("operation metadata is saved only after commit, reports unknown cache data, and survives reopen", async (t) => {
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent."] });
  h.replies.push({ text: wrappedSummary(summary), beforeReply: () => {
    assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "custom").length, 0,
      "Pending metadata must not change the candidate's source fingerprint");
  } });
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  await h.session.compact();
  await h.session.prompt("/cachewise-compact status");
  const status = h.notifications.at(-1)!.message;
  assert.match(status, /Last: optimized/);
  assert.match(status, /Trigger: manual/);
  assert.match(status, /Summary usage: input 2000, output 20/);
  assert.match(status, /Cache.*read unknown.*write unknown/);
  const last = h.sessionManager.getBranch().at(-1)!;
  assert.equal(last.type, "custom");
  if (last.type !== "custom") assert.fail("Expected terminal operation metadata");
  const data = last.data as OperationMetadata;
  assert.equal(data.version, 1);
  assert.ok(data.durationMs !== null && data.durationMs >= 0);
  assert.ok(data.contextTokensBefore !== null && data.contextTokensAfter !== null &&
    data.contextTokensBefore > data.contextTokensAfter && data.contextTokensAfter > 0);
  assert.equal(data.discardedAttemptUsage, null, "Accepted usage must not be counted twice");
  assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).getBranch().at(-1), last);
  await h.session.reload();
  await h.session.prompt("/cachewise-compact status");
  assert.equal(h.notifications.at(-1)!.message, status);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.extensionErrors, []);
});

test("native fallback keeps rejected-attempt usage separate from saved summary usage", async (t) => {
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.",
    { text: "Truncated candidate", stop: "length" }, summary] });
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  await h.session.compact();
  await h.session.prompt("/cachewise-compact status");
  const status = h.notifications.at(-1)!.message;
  assert.match(status, /Last: native-fallback/);
  assert.match(status, /Summary usage: input 2000, output 20/);
  assert.match(status, /Discarded attempt usage \(separate from Pi totals\): input 2000, output 20/);
  assert.equal(h.requests.length, 5);
  assert.ok(h.requests[3].tools?.length);
  assert.equal(h.requests[4].tools, undefined);
  assert.equal(h.session.getSessionStats().tokens.input, 8000);
  assert.deepEqual(h.extensionErrors, []);
});

test("a native no-op is recorded and cannot arm bypass for a later compaction", async (t) => {
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.", wrappedSummary(summary)] });
  await h.session.prompt("/compact-native focus on the empty session");
  await h.session.prompt("/cachewise-compact status");
  assert.match(h.notifications.at(-1)!.message, /Last: no-op \(explicit native request\)/);
  assert.equal(h.requests.length, 0);
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  await h.session.compact();
  assert.ok(h.requests[3].tools?.length);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.extensionErrors, []);
});

for (const outcome of ["failed", "cancelled"] as const) {
  test(`a ${outcome} native bypass preserves history and cannot affect the next invocation`, async (t) => {
    const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent."] });
    h.replies.push(outcome === "failed" ? { text: "Truncated native summary", stop: "length" }
      : { text: summary, beforeReply: () => h.session.abortCompaction() }, wrappedSummary(summary));
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    const messages = structuredClone(h.session.messages);
    const settings = await readFile(join(h.agentDir, "cachewise-compact.json"), "utf8");
    await h.session.prompt("/compact-native keep the constraint");
    await h.session.prompt("/cachewise-compact status");
    assert.ok(h.notifications.at(-1)!.message.includes(`Last: ${outcome} (explicit native request)`));
    assert.equal(h.requests.length, 4, "Explicit native failure never retries with optimization");
    assert.equal(h.requests[3].tools, undefined);
    assert.deepEqual(h.session.messages, messages);
    assert.equal(await readFile(join(h.agentDir, "cachewise-compact.json"), "utf8"), settings);
    await h.session.compact();
    assert.ok(h.requests[4].tools?.length);
    assert.equal(h.requests.length, 5);
    assert.deepEqual(h.extensionErrors, []);
  });
}

test("native commands rejected while busy do not cancel or bypass later compaction", async (t) => {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.",
    { text: wrappedSummary(summary), beforeReply: async () => { markStarted(); await released; } },
    "Continued.", "Latest.", wrappedSummary("## Goal\nContinue the parser.")] });
  t.after(() => release());
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const current = h.session.compact();
  await started;
  await h.session.prompt("/compact-native must not run later");
  assert.match(h.notifications.at(-1)!.message, /busy/i);
  release();
  await current;
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  await h.session.compact();
  assert.equal(h.requests.length, 7);
  assert.ok(h.requests[3].tools?.length);
  assert.ok(h.requests[6].tools?.length);
  assert.deepEqual(h.extensionErrors, []);
});

test("a summary supplied by another extension is never reported as native", async (t) => {
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent."],
    extensionFactories: [(pi) => {
      pi.on("session_before_compact", (event) => ({ compaction: {
        summary: "Another extension's summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      } }));
    }],
  });
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  await h.session.prompt("/compact-native");
  assert.ok(!h.notifications.some((notice) => notice.message === "Native compaction completed."));
  await h.session.prompt("/cachewise-compact status");
  assert.match(h.notifications.at(-1)!.message, /Last: other-extension/);
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.extensionErrors, []);
});

test("a competing built-in compaction cancels the first, completes the second, and leaves controls idle", async (t) => {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recent.",
    { text: "Discard this candidate", beforeReply: async () => { markStarted(); await released; } },
    wrappedSummary(summary)] });
  t.after(() => release());
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const first = h.session.compact().then(() => "completed", (error: Error) => error.message);
  await started;
  const second = h.session.compact();
  await second;
  release();
  assert.match(await first, /cancel|abort/i);
  assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(h.session.isIdle, true);
  h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 100000 } });
  const notices = h.notifications.length;
  await h.session.prompt("/compact-native");
  assert.ok(!h.notifications.slice(notices).some((notice) => /Busy:/.test(notice.message)));
  assert.equal(h.requests.length, 5);
  assert.deepEqual(h.extensionErrors, []);
});

test("native bypass is consumed before a compaction-end subscriber starts an ordinary operation", async (t) => {
  const h = await createHarness(t, { keepRecentTokens: 600, replies: ["Recorded.", "Recorded.", "Recent.", summary,
    wrappedSummary("## Goal\nContinue with the remaining parser work.")] });
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  let next: Promise<unknown> | undefined;
  const unsubscribe = h.session.subscribe((event) => {
    if (event.type !== "compaction_end" || !event.result || next) return;
    h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 100 } });
    next = h.session.compact();
  });
  t.after(unsubscribe);
  await h.session.prompt("/compact-native keep the parser constraint");
  assert.ok(next, "The subscriber starts an ordinary compaction before native command callbacks finish");
  await next;
  const metadata = h.sessionManager.getBranch().filter((entry) => entry.type === "custom" &&
    entry.customType === "cachewise-compact-operation").map((entry) => entry.type === "custom" ? entry.data as OperationMetadata : undefined);
  assert.equal(metadata.length, 2);
  assert.equal(metadata[0]?.nativeRequested, true);
  assert.equal(metadata[1]?.nativeRequested, false, "An inherited async scope must not bypass a second invocation");
  assert.notEqual(metadata[1]?.outcome, "native-requested");
  assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 2);
  assert.equal(h.requests.length, 5);
  assert.deepEqual(h.extensionErrors, []);
});
