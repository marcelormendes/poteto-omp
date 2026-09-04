/**
 * Canonical pstack-OMP role, config, and provenance types.
 *
 * Every module in src/setup, src/extension, and src/transcripts derives its
 * role vocabulary from these constants. The upstream commit is the immutable
 * Cursor pstack snapshot this package ports; setup validates that the written
 * config matches it.
 */

/** Immutable upstream pstack commit this port tracks. */
export const UPSTREAM_COMMIT = "b9ddc83c32972210b8a94d389130713e8eed346e";

/** Upstream pstack version recorded in the manifest at that commit. */
export const UPSTREAM_PSTACK_VERSION = "0.14.5";

/** Schema version for pstack config.yml and the generated-agents manifest. */
export const PSTACK_SCHEMA_VERSION = 1;

/**
 * Scalar roles: one generated agent each. Order is canonical — setup emits
 * roles/keys in this order and the checksum serialization uses it.
 */
export const SCALAR_ROLES = [
  "feature",
  "refactoring",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "judgment-prose",
  "hardest",
  "how-explorer",
  "how-explainer",
  "why-investigator",
  "why-synthesizer",
  "reflect-tooling",
  "reflect-judgment",
  "reflect-divergent",
  "reflect-synthesizer",
  "swarm-worker",
] as const;

export type ScalarRole = (typeof SCALAR_ROLES)[number];

/**
 * Panel roles: one generated agent per configured seat, 1-based. Order is
 * canonical and the configured seat order is preserved in routing.
 */
export const PANEL_ROLES = [
  "how-critics",
  "arena-runners",
  "arena-cross-judges",
  "architect-runners",
  "interrogate-reviewers",
] as const;

export type PanelRole = (typeof PANEL_ROLES)[number];

export type RoleName = ScalarRole | PanelRole;

/**
 * Model selection for one role. `inherit-parent` omits the model from the
 * generated agent so the subagent inherits the session model.
 */
export type ModelChoice =
  | { readonly type: "model"; readonly selector: string }
  | { readonly type: "inherit-parent" };

/**
 * Parsed, validated pstack configuration. Persisted config.yml always carries
 * the checksum; user-provided input files (setup --file) may omit it — the
 * checksum is then computed by setup. Setup sets it before persisting.
 */
export interface PstackConfig {
  readonly schemaVersion: typeof PSTACK_SCHEMA_VERSION;
  readonly upstreamCommit: string;
  readonly autoEnable: boolean;
  readonly setupChecksum?: string;
  readonly roles: Readonly<Record<ScalarRole, ModelChoice>>;
  readonly panels: Readonly<Record<PanelRole, readonly ModelChoice[]>>;
}

/**
 * Generated-agent tool profiles. Names are shared with the setup agent
 * generator and the generated-agents manifest values; not a duplicate vocabulary.
 */
export const TOOL_PROFILES = ["read-only", "mcp-posture", "writing", "coordinator"] as const;

export type ToolProfile = (typeof TOOL_PROFILES)[number];

/** Generated agent manifest entry (written by setup, verified by status). */
export interface GeneratedAgentEntry {
  /** File name under ~/.omp/agent/agents/, e.g. "pstack-feature.md". */
  readonly file: string;
  /** SHA-256 hex of the file content bytes. */
  readonly sha256: string;
  /** Semantic role, e.g. "feature" or "how-critics-1". */
  readonly semanticRole: string;
  readonly toolProfile: ToolProfile;
  /** modelRoles alias, e.g. "@pstack-feature"; null for inherit-parent. */
  readonly modelRole: string | null;
}

/** Ownership manifest for generated pstack agents. */
export interface GeneratedAgentsManifest {
  readonly schemaVersion: number;
  readonly entries: readonly GeneratedAgentEntry[];
}

/** Generated agent file name for a scalar role. */
export const scalarAgentName = (role: ScalarRole): string => `pstack-${role}`;

/** Generated agent file name for panel seat `seat` (1-based). */
export const panelSeatAgentName = (role: PanelRole, seat: number): string =>
  `pstack-${role}-${seat}`;
