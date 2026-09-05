import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function command(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}
export const SOURCE = {
  "package.json": JSON.stringify(
    { name: "pstack-fixture", type: "module", scripts: { test: "bun test" } },
    null,
    2,
  ),
  "math.ts":
    "export function total(values: number[]): number { return values.reduce((sum, value) => sum + value, 0); }\nexport function average(values: number[]): number { return total(values) / (values.length + 1); }\n",
  "format.ts":
    "export function format(value: number): string { return `result: ${value}`; }\n",
  "main.ts":
    'import { total } from "./math";\nimport { format } from "./format";\nexport function run(values: number[]): string { return format(total(values)); }\n',
  "cli.ts":
    'import {total} from "./math";\nconst [command, ...args] = process.argv.slice(2);\nif(command === "--version") console.log("1.0.0");\nelse if(command === "sum" && args.every(arg => Number.isFinite(Number(arg)))) console.log(total(args.map(Number)));\nelse { console.error("Usage: bun cli.ts sum [numbers...] | --version"); process.exitCode = 2; }\n',
  "main.test.ts":
    'import {expect,test} from "bun:test";\nimport {run} from "./main";\ntest("pipeline sums inputs",()=>expect(run([1,2,3])).toBe("result: 6"));\ntest("empty input",()=>expect(run([])).toBe("result: 0"));\n',
  "README.md":
    "# Number CLI\n\nRun `bun cli.ts sum 1 2 3` to print `6`, `bun cli.ts sum` to print `0`, or `bun cli.ts --version` to print `1.0.0`. Invalid commands or non-numeric input exit 2. Tests: `bun test`. No network, dependencies, credentials, or server is needed.\n",
  ".gitignore": "node_modules/\n.artifacts/\n",
  "session-notes.md":
    "# Previous task evidence\n\nThe user asked to sum CLI arguments and required live CLI checks before claiming done. The first implementation passed unit tests but crashed on empty CLI input. We reproduced with `bun cli.ts sum`, observed a reduce-without-initial-value error, added initial zero, then ran the real CLI and observed 0. The same user twice asked for concise reports with commands and outputs. No push or publication was requested.\n",
};
export async function fixture(id: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pstack-${id}-`));
  for (const [name, content] of Object.entries(SOURCE))
    await writeFile(join(dir, name), content);
  await command(dir, ["git", "init", "-b", "main"]);
  await command(dir, [
    "git",
    "config",
    "user.email",
    "fixture@example.invalid",
  ]);
  await command(dir, ["git", "config", "user.name", "Pstack fixture"]);
  await command(dir, ["git", "add", "."]);
  const commit = await command(dir, [
    "git",
    "commit",
    "-qm",
    "Implement local number CLI with an empty-input identity",
  ]);
  if (commit.code) throw new Error(commit.stderr);
  await writeFile(
    join(dir, "DECISIONS.md"),
    "# Empty input\n\nThe CLI must return zero for an empty list so callers can stream optional values without branching. The explicit initial accumulator in total preserves that identity.\n",
  );
  await command(dir, ["git", "add", "DECISIONS.md"]);
  await command(dir, [
    "git",
    "commit",
    "-qm",
    "Record why empty lists return zero for streaming callers",
  ]);
  if (id === "interrogate" || id === "blast-radius") {
    await writeFile(
      join(dir, "math.ts"),
      SOURCE["math.ts"].replace("sum + value, 0", "sum + value"),
    );
  }
  if (id === "no-comments")
    await writeFile(
      join(dir, "format.ts"),
      "// Format the value.\n" + SOURCE["format.ts"],
    );
  if (id === "maintain-verification-skill") {
    const skill = join(dir, ".omp/skills/verify-number-cli");
    await mkdir(join(skill, "references"), { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: verify-number-cli\ndescription: Verify the local Number CLI on its real command.\n---\n# Launch\nRun from repo root. Requires Bun; no daemon.\n# Doctor\nRun `bun --version` and `bun cli.ts --version` (1.0.0).\n# Feature map\nSee references/features.md. Capture commands, output and exit status in .artifacts/verification.txt; each invocation is a fresh process.\n# Cleanup\nNo persistent process or data; retain the evidence file.\n",
    );
    await writeFile(
      join(skill, "references/features.md"),
      "# Features\n- Sum: `bun cli.ts sum 1 2 3` prints 6.\n- Empty input: `bun cli.ts sum` prints 99.\n- Version: `bun cli.ts --version` prints 1.0.0.\n- Invalid input: `bun cli.ts sum nope` exits 2.\n",
    );
  }
  return dir;
}
