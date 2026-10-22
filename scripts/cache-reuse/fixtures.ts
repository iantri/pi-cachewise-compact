import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import { repo, requireCheck, type Config } from "./config.ts";
import type { Fixture } from "./run.ts";

const encoding = getEncoding("cl100k_base");
export const referenceTokens = (value: unknown) =>
  encoding.encode(JSON.stringify(value), [], []).length;
export async function loadFixture(id: Config["fixture"]): Promise<Fixture> {
  requireCheck(id === "100k" || id === "250k", "fixture-invalid");
  const fixture: Fixture = JSON.parse(
    await readFile(join(repo, "fixtures/cache-reuse", `${id}.json`), "utf8"),
  );
  requireCheck(
    fixture.id === id &&
      Number.isSafeInteger(fixture.version) &&
      fixture.version > 0 &&
      fixture.tokenizer ===
        "cl100k_base / js-tiktoken 1.0.21 / sum of JSON messages" &&
      typeof fixture.description === "string" &&
      Array.isArray(fixture.messages) &&
      fixture.messages.length > 2,
    "fixture-invalid",
  );
  const pending = new Map<string, string>(),
    seen = new Set<string>();
  let tokens = 0;
  for (const message of fixture.messages) {
    requireCheck(
      message &&
        ["user", "assistant", "toolResult"].includes(String(message.role)),
      "fixture-invalid",
    );
    requireCheck(
      Object.keys(message).every((key) =>
        [
          "role",
          "content",
          "stopReason",
          "rawStopReason",
          "toolCallId",
          "toolName",
          "isError",
        ].includes(key),
      ),
      "fixture-invalid",
    );
    requireCheck(
      typeof message.content === "string" || Array.isArray(message.content),
      "fixture-invalid",
    );
    if (message.role !== "assistant" && Array.isArray(message.content)) {
      requireCheck(
        message.content.length > 0 &&
          message.content.every(
            (part) =>
              part && part.type === "text" && typeof part.text === "string",
          ),
        "fixture-invalid",
      );
    }
    if (message.role === "toolResult") {
      requireCheck(
        typeof message.toolCallId === "string" &&
          pending.get(message.toolCallId) === message.toolName,
        "fixture-invalid",
      );
      pending.delete(message.toolCallId);
    } else {
      requireCheck(pending.size === 0, "fixture-invalid");
      if (message.role === "assistant") {
        requireCheck(
          Array.isArray(message.content) &&
            ["stop", "toolUse"].includes(String(message.stopReason)),
          "fixture-invalid",
        );
        for (const part of message.content as Array<Record<string, unknown>>) {
          requireCheck(
            part.type === "text" || part.type === "toolCall",
            "fixture-invalid",
          );
          if (part.type === "text")
            requireCheck(typeof part.text === "string", "fixture-invalid");
          else {
            requireCheck(
              typeof part.id === "string" &&
                !seen.has(part.id) &&
                typeof part.name === "string" &&
                part.arguments &&
                typeof part.arguments === "object" &&
                !Array.isArray(part.arguments),
              "fixture-invalid",
            );
            seen.add(part.id);
            pending.set(part.id, part.name);
          }
        }
        requireCheck(
          pending.size > 0 === (message.stopReason === "toolUse"),
          "fixture-invalid",
        );
      }
    }
    tokens += referenceTokens(message);
  }
  const target = id === "100k" ? 100000 : 250000;
  requireCheck(
    pending.size === 0 &&
      fixture.messages[0].role === "user" &&
      fixture.messages.at(-1)?.role === "assistant" &&
      tokens === fixture.referenceTokens &&
      tokens >= target * 0.9 &&
      tokens <= target * 1.15,
    "fixture-invalid",
  );
  requireCheck(
    Array.isArray(fixture.facts) &&
      fixture.facts.length > 0 &&
      fixture.facts.every(
        (f) =>
          Number.isSafeInteger(f.sourceMessage) &&
          f.sourceMessage >= 0 &&
          f.sourceMessage < fixture.messages.length &&
          typeof f.question === "string" &&
          f.question.length > 0 &&
          Array.isArray(f.mustInclude) &&
          f.mustInclude.length > 0 &&
          f.mustInclude.every(
            (term) =>
              typeof term === "string" &&
              term.length > 0 &&
              JSON.stringify(fixture.messages[f.sourceMessage])
                .toLowerCase()
                .includes(term.toLowerCase()),
          ),
      ),
    "fixture-invalid",
  );
  return fixture;
}
export function checkBudget(config: Config, fixture: Fixture) {
  // A local screen, not a provider-token guarantee. Live payloads and usage are checked again.
  const estimate =
    Math.ceil(fixture.referenceTokens * 1.2) +
    config.cache.sharedPrefixUpperBoundTokens +
    config.reserveTokens +
    config.maxOutputTokens +
    8192;
  requireCheck(
    estimate < config.contextTokens &&
      config.keepRecentTokens < fixture.referenceTokens / 2,
    "insufficient-headroom",
  );
  requireCheck(
    fixture.referenceTokens - config.keepRecentTokens >
      config.cache.minimumPrefixTokens + config.cache.minimumHistoryCacheTokens,
    "insufficient-headroom",
  );
}
