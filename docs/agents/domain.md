# Domain docs

## Layout and reading rules

This is a single-context repo. Domain terms live in root `GLOSSARY.md`.
Architecture decisions live in `docs/adr/`.

Before exploring the codebase, read the glossary and ADRs relevant to
the work. If a root `GLOSSARY-MAP.md` exists later, follow its links to
relevant context glossaries and check context-specific ADRs too.

If these files do not exist, proceed silently. Domain-modeling creates
them when terms or decisions are resolved; do not create placeholders
or suggest creating them just because they are missing.

## Vocabulary

Use glossary terms in issue titles, proposals, hypotheses, and test names.
Avoid synonyms the glossary rejects.

If a needed concept is missing, reconsider whether it belongs to the
project. Note real vocabulary gaps for domain-modeling.

## Decision conflicts

If a proposal contradicts an ADR, name the ADR and explain why the
decision should be reconsidered. Do not silently override it.
