import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { command } from "../e2e/fixtures";
test("worktree audit preserves paths with spaces and holds untracked work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pstack-worktrees-"));
  try {
    await command(root, ["git", "init", "-b", "main"]);
    await command(root, [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=f@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
    const wt = join(root, "work tree");
    const added = await command(root, [
      "git",
      "worktree",
      "add",
      "-b",
      "topic",
      wt,
    ]);
    expect(added.code).toBe(0);
    await writeFile(join(wt, "precious.txt"), "uncommitted work");
    const audit = await command(root, [
      "bash",
      resolve("skills/poteto-mode/scripts/worktree-audit.sh"),
      root,
    ]);
    expect(audit.code).toBe(0);
    expect(audit.stdout).toContain(`hold-work\t${await realpath(wt)}`);
    expect(await Bun.file(join(wt, "precious.txt")).text()).toBe(
      "uncommitted work",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
