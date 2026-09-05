---
name: arena
description: "Run N candidate passes at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Fan out N attempts at the same task as task spawns, each on its own role model and in its own isolated copy. Read every candidate end to end. Pick the strongest as the base. Graft the best ideas from the others into it. Verify the synthesized result.

## Start

Open a todolist with one entry per phase before launching anything (OMP's `todo` tool). The arena runs autonomously and the list keeps phases from silently disappearing.

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Phase A: Frame

The N candidates will receive the same prompt, so the prompt is the contract. Get it right before running anything.

1. State the artifact each candidate is producing.
2. Derive the rubric. State what success looks like for *this* task, then turn it into 3-6 concrete gradeable criteria. Concrete: `Adds a --dry-run flag that skips writes`. Vague: `code is correct`. The rubric is the picker's tool in Phase D; candidates only see the task.
3. Resolve the configured `arena-runners` panel with `pstack_route` and use its seats in order. Setup defines the models; there are no hidden default seats. Run `/setup-pstack` if resolution fails. Run additional attempts on the same configured model only when the task is generation-bound rather than judgment-sensitive.
4. Assign output paths and labels. One isolated copy per candidate: a candidate that writes spawns with `isolated: true`; native OMP isolation creates its workspace. Keep artifacts outside the parent checkout when the task has no repository. Give each candidate a blind label (Candidate A, B, C) and record label -> job ID -> retained patch -> runner seat so the judge and the synthesis record can refer to candidates without naming models. N candidates writing to the same path is shared mutable state and fails the **separate-before-serializing-shared-state** principle skill test. Review candidate patches before applying them within the user's authorized task. A request to compare designs alone does not authorize applying an implementation.

## Phase B: Fan out

**Fan-out (default).** Launch all N candidates as task-tool batch spawns, one item per arena runner seat; collect every launched job through `hub` before consuming results. Each item names the matching `pstack-arena-runners-<n>` role agent (role agents live in `~/.omp/agent/agents/`); the role agents resolve their own models from the `modelRoles` entries in `~/.omp/agent/config.yml`, so record which model ran which pass from the results. A candidate that writes spawns with `isolated: true` — the runtime runs it in an isolated copy of the checkout and keeps the patch because `task.isolation.apply: false` — and each brief's gate runs the focused checks for the artifact — the project's test, lint, and typecheck commands, or the harness the project's verify skill drives — inside that copy before reporting. The shared grounding goes in the batch `context`; each item gets the same task, its own labeled output path, and instructions to produce both the artifact and a short rationale; every brief is standalone. Results come back in input order, each with its PASS / ISSUES / BLOCKED status: BLOCKED is a dropout — proceed with N-1 and note it in the synthesis record. A run whose gate fails does not get a free PASS: the artifact is unverified, so mark it ISSUES with the gate output, and decide whether to re-run that seat before judging. The synthesis record maps Candidate A/B/C to its job ID, retained patch path, runner seat, and actual model. Temporary worker directories can disappear on completion; judge the retained patch rather than assuming the original cwd remains readable. Read the patch itself before scoring and reconcile any disagreement with the worker report. Apply a reviewed patch only within the user's authorized scope.

The rationale is mandatory. Without it, the parent cannot tell whether a candidate's structure is principled or accidental, which makes Phase E grafting unreliable. Each rationale names the alternatives the candidate considered and what it rejected.

## Phase C: Cross-judge

**Judge spawn (default).** Launch one `pstack-arena-cross-judges-<n>` seat from the configured panel. Contrast rule: resolve `arena-cross-judges` with the parent's exact selector as `excludeSelector`, then pick one returned seat. This contrasts with the parent; candidates can span the whole pool, so do not demand a family absent from every candidate. It sees the rubric and the candidates by path label (Candidate A, B, C — never by model name or seat), scores each criterion, and recommends a base with rationale. It runs after every candidate pass completed — not while candidates are still mid-write, because a judge that sees partial or empty outputs reports them as false dropouts. The judge works read-only: it reads, it doesn't execute, write, or merge anything. Record which model judged.

## Phase D: Pick a base

Read every candidate end to end before picking. Skimming N candidates surfaces only the candidate whose surface looks most familiar.

Score each candidate against the rubric criterion by criterion, not on holistic feel. Compare against the cross-judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base on which candidate a future maintainer can extend most easily without breaking invariants. Prefer the cleaner boundary or smaller surface area when two feel tied, per the Laziness Protocol.

Record the pick and the reason in a short synthesis note alongside the base artifact, including the cross-judge's verdict.

## Phase E: Graft

Walk each losing candidate once more and identify what is worth porting into the base. The signal is usually one or two things per candidate, not most of it.

Fold each graft in by hand, per the **redesign-from-first-principles** principle skill. Don't paste mechanically. The result has to remain coherent under one mental model.

Record what was grafted, from which candidate, and what was rejected and why. The rejection notes are the highest-signal part of the record. Future readers learn from what you considered and dropped, not just what you kept.

When N candidates converge on the same shape, that is a strong agreement signal. Note the convergence in the record and ship the consensus shape. No graft is needed. When N candidates wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

The synthesized artifact has to hold up under the same scrutiny as any other output, per the **prove-it-works** principle skill. The arena does not earn you a pass. Run the actual changed surface per the project's verify skill (bash-driven harness: Playwright script, PTY helper, or curl) before handoff.

If verification surfaces a problem the arena did not catch, either Phase A was wrong (re-frame and re-run) or one candidate caught it and you missed the graft (go back to Phase E). Don't paper over.

## Outputs

One synthesized artifact. One synthesis note alongside, naming the base, the grafts (with source candidate), the rejections, the dropouts if any, the model that ran each candidate and judge pass, and the verification result. To synthesize the artifact, review the base candidate's patch and apply it when implementation is authorized. Preserve unrelated parent changes and run verification again after applying it.
