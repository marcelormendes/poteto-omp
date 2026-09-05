// Preserving OMP modelRoles read/merge/write.
//
// modelRoles lives in the OMP agent config (~/.omp/agent/config.yml) and is
// managed through `omp config`. pstack only ever touches keys in its own
// `pstack-*` namespace: unrelated keys (default, provider settings, custom
// roles) are read through and written back untouched. Reads happen
// immediately before writes to minimize stale overwrites.

import { PstackError } from "../core/errors";
import { isRecord } from "../core/guards";

/** Result of one injected command. */
export interface ConfigRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Command runner seam; production uses `omp`, tests inject a double. */
export interface ConfigRunner {
  run(args: string[]): Promise<ConfigRunnerResult>;
}

/** Production runner: spawns the `omp` CLI on PATH. */
export const bunConfigRunner = (agentDir?: string): ConfigRunner => ({
  async run(args: string[]): Promise<ConfigRunnerResult> {
    const proc = Bun.spawn(["omp", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: agentDir
        ? {
            ...process.env,
            OMP_PROFILE: "",
            PI_PROFILE: "",
            PI_CODING_AGENT_DIR: agentDir,
          }
        : process.env,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  },
});

/** Namespace ownership predicate for modelRoles keys. */
export const isPstackModelRoleKey = (key: string): boolean =>
  key.startsWith("pstack-");

/**
 * Read the current modelRoles map. A missing/unset value reads as an empty
 * map; malformed output fails closed.
 */
export const readModelRoles = async (
  runner: ConfigRunner,
): Promise<Record<string, string>> => {
  const result = await runner.run(["config", "get", "modelRoles", "--json"]);
  if (result.exitCode !== 0) {
    throw new PstackError(
      "PSTACK_IO",
      `omp config get modelRoles failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    throw new PstackError(
      "PSTACK_IO",
      `omp config get modelRoles returned invalid JSON: ${String(error)}`,
      {
        cause: error,
      },
    );
  }
  const value = isRecord(payload) ? payload.value : undefined;
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new PstackError(
      "PSTACK_IO",
      "omp config get modelRoles returned a non-record value",
    );
  }
  const roles: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new PstackError("PSTACK_IO", `modelRoles.${key} is not a string`);
    }
    roles[key] = entry;
  }
  return roles;
};

const writeModelRoles = async (
  runner: ConfigRunner,
  roles: Record<string, string>,
): Promise<void> => {
  const result = await runner.run([
    "config",
    "set",
    "modelRoles",
    JSON.stringify(roles),
    "--json",
  ]);
  if (result.exitCode !== 0) {
    throw new PstackError(
      "PSTACK_IO",
      `omp config set modelRoles failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
};

/**
 * Merge a pstack modelRoles update into the live config: reads current roles
 * immediately before writing, replaces only the `pstack-*` subset (obsolete
 * pstack keys removed, new ones added), and preserves every other key
 * byte-for-value. Returns the previous pstack subset (for rollback) and the
 * preserved non-pstack keys (for reporting).
 */
export const mergeModelRoles = async (
  runner: ConfigRunner,
  pstackRoles: Record<string, string>,
): Promise<{ previous: Record<string, string>; preserved: string[] }> => {
  const current = await readModelRoles(runner);
  const previous: Record<string, string> = {};
  const preserved: string[] = [];
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(current)) {
    if (isPstackModelRoleKey(key)) previous[key] = value;
    else {
      merged[key] = value;
      preserved.push(key);
    }
  }
  Object.assign(merged, pstackRoles);
  await writeModelRoles(runner, merged);
  return { previous, preserved };
};

/** Restore the previous pstack subset (rollback). Non-pstack keys are kept. */
export const restoreModelRoles = async (
  runner: ConfigRunner,
  previous: Record<string, string>,
): Promise<void> => {
  const current = await readModelRoles(runner);
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!isPstackModelRoleKey(key)) merged[key] = value;
  }
  Object.assign(merged, previous);
  await writeModelRoles(runner, merged);
};

export const readConfigValue = async (
  runner: ConfigRunner,
  key: string,
): Promise<unknown> => {
  const result = await runner.run(["config", "get", key, "--json"]);
  if (result.exitCode !== 0)
    throw new PstackError(
      "PSTACK_IO",
      `cannot read OMP setting ${key}: ${result.stderr}`,
    );
  const payload: unknown = JSON.parse(result.stdout);
  if (!isRecord(payload))
    throw new PstackError(
      "PSTACK_IO",
      `invalid OMP setting response for ${key}`,
    );
  return payload.value;
};

export const writeConfigValue = async (
  runner: ConfigRunner,
  key: string,
  value: unknown,
): Promise<void> => {
  const args =
    value === undefined
      ? ["config", "reset", key, "--json"]
      : ["config", "set", key, JSON.stringify(value), "--json"];
  const result = await runner.run(args);
  if (result.exitCode !== 0)
    throw new PstackError(
      "PSTACK_IO",
      `cannot write OMP setting ${key}: ${result.stderr}`,
    );
};
