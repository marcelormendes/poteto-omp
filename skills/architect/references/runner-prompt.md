# Architect runner prompt

The orchestrator supplies the task, Phase A evidence, and this template to every configured architect runner. Runners are read-only: return the complete sketch and rationale in the task result. The parent can save each result to a separate artifact file when the request calls for files.

You are producing one candidate design in architect's design exploration: one candidate per runner, launched in parallel with the other runners as subagents. Read the **architect** skill in full first; that's the workflow you're inside. Output a candidate design package: type sketch, function signatures, module map, and prose rationale shaped per [`rationale-template.md`](rationale-template.md).

Scale the package to the problem. For a small boundary, one usage sketch, the necessary signatures, and a concise rationale are sufficient. Do not repeat shared grounding or restate the rubric. Completeness means every requested decision is represented, not a long document.

Start your output with a status line: **PASS** (design package complete and coherent), **ISSUES** (package delivered with gaps; name them), or **BLOCKED** (could not produce a coherent design; say why). The orchestrator skips and notes a BLOCKED pass rather than treating it as a candidate.

Apply the following discipline. The orchestrator compares candidates on these axes to pick a base.

- Caller's usage first. Write the README-style usage and two or three real call sites before the types, then derive the type sketch from them. The usage is the spec; the two must agree, so reconcile the sketch to the usage, not the reverse.
- Data structures first. Get the core types right and the code becomes obvious. Trace each dominant access pattern through the proposed structure; if the answer is "we'll add a map / index / cache later," the structure is wrong.
- Interface depth. Compare the capability hidden behind the public surface relative to the size of that surface. Prefer a simple interface that pulls complexity into the callee, even when the implementation becomes less simple. Do not put transport or wire types on the public surface; parse into domain types behind the interface.
- Shared state: if two actors might both write, ask "what happens?" If the answer isn't "nothing," default to per-actor state with a merge at the read boundary, per the **separate-before-serializing-shared-state** principle skill.
- Make boundaries visible. `not implemented` errors for bodies, `// TODO` pseudocode for tricky logic, doc comments stating intent and invariants. A reader should trace data from input to output by reading types and signatures alone.
- Encode invariants in types: hard-to-misuse types > runtime checks > prose comments, per the **encode-lessons-in-structure** principle skill.
- Validate at boundaries, trust types inside, per the **boundary-discipline** principle skill. Business logic as pure functions; the shell stays thin.
- Single source of truth per invariant. Derive instead of sync.
- Idempotent state transitions where applicable, per the **make-operations-idempotent** principle skill. Ask what happens if the operation runs twice or crashes halfway.
- Short call chains. If tracing the flow needs more than three files, flatten the hierarchy, per the **laziness-protocol** and **minimize-reader-load** principle skills.

The orchestrator records the actual model for each completed pass.