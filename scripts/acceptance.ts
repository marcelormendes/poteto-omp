import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { RpcDriver } from "../tests/e2e/rpc-driver";
import { mustRunOmp, seedProfile } from "./test-omp-plugin";
import { command, fixture, SOURCE } from "../tests/e2e/fixtures";
import {
  extraSkillCases,
  skillCases,
  type SkillCase,
} from "../tests/e2e/skill-cases";
import {
  assertModelExecution,
  compactEvidence,
  skillLoaded,
  childEvidence,
  modelCalls,
  type ChildEvidence,
} from "../tests/e2e/live-evidence";
import { parsePstackConfig } from "../src/setup/schema";
import { buildSemanticModelRoles } from "../src/setup/agent-generator";
import { parseModelSelector } from "../src/setup/catalog";
import {
  verifyArenaArtifacts,
  verifyTddOrder,
} from "../tests/e2e/artifact-checks";

const ROOT = resolve(import.meta.dir, "..");
const ARTIFACTS =
  process.env.PSTACK_TEST_ARTIFACTS ?? join(ROOT, ".artifacts/acceptance");
const DIST = resolve(
  process.env.PSTACK_TEST_PLUGIN ?? join(ROOT, "dist/pstack-omp"),
);
const ROOT_MODEL = process.env.PSTACK_TEST_MODEL ?? "openai-codex/gpt-5.6-sol";
const BOUNDARY =
  "This is a disposable local acceptance fixture. Complete the requested task using the invoked skill and configured roles. Model calls and local fixture changes requested by the task are authorized. No push, PR, external messages, remote services, other-project history, or edits outside this fixture and isolated child/artifact directories. Do not install packages or change profile settings. No human is available; the task supplies the requirements. Collect every spawned job before the final answer. Do not claim model execution from configuration alone.";
const MODELS =
  process.env.PSTACK_TEST_MODELS ?? join(ROOT, "tests/e2e/models.yml");
const expectedRoles = buildSemanticModelRoles(
  parsePstackConfig(await readFile(MODELS, "utf8")),
);
interface Verdict {
  id: string;
  status: "pass" | "fail";
  detail: string;
  models: string[];
  children: ChildEvidence[];
  fixture: string;
  durationMs: number;
}
const report: {
  status: string;
  profile: string;
  ompVersion: string;
  setup?: unknown;
  verdicts: Verdict[];
} = {
  status: "running",
  profile: `pstack-e2e-${process.pid}-${Date.now()}`,
  ompVersion: "",
  verdicts: [],
};
const profileDir = join(process.env.HOME!, ".omp/profiles", report.profile);
const agentDir = join(profileDir, "agent");
async function save() {
  await mkdir(ARTIFACTS, { recursive: true });
  await writeFile(
    join(ARTIFACTS, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
function start(cwd: string) {
  return RpcDriver.start({
    profile: report.profile,
    cwd,
    extraArgs: [
      "--model",
      ROOT_MODEL,
      "--thinking",
      "low",
      "--no-lsp",
      "--no-title",
      "--no-rules",
      "--max-time",
      "12m",
      "--append-system-prompt",
      BOUNDARY,
    ],
  });
}
function notifications(driver: RpcDriver) {
  return driver.frames.filter(
    (f) => f.type === "extension_ui_request" && f.method === "notify",
  );
}
function checkErrors(driver: RpcDriver) {
  const errors = [
    ...driver.extensionErrors(),
    ...notifications(driver).filter((f) => f.notifyType === "error"),
  ];
  if (errors.length)
    throw new Error(`OMP extension failure: ${JSON.stringify(errors)}`);
}
async function snapshot(cwd: string) {
  const files = Object.fromEntries(
    await Promise.all(
      Object.keys(SOURCE).map(async (file) => [
        file,
        await readFile(join(cwd, file), "utf8").catch(() => null),
      ]),
    ),
  );
  const diff = await command(cwd, ["git", "diff", "--binary", "HEAD"]);
  const untracked = await command(cwd, [
    "git",
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  if (diff.code || untracked.code)
    throw new Error("Cannot inspect fixture changes");
  return {
    files,
    diff: diff.stdout,
    untracked: untracked.stdout.split("\n").sort(),
  };
}

async function runCase(spec: SkillCase, cwd?: string): Promise<Verdict> {
  cwd ??= await fixture(spec.id);
  if (spec.seedHistory) {
    const history = join(agentDir, "sessions", `acceptance-history-${spec.id}`);
    await mkdir(history, { recursive: true });
    for (let i = 1; i <= 6; i++) {
      const id = `synthetic-history-${i}`;
      const timestamp = new Date(Date.now() - i * 3600000).toISOString();
      const records = [
        { type: "session", id, cwd, timestamp, version: 3 },
        {
          type: "message",
          id: `${id}-user`,
          timestamp,
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: `Synthetic acceptance history ${i}. Verify the Number CLI sum and empty-input behavior locally, keep the report concise, and do not publish.`,
              },
            ],
          },
        },
        {
          type: "message",
          id: `${id}-result`,
          timestamp,
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Synthetic acceptance record, not a live execution receipt: iteration ${i} observed sum output 6 and empty output 0. Chose the initial accumulator identity. Next: verify invalid input exits 2.`,
              },
            ],
          },
        },
      ];
      await writeFile(
        join(history, `${id}.jsonl`),
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
    }
  }
  const began = Date.now();
  const before = await snapshot(cwd);
  const driver = await start(cwd);
  let messages: unknown[] = [];
  let children: ChildEvidence[] = [];
  let models: string[] = [];
  const verdict: Verdict = {
    id: spec.id,
    status: "fail",
    detail: "not completed",
    models,
    children,
    fixture: cwd,
    durationMs: 0,
  };
  console.log(`RUN ${spec.id} (${cwd})`);
  try {
    const skill = spec.skill ?? spec.id;
    const text = spec.directPrompt
      ? spec.prompt
      : spec.id === "poteto-mode"
        ? `/poteto-mode ${spec.prompt}`
        : `/skill:${skill} ${spec.prompt}`;
    const result = await driver.promptAndWait(
      text,
      Number(process.env.PSTACK_TEST_TIMEOUT_MS ?? 600000),
    );
    if (!result.agentInvoked)
      throw new Error("skill command did not invoke a model");
    messages = await driver.getMessages();
    checkErrors(driver);
    if (!skillLoaded(messages, skill))
      throw new Error("OMP did not load the requested skill");
    const final = messages
      .filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          message.role === "assistant",
      )
      .at(-1);
    if (
      !Array.isArray(final?.content) ||
      !final.content.some((part) => part.type === "text" && part.text?.trim())
    )
      throw new Error("No final assistant result");
    const calls = modelCalls(messages);
    assertModelExecution(calls, spec.id, ROOT_MODEL);
    models = [...new Set(calls.map((c) => `${c.provider}/${c.model}`))];
    verdict.models = models;
    const state = await driver.getState();
    const sessionFile =
      typeof state.sessionFile === "string" ? state.sessionFile : undefined;
    if (!sessionFile) throw new Error("OMP state has no sessionFile");
    children = await childEvidence(messages, sessionFile);
    verdict.children = children;
    for (const child of children) {
      if (!child.status.startsWith("completed"))
        throw new Error(`${child.agent}/${child.id}: ${child.status}`);
      const selector = expectedRoles[child.agent];
      const parsed = selector ? parseModelSelector(selector) : null;
      assertModelExecution(
        child.models,
        child.agent,
        parsed ? `${parsed.provider}/${parsed.modelId}` : ROOT_MODEL,
      );
    }
    for (const [agent, count] of Object.entries(spec.agents ?? {})) {
      if (children.filter((c) => c.agent === agent).length < count)
        throw new Error(`expected ${count} completed ${agent} workers`);
    }
    if (
      spec.id === "arena" &&
      !children.some((c) => c.agent.startsWith("pstack-arena-cross-judges-"))
    )
      throw new Error("no cross-judge ran");
    if (
      spec.readOnly &&
      JSON.stringify(before) !== JSON.stringify(await snapshot(cwd))
    )
      throw new Error("read-only skill changed fixture source");
    if (spec.id === "arena") {
      const proof = await verifyArenaArtifacts(cwd, children);
      await mkdir(join(ARTIFACTS, spec.id), { recursive: true });
      await writeFile(
        join(ARTIFACTS, spec.id, "patch-replay.json"),
        JSON.stringify(proof, null, 2),
      );
    }
    if (
      spec.artifact &&
      !(await readFile(join(cwd, spec.artifact), "utf8")).trim()
    )
      throw new Error(`empty artifact ${spec.artifact}`);
    if (["poteto-mode", "tdd", "no-comments"].includes(spec.id)) {
      const test = await command(cwd, ["bun", "test"]);
      if (test.code)
        throw new Error(`fixture regression suite failed: ${test.stderr}`);
    }
    if (spec.id === "poteto-mode") {
      const check = await command(cwd, [
        "bun",
        "-e",
        'import {summarize} from "./main"; if(JSON.stringify(summarize([2,4]))!==JSON.stringify({count:2,sum:6,average:3}) || summarize([]).average!==0) process.exit(1);',
      ]);
      if (check.code)
        throw new Error(`summarize contract failed: ${check.stderr}`);
    }
    if (spec.id === "tdd") {
      verifyTddOrder(messages);
      const check = await command(cwd, [
        "bun",
        "-e",
        'import {average} from "./math"; if(average([])!==0 || average([4])!==4) process.exit(1);',
      ]);
      if (check.code) throw new Error("average regression remains");
    }
    if (spec.id === "figure-it-out") {
      const check = await command(cwd, ["bun", "audit-check.ts"]);
      if (check.code)
        throw new Error(`readiness audit script failed: ${check.stderr}`);
    }
    if (
      ["figure-it-out", "show-me-your-work"].includes(spec.id) &&
      !children.some(
        (child) =>
          child.agent === "pstack-judgment-prose" ||
          child.agent.startsWith("pstack-arena-cross-judges-"),
      )
    )
      throw new Error("decision trail has no completed judgment worker");
    if (
      spec.id === "loop" &&
      (await readFile(join(cwd, "count.txt"), "utf8")).trim() !== "6\n6"
    )
      throw new Error("loop did not produce exactly two verified outputs");
    if (
      spec.id === "maintain-verification-skill" &&
      (await readFile(join(cwd, spec.artifact!), "utf8")).includes("prints 99")
    )
      throw new Error("verification drift remains");
    verdict.status = "pass";
    verdict.detail = `${calls.length} parent responses; ${children.length} completed workers; artifact checks passed`;
  } catch (error) {
    verdict.detail = String(error);
  } finally {
    if (messages.length === 0)
      messages = await driver.getMessages().catch(() => []);
    await mkdir(join(ARTIFACTS, spec.id), { recursive: true });
    await writeFile(
      join(ARTIFACTS, spec.id, "messages.json"),
      JSON.stringify(compactEvidence(messages)),
    );
    const events = driver.frames.filter(
      (frame) =>
        frame.type !== "response" &&
        !["message_update", "tool_execution_update"].includes(
          String(frame.type),
        ),
    );
    await writeFile(
      join(ARTIFACTS, spec.id, "events.json"),
      JSON.stringify(compactEvidence(events)),
    );
    await driver.stop();
    verdict.durationMs = Date.now() - began;
    report.verdicts.push(verdict);
    await save();
    console.log(
      `${verdict.status.toUpperCase()} ${spec.id}: ${verdict.detail}`,
    );
  }
  return verdict;
}
async function setup() {
  await seedProfile(report.profile);
  // Seed auth/catalog only; test a first-time plugin setup without inherited pstack roles or global extensions.
  const config = {
    modelRoles: {
      default: ROOT_MODEL,
      task: "opencode-go/glm-5.3-flash:low",
      smol: "opencode-go/glm-5.3-flash:low",
      preserved: "opencode-go/glm-5.3-flash:low",
    },
    "task.maxConcurrency": 4,
    "async.maxJobs": 12,
    "dev.autoqa": false,
    "dev.autoqaConsent": "denied",
  };
  await writeFile(join(agentDir, "config.yml"), stringify(config));
  await mustRunOmp(["plugin", "link", DIST], report.profile);
  report.ompVersion = (await mustRunOmp(["--version"], report.profile)).trim();
  const cwd = await fixture("setup");
  const driver = await start(cwd);
  try {
    const commands = await driver.getAvailableCommands();
    const names = (await readdir(join(ROOT, "skills"))).map(
      (name) => `skill:${name}`,
    );
    if (names.some((name) => !commands.some((c) => c.name === name)))
      throw new Error("not every skill was discovered");
    await driver.promptAndWait(`/setup-pstack --file ${MODELS}`, 120000);
    checkErrors(driver);
    await driver.promptAndWait("/pstack-status", 60000);
    checkErrors(driver);
    if (
      !notifications(driver).some((f) =>
        String(f.message).includes("Pstack status: clean"),
      )
    )
      throw new Error("setup doctor is not clean");
    const saved = parse(await readFile(join(agentDir, "config.yml"), "utf8"));
    if (saved.modelRoles?.preserved !== config.modelRoles.preserved)
      throw new Error("setup modified an unrelated model role");
    report.setup = {
      status: "pass",
      skills: names.length,
      notifications: notifications(driver),
      fixture: cwd,
    };
    console.log(
      `PASS setup: discovered ${names.length} skills and verified persisted roles + clean doctor`,
    );
  } finally {
    await driver.stop();
  }
  await save();
}
async function main() {
  const concurrency = Number(process.env.PSTACK_TEST_CONCURRENCY ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("PSTACK_TEST_CONCURRENCY must be an integer from 1 to 8");
  const args = process.argv.slice(2);
  const selected =
    args.find((a) => a.startsWith("--scenarios="))?.split("=")[1] ??
    (args.includes("--scenarios")
      ? args[args.indexOf("--scenarios") + 1]
      : undefined);
  const all = [...(await skillCases()), ...extraSkillCases];
  const ids = selected?.split(",");
  if (ids?.some((id) => !all.some((c) => c.id === id)))
    throw new Error("Unknown skill scenario");
  const cases = ids ? ids.map((id) => all.find((c) => c.id === id)!) : all;
  await setup();
  const chain = cases.find((c) => c.id === "create-verification-skill");
  let remaining = cases;
  if (chain) {
    const created = await runCase(chain);
    if (created.status === "pass") {
      await runCase(
        {
          id: "verify-number-cli",
          prompt:
            "Run every mapped CLI feature now. Record actual output and exit status in .artifacts/verification.txt. No source changes or publication.",
          artifact: ".artifacts/verification.txt",
        },
        created.fixture,
      );
      const poteto = cases.find((c) => c.id === "poteto-mode");
      if (poteto) await runCase(poteto, created.fixture);
    }
    remaining = cases.filter(
      (c) =>
        c !== chain && !(created.status === "pass" && c.id === "poteto-mode"),
    );
  }
  const queue = [...remaining];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const next = queue.shift();
        if (next) await runCase(next);
      }
    }),
  );
  report.status = report.verdicts.every((v) => v.status === "pass")
    ? "pass"
    : "fail";
  await save();
  console.log(
    `${report.status.toUpperCase()}: ${report.verdicts.filter((v) => v.status === "pass").length}/${report.verdicts.length} live scenarios. ${ARTIFACTS}/report.json`,
  );
  if (report.status !== "pass") process.exitCode = 1;
}
if (import.meta.main)
  main()
    .catch(async (error) => {
      report.status = "fail";
      await save();
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      // Preserve transcripts and fixtures, but remove the copied credential databases.
      for (const name of ["agent.db", "models.db"]) {
        for (const suffix of ["", "-wal", "-shm"])
          await rm(join(agentDir, name + suffix), { force: true });
      }
    });
