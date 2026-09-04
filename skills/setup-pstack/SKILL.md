---
name: setup-pstack
description: Configure which models pstack uses per role. Detects your available models with `omp models` and writes the role config the generated agents bind. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Write `~/.omp/agent/config.yml`, the OMP settings + modelRoles configuration that binds pstack's model per role, and generate the pstack-* role agents into `~/.omp/agent/agents/`. The skills spawn role agents and fall back to their inline role defaults when an entry is absent, so this is an override layer, not a requirement.

## Steps

### 1. Detect available models

Run `omp models`. That table is the dependable source: each row is a provider and a model, and the `provider/model` form is the selector the model role entries accept. If it is empty or errors, ask the user to paste the selectors they have access to. Never write a real selector you have not confirmed is available.

### 2. Load current state

If `~/.omp/agent/config.yml` already exists, read it and treat its `modelRoles` values as the current choices. Otherwise start from the default table in step 5.

### 3. Confirm or replace each default with the user

Walk the user role by role through the table below: show the default,
ask to accept or replace it, offer detected selectors as the options.
For panel roles (how critics, arena runners, architect runners,
interrogate reviewers) the value is a list of seats, and one fan-out
spawn runs per entry, so the list length sets the spawn count. `arena
cross-judge pool` is also a list, but Arena selects one value from it whose
model family differs from the session model when possible. `swarm workers` is
the default model for every ownership block in a swarm run unless a race
or comparison assigns another model per arm. Do not skip roles: an
unconfirmed role keeps no value and falls back to the skill default.

### 4. Smoke-test each distinct model

A selector listed in `omp models` can still have dead credentials
(expired OAuth is silent until launch). For each distinct model in the
confirmed table, spawn one trivial read-only run via the `task` tool:
`{ agent: "pstack-how-explorer", task: "reply with exactly smoke-ok" }`
(fallback agent: `scout`). Every smoke run must return the marker. A dead
credential fails setup right here naming the exact provider: fix auth
before any file is written. This is cheaper than debugging fifteen dead
roles later.

### 5. Validate

Every real selector written must be in the detected set. If a chosen real selector is not available, stop and ask again. A config entry pointing at a model the user cannot use breaks every pass that reads it.

### 6. Write the config and generate the agents

Write `~/.omp/agent/config.yml`, one `modelRoles` entry per role, using the same labels the skills use. Overwrite the whole file so re-runs stay idempotent. The values are the resolved selectors you confirmed in step 3, never a slug you invented. Shape (defaults verified against `omp models`; confirm or replace each role with the user in step 3 before writing):

```yaml
# pstack model configuration. One entry per role agent. Delete an entry to fall
# back to the skill default. Panel seats each get their own entry.
modelRoles:
  pstack-feature: opencode-go/glm-5.3-flash
  pstack-refactoring: opencode-go/glm-5.3-flash
  pstack-bug-fix: openai-codex/gpt-5.6-sol:xhigh
  pstack-perf-issue: openai-codex/gpt-5.6-sol:xhigh
  pstack-hillclimb: openai-codex/gpt-5.6-sol:xhigh
  pstack-judgment-prose: openai-codex/gpt-5.6-sol:xhigh
  pstack-hardest: openai-codex/gpt-5.6-sol:xhigh
  pstack-how-explorer: opencode-go/glm-5.3-flash
  pstack-how-explainer: openai-codex/gpt-5.6-sol:xhigh
  pstack-how-critics-1: opencode-go/deepseek-v4-flash-vision-exp:max
  pstack-how-critics-2: openai-codex/gpt-5.6-sol:xhigh
  pstack-how-critics-3: opencode-go/glm-5.3-flash
  pstack-how-critics-4: openai-codex/gpt-5.6-sol:high
  pstack-why-investigator: opencode-go/glm-5.3-flash
  pstack-why-synthesizer: openai-codex/gpt-5.6-sol:xhigh
  pstack-reflect-tooling: openai-codex/gpt-5.6-sol:xhigh
  pstack-reflect-judgment: openai-codex/gpt-5.6-sol:xhigh
  pstack-reflect-divergent: openai-codex/gpt-5.6-sol:xhigh
  pstack-reflect-synthesizer: openai-codex/gpt-5.6-sol:xhigh
  pstack-arena-runners-1: opencode-go/deepseek-v4-flash-vision-exp:max
  pstack-arena-runners-2: openai-codex/gpt-5.6-sol:xhigh
  pstack-arena-runners-3: opencode-go/glm-5.3-flash
  pstack-arena-runners-4: openai-codex/gpt-5.6-sol:high
  pstack-arena-cross-judges-1: opencode-go/deepseek-v4-flash-vision-exp:max
  pstack-arena-cross-judges-2: openai-codex/gpt-5.6-sol:xhigh
  pstack-arena-cross-judges-3: opencode-go/glm-5.3-flash
  pstack-arena-cross-judges-4: openai-codex/gpt-5.6-sol:high
  pstack-swarm-worker: opencode-go/glm-5.3-flash
  pstack-architect-runners-1: opencode-go/deepseek-v4-flash-vision-exp:max
  pstack-architect-runners-2: openai-codex/gpt-5.6-sol:xhigh
  pstack-architect-runners-3: opencode-go/glm-5.3-flash
  pstack-architect-runners-4: openai-codex/gpt-5.6-sol:high
  pstack-interrogate-reviewers-1: opencode-go/deepseek-v4-flash-vision-exp:max
  pstack-interrogate-reviewers-2: openai-codex/gpt-5.6-sol:xhigh
  pstack-interrogate-reviewers-3: opencode-go/glm-5.3-flash
  pstack-interrogate-reviewers-4: openai-codex/gpt-5.6-sol:high
```

Then generate the role agents into `~/.omp/agent/agents/`, one file per entry (the setup script does this; re-running regenerates in place). Each agent binds its entry's selector, carries its role's tool allowlist and system prompt, and lists no `spawns` (a pstack role agent never spawns its own children). `pstack-judgment-prose`, `pstack-hardest`, `pstack-feature`, `pstack-bug-fix`, `pstack-perf-issue`, `pstack-refactoring`, `pstack-hillclimb` are writers; all other role agents are read-only by definition.

### 7. Enforce delegation guardrails (structural, not prose)

Lauren's roles run as local subagents. These settings make the guardrails
real instead of advisory. Merge, never overwrite: read the config file
first and preserve every unrelated key. Confirm each change with the user
before writing (settings edits are hard to review after the fact).

- In `~/.omp/agent/config.yml` (the OMP settings file), set:
  `task.isolation.enabled: true` (the `isolated: true` spawn field is only
  advertised when it is on), `task.isolation.apply: false` (the runtime
  keeps each writer's patch instead of auto-applying, so the parent merges
  only on explicit user confirmation), `task.maxRecursionDepth: 2` (flat
  panels need 1, track coordinators need 2), and `task.batch: true` (the
  batch form is what panels fan out with).
- Never route pstack work through adapter identities that shell out to
  other CLIs or external providers; pstack runs local only. The role agents
  themselves never hold the `task` tool, so recursion is bounded by the
  depth setting, never silent.

### 8. Nothing to install

OMP supplies the runtime natively: the `task` tool for delegation (flat and
batch forms), the eval kernel's `agent()` bridge for barriered panels, and
the extension's pstack tools (`pstack_todo` for the todo list,
`pstack_transcripts` for session access, `pstack_memory` for durable memory,
and `/pstack-status` for the drift check). Bounded loops use bash polling
with an explicit iteration cap. No third-party package is needed; skip any
install step, and never force-install over an objection.

### 9. Confirm

Tell the user the config was written and that it applies to new sessions. Re-running this skill updates it. Then run `/pstack-status`: it must report clean. A drift line names the exact skipped guardrail; fix it before doing pstack work.

Then check that delegation resolves. Confirm every role the skills launch shows up in `~/.omp/agent/agents/` and in the agent roster (`/agents`): `pstack-feature`, `pstack-bug-fix`, `pstack-refactoring`, `pstack-perf-issue`, `pstack-hillclimb`, `pstack-judgment-prose`, `pstack-hardest`, `pstack-how-explorer`, `pstack-how-explainer`, `pstack-why-investigator`, `pstack-why-synthesizer`, `pstack-reflect-tooling`, `pstack-reflect-judgment`, `pstack-reflect-divergent`, `pstack-reflect-synthesizer`, `pstack-swarm-worker`, `pstack-how-critics-1..4`, `pstack-arena-runners-1..4`, `pstack-arena-cross-judges-1..4`, `pstack-architect-runners-1..4`, `pstack-interrogate-reviewers-1..4`. A role agent the roster does not show means delegation for that role fails. If any role agent is missing, or `/pstack-status` still reports drift, fail the setup: name the exact missing piece (the agent name, or the drift line naming the skipped guardrail) and the fix, and stop. No pstack work starts until both checks pass.

### 10. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /skill:create-verification-skill." On yes, invoke `/skill:create-verification-skill`. On no, move on without pushing.
