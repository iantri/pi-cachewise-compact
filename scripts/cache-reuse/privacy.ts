import { readFile } from "node:fs/promises";

const metric =
  /^(?:input|output|prompt|completion|cached|cache_write|cache_read_input|cache_creation_input|max|max_completion|budget)_tokens$/;
const sensitive =
  /api.?key|authorization|cookie|password|secret|token|credential|(?:^|\/)(?:key|access|refresh)$/i;
/** Capture only inside the disposable worker. Never capture headers or serialize raw errors. */
export class PrivateCapture {
  private secrets = new Set<string>();
  private logs: Buffer[] = [];
  private logBytes = 0;
  private overflow = false;
  private stdout = process.stdout.write;
  private stderr = process.stderr.write;
  constructor(private diagnostics: boolean) {
    for (const [key, value] of Object.entries(process.env))
      if (sensitive.test(key) && value) this.add(value);
    const sink = ((
      chunk: string | Uint8Array,
      encodingOrCallback?: unknown,
      callback?: () => void,
    ) => {
      if (this.diagnostics && !this.overflow) {
        const bytes =
          typeof chunk === "string"
            ? Buffer.from(
                chunk,
                typeof encodingOrCallback === "string"
                  ? (encodingOrCallback as BufferEncoding)
                  : "utf8",
              )
            : Buffer.from(chunk);
        this.logs.push(bytes);
        this.logBytes += bytes.length;
        if (this.logBytes > 1_000_000) {
          this.logs = [Buffer.from("[logs omitted: size limit]")];
          this.overflow = true;
        }
      }
      if (typeof encodingOrCallback === "function") encodingOrCallback();
      else callback?.();
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = sink;
    process.stderr.write = sink;
  }
  private add(value: string) {
    if (value) {
      this.secrets.add(value);
      this.secrets.add(encodeURIComponent(value));
      this.secrets.add(JSON.stringify(value).slice(1, -1));
    }
  }
  url(value: string) {
    try {
      const url = new URL(value);
      this.add(url.username);
      this.add(url.password);
      for (const secret of url.searchParams.values()) this.add(secret);
    } catch {
      /* Ordinary text is not a URL. */
    }
  }
  collect(value: unknown, key = "") {
    if (typeof value === "string" && /^https?:\/\//i.test(value))
      this.url(value);
    if (typeof value === "string" && sensitive.test(key)) this.add(value);
    else if (value && typeof value === "object")
      for (const [name, child] of Object.entries(value))
        this.collect(child, `${key}/${name}`);
  }
  headers(headers: Headers) {
    for (const [key, value] of headers)
      if (/auth|cookie|key|token|secret/i.test(key)) {
        this.add(value);
        if (/^Bearer /i.test(value)) this.add(value.slice(7));
      }
  }
  async credentials(path?: string) {
    if (!path) return;
    try {
      this.collect(JSON.parse(await readFile(path, "utf8")));
    } catch {
      /* Resolution errors are handled by Pi, without printing them. */
    }
  }
  serialize(value: unknown) {
    const secrets = [...this.secrets].sort((a, b) => b.length - a.length);
    const scrub = (text: string) =>
      secrets.reduce(
        (result, secret) => result.split(secret).join("[redacted]"),
        text,
      );
    const clean = (item: unknown): unknown => {
      if (typeof item === "string") return scrub(item);
      if (Array.isArray(item)) return item.map(clean);
      if (item && typeof item === "object")
        return Object.fromEntries(
          Object.entries(item).map(([key, child]) => [
            scrub(key),
            sensitive.test(key) &&
            !metric.test(key) &&
            key !== "credentialSource" &&
            !/Tokens$|tokenizer$|Tokens|cacheRead|cacheWrite/.test(key)
              ? "[redacted]"
              : clean(child),
          ]),
        );
      return item;
    };
    return JSON.stringify(clean(value), null, 2) + "\n";
  }

  diagnosticsData(
    payloads: unknown[],
    responses: unknown[],
    errors: unknown[],
  ) {
    return {
      payloads,
      responses,
      errors,
      logs: Buffer.concat(this.logs).toString("utf8"),
    };
  }
  restore() {
    process.stdout.write = this.stdout;
    process.stderr.write = this.stderr;
  }
}
