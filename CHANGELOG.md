# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
Releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-23

### Added

- Initial release of cache-preserving compaction for Pi 1.1.0 or newer and Node.js 22.19.0 or newer.
- Support for OpenAI-compatible Chat Completions and Anthropic Messages, with compatibility limited to tested configurations.
- Provider selection, persistent enablement settings, operation status, and an invocation-local native compaction command.
- Native fallback when a request cannot preserve the conversation prefix or a summary fails validation.
- One checkpoint with focused continuation context when discarded history includes both completed turns and a split-turn prefix.
- Local integration tests and a live cache-reuse checker with fictional histories and private configuration and results.
- Installation, update, removal, and local reasoning-model cache guidance.
