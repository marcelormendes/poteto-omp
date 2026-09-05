import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import {
  parsePstackConfig,
  computeSetupChecksum,
  stringifyConfig,
} from "../../src/setup/schema";
import {
  applyGeneratedAgents,
  buildSemanticModelRoles,
  generateAgentFiles,
} from "../../src/setup/agent-generator";
import { inspectPstackStatus } from "../../src/extension/status";
import { TASK_SETTINGS } from "../../src/extension/capabilities";
import { resolvePstackPaths } from "../../src/core/paths";

test("doctor detects model alias drift even when agent files and setup checksum are intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pstack-doctor-"));
  try {
    const paths = resolvePstackPaths(root);
    const parsed = parsePstackConfig(
      await readFile(new URL("../e2e/models.yml", import.meta.url), "utf8"),
    );
    const config = { ...parsed, setupChecksum: computeSetupChecksum(parsed) };
    await (
      await applyGeneratedAgents(paths, generateAgentFiles(config))
    ).discard();
    await writeFile(paths.configPath, stringifyConfig(config));
    const roles = buildSemanticModelRoles(config);
    await writeFile(join(root, "config.yml"), stringify({ modelRoles: roles }));
    const deps = {
      getTaskValue: (key: string) =>
        ({
          ...TASK_SETTINGS,
          "task.maxConcurrency": 2,
          "task.maxRecursionDepth": 2,
        })[key as keyof typeof TASK_SETTINGS],
      probe: async () => ({ present: true }),
    };
    const mode = {
      enabled: true,
      source: "auto" as const,
      routerLoaded: false,
    };
    expect((await inspectPstackStatus(paths, mode, deps)).ok).toBe(true);
    const old = { ...config, upstreamCommit: "old-upstream" };
    await writeFile(
      paths.configPath,
      stringifyConfig({ ...old, setupChecksum: computeSetupChecksum(old) }),
    );
    expect(
      (await inspectPstackStatus(paths, mode, deps)).agentDrift,
    ).toContainEqual(
      expect.objectContaining({
        kind: "stale",
        detail: expect.stringContaining("upstream revision"),
      }),
    );
    await writeFile(paths.configPath, stringifyConfig(config));
    await writeFile(
      join(root, "config.yml"),
      stringify({ modelRoles: { ...roles, "pstack-feature": "other/model" } }),
    );
    const status = await inspectPstackStatus(paths, mode, deps);
    expect(status.ok).toBe(false);
    expect(status.agentDrift).toMatchObject([
      { kind: "model-role", detail: expect.stringContaining("pstack-feature") },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
