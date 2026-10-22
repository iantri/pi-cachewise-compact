# Cache-preserving compaction

This context covers summarizing older conversation history while preserving recent context and an existing inference prefix.

## Language

**Compaction**:
A context reduction that replaces selected older history with a summary and retains recent history unchanged. It does not erase the original session record.

**Discarded prefix (A)**:
The older conversation material selected for replacement by a summary, including previous-summary context and any selected split-turn prefix. Its state ends at the retained boundary, not at the end of the session.
_Avoid_: Deleted history, full conversation

**Retained suffix (B)**:
The recent conversation material kept unchanged after the summary. It is not input to maintenance inference.
_Avoid_: Summary input

**Retained boundary**:
The start of B, separating material selected for summarization from material retained unchanged.

**Foreground inference**:
An ordinary model request made while the coding agent works on the user's task.

**Maintenance inference**:
A model request that produces a compaction summary rather than continuing the user's task or executing tools.

**Candidate summary**:
Text produced by maintenance inference for possible use as the compaction summary, before validation and commit.

**Summary validation**:
Checks that determine whether a candidate summary may be committed. Passing these checks does not certify factual accuracy or completeness.

**Effective prefix**:
The system content, tool definitions, and conversation representation actually presented to the provider before the appended summary instruction.
_Avoid_: Raw session history

**Prefix fidelity**:
Preservation of the effective prefix shared with foreground inference. It is distinct from whether a provider actually reuses cached computation.
_Avoid_: Cache hit

**Cache hit**:
Provider reuse of previously cached input computation. A matching prefix makes reuse possible but does not prove it occurred.
_Avoid_: Prefix fidelity

**Split turn**:
A conversational turn whose earlier messages belong to A and whose later messages belong to B.

**Split-turn prefix**:
The earlier portion of a split turn that belongs to A, before its continuation in B.

**Turn context**:
A checkpoint of the original request and progress in a split turn's discarded prefix, placed before its retained continuation.

**Optimized compaction**:
Compaction that uses prefix-preserving maintenance inference to summarize A and retains B unchanged.
_Avoid_: Guaranteed cached compaction

**Native compaction**:
Pi's built-in compaction behavior, not another extension's summary generator.

**Native fallback**:
Native compaction used when optimization is unavailable or its candidate is rejected.

**Native bypass**:
An explicit request to use native compaction for one invocation without attempting optimization or changing persistent settings.
_Avoid_: Disabling optimization
