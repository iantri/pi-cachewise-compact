import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Keep stable wrappers before Pi loads the extension. Its module loader may
// capture filesystem exports, so replacing them only for one call is unsafe.
let fault: "write" | "rename" | "release" | undefined;
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;
fs.writeFileSync = (path, data, options) => {
  if (fault === "write") {
    originalWrite(path, String(data).slice(0, 8), options);
    throw Object.assign(new Error("Synthetic disk full"), { code: "ENOSPC" });
  }
  originalWrite(path, data, options);
};
fs.renameSync = (...args) => {
  if (fault === "rename") throw Object.assign(new Error("Synthetic replacement denied"), { code: "EACCES" });
  originalRename(...args);
  if (fault === "release") fs.chmodSync(dirname(String(args[1])), 0o500);
};
syncBuiltinESMExports();

const agentDir = getAgentDir();
const cwd = process.cwd();
const settingsManager = SettingsManager.create(cwd, agentDir);
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
  modelsStorePath: join(agentDir, "models-cache.json"), allowModelNetwork: false,
});
const model = modelRuntime.getModel("provider-alpha", "fixture-model");
assert.ok(model);
const loader = new DefaultResourceLoader({
  cwd, agentDir, settingsManager,
  additionalExtensionPaths: [fileURLToPath(new URL("../extensions/cachewise-compact/index.ts", import.meta.url))],
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  systemPrompt: "Synthetic settings test. Commands must not enter inference.",
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
const { session } = await createAgentSession({
  cwd, agentDir, modelRuntime, model, thinkingLevel: "off", tools: [],
  resourceLoader: loader, settingsManager, sessionManager,
});
const notices: Array<{ message: string; type: string }> = [];
const errors: unknown[] = [];
await session.bindExtensions({
  mode: "rpc",
  uiContext: { ...session.extensionRunner.getUIContext(), notify: (message, type = "info") => notices.push({ message, type }) },
  onError: (error) => errors.push(error),
});
assert.ok(session.extensionRunner.getCommand("cachewise-compact"));
process.send!({ ready: true, pid: process.pid, sessionId: sessionManager.getSessionId(), agentDir });
process.on("message", async (message: { id: number; command: string; fault?: "write" | "rename" | "release" }) => {
  try {
    // Inject operating-system failures at the filesystem boundary, not into
    // the extension. A partial write must never damage the previous settings.
    fault = message.fault;
    const start = notices.length;
    await session.prompt(message.command);
    assert.deepEqual(errors, []);
    assert.equal(session.messages.length, 0, "Settings commands must not enter inference");
    process.send!({ id: message.id, notices: notices.slice(start) });
  } catch (error) {
    process.send!({ id: message.id, error: String(error) });
  } finally {
    if (fault === "release") fs.chmodSync(agentDir, 0o700);
    fault = undefined;
  }
});
process.on("disconnect", () => { session.dispose(); process.exit(0); });
