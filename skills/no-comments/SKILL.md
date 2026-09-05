---
name: no-comments
description: "Run a hostile read-only review of comments and workaround code, then apply only evidence-backed deletions or root-cause reshapes inside the declared scope. Use before code review or when comments may hide design debt."
disable-model-invocation: true
---

# No comments

Spawn the installed `comment-sicko` agent for an independent read-only review, then act on accepted findings. The checklist lives in that agent; do not duplicate it here or impersonate a second reviewer in the parent session.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Use native `task` with `context` containing the scope and current diff, and `tasks: [{name: "commentReview", agent: "comment-sicko", task: "Review the scoped comments and return your report without edits."}]`. The agent inherits the parent's model. Collect its completed result through `hub` before accepting findings or editing. Record the actual model; a spawn without a completed report is not a review.

2. Inspect the report and diff. Reject application-code edits, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, run the **how** or **why** skill on their symbol. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. Rerun the agent once when a report was rejected, with the failure named. Reject a second, report it open, and fail this skill run.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, run the **architect** skill once for the accepted set and surrounding code. Stop at the sketch. Architect shapes. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The **principle-fix-root-causes** and **principle-redesign-from-first-principles** skills guide intent only: fix real causes, redesign as if requirements always existed, never bolt on symptom guards. Neither authorizes widening the fence nor fixing instances outside it.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. Offer the cheapest in-scope type, runtime, test, or CI lint. Wait for interactive approval. Unattended and eval runs require caller pre-approval. If approved, encode then delete. Otherwise delete, report the constraint open, and sketch out-of-scope work.
6. Report the deletion count, restored comments, reruns, architect sketch, fixes, encoding offers, encodings, unenforced constraints, and other open work.
