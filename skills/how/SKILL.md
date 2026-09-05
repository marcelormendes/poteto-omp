---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Can critique architecture. Use why for motivation."
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?" questions. Produce clear architectural explanations at the level of a senior engineer onboarding onto a subsystem. Enough to build a working mental model, not annotated source code.

Two modes:

1. **Explain** (default). Run exploration passes and produce a clear explanation
2. **Critique.** Explain first, then run one critic pass per model in your configured critic list to independently identify architectural issues

## Explain Mode

### Step 1. Understand the Question and Assess Complexity

Parse what the user is asking about:

- "How does the rate limiter work?", a subsystem
- "How do we handle billing for on-demand usage?", a feature flow
- "How is the auth service structured?", an architectural overview
- "Walk me through what happens when a user submits a form", a runtime trace

Identify the scope. If ambiguous, state your best-guess interpretation before exploring. Don't ask. Let the user redirect if you're off.

**Assess complexity to decide the approach:**

- **Simple** (a single module, a small utility, a narrow question like "how does function X work"): skip explorer passes; the explainer explores and explains in a single pass. Go to Step 2b.
- **Complex** (a subsystem spanning multiple files/services, a cross-cutting feature, a full architectural overview): run the explorer fan-out first, then hand off to the explainer. Go to Step 2a.

When in doubt, lean simple. You can always run explorer passes if the explainer hits a wall.

Before handing off, include any diff, Git history, or runtime output the question depends on in the shared context. These read-only agents have `read`, `grep`, and `glob`; the parent runs necessary commands. If a worker reports missing evidence, obtain that evidence before another focused pass.

### Step 2a. Explore (complex questions only)

Decompose the question into 2-4 exploration angles, each a distinct slice of the subsystem so passes don't duplicate work. Example split for "how does the rate limiter work?":

- Explorer 1: data model and state management
- Explorer 2: request path and enforcement
- Explorer 3: configuration and metrics infrastructure

The right decomposition depends on the question. Use your judgment. Narrow questions: 2 passes is fine. Broad subsystems: up to 4.

**Task fan-out (default).** Spawn one explorer per angle with one batched task call ({ context, tasks[] }); collect every launched job through `hub` before consuming results. Each item names the agent returned by pstack_route for the how-explorer role and carries a standalone brief built from `references/explorer-prompt.md` plus its exploration angle; read-only workers spawn without isolation. Briefs stay identical across passes except the angle; every brief is standalone — no explorer references another's findings. Results come back in input order, each with its PASS / ISSUES / BLOCKED status line.

Each pass should:
- Start broad: locate relevant directories and files (`glob`), grep for key types/interfaces/class names
- Follow the thread: from an entry point, trace the call chain (callers, callees, data flow, type definitions)
- Read the actual code, don't guess from file names
- Stop when it can describe the full path from input to output (or trigger to effect) without hand-waving any step
- Note things that are surprising, non-obvious, or that a newcomer would get wrong

Each pass returns structured findings with a PASS / ISSUES / BLOCKED status line: components found, flow traced, files read, anything non-obvious. A pass that can't trace its angle reports BLOCKED; skip it, note the dropout, and continue with the remaining passes. Overlap between passes is fine; the explainer reconciles.

Then proceed to Step 3.

### Step 2b. Direct Explain (simple questions)

**Task spawn (default).** Launch the explainer as one task spawn naming the agent returned by pstack_route for the how-explainer role; read-only, no isolation. Its task is the prompt from `references/explainer-prompt.md`; it explores (`glob`, `grep`, and `read`) and writes the explanation in one go. Same structure, just no explorer findings as input. Record the model from the result. Proceed to Step 4.

### Step 3. Synthesize (complex questions only)

**Task spawn (default).** Once all explorer passes return, launch the synthesize pass as one task spawn naming the agent returned by pstack_route for the how-explainer role, read-only, no isolation. Its task collects every pass's findings and the template in `references/explainer-prompt.md`; it reconciles overlapping findings, resolves contradictions, and weaves the slices into one unified picture. Record the model from the result.

### Step 4. Present

Present the explainer's output to the user. You may lightly edit for clarity or add context from the conversation, but don't substantially rewrite. The explainer's communication is the product.

### Output Format

Follow this structure, adapted to the question. Not every section is needed for every question.

**Overview.** 1-2 paragraphs. What it is, what it does, why it exists. Enough to decide whether to keep reading.

**Key Concepts.** The important types, services, or abstractions. Brief definition of each. Not exhaustive, just the ones needed to understand the rest.

**How It Works.** The core of the explanation. Walk through the flow: what triggers it, what happens step by step, where data goes, the decision points. Prose, not pseudocode. Reference specific files and functions so the reader can go look, but don't dump code blocks unless a snippet is genuinely necessary.

**Where Things Live.** A brief map of the relevant files/directories. Not every file, just the ones needed to start working in this area.

**Gotchas.** Non-obvious or surprising things that would trip someone up. Historical context that explains why something looks weird. Known sharp edges.

**Pass log.** One line per pass: pass number, role, angle, model, status. Example: `Pass 1 — explorer — data model and state management — fast mechanical model — PASS`. This lets the reader see which model(s) produced the explanation.

## Critique Mode

Triggered when the user asks for architectural issues, problems, or improvements, not just understanding.

### Step 1. Explain First

Run the full explain flow above (Steps 1-4). You must understand the architecture before critiquing it.

### Step 2. Run Critics

Resolve the configured `how-critics` panel with `pstack_route` and run one critic per returned seat. Setup defines the models; never invent a selector.

**Task panel (default).** Run one critic per seat with one batched task call; each item names the agent returned by pstack_route for its how-critics seat, carries the identical brief, and reads only without isolation. Record which model ran which pass.

Each critic reads the code and edits nothing. Collect all job results before lead judgment.

Read `references/critic-prompt.md` for the prompt template. Each critic pass gets:
1. The explanation from Step 1 (so it doesn't re-explore)
2. The relevant file paths (so it can read the actual code)
3. The architectural critique rubric from `references/critique-rubric.md`

Each critic pass returns its findings with a PASS / ISSUES / BLOCKED status line. Dropout tolerance: a BLOCKED pass (or a pass the user skips) is noted and the remaining passes continue.

### Step 3. Lead Judgment

Same framework as the interrogate skill. You're a pragmatic lead, not an aggregator.

Categorize findings:
- **Act on.** Architectural problems worth fixing now
- **Consider.** Real concerns, but the cost/benefit is unclear
- **Noted.** Valid observations, low priority
- **Dismissed.** Wrong, missing context, or style preference

Present the explanation first (from Step 1), then the critique verdict below it. The explanation should stand on its own; someone who just wants to understand the system shouldn't wade through critique. The verdict includes the pass log with the model that ran each critic pass.
