import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGeneratedAgents,
  generateAgentFiles,
  readGeneratedAgentManifest,
} from "../../src/setup/agent-generator";
import { resolvePstackPaths } from "../../src/core/paths";
import { parsePstackConfig } from "../../src/setup/schema";

const config = parsePstackConfig(
  await readFile(new URL("../e2e/models.yml", import.meta.url), "utf8"),
);

describe("generated agent ownership", () => {
  test("rejects a manifest path outside its agent namespace before touching files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pstack-manifest-"));
    try {
      const paths = resolvePstackPaths(dir);
      await mkdir(join(dir, "pstack"));
      await writeFile(
        paths.generatedManifestPath,
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            {
              file: "../config.yml",
              sha256: "a".repeat(64),
              semanticRole: "feature",
              toolProfile: "writing",
              modelRole: null,
            },
          ],
        }),
      );
      await expect(
        readGeneratedAgentManifest(paths.generatedManifestPath),
      ).rejects.toThrow("invalid manifest");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves user edits to obsolete panel seats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pstack-obsolete-"));
    try {
      const paths = resolvePstackPaths(dir);
      const agents = generateAgentFiles(config);
      await (await applyGeneratedAgents(paths, agents)).discard();
      const obsolete = agents.at(-1)!;
      const edited = obsolete.content + "\nMy own instructions.\n";
      await writeFile(join(paths.generatedAgentsDir, obsolete.file), edited);
      await expect(
        applyGeneratedAgents(paths, agents.slice(0, -1)),
      ).rejects.toThrow("modified");
      expect(
        await readFile(join(paths.generatedAgentsDir, obsolete.file), "utf8"),
      ).toBe(edited);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
