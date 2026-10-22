# pi-cachewise-compact

## Versioning

- Follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Before choosing a release version, read [README.md — Versioning](README.md#versioning) for the public compatibility contract and pre-1.0 policy.
- For a package release, keep the version in `package.json` and `package-lock.json` aligned, and tag the release `v<version>`. Published versions and release tags are immutable.

## Changelog

- Maintain `CHANGELOG.md` using [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) categories. Use SemVer release headings in the form `## [X.Y.Z] - YYYY-MM-DD`, newest release first.
- Keep pending changes under `## [Unreleased]`. They may be grouped into dated subsections such as `### YYYY-MM-DD`, newest date first, with change categories one heading level below.
- When releasing a version, consolidate its pending entries into that version's section, grouped by change category. Leave work not included in the release under `Unreleased`. Commits alone do not create release sections.
- Preserve published release entries; new changes belong under `Unreleased` until their version is released.
- Group entries under the standard `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security` headings as applicable. Keep them concise and describe what users can notice or do differently.

## Writing

Plain language, always -- conversation as much as anything written down: commit messages,
changelog entries, documentation, issue bodies, and code comments. Short sentences. State
the fact rather than hedging around it, and cut ornament and filler.

- Load the `writing-with-plain-language` skill at session start, whenever it is available.
  Apply it to every message, including routine status updates. Also load it before drafting
  or editing substantive prose. Do not wait to be asked; the preference is standing.
- This governs prose, not identifiers or established domain terms. `GLOSSARY.md` holds the
  project's vocabulary, and the right domain word beats a simpler wrong one.

## Verification

- Verify releases locally and record the revision, Pi/Node versions, commands, and results. CI and automated publishing workflows are outside the release plan.
- Before every release, complete and record the [live cache-reuse check](docs/verification/live-cache-reuse.md) on the release candidate. Demonstrated reuse of discarded history A on a representative supported configuration is a release gate.
- Test at the real Pi session and provider-adapter seam, using fake endpoints for deterministic integration checks.
- Judge summaries against discarded history A, not later corrections retained in B.
- Verify prefix fidelity, provider-reported cache reuse, and summary quality separately; none proves the others.

## Publication privacy

- Treat tracked files, commit messages, and GitHub issue/comment text as intended for public distribution, even while the repository is private.
- Keep credentials, personal information, developer-specific absolute paths, private endpoints, local configuration, borrowed transcripts, payloads, and derived summaries outside the repository. Keep live verification results and diagnostics private, including aggregate run reports. Commit reusable procedures, fictional fixtures, and configuration examples instead.
- Use repository-relative paths or clearly fictional placeholders in public code and documentation. Read machine-specific settings from external configuration or environment variables; never copy a developer's resolved values into examples or reports committed here.
- Before committing, inspect staged filenames and content for private material, including generated files and metadata. Ignore rules and the npm allowlist do not protect files already tracked in Git or exposed through GitHub history.
- Preserve explicitly approved public details, such as license attribution and approved examples. Approval for one detail does not authorize publishing related private information. If private material is already committed, flag it for cleanup; deleting the current file does not remove historical copies.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `iantri/pi-cachewise-compact`.
See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`.
See `docs/agents/domain.md`.
