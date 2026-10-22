import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, olderConstraint, olderTask, recent, summary, wrappedSummary } from "./harness.ts";

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
