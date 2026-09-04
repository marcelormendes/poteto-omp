# poteto-pi: PI.dev port architecture

Source planning: `planning/2026-09-01-pstack-omp-design.md` (approved spec) and
`planning/2026-09-01-pstack-omp.md` (build plan). Both target OMP; this file
records what changes for upstream PI 0.84.4 (`/opt/homebrew`, `~/.pi/agent`).

## Verified platform facts

- PI events include `before_agent_start`, `session_start`, `session_compact`,
  `tool_call`. Router injection via `before_agent_start` ports directly.
- PI built-in tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`.
  No `task`, no Agent Hub, no `pstack_route`, no `pstack_transcripts`,
  no `eval agent()`, no LSP tool, no `yield`, no model roles.
- Skills follow the Agent Skills standard (`SKILL.md`, name/description
  frontmatter, `/skill:name` commands, on-demand loading).
- Extensions are TS modules importing `@earendil-works/pi-coding-agent`;
  locations `~/.pi/agent/extensions/`, `.pi/extensions/`; `pi install`
  distributes npm/git packages.
- Sessions are trees under `~/.pi/agent/sessions` (adapter must be re-derived;
  OMP transcript paths do not apply).

## What ports directly

- All 47 skill bodies (methodology prose): how, why, architect, arena,
  swarm, interrogate, reflect, poteto playbooks, principles, references.
- Extension shape: factory, `registerCommand`, `registerTool`, `appendEntry`,
  `ctx.ui`, event subscriptions.
- Upstream sync pipeline, classification policy, forbidden-construct scan
  (retargeted: OMP-isms instead of Cursor-isms), generated-artifact tests.
- `worktree-audit.sh`, `check-plan.mjs`, `watch-pr`, `orch` scripts.

## What must be re-expressed (no subagents on PI)

- Panels (critics, judges, reviewers, runners) become sequential passes in one
  session. Blinding becomes prompt discipline: artifacts are labeled
  "Candidate A/B/C" in files under `/tmp`, never with model names.
- Arena isolation becomes `git worktree` checkouts created via `bash`,
  one per candidate, applied by explicit user-confirmed merge. The
  `isolated:true/apply:false` invariant becomes a checklist, not an API call.
- Swarm slices become sequential ownership blocks with a merge contract.
- `pstack_route` becomes a skill-side model table: the router names a role,
  the user switches model mid-session (PI supports this natively).
- `pstack_transcripts` becomes an extension custom tool reading PI session
  trees with the same bounded/project-scoped contract.
- `/loop` and goal mode are absent on PI (OMP additions). Bounded work uses
  `bash` polling and explicit iteration caps instead.
- MCP-proxy tool profiles (PI MCP surface differs; why/reflect become
  prompt-posture only until verified).

## Resolved open questions (2026-09-03, PI 0.84.4)

1. Models: `--model provider/id`, `--models` + Ctrl+P cycling, `--list-models`.
   Role routing names a role and selector; the user switches. No programmatic
   per-call model selection exists.
2. `/loop` and goal mode are absent on PI (OMP additions). Bounds playbooks
   use `bash` polling and explicit iteration caps instead.
3. Sessions: same JSONL entry shape as OMP (`session`, `model_change`,
   `message`, parent-linked), per-project dirs. Adapter ports with PI paths
   (`~/.pi/agent`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`).
4. Distribution via `pi install` (npm/git packages); exact `pi.skills`
   manifest shape to confirm against an installed package during build.
