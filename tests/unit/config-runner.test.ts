import {parse} from "yaml";
import {expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import {basename, join} from "node:path";
import {tmpdir} from "node:os";
import {bunConfigRunner, writeConfigValue} from "../../src/setup/omp-config";
test("config runner honors an explicit directory even when its path contains profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pstack-config-path-"));
  const profile = basename(root);
  const agentDir = join(root, "profiles", profile, "agent");
  try {
    await mkdir(agentDir, {recursive: true});
    const runner = bunConfigRunner(agentDir);
    const path = await runner.run(["config", "path"]);
    expect(path.exitCode).toBe(0);
    expect(path.stdout.trim()).toBe(agentDir);
    await writeConfigValue(runner, "task.batch", false);
    expect(parse(await readFile(join(agentDir, "config.yml"), "utf8")).task.batch).toBe(false);
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(join(process.env.HOME!, ".omp/profiles", profile), {recursive: true, force: true});
  }
});
