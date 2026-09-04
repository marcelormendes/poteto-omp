// Transactional pstack setup: validate, then apply agents -> modelRoles ->
// config, with ordered rollback and post-write verification.
//
// The transaction phases are applied in order: generated agents, modelRoles,
// config.yml. On any failure the previously applied phases are restored in
// reverse order (config -> roles -> agents), so no partial pstack state can
// survive a failed setup.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GeneratedAgent } from "./agent-generator";
import {
  applyGeneratedAgents,
  buildSemanticModelRoles,
  generateAgentFiles,
  readGeneratedAgentManifest,
} from "./agent-generator";
import type { ModelFacade } from "./catalog";
import { validateConfigModels } from "./catalog";
import type { ConfigRunner } from "./omp-config";
import { bunConfigRunner, mergeModelRoles, restoreModelRoles } from "./omp-config";
import type { PstackConfig } from "../core/types";
import type { PstackPaths } from "../core/paths";
import { PstackError } from "../core/errors";
import { activePstackPaths, resolvePstackPaths } from "../core/paths";
import {
  computeSetupChecksum,
  sha256Hex,
  stringifyConfig,
  validateCompleteConfig,
  verifySetupChecksum,
} from "./schema";

/** Injected runtime surface for setup; `models` mirrors `ctx.models`. */
export interface SetupDependencies {
  models: ModelFacade;
  /** Command runner for `omp config`; defaults to the real `omp` CLI. */
  runner?: ConfigRunner;
  /** OMP agent directory; defaults to ~/.omp/agent. */
  agentDir?: string;
}

/** Result of a successful setup transaction. */
export interface SetupReport {
  /** Final config including the computed setupChecksum. */
  config: PstackConfig;
  agents: GeneratedAgent[];
  /** pstack-* modelRoles entries written. */
  modelRoles: Record<string, string>;
  /** modelRole key -> opaque model family token. */
  families: Record<string, string>;
  /** Persistent paths written by this setup. */
  changedPaths: string[];
  /** Non-pstack modelRoles keys that were preserved. */
  preservedRoles: string[];
  /** Always true: generated agents and modelRoles are discovered at session start. */
  requiresNewSession: boolean;
}

const writeConfigAtomically = async (configPath: string, yaml: string): Promise<void> => {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, yaml, "utf8");
  await rename(tmp, configPath);
};

const readConfigRaw = async (configPath: string): Promise<string | null> => {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PstackError("PSTACK_IO", `cannot read ${configPath}: ${String(error)}`, { cause: error });
  }
};

const restoreConfig = async (configPath: string, previous: string | null): Promise<void> => {
  if (previous === null) {
    await unlink(configPath).catch(() => {});
  } else {
    await writeConfigAtomically(configPath, previous);
  }
};

/**
 * Post-write verification: the written config verifies against its embedded
 * checksum, the manifest records exactly the generated set, and every agent
 * file on disk matches the manifest checksum. Fails closed.
 */
export const verifySetupState = async (
  paths: PstackPaths,
  config: PstackConfig,
  agents: GeneratedAgent[],
): Promise<void> => {
  const configRaw = await readConfigRaw(paths.configPath);
  if (configRaw === null) {
    throw new PstackError("PSTACK_IO", `setup verification failed: ${paths.configPath} was not written`);
  }
  if (!verifySetupChecksum(configRaw)) {
    throw new PstackError(
      "PSTACK_IO",
      `setup verification failed: ${paths.configPath} does not verify against its setupChecksum`,
    );
  }
  const manifest = await readGeneratedAgentManifest(paths.generatedManifestPath);
  if (manifest === null) {
    throw new PstackError(
      "PSTACK_IO",
      `setup verification failed: ${paths.generatedManifestPath} was not written`,
    );
  }
  const expected = new Map(agents.map((agent) => [agent.file, agent.content]));
  if (manifest.entries.length !== agents.length) {
    throw new PstackError(
      "PSTACK_IO",
      `setup verification failed: manifest records ${manifest.entries.length} agents, expected ${agents.length}`,
    );
  }
  for (const entry of manifest.entries) {
    const content = expected.get(entry.file);
    if (content === undefined) {
      throw new PstackError("PSTACK_IO", `setup verification failed: manifest lists unknown agent ${entry.file}`);
    }
    let onDisk: string;
    try {
      onDisk = await readFile(join(paths.generatedAgentsDir, entry.file), "utf8");
    } catch (error) {
      throw new PstackError("PSTACK_IO", `setup verification failed: ${entry.file} missing: ${String(error)}`, {
        cause: error,
      });
    }
    if (onDisk !== content || entry.sha256 !== sha256Hex(content)) {
      throw new PstackError(
        "PSTACK_IO",
        `setup verification failed: ${entry.file} on disk does not match the generated content`,
      );
    }
  }
};

/**
 * Configure pstack end to end. Validation happens before any write; the
 * transaction applies agents -> modelRoles -> config.yml and rolls back in
 * reverse order on failure (config write is atomic, roles are restored to
 * their previous pstack subset, generated agent files and the manifest are
 * restored from backups). Ownership conflicts (modified or untracked
 * pstack-* agent files) abort before any mutation.
 */
export const configurePstack = async (input: {
  config: PstackConfig;
  deps: SetupDependencies;
}): Promise<SetupReport> => {
  const config = validateCompleteConfig(input.config);
  const paths =
    input.deps.agentDir !== undefined
      ? resolvePstackPaths(input.deps.agentDir)
      : activePstackPaths();
  const runner = input.deps.runner ?? bunConfigRunner();

  // Phase A: validate everything before any write.
  const validated = validateConfigModels(config, input.deps.models);
  const agents = generateAgentFiles(config);
  const modelRoles = buildSemanticModelRoles(config);

  // Phase B: generated agents (atomic; refuses ownership conflicts).
  const apply = await applyGeneratedAgents(paths, agents);

  let previousConfigRaw: string | null = null;
  let previousRoles: Record<string, string> | null = null;

  try {
    // Snapshot the current config for exact rollback before any write.
    previousConfigRaw = await readConfigRaw(paths.configPath);

    // Phase C: pstack-* modelRoles (preserving merge).
    const merged = await mergeModelRoles(runner, modelRoles);
    previousRoles = merged.previous;

    // Phase D: config.yml with the computed setup checksum.
    const finalConfig: PstackConfig = { ...config, setupChecksum: computeSetupChecksum(config) };
    await writeConfigAtomically(paths.configPath, stringifyConfig(finalConfig));

    // Post-write verification: fail closed, then roll back on any mismatch.
    await verifySetupState(paths, finalConfig, agents);

    await apply.discard();
    const changedPaths = [
      paths.configPath,
      paths.generatedManifestPath,
      ...agents.map((agent) => join(paths.generatedAgentsDir, agent.file)),
    ];
    return {
      config: finalConfig,
      agents,
      modelRoles,
      families: validated.families,
      changedPaths,
      preservedRoles: merged.preserved,
      requiresNewSession: true,
    };
  } catch (error) {
    // Ordered rollback, reverse of application: config -> roles -> agents.
    await restoreConfig(paths.configPath, previousConfigRaw).catch(() => {});
    if (previousRoles !== null) {
      await restoreModelRoles(runner, previousRoles).catch(() => {});
    }
    await apply.rollback();
    if (error instanceof PstackError) throw error;
    throw new PstackError("PSTACK_IO", `setup failed: ${String(error)}`, { cause: error });
  }
};
