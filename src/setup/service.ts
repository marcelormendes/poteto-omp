// Transactional pstack setup: validate, then apply agents -> modelRoles ->
// config, with ordered rollback and post-write verification.
//
// The transaction phases are applied in order: generated agents, modelRoles,
// config.yml. On any failure the previously applied phases are restored in
// reverse order (config -> roles -> agents), so no partial pstack state can
// survive a failed setup.

import {
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "@oh-my-pi/pi-utils";
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
import {
  bunConfigRunner,
  mergeModelRoles,
  restoreModelRoles,
  readConfigValue,
  writeConfigValue,
  readModelRoles,
} from "./omp-config";
import { TASK_SETTINGS } from "../extension/capabilities";
import type { PstackConfig } from "../core/types";
import { UPSTREAM_COMMIT } from "../core/types";
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

const writeConfigAtomically = async (
  configPath: string,
  yaml: string,
): Promise<void> => {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, yaml, "utf8");
    await rename(tmp, configPath);
  } finally {
    await unlink(tmp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

const readConfigRaw = async (configPath: string): Promise<string | null> => {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PstackError(
      "PSTACK_IO",
      `cannot read ${configPath}: ${String(error)}`,
      { cause: error },
    );
  }
};

const restoreConfig = async (
  configPath: string,
  previous: string | null,
): Promise<void> => {
  if (previous === null) {
    await unlink(configPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
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
    throw new PstackError(
      "PSTACK_IO",
      `setup verification failed: ${paths.configPath} was not written`,
    );
  }
  if (!verifySetupChecksum(configRaw)) {
    throw new PstackError(
      "PSTACK_IO",
      `setup verification failed: ${paths.configPath} does not verify against its setupChecksum`,
    );
  }
  const manifest = await readGeneratedAgentManifest(
    paths.generatedManifestPath,
  );
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
      throw new PstackError(
        "PSTACK_IO",
        `setup verification failed: manifest lists unknown agent ${entry.file}`,
      );
    }
    let onDisk: string;
    try {
      onDisk = await readFile(
        join(paths.generatedAgentsDir, entry.file),
        "utf8",
      );
    } catch (error) {
      throw new PstackError(
        "PSTACK_IO",
        `setup verification failed: ${entry.file} missing: ${String(error)}`,
        {
          cause: error,
        },
      );
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
const configureUnlocked = async (input: {
  config: PstackConfig;
  deps: SetupDependencies;
}): Promise<SetupReport> => {
  const config = {
    ...validateCompleteConfig(input.config),
    upstreamCommit: UPSTREAM_COMMIT,
  };
  const paths =
    input.deps.agentDir !== undefined
      ? resolvePstackPaths(input.deps.agentDir)
      : activePstackPaths();
  const runner = input.deps.runner ?? bunConfigRunner(paths.agentDir);

  // Phase A: validate everything before any write.
  const validated = validateConfigModels(config, input.deps.models);
  const agents = generateAgentFiles(config);
  const modelRoles = buildSemanticModelRoles(config);

  // Phase B: generated agents (atomic; refuses ownership conflicts).
  const previousConfigRaw = await readConfigRaw(paths.configPath);
  const previousRoles = Object.fromEntries(
    Object.entries(await readModelRoles(runner)).filter(([key]) =>
      key.startsWith("pstack-"),
    ),
  );
  const previousSettings = new Map<string, unknown>();
  for (const key of [...Object.keys(TASK_SETTINGS), "task.maxRecursionDepth"]) {
    previousSettings.set(key, await readConfigValue(runner, key));
  }
  const apply = await applyGeneratedAgents(paths, agents);
  const changedSettings: string[] = [];
  let configWritten = false;

  try {
    // Phase C: pstack-* modelRoles (preserving merge).
    const merged = await mergeModelRoles(runner, modelRoles);
    for (const [key, value] of Object.entries(TASK_SETTINGS)) {
      if (previousSettings.get(key) === value) continue;
      changedSettings.push(key);
      await writeConfigValue(runner, key, value);
    }
    const depth = previousSettings.get("task.maxRecursionDepth");
    if (typeof depth !== "number" || (depth !== -1 && depth < 2)) {
      changedSettings.push("task.maxRecursionDepth");
      await writeConfigValue(runner, "task.maxRecursionDepth", 2);
    }

    // Phase D: config.yml with the computed setup checksum.
    const finalConfig: PstackConfig = {
      ...config,
      setupChecksum: computeSetupChecksum(config),
    };
    await writeConfigAtomically(paths.configPath, stringifyConfig(finalConfig));
    configWritten = true;

    // Post-write verification: fail closed, then roll back on any mismatch.
    await verifySetupState(paths, finalConfig, agents);
    const savedRoles = await readModelRoles(runner);
    if (
      Object.entries(modelRoles).some(
        ([key, value]) => savedRoles[key] !== value,
      )
    ) {
      throw new PstackError("PSTACK_IO", "OMP model roles did not persist");
    }

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
    const rollbackErrors: unknown[] = [];
    const restore = async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (failure) {
        rollbackErrors.push(failure);
      }
    };
    if (configWritten)
      await restore(() => restoreConfig(paths.configPath, previousConfigRaw));
    for (const key of changedSettings.reverse())
      await restore(() =>
        writeConfigValue(runner, key, previousSettings.get(key)),
      );
    await restore(() => restoreModelRoles(runner, previousRoles));
    await restore(() => apply.rollback());
    if (rollbackErrors.length)
      throw new PstackError(
        "PSTACK_IO",
        `setup failed and rollback needs attention: ${rollbackErrors.map(String).join("; ")}`,
        { cause: error },
      );
    if (error instanceof PstackError) throw error;
    throw new PstackError("PSTACK_IO", `setup failed: ${String(error)}`, {
      cause: error,
    });
  }
};

/** Serialize setup across local OMP sessions; OS ownership releases on process exit. */
export const configurePstack = async (input: {
  config: PstackConfig;
  deps: SetupDependencies;
}): Promise<SetupReport> => {
  const paths = input.deps.agentDir
    ? resolvePstackPaths(input.deps.agentDir)
    : activePstackPaths();
  await mkdir(dirname(paths.configPath), { recursive: true });
  const lockPath = join(
    await realpath(dirname(paths.configPath)),
    basename(paths.configPath),
  );
  return withFileLock(lockPath, () => configureUnlocked(input), {
    retries: 300,
    retryDelayMs: 100,
  });
};
