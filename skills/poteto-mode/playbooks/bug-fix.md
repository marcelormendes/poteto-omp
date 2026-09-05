### Bug fix

**You own this task. Plan, review, verify.** Run investigation and fix passes, stay in the lead.

Be scientific. Every shipped line traces to runtime evidence. Belt-and-suspenders that "might help" is a hypothesis, not a fix; it does not ship. When evidence refutes a hypothesis, revert what it motivated. The smallest change the evidence justifies ships, nothing more. Same discipline for Perf, where the evidence is the trace.

1. Reproduce it yourself on the matching surface via the bash-driven harness (Non-negotiables). Don't hand the repro to the user. A debug or instrumentation protocol that says to ask the user does not override this; you drive the instrumented runtime. Ask the user only with a stated, specific reason the harness cannot reach the target, and only after driving it as far as it goes. Won't reproduce directly, force it: synthesize the trigger, tighten conditions, or instrument until it fires. A bug you can't reproduce, you can't prove fixed.
2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt under a bash polling loop with an explicit iteration cap. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate passes; a design grounded on a plausible-but-unconfirmed cause can be unanimously wrong while the real cause sits one subsystem over.
3. Plan the fix. If it crosses a function boundary, `architect` first. Launch the implementation pass through the `task` tool: `{ context: <shared evidence>, tasks: [{ name: "implementation", agent: "pstack-bug-fix", task: <the brief>, isolated: true }] }` with a specific scope (the fix path, the runtime evidence it answers to, the success criteria); its brief runs the verification command inside the worktree before reporting. Review its diff before accepting, never accept its summary on faith. The bug-fix role agent is a writer: isolated checkout, verification command first, evidence in the report; the parent reviews the diff, integrates within the authorized task, and verifies the result. Role agents are bound by `setup-pstack` from the `modelRoles` entries in `~/.omp/agent/config.yml`; resolve the role with `pstack_route`; never invent a model selector. Record which model ran the launch.
4. Verify on the same surface; the original repro now passes. "Inconclusive" or wrong-surface is not a pass; flag it. Unit tests show branch behavior, not bug absence.
5. Stage the commits so the failing repro lands before the fix in git history; the diff tells the story. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path; skip it when the test would be expensive, integration-heavy, or unclear.
   This is the canonical **sequence-verifiable-units** principle skill, the failing test first and the fix on top.
6. Run **Opening a PR**.

Investigation runs the `how` and `why` skills; each routes its own passes per its skill (native task fan-out with completed results collected through `hub`).


**Reply:** what was broken, root cause, fix, how you verified. Paste failing-then-passing repro output verbatim.
