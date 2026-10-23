# pi-cachewise-compact

pi-cachewise-compact aims to reduce disruptive compaction pauses for local-inference Pi users by generating the compaction summary based on continuation of the existing conversation prefix, allowing the inference engine to reuse work it has already performed.

It uses your existing provider and model and preserves Pi's normal compaction structure: **a summary of the discarded older history, followed by the retained recent history unchanged**. In other words, behaviour is as close as possible to stock Pi compaction, except that instead of a separate summarization request, the summarization prompt is appended to the tail of the conversation prefix up to the point of compaction.

The goal is **less waiting without materially worse task continuity, lost work, or extra work managing the agent**.

A small deviation from stock behaviour: When both completed turns and the beginning of a split turn are discarded, native Pi summarizes them in separate requests, each receiving its own source material. An appended request sees all discarded history together. Reproducing the native division would rely on the model to enforce two source scopes within that shared input and keep the resulting summaries consistent. We instead ask for one coherent checkpoint of the state at the end of the discarded history, followed by concise continuation context that keeps the interrupted request and unfinished work visible. The aim is useful context for continuation without asking the model to reproduce a separation that native Pi establishes through separate inputs.

This changes only the mixed split-turn prompt. The history selection, summary objectives, combined summary budget, and preserved request prefix stay the same; recent history remains unchanged. Ordinary and split-only compaction keep their existing behavior.

![Standard Pi compaction builds a separate summarization request with older history serialized as text. pi-cachewise-compact preserves the system, tools, and older message prefix, then appends summary instructions so cached computation can be reused. Both continue with a summary and unchanged recent history; cache reuse is not guaranteed.](docs/images/compaction-comparison-v5.png)

Supports Pi 1.1.0 and newer.

## Setup

Requires Pi 1.1.0 or newer and Node.js 22.19.0 or newer. Install it from npm using Pi's package manager:

```sh
pi install npm:pi-cachewise-compact
```

Run `/reload` in Pi after installation, or restart Pi.

The extension is initially disabled, with no providers selected. Configure it using your existing Pi provider ID:

```text
/cachewise-compact provider add
/cachewise-compact on
```

An omitted provider ID resolves to the current model's provider at command time. Selecting a provider covers its models collectively.

### Update or remove

Update the installed package:

```sh
pi update npm:pi-cachewise-compact
```

Remove it:

```sh
pi remove npm:pi-cachewise-compact
```

Run `/reload` or restart Pi after either change. Removing the package leaves its saved settings in place for a later reinstall. To disable it without removing it, use `/cachewise-compact off`.

## Commands

- `/compact [focus]`: Pi's normal entry point, optimized when enabled and compatible.
- `/compact-native [focus]`: native compaction for this invocation only; does not change settings.
- `/cachewise-compact on` or `off`: enable or disable; preserve selected providers.
- `/cachewise-compact providers`: list available, selected, current, and unavailable saved provider IDs.
- `/cachewise-compact provider add [id]` or `remove [id]`: change one selection without changing enablement.
- `/cachewise-compact status`: show configuration, availability, and the last operation outcome.

Settings are user-level, in `cachewise-compact.json` under `PI_CODING_AGENT_DIR` or `~/.pi/agent`. They are separate from Pi's native compaction settings. An empty selection means no providers, not all.

In RPC mode, submit extension commands through `prompt`. Pi's RPC `compact` operation remains the ordinary compaction entry point; it is not a replacement for `/compact-native`. Terminal and RPC retain their native busy, queue, and cancellation behavior.

## Compatibility

Automated and live tests cover OpenAI-compatible Chat Completions and Anthropic Messages. Representative live checks have verified prefix preservation, provider-reported cache reuse, optimized compaction, and continuation through both APIs. This establishes compatibility for the tested configurations, not every provider or model.

This extension preserves the request prefix; it cannot guarantee cache retention, a cache hit, or faster execution on every attempt. For the intended benefit of achieving cache reuse, your inference engine must be able to prefill from an earlier prefix than the latest state of the conversation. This is true of oMLX at least as of 0.7.0, but may not be true of all inference engines.

Request-transforming extensions require care. A nested model call does not replay Pi's entire agent hook pipeline. Arbitrary context rewrites, payload replacements, header changes, and custom routing are not verified compatible.

Other extensions that modify or take over compaction may be incompatible. Use pi-cachewise-compact only with extension combinations you have verified work together.

### Reasoning models and local cache reuse

If you use a reasoning model locally, check whether your setup preserves earlier reasoning when a new user message arrives. Some models' chat templates—the rules that turn messages into model input—remove earlier reasoning at that point. pi-cachewise-compact appends its summary instructions as a user message, so this can change previously cached input and reduce reuse, even though the extension preserves the messages it sends. Compaction may still succeed, but with less of a speed benefit.

This concern was reported in [Pi PR #10577](https://github.com/earendil-works/pi/pull/10577): its [verification notes](https://github.com/earendil-works/pi/blob/962b130e0cb58033045f85e2180e5ba1483e7c40/packages/ai/scripts/generate-models.ts#L979) describe configurations where appending a user message caused earlier reasoning to be dropped and cache reuse to fall to 0–9%.

For a concrete local-model example, [Qwen3.6's template finds the latest user message](https://huggingface.co/Qwen/Qwen3.6-27B/blob/main/chat_template.jinja#L66) and [omits reasoning from earlier assistant messages unless `preserve_thinking` is enabled](https://huggingface.co/Qwen/Qwen3.6-27B/blob/main/chat_template.jinja#L99).

Check your engine and model documentation for a setting that preserves earlier reasoning; the available settings vary. If you change such a setting, use it consistently during normal work and compaction. Verify cache reuse after real tool use with reasoning enabled, using your engine's cache statistics where available. A successful summary alone does not show that the cache was reused.

## Support

Report problems or request changes in [GitHub Issues](https://github.com/iantri/pi-cachewise-compact/issues). Include your Pi and Node.js versions, inference engine or provider, model, API, and the steps that caused the problem. Remove credentials and private conversation content before sharing diagnostics.

## Development

Install dependencies and run the local checks:

```sh
npm ci
npm run typecheck
npm test
```

Automated tests exercise real Pi sessions and provider adapters against local fake endpoints. They do not require provider credentials.

Before each release, run the [live cache-reuse check](docs/verification/live-cache-reuse.md) with external private configuration. Results stay private. Automated tests alone cannot establish actual cache reuse.

## Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
for npm package versions, with matching Git tags such as `v1.2.3`.

The public compatibility contract covers documented commands, configuration and
persisted settings, extension behavior, and supported Pi and Node.js versions.
Internal TypeScript modules are not a public import API.

From `1.0.0`, incompatible changes require a major release, compatible features
and deprecations require a minor release, and compatible bug fixes require a
patch release. Raising a minimum supported Pi or Node.js version counts as an
incompatible change.

During `0.x` development, the contract is not yet stable. This project uses
minor releases for new features or incompatible changes, and patch releases
for compatible fixes. Release notes identify incompatible changes and any
required migration steps.

Published versions are immutable. The [changelog](CHANGELOG.md) groups releases
by version, with headings such as `## [1.2.3] - 2026-10-20`. Pending changes stay
under `Unreleased`, where dated subsections may be used until release.

## License

[MIT](LICENSE). Pi-derived material is covered by the notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
