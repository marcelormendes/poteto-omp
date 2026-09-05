/** Exercise an installed tarball outside the checkout, with no repository dependency hoisting. */
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { command, fixture } from "../tests/e2e/fixtures";
import { RpcDriver } from "../tests/e2e/rpc-driver";
import { mustRunOmp, seedProfile } from "./test-omp-plugin";

async function main() {
  const root = resolve(import.meta.dir, "..");
  const scratch = await mkdtemp(join(tmpdir(), "pstack-package-"));
  const profile = `pstack-package-${process.pid}-${Date.now()}`;
  const profileDir = join(process.env.HOME!, ".omp/profiles", profile);
  const installSpec = process.env.PSTACK_TEST_INSTALL_SPEC;
  const reportPath = join(root, installSpec ? ".artifacts/registry/report.json" : ".artifacts/package/report.json");
  let driver: RpcDriver | undefined;
  let cwd: string | undefined;
  const report: Record<string, unknown> = { status: "fail", profile };
  try {
    const archive = join(scratch, "poteto-omp.tgz");
    const packed = await command(
      resolve(process.env.PSTACK_TEST_PLUGIN ?? join(root, "dist/pstack-omp")),
      [
        "bun",
        "pm",
        "pack",
        "--filename",
        archive,
        "--ignore-scripts",
        "--quiet",
      ],
    );
    if (packed.code) throw new Error(packed.stderr);
    report.sha256 = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    const agentDir = await seedProfile(profile);
    const plugins = join(profileDir, "plugins");
    await mkdir(plugins, { recursive: true });
    await writeFile(
      join(plugins, "package.json"),
      JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }),
    );
    // OMP 18.1.10's install command accepts registry names only. Install the
    // local tarball into its standard package store through Bun, then let OMP
    // discover and validate it exactly like a registry package.
    if (installSpec) {
      await mustRunOmp(["plugin", "install", installSpec, "--json"], profile);
      report.installSpec = installSpec;
    } else {
      const installed = await command(plugins, ["bun", "add", archive]);
      if (installed.code) throw new Error(installed.stderr);
    }
    const installedPath = await realpath(
      join(plugins, "node_modules/poteto-omp"),
    );
    if (installedPath.startsWith(root + "/"))
      throw new Error("package resolved back into the checkout");
    const helperDir = join(installedPath, "skills/poteto-mode/scripts");
    for (const helper of ["orch/orch.ts", "watch-pr/watch-pr"]) {
      const result = await command(scratch, [
        "bun",
        join(helperDir, helper),
        "--help",
      ]);
      if (result.code || !result.stdout.includes("Usage:"))
        throw new Error(
          `${helper}: installed helper failed to start: ${result.stderr}`,
        );
      if (
        await Bun.file(
          join(helperDir, "node_modules/.poteto-mode-tools-install-key"),
        ).exists()
      )
        throw new Error(
          `${helper}: helper installed nested dependencies at invocation time`,
        );
    }
    report.helpers = ["orch --help", "watch-pr --help"];
    const listed = JSON.parse(
      await mustRunOmp(["plugin", "list", "--json"], profile),
    );
    if (!JSON.stringify(listed).includes("poteto-omp"))
      throw new Error("OMP did not discover the installed package");
    const doctor = JSON.parse(
      await mustRunOmp(["plugin", "doctor", "--json"], profile),
    );
    report.doctor = doctor;
    cwd = await fixture("packed-plugin");
    driver = await RpcDriver.start({
      profile,
      cwd,
      extraArgs: ["--no-lsp", "--no-title"],
    });
    const commands = await driver.getAvailableCommands();
    const skills = commands.filter(
      (c) => c.name.startsWith("skill:") && !c.name.includes("verify-number"),
    );
    if (skills.length !== 45)
      throw new Error(`expected 45 skills, found ${skills.length}`);
    await driver.promptAndWait(
      `/setup-pstack --file ${join(root, "tests/e2e/models.yml")}`,
      120000,
    );
    await driver.promptAndWait("/pstack-status", 60000);
    const notices = driver.frames.filter(
      (f) => f.type === "extension_ui_request" && f.method === "notify",
    );
    if (
      driver.extensionErrors().length ||
      notices.some((f) => f.notifyType === "error")
    )
      throw new Error(`extension errors: ${JSON.stringify(notices)}`);
    if (
      !notices.some((f) => String(f.message).includes("Pstack status: clean"))
    )
      throw new Error("package setup status is not clean");
    report.status = "pass";
    report.skills = skills.length;
    report.notices = notices;
    console.log(
      "PASS packed install: 45 skills, setup, clean status, and no checkout dependency resolution",
    );
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    await driver?.stop();
    await mkdir(join(root, installSpec ? ".artifacts/registry" : ".artifacts/package"), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    await rm(profileDir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
    if (cwd) await rm(cwd, { recursive: true, force: true });
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
