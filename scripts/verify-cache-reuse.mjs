#!/usr/bin/env node
// Keep loader warnings, provider output, and uncaught errors out of the terminal.
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const codes = new Set([
  "configuration-valid",
  "invalid-configuration",
  "private-path-required",
  "missing-prerequisite",
  "fixture-invalid",
  "insufficient-headroom",
  "passed",
  "failed",
  "unverified",
  "cancelled",
]);
const args = process.argv.slice(2);
if (
  args.length !== 3 ||
  !["--check", "--live"].includes(args[0]) ||
  args[1] !== "--config"
) {
  process.stderr.write(
    "Usage: node scripts/verify-cache-reuse.mjs --check|--live --config /external/config.json\n",
  );
  process.exitCode = 2;
} else {
  process.umask(0o077);
  let workspace;
  let child;
  let result = "missing-prerequisite";
  let receivedResult = false;
  let cancelled = false;
  let killTimer;
  const stop = () => {
    cancelled = true;
    child?.kill("SIGTERM");
    killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 3000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    workspace = await mkdtemp(join(tmpdir(), "cache-reuse-"));
    if (cancelled) throw new Error("cancelled");
    child = fork(
      fileURLToPath(new URL("./cache-reuse/worker.ts", import.meta.url)),
      [...args, workspace],
      {
        cwd: workspace,
        execArgv: ["--import", import.meta.resolve("tsx")],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          PI_CODING_AGENT_DIR: join(workspace, "agent"),
          PI_CODING_AGENT_SESSION_DIR: join(workspace, "sessions"),
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
      },
    );
    const timeout = setTimeout(stop, 30 * 60 * 1000);
    child.on("message", (message) => {
      if (message && typeof message === "object" && codes.has(message.code)) {
        result = message.code;
        receivedResult = true;
      }
    });
    await new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        if (code !== 0 || signal)
          result = receivedResult ? "unverified" : "missing-prerequisite";
        resolve();
      });
      child.once("error", () => {
        result = "missing-prerequisite";
        resolve();
      });
    });
    clearTimeout(timeout);
  } catch {
    result = "missing-prerequisite";
  } finally {
    clearTimeout(killTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (workspace)
      await rm(workspace, { recursive: true, force: true }).catch(() => {
        result = "unverified";
      });
  }
  if (cancelled) result = "cancelled";
  const success = result === "configuration-valid" || result === "passed";
  (success ? process.stdout : process.stderr).write(
    `Cache check: ${result}.\n`,
  );
  process.exitCode = success ? 0 : result === "failed" ? 1 : 2;
}
