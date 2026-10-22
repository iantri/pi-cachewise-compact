## Problem Statement

Pi users running long coding sessions can wait through slow compaction because native summarization presents older conversation material in a new prompt rather than reusing its existing inference prefix. Users need useful summaries and intact recent history without a new workflow, private configuration, or memory system.

Phase 1 improves compaction at Pi's existing manual and automatic trigger points. It does not introduce early or idle-time compaction.

## Solution

Provide an installable, default-off Pi extension. Users select existing provider IDs and enable it. At an eligible compaction, send the existing effective system/tools prefix and only the older material Pi selected for summarization (A), followed by a summary instruction, through Pi's configured model runtime. Pi commits the validated summary once and retains recent material (B) unchanged.

Use Pi's provider abstraction, not a separate HTTP client. Required implementation and automated coverage include OpenAI-compatible Chat Completions and Anthropic Messages. Unsupported transformations or requests receive an explicit native fallback. Ordinary supported configurations must actually optimize; a fallback-only implementation does not satisfy this spec.

Preserve native continuation, recovery, persistence, and user interaction. Provide an invocation-local `/compact-native` command and concise configuration/status commands. Treat cache reuse and reduced waiting as intended benefits, not measured facts without evidence.

## User Stories

1. As a Pi user, I want to install the extension without editing source, so that I can use my existing provider configuration.
2. As a new user, I want the extension off with no selected providers, so that installation does not silently change inference behavior.
3. As a user, I want to select an exact existing provider ID, so that I control which requests are eligible.
4. As a user, I want selection to cover all models under that provider, so that changing models requires no duplicate setup.
5. As a user, I want an empty provider selection to mean none, so that clearing selections never enables every provider.
6. As a user, I want enablement and selections to persist across sessions, so that setup is not repeated.
7. As a user, I want disabling the extension to preserve selections, so that I can resume my configuration later.
8. As a user, I want omitted provider arguments resolved at command time, so that selecting the current provider does not become a moving rule.
9. As a user, I want unknown provider additions rejected and unavailable saved IDs removable, so that settings remain understandable.
10. As a user, I want available, selected, and current provider IDs listed without secrets, so that I can troubleshoot setup.
11. As a user, I want ordinary manual compaction to optimize when eligible, so that I do not learn a replacement workflow.
12. As a user, I want native automatic compaction and overflow recovery preserved, so that optimization does not change when work is interrupted.
13. As a user, I want focus instructions respected, so that summaries emphasize what matters to my task without changing their scope.
14. As a user, I want one-time native compaction with unchanged focus text, so that I can bypass optimization without changing settings.
15. As a user, I want rejected, failed, or cancelled native bypass commands to affect no later operation, so that bypass remains invocation-local.
16. As a user, I want known competing compactors identified, so that another extension's summary is never mislabeled native.
17. As a user, I want only A summarized and B retained verbatim, so that recent work is neither exposed to the summarizer nor duplicated in its output.
18. As a user, I want split-turn boundaries handled exactly, so that retained tool sequences keep the context they need.
19. As a user, I want previous summaries consolidated once, so that repeated compaction retains important earlier information.
20. As a user, I want the effective system content, tools, message representations, and thinking settings preserved, so that the request can reuse its established prefix.
21. As a user, I want ordinary Chat Completions and Anthropic Messages configurations supported through Pi, so that I do not need a new provider client or credentials.
22. As a user, I want compatible transformations accounted for and unsupported ones disclosed, so that optimization is not falsely advertised.
23. As a user, I want images confined to B not to block eligible A-only requests, so that irrelevant content restrictions do not cause unnecessary fallback.
24. As a user, I want restart and navigation handled conservatively without warm-up inference, so that uncertainty does not cause hidden requests.
25. As a user, I want summaries to preserve constraints, decisions, progress, blockers, and exact technical details as of A, so that I can continue the task reliably.
26. As a user, I want ordinary summary budgeting preserved, so that faster compaction does not secretly mean aggressive shortening.
27. As a user, I want invalid, truncated, tool-calling, or non-saving results rejected, so that unusable candidates cannot replace context.
28. As a user, I want no eligible material to remain a native no-op, so that the extension does not invent work.
29. As a user, I want maintenance inference to execute no project tools or ordinary task turns, so that compaction has no project side effects.
30. As a user, I want the summary stored only as compaction context, so that my conversation does not contain a duplicate task answer.
31. As a user, I want history, file-operation information, and observed usage preserved across reopen and native transitions, so that session records remain useful.
32. As a user, I want cancellation to stop maintenance without triggering native fallback, so that my request to stop is respected.
33. As a user, I want stale candidates discarded after relevant state changes, so that newer work cannot be replaced.
34. As a user, I want accepted input preserved exactly once through Pi's native interaction behavior, so that compaction cannot lose or duplicate work.
35. As a user, I want competing built-in compaction to follow Pi's native cancellation behavior safely, so that the extension does not require a patched host.
36. As a user, I want extension-owned competing compaction commands rejected as busy, so that they do not defer an unexpected bypass.
37. As a user, I want unsuccessful optimization to fall back once when still valid, so that I can keep working without confirmation prompts or retry loops.
38. As a user, I want provider timeout and transport behavior inherited, so that slow local inference is not killed by an arbitrary short timeout.
39. As a terminal or RPC user, I want configuration, status, and integrity guarantees through my normal interface, so that correctness does not depend on a terminal UI.
40. As a user, I want outcome, duration, usage, context sizes, and reported cache metrics distinguished from unknown values, so that I can assess behavior honestly.
41. As a user, I want small last-operation metadata available after reopening, so that troubleshooting does not require full request captures.
42. As a user, I want no telemetry, extra service, or default full-payload logging, so that my conversation and credentials remain private.
43. As a maintainer, I want deterministic integration tests of actual outgoing requests and persisted sessions, so that prefix and integrity regressions are caught before release.
44. As a user, I want supported behavior distinguished from configurations actually exercised, so that I understand the limits of release evidence.

## Implementation Decisions

### Authority and release scope

The PRD v1.2 Phase 1 behavior is the product baseline, with two approved amendments: both Chat Completions and Anthropic Messages require implementation and automated coverage; built-in competing manual compaction may retain Pi's native cancellation behavior. Anthropic live verification is deferred to #1 and is not an initial release gate. The PRD's Section 5 Phase 2 requirements remain retained requirements for a separate phase; only Appendix B's proposed defaults and rules are unapproved. Neither belongs in this implementation.

Pi 1.0.2 is the initial exact compatibility target, based on released source inspection, not completed runtime testing. Establish that target through the integration suite before claiming support. Widen the version range only with evidence. No patched host or private API dependency is permitted. The source review identifies implementation risks; it does not constitute completed acceptance testing.

Document the supported version range and required capabilities. Keep non-UI behavior portable across the operating systems supported by that range. Installation must not require the author's provider, model, endpoint, engine version, or private setup. Distribute no personal settings, selected provider IDs, request captures, or credentials. The named smoke configuration is a test target, not a product dependency.

### Module and interface

Keep the compaction behavior behind Pi's extension interface. Pi continues to own trigger selection, retained-boundary selection, storage, native fallback, and continuation. Use the simplest implementation that satisfies the guarantees below. Do not introduce independent queues, retention policies, protocol clients, or a generic transformation framework.

Use the real extension lifecycle and model registry. Keep maintenance requests outside ordinary conversation history. Preserve tool declarations but never execute returned tool calls. Reject them as invalid output.

Require no model-facing compaction tool, permanent workflow instructions, or special user ritual. Do not display or stream the full summary as a normal task answer; show it only on explicit inspection. Do not rewind, branch, or delete substantive history to hide maintenance artifacts. Leave native trigger thresholds and retained-tail settings unchanged.

### Request provenance and prefix fidelity

Construct the summary request faithfully from Pi's exact history selection and effective request configuration. Do not select history by text matching or a guessed cutoff. Foreground request observation, transient captures, or provenance records may be used where the integration needs them, but are not required infrastructure. Do not send preparatory inference.

At `session_before_compact`, use Pi's preparation and exact retained-entry identity. A includes the discarded split-turn prefix and previous-summary context when applicable. Preserve the prior summary's normal representation exactly once. B and supplemental state derived from B must not enter maintenance inference. A fact already in A remains eligible even if B repeats it.

Use the configured registry/runtime and provider adapters with the same model, routing, tools/order, system content, thinking/template behavior, and relevant request settings. Append the summary instruction after A. Preserve ordinary transport and timeout behavior and obtain authentication through Pi rather than storing secret headers.

For supported configurations, verify actual outgoing request fidelity in integration tests, including adapter message merging or bridge content at the retained boundary. Compare the model-visible prefix and prompt-affecting fields, not unrelated JSON transport bytes. These tests establish fidelity for the configurations exercised; they do not establish compatibility with arbitrary installed transformations. Neither runtime comparison nor these tests certify a cache hit.

The provider abstraction handles protocol conversion but does not automatically replay the agent's context and payload extension pipeline. Support ordinary configurations of both required protocols and identified compatible transformations. Compare the maintenance request with the foreground request as observed by the extension. Use native fallback when that comparison detects a mismatch, or a known incompatibility prevents preserving the effective prefix or excluding B-derived state.

The observation may precede other extensions' payload or header transformations. The extension is not required to detect transformations that occur outside its observation point. Those combinations are outside the supported compatibility scope unless separately established as compatible. Document this limitation; do not describe the runtime comparison as verification of the final outgoing request. Actual prefix fidelity and exclusion of B-derived state remain mandatory for supported configurations.

Do not build a universal transformation analyzer or depend on private Pi APIs, network interception, or a hard-coded provider or engine brand list.

After restart or navigation, fall back only if the correct effective prefix cannot be established; a new foreground request is not inherently required. Cache eviction alone does not invalidate known-correct input. Unsupported content in A can fall back; unsupported content only in B cannot alone disqualify A. No post-compaction warm-up request.

### Summary contract and validation

Use the supported Pi release's native summary objectives, structure, focus handling, and substantive answer allowance as defaults. Include split-turn continuation objectives where relevant. Add 32 output tokens for the response delimiters and separating whitespace, on top of the normal answer allowance. This covers the wrapper, not arbitrary preambles. Preserve provider-specific thinking accounting. Check headroom using A, the complete instruction, and the answer plus wrapper allowance. If model limits or serialized headroom cannot preserve those allowances, fall back before optimized dispatch. Do not shrink the answer or thinking budget to fit.

Preserve goals, constraints, progress, blockers, decisions and rationale, next steps, and continuation-critical details. Keep relevant paths, symbols, commands, errors, and test outcomes accurate. Describe state as of A: do not invent details, report attempted work as completed, revive superseded decisions, or incorporate developments available only in B. Focus instructions may change emphasis, but later facts supplied in them must not be presented as events established within A. They never authorize reading B, moving the boundary, or bypassing safeguards. Assess these content obligations through focused continuity review, not an added model judge.

Ask optimized maintenance inference for exactly one case-sensitive `<compaction-summary>` opening marker and one `</compaction-summary>` closing marker, in that order. These are plain-text delimiters around the normal Markdown summary, not XML. Missing, reversed, repeated, nested, incomplete, empty, or whitespace-only blocks are invalid. Alternate capitalization, attributes, and self-closing forms do not substitute for the exact markers. Literal reserved markers inside a summary make it ambiguous.

Extract only newly generated final text. Ignore surrounding text without inspecting its words. Trim boundary whitespace and preserve the enclosed content otherwise; do not decode entities or require XML escaping. Markdown, code, unrelated angle-bracket text, and concise content remain valid. One outer block contains the ordinary summary, split-only checkpoint, or both mixed-split sections. Extract before assembling split-only summaries, adding file metadata, or measuring context saving. Preserve any prior summary kept verbatim outside this parsing step.

A candidate also needs an accepted complete finish state, no tool calls, and no declared truncation. A closing marker cannot override these checks; Anthropic's paused turn is incomplete. Reasoning-only output is invalid. Do not classify acknowledgements, promises, refusals, or other wording. Do not require headings or a minimum length. A refusal or inaccurate summary inside a valid block can pass: validation checks format and operation integrity, not meaning. Summary quality remains a product goal assessed through source-grounded continuity review. Do not add a failure marker, judge model, repair request, or extension-owned retry. Native bypass, pass-through, and fallback keep their ordinary unwrapped prompts and responses.

Compare the final assembled summary, including preserved prior context and file metadata, against the pre-compaction context using Pi's normal accounting. Exclude discarded wrapper and surrounding text from stored-context size; retain reported usage for the whole response. Require positive saving, not an arbitrary percentage. Preserve B and the boundary regardless of result size. No eligible material uses Pi's native no-op without optimized inference.

### Lifecycle, commit, and fallback

Before returning a candidate, verify that it still belongs to the current session, source history/boundary, model, and relevant request configuration. Use Pi's lifecycle and the minimum operation-local state needed; no separate transaction framework is prescribed. Settings changes affect subsequent operations; accepted queued input alone does not invalidate unchanged source state.

Use the host abort signal. Cancelled or stale attempts must explicitly cancel rather than throw an error that the host might turn into native fallback. For a valid unsuccessful optimization, notify briefly and return no custom result so the same Pi operation runs native summarization once. Do not recursively invoke compaction. A valid optimized result is committed once with no native summary request. Native failure ends the operation with recoverable history and no extension retry loop.

When disabled or the provider is unselected, pass through to native behavior without an error or failed-optimization notice. An unsupported request must not alter provider selection. Configuration commands do not implicitly cancel in-flight work; actual model or source-context changes still invalidate stale candidates. If Pi cannot accept input, report busy rather than inventing another queue.

Pi's saved compaction is the commit point. Cancellation before it discards the candidate; cancellation after it must not be reported as undoing the saved result. Preserve Pi's native queue and continuation behavior, including its terminal/RPC differences. No extra user request, continuation, or maintenance response enters normal history.

Approved host exception: on Pi 1.0.2, a second built-in manual compaction can cancel the first before the extension hook. Preserve that native behavior instead of requiring rejection of the second operation. Cancellation must still be safe: no stale commit, duplicate input, leaked bypass, or extension-created fallback. Extension-owned commands must reject competing compaction as busy before requesting another operation. Characterize both native entry points rather than assuming their UI admission is identical.

### Native bypass and conflicts

Implement `/compact-native [optional focus instructions]` using the documented command/context compaction interface. Forward focus unchanged and bypass only that invocation. No success, failure, cancellation, rejection, or no-op may leave a bypass armed for a later operation. Choose the simplest mechanism that meets this invocation-local contract; no particular token or asynchronous-context mechanism is prescribed.

For that invocation, make no optimized inference attempt, supply no custom summary, and do not modify Pi's native summarization request. Native summary generation must use the user's ordinary Pi settings.

Do not change persistent settings. Do not try optimization after an explicitly native failure. Native means Pi's built-in summarizer, but other extensions can override it. The limited known-conflict check is advisory in status only; `/compact-native` must not run that check or reject the command on that basis. Do not disable other extensions. Report when another extension supplied the committed summary. Passive observers and demonstrated compatible request transformers may coexist.

### Persistence and accounting

Approved Pi 1.0.2 diagnostics exception: do not subscribe to `session_compact_failed`. Its awaited dispatch exposes a host controller-cleanup race when built-in manual compactions overlap. Preserve successful-operation metadata and explicit `/compact-native` callback outcomes. Some failed or cancelled built-in operations may have no durable outcome record; status must disclose this and defer to Pi's operation error, not claim completion. No host patch, retry, or extra inference is required to restore those diagnostics.

Let Pi save the summary, exact retained identity, context information, successful summary usage, and reconstruction metadata. Preserve raw substantive history and session navigation. Carry cumulative file-operation metadata across optimized, native, and reopened sessions without importing B's operations. Pi's handling of extension-originated compactions makes this a specific integration acceptance case, not a claim that returning familiar metadata keys is sufficient.

Include reported usage from discarded optimized attempts in ordinary operation metadata when Pi cannot include it in native totals. Keep those costs visible and clearly separate from native totals; no separate accounting subsystem is required. Do not invent usage for aborted streams without reported measurements. Successful optimized usage belongs in Pi's compaction accounting and must not be double-counted.

Persist small versioned last-operation metadata per session: outcome, trigger, duration, reported summary input/output usage, before/after context measurements, cache measurements and availability, and concise limitation/failure reason. Distinguish optimized completion, explicitly requested native compaction, native fallback, failure, and cancellation. Normal native pass-through while disabled or unselected is not a failure or an explicitly requested bypass. Represent unavailable measurements as unknown, including provider fields normalized to zero without evidence of measurement; elapsed time is not evidence of a cache hit. Full payloads and uncommitted candidates remain transient; no telemetry or default payload or credential logging. Detailed export is not required. If provided, it must require an explicit action, warn about conversation/project contents, and exclude credentials.

### Configuration and commands

Persist user-level enablement and exact provider-ID selections, initially off and empty. Reuse Pi's provider catalog, endpoint, authentication, and model configuration. No model-name filters, local/cloud guessing, duplicate credentials, or project overrides.

- `/compact [focus]`: retain the built-in entry point and automatic eligibility/fallback behavior.
- `/compact-native [focus]`: invocation-local native operation, subject to busy admission checks; other extensions may override the summary.
- `/cachewise-compact on` and `off`: persist enablement without changing selections; on with no selections reports inactive.
- `/cachewise-compact providers`: list available/configured IDs, selected state, current ID, and saved IDs no longer available.
- `/cachewise-compact provider add [id]`: resolve omitted ID to the current provider now; require an existing ID and report the effective selection without enabling globally.
- `/cachewise-compact provider remove [id]`: resolve omitted ID now; allow removing unavailable saved IDs; leave other selections unchanged.
- `/cachewise-compact status`: show enablement, selections, current provider, availability/limitation, and last session outcome.

Repeated add/remove is harmless. Missing current provider requires an explicit ID. New provider IDs are never automatically selected. Default setup is provider add followed by on. Explain commands in help, including terminal and RPC invocation. Use RPC-visible status/errors as well as terminal UI; command acceptance is not proof of compaction completion.

## Testing Decisions

The user approved one primary integration seam: real Pi sessions and the actual extension/runtime/provider adapters, with loopback fake HTTP/SSE endpoints and temporary file-backed session/settings storage. Only the external provider is fake. Drive public session operations and registered commands. Do not make mocked hook invocation or a replaced boundary selector the main correctness evidence.

Good tests assert outgoing request semantics, user-visible outcomes, request counts, retained context, and saved/reopened state—not internal helper calls or incidental implementation layout. The module under test is the complete compaction extension through its public Pi interface.

Use the existing compaction, fidelity, lifecycle, and controls integration tests. Keep the real Pi registry and provider adapters when verifying wire fidelity.

Required focused coverage:

Use a few representative histories and reuse them across checks. The list below describes behaviors to cover, not a matrix of every protocol, frontend, setting, history, and failure mode. Keep shared lifecycle checks at the real-session seam; repeat protocol-specific request checks only where serialization differs. Table-test cheap invalid-response cases. Test extension-owned behavior rather than re-testing Pi's entire implementation.

- Both required protocols take the optimized path in an ordinary configuration with an arbitrary configured provider ID. Compare captured foreground and maintenance payloads for stable system/tools/A representation, order and relevant settings; use B-only canaries and B-derived transformation fixtures to detect provenance violations. Exercise supported thinking representations as well as thinking off.
- Whole-turn and split-turn boundaries, prior summaries, corrections, repeated compaction, context edits, and unsupported content only in B.
- No-op, insufficient headroom, missing/malformed/multiple/nested/empty summary blocks and reasoning-only/tool-calling/truncated/incomplete output, no saving, provider error, unsupported transforms, native fallback failure, and correct request counts.
- Valid summary blocks with ignored preambles and trailing text, concise content, Markdown/code, and formerly rejected wording. A deliberately wrapped refusal or acknowledgement tests the format contract, not summary quality. Verify extraction before assembly, positive saving, full-response usage, saved/reopened state, and no response bodies in routine diagnostics.
- Answer plus wrapper headroom for both protocols, including Anthropic thinking. Tight context or model limits fall back before optimized dispatch without reducing the substantive allowance.
- Native bypass with exact focus forwarding and an unchanged native summarization request; success/failure/cancellation/no-op/busy cases leave no armed bypass or changed settings.
- Delayed streams to reproduce cancellation, model/history/navigation changes, queued input, and competing operations. Assert pre-commit discard, post-commit completion, and no stale replacement, tool execution, duplicate continuation, or lost accepted input.
- Saved usage and cumulative file metadata through optimized → optimized → native → reopen. Separate discarded-attempt usage and unknown cache data honestly.
- Default-off/provider controls, persistence, unavailable IDs, unknown additions, and status privacy. Disabled/unselected pass-through is not an error; outcomes distinguish explicit native, fallback, optimized completion, failure, and cancellation. If export is added, test its explicit action, warning, and credential exclusion.
- Use small terminal and RPC smoke checks for command/status, busy, and cancellation behavior. These may be manual or use existing tooling; dedicated subprocess or terminal automation infrastructure is not required. Add frontend-specific automated regressions only where extension behavior or an observed defect warrants them.

One live smoke workflow uses the approved existing provider `synthetic`, model `syn:small:text`, thinking off for both foreground and compaction. First establish which protocol that configuration uses; do not infer it from its name. Verify optimized compaction, one constraint/unresolved item/exact technical detail against source history, useful continuation, reopen, and native bypass. Record timing and reported usage/cache data. Do not change global user settings merely to run the test.

Reuse the correction/repeated-compaction fixtures to check the summary instruction's as-of-A and focus-provenance safeguards. Cover attempted versus completed work and a superseded decision within the same small continuity review, not a new evaluation corpus. Check that maintenance never displays a full summary as an ordinary answer. Review distribution contents for personal settings, captures, or secrets, and non-UI code for OS-specific assumptions; no cross-platform test campaign is required.

Live Anthropic Messages verification is deferred to #1. Automated adapter/payload coverage remains required in Phase 1. Describe support as implemented and automatically tested only after those checks pass, and explicitly state that live verification is pending. The selected smoke does not prove other protocols or thinking-on behavior in real engines.

Keep live-check versions, tested configurations, outcomes, and limitations in private run records outside the public repository; publish the procedure and tooling, not verification results. Request fidelity is mandatory. Before every release, the release candidate must pass the [live cache-reuse check](../verification/live-cache-reuse.md) on a representative supported configuration, demonstrating provider-reported reuse of discarded history A beyond the shared system/tools prefix. Missing metrics are unverified, not a pass. A fake endpoint cannot establish server tokenization, cache behavior, or summary quality. No known A/B violation, session corruption, lost input, or critical continuity defect is acceptable. A measured speedup, benchmark corpus, multi-engine campaign, statistical target, or user-run evaluation program is not required.

Approved quality criterion: on representative matched history, optimized summaries should not be materially worse than native for continuation. Assess consequential invented facts, lost requirements, false completion claims, and missing technical context, not cosmetic differences or perfect recall. An empty native response is not a sufficient baseline for acceptance. Record model-specific failures and comparison limits; a passing pair does not establish universal fidelity.

## Out of Scope

Phase 2 early/idle triggers, thresholds, preemption rules, and minimum-benefit proposals. No new memory/retrieval system, semantic pruning, side-model routing, cloud offloading, handoff artifacts, branch-summary redesign, custom retention, engine cache management, speculative summaries, warm-up requests, per-model filters, graphical settings panel, patched Pi, or custom protocol client.

Universal compatibility with arbitrary transformers, competing compaction owners, or future Pi releases is not promised. Live Anthropic verification is tracked separately, not silently counted as complete.

## Further Notes

This is an implementation specification, not a claim of completed implementation or QA. Source review supports a viable ordinary Chat Completions path; Anthropic adapter fidelity, invocation-local bypass propagation, file-metadata carry-forward, and final lifecycle checks must be established by the prescribed tests. If a documented capability cannot satisfy a required behavior, report the concrete blocker instead of hiding it behind always-native fallback or private API use.

Approved departures from the PRD are limited to protocol scope/live-test scheduling, native competing-compaction admission, and the Pi 1.0.2 failure-diagnostics exception above. Operation metadata exposes discarded-attempt usage where native aggregate accounting lacks an extension hook; do not present it as native totals. Research notes describe possible techniques and risks, not additional mandatory infrastructure. The simpler implementation and proportional QA requirements in this spec take precedence over those suggestions.

Follow-up: #1, live Anthropic Messages verification.

Primary source references for the initial compatibility target:

- [Pi 1.0.2 release](https://github.com/earendil-works/pi/releases/tag/v1.0.2)
- [Released extension contracts](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/docs/extensions.md)
- [Native compaction behavior](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/docs/compaction.md)
- [Session lifecycle and commit](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/core/agent-session.ts)
- [SDK request wiring](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/src/core/sdk.ts)
- [Upstream integration harness](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/coding-agent/test/suite/harness.ts)
