/** Raw provider counters stay unknown when absent; Pi's normalized zero is not evidence. */
export interface UsageMeasurement {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  invalidCounters?: boolean;
}

export function recordUsage(
  measurement: UsageMeasurement,
  data: unknown,
  api: string,
): void {
  const event = data as {
    usage?: Record<string, any>;
    message?: { usage?: Record<string, any> };
  };
  const usage = event.usage ?? event.message?.usage;
  if (!usage) return;
  for (const value of [
    usage.prompt_tokens,
    usage.completion_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cache_write_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cached_tokens,
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      measurement.invalidCounters = true;
  }
  if (api === "openai-completions") {
    if (Number.isFinite(usage.prompt_tokens))
      measurement.input = usage.prompt_tokens;
    const cached =
      usage.prompt_tokens_details?.cached_tokens ??
      usage.prompt_cache_hit_tokens ??
      usage.cached_tokens;
    if (Number.isFinite(cached)) measurement.cacheRead = cached;
    if (Number.isFinite(usage.prompt_tokens_details?.cache_write_tokens))
      measurement.cacheWrite = usage.prompt_tokens_details.cache_write_tokens;
    if (Number.isFinite(usage.completion_tokens))
      measurement.output = usage.completion_tokens;
  } else {
    if (Number.isFinite(usage.input_tokens))
      measurement.input = usage.input_tokens;
    if (Number.isFinite(usage.cache_read_input_tokens))
      measurement.cacheRead = usage.cache_read_input_tokens;
    if (Number.isFinite(usage.cache_creation_input_tokens))
      measurement.cacheWrite = usage.cache_creation_input_tokens;
    if (Number.isFinite(usage.output_tokens))
      measurement.output = usage.output_tokens;
  }
}
