---
name: arena
description: "Run N candidate passes at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Fan out N attempts at the same task as task spawns, each on its own role model and in its own isolated copy. Read every candidate end to end. Pick the strongest as the base. Graft the best ideas from the others into it. Verify the synthesized result.

## Start

Open a todolist with one entry per phase before launching anything (the `pstack_todo` extension tool when present, otherwise a markdown checklist in chat). The arena runs autonomously and the list keeps phases from silently disappearing.

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
3. Pick the runner roles. Use the `arena-runners` role list bound by setup-pstack from the `modelRoles` entries in `~/.omp/agent/config.yml` when present; fall back to the roles' defaults: the strongest judgment model, the second-family model, the fast mechanical model, and a second strong-judgment model — setup resolves the concrete models; never invent a model selector. Run more passes when the arena covers multiple design directions. Same model for multiple passes when the work is generation-bound rather than judgment-sensitive.
4. Assign output paths and labels. One isolated copy per candidate: a candidate that writes spawns with `isolated: true`; in the inline fallback, create the copy with bash `git worktree add .arena/<slug>-candidate-<n> <base-ref>` when the pass writes. Fall back to `/tmp/arena-<slug>/candidate-<n>/` when the repo has no git worktree support. Give each candidate a blind label (Candidate A, B, C) and record label -> worktree -> runner seat so the judge and the synthesis record can refer to candidates without naming models. N candidates writing to the same path is shared mutable state and fails the **separate-before-serializing-shared-state** principle skill test. Candidate worktrees are merged only on explicit user confirmation; never merge silently.

## Phase B: Fan out

**Fan-out (default).** Launch all N candidates as task-tool batch spawns, one item per arena runner seat; the call is the barrier and results return in input order. Each item names the matching `pstack-arena-runners-<n>` role agent (role agents live in `~/.omp/agent/agents/`); the role agents resolve their own models from the `modelRoles` entries in `~/.omp/agent/config.yml`, so record which model ran which pass from the results. A candidate that writes spawns with `isolated: true` — the runtime runs it in an isolated copy of the checkout and keeps the patch because `task.isolation.apply: false` — and each brief's gate runs the focused checks for the artifact — the project's test, lint, and typecheck commands, or the harness the project's verify skill drives — inside that copy before reporting. The shared grounding goes in the batch `context`; each item gets the same task, its own labeled output path, and instructions to produce both the artifact and a short rationale; every brief is standalone. Results come back in input order, each with its PASS / ISSUES / BLOCKED status: BLOCKED is a dropout — proceed with N-1 and note it in the synthesis record. A run whose gate fails does not get a free PASS: the artifact is unverified, so mark it ISSUES with the gate output, and decide whether to re-run that seat before judging. The synthesis record maps Candidate A/B/C to its isolated copy, its runner seat, and the model that ran it. Candidate worktrees are merged only after explicit user confirmation, never silently.

**Inline passes (only when the role agents are not installed; run `setup-pstack` first).** Run all N candidate passes sequentially, one per numbered pass, in this session. Each pass is a full block of work run to completion before the next starts. Each pass gets the same task, the path to the shared grounding, its own output path, and instructions to produce both the artifact and a short rationale.

Record which model ran which pass in the synthesis record. A pass that can't produce output reports BLOCKED; otherwise it reports PASS (artifact and rationale complete) or ISSUES (incomplete; note what's missing). Proceed with N-1 and note any dropout in the synthesis record.

The rationale is mandatory. Without it, the parent cannot tell whether a candidate's structure is principled or accidental, which makes Phase E grafting unreliable. Each rationale names the alternatives the candidate considered and what it rejected.

## Phase C: Cross-judge

**Judge spawn (default).** Launch one judge as a task-tool spawn naming a `pstack-arena-cross-judges-<n>` role agent chosen from the `arena cross-judge` role list bound by setup-pstack from the `modelRoles` entries in `~/.omp/agent/config.yml` when present; otherwise fall back to the strongest judgment model, the second-family model, or the fast mechanical model, preferring a different model family from the parent's. Contrast rule: the judge's model family must differ from the candidate authors' families and from the parent's — the cross-judge pool spans families, so pick a contrasting seat and note the family of each pass in the record; never judge on the same family as the eventual base author when a contrasting seat is available. It sees the rubric and the candidates by path label (Candidate A, B, C — never by model name or seat), scores each criterion, and recommends a base with rationale. It runs after every candidate pass completed — not while candidates are still mid-write, because a judge that sees partial or empty outputs reports them as false dropouts. The judge works read-only: it reads, it doesn't execute, write, or merge anything. Record which model judged.

**Inline judge pass (only when the role agents are not installed; run `setup-pstack` first).** After all Phase B candidates complete, choose one model from the `arena cross-judge` role list bound by setup-pstack from the `modelRoles` entries in `~/.omp/agent/config.yml` when present. Otherwise use the strongest judgment model, the second-family model, or the fast mechanical model — prefer a different model family from the parent's. Run one judge pass in this session; record which model judged. It sees the rubric and the candidates by path label (Candidate A, B, C — never by model name), scores each criterion, and recommends a base with rationale.

The judge pass runs after every candidate pass completed — not while candidates are still mid-write, because a judge that sees partial or empty outputs reports them as false dropouts. The judge works read-only: it reads, it doesn't execute, write, or merge anything.

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

One synthesized artifact. One synthesis note alongside, naming the base, the grafts (with source candidate), the rejections, the dropouts if any, the model that ran each candidate and judge pass, and the verification result. To synthesize the artifact, check out the base candidate's worktree contents; never merge the worktrees into the parent checkout until the user explicitly confirms the result.
