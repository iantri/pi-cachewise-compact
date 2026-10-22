import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const cli = resolve("scripts/verify-cache-reuse.mjs");
test("configuration errors stay private and never start live inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-check-cli-"));
  try {
    const config = join(root, "LOCAL_PATH_CANARY.json");
    await writeFile(
      config,
      JSON.stringify({
        provider: "PRIVATE_PROVIDER_CANARY",
        apiKey: "SECRET_CANARY",
      }),
    );
    const result = spawnSync(
      process.execPath,
      [cli, "--check", "--config", config],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Cache check: invalid-configuration.\n");
    assert.equal(
      await readFile(config, "utf8"),
      JSON.stringify({
        provider: "PRIVATE_PROVIDER_CANARY",
        apiKey: "SECRET_CANARY",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

export function configuration(outputDir: string) {
  return {
    version: 1,
    fixture: "100k",
    provider: "fictional",
    model: "fictional-model",
    outputDir,
    extensions: [],
    thinking: "off",
    diagnostics: false,
    contextTokens: 196608,
    reserveTokens: 8192,
    keepRecentTokens: 512,
    maxOutputTokens: 2048,
    timeoutSeconds: 120,
    cache: {
      minimumPrefixTokens: 1024,
      sharedPrefixUpperBoundTokens: 16384,
      minimumHistoryCacheTokens: 8192,
      retentionSeconds: 300,
    },
  };
}
test("configuration checking accepts explicit private diagnostics settings without loading extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-check-cli-"));
  try {
    const extension = join(root, "must-not-load.mjs");
    await writeFile(
      extension,
      'throw new Error("EXTENSION_MUST_NOT_LOAD_CANARY");',
    );
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({ ...configuration(root), extensions: [extension] }),
    );
    const result = spawnSync(
      process.execPath,
      [cli, "--check", "--config", path],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Cache check: configuration-valid.\n");
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a small context budget is rejected before inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-check-cli-"));
  try {
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({ ...configuration(root), contextTokens: 4000 }),
    );
    const result = spawnSync(
      process.execPath,
      [cli, "--check", "--config", path],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "Cache check: insufficient-headroom.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration and output paths cannot point into the checkout, including through symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-check-paths-"));
  const localDirectory = await mkdtemp(join(resolve(), ".cache-check-test-"));
  const local = join(localDirectory, "config.json");
  try {
    const inside = { ...configuration(root) };
    await writeFile(local, JSON.stringify(inside));
    const link = join(root, "config-link.json");
    await symlink(local, link);
    for (const path of [local, link]) {
      const r = spawnSync(
        process.execPath,
        [cli, "--check", "--config", path],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 2);
      assert.equal(r.stderr, "Cache check: private-path-required.\n");
    }
    const outLink = join(root, "output-link");
    await symlink(resolve(), outLink);
    const path = join(root, "external.json");
    await writeFile(path, JSON.stringify({ ...inside, outputDir: outLink }));
    const r = spawnSync(process.execPath, [cli, "--check", "--config", path], {
      encoding: "utf8",
    });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, "Cache check: private-path-required.\n");
  } finally {
    await rm(localDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("the committed 100k fixture has validated structure and a measured immutable input size", async () => {
  const { loadFixture } = await import("../scripts/cache-reuse/fixtures.ts");
  const fixture = await loadFixture("100k");
  assert.equal(fixture.referenceTokens, 94497);
  assert.equal(fixture.messages.length, 96);
  assert.equal(fixture.facts[0].sourceMessage, 0);
  assert.match(JSON.stringify(fixture.messages[0]), /Lantern Ledger/);
});

test("selecting 250k for a smaller context is rejected without changing the selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-check-selection-"));
  try {
    const path = join(root, "config.json");
    const contents = JSON.stringify({
      ...configuration(root),
      fixture: "250k",
    });
    await writeFile(path, contents);
    const result = spawnSync(
      process.execPath,
      [cli, "--check", "--config", path],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "Cache check: insufficient-headroom.\n");
    assert.equal(await readFile(path, "utf8"), contents);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the committed 250k fixture has valid tool structure and fits a larger context", async () => {
  const { loadFixture, checkBudget } = await import(
    "../scripts/cache-reuse/fixtures.ts"
  );
  const { loadConfig } = await import("../scripts/cache-reuse/config.ts");
  const fixture = await loadFixture("250k");
  assert.ok(
    fixture.referenceTokens >= 225000 && fixture.referenceTokens <= 287500,
  );
  assert.match(JSON.stringify(fixture.messages[0]), /Harbor Dispatch/);
  const root = await mkdtemp(join(tmpdir(), "cache-check-large-"));
  try {
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        ...configuration(root),
        fixture: "250k",
        contextTokens: 524288,
      }),
    );
    checkBudget(await loadConfig(path), fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration checking enforces the Pi minimum without importing the SDK", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cache-check-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdkDir = join(root, "sdk");
  await mkdir(join(sdkDir, "dist/core"), { recursive: true });
  await writeFile(
    join(sdkDir, "package.json"),
    JSON.stringify({ type: "module", version: "1.0.1" }),
  );
  await writeFile(
    join(sdkDir, "dist/index.js"),
    'throw new Error("SDK_MUST_NOT_LOAD");',
  );
  await writeFile(
    join(sdkDir, "dist/core/system-prompt.js"),
    'throw new Error("SDK_MUST_NOT_LOAD");',
  );
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ ...configuration(root), sdkDir }));
  for (const version of ["1.0.1", "1.0.2", "1.1.0", "2.0.0"]) {
    await writeFile(
      join(sdkDir, "package.json"),
      JSON.stringify({ type: "module", version }),
    );
    const result = spawnSync(
      process.execPath,
      [cli, "--check", "--config", path],
      { encoding: "utf8" },
    );
    const supported = version !== "1.0.1";
    assert.equal(result.status, supported ? 0 : 2, version);
    assert.equal(
      result.stdout,
      supported ? "Cache check: configuration-valid.\n" : "",
    );
    assert.equal(
      result.stderr,
      supported ? "" : "Cache check: missing-prerequisite.\n",
    );
  }
});
