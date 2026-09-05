/** Exercise every interactive setup selection, cancellation, and sticky mode restoration. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { RpcDriver } from "../tests/e2e/rpc-driver";
import { fixture } from "../tests/e2e/fixtures";
import { mustRunOmp, seedProfile } from "./test-omp-plugin";

async function main() {
  const root = resolve(import.meta.dir, "..");
  const profile = `pstack-ui-${process.pid}-${Date.now()}`;
  const profileDir = join(process.env.HOME!, ".omp/profiles", profile);
  const agentDir = await seedProfile(profile);
  const cwd = await fixture("setup-ui");
  const report: Record<string, unknown> = { status: "fail", selections: [] };
  let driver: RpcDriver | undefined;
  const selections: string[] = [];
  let cancelled = false;
  try {
    await mustRunOmp(
      [
        "plugin",
        "link",
        resolve(
          process.env.PSTACK_TEST_PLUGIN ?? join(root, "dist/pstack-omp"),
        ),
      ],
      profile,
    );
    driver = await RpcDriver.start({
      profile,
      cwd,
      extraArgs: ["--no-lsp", "--no-title"],
      onUIRequest(frame) {
        if (frame.method !== "select") return { cancelled: true };
        if (cancelled) return { cancelled: true };
        const value =
          selections.length % 2 === 0
            ? "opencode-go/glm-5.3-flash"
            : "openai-codex/gpt-5.6-sol";
        if (!Array.isArray(frame.options) || !frame.options.includes(value))
          throw new Error(`Missing selectable model ${value}`);
        selections.push(value);
        return { value };
      },
    });
    await driver.promptAndWait("/setup-pstack", 120000);
    if (selections.length !== 36)
      throw new Error(
        `Expected 36 interactive role choices, got ${selections.length}`,
      );
    await driver.promptAndWait("/pstack-status", 60000);
    const notices = () =>
      driver!.frames.filter(
        (frame) =>
          frame.type === "extension_ui_request" && frame.method === "notify",
      );
    if (
      driver.extensionErrors().length ||
      notices().some((frame) => frame.notifyType === "error")
    )
      throw new Error(JSON.stringify(notices()));
    if (
      !notices().some((frame) =>
        String(frame.message).includes("Pstack status: clean"),
      )
    )
      throw new Error("Interactive setup did not produce clean status");
    const path = join(agentDir, "pstack/config.yml");
    const before = await readFile(path, "utf8");
    const saved = parse(before);
    if (!saved.upstreamCommit || !saved.setupChecksum)
      throw new Error("Interactive setup omitted provenance/checksum");
    cancelled = true;
    await driver.promptAndWait("/setup-pstack", 60000);
    if ((await readFile(path, "utf8")) !== before)
      throw new Error("Cancelled setup changed the configuration");
    await driver.promptAndWait("/poteto-mode off", 60000);
    const original = await driver.getState();
    await driver.newSession();
    const switched = await driver.send({
      type: "switch_session",
      sessionPath: original.sessionFile,
    });
    if (!switched.success) throw new Error(`Resume failed: ${switched.error}`);
    await driver.promptAndWait("/poteto-mode status", 60000);
    if (
      !String(notices().at(-1)?.message).includes("off (source: session-off)")
    )
      throw new Error("Explicit off did not survive resume");
    await driver.promptAndWait("/poteto-mode on", 60000);
    await driver.promptAndWait("/poteto-mode status", 60000);
    if (!String(notices().at(-1)?.message).includes("on (source: session-on)"))
      throw new Error("Explicit on did not apply");
    report.status = "pass";
    report.selections = selections;
    report.notices = notices();
    console.log(
      "PASS setup UI: 36 model selections, clean status, cancellation preservation, mode off/resume/on",
    );
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    await driver?.stop();
    await mkdir(join(root, ".artifacts/setup-ui"), { recursive: true });
    await writeFile(
      join(root, ".artifacts/setup-ui/report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    await rm(profileDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
