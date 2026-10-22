import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { candidateIdentity } from "../scripts/cache-reuse/identity.ts";

test("candidate identity follows the external checkout, including imported implementation changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "candidate-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    promisify(execFile)("git", args, { cwd: root });
  await git("init", "-q");
  await mkdir(join(root, "extension"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ version: "3.2.1" }),
  );
  const entry = join(root, "extension/index.ts");
  await writeFile(entry, 'export { default } from "./logic.ts";');
  await writeFile(join(root, "extension/logic.ts"), "export default () => 1;");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const before = await candidateIdentity(entry);
  assert.equal(before.revision, (await git("rev-parse", "HEAD")).stdout.trim());
  assert.equal(before.version, "3.2.1");
  assert.equal(before.dirty, false);
  await writeFile(join(root, "extension/logic.ts"), "export default () => 2;");
  const after = await candidateIdentity(entry);
  assert.equal(after.dirty, true);
  assert.equal(after.entryHash, before.entryHash);
  assert.notEqual(after.sourceHash, before.sourceHash);
});

test("unversioned candidates get a source digest covering sibling imports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "candidate-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "index.ts");
  await writeFile(entry, 'export { default } from "./logic.ts";');
  await writeFile(join(root, "logic.ts"), "export default () => 1;");
  const before = await candidateIdentity(entry);
  await writeFile(join(root, "logic.ts"), "export default () => 2;");
  const after = await candidateIdentity(entry);
  assert.equal(before.revision, null);
  assert.notEqual(after.sourceHash, before.sourceHash);
});
