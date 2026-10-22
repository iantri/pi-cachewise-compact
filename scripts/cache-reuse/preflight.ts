import { readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { piVersionDiagnostic } from "../pi-compatibility.ts";
import { requireCheck, repo, type Config } from "./config.ts";

export async function localPrerequisites(config: Config) {
  const sdkDir =
    config.sdkDir ??
    join(
      dirname(
        fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
      ),
      "..",
    );
  const pkg = JSON.parse(await readFile(join(sdkDir, "package.json"), "utf8"));
  requireCheck(!piVersionDiagnostic(pkg.version), "missing-prerequisite");
  for (const path of [
    join(sdkDir, "dist/index.js"),
    join(sdkDir, "dist/core/system-prompt.js"),
    config.extensionPath ?? join(repo, "extensions/cachewise-compact/index.ts"),
  ]) {
    requireCheck((await stat(path)).isFile(), "missing-prerequisite");
  }
  // Only local files are read. Providers and extensions are not imported here.
  if (config.modelsPath)
    requireCheck(
      typeof JSON.parse(await readFile(config.modelsPath, "utf8")) === "object",
      "invalid-configuration",
    );
}
