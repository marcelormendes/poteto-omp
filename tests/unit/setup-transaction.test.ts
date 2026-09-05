import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configurePstack } from "../../src/setup/service";
import { parsePstackConfig } from "../../src/setup/schema";
import { parseModelSelector, type ModelFacade } from "../../src/setup/catalog";
import { buildSemanticModelRoles } from "../../src/setup/agent-generator";
import type { ConfigRunner } from "../../src/setup/omp-config";
import { resolvePstackPaths } from "../../src/core/paths";

const config = parsePstackConfig(
  await readFile(new URL("../e2e/models.yml", import.meta.url), "utf8"),
);
const available = Object.values(buildSemanticModelRoles(config)).map(
  (selector) => {
    const p = parseModelSelector(selector)!;
    return { provider: p.provider, id: p.modelId };
  },
);
const models: ModelFacade = {
  list: () => available,
  resolve: (selector) => {
    const p = parseModelSelector(selector);
    return available.find(
      (m) => m.provider === p?.provider && m.id === p.modelId,
    );
  },
  family: (model) => model.id.split("-")[0],
};
function settingsRunner() {
  const values: Record<string, unknown> = {
    modelRoles: { default: "user/model", "pstack-old": "user/old" },
    "task.batch": false,
    "task.isolation.enabled": false,
    "task.isolation.apply": true,
    "task.maxRecursionDepth": 0,
  };
  const runner: ConfigRunner = {
    async run(args) {
      const [, action, key, value] = args;
      if (action === "set") values[key] = JSON.parse(value);
      if (action === "reset") delete values[key];
      return {
        exitCode: 0,
        stdout: JSON.stringify({ value: values[key] }),
        stderr: "",
      };
    },
  };
  return { values, runner };
}

test("failed setup restores roles, task settings, agents, and config", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pstack-transaction-"));
  try {
    const { values, runner } = settingsRunner();
    const original = structuredClone(values);
    let injected = false;
    const failing: ConfigRunner = {
      async run(args) {
        if (
          !injected &&
          args[1] === "set" &&
          args[2] === "task.isolation.enabled"
        ) {
          injected = true;
          return { exitCode: 1, stdout: "", stderr: "injected disk failure" };
        }
        return runner.run(args);
      },
    };
    await expect(
      configurePstack({ config, deps: { models, runner: failing, agentDir } }),
    ).rejects.toThrow("injected disk failure");
    expect(values).toEqual(original);
    const paths = resolvePstackPaths(agentDir);
    expect(await Bun.file(paths.configPath).exists()).toBe(false);
    expect(await Bun.file(paths.generatedManifestPath).exists()).toBe(false);
    expect(
      await Bun.file(
        join(paths.generatedAgentsDir, "pstack-feature.md"),
      ).exists(),
    ).toBe(false);
    // The failure also released the transaction lock: a fresh setup succeeds.
    const result = await configurePstack({
      config: { ...config, upstreamCommit: "old-upstream" },
      deps: { models, runner, agentDir },
    });
    expect(result.agents).toHaveLength(36);
    expect(
      parsePstackConfig(await readFile(paths.configPath, "utf8"))
        .upstreamCommit,
    ).toBe(config.upstreamCommit);
    expect((values.modelRoles as Record<string, string>).default).toBe(
      "user/model",
    );
    expect(values["task.isolation.apply"]).toBe(false);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("concurrent setups cannot read a partially applied transaction", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pstack-lock-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const first = settingsRunner();
    let blocked = false;
    const runner: ConfigRunner = {
      async run(args) {
        if (!blocked && args[1] === "set") {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        return first.runner.run(args);
      },
    };
    const one = configurePstack({ config, deps: { models, runner, agentDir } });
    await entered.promise;
    let secondReads = 0;
    const second: ConfigRunner = {
      async run(args) {
        secondReads++;
        return first.runner.run(args);
      },
    };
    const two = configurePstack({
      config,
      deps: { models, runner: second, agentDir },
    });
    await Bun.sleep(30);
    expect(secondReads).toBe(0);
    release.resolve();
    await Promise.all([one, two]);
    expect(secondReads).toBeGreaterThan(0);
  } finally {
    release.resolve();
    await rm(agentDir, { recursive: true, force: true });
  }
});
