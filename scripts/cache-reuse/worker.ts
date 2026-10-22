import { CheckError, loadConfig } from "./config.ts";
import { loadFixture, checkBudget } from "./fixtures.ts";
import { localPrerequisites } from "./preflight.ts";

async function main(): Promise<string> {
  try {
    const config = await loadConfig(process.argv[4]);
    await localPrerequisites(config);
    const fixture = await loadFixture(config.fixture);
    checkBudget(config, fixture);
    if (process.argv[2] === "--check") return "configuration-valid";
    const { runCheck } = await import("./run.ts");
    return (await runCheck(config, fixture, process.argv[5])).outcome;
  } catch (error) {
    return error instanceof CheckError
      ? error.message
      : ["ENOENT", "ERR_MODULE_NOT_FOUND"].includes(
            (error as NodeJS.ErrnoException)?.code ?? "",
          )
        ? "missing-prerequisite"
        : "invalid-configuration";
  }
}
const code = await main();
await new Promise<void>((resolve) => {
  if (process.send) process.send({ code }, () => resolve());
  else resolve();
});
process.disconnect?.();
// The worker owns no interactive session. Configured extensions may leave timers alive.
// Cleanup and record writes have completed before the result is sent.
process.exit(0);
