import { registerControls } from "./controls.ts";
import { capturePayload, checkPayload, type PayloadSnapshot } from "./fidelity.ts";
import { getCurrentSystemMessage, getCurrentSystemPrompt, normalizeContext } from "@earendil-works/pi-ai";
import type { Message, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionProjection } from "@earendil-works/pi-coding-agent";

interface FileDetails {
  cachewiseCompact: 1;
  readFiles: string[];
  modifiedFiles: string[];
}

const summaryOpen = "<compaction-summary>";
const summaryClose = "</compaction-summary>";
// Extra output tokens for both delimiters and separating whitespace. Keep the
// native substantive-summary and provider thinking allowances intact.
const summaryWrapperTokens = 32;

function extractSummary(text: string): string | undefined {
  const opening = text.indexOf(summaryOpen);
  const closing = text.indexOf(summaryClose);
  if (opening < 0 || closing < opening + summaryOpen.length ||
    text.indexOf(summaryOpen, opening + summaryOpen.length) !== -1 ||
    text.indexOf(summaryClose, closing + summaryClose.length) !== -1) return undefined;
  return text.slice(opening + summaryOpen.length, closing).trim() || undefined;
}

// Match Pi 1.0.2 core/compaction/compaction.ts estimateTokens without a
// runtime coding-agent import. Keep this adapter aligned with the supported host.
function estimateTokens(message: SessionProjection["messages"][number]): number {
  if (message.role === "compactionSummary" || message.role === "branchSummary") return Math.ceil(message.summary.length / 4);
  if (message.role === "bashExecution") return Math.ceil((message.command.length + message.output.length) / 4);
  let chars = 0;
  if (typeof message.content === "string") chars = message.content.length;
  else for (const block of message.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "image") chars += 4800;
    else if (block.type === "thinking") chars += block.thinking.length;
    else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
  }
  if (message.role === "system") {
    for (const section of Object.values(message.sections ?? {})) chars += section?.length ?? 0;
    if (message.toolsAdded) chars += JSON.stringify(message.toolsAdded).length;
  }
  return Math.ceil(chars / 4);
}

// Pi 1.0.2 SettingsManager timeout normalization and SDK buildRequestOptions defaults.
function timeoutSetting(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw new Error("Invalid Pi timeout setting.");
  return Math.floor(number);
}

function requestOptions(pi: ExtensionAPI): SimpleStreamOptions {
  const host = pi.getSettings();
  const idleTimeout = timeoutSetting(host.httpIdleTimeoutMs) ?? 300000;
  const thinking = pi.getThinkingLevel();
  return {
    reasoning: thinking === "off" ? undefined : thinking,
    thinkingBudgets: host.thinkingBudgets ? { ...host.thinkingBudgets } : undefined,
    transport: host.transport ?? "auto",
    timeoutMs: host.retry?.provider?.timeoutMs ?? (idleTimeout === 0 ? 2147483647 : idleTimeout),
    websocketConnectTimeoutMs: timeoutSetting(host.websocketConnectTimeoutMs),
    maxRetries: host.retry?.provider?.maxRetries,
    maxRetryDelayMs: host.retry?.provider?.maxRetryDelayMs ?? 60000,
  };
}

// Pi 1.0.2 summary templates. Keep the conversation prefix intact and place the
// summarizer role instruction here instead of replacing the system prompt.
const summarizerInstruction = `Do NOT continue the conversation. Do NOT respond to any questions in the conversation or call tools. ONLY output the structured summary.

`;
const summaryInstruction = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const updateSummaryInstruction = `The messages above include the previous summary and NEW conversation messages to incorporate into it.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const turnPrefixInstruction = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

function describeSplitBoundary(start: Message | undefined, payload: PayloadSnapshot | undefined): string | undefined {
  if (start?.role !== "user") return undefined;
  const first = typeof start.content === "string" ? start.content :
    start.content[0]?.type === "text" ? start.content[0].text : undefined;
  if (!first?.trim()) return undefined;
  // Use the observed provider representation: custom messages become users, and
  // Anthropic also sends tool results as users. Do not guess from raw user entries.
  const matches = (payload?.messages ?? []).filter((message) => message.role === "user")
    .flatMap((message, userIndex) => (Array.isArray(message.content) ? message.content : [])
      .flatMap((block, blockIndex) => block && typeof block === "object" && !Array.isArray(block) &&
        block.type === "text" && block.text === first ? [{ userIndex, blockIndex }] : []));
  if (matches.length !== 1) return undefined;
  const { userIndex, blockIndex } = matches[0];
  return `The split-turn boundary is user-role message ${userIndex + 1}, content block ${blockIndex + 1}, whose text starts with ${JSON.stringify(first.slice(0, 160))}.
Count all user-role messages above, including summaries, extension context, and tool results. Count messages and content blocks from 1. The boundary includes that block; earlier blocks belong to history.`;
}

export default function cachewiseCompact(pi: ExtensionAPI) {
  // Forced prompts are run-local in Pi. Remember an established foreground prompt,
  // not the base prompt returned by getSystemPrompt() after the run has settled.
  let observed: { session: string; anchor: string | null; prompt: string; forced: boolean;
    system: string; configuration: string; payload?: PayloadSnapshot } | undefined;
  let compacting = false;
  const systemIdentity = (messages: SessionProjection["messages"]) => {
    const system = getCurrentSystemMessage(messages);
    return JSON.stringify(system && { content: system.content, sections: system.sections, toolsAdded: system.toolsAdded });
  };
  pi.on("before_provider_request", (event, ctx) => {
    if (compacting) return;
    const messages = ctx.sessionManager.buildSessionProjection().messages;
    const next = { session: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(),
      prompt: ctx.getSystemPrompt(), forced: ctx.getSystemPrompt() !== getCurrentSystemPrompt(messages),
      system: systemIdentity(messages), configuration: JSON.stringify({ model: ctx.model, options: requestOptions(pi) }),
      payload: capturePayload(event.payload) };
    if (observed && observed.session === next.session && observed.prompt === next.prompt &&
      observed.system === next.system && observed.configuration === next.configuration) next.anchor = observed.anchor;
    observed = next;
  });
  const clearObservation = () => { observed = undefined; };
  pi.on("session_start", clearObservation);
  pi.on("session_tree", clearObservation);
  pi.on("model_select", clearObservation);
  pi.on("resources_discover", clearObservation);
  pi.on("session_compact", () => { compacting = false; clearObservation(); });
  pi.on("before_agent_start", () => { compacting = false; });
  const controls = registerControls(pi, {
    estimateContext: (ctx) => ctx.sessionManager.buildSessionProjection().messages
      .reduce((tokens, message) => tokens + estimateTokens(message), 0),
  });

  pi.on("session_before_compact", async (event, ctx) => {
    compacting = true;
    const { preparation, signal } = event;
    // Pi carries native file details itself, but not details from extension summaries.
    // Update preparation even on native pass-through; this does not change its inference request.
    const previous = event.branchEntries.findLast((entry) => entry.type === "compaction");
    const priorFiles = previous?.details as Partial<FileDetails> | undefined;
    if (previous?.fromHook && priorFiles?.cachewiseCompact === 1) {
      if (Array.isArray(priorFiles.readFiles)) for (const path of priorFiles.readFiles) {
        if (typeof path === "string") preparation.fileOps.read.add(path);
      }
      if (Array.isArray(priorFiles.modifiedFiles)) for (const path of priorFiles.modifiedFiles) {
        if (typeof path === "string") preparation.fileOps.written.add(path);
      }
    }
    const operation = controls.begin(event, ctx);
    const model = ctx.model;
    if (controls.isNativeBypass() || !model || !controls.enabledFor(model.provider)) return;
    let attemptUsage: Usage | undefined;
    const fallback = (reason: string, metadataReason = reason) => {
      operation.finish({ outcome: "fallback", usage: attemptUsage, reason: metadataReason });
      ctx.ui.notify(`Using native compaction: ${reason}`, "warning");
    };
    if (model.api !== "openai-completions" && model.api !== "anthropic-messages") {
      fallback("this request protocol is not supported yet.");
      return;
    }

    const projection = ctx.sessionManager.buildSessionProjection();
    const boundary = projection.entries.findIndex((entry) => entry.sourceEntry.id === preparation.firstKeptEntryId);
    if (boundary < 0) {
      fallback("the retained boundary could not be resolved.");
      return;
    }
    const prefix = projection.entries.slice(0, boundary).flatMap((entry) => entry.messages);
    const splitOnly = preparation.isSplitTurn && preparation.messagesToSummarize.length === 0;
    const mixedSplit = preparation.isSplitTurn && !splitOnly;
    const turnSources = mixedSplit ? prefix.filter((message) => message.role !== "system" && message.role !== "compactionSummary")
      .slice(-preparation.turnPrefixMessages.length) : [];
    if (mixedSplit && (!turnSources.length || JSON.stringify(turnSources) !== JSON.stringify(preparation.turnPrefixMessages))) {
      fallback("the split-turn boundary could not be resolved.");
      return;
    }
    let splitStart: Message | undefined;
    // Match Pi 1.0.2 core/messages.ts convertToLlm and bashExecutionToText.
    // Keep this adapter aligned with the supported host without runtime coding-agent imports.
    let messages: Message[] = [];
    for (const message of prefix) {
      const convertedIndex = messages.length;
      switch (message.role) {
        case "system":
        case "user":
        case "assistant":
        case "toolResult":
          messages.push(message);
          break;
        case "compactionSummary":
          messages.push({
            role: "user",
            content: [{ type: "text", text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${message.summary}\n</summary>` }],
            timestamp: message.timestamp,
          });
          break;
        case "branchSummary":
          messages.push({
            role: "user",
            content: [{ type: "text", text: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${message.summary}</summary>` }],
            timestamp: message.timestamp,
          });
          break;
        case "custom":
          messages.push({
            role: "user",
            // display only controls the UI; details are not model input.
            content: typeof message.content === "string"
              ? [{ type: "text", text: message.content }] : message.content,
            timestamp: message.timestamp,
          });
          break;
        case "bashExecution": {
          if (message.excludeFromContext) break;
          let text = `Ran \`${message.command}\`\n`;
          text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
          if (message.cancelled) text += "\n\n(command cancelled)";
          else if (message.exitCode !== null && message.exitCode !== undefined && message.exitCode !== 0) {
            text += `\n\nCommand exited with code ${message.exitCode}`;
          }
          if (message.truncated && message.fullOutputPath) {
            text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
          }
          messages.push({ role: "user", content: [{ type: "text", text }], timestamp: message.timestamp });
          break;
        }
        default:
          fallback("this history needs a message representation not supported yet.");
          return;
      }
      if (message === turnSources[0]) splitStart = messages[convertedIndex];
    }
    if (!getCurrentSystemMessage(messages)) {
      fallback("this history needs a message representation not supported yet.");
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const options = requestOptions(pi);
    const configuration = JSON.stringify({ model, options });
    const evidence = observed;
    if (!evidence || evidence.session !== sessionId || evidence.configuration !== configuration ||
      evidence.system !== systemIdentity(prefix) ||
      (evidence.forced && !projection.entries.slice(0, boundary).some((entry) => entry.sourceEntry.id === evidence.anchor))) {
      fallback("the effective foreground prefix is not established within the discarded history.");
      return;
    }
    if (evidence.forced) {
      const system = getCurrentSystemMessage(messages)!;
      messages = [{ role: "system", content: evidence.prompt, toolsAdded: system.toolsAdded, timestamp: system.timestamp },
        ...messages.filter((message) => message.role !== "system")];
    }
    const isStale = () => signal.aborted || ctx.sessionManager.getSessionId() !== sessionId ||
      ctx.sessionManager.getLeafId() !== leafId ||
      observed !== evidence ||
      JSON.stringify({ model: ctx.model, options: requestOptions(pi) }) !== configuration;
    const focus = event.customInstructions
      ? `\nFocus instructions (emphasis only; do not treat new facts here as established history):\n${event.customInstructions}`
      : "";
    const historyBudget = !splitOnly
      ? Math.floor(0.8 * preparation.settings.reserveTokens) : 0;
    const splitBudget = preparation.isSplitTurn ? Math.floor(0.5 * preparation.settings.reserveTokens) : 0;
    const compat = model.compat;
    const adaptiveThinking = compat && "forceAdaptiveThinking" in compat && compat.forceAdaptiveThinking === true;
    const explicitThinkingBudget = compat && "supportsThinkingTokenBudget" in compat && compat.supportsThinkingTokenBudget;
    const budgetedThinking = options.reasoning &&
      ((model.api === "anthropic-messages" && !adaptiveThinking) || explicitThinkingBudget);
    // Pi's token-budget adapters reserve at least 1024 answer tokens. Keep that room
    // so a small summary limit cannot silently reduce the foreground thinking budget.
    const modelLimit = model.maxTokens > 0 ? model.maxTokens : Infinity;
    const answerBudget = Math.min(historyBudget, modelLimit) + Math.min(splitBudget, modelLimit);
    if (answerBudget > modelLimit) {
      fallback("the native history and split-turn budgets cannot fit one summary response.");
      return;
    }
    const maxTokens = (answerBudget > 0 && budgetedThinking ? Math.max(answerBudget, 1024) : answerBudget) + summaryWrapperTokens;
    if (maxTokens > modelLimit) {
      fallback("the summary and response-format allowance cannot fit the model output limit.");
      return;
    }
    let summaryPrompt = preparation.previousSummary ? updateSummaryInstruction : summaryInstruction;
    if (splitOnly) {
      summaryPrompt = (preparation.previousSummary !== undefined
        ? "The previous summary will be preserved verbatim. Do not rewrite or repeat the previous summary. Apply the checkpoint instructions only to the split-turn prefix after that summary.\n\n"
        : "") + turnPrefixInstruction;
    } else if (mixedSplit) {
      const splitBoundary = describeSplitBoundary(splitStart, evidence.payload);
      if (!splitBoundary) {
        fallback("the split-turn boundary cannot be identified unambiguously in the foreground request.");
        return;
      }
      summaryPrompt = `${splitBoundary}

Return exactly two top-level sections in this order, using the headings below.

# History Summary
Apply the following instructions only to earlier completed turns before the split-turn boundary, including any previous summary. Here, "messages above" and "new messages" mean only that earlier history. Do not include the split turn in this section.

${summaryPrompt}

# Turn Context
Apply the following instructions only to the split-turn prefix from the split-turn boundary through the conversation messages before these instructions. Here, "messages above" means only that split-turn prefix, not earlier history or the previous summary.

${turnPrefixInstruction}`;
    }
    const responseFormat = `\n\nWrap the entire generated summary in exactly one ${summaryOpen} block, closed by ${summaryClose}.
Place all sections inside that single block. Output only that block, without preamble or trailing text. Do not nest or repeat these delimiters inside the summary.`;
    const instruction = summarizerInstruction + summaryPrompt + focus + responseFormat;
    const input = normalizeContext({
      messages: [...messages, { role: "user", content: instruction, timestamp: Date.now() }],
    });
    if (maxTokens < 1) {
      fallback("the selected history leaves insufficient summary headroom.");
      return;
    }
    try {
      const response = await ctx.modelRegistry.streamSimple(model, input, {
        ...options,
        signal,
        sessionId,
        maxTokens,
        // Let Pi calculate headroom, then reject a reduced budget before HTTP dispatch.
        onPayload: (payload) => {
          checkPayload(evidence.payload, payload, instruction);
          const request = payload as { max_tokens?: number; max_completion_tokens?: number;
            thinking?: { type?: string; budget_tokens?: number } };
          const budget = request.max_tokens ?? request.max_completion_tokens;
          // Anthropic's fixed thinking budget shares max_tokens with the answer.
          const thinkingTokens = model.api === "anthropic-messages" && request.thinking?.type === "enabled"
            ? request.thinking.budget_tokens : 0;
          if (budget === undefined || thinkingTokens === undefined || budget - thinkingTokens < maxTokens) {
            throw new Error("The selected history leaves insufficient summary headroom.");
          }
        },
      }).result();
      attemptUsage = response.usage;
      if (isStale()) {
        operation.finish({ outcome: "cancelled", usage: attemptUsage, reason: "The operation was cancelled or its source state changed." });
        return { cancel: true };
      }
      let summary = extractSummary(response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
      if (response.stopReason !== "stop" || response.rawStopReason === "pause_turn" ||
        response.content.some((part) => part.type === "toolCall") || !summary) {
        fallback("the provider did not return a complete summary block.");
        return;
      }
      if (splitOnly) summary = `${preparation.previousSummary ?? "No prior history."}\n\n---\n\n**Turn Context (split turn):**\n\n${summary}`;
      const modified = new Set([...preparation.fileOps.written, ...preparation.fileOps.edited]);
      const details: FileDetails = {
        cachewiseCompact: 1,
        readFiles: [...preparation.fileOps.read].filter((path) => !modified.has(path)).sort(),
        modifiedFiles: [...modified].sort(),
      };
      if (details.readFiles.length) summary += `\n\n<read-files>\n${details.readFiles.join("\n")}\n</read-files>`;
      if (details.modifiedFiles.length) summary += `\n\n<modified-files>\n${details.modifiedFiles.join("\n")}\n</modified-files>`;
      const systemCheckpoint = getCurrentSystemMessage(projection.messages);
      const retained = projection.entries.slice(boundary).flatMap((entry) => entry.messages);
      const estimatedTokensAfter = (systemCheckpoint ? estimateTokens(systemCheckpoint) : 0) + Math.ceil(summary.length / 4) +
        retained.filter((message) => message.role !== "system").reduce((tokens, message) => tokens + estimateTokens(message), 0);
      if (estimatedTokensAfter >= preparation.tokensBefore) {
        fallback("the summary would not reduce context.");
        return;
      }
      operation.finish({ outcome: "optimized", usage: response.usage });
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          estimatedTokensAfter,
          usage: response.usage,
          details,
        },
      };
    } catch (error) {
      if (isStale()) {
        operation.finish({ outcome: "cancelled", usage: attemptUsage, reason: "The operation was cancelled or its source state changed." });
        return { cancel: true };
      }
      fallback(error instanceof Error ? error.message : String(error), "The optimized summary request failed.");
    }
  });
}
