### Worktree cleanup

Use this playbook when the user asks to reclaim worktree space. Inventory first, preserve work, and remove only the confirmed unused set.

1. Record `df -h /`. Resolve `scripts/worktree-audit.sh` relative to the installed poteto-mode skill and run it with the repository path. The helper reads `git worktree list --porcelain -z`, preserves paths containing spaces, and reports local size, age, merge state, dirty state, lock state, and a suggested bucket. It does not fetch or scan private session history.
2. Review each candidate. `hold-work` includes tracked changes and untracked files; neither is disposable by default. `hold-locked` stays on hold. `review-merged` means only that the checkout's commit is reachable from the locally cached origin/main (or local main when no origin/main exists). It does not prove that the branch is published, the worktree is unused, or deletion is authorized. PR and session columns deliberately say `unchecked`.
3. Check whether the candidate is in use by the current task or another active process. Inspect only relevant project-scoped session evidence if needed. Review ignored files with `git -C <path> status --short --ignored` before removal; generated output can still contain useful artifacts. Keep uncertain candidates and explain why.
4. For clean, unused worktrees within the user's cleanup request, use `git worktree remove <path>` with a quoted observed path. A refusal is a reason to inspect the remaining files. Do not escalate to `--force` or `rm -rf` without identifying the data that would be lost and having authorization to discard it. Never delete the current checkout or an active worker's checkout.
5. Re-list worktrees and record disk usage after cleanup. Report what was removed and why each remaining candidate was held.

Simulator runtimes, package caches, and OMP configuration or sessions are separate stores. A worktree cleanup request does not authorize deleting those stores. Apply any broader cleanup request to specifically identified paths, with the same checks for use and recoverability.
