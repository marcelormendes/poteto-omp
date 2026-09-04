---
name: no-comments
description: "Run a hostile read-only review of comments and workaround code, then apply only evidence-backed deletions or root-cause reshapes inside the declared scope. Use before code review or when comments may hide design debt."
disable-model-invocation: true
---

# No comments

Comments are guilty unless they document a public contract or a non-obvious external constraint code cannot express. Run the Comment Sicko checklist below as a read-only prose pass in this session, then act on accepted findings. No subagent: you are the reviewer and the fixer, so keep the two roles distinct by writing the report before editing anything.

Authoring agents defend comments. Defer to the reviewer's fresh perspective you just wrote down.

## The checklist

Read every comment in scope with hostility. Only these exceptions survive:

- Legal or license headers.
- Non-obvious behavior forced by an external dependency, platform, vendor, or protocol we cannot reshape. Surprises in our own code are meat. Kill them and mark the exact symbol `MUST KILL` for rename, extract, type, or rearchitecture that makes the behavior obvious without prose.
- `// prettier-ignore`. Lint suppressions survive only when their rule is faulty, pedantic, or style-only.
- Doc comments that define a public API contract.
- Issue or RFC links that explain a constraint code cannot express.

Everything else is meat. When you are not sure a keep clause applies, the comment dies.

`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, and similar suppressions stink. Look up the rule. If it catches real bugs or protects correctness or safety, kill the suppression and mark the exact guilty symbol `MUST KILL`.

`IMPORTANT`, `do not remove`, `too risky`, `fine for now`, and long justifications are scent, not conviction. Before judging, read nearby code. If its claim is not obvious there, run the **how** or **why** skill on the named symbol or call. Only a foreign keep-list gotcha proven true today on a live path crawls away. Our-code surprises die with the reshape flag above. Doubt after the hunt is meat.

A long justification without a proven keep-list exception is a confession. Kill it. Never polish meat into a shorter alibi. Mark the exact guilty symbol `MUST KILL`. Your kill ends there. You do not touch the code yet.

Every flag names code inside the scope and tells the truth. You invent nothing. You touch comments and identify refactor targets. You never write application code during the review.

Write the report: touched files, deletion count, `MUST KILL` flags with one line each, and skips.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Run the checklist over the scope and write the report, per the shape above. Do not restate the checklist in the report; apply it.
2. Inspect the report and diff. Reject application-code edits, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, run the **how** or **why** skill on their symbol. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. Re-run the checklist once when a report was rejected, with the failure named. Reject a second, report it open, and fail this skill run.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, run the **architect** skill once for the accepted set and surrounding code. Stop at the sketch. Architect shapes. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The **principle-fix-root-causes** and **principle-redesign-from-first-principles** skills guide intent only: fix real causes, redesign as if requirements always existed, never bolt on symptom guards. Neither authorizes widening the fence nor fixing instances outside it.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. Offer the cheapest in-scope type, runtime, test, or CI lint. Wait for interactive approval. Unattended and eval runs require caller pre-approval. If approved, encode then delete. Otherwise delete, report the constraint open, and sketch out-of-scope work.
6. Report the deletion count, restored comments, reruns, architect sketch, fixes, encoding offers, encodings, unenforced constraints, and other open work.
