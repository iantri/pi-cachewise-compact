export const MINIMUM_PI_VERSION = "1.0.2";

/** Admit stable releases at or above the documented minimum; Pi owns its peers. */
export function piVersionDiagnostic(version: unknown): string | undefined {
  const match =
    typeof version === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\da-zA-Z.-]+)?$/.exec(
      version,
    );
  if (match) {
    const [major, minor, patch] = match.slice(1, 4).map(Number);
    if (major > 1 || (major === 1 && (minor > 0 || patch >= 2)))
      return undefined;
  }
  return `unsupported-pi-version-requires-at-least-${MINIMUM_PI_VERSION}`;
}
