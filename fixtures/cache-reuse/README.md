# Fictional histories for cache-reuse checks

These are static conversations authored through actual Pi coding sessions in isolated temporary projects. They contain fictional requirements, implementation work, tool calls and results, test failures, fixes, and unfinished work. They are not borrowed personal transcripts or examples of production-ready application code.

- `100k.json`: **Lantern Ledger**, a community-workshop equipment lending application. The conversation covers catalog rules and reservation state transitions.
- `250k.json`: **Harbor Dispatch**, an island-cooperative freight planning application. The conversation covers vessels, sailings, booking capacity, routing, and cargo rules.

| Fixture | Version | Reference history tokens | Messages |
| --- | --- | ---: | ---: |
| `100k.json` | 1 | 94,497 | 96 |
| `250k.json` | 1 | 253,641 | 523 |

Each JSON file records its fixture version, exact reference token count, messages, and a few continuity facts tied to source-message indexes. The targets are approximately 100,000 and 250,000 history tokens. They exclude the live system/tools prefix and subsequent requests.

Reference counts use `cl100k_base` from pinned `js-tiktoken` 1.0.21. Encode `JSON.stringify(message)` for each normalized message and sum the lengths, treating special-token spellings as ordinary text. This measures the committed history, including its JSON message structure. It is not a claim about another tokenizer or a provider's serialized input count.

Before export, runtime usage, model/provider metadata, response identifiers, timings, and timestamps were removed. Tool-call IDs were replaced with deterministic IDs while preserving their matching results. Temporary project paths were normalized to fictional paths. Public fixtures contain no authentication material, provider configuration, authoring logs, or generated compaction results.

The checker loads the chosen file unchanged. It does not generate text, repeat blocks to reach a target, truncate the history, switch fixtures, or execute the historical tool calls. It adds the fixed public prompt state and restores the Pi message metadata needed for replay. A real foreground request then establishes the cache prefix before compaction.

Pi chooses the A/B boundary. Continuity checks use only listed facts whose source messages actually fall in discarded history A. The summary and continuation must retain those terms. These narrow checks can flag a run for review; they do not assess the accuracy of the entire conversation or summary.

Any content change requires a new fixture version and a fresh reference count. The private run record also stores the content hash and checkout revision. Validate both artifacts with the ordinary test suite before using them for a release check. Fake-provider tests validate the checker and fixture structure; they do not establish live cache reuse.

For private configuration, commands, and result interpretation, see [the live check procedure](../../docs/verification/live-cache-reuse.md).
