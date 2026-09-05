### Eval

**You own the experiment design. Plan, blind, run, synthesize.**

Evals test how a change affects agent behavior before promoting it: a new skill variant, a structural change, a prompt tweak. The failure mode is the observer effect. An agent that knows it's being evaluated behaves differently, so candidates must run blind.

**Non-negotiables for blinding:**

- No `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate`, or `arena` in any directory, file, or prompt the candidate sees.
- The candidate prompt looks like an organic user request. State the goal, not the meta. "build me a small todo cli" not "show me how you follow the principles chain".
- No chain-eliciting cues. Don't ask the candidate to list which skills, principles, or files they applied; that meta-prompt inflates citation behavior. Ask for design notes generally and grade chain-following from code shape, not self-report.
- Sanitize directory and slug names. Use project-shaped names a user might pick, not labels like `candidate-1` or `agent-a`.
- Don't tell the candidate other candidates exist.
- The judge can know it's judging but sees outputs by sanitized label only, never by model name.
- Comparing two variants: one judge scores both sets in a single pass on one scale, blind to which set each came from. Two judge runs with different prompts don't compare, the calibration drifts.

**Steps:**

1. **Frame.** State what variant is under test and what behavior counts as success. Write the rubric (3-6 concrete criteria) for the judge only. Hold it back from candidates.
2. **Set up sanitized environments.** Per-candidate working dir with the variant in place. Plant any context an organic task would have: a project skeleton, the skills the candidate would naturally read.
3. **Author one organic prompt.** What a user would type. No leakage of what's being measured.
4. **Launch the passes** using the configured arena runner seats. Resolve them with `pstack_route`. Give each pass its own sanitized directory and the identical organic prompt. Keep variant instructions inside that pass's directory; do not broadcast every variant in shared `context`. Use the native task tool's supported `cwd` field when available; otherwise name the absolute directory and require all commands to run there. These independently prepared directories already provide isolation, so do not layer an unrelated worktree on top. Use neutral task IDs such as `maple` and `cedar`. Collect all returned async job IDs with `hub`; a batch submission alone is not completion. Record the actual model outside the candidate-visible artifact.
5. **Run one blinded judge pass** from the configured arena cross-judge panel on a family different from the parent. Keep candidate model identities out of the judge's brief. If a judge family absent from all candidates exists, prefer it; otherwise record the overlap as an experiment limitation instead of inventing a seat or substituting a same-model parent review. Give the judge the sanitized outputs and one shared rubric; collect its completed result.
6. **Verify the chain from transcripts, not self-report.** Read each candidate's session transcript via the **pstack_transcripts** tool for this project. Do not read another project's transcripts; that crosses workspace boundaries and reads private chats from unrelated projects. Look at which files each candidate actually opened. Citing a principle is not reading its leaf skill, and reading it is not applying it. Grade chain-following from the files it really read plus the shape of the code, never from the candidate's own claims.
7. **Read every candidate output yourself** end to end. Compare to the judge's verdict. Disagreement means a model is biased or the rubric is ambiguous. Synthesize.

**Reply:** variant under test, rubric, per-candidate notes, judge's verdict, your synthesis, and a recommendation for whether to promote the variant.
