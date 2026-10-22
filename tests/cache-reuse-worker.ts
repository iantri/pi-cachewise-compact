// Test entrypoint only: the public CLI accepts committed fixtures, never transcript paths.
import { readFile } from "node:fs/promises";
import { runCheck } from "../scripts/cache-reuse/run.ts";
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
try {
  const result = await runCheck(input.config, input.fixture, process.argv[3]);
  process.send?.(result);
} catch {
  process.send?.({ outcome: "worker-error" });
}
process.disconnect?.();
