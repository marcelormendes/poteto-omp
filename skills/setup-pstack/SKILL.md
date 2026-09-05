---
name: setup-pstack
description: Configure pstack's OMP models and generated role agents. Use for setup-pstack, changing model choices, or repairing a missing setup.
---

# Setup pstack

Use the installed extension's `/setup-pstack` command. It detects authenticated
models, validates every selection, generates the role agents, and merges its
model roles into the active OMP profile. It preserves unrelated settings and
agents. Never replace the user's OMP config with a generated model table.

For interactive setup, run `/setup-pstack` in the OMP terminal. For repeatable
setup, run `/setup-pstack --file /absolute/path/models.yml`. A quoted path may
contain spaces. If this skill was invoked as `/skill:setup-pstack`, guide the
user to the command; writing settings by hand does not run setup.

The file has `schemaVersion: 1`, `autoEnable: true` or `false`, a `roles` map,
and a `panels` map. Resolve available selectors with `omp models`; copy exact
`provider/model` selectors, optionally with a supported thinking suffix.
A choice is `{ type: model, selector: provider/model }` or
`{ type: inherit-parent }`. Do not invent defaults or use `auto` as a choice.

Scalar roles: `feature`, `refactoring`, `bug-fix`, `perf-issue`, `hillclimb`,
`judgment-prose`, `hardest`, `how-explorer`, `how-explainer`, `why-investigator`,
`why-synthesizer`, `reflect-tooling`, `reflect-judgment`, `reflect-divergent`,
`reflect-synthesizer`, `swarm-worker`.

Panels: `how-critics`, `arena-runners`, `arena-cross-judges`,
`architect-runners`, `interrogate-reviewers`. Each is a nonempty list of
choices. Its length determines the number of seats. The cross-judge pool
needs two model families so Arena can select a judge contrasting with the
parent. Panel seats may share a model, but report the reduced diversity.

Setup writes `pstack/config.yml`, `pstack/generated-agents.json`, and
`agents/pstack-*.md` below the active OMP agent directory. That directory is
`~/.omp/agent` for the default profile; use `omp config path` with the active
profile to locate it. Setup enables batched tasks and writer isolation,
disables automatic application of isolated patches, and allows two levels
of delegation. It keeps the user's concurrency budget.

Setup reloads the runtime so generated agents are available immediately.
Run `/pstack-status` and resolve a role with `pstack_route`. Then launch one
short read-only task on each distinct configured model and inspect its
result and actual model. A catalog entry proves availability, not a working
credential. Mark setup unverified when any required model cannot respond;
report the exact failure rather than counting an inline fallback as a pass.

If the project lacks a way to verify behavior on its real surface, use
`create-verification-skill` when the user requests one.
