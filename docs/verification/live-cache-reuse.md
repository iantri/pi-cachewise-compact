# Live cache-reuse check before every release

Every release candidate must demonstrate real cache reuse on a representative supported provider/model configuration before publication. This is separate from deterministic integration tests, prefix-fidelity checks, and summary-quality review. Run it locally; ordinary tests must not require live credentials or services.

This procedure covers the reusable checker, configuration example, and two authored fictional histories. It does not require publishing verification results or running a particular release candidate. Each release requires its own live run and private record. Fixture authoring and deterministic checker tests do not satisfy that release gate.

## Running the checker

Use a source checkout with `npm ci` installed, Node >=22.19.0, and Pi >=1.1.0. The checker uses the pinned development SDK by default. It is a maintainer tool, excluded from the npm extension archive.

1. Copy [cache-reuse.example.json](cache-reuse.example.json) to a location outside this checkout. Replace its placeholders and cache-policy assumptions. Create the external results directory first. Use owner-only permissions for the configuration and results directory.
2. Choose a model with room for the selected fixture, system/tools, thinking, and output. Select `100k` or `250k` explicitly; the checker never changes the selection to make a run fit.
3. Check local prerequisites:

   ```sh
   node scripts/verify-cache-reuse.mjs --check --config /absolute/private/verification.json
   ```

4. Run paid inference only when ready:

   ```sh
   node scripts/verify-cache-reuse.mjs --live --config /absolute/private/verification.json
   ```

Configuration checking does not import provider extensions, resolve credentials, refresh catalogs, or contact a provider. A valid configuration is not proof that authentication, routing, or cache reuse will work. Live mode makes at most three inference requests: foreground, optimized summary, and continuation. Native fallback, retries, and additional model calls cannot produce a pass. All three actual request bodies must match the inspected payloads; a transport that bypasses inspection leaves the run unverified.

The terminal prints a fixed outcome. Exit status is `0` for a valid configuration or passing live check, `1` for a failed live check, and `2` for an unverified check, cancellation, or configuration error. Inspect the fresh `cache-check-*` directory under your configured output directory for `result.json`. No result path or model identifier is printed. `diagnostics: true` additionally writes `diagnostics.json`; leave it off for ordinary checks.

The private record separates prefix fidelity, cache measurements, retained-history checks, and informational fixture-term matches.

The `observations` fields `summaryTermsPresent` and `continuationTermsPresent` record whether all expected terms from selected facts occur in the summary and continuation, using case-insensitive substring matching. `discardedFactCount` records how many facts were selected from A; with none, both matches are `null`. These observations do not affect pass/fail and do not establish factual accuracy or completeness. `checks.continuationCompleted` records successful continuation flow separately.

The private record identifies the candidate separately from the checker checkout: candidate Git revision and dirty state when available, package version, entrypoint hash, and a source-directory digest. The digest covers the nearest package directory (or entrypoint directory without a package), excluding hidden files, symlinks, and installed dependencies; record external dependency changes separately. Inspect these and the limitations before making the release decision. Cache reuse does not prove general summary quality.

### Configuration fields

All paths must be absolute. Tilde expansion is not performed. Configuration and output paths are resolved through symlinks and must be outside the checkout. The output directory must already exist; each run gets a fresh private subdirectory.

| Field | Meaning |
| --- | --- |
| `version` | Configuration schema, currently `1`. |
| `fixture` | `100k` or `250k`; see the [fixture notes](../../fixtures/cache-reuse/README.md). |
| `provider`, `model` | Existing Pi provider and model IDs. |
| `outputDir` | External directory for private records. |
| `sdkDir` | Optional Pi package directory containing `package.json` and `dist/index.js`. Defaults to this checkout's development dependency. |
| `extensionPath` | Optional candidate entrypoint. Defaults to this checkout's extension. |
| `extensions` | Explicit provider/compatibility extension entrypoints. No other extensions are discovered. |
| `authPath` | Optional existing Pi auth file. Its values are resolved by Pi and never copied into config or reports. Without it, only Pi's environment-based credential resolution and an empty temporary auth store are available. |
| `modelsPath` | Optional existing Pi model definitions. Use this for provider routes and adapter compatibility options. Treat it as private if it contains credentials. |
| `thinking` | `off`, `minimal`, `low`, `medium`, or `high`, as supported by the model. |
| `cacheRetention` | Pi adapter retention option: `short` (default) or `long`. Applied consistently to all three requests. Provider support varies. |
| `contextTokens` | Explicit working context cap, no larger than the selected model's limit. |
| `reserveTokens` | Pi compaction reserve. Pi derives the substantive summary allowance from this. |
| `keepRecentTokens` | Pi's retained-tail target; Pi chooses the actual A/B boundary. |
| `maxOutputTokens` | Foreground and continuation output cap. This does not replace Pi's summary budget. |
| `timeoutSeconds` | Total live-run timeout, at most 1,500 seconds. |
| `diagnostics` | Optional full-content diagnostic capture; defaults to `false`. |
| `cache.minimumPrefixTokens` | Provider/model cache eligibility threshold used for local screening. |
| `cache.sharedPrefixUpperBoundTokens` | Conservative bound for system/tools reuse. It must also cover the actual serialized system/tools byte count plus 4,096 tokens of framing allowance. |
| `cache.minimumHistoryCacheTokens` | Required cache reads beyond that shared-prefix bound. Choose a meaningful amount of A. |
| `cache.retentionSeconds` | Maximum allowed foreground-to-summary dispatch gap for this check. It is not a promise that the provider retains cache entries that long. |

The example's numerical settings are starting points, not provider guarantees. The local fit screen uses the reference tokenizer with a 20% margin, a shared-prefix allowance, and output headroom. Actual serialized requests are screened again; provider-reported foreground input also constrains summary headroom. Tokenizers differ, so a locally valid fixture can still be unsuitable for a particular provider.

The checker follows Pi's Chat Completions cache-read precedence: `usage.prompt_tokens_details.cached_tokens`, then `usage.prompt_cache_hit_tokens`, then `usage.cached_tokens`. It also recognizes Anthropic Messages `cache_read_input_tokens`. Anthropic's total input includes uncached input, cache reads, and cache creation. Missing counters stay unknown. Unsupported protocols are rejected. The fake-provider suite covers both protocols; it does not constitute live Anthropic verification.

Explicit extensions are trusted code. They may apply their own behavior; the checker suppresses their terminal output, disables automatic resource discovery, and blocks unexpected inference traffic. It cannot sandbox arbitrary extension code. Prompt changes first introduced after the seeded history can prevent optimization and require investigation of that configuration.

## Public tools and private settings

Keep the checker, two authored fictional history fixtures, example JSON configuration, offline tests, and setup instructions in this repository. No developer-specific paths, endpoints, provider/model selections, or run results belong in those examples.

Each developer copies the example to an external JSON configuration file. The checker must accept an explicit configuration path. A conventional location such as `~/.config/pi-cachewise-compact/verification.json` may be documented as a convenience; it must not be required. A separate private working directory is also suitable. Do not require a second `.env` configuration mechanism.

The configuration selects:

- The candidate extension and compatible Pi installation, using installed dependencies where appropriate and explicit paths where needed.
- The existing Pi provider/model, thinking settings, and any provider/cache options needed for the run.
- Only the provider or compatibility extensions deliberately included in the check.
- Selection of the approximately 100,000-token or 250,000-token fixture, and bounded run settings appropriate to the model's context limit and cache eligibility conditions.
- An external directory for private run records and optional diagnostics.

Use Pi's existing credential resolution. Do not introduce a second credentials file, copy credentials into the configuration example or run record, or print authentication values. Do not change global Pi settings. The checker must not hard-code one developer's provider, model, endpoint, extension combination, or installation layout.

Document setup, required fields, path resolution, and the supported Pi minimum. Provide a configuration-check mode that validates inputs and local prerequisites without provider requests, authentication probes, catalog refreshes, or other network activity. Live inference must require an explicit invocation and remain outside the default test command and import path. Report missing prerequisites clearly without dumping configuration or raw errors.

## Isolation and synthetic history

Use a fresh temporary Pi session and workspace with a fixed public system prompt. Do not automatically discover working-directory or home-directory instructions, skills, prompt templates, extensions, or session history. Load only the explicitly configured provider and compatibility extensions. Reuse existing credential resolution without importing the rest of the developer's agent environment.

The fixtures are authored by driving actual isolated Pi coding sessions in temporary fictional projects, then reviewing and normalizing the saved conversations. The checked-in runner only replays the static artifacts. Provide two conversations: one targeting approximately **100,000 history tokens**, the other approximately **250,000 history tokens**. The runner loads the chosen fixture; it does not generate conversation content or expand a template. Do not accept personal transcript files or discover existing sessions. Private transcript-comparison tools are separate from this release check.

Use plausible requirements, investigation, tool calls and matching results, corrections, partial progress, and unfinished work. Preserve valid message/tool-call structure. Meet the size targets with substantive, varied fictional task material, not repeated filler. Each fixture includes a short task description, version, and key facts for informational term matching. Pi chooses the actual retained boundary; judge the summary against actual discarded history A, not later corrections retained in B.

The targets describe conversation history, excluding the system/tools prefix and live request/output overhead. Token counts differ by tokenizer and adapter serialization. Document the reference tokenizer/counting method and measured fixture sizes; do not claim the same exact count for every model. The runner validates the selected fixture against the effective context limit, cache eligibility, and foreground/summary headroom. It must report an unsuitable fixture before inference where this can be established locally, rather than silently truncating, padding, or switching fixtures. Distinguish local estimates from provider-reported live input counts. The 250,000-token fixture requires a model with sufficient additional headroom; a nominal 250,000-token context window is not enough.

Populate the temporary session with the authored messages, then make a real foreground request over them before compaction. Loading history alone does not establish a provider cache entry. Preserve the fixture content across runs; any later fixture edit gets a new version so private results identify the exact input used.

Exercise real foreground inference, optimized compaction, and continuation through Pi's actual session and provider adapter. Synthetic source history can establish cache reuse and history preservation; it does not establish summary quality across real workloads. Configured extensions and provider responses can still introduce sensitive content, so treat all generated output as private.

## Procedure

1. Select the candidate revision/version and external configuration. Validate local prerequisites without inference. Keep resolved Pi/Node versions, protocol, thinking settings, selected extensions, and cache settings in the private run record.
2. Select a cache-capable provider or engine with per-request cache-read reporting. Establish its minimum eligible prefix size, retention conditions, and counter semantics. Choose one of the two authored fixtures and check its fit. Discarded history A must be large enough to distinguish conversation reuse from the shared system/tools prefix, while the complete requests fit the selected model's budget.
3. Run ordinary foreground inference to establish the prefix. Then request optimized compaction promptly with the same model and effective request configuration. Do not substitute repeated summary requests or a separate cache-warming request for foreground-to-compaction reuse.
4. Identify the optimized summary request separately from foreground requests and native fallback. Measure total input, cache reads, cache writes when available, output usage, and duration. Some adapters report uncached input separately; do not double-count cached tokens or infer a cache hit from elapsed time.
5. Establish the size or conservative bound of the shared system/tools prefix. Confirm that measured reuse includes a substantial portion of A beyond that shared prefix. A tiny nonzero cache counter alone is insufficient; ambiguous attribution is unverified.
6. Confirm that optimized compaction was committed, the A/B boundary is correct, B is unchanged, and subsequent context is usable. Compare payloads and generated text in memory where possible. Record fidelity, cache reuse, and summary-quality observations separately. A cache hit does not excuse failed compaction, changed retained history, or failed continuation flow. Missing fixture terms do not fail this check; human assessment of summary quality is separate.
7. Save the private run record. The maintainer uses it for the release decision. Do not publish results, attach diagnostics to GitHub, or commit any run record. Historical runs do not replace a run on the current candidate.

## Private output and diagnostics

By default, persist only measurements, non-secret resolved configuration details, checks, the outcome, and limitations. Exact provider/model names and local paths may be useful in this private record; they must not be copied into public examples or issues. Reference credential sources without saving their values. Do not serialize the complete configuration or provider error object blindly.

Full request/response capture requires an explicit diagnostic option. Payloads, generated summaries, extension logs, and detailed errors must remain in the private output directory. Diagnostic capture must omit authentication headers and credential values; enabling it is not permission to record secrets. Do not retain full Pi session transcripts or temporary response content by default merely because Pi wrote them during the run. Clean up the temporary workspace/session after use, including failed or cancelled runs.

Require configuration and output paths outside the public checkout. Resolve symlinks before checking that boundary and reject destinations that point back into it. Create private run directories/files with owner-only permissions where supported. Use fresh run locations so a new run cannot overwrite existing evidence. Ignore rules may provide extra protection but do not replace these checks.

Normal terminal output should contain fixed progress/outcome messages, not provider/model identifiers, absolute paths, configuration dumps, raw responses, or arbitrary errors. Handle output from loaded extensions and failure paths under the same rule. If detailed logs are requested, capture them privately. Never write generated evidence into the checkout or automatically stage, commit, upload, or post it.

## Result and release decision

- **Pass:** the candidate completes optimized compaction and the summary request has measured, meaningful reuse of A beyond the shared system/tools prefix. The private record explains the measurements and their scope.
- **Unverified:** cache measurements are missing or ambiguous, prerequisites are unavailable, or only foreground/native requests were measured. Publication waits for a verified run.
- **Failed:** the controlled run shows no meaningful reuse of A, or compaction or continuation flow fails. Investigate configuration, cache retention, routing, and prefix fidelity. Record corrective reruns privately; do not silently select a favorable attempt.

One representative supported configuration and one suitable fixture are sufficient for the release gate; creating both fixtures does not require running both before every release. This gate does not require a provider/model matrix, paired native benchmark, fixed speedup, or universal cache-hit percentage. If only the system/tools prefix is reused, the intended conversation-cache benefit has not been demonstrated. A pass on one protocol does not establish another; keep deferred Anthropic claims explicit.

Rerun after candidate changes affecting request construction, prompts, budgeting, adapters, or runtime packaging. Documentation-only changes may reference the tested revision if runtime/package contents relevant to the check are unchanged and that limitation is recorded privately.

The private record includes date, candidate revision/version, Pi/Node versions, fixture version/size, non-secret tested configuration, reproducible steps, request attribution, input/cache/output counts, shared-prefix bound, duration, compaction/continuation outcome, decision, limitations, and corrective reruns. Results are for the maintainer's release decision, not a public report.

This is a release requirement, not an automatic runtime fallback policy. Cache eviction or missing cache counters on an ordinary user request do not themselves invalidate a correctly constructed summary request.

## Offline verification of the checker

Validate both fixtures' message/tool-call structure, declared sizes, and metadata. Test fixture selection and rejection of unsuitable context budgets without modifying fixture content. Use deterministic tests for configuration validation, isolation, output location restrictions (including symlinks), default versus diagnostic capture, and output handling on failure/cancellation. Use fictional canary values for local paths, identifiers, response text, extension output, and credentials; verify they cannot appear in checkout files or normal stdout/stderr, and credentials are absent even from diagnostic captures.

Test request attribution, counter normalization, and pass/failed/unverified classification separately. Zero or unknown cache reads, reuse explainable only by system/tools, and native fallback must never produce a pass. These tests validate the checker; fake cache counters cannot satisfy the live release gate.
