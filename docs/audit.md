# Local OMP readiness audit

Audited September 4–5, 2026 against Lauren Tan's pstack 0.14.8 at
[`93b00b89ef425a9c1bac0d0b317dfc49c930ac99`](https://github.com/cursor/plugins/tree/93b00b89ef425a9c1bac0d0b317dfc49c930ac99/pstack).
Scope: local installation, setup, verification, poteto-mode, every bundled skill,
and the helper programs. No commit, push, publication, cloud worker, SSH, or
Tailscale setup was performed.

## What changed

- **Entry and setup:** `/poteto-mode <task>` now submits task text instead of rejecting it. Interactive setup uses valid provenance and the active model facade. Config commands target the exact active agent directory, including profiles and custom paths. Setup reloads OMP so generated agents work immediately.
- **Transactions and ownership:** cross-process locking, snapshots before mutation, verification after writes, ordered rollback, and retained backups on restoration failure. Unsafe manifest paths, duplicate entries, malformed hashes, and edited obsolete agents fail before mutation. Unrelated settings and agents survive setup.
- **Task configuration:** batching and isolation enabled, automatic patch application disabled, nested delegation allowed. Existing concurrency is preserved. Doctor detects alias, generated-agent, checksum, and capability drift.
- **Upstream parity:** independent workers restored where the port had substituted parent-session imitations or serialized unrelated work. This includes Comment Sicko, verification source readers, history mining, and playbooks. Invented model defaults and duplicate fallbacks removed. Implementation roles load poteto-mode through native `autoloadSkills`; specialist roles retain narrow briefs.
- **Isolation:** completed OMP workspaces may disappear. Skills now use retained patch paths. Arena tests replay all four patches, compare them with worker writes, run their tests, check behavior independently, and confirm the parent remains unchanged.
- **Context cost:** the full router fell from 6,965 to 1,539 UTF-8 bytes, about 78%. Roles resolve when needed; narrow leaf workers skip the coordinator router. Read-only workers return missing command evidence to the parent instead of attempting to reconstruct it from binary Git objects.
- **Transcripts:** bounded header discovery before scoped content, native title records before headers, nested/custom session roots, modification-time ordering for resumed sessions, UTF-8 byte caps, ambiguous-ID rejection, visible truncation, tool/model evidence, and credential redaction.
- **Cleanup:** read-only worktree inventory handles spaces, dirty/untracked work, current trees, and locked trees. Removed broad forced deletion advice for configs, history, caches, and unreviewed files.
- **Packaging:** transient files and nested dependency trees excluded. Helpers use the plugin's installed dependency instead of installing another tree and restarting themselves on first invocation. Installed `orch` and `watch-pr` startup tested outside the checkout.
- **Validation and provenance:** replaced the assertion-skipping pilot and duplicate dist test discovery. Every shipped TypeScript helper is typechecked. Lauren's MIT attribution restored and stale PI planning documents removed. Repository dependency overrides resolve the optional SDK advisories; `bun audit --json` reports zero advisories.

The original principles, independent review, design exploration, ownership, and
real-surface verification remain. Cursor-specific mechanics use OMP equivalents.
The cloud-oriented `make-bot-ui` and `benny` are outside this local port; the
bounded `loop` skill is an OMP adaptation.

## Live environment and evidence

OMP 18.1.10, Bun 1.3.14, macOS. Tests launch separate native OMP processes.
A real terminal session exercised setup, status, skills, and parent-model
inheritance. Native RPC also exercised the full matrix and all 36 interactive
model-selection dialogs, cancellation, and mode persistence/resume.

Observed models from actual assistant usage records:

- `openai-codex/gpt-5.6-sol`: parent and workers.
- `openai-codex/gpt-5.6-luna`: panel workers.
- `opencode-go/deepseek-v4-flash`.
- `opencode-go/glm-5.3-flash`.

Four-seat panels use those selectors in that order, with low thinking, spanning
three families. Arena selects one contrasting cross-judge; the whole judge
pool is not required to execute. Configuration or a spawn alone never counts
as model execution.

Setup → create verification skill → run generated verification → poteto-mode
passed in the same disposable repository. The parent applied the worker patch
and passed regression tests plus an independent behavior check. The matrix also
covers design candidates, swarms, reflection lenses and synthesis, comment
deletion, red-before-green TDD, decision trails, and every principle. Large-history
fixtures contain labeled synthetic records. Only new live transcripts count
as model execution.

Reports and sanitized evidence are under `.artifacts/`:

| Report | Evidence |
|---|---|
| `test-omp/report.json` | Link, doctor, sessions, ownership, rollback, uninstall |
| `package/report.json` | Tarball outside the checkout, helper startup, setup, discovery |
| `setup-ui/report.json` | 36 selections, cancellation, mode off/resume/on |
| `acceptance/report.json` | Initial complete matrix, including the caught Comment Sicko failure |
| `final-live/report.json` | Panel, coordinator, role-dispatch reruns |
| `parity-live/report.json` | Repaired workflow and history-mining reruns |
| `final-smoke/report.json` | Setup skill guidance and natural-language routing |
| `audit/terminal-proof.json` | Terminal and inheritance proof |
| `audit/arena-independent-checks.json` | Four independent patch replays |
| `audit/tdd-order.json` | Failure before production edit, passing rerun afterward |
| `audit/readiness-script-replay.json` | Independent execution of the generated audit script |
| `audit/prompt-size.json` | Router size measurement |

The earlier GLM 5.3 worker timed out; that attempt remains in
`audit/slow-model-run.json`. The fixture switched to GLM 5.3 Flash and the
workflow passed on rerun. An Arena reviewer claimed a patch/report mismatch;
independent replay disproved it. OMP attempted its QA device, but its
noninteractive consent gate prevented recording or sending the report.
Automatic QA is now disabled in test processes.

## Limits and cleanup

These are live integration and bounded behavioral acceptance tests, not a proof
of every possible project, provider outage, external connector, or PR/merge
workflow. Cloud execution and publication are deferred as requested. Transcript
reads cap each file at 8 MiB and expose truncation. Tool restrictions and
non-writing briefs are workflow controls, not an OS sandbox. The dependency
audit covers this repository's lockfile; the installed OMP distribution was
not modified.

Disposable profiles isolate plugin/configuration changes from the default
profile. Copied credential databases are removed after each run. Fixtures and
execution evidence remain for inspection and are excluded from the package.

## Final verification

45/45 bundled skills passed live. 52/52 distinct acceptance scenarios passed after repairs and reruns, with 534 parent model responses and 74 completed workers. Earlier failed attempts remain in the source reports. Consolidated evidence: `.artifacts/audit/final-report.json`.

121 repository tests pass. Typechecking, deterministic build verification, native plugin integration, interactive setup, installed tarball/helper checks, and dependency audit pass. The final build contains 45 skills, 2 static agents, and 145 files.

| Bundled skill | Result | Parent responses | Completed workers |
|---|---|---:|---:|
| `architect` | PASS | 18 | 6 |
| `arena` | PASS | 27 | 5 |
| `automate-me` | PASS | 17 | 0 |
| `blast-radius` | PASS | 22 | 5 |
| `bro` | PASS | 1 | 0 |
| `create-verification-skill` | PASS | 21 | 0 |
| `figure-it-out` | PASS | 20 | 1 |
| `how` | PASS | 5 | 1 |
| `interrogate` | PASS | 13 | 4 |
| `loop` | PASS | 9 | 0 |
| `maintain-verification-skill` | PASS | 17 | 1 |
| `no-comments` | PASS | 14 | 1 |
| `poteto-mode` | PASS | 34 | 3 |
| `principle-boundary-discipline` | PASS | 3 | 0 |
| `principle-build-the-lever` | PASS | 3 | 0 |
| `principle-encode-lessons-in-structure` | PASS | 3 | 0 |
| `principle-exhaust-the-design-space` | PASS | 19 | 6 |
| `principle-experience-first` | PASS | 9 | 1 |
| `principle-fix-root-causes` | PASS | 4 | 0 |
| `principle-foundational-thinking` | PASS | 3 | 0 |
| `principle-guard-the-context-window` | PASS | 4 | 0 |
| `principle-laziness-protocol` | PASS | 3 | 0 |
| `principle-make-operations-idempotent` | PASS | 4 | 0 |
| `principle-migrate-callers-then-delete-legacy-apis` | PASS | 17 | 1 |
| `principle-minimize-reader-load` | PASS | 4 | 0 |
| `principle-model-the-domain` | PASS | 3 | 0 |
| `principle-never-block-on-the-human` | PASS | 3 | 0 |
| `principle-outcome-oriented-execution` | PASS | 3 | 0 |
| `principle-prove-it-works` | PASS | 4 | 0 |
| `principle-redesign-from-first-principles` | PASS | 3 | 0 |
| `principle-separate-before-serializing-shared-state` | PASS | 3 | 0 |
| `principle-sequence-verifiable-units` | PASS | 5 | 0 |
| `principle-subtract-before-you-add` | PASS | 9 | 1 |
| `principle-type-system-discipline` | PASS | 4 | 0 |
| `recall` | PASS | 5 | 0 |
| `reflect` | PASS | 15 | 4 |
| `setup-pstack` | PASS | 1 | 0 |
| `show-me-your-work` | PASS | 25 | 2 |
| `swarm` | PASS | 10 | 3 |
| `tdd` | PASS | 13 | 0 |
| `teach` | PASS | 16 | 5 |
| `technical-writing` | PASS | 6 | 0 |
| `typescript-best-practices` | PASS | 3 | 0 |
| `unslop` | PASS | 1 | 0 |
| `why` | PASS | 12 | 3 |

Additional scenarios: generated `verify-number-cli`, `how-critique`, `natural-how`, `poteto-coordinator`, `role-dispatch`, `recall-history`, and `automate-history`.
