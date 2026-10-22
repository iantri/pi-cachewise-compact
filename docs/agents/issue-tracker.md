# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `iantri/pi-cachewise-compact`.
Use the `gh` CLI from this repo; it infers the repository from the Git remote.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body-file <file>`
- Label: `gh issue edit <number> --add-label "..." --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Use label and state filters when listing issues. Read labels as well as
the body and comments when evaluating a ticket.

“Publish to the issue tracker” means create a GitHub issue.
“Fetch the relevant ticket” means read the issue and its comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Set this flag to `yes` to include external PRs in triage. When enabled,
use the equivalent `gh pr` commands. Include authors with association
CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, or NONE; exclude OWNER, MEMBER,
and COLLABORATOR.

GitHub issues and PRs share a number space. For an ambiguous reference,
try `gh pr view <number>`, then `gh issue view <number>`.

## Wayfinding

- Keep the map in one issue labelled `wayfinder:map`.
- Link child tickets as sub-issues. If unavailable, use a task list in
  the map and put `Part of #<map>` in each child.
- Label children `wayfinder:<type>`: research, prototype, grilling, or task.
- Record blockers with native GitHub issue dependencies. If unavailable,
  put `Blocked by: #<number>` at the top of the ticket.
- Select the first open, unassigned child in map order with no open blockers.
- Claim it with `gh issue edit <number> --add-assignee @me` before other writes.
- Comment with the result, close the ticket, and add a summary and link
  to the map’s Decisions-so-far section.
