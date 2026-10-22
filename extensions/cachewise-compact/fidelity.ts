import { isDeepStrictEqual } from "node:util";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject { [key: string]: JsonValue }

/** Transient request evidence. Never persist this: it includes conversation content. */
export interface PayloadSnapshot {
  readonly fields: Readonly<JsonObject>;
  readonly messages: readonly JsonObject[];
}

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function withoutCacheMarker(value: JsonObject): JsonObject {
  const { cache_control: _cacheControl, ...rest } = value;
  return rest;
}

function contentBlocks(value: JsonValue): JsonValue {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return value;
  return value.map((block) => {
    if (!isObject(block)) return block;
    const normalized = withoutCacheMarker(block);
    if (block.type === "tool_result" && "content" in block) {
      normalized.content = contentBlocks(block.content);
    }
    return normalized;
  });
}

/**
 * Capture JSON as seen by this before_provider_request handler, not the session projection.
 * Later payload/header hooks are outside this evidence; they must not change the request.
 * Only protocol cache markers are ignored, never similarly named tool arguments or schemas.
 */
export function capturePayload(payload: unknown): PayloadSnapshot | undefined {
  try {
    const copy: unknown = JSON.parse(JSON.stringify(payload));
    if (!isObject(copy) || !Array.isArray(copy.messages) || !copy.messages.length ||
      !copy.messages.every((message) => isObject(message) && typeof message.role === "string")) return undefined;
    const { messages: rawMessages, max_tokens: _maxTokens, max_completion_tokens: _maxCompletionTokens, ...fields } = copy;
    if ("system" in fields) fields.system = contentBlocks(fields.system);
    if (Array.isArray(fields.tools)) {
      fields.tools = fields.tools.map((tool) => isObject(tool) ? withoutCacheMarker(tool) : tool);
    }
    const messages = (rawMessages as JsonObject[]).map((message) => ({
      ...withoutCacheMarker(message),
      ...("content" in message ? { content: contentBlocks(message.content) } : {}),
    }));
    return { fields, messages };
  } catch {
    return undefined;
  }
}

function beforeInstruction(messages: readonly JsonObject[], instruction: string): JsonObject[] {
  const last = messages.at(-1);
  const blocks = last?.content;
  const suffix = Array.isArray(blocks) ? blocks.at(-1) : undefined;
  if (!instruction || last?.role !== "user" || !Array.isArray(blocks) ||
    !isObject(suffix) || !isDeepStrictEqual(suffix, { type: "text", text: instruction })) {
    // Concatenated text without a separate instruction block has no proven boundary.
    throw new Error("The serialized summary instruction boundary is not supported.");
  }
  const prefix = messages.slice(0, -1);
  if (blocks.length > 1) prefix.push({ ...last, content: blocks.slice(0, -1) });
  return prefix;
}

function matchesPrefix(prefix: readonly JsonObject[], foreground: readonly JsonObject[]): boolean {
  if (!prefix.length || prefix.length > foreground.length) return false;
  return prefix.every((message, index) => {
    const observed = foreground[index];
    if (isDeepStrictEqual(message, observed)) return true;
    // Anthropic-style user blocks can coalesce at A/B. Compare the complete A blocks,
    // not the whole final message, and never discard A with the summary instruction.
    if (index !== prefix.length - 1 || message.role !== "user") return false;
    const { content, ...fields } = message;
    const { content: observedContent, ...observedFields } = observed;
    return isDeepStrictEqual(fields, observedFields) && Array.isArray(content) &&
      Array.isArray(observedContent) && content.length > 0 && content.length <= observedContent.length &&
      content.every((block, blockIndex) => isDeepStrictEqual(block, observedContent[blockIndex]));
  });
}

/**
 * Guard a Pi Chat Completions or Anthropic Messages onPayload callback before dispatch.
 * All request fields except output caps must match, including tools, system, thinking,
 * template options and routing fields. The caller owns exact A selection and output headroom.
 * This does not replay transforms or certify hooks that run after foreground observation.
 */
export function checkPayload(foreground: PayloadSnapshot | undefined, candidate: unknown, instruction: string): void {
  const maintenance = capturePayload(candidate);
  if (!foreground || !maintenance) throw new Error("The serialized foreground request is not established.");
  if (!isDeepStrictEqual(maintenance.fields, foreground.fields)) {
    throw new Error("The optimized request changes foreground system, tools, thinking, or request settings.");
  }
  if (!matchesPrefix(beforeInstruction(maintenance.messages, instruction), foreground.messages)) {
    throw new Error("The optimized request does not preserve the observed foreground prefix.");
  }
}
