/**
 * The pstack routing contract and its reminders.
 *
 * The full contract is injected once per (post-compaction) branch as a
 * non-displayed custom message; later turns get a compact reminder. Role maps are queried through
 * pstack_route when needed, so the whole registry is not repeated each turn.
 */
import { computeSetupChecksum } from "../setup/schema";
import { UPSTREAM_PSTACK_VERSION } from "../core/types";
import type { GeneratedAgentsManifest, PstackConfig } from "../core/types";
import type { PstackModeState } from "./mode-state";

/** Short checksum label for reminders ("1a2b3c4d…"). */
export const setupChecksumLabel = (checksum: string): string =>
  checksum.length > 12 ? `${checksum.slice(0, 12)}…` : checksum;

/** Recompute the setup checksum for a parsed config (setup's canonical hash). */
export const currentSetupChecksum = (config: PstackConfig): string =>
  computeSetupChecksum(config);

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
  return `Pstack mode is enabled (upstream ${UPSTREAM_PSTACK_VERSION}, checksum ${setupChecksumLabel(checksum)}, ${agentCount}).

For a nontrivial engineering task, read skill://poteto-mode in full, including
its principle index, then follow the matching playbook. Read leaf principles
when applying them. An explicitly invoked specialist skill controls its own
workflow; do not wrap simple prose requests in engineering work.

Skills are read with the read tool at skill://<name>. User slash commands are
not shell commands. Explanations use how; rationale uses why; design uses
architect; competing artifacts use arena; disjoint work uses swarm; adversarial
review uses interrogate; session lessons use reflect. Project verification uses
create-verification-skill and maintain-verification-skill.

Before delegating, read skill://poteto-mode/references/omp-runtime.md.
Resolve role names and current selectors with pstack_route (or the xd:// gateway
advertised by OMP). Setup owns the model assignments; never invent an agent or
selector and never count a same-session imitation as another model's pass.
Use the native task batch form and collect all async results through hub.
Writers set isolated:true; readers omit it. Review retained patches, integrate
only authorized changes, and verify the real surface in the parent checkout.
Keep unselected candidates isolated. No nested CLI or remote workers.
The parent owns todos and the final report. A failed worker remains a failure;
report actual models, completed coverage, and gaps rather than trusting claims.`;
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
    `Read the narrowest specialist at skill://<name> and follow its instructions; ` +
    `resolve agent names and model selectors with pstack_route, never by inventing them. ` +
    `Writers run isolated, readers do not. Verify against the real surface.`;
};
