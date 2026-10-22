import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Notice { message: string; type: string }
interface Reply { id: number; notices: Notice[]; error?: string }
interface Ready { ready: true; pid: number; sessionId: string; agentDir: string }

const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(path: string): Promise<() => Promise<void>>;
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cachewise-settings-"));
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(500); res.end("Unexpected inference"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    assert.equal(requests, 0);
  });
  const home = join(root, "home");
  await mkdir(home);
  async function seed(agentDir: string, enabled = true, providers: string[] = []) {
    await mkdir(agentDir, { recursive: true });
    const provider = {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: "synthetic-test-key",
      models: [{ id: "fixture-model", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096 }],
    };
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      "provider-alpha": provider, "provider-beta": provider, "provider-gamma": provider,
    } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    }));
    await writeFile(join(agentDir, "cachewise-compact.json"), JSON.stringify({ enabled, providers }) + "\n");
  }
  async function launch(name: string, override?: string) {
    const cwd = join(root, name);
    await mkdir(cwd);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.PI_CODING_AGENT_DIR;
    delete env.PI_CODING_AGENT_SESSION_DIR;
    delete env.PI_PACKAGE_DIR;
    if (override !== undefined) env.PI_CODING_AGENT_DIR = override;
    const child = fork(fileURLToPath(new URL("./settings-worker.ts", import.meta.url)), {
      cwd, env, execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr!.on("data", (data) => { stderr += data; });
    child.stdout!.resume();
    t.after(async () => {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    });
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: Notice[]) => void; reject: (error: Error) => void }>();
    const ready = await new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker startup timed out: ${stderr}`)), 30000);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${stderr}`)); });
      child.on("message", (message: Ready | Reply) => {
        if ("ready" in message) { clearTimeout(timer); resolve(message); return; }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error));
        else waiter.resolve(message.notices);
      });
    });
    async function command(args: string, fault?: "write" | "rename" | "release") {
      return new Promise<Notice[]>((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Command timed out: ${args} ${stderr}`)); }, 15000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        child.send({ id, command: `/cachewise-compact ${args}`, fault });
      });
    }
    return { ready, command, status: async () => (await command("status")).at(-1)!.message };
  }
  return { root, home, seed, launch };
}

test("interleaved commands preserve other processes' provider and enablement changes", async (t) => {
  const h = await fixture(t);
  const agentDir = join(h.root, "agent");
  await h.seed(agentDir);
  const a = await h.launch("workspace-a", agentDir);
  const b = await h.launch("workspace-b", agentDir);
  assert.notEqual(a.ready.pid, b.ready.pid);
  assert.notEqual(a.ready.sessionId, b.ready.sessionId);
  await b.command("provider add provider-alpha");
  await a.command("off");
  assert.match(await a.status(), /Cache compaction: off\nSelected: provider-alpha\n/);
  await b.command("provider add provider-beta");
  assert.match(await b.status(), /Cache compaction: off\nSelected: provider-alpha, provider-beta\n/);
  const reopened = await h.launch("workspace-reopened", agentDir);
  assert.match(await reopened.status(), /Cache compaction: off\nSelected: provider-alpha, provider-beta\n/);
  await b.command("provider add provider-gamma");
  await a.command("provider remove provider-alpha");
  assert.match(await a.status(), /Cache compaction: off\nSelected: provider-beta, provider-gamma\n/);
});

test("concurrent commands preserve all independent changes across processes", async (t) => {
  const h = await fixture(t);
  const agentDir = join(h.root, "agent");
  await h.seed(agentDir);
  const [a, b, c] = await Promise.all([
    h.launch("workspace-a", agentDir), h.launch("workspace-b", agentDir), h.launch("workspace-c", agentDir),
  ]);
  for (let round = 0; round < 6; round++) {
    await a.command("provider remove provider-alpha");
    await b.command("provider remove provider-beta");
    await c.command("on");
    const results = await Promise.all([
      a.command("provider add provider-alpha"), b.command("provider add provider-beta"), c.command("off"),
    ]);
    for (const notices of results) assert.ok(notices.every((notice) => notice.type === "info"));
    // An idempotent mutation refreshes from disk without changing the expected result.
    await c.command("off");
    const status = await c.status();
    assert.match(status, /Cache compaction: off\n/);
    assert.match(status, /Selected: (provider-alpha, provider-beta|provider-beta, provider-alpha)\n/);
  }
  const reopened = await h.launch("workspace-reopened", agentDir);
  assert.equal(await reopened.status(), await c.status());
});

test("lock contention reports an error without changing saved or session settings", async (t) => {
  const h = await fixture(t);
  const agentDir = join(h.root, "agent");
  await h.seed(agentDir, true, ["provider-alpha"]);
  const worker = await h.launch("workspace", agentDir);
  const path = join(agentDir, "cachewise-compact.json");
  const before = await readFile(path, "utf8");
  const release = await lockfile.lock(path);
  try {
    for (const command of ["off", "provider add provider-beta", "provider remove provider-alpha"]) {
      const notices = await worker.command(command);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].type, "error");
      assert.match(notices[0].message, /could not save/i);
      assert.match(await worker.status(), /Cache compaction: on\nSelected: provider-alpha\n/);
      assert.equal(await readFile(path, "utf8"), before);
    }
  } finally { await release(); }
  await worker.command("provider add provider-beta");
  const reopened = await h.launch("workspace-reopened", agentDir);
  assert.match(await reopened.status(), /Cache compaction: on\nSelected: provider-alpha, provider-beta\n/);
});

test("commands wait for a briefly held cross-process lock and then save fresh settings", async (t) => {
  const h = await fixture(t);
  const agentDir = join(h.root, "agent");
  await h.seed(agentDir, true, ["provider-alpha"]);
  const worker = await h.launch("workspace", agentDir);
  const release = await lockfile.lock(join(agentDir, "cachewise-compact.json"));
  let finished = false;
  const pending = worker.command("off").then((notices) => { finished = true; return notices; });
  try {
    await delay(100);
    assert.equal(finished, false, "The command must not ignore the held lock");
  } finally { await release(); }
  const notices = await pending;
  assert.equal(notices.at(-1)!.type, "info");
  assert.match(await worker.status(), /Cache compaction: off\nSelected: provider-alpha\n/);
  const reopened = await h.launch("workspace-reopened", agentDir);
  assert.match(await reopened.status(), /Cache compaction: off\nSelected: provider-alpha\n/);
});

test("concurrent first saves preserve selections when no settings file exists", async (t) => {
  const h = await fixture(t);
  const agentDir = join(h.root, "agent");
  await h.seed(agentDir);
  await rm(join(agentDir, "cachewise-compact.json"));
  const [a, b] = await Promise.all([h.launch("workspace-a", agentDir), h.launch("workspace-b", agentDir)]);
  assert.match(await a.status(), /Cache compaction: off\nSelected: none\n/);
  const results = await Promise.all([a.command("provider add provider-alpha"), b.command("provider add provider-beta")]);
  for (const notices of results) assert.equal(notices.at(-1)!.type, "info");
  const reopened = await h.launch("workspace-reopened", agentDir);
  assert.match(await reopened.status(), /Selected: (provider-alpha, provider-beta|provider-beta, provider-alpha)\n/);
});

test("unreadable fresh settings and unwritable directories leave session settings unchanged", async (t) => {
  const h = await fixture(t);
  const agentDir = join(h.root, "agent");
  await h.seed(agentDir, true, ["provider-alpha"]);
  const worker = await h.launch("workspace", agentDir);
  const path = join(agentDir, "cachewise-compact.json");
  const before = await readFile(path, "utf8");
  for (const failure of ["invalid-json", "read-denied", "directory-denied"]) {
    try {
      if (failure === "invalid-json") await writeFile(path, "{incomplete");
      if (failure === "read-denied") await chmod(path, 0o000);
      if (failure === "directory-denied") await chmod(agentDir, 0o500);
      const notices = await worker.command("off");
      assert.equal(notices.length, 1);
      assert.equal(notices[0].type, "error");
      assert.match(await worker.status(), /Cache compaction: on\nSelected: provider-alpha\n/);
    } finally {
      await chmod(agentDir, 0o700);
      await chmod(path, 0o600);
    }
    assert.equal(await readFile(path, "utf8"), failure === "invalid-json" ? "{incomplete" : before);
    await writeFile(path, before);
    assert.deepEqual((await readdir(agentDir)).filter((name) => /\.tmp$|\.lock$/.test(name)), []);
  }
});

test("successful saves atomically replace read-only files with owner-only permissions", async (t) => {
  const h = await fixture(t);
  const agentDir = join(h.root, "agent");
  await h.seed(agentDir, true, ["provider-alpha"]);
  const worker = await h.launch("workspace", agentDir);
  const path = join(agentDir, "cachewise-compact.json");
  await chmod(path, 0o444);
  const notices = await worker.command("off");
  assert.equal(notices.at(-1)!.type, "info");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const reopened = await h.launch("workspace-reopened", agentDir);
  assert.match(await reopened.status(), /Cache compaction: off\nSelected: provider-alpha\n/);
  assert.deepEqual((await readdir(agentDir)).filter((name) => /\.tmp$|\.lock$/.test(name)), []);
});

for (const fault of ["write", "rename"] as const) {
  test(`${fault} failures preserve the prior file and session settings without reporting success`, async (t) => {
    const h = await fixture(t);
    const agentDir = join(h.root, "agent");
    await h.seed(agentDir, true, ["provider-alpha"]);
    const worker = await h.launch("workspace", agentDir);
    const path = join(agentDir, "cachewise-compact.json");
    const before = await readFile(path, "utf8");
    const notices = await worker.command("provider add provider-beta", fault);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, "error");
    assert.match(await worker.status(), /Cache compaction: on\nSelected: provider-alpha\n/);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual((await readdir(agentDir)).filter((name) => /\.tmp$|\.lock$/.test(name)), []);
    await worker.command("provider add provider-beta");
    const reopened = await h.launch("workspace-reopened", agentDir);
    assert.match(await reopened.status(), /Cache compaction: on\nSelected: provider-alpha, provider-beta\n/);
  });
}

test("lock cleanup failure reports the completed save accurately and keeps session state consistent", async (t) => {
  const h = await fixture(t);
  const agentDir = join(h.root, "agent");
  await h.seed(agentDir, true, ["provider-alpha"]);
  const worker = await h.launch("workspace", agentDir);
  const notices = await worker.command("provider add provider-beta", "release");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "error");
  assert.match(notices[0].message, /settings were saved.*lock/i);
  assert.match(await worker.status(), /Cache compaction: on\nSelected: provider-alpha, provider-beta\n/);
  const reopened = await h.launch("workspace-reopened", agentDir);
  assert.match(await reopened.status(), /Cache compaction: on\nSelected: provider-alpha, provider-beta\n/);
});

test("literal ~/ overrides share Pi's agent directory across working directories", async (t) => {
  const h = await fixture(t);
  const agentDir = join(h.home, "override");
  await h.seed(agentDir, true, ["provider-alpha"]);
  const a = await h.launch("workspace-a", "~/override");
  const b = await h.launch("workspace-b", "~/override");
  assert.equal(a.ready.agentDir, agentDir);
  assert.equal(b.ready.agentDir, agentDir);
  assert.match(await a.status(), /Cache compaction: on\nSelected: provider-alpha\n/);
  await a.command("provider add provider-beta");
  await b.command("off");
  const reopened = await h.launch("workspace-reopened", "~/override");
  assert.match(await reopened.status(), /Cache compaction: off\nSelected: provider-alpha, provider-beta\n/);
  for (const workspace of ["workspace-a", "workspace-b", "workspace-reopened"]) {
    assert.ok(!(await readdir(join(h.root, workspace))).includes("~"), "No literal tilde directory may be created");
  }
});

for (const kind of ["absolute", "default", "bare-tilde", "file-url", ...(process.platform === "win32" ? ["windows-tilde"] : [])]) {
  test(`${kind} agent directories agree with Pi's settings directory`, async (t) => {
    const h = await fixture(t);
    const agentDir = kind === "default" ? join(h.home, ".pi", "agent")
      : kind === "bare-tilde" ? h.home : join(h.home, "agent override");
    const override = kind === "default" ? undefined : kind === "bare-tilde" ? "~"
      : kind === "file-url" ? pathToFileURL(agentDir).href
      : kind === "windows-tilde" ? "~\\agent override" : agentDir;
    await h.seed(agentDir, false, ["provider-alpha"]);
    const worker = await h.launch("workspace", override);
    assert.equal(worker.ready.agentDir, agentDir);
    assert.match(await worker.status(), /Cache compaction: off\nSelected: provider-alpha\n/);
    await worker.command("on");
    const reopened = await h.launch("workspace-reopened", override);
    assert.match(await reopened.status(), /Cache compaction: on\nSelected: provider-alpha\n/);
    assert.ok(!(await readdir(join(h.root, "workspace"))).includes("~"));
  });
}
