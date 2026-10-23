import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, parse, relative } from "node:path";
import { promisify } from "node:util";

/** Identify the candidate independently of the checkout containing the checker. */
export async function candidateIdentity(entry: string) {
  entry = await realpath(entry);
  let sourceRoot = dirname(entry);
  let version: string | null = null;
  for (let directory = sourceRoot; ; directory = dirname(directory)) {
    try {
      const pkg = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      sourceRoot = directory;
      version = typeof pkg.version === "string" ? pkg.version : null;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (directory === parse(directory).root) break;
  }
  let revision: string | null = null;
  let dirty: boolean | null = null;
  try {
    const git = promisify(execFile);
    const repositoryRoot = (
      await git("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(entry) })
    ).stdout.trim();
    const candidatePath = relative(repositoryRoot, entry);
    // An ignored install can sit inside the consumer's checkout.
    const candidateFiles = (
      await git("git", [
        "--literal-pathspecs", "ls-files", "--cached", "--others",
        "--exclude-standard", "--", candidatePath,
      ], { cwd: repositoryRoot })
    ).stdout;
    if (candidateFiles) {
      revision = (
        await git("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
      ).stdout.trim();
      dirty = Boolean(
        (await git("git", ["status", "--porcelain"], { cwd: repositoryRoot })).stdout.trim(),
      );
    }
  } catch {
    /* Installed packages may have no Git metadata. */
  }
  const digest = createHash("sha256");
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const item of entries) {
      if (item.name.startsWith(".") || item.name === "node_modules") continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) await visit(path);
      else if (item.isFile()) {
        const content = await readFile(path);
        digest.update(
          JSON.stringify([relative(sourceRoot, path), content.length]),
        );
        digest.update(content);
      }
    }
  }
  await visit(sourceRoot);
  return {
    revision,
    dirty,
    version,
    sourceRoot,
    sourceHash: digest.digest("hex"),
    entryHash: createHash("sha256")
      .update(await readFile(entry))
      .digest("hex"),
    scope:
      "Package directory, or entrypoint directory when no package exists; excludes hidden files, symlinks, and node_modules. External dependencies are not covered.",
  };
}
