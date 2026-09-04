---
name: loop
description: "Run a bounded repetition to a predicate: same check N times, drive until a condition holds, or sweep a list with per-unit verification. Use for /loop, 'repeat until', or overnight-style bounded runs. Every loop declares its stop condition and iteration cap up front."
disable-model-invocation: true
---

# Loop

Repeat bounded work to a declared predicate. No unbounded runs: every loop
states its stop condition and its iteration cap before the first iteration.

## 1. Frame

Write down, before starting:

- **Predicate:** the exact condition that ends the loop (a test passing, a
  counter reaching N, a queue draining, a goal predicate holding).
- **Cap:** the maximum iterations. A loop without a cap is not a loop, it
  is an incident. Suggest a cap when the user gives none (10 is a sane
  default for checks, 3 for expensive model passes).
- **Unit:** what one iteration does and what evidence it returns
  (PASS/ISSUES/BLOCKED with pointers, never bare prose).
- **Recovery:** what happens on a failed iteration (retry same unit, skip
  and note, abort the loop). Failed units never silently count as passed.

Track the loop in the `pstack_todo` tool: one item per iteration or per
batch, checked as each completes.

## 2. Run

Execute iterations sequentially in this session. After each iteration,
record its evidence line. Re-read the predicate before every iteration:
stop the moment it holds, even with budget remaining. On hitting the cap
with the predicate unmet, stop and report BLOCKED with the per-iteration
evidence table, never run one more "just to check".

Long-running loops that must survive this session belong in a scheduled
runner (cron/launchd invoking `pi --no-session -p "/skill:loop <framing>"`),
not in a longer cap. Say so when the horizon exceeds the session.

## 3. Report

One table: iteration, result, evidence pointer. Then the verdict: predicate
met (with the proving observation) or cap reached (with what would change
the outcome). Keep raw per-iteration dumps out of the report.
