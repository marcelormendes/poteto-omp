# OMP delegation

Run `/setup-pstack` once in the active profile. It generates the role agents
and their model aliases; `pstack_route` resolves the current configuration.
If the tool is exposed through OMP's extension gateway, read
`xd://pstack_route` for its schema and write the JSON arguments to that URI.
Never read the complete user config to discover model assignments.

Read a skill with `read` at `skill://<name>` and follow it. Slash commands
are user entry points, not shell commands. Resolve reference paths relative
to the loaded skill file. Native tools are `task`, `hub`, and `todo`.

Launch a panel using one task call with `context` and `tasks[]`. Every item
has a unique `name`, its configured `agent`, and a standalone `task` brief.
Put shared evidence in `context` once. Do not duplicate it in every item.
With async execution enabled, the call returns job IDs before completion.
Collect all jobs using `hub` wait/jobs or their delivered results before
synthesis. Map results by job ID. A failed job is not a completed review.
With async disabled, the task call blocks and returns the results directly.

Writer items set `isolated: true`; reader items omit it. Setup disables
`task.isolation.apply`, so isolated writes return retained patch artifacts.
OMP can remove the temporary workspace when a worker finishes. Use the
returned patch path for review; do not assume its original cwd still exists.
The parent reads and verifies the patch before integrating authorized changes.
Never apply an unselected candidate. Use native task isolation; do not shell
out to another harness or start nested OMP sessions.

Keep every model assignment attributable to a completed worker and its
transcript. A configured selector or spawn request alone is not execution
evidence. Report actual models, completed seats, failures, and missing
coverage. `inherit-parent` is one model choice, not cross-model diversity.
