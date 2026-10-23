import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHarness, olderConstraint, olderTask, recent, summary, wrappedSummary, type Reply } from "./harness.ts";

function assertCompactionOpening(content: unknown) {
  const text = typeof content === "string" ? content : (content as Array<{ text: string }>).map((block) => block.text).join("\n");
  assert.ok(text.startsWith("This message contains compaction instructions. It is not part of the conversation to summarize. Summarize only the conversation messages before this message.\n\nDo not record these compaction instructions as user requests, constraints, decisions, or next steps.\n\nFor this response only, do not continue the conversation, answer its questions, or call tools. Output only the requested structured summary.\n\n"));
}

for (const api of ["openai-completions", "anthropic-messages"] as const) {
test(`${api}: compaction reuses the discarded prefix and retains the recent turn unchanged`, async (t) => {
  const { session, sessionManager, requests, extensionErrors } = await createHarness(t, { api, replies: [
    "Recorded the constraint.", "Recorded the unresolved task.", "Kept recent work.", wrappedSummary(summary),
    "Recorded the correction.", "Kept the new turn.", "Preamble\n" + wrappedSummary("## Goal\nContinue the corrected streaming parser.") + "\nTrailing text",
  ] });
  await session.prompt(olderConstraint);
  await session.prompt(olderTask);
  await session.prompt(recent);
  assert.equal(requests.length, 3, "Configuration commands must not call the model");
  const foreground = requests[2];
  const rawBefore = structuredClone(sessionManager.getBranch());
  const recentEntry = rawBefore.find((entry) => entry.type === "message" &&
    entry.message.role === "user" && JSON.stringify(entry.message.content).includes("B_ONLY_CANARY"));
  assert.ok(recentEntry);
  const retainedMessages = sessionManager.buildSessionProjection().entries
    .slice(sessionManager.buildSessionProjection().entries.findIndex((entry) => entry.sourceEntry.id === recentEntry.id))
    .flatMap((entry) => entry.messages);

  await session.compact("Keep the streaming constraint and exact parser path.");

  assert.deepEqual(extensionErrors, []);
  assert.equal(requests.length, 4, "One optimized summary request, without native fallback or warm-up");
  const maintenance = requests[3];
  assertCompactionOpening(maintenance.messages.at(-1)!.content);
  assert.deepEqual(maintenance.system, foreground.system);
  assert.deepEqual(maintenance.tools, foreground.tools);
  assert.ok(maintenance.tools?.length, "Tool declarations must remain present");
  assert.equal(maintenance.model, foreground.model);
  assert.deepEqual(maintenance.messages.slice(0, -1), foreground.messages.slice(0, -1));
  assert.ok(JSON.stringify(maintenance).includes("A_ONLY_CONSTRAINT"));
  assert.ok(JSON.stringify(maintenance).includes("A_ONLY_TASK"));
  assert.ok(!JSON.stringify(maintenance).includes("B_ONLY_CANARY"));
  assert.match(JSON.stringify(maintenance.messages.at(-1)), /Keep the streaming constraint and exact parser path/);
  assert.match(JSON.stringify(maintenance.messages.at(-1)), /Use this EXACT format:/);
  assert.match(JSON.stringify(maintenance.messages.at(-1)), /exactly one <compaction-summary> block, closed by <\/compaction-summary>/);
  assert.match(JSON.stringify(maintenance.messages.at(-1)), /Preserve exact file paths, function names, and error messages/);
  assert.equal(maintenance.max_tokens ?? maintenance.max_completion_tokens, 851);

  const compactions = sessionManager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].fromHook, true);
  assert.equal(compactions[0].firstKeptEntryId, recentEntry.id);
  assert.equal(compactions[0].summary, summary);
  assert.equal(compactions[0].usage?.input, 2000);
  assert.deepEqual(sessionManager.getBranch().slice(0, rawBefore.length), rawBefore);
  const context = sessionManager.buildSessionContext().messages;
  assert.equal(context.filter((message) => message.role === "compactionSummary").length, 1);
  assert.deepEqual(context.filter((message) => message.role !== "system" && message.role !== "compactionSummary"), retainedMessages);
  const sessionFile = sessionManager.getSessionFile();
  assert.ok(sessionFile);
  assert.deepEqual(SessionManager.open(sessionFile).buildSessionContext().messages, context);

  await session.prompt("CORRECTION_IN_A: the parser task is still unfinished. " + "More discussion. ".repeat(100));
  await session.prompt("NEW_B_ONLY_CANARY: retain this later turn. " + "New recent work. ".repeat(100));
  const repeatedForeground = requests.at(-1)!;
  await session.compact();
  const repeatedMaintenance = requests.at(-1)!;
  assertCompactionOpening(repeatedMaintenance.messages.at(-1)!.content);
  assert.equal(requests.length, 7);
  assert.deepEqual(repeatedMaintenance.system, repeatedForeground.system);
  assert.deepEqual(repeatedMaintenance.tools, repeatedForeground.tools);
  assert.deepEqual(repeatedMaintenance.messages.slice(0, -1), repeatedForeground.messages.slice(0, -1));
  assert.equal(JSON.stringify(repeatedMaintenance).split("The conversation history before this point was compacted").length - 1, 1);
  assert.ok(JSON.stringify(repeatedMaintenance).includes("CORRECTION_IN_A"));
  assert.match(JSON.stringify(repeatedMaintenance.messages.at(-1)), /PRESERVE all existing information from the previous summary/);
  assert.match(JSON.stringify(repeatedMaintenance.messages.at(-1)), /remove if resolved/);
  assert.ok(!JSON.stringify(repeatedMaintenance).includes("NEW_B_ONLY_CANARY"));
  assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction" && entry.fromHook).length, 2);
  assert.equal(sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!.summary, "## Goal\nContinue the corrected streaming parser.");
  assert.deepEqual(SessionManager.open(sessionFile).buildSessionContext().messages, session.messages);
});
}

for (const api of ["openai-completions", "anthropic-messages"] as const) {
test(`${api}: extension context messages preserve their foreground representation`, async (t) => {
  const h = await createHarness(t, { api, replies: ["Recorded.", "Recorded.", "Recorded.", wrappedSummary(summary)] });
  await h.session.prompt(olderConstraint);
  h.sessionManager.appendCustomMessageEntry("fixture-extension", "VISIBLE_EXTENSION_CONTEXT", true,
    { privateDetail: "DETAILS_NOT_MODEL_INPUT" });
  h.sessionManager.appendCustomMessageEntry("fixture-extension", [{ type: "text", text: "HIDDEN_EXTENSION_CONTEXT" }], false);
  h.session.refreshContext();
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const foreground = h.requests.at(-1)!;
  await h.session.compact();
  const maintenance = h.requests.at(-1)!;
  assert.equal(h.requests.length, 4);
  assert.deepEqual(maintenance.system, foreground.system);
  assert.deepEqual(maintenance.tools, foreground.tools);
  assert.deepEqual(maintenance.messages.slice(0, -1), foreground.messages.slice(0, -1));
  assert.match(JSON.stringify(maintenance), /VISIBLE_EXTENSION_CONTEXT/);
  assert.match(JSON.stringify(maintenance), /HIDDEN_EXTENSION_CONTEXT/);
  assert.ok(!JSON.stringify(maintenance).includes("DETAILS_NOT_MODEL_INPUT"));
  assert.ok(!JSON.stringify(maintenance).includes("B_ONLY_CANARY"));
  assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, true);
});

test(`${api}: extension context before the initial system message preserves the foreground prefix`, async (t) => {
  const h = await createHarness(t, { api, replies: ["Recorded.", "Recorded.", "Recorded.", wrappedSummary(summary)] });
  h.sessionManager.appendCustomMessageEntry("fixture-extension", "BEFORE_SYSTEM_CONTEXT", true);
  h.session.refreshContext();
  await h.session.prompt(olderConstraint);
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  assert.deepEqual(h.sessionManager.buildSessionProjection().messages.slice(0, 2).map((message) => message.role),
    ["custom", "system"]);
  const foreground = h.requests.at(-1)!;
  await h.session.compact();
  const maintenance = h.requests.at(-1)!;
  assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, true);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.extensionErrors, []);
  assert.deepEqual(maintenance.system, foreground.system);
  assert.deepEqual(maintenance.tools, foreground.tools);
  assert.deepEqual(maintenance.messages.slice(0, -1), foreground.messages.slice(0, -1));
  assert.match(JSON.stringify(maintenance), /BEFORE_SYSTEM_CONTEXT/);
  assert.ok(!JSON.stringify(maintenance).includes("B_ONLY_CANARY"));
});

test(`${api}: shell messages preserve their foreground text and omit excluded executions`, async (t) => {
  const h = await createHarness(t, { api, replies: ["Recorded.", "Recorded.", "Recorded.", wrappedSummary(summary)] });
  await h.session.prompt(olderConstraint);
  h.sessionManager.appendMessage({
    role: "bashExecution", command: "fixture-output", output: "A_SHELL_OUTPUT", exitCode: 7,
    cancelled: false, truncated: true, fullOutputPath: "/fixture/full-output.txt", timestamp: Date.now(),
  });
  h.sessionManager.appendMessage({
    role: "bashExecution", command: "fixture-cancelled", output: "", exitCode: 130,
    cancelled: true, truncated: false, timestamp: Date.now(),
  });
  h.sessionManager.appendMessage({
    role: "bashExecution", command: "fixture-empty", output: "", exitCode: 0,
    cancelled: false, truncated: false, timestamp: Date.now(),
  });
  h.sessionManager.appendMessage({
    role: "bashExecution", command: "EXCLUDED_SHELL_COMMAND", output: "EXCLUDED_SHELL_OUTPUT", exitCode: 0,
    cancelled: false, truncated: false, excludeFromContext: true, timestamp: Date.now(),
  });
  h.session.refreshContext();
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const foreground = h.requests.at(-1)!;
  await h.session.compact();
  const maintenance = h.requests.at(-1)!;
  assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, true);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.extensionErrors, []);
  assert.deepEqual(maintenance.system, foreground.system);
  assert.deepEqual(maintenance.tools, foreground.tools);
  assert.deepEqual(maintenance.messages.slice(0, -1), foreground.messages.slice(0, -1));
  const userTexts = maintenance.messages.filter((message) => message.role === "user")
    .flatMap((message) => typeof message.content === "string"
      ? [{ text: message.content }] : message.content as Array<{ text?: string }>)
    .map((block) => block.text);
  assert.ok(userTexts.includes("Ran `fixture-output`\n```\nA_SHELL_OUTPUT\n```\n\nCommand exited with code 7\n\n[Output truncated. Full output: /fixture/full-output.txt]"));
  assert.ok(userTexts.includes("Ran `fixture-cancelled`\n(no output)\n\n(command cancelled)"));
  assert.ok(userTexts.includes("Ran `fixture-empty`\n(no output)"));
  assert.ok(!JSON.stringify(foreground).includes("EXCLUDED_SHELL"));
  assert.ok(!JSON.stringify(maintenance).includes("EXCLUDED_SHELL"));
  assert.ok(!JSON.stringify(maintenance).includes("B_ONLY_CANARY"));
});

test(`${api}: branch summaries preserve their foreground wrapper`, async (t) => {
  const h = await createHarness(t, { api, replies: ["Recorded.", "Recorded.", "Recorded.", wrappedSummary(summary)] });
  await h.session.prompt(olderConstraint);
  h.sessionManager.branchWithSummary(h.sessionManager.getLeafId(), "A_BRANCH_SUMMARY");
  h.session.refreshContext();
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  const foreground = h.requests.at(-1)!;
  await h.session.compact();
  const maintenance = h.requests.at(-1)!;
  assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, true);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.extensionErrors, []);
  assert.deepEqual(maintenance.system, foreground.system);
  assert.deepEqual(maintenance.tools, foreground.tools);
  assert.deepEqual(maintenance.messages.slice(0, -1), foreground.messages.slice(0, -1));
  const branchText = "The following is a summary of a branch that this conversation came back from:\n\n<summary>\nA_BRANCH_SUMMARY</summary>";
  assert.ok(JSON.stringify(maintenance).includes(JSON.stringify(branchText)));
  assert.ok(!JSON.stringify(maintenance).includes("B_ONLY_CANARY"));
});
}

test("unknown history roles use native compaction without sending an optimized request", async (t) => {
  const h = await createHarness(t, { replies: ["Recorded.", "Recorded.", "Recorded.", summary] });
  await h.session.prompt(olderConstraint);
  h.sessionManager.appendMessage({
    // @ts-expect-error Session files can contain roles from a different host version.
    role: "futureRole", content: [{ type: "text", text: "UNKNOWN_ROLE_CONTEXT" }], timestamp: Date.now(),
  });
  h.session.refreshContext();
  await h.session.prompt(olderTask);
  await h.session.prompt(recent);
  await h.session.compact();
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests.at(-1)!.tools, undefined);
  assert.deepEqual(h.extensionErrors, []);
  assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.fromHook, false);
  assert.ok(h.notifications.some(({ message }) => message.includes("message representation not supported")));
});

for (const api of ["openai-completions", "anthropic-messages"] as const) {
test(`${api}: split-turn compaction uses the dedicated checkpoint and persists the native wrapper`, async (t) => {
  const retainedText = "B_SPLIT_SUFFIX: continue after this assistant message. " + "Retained content. ".repeat(100);
  const turnSummary = "## Original Request\nKeep the parser streaming.\n\n## Progress So Far\n- Read parser.ts.\n\n## Context Needed to Continue\n- No whole-file buffering.";
  const { session, sessionManager, requests, cwd, extensionErrors } = await createHarness(t, { api, replies: [
    { tool: { name: "read", arguments: { path: "parser.ts" } } }, retainedText, "Preamble\n" + wrappedSummary(turnSummary) + "\nTrailing text",
  ] });
  await writeFile(join(cwd, "parser.ts"), "A_TOOL_OUTPUT: parser source. " + "function parse() {}\n".repeat(100));
  await session.prompt(olderConstraint);
  const foreground = requests.at(-1)!;
  const retainedEntry = sessionManager.getBranch().at(-1)!;
  assert.equal(retainedEntry.type, "message");
  await session.compact("Keep the streaming constraint.");
  const maintenance = requests.at(-1)!;
  assert.equal(requests.length, 3, "One optimized request for the split prefix");
  assert.deepEqual(extensionErrors, []);
  assert.deepEqual(maintenance.system, foreground.system);
  assert.deepEqual(maintenance.tools, foreground.tools);
  const expectedPrefix = structuredClone(foreground.messages);
  // Anthropic moves the cache marker from the last tool result to the new instruction.
  if (api === "anthropic-messages") delete (expectedPrefix.at(-1)!.content as Array<Record<string, unknown>>).at(-1)!.cache_control;
  assert.deepEqual(maintenance.messages.slice(0, -1), expectedPrefix);
  assert.ok(JSON.stringify(maintenance).includes("A_TOOL_OUTPUT"));
  assert.ok(!JSON.stringify(maintenance).includes("B_SPLIT_SUFFIX"));
  assertCompactionOpening(maintenance.messages.at(-1)!.content);
  const instruction = JSON.stringify(maintenance.messages.at(-1));
  assert.match(instruction, /Create a concise checkpoint of the user's request and the progress shown above/);
  assert.match(instruction, /## Original Request/);
  assert.match(instruction, /## Progress So Far/);
  assert.match(instruction, /## Context Needed to Continue/);
  assert.match(instruction, /Only summarize information explicitly present above\. Do not infer or recreate later messages\./);
  assert.ok(!instruction.includes("## Goal"), "A split-only checkpoint must not request the generic history format");
  assert.match(instruction, /Keep the streaming constraint\./);
  assert.equal(maintenance.max_tokens ?? maintenance.max_completion_tokens, 544);
  const compaction = sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
  assert.equal(compaction.type, "compaction");
  if (compaction.type !== "compaction") assert.fail("Expected committed compaction");
  assert.equal(compaction.firstKeptEntryId, retainedEntry.id);
  assert.equal(compaction.fromHook, true);
  assert.equal(compaction.summary, `No prior history.\n\n---\n\n**Turn Context (split turn):**\n\n${turnSummary}\n\n<read-files>\nparser.ts\n</read-files>`);
  assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(SessionManager.open(sessionManager.getSessionFile()!).getBranch()
    .findLast((entry) => entry.type === "compaction")?.summary, compaction.summary);
  assert.deepEqual(sessionManager.buildSessionContext().messages.at(-1), retainedEntry.type === "message" ? retainedEntry.message : undefined);
});
}

test("split-only compaction preserves the previous summary verbatim without budgeting a rewrite", async (t) => {
  const priorSummary = "## Goal\nKeep EXACT prior wording.  \n\n## Next Steps\n1. Finish the parser.\n<compaction-summary>Legacy literal markers</compaction-summary>\n";
  const turnSummary = "## Original Request\nKeep parsing streaming.\n\n## Progress So Far\n- Read parser.ts.\n\n## Context Needed to Continue\n- The parser is unfinished.";
  const h = await createHarness(t, { replies: ["Recorded.",
    { tool: { name: "read", arguments: { path: "parser.ts" } } },
    "B_SPLIT_SUFFIX: " + "Retained content. ".repeat(100), "Preamble\n" + wrappedSummary(turnSummary) + "\nTrailing text",
  ] });
  await h.session.prompt(olderTask);
  h.sessionManager.appendCompaction(priorSummary, null, 2020);
  h.session.refreshContext();
  await writeFile(join(h.cwd, "parser.ts"), "A_TOOL_OUTPUT: " + "function parse() {}\n".repeat(100));
  await h.session.prompt(olderConstraint);
  const foreground = h.requests.at(-1)!;
  const kept = h.sessionManager.getBranch().at(-1)!;
  const result = await h.session.compact();
  const maintenance = h.requests.at(-1)!;
  assert.equal(h.requests.length, 4, "Only the turn prefix needs an inference request");
  assert.deepEqual(h.extensionErrors, []);
  assert.deepEqual(maintenance.system, foreground.system);
  assert.deepEqual(maintenance.tools, foreground.tools);
  assert.deepEqual(maintenance.messages.slice(0, -1), foreground.messages);
  assertCompactionOpening(maintenance.messages.at(-1)!.content);
  const instruction = JSON.stringify(maintenance.messages.at(-1));
  assert.match(instruction, /Do not rewrite or repeat the previous summary/);
  assert.match(instruction, /## Original Request/);
  assert.ok(!instruction.includes("## Goal"));
  assert.ok(!instruction.includes("Update the existing structured summary"));
  assert.equal(maintenance.max_tokens ?? maintenance.max_completion_tokens, 544);
  assert.equal(result.summary, `${priorSummary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnSummary}\n\n<read-files>\nparser.ts\n</read-files>`);
  assert.ok(!result.summary.includes("No prior history."));
  assert.equal(result.firstKeptEntryId, kept.id);
  const compactions = h.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 2);
  assert.equal(compactions.at(-1)!.fromHook, true);
  assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, h.session.messages);
});

for (const api of ["openai-completions", "anthropic-messages"] as const) {
for (const withPreviousSummary of [false, true]) {
test(`${api}: mixed split-turn compaction checkpoints all A${withPreviousSummary ? " with a previous summary" : ""}`, async (t) => {
  const splitRequest = "MIXED_SPLIT_REQUEST: preserve exact parser behavior.";
  const turnSummary = "## Original Request\nPreserve parser behavior.\n\n## Progress So Far\n- Read parser.ts.\n\n## Context Needed to Continue\n- Keep the parser streaming.";
  const mixedSummary = `${summary}\n\n## Continuation Context\n${turnSummary}`;
  const h = await createHarness(t, { api, replies: [
    { tool: { name: "read", arguments: { path: "earlier.ts" } } }, "Earlier task recorded.",
    { tool: { name: "read", arguments: { path: "parser.ts" } } },
    "B_MIXED_SUFFIX: " + "Retained content. ".repeat(100), "Preamble\n" + wrappedSummary(mixedSummary) + "\nTrailing text",
  ] });
  if (withPreviousSummary) {
    h.sessionManager.appendCompaction("## Goal\nPRIOR_SUMMARY: keep the EOF test requirement.", null, 2020);
    h.session.refreshContext();
  }
  await writeFile(join(h.cwd, "earlier.ts"), "A_HISTORY_TOOL: earlier work.");
  await writeFile(join(h.cwd, "parser.ts"), "A_SPLIT_TOOL: " + "function parse() {}\n".repeat(100));
  await h.session.prompt(olderTask);
  h.sessionManager.appendCustomMessageEntry("fixture-extension", "A_HISTORY_CUSTOM: earlier extension context.", false);
  h.session.refreshContext();
  await h.session.prompt(splitRequest);
  const foreground = h.requests.at(-1)!;
  const rawBefore = structuredClone(h.sessionManager.getBranch());
  const kept = rawBefore.at(-1)!;
  const result = await h.session.compact("Keep the EOF test requirement.");
  const maintenance = h.requests.at(-1)!;
  assert.equal(h.requests.length, 5, "History and split prefix share one optimized request");
  assert.deepEqual(h.extensionErrors, []);
  assert.deepEqual(maintenance.system, foreground.system);
  assert.deepEqual(maintenance.tools, foreground.tools);
  const expectedPrefix = structuredClone(foreground.messages);
  if (api === "anthropic-messages") delete (expectedPrefix.at(-1)!.content as Array<Record<string, unknown>>).at(-1)!.cache_control;
  assert.deepEqual(maintenance.messages.slice(0, -1), expectedPrefix);
  assert.ok(!JSON.stringify(maintenance).includes("B_MIXED_SUFFIX"));
  const content = maintenance.messages.at(-1)!.content;
  assertCompactionOpening(content);
  const instruction = typeof content === "string" ? content : (content as Array<{ text: string }>).map((block) => block.text).join("\n");
  assert.match(instruction, /checkpoint of all conversation messages above, including any previous summary/);
  assert.match(instruction, /## Continuation Context/);
  assert.ok(instruction.includes(`For Continuation Context, focus on the turn that begins with this user request:\n\n<split-turn-request>\n${splitRequest}\n</split-turn-request>`));
  assert.doesNotMatch(instruction, /user-role message \d|content block \d|Count all user-role messages|earlier blocks belong to history/);
  assert.match(instruction, /Use the checkpoint format below, followed by the Continuation Context section described afterward:/);
  assert.ok(!instruction.includes("Use this EXACT format:"));
  const historyInstructions = instruction.slice(0, instruction.indexOf("## Continuation Context"));
  assert.match(historyInstructions, /## Goal/);
  if (withPreviousSummary) {
    assert.match(historyInstructions, /PRESERVE all existing information from the previous summary/);
    assert.match(historyInstructions, /remove if resolved/);
    assert.ok(JSON.stringify(maintenance).includes("PRIOR_SUMMARY"));
  }
  const turnInstructions = instruction.slice(instruction.indexOf("## Continuation Context"));
  assert.match(turnInstructions, /user's request quoted above/);
  assert.match(turnInstructions, /the progress made on that request/);
  assert.match(turnInstructions, /unresolved questions, blockers, or unfinished work as of the end of the conversation messages above/);
  assert.match(turnInstructions, /Include earlier dependencies when needed/);
  assert.match(turnInstructions, /Avoid repeating information already covered in the checkpoint/);
  assert.match(turnInstructions, /Only describe information present in those conversation messages; do not speculate about what happened afterward/);
  assert.ok(!instruction.includes("# History Summary"));
  assert.ok(!instruction.includes("# Turn Context"));
  assert.match(instruction, /Keep the EOF test requirement\./);
  assert.match(instruction, /Place all sections inside that single block/);
  assert.equal(maintenance.max_tokens ?? maintenance.max_completion_tokens, 1363);
  assert.equal(result.summary, `${mixedSummary}\n\n<read-files>\nearlier.ts\nparser.ts\n</read-files>`);
  assert.ok(!result.summary.includes("No prior history."));
  assert.equal(result.firstKeptEntryId, kept.id);
  assert.deepEqual(h.sessionManager.getBranch().slice(0, rawBefore.length), rawBefore);
  const compactions = h.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, withPreviousSummary ? 2 : 1);
  assert.equal(compactions.at(-1)!.fromHook, true);
  assert.deepEqual(h.sessionManager.buildSessionContext().messages.at(-1), kept.type === "message" ? kept.message : undefined);
  assert.deepEqual(SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages, h.session.messages);
});
}
}

for (const api of ["openai-completions", "anthropic-messages"] as const) {
for (const repeatedWithinRequest of [false, true]) {
test(`${api}: a shared request prefix expands the quote${repeatedWithinRequest ? " within one text block" : " across requests"}`, async (t) => {
  const shared = "Shared request context. ".repeat(8).slice(0, 160);
  const splitRequest = shared + (repeatedWithinRequest ? shared : "") + "CURRENT_REQUEST: keep parser streaming. " + "Preserve EOF details. ".repeat(20);
  const h = await createHarness(t, { api, replies: [
    "Earlier request recorded.", { tool: { name: "read", arguments: { path: "parser.ts" } } },
    "B_SPLIT_SUFFIX: " + "Retained content. ".repeat(100), wrappedSummary(summary),
  ] });
  await writeFile(join(h.cwd, "parser.ts"), "A_TOOL_OUTPUT: " + "function parse() {}\n".repeat(100));
  await h.session.prompt(repeatedWithinRequest ? olderTask : shared + "EARLIER_REQUEST: record the completed work.");
  await h.session.prompt(splitRequest);
  const foreground = h.requests.at(-1)!;
  await h.session.compact();
  assert.equal(h.requests.length, 4, "Only one optimized maintenance request follows foreground");
  const maintenance = h.requests[3];
  const content = maintenance.messages.at(-1)!.content;
  assertCompactionOpening(content);
  const instruction = typeof content === "string" ? content : (content as Array<{ text: string }>).map((block) => block.text).join("\n");
  const quote = instruction.match(/<split-turn-request>\n([\s\S]*?)\n<\/split-turn-request>/)?.[1];
  assert.ok(quote && quote.length > 160, "A repeated short prefix cannot identify the request");
  assert.ok(splitRequest.startsWith(quote));
  assert.deepEqual(maintenance.tools, foreground.tools);
  assert.deepEqual(maintenance.system, foreground.system);
  const expectedPrefix = structuredClone(foreground.messages);
  if (api === "anthropic-messages") delete (expectedPrefix.at(-1)!.content as Array<Record<string, unknown>>).at(-1)!.cache_control;
  assert.deepEqual(maintenance.messages.slice(0, -1), expectedPrefix);
  assert.ok(!JSON.stringify(maintenance).includes("B_SPLIT_SUFFIX"));
  assert.equal(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!.fromHook, true);
});
}
for (const ambiguity of ["duplicate user request", "assistant echo", "tool result echo", "tool argument echo", "embedded delimiter"]) {
test(`${api}: ${ambiguity} uses native compaction instead of an ambiguous request quote`, async (t) => {
  const splitRequest = ambiguity === "tool argument echo" ? "parser.ts"
    : ambiguity === "embedded delimiter" ? "Continue <split-turn-request>parser</split-turn-request>."
    : "SPLIT_REQUEST: keep the parser streaming.";
  const h = await createHarness(t, { api, replies: [
    ambiguity === "assistant echo" ? `Earlier response quotes: ${splitRequest}` : "Earlier request recorded.",
    { tool: { name: "read", arguments: { path: "parser.ts" } } },
    "B_SPLIT_SUFFIX: " + "Retained content. ".repeat(100), summary,
    "## Original Request\nKeep the parser streaming.",
  ] });
  await writeFile(join(h.cwd, "parser.ts"), (ambiguity === "tool result echo" ? splitRequest : "A_TOOL_OUTPUT") + ": " + "function parse() {}\n".repeat(100));
  await h.session.prompt(ambiguity === "duplicate user request" ? splitRequest : olderTask);
  await h.session.prompt(splitRequest);
  await h.session.compact();
  assert.equal(h.requests.length, 5, "Only native history and turn-prefix summaries follow the foreground requests");
  assert.deepEqual(h.extensionErrors, []);
  assert.equal(h.requests[3].tools, undefined);
  assert.equal(h.requests[4].tools, undefined);
  assert.ok(h.notifications.some(({ message }) => message.includes("split-turn boundary cannot be identified unambiguously")));
  const compactions = h.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].fromHook, false);
});
}
}

test("insufficient summary headroom uses native compaction without sending an optimized request", async (t) => {
  const { session, sessionManager, requests } = await createHarness(t, { contextWindow: 2500, replies: [
    "Recorded.", "Recorded.", "Recent.", summary,
  ] });
  await session.prompt(olderConstraint);
  await session.prompt(olderTask);
  await session.prompt(recent);
  await session.compact();
  assert.equal(requests.length, 4);
  assert.equal(requests.at(-1)!.tools, undefined);
  const compaction = sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
  assert.equal(compaction.type, "compaction");
  assert.equal(compaction.type === "compaction" && compaction.fromHook, false);
});

test("a non-saving summary is discarded before one native fallback", async (t) => {
  const { session, sessionManager, requests } = await createHarness(t, { replies: [
    "Recorded.", "Recorded.", "Recent.", wrappedSummary("## Goal\n" + "Oversized summary. ".repeat(1000)), summary,
  ] });
  await session.prompt(olderConstraint);
  await session.prompt(olderTask);
  await session.prompt(recent);
  await session.compact();
  assert.equal(requests.length, 5);
  assert.ok(requests[3].tools?.length);
  assert.equal(requests[4].tools, undefined);
  const compactions = sessionManager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].fromHook, false);
  assert.equal(compactions[0].summary, summary);
});

test("file metadata follows A through optimized repeats, native fallback, and reopen", async (t) => {
  const { session, sessionManager, requests, cwd } = await createHarness(t, { replies: [
    { tool: { name: "read", arguments: { path: "older.ts" } } },
    { tool: { name: "write", arguments: { path: "changed.ts", content: "export const changed = true;" } } },
    "Earlier files inspected and changed.",
    { tool: { name: "read", arguments: { path: "recent.ts" } } }, "Recent file inspected.", wrappedSummary(summary),
    "Next turn.", wrappedSummary(summary), "Last turn.", "", summary,
  ] });
  await writeFile(join(cwd, "older.ts"), "export const old = true;");
  await writeFile(join(cwd, "recent.ts"), "export const recent = true;");
  await session.prompt(olderConstraint);
  await session.prompt(recent);
  const first = await session.compact();
  assert.deepEqual(first.details, { cachewiseCompact: 1, readFiles: ["older.ts"], modifiedFiles: ["changed.ts"] });
  assert.match(first.summary, /<read-files>\nolder.ts\n<\/read-files>/);
  assert.ok(!first.summary.includes("recent.ts"), "Retained-only file activity must not enter the summary");
  await session.prompt("NEXT_RECENT: " + recent);
  const second = await session.compact();
  assert.deepEqual(second.details, { cachewiseCompact: 1, readFiles: ["older.ts", "recent.ts"], modifiedFiles: ["changed.ts"] });
  await session.prompt("LAST_RECENT: " + recent);
  const third = await session.compact();
  assert.equal(requests.length, 11);
  assert.deepEqual(third.details, { readFiles: ["older.ts", "recent.ts"], modifiedFiles: ["changed.ts"] });
  assert.match(third.summary, /<modified-files>\nchanged.ts\n<\/modified-files>/);
  const reopened = SessionManager.open(sessionManager.getSessionFile()!);
  assert.deepEqual(reopened.buildSessionContext().messages, session.messages);
  const compactions = reopened.getBranch().filter((entry) => entry.type === "compaction");
  assert.deepEqual(compactions.map((entry) => entry.fromHook), [true, true, false]);
  assert.deepEqual(compactions.at(-1)!.details, third.details);
});

for (const [name, reply] of Object.entries<Reply>({
  empty: { text: "" },
  truncated: { text: wrappedSummary("## Goal\nPartial"), stop: "length" },
  "tool request": { tool: { name: "write", arguments: { path: "maintenance-side-effect.ts", content: "not allowed" } } },
})) {
  test(`${name} summary falls back once without executing tools or saving the rejected candidate`, async (t) => {
    const { session, sessionManager, requests, cwd } = await createHarness(t, { replies: [
      "Recorded.", "Recorded.", "Recent.", reply, summary,
    ] });
    await session.prompt(olderConstraint);
    await session.prompt(olderTask);
    await session.prompt(recent);
    await session.compact();
    assert.equal(requests.length, 5);
    assert.equal(requests[4].tools, undefined);
    const compactions = sessionManager.getBranch().filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].fromHook, false);
    assert.equal(compactions[0].summary, summary);
    await assert.rejects(access(join(cwd, "maintenance-side-effect.ts")), { code: "ENOENT" });
  });
}

test("Anthropic summary preserves Pi's configured thinking budget", async (t) => {
  const { session, requests } = await createHarness(t, {
    api: "anthropic-messages", reasoning: true,
    settings: { thinkingBudgets: { low: 1024 }, transport: "sse", httpIdleTimeoutMs: 45000 },
    replies: ["Recorded.", "Recorded.", "Recent.", wrappedSummary(summary)],
  });
  session.setThinkingLevel("low");
  await session.prompt(olderConstraint);
  await session.prompt(olderTask);
  await session.prompt(recent);
  const foreground = requests.at(-1)!;
  await session.compact();
  assert.equal((foreground.thinking as { budget_tokens: number }).budget_tokens, 1024);
  assert.deepEqual(requests.at(-1)!.thinking, foreground.thinking);
  assert.deepEqual(requests.at(-1)!.system, foreground.system);
  assert.deepEqual(requests.at(-1)!.tools, foreground.tools);
});


for (const contextWindow of [8566, 32768]) {
  test(`Anthropic preserves the native answer allowance with thinking (${contextWindow} context tokens)`, async (t) => {
    const h = await createHarness(t, {
      api: "anthropic-messages", reasoning: true, reserveTokens: 2048, contextWindow,
      replies: ["Recorded.", "Recorded.", "Recent.", wrappedSummary(summary)],
    });
    h.session.setThinkingLevel("minimal");
    await h.session.prompt(olderConstraint);
    await h.session.prompt(olderTask);
    await h.session.prompt(recent);
    const foregroundThinking = h.requests[2].thinking;
    await h.session.compact();
    assert.equal(h.requests.length, 4, "A rejected optimized request must not reach HTTP or retry native compaction");
    const request = h.requests[3];
    assert.deepEqual(request.thinking, foregroundThinking);
    assert.equal((request.thinking as { budget_tokens: number }).budget_tokens, 1024);
    if (contextWindow === 32768) {
      assert.equal(request.max_tokens, 2694,
        "Keep 1638 answer tokens and 1024 thinking tokens, plus 32 wrapper tokens for optimization");
    } else {
      // Pi 1.4 omits the reserve-token cap and lets the provider adapter set the native limit.
      assert.ok(request.max_tokens === 2662 || request.max_tokens === 3010);
    }
    const entry = h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
    assert.equal(entry.fromHook, contextWindow === 32768);
    assert.equal(Boolean(request.tools?.length), contextWindow === 32768);
    assert.deepEqual(h.extensionErrors, []);
  });
}

test("mixed split-turn budgets that cannot fit one response use native summarization", async (t) => {
  const h = await createHarness(t, { reserveTokens: 8192, replies: [
    "Earlier task recorded.", { tool: { name: "read", arguments: { path: "parser.ts" } } },
    "B_SPLIT_SUFFIX: " + "Retained content. ".repeat(100), summary, summary,
  ] });
  await writeFile(join(h.cwd, "parser.ts"), "A_TOOL_OUTPUT: " + "function parse() {}\n".repeat(100));
  await h.session.prompt(olderTask);
  await h.session.prompt(olderConstraint);
  await h.session.compact();
  const entry = h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
  assert.equal(entry.fromHook, false);
  assert.equal(h.requests.length, 5, "Native history and split-prefix summaries preserve both budgets");
  for (const request of h.requests.slice(3)) {
    assert.equal(request.tools, undefined);
    assert.equal(request.max_tokens ?? request.max_completion_tokens, 4096);
  }
});
