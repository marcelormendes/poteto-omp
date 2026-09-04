/**
 * The pstack routing contract and its reminders.
 *
 * The full contract is injected once per (post-compaction) branch as a
 * non-displayed custom message; later turns get a compact reminder plus the
 * configured registry. Both texts render the CURRENT setup: role rosters,
 * model selectors, and the setup checksum, so a changed configuration is
 * visible to the model instead of stale prose.
 */
import { computeSetupChecksum } from "../setup/schema";
import {
  PANEL_ROLES,
  UPSTREAM_COMMIT,
  UPSTREAM_PSTACK_VERSION,
  panelSeatAgentName,
  scalarAgentName,
} from "../core/types";
import type {
  GeneratedAgentsManifest,
  ModelChoice,
  PanelRole,
  PstackConfig,
  ScalarRole,
} from "../core/types";
import type { PstackModeState } from "./mode-state";

/** Short checksum label for reminders ("1a2b3c4d…"). */
export const setupChecksumLabel = (checksum: string): string =>
  checksum.length > 12 ? `${checksum.slice(0, 12)}…` : checksum;

/** Recompute the setup checksum for a parsed config (setup's canonical hash). */
export const currentSetupChecksum = (config: PstackConfig): string =>
  computeSetupChecksum(config);

const roleLine = (agent: string, choice: ModelChoice): string => {
  const model = choice.type === "model" ? choice.selector : "inherit-parent";
  return `- ${agent}: ${model}`;
};

const panelLines = (config: PstackConfig, panel: PanelRole): string[] => {
  const seats = config.panels[panel];
  return seats.map((choice, index) => {
    const agent = panelSeatAgentName(panel, index + 1);
    const model = choice.type === "model" ? choice.selector : "inherit-parent";
    return `- ${agent}: ${model}`;
  });
};

/** Scalar role registry (agent -> selector) in canonical order. */
export const buildScalarRegistry = (config: PstackConfig): string[] =>
  (Object.keys(config.roles) as ScalarRole[]).map((role) =>
    roleLine(scalarAgentName(role), config.roles[role]),
  );

/** Panel registry in canonical order, seats in configured order. */
export const buildPanelRegistry = (config: PstackConfig): string => {
  const lines: string[] = [];
  for (const panel of PANEL_ROLES) {
    lines.push(`${panel}:`);
    lines.push(...panelLines(config, panel));
  }
  return lines.join("\n");
};

/** Compact routing registry: agent names and selectors, nothing else. */
export const buildRoutingRegistry = (config: PstackConfig): string =>
  [...buildScalarRegistry(config), ...buildPanelRegistry(config).split("\n")].join("\n");

/**
 * Full routing contract. Rendered from the live config so renamed agents,
 * changed selectors, and config drift are reflected in what the model reads.
 */
export const buildFullRouter = (
  config: PstackConfig,
  manifest: GeneratedAgentsManifest | undefined,
): string => {
  const checksum = currentSetupChecksum(config);
  const agentCount = manifest
    ? `${manifest.entries.length} generated agents`
    : "generated-agent manifest not found";
  return `# Pstack routing contract (OMP edition)

Pstack mode is enabled. Here is how the user's goal routes. Interpret the
natural-language goal semantically, select the narrowest specialist skill, and
invoke it explicitly via /skill:name. Manual slash commands are overrides, not
a prerequisite. Setup: upstream pstack ${UPSTREAM_PSTACK_VERSION} at ${UPSTREAM_COMMIT} (commit ${config.upstreamCommit}), checksum ${setupChecksumLabel(checksum)}, ${agentCount}.

## Runtime invariants

- Everything runs locally on this host. No cloud workers, no remote executors,
  no external job providers, no adapter profiles (claude-code*, cursor-agent*,
  codex-exec*): those leave OMP to other CLIs. The root process must stay
  alive while workers run.
- Deployment surfaces are native OMP: the task tool (batch form
  { context, tasks[] } with per-item agent and isolated; flat form
  { agent, task, isolated }), eval agent()/parallel() for barriered one-shot
  panels, Agent Hub for async workers, modelRoles via generated pstack agents,
  the pstack_transcripts tool for project-scoped transcript evidence, and
  /loop or goal mode only for bounded autonomous work.
- Writers run isolated: pass isolated: true (task) or isolation on the eval
  spawn; never let an unselected arena candidate reach the parent checkout.
  Readers omit the flag. Shared mutable work serializes at one integration
  owner.
- The parent owns the todo list. Subagents receive complete assignments or use
  the orchestration ledger; they never mutate the parent's todos.
- The parent reviews and verifies every delegated result. You own the summary:
  verify claims against the real surface (commands run, files read,
  transcripts inspected, UI observed) and report evidence, not assertions.
- Never count a failed or dropped worker as a pass. Aggregate PASS/ISSUES/
  BLOCKED and report dropouts explicitly.

## Tool profiles (generated agents)

- read-only: how explorers/explainers, critics, arena judges, architect design
  runners, interrogate reviewers. Filesystem reads only.
- mcp-posture: why investigators/synthesizer, reflect reviewers/synthesizer.
  Full tool surface for MCP proxy access; the prompt forbids workspace mutation.
- writing: feature, bug-fix, refactoring, perf-issue, hillclimb, arena
  candidate, swarm slice, and ordinary poteto workers. Must be isolated.
- coordinator: poteto wrapper and orchestration coordinators. Controlled
  spawn permissions; they never start a nested pstack session.

## Specialist skills

- how: evidence-first explanation; explorers and explainer, then critics
- why: source-control and repository archaeology; investigators, synthesizer — MCP posture
- architect: competing designs from caller usage; isolated runners are read-only
- arena: parallel candidates in isolated checkouts, blinded adjudication, one
  contrasting-family judge
- swarm: parallel disjoint slices with a merge contract; writers isolated
- interrogate: identical evidence and rubric per reviewer; no auto-apply
- reflect: tooling, judgment, divergent lenses, then synthesis — MCP posture
- recall / show-me-your-work / session-pickup: transcript evidence via the
  pstack_transcripts tool
- create-verification-skill / maintain-verification-skill: project-local
  verification harnesses; the human is not the bottleneck
## Doing goals (no direct skill — use poteto-mode playbooks)

- Goals that change code or ship behavior (add a feature, fix a bug, refactor,
  improve performance, hillclimb, hardest-first, judgment prose) have no
  /skill:name. Read skill://poteto-mode and follow its matching playbook
  (feature, bug-fix, refactoring, perf-issue, hillclimb); the playbook names
  the generated pstack role agent — resolve it with pstack_route, never by
  inventing it, and spawn it via the task tool. Writers run isolated.

## Playbook index (poteto-mode)

authoring-a-skill, autonomous-run, autopilot-full, autopilot-stack, babysit,
bug-fix, eval, feature, hillclimb, investigation, multi-phase-plan,
opening-a-pr, orchestrate, pause-safely, perf-issue, prototype, refactoring,
runtime-forensics, session-pickup, shipping, trace-forensics, visual-parity,
worktree-cleanup.

## Principle index (all 21)

boundary-discipline, build-the-lever, encode-lessons-in-structure,
exhaust-the-design-space, experience-first, fix-root-causes,
foundational-thinking, guard-the-context-window, laziness-protocol,
make-operations-idempotent, migrate-callers-then-delete-legacy-apis,
minimize-reader-load, model-the-domain, never-block-on-the-human,
outcome-oriented-execution, prove-it-works, redesign-from-first-principles,
separate-before-serializing-shared-state, sequence-verifiable-units,
subtract-before-you-add, type-system-discipline.

## Configured role registry

### Scalars
${buildScalarRegistry(config).join("\n")}

### Panels
${buildPanelRegistry(config)}`;
};

/**
 * Compact per-turn reminder: mode state, setup checksum, route instruction.
 * Never repeats principle bodies or the full playbook index.
 */
export const buildReminder = (
  config: PstackConfig,
  state: PstackModeState,
  manifest: GeneratedAgentsManifest | undefined,
): string => {
  const checksum = setupChecksumLabel(currentSetupChecksum(config));
  const agentStatus = manifest
    ? `${manifest.entries.length} agents`
    : "manifest missing";
  const source = state.source === "auto" ? "auto (setup)" : state.source;
  return `Pstack mode is on (${source}; setup checksum ${checksum}; ${agentStatus}). ` +
    `Route the goal to the narrowest specialist skill and invoke it via /skill:name; ` +
    `resolve agent names and model selectors with pstack_route, never by inventing them. ` +
    `Writers run isolated, readers do not. Verify against the real surface.`;
};
