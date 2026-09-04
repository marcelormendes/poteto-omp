---
name: swarm
description: "Run N workers over slices or race arms, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Run N workers over separate slices or identical race arms, drain them, and return one report. Workers are task-tool spawns launched in one batch: the `pstack-swarm-worker` role agent (role agents live in `~/.omp/agent/agents/`), one per slice or race arm, each with its own writable output under `/tmp/<slug>/worker-<n>/`. Each worker gets a standalone brief and reports back with the same envelope. If the role agents are not installed (run `setup-pstack` first), run numbered sequential passes instead (see the fallback below).

## Start

Open a todo list (`pstack_todo` when present, else a markdown checklist) with one entry per phase before starting anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before running.
3. Set N from the user or derive it from the shape. N is total workers, not a concurrency limit.
4. Resolve the worker model. The worker model is bound by setup-pstack from the `modelRoles` entries in `~/.omp/agent/config.yml`; otherwise the `pstack-swarm-worker` role agent's default model is the worker model. The role agent resolves its own model; never invent a model selector. For a model race, name each arm's model up front — the batch resolves all arm models at once.
5. Give each worker its own writable output at `/tmp/<slug>/worker-<n>/` (create it with bash). Each worker's brief names its own dir; reports and artifacts land there.
6. Decode write isolation. A worker that modifies the repo spawns with `isolated: true`; the runtime runs it in an isolated copy of the checkout and keeps the patch because `task.isolation.apply: false`. Its brief's gate is the slice's single verification command, which the worker runs inside that copy before reporting. A read-only worker (coverage, exploration) spawns without isolation. Isolated copies require a clean repo state, so commit or stash before launching repo-writing workers.

## Phase B: Fan out

**Fan-out (default).** Launch all N workers as a task-tool batch spawn, one item per worker; the call is the barrier and results return in input order. Each item names the `pstack-swarm-worker` role agent, which resolves its own model (the resolved swarm worker model), carries the worker's standalone brief as `task`, and spawns with `isolated: true` only when the worker writes to the repo; its brief's gate runs the slice's verification command inside that copy before reporting. A writer runs in an isolated copy of the checkout that keeps repo writes isolated; never apply its patch without explicit user confirmation — show the diff and wait.

```js
task({
  context: "<shared grounding>",
  tasks: [
    { agent: "pstack-swarm-worker", task: "<slice-1 brief, standalone>", isolated: true },
    { agent: "pstack-swarm-worker", task: "<slice-2 brief, standalone>" },
  ],
})
```

Every brief stands alone. Include the goal, scope, exact slice or race arm, its output dir under `/tmp/<slug>/worker-<n>/`, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out or returns `BLOCKED`, proceed with N-1 and note it. The batch keeps sibling items running when one blocks or fails.

For a model race, name each arm's role agent up front — arms differ by role agent, each resolving its own model; record which model each arm ran under from the run results.

**Fallback: sequential passes (only when the role agents are not installed; run `setup-pstack` first).**

Run all N briefs as numbered sequential passes in one session, in the order declared. Each pass is self-contained: read its brief, do the work, write outputs, report. Do not start a pass until the previous one has reported.

For a model race in the fallback, run each arm inline; without subagents every arm shares the session model — say so in the report:

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a pass is abandoned or cannot complete, proceed with N-1 and note it.

## Phase C: Aggregate

Read each worker's report file under `/tmp/<slug>/worker-<n>/`; with the fan-out, also read the workflow result (each child's key, status, and output reference). For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
