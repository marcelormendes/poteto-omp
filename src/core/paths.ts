/**
 * Namespaced paths under the active OMP agent directory.
 *
 * The active agent directory is profile-aware: resolvePstackPaths takes an
 * explicit dir for tests and callers that already know it; activePstackPaths
 * asks the SDK for the running session's directory.
 */
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export interface PstackPaths {
  /** Active OMP agent directory (~/.omp/agent, profile-aware). */
  readonly agentDir: string;
  /** pstack configuration file. */
  readonly configPath: string;
  /** OMP user agent directory where generated pstack agents land. */
  readonly generatedAgentsDir: string;
  /** Ownership manifest written by setup next to the config. */
  readonly generatedManifestPath: string;
}

/** Resolve every pstack path under an explicit agent directory. */
export const resolvePstackPaths = (agentDir: string): PstackPaths => ({
  agentDir,
  configPath: join(agentDir, "pstack", "config.yml"),
  generatedAgentsDir: join(agentDir, "agents"),
  generatedManifestPath: join(agentDir, "pstack", "generated-agents.json"),
});

/** Resolve every pstack path under the active OMP agent directory. */
export const activePstackPaths = (): PstackPaths => resolvePstackPaths(getAgentDir());
