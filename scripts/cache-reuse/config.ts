import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export class CheckError extends Error {}
export function requireCheck(value: unknown, code: string): asserts value {
  if (!value) throw new CheckError(code);
}
export interface Config {
  version: 1;
  fixture: "100k" | "250k";
  provider: string;
  model: string;
  outputDir: string;
  sdkDir?: string;
  extensionPath?: string;
  extensions: string[];
  modelsPath?: string;
  authPath?: string;
  diagnostics: boolean;
  cacheRetention: "short" | "long";
  thinking: "off" | "minimal" | "low" | "medium" | "high";
  contextTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
  maxOutputTokens: number;
  timeoutSeconds: number;
  cache: {
    minimumPrefixTokens: number;
    sharedPrefixUpperBoundTokens: number;
    minimumHistoryCacheTokens: number;
    retentionSeconds: number;
  };
}
export async function externalPath(path: string): Promise<string> {
  requireCheck(
    typeof path === "string" && isAbsolute(path),
    "private-path-required",
  );
  const [target, checkout] = await Promise.all([
    realpath(path),
    realpath(repo),
  ]);
  const rel = relative(checkout, target);
  requireCheck(
    rel !== "" &&
      (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)),
    "private-path-required",
  );
  return target;
}
export async function loadConfig(path: string): Promise<Config> {
  const input = JSON.parse(await readFile(await externalPath(path), "utf8"));
  const keys = [
    "version",
    "fixture",
    "provider",
    "model",
    "outputDir",
    "sdkDir",
    "extensionPath",
    "extensions",
    "modelsPath",
    "authPath",
    "diagnostics",
    "cacheRetention",
    "thinking",
    "contextTokens",
    "reserveTokens",
    "keepRecentTokens",
    "maxOutputTokens",
    "timeoutSeconds",
    "cache",
  ];
  requireCheck(
    input &&
      typeof input === "object" &&
      Object.keys(input).every((k) => keys.includes(k)),
    "invalid-configuration",
  );
  input.cacheRetention ??= "short";
  requireCheck(
    ["short", "long"].includes(input.cacheRetention),
    "invalid-configuration",
  );
  input.diagnostics ??= false;
  requireCheck(typeof input.diagnostics === "boolean", "invalid-configuration");
  requireCheck(
    input.version === 1 && ["100k", "250k"].includes(input.fixture),
    "invalid-configuration",
  );
  for (const key of ["provider", "model"])
    requireCheck(
      typeof input[key] === "string" && input[key].length > 0,
      "invalid-configuration",
    );
  for (const key of [
    "contextTokens",
    "reserveTokens",
    "keepRecentTokens",
    "maxOutputTokens",
    "timeoutSeconds",
  ]) {
    requireCheck(
      Number.isSafeInteger(input[key]) && input[key] > 0,
      "invalid-configuration",
    );
  }
  requireCheck(input.timeoutSeconds <= 1500, "invalid-configuration");
  requireCheck(
    ["off", "minimal", "low", "medium", "high"].includes(input.thinking),
    "invalid-configuration",
  );
  requireCheck(
    Array.isArray(input.extensions) &&
      input.extensions.every(
        (v: unknown) => typeof v === "string" && isAbsolute(v),
      ),
    "invalid-configuration",
  );
  const cacheKeys = [
    "minimumPrefixTokens",
    "sharedPrefixUpperBoundTokens",
    "minimumHistoryCacheTokens",
    "retentionSeconds",
  ];
  requireCheck(
    input.cache &&
      Object.keys(input.cache).length === cacheKeys.length &&
      Object.keys(input.cache).every((k) => cacheKeys.includes(k)),
    "invalid-configuration",
  );
  for (const key of cacheKeys)
    requireCheck(
      Number.isSafeInteger(input.cache[key]) && input.cache[key] > 0,
      "invalid-configuration",
    );
  const target = input.fixture === "100k" ? 100000 : 250000;
  requireCheck(
    target * 0.9 +
      input.reserveTokens +
      input.maxOutputTokens +
      input.cache.sharedPrefixUpperBoundTokens <
      input.contextTokens,
    "insufficient-headroom",
  );
  input.outputDir = await externalPath(input.outputDir);
  requireCheck(
    (await stat(input.outputDir)).isDirectory(),
    "missing-prerequisite",
  );
  for (const key of ["sdkDir", "extensionPath", "modelsPath", "authPath"]) {
    if (input[key] !== undefined) {
      requireCheck(
        typeof input[key] === "string" && isAbsolute(input[key]),
        "invalid-configuration",
      );
      await stat(input[key]);
    }
  }
  for (const path of input.extensions) await stat(path);
  return input as Config;
}
