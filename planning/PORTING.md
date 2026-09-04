# pstack-pi skill porting rules

Source: `upstream-skills/` (cursor/plugins pstack at 7314f72, immutable).
Output: `skills/` (PI-ready). Never edit `upstream-skills/`.

## Mechanical transforms (script-safe)

- `~/.cursor/rules/pstack-models.mdc` -> `~/.pi/agent/pstack/models.md`
- `.cursor/skills/` -> `.pi/skills/`
- `.cursor/automations/` -> drop (Benny excluded entirely)
- `cursor-team-kit` `deslop` trigger -> drop that trigger line
- `control-cli` / `control-ui` references -> `bash-driven harness
  (Playwright script, PTY helper, or curl; see the project's verify skill)`
- Frontmatter: keep `name`, `description`, `license`, `compatibility`,
  `metadata`, `allowed-tools`, `disable-model-invocation`. Drop Cursor-only
  keys (`mode`, `icon`, `color`, `reminder`).
- `grok-4.6-fast-xhigh` -> `fast mechanical model (setup default)`;
  `claude-fable-5-1-thinking-max` / `claude-opus-5` -> `strongest judgment
  model (setup default)`; `gpt-5.6-sol` -> `second-family model`.
  Never invent PI model slugs; setup resolves them.

## Structural rewrites (by hand, per skill)

- Every `Task`/`subagent_type`/cloud-worker fan-out becomes sequential
  numbered passes in one session, same briefs, same PASS/ISSUES/BLOCKED
  envelopes, same dropout tolerance (skip and note).
- `environment: "cloud"` / `cloud_base_branch` -> `git worktree` via bash,
  merged only on explicit user confirmation.
- `run_in_background` / Agent Hub polling -> run inline, sequentially.
- `pstack-models.mdc` panel-list fan-out ("one subagent per entry") ->
  "one sequential pass per entry".
- `AskQuestion` tool -> `ctx.ui` prompt (PI: ask in prose; no such tool).
- `TodoWrite`/todolist -> the `pstack_todo` extension tool when present,
  else a markdown checklist in chat.
- `/loop` -> bash polling loop with an explicit iteration cap.
- Cross-model review ("different model") -> user switches model mid-session
  (`--model provider/id`, Ctrl+P); record which pass ran under which model.
- `make-bot-ui` -> do not port (Grok/Tailscale-specific).
- Links to `github.com/cursor/plugins/.../pstack/...` stay (provenance).

## Verification per skill

- Reread the ported skill fully; every bash path, command, and filename
  must exist or be created by the skill itself. No placeholders.
- `bun test` + `tsc` stay green (for anything with scripts).
