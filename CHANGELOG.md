# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
Releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pending changes may be grouped by date under `Unreleased`.

## [Unreleased]

### 2026-10-22

#### Changed

- Raised the minimum supported Pi version to 1.1.0.
- Live cache-reuse checks now report fixture-term matches as informational observations, without failing otherwise successful flow and cache-reuse checks.
- Live cache-reuse checks now preserve Pi's normal coding tool definitions across requests while blocking tool execution and failing unexpected tool calls.

#### Added

- Lifecycle regression tests for queued input, stale summaries, cancellation, session transitions, and automatic compaction.

#### Removed

- Removed author-specific extension compatibility check

### 2026-10-21

#### Added

- Initial version.
