import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createHarness, olderConstraint, olderTask, recent, summary, wrappedSummary } from "./harness.ts";

for (const changesInB of [false, true]) {
  test(changesInB ? "a forced prompt introduced by B uses native fallback" : "idle compaction preserves the established forced system prompt", async (t) => {
    const sandbox: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\nSandbox: workspace access only." }));
    };
    const promptSurgery: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: event.systemPrompt.replace("You are a coding assistant.", "Use registered tools and loaded skills.") +
          (changesInB && "prompt" in event && event.prompt.includes("B_ONLY_CANARY") ? "\nB_DERIVED_STATUS: the recent task is complete." : ""),
      }));
    };
    const h = await createHarness(t, { extensionFactories: [sandbox, promptSurgery],
      replies: ["Recorded.", "Recorded.", "Recent.", changesInB ? summary : wrappedSummary(summary)] });
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    await h.session.waitForIdle();
    const foreground = h.requests[2];
    await h.session.compact();
    assert.equal(h.requests.length, 4);
    const maintenance = h.requests[3];
    const entry = h.sessionManager.getBranch().findLast((value) => value.type === "compaction");
    assert.ok(entry);
    assert.equal(entry.fromHook, !changesInB);
    if (!changesInB) {
      assert.deepEqual(maintenance.tools, foreground.tools);
      assert.deepEqual(maintenance.messages.slice(0, -1), foreground.messages.slice(0, -1));
      assert.ok(!JSON.stringify(maintenance).includes("B_ONLY_CANARY"));
    } else {
      assert.equal(maintenance.tools, undefined, "Only the native summarization request is sent");
    }
  });
}
