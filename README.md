# pi-cachewise-compact

pi-cachewise-compact aims to reduce disruptive compaction pauses for local-inference Pi users by generating the compaction summary from the existing conversation prefix, allowing the inference engine to reuse work it has already performed.

It uses your existing provider and model and preserves Pi's normal compaction structure: **a summary of the discarded older history, followed by the retained recent history unchanged**.

The goal is **less waiting without materially worse task continuity, lost work, or extra work managing the agent**.

![Standard Pi compaction builds a separate summarization request with older history serialized as text. pi-cachewise-compact preserves the system, tools, and older message prefix, then appends summary instructions so cached computation can be reused. Both continue with a summary and unchanged recent history; cache reuse is not guaranteed.](docs/images/compaction-comparison-v5.png)

Supports Pi 1.1.0 and newer.

## Setup

Requires Pi 1.1.0 or newer and Node.js 22.19.0 or newer. We match Pi's minimum supported Node.js version. Install from GitHub using Pi's package manager:

```sh
pi install git:github.com/iantri/pi-cachewise-compact
```

Reload Pi after installation. Pi clones the repository and installs its dependencies; you do not need a local checkout. Access to this repository is required; it is not currently a public npm release.

The extension starts off, with no providers selected. Configure it using your existing Pi provider ID:

```text
/cachewise-compact provider add
/cachewise-compact on
```

An omitted provider ID resolves to the current model's provider at command time. Selecting a provider covers its models collectively; it does not distinguish local from cloud traffic. No endpoint or credentials are configured here.

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

Automated tests cover OpenAI-compatible Chat Completions and Anthropic Messages. Live testing has covered only Chat Completions, where it verified prefix preservation and provider-reported cache reuse. Anthropic Messages has not yet been verified against a live provider.

This extension preserves the request prefix; it cannot guarantee cache retention, a cache hit, or faster execution on every attempt.

Request-transforming extensions require care. A nested model call does not replay Pi's entire agent hook pipeline. Arbitrary context rewrites, payload replacements, header changes, and custom routing are not verified compatible.

Other extensions that modify or take over compaction may be incompatible. Use pi-cachewise-compact only with extension combinations you have verified work together.

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
