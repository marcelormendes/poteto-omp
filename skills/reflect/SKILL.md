---
name: reflect
description: Run three review lenses over the active session, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

## When to invoke

- The user said "reflect" or "/reflect".
- A complex task (5+ tool calls) just landed cleanly and the recipe is worth keeping.
- The agent hit dead ends, found the working path, and the path generalizes.
- The user corrected the agent's approach mid-task.
- A non-trivial workflow emerged that isn't captured anywhere.

Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the active session

The agent finds its own session file before starting the passes. OMP stores sessions as JSONL files under `~/.omp/agent/sessions/<project>/<session>.jsonl`, one entry per message (same entry shape as the transcripts extension: `message.content` text parts). Locate it through the `pstack_transcripts` tool (bounded, project-scoped); never hardcode session paths.

Do not glob across other projects' session dirs. That crosses workspace boundaries and reads private chats from unrelated projects. Restrict the search to the current project's subdir (the `pstack_transcripts` extension tool resolves the current project automatically when present).

For each candidate, read the first JSONL entry and check that the entry's message text contains the conversation's opening user prompt. Take the matching path. If no path resolves, write a tight digest of the session and pass that instead.

### 2. Run three reviewers as a task-tool fan-out

**Fan-out (default).** Launch the three lens reviewers with the task tool's batch form: one call carrying `context` (the shared background) and `tasks`, one item per lens. Each item names its role agent — `pstack-reflect-tooling`, `pstack-reflect-judgment`, `pstack-reflect-divergent` (role agents live in `~/.omp/agent/agents/`) — and carries the lens template as the task. The call is the barrier; results return in input order. The role agents are non-writing: their prompts forbid file writes; the parent applies edits. Never let a lens edit files.

| Lens | Role agent | Prompt template |
|---|---|---|
| Judgment | `pstack-reflect-judgment` | `references/judgment-reviewer.md` |
| Tooling | `pstack-reflect-tooling` | `references/tooling-reviewer.md` |
| Divergent | `pstack-reflect-divergent` | `references/divergent-reviewer.md` |

Each role agent binds its model from the `modelRoles` entries in `~/.omp/agent/config.yml` (written by setup-pstack): the `reflect tooling` line for the tooling lens, the `reflect judgment, divergent, synthesizer` line for the judgment, divergent, and synthesizer seats. When a line is absent, use that role agent's pinned model (setup default). Never invent a model selector. If a configured value is `inherit-parent` or `auto`, use the role agent's pin and note it.

Pass each template verbatim as the task, substituting the session path or digest where marked. Lens runs are read-only: they may call MCP tools and read the codebase, never write.

```js
task({
  context: "<shared background: session path or digest>",
  tasks: [
    { agent: "pstack-reflect-judgment", name: "judgment", task: "<references/judgment-reviewer.md with the session path substituted>" },
    { agent: "pstack-reflect-tooling", name: "tooling", task: "<references/tooling-reviewer.md with the session path substituted>" },
    { agent: "pstack-reflect-divergent", name: "divergent", task: "<references/divergent-reviewer.md with the session path substituted>" }
  ]
})
```

Record which model each seat ran under, and whether the session went by path or digest. If a reviewer drops out or returns `BLOCKED`, proceed with the remaining lenses and note the gap when synthesizing; the batch keeps sibling seats running when one lane blocks or fails. If the user configured one model for all three lenses, note it: lens diversity is weaker with one model.

### 3. Synthesize (parent)

**Parent synthesis (default).** The parent performs the synthesis in its own session after the three lens reviewers return — do not launch a fourth subagent for it. Apply `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. The quality check includes spot-verifying citations, which can require read-only context lookups (MCP or codebase). The synthesis returns a structured Accepted / Rejected / Backlog list; the parent owns the criteria judgments and the presentation to the user.

This pass is judgment work. The parent runs it on its session model; if the session model differs from the configured synthesizer role (the `reflect judgment, divergent, synthesizer` line in `~/.omp/agent/config.yml`; default: strongest judgment model (setup default)), note the mismatch after the synthesis.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. The synthesizer already applies this criterion; this is a final pass before edits land. See the **encode-lessons-in-structure** principle skill.

### 5. Apply

Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval. Ask in prose; the user picks which subset to apply and may redirect routings. Skill changes affect every future agent; do not auto-apply.

Backlog items file to whatever devex / backlog tracker your team uses automatically. Those are tracker submissions, not skill edits. Only the Accepted list waits for approval.

For each approved Accepted item, follow the Routing field exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the authoring-a-skill playbook (`poteto-mode/playbooks/authoring-a-skill.md`) and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to the authoring-a-skill playbook and run its description-optimization loop.
- `new skill: <kebab-name>`: hand creation to the authoring-a-skill playbook. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done. Skip this step if it doesn't.

### 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.

**Inline passes (only when the role agents are not installed; run `setup-pstack` first).**

### 2. Run three reviewers as sequential passes

One session, three numbered passes, one per lens. Each pass reads the session and applies its lens. Record which model each pass ran under. The prompts forbid file writes; the parent applies edits.

| Lens | `model` | Prompt template |
|---|---|---|
| Judgment | your configured reflect-judgment model (default: strongest judgment model (setup default)) | `references/judgment-reviewer.md` |
| Tooling | your configured reflect-tooling model (default: second-family model) | `references/tooling-reviewer.md` |
| Divergent | your configured reflect-judgment model (default: strongest judgment model (setup default)) | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the session path or digest where marked. Reviewers return findings in the pass output. If a configured model is `inherit-parent` or `auto`, run that pass on the current session model and note it. If the user keeps one model for all three passes, note it: lens diversity is weaker with one model.

### 3. Synthesize

One pass after the reviewers, using your configured reflect-judgment model (default: strongest judgment model (setup default)). The synthesizer's quality check includes spot-verifying citations, which can require context lookups. Use `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. The synthesizer returns a structured Accepted / Rejected / Backlog list.
