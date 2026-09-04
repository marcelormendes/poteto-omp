/**
 * Live-OMP acceptance pilot: runs bounded natural-language scenarios against
 * the REAL `omp` CLI in a separate process with REAL models.
 *
 * Per scenario: seed disposable profile -> link dist -> /setup-pstack with
 * tests/e2e/models.yml -> run the scenario prompt untouched -> collect
 * evidence (subagent roster, status envelopes, extension errors) -> verdict ->
 * uninstall + remove profile and fixture.
 *
 * The prompt never names its target skill: routing is proven from natural
 * language. Usage:
 *   bun scripts/acceptance.ts [--scenarios how,feature] [--timeout-scale 1] [--dist <path>]
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcDriver } from "../tests/e2e/rpc-driver";
import { scenarioById, SCENARIOS } from "../tests/e2e/scenarios";
import { mustRunOmp, seedProfile } from "./test-omp-plugin";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_DIST = resolve(REPO_ROOT, "dist", "pstack-omp");
const MODELS_YML = resolve(REPO_ROOT, "tests", "e2e", "models.yml");
const REPORT_PATH = resolve(REPO_ROOT, ".artifacts", "acceptance", "report.json");
const ARTIFACTS_DIR = resolve(REPO_ROOT, ".artifacts", "acceptance");

const SETUP_BUDGET_MS = 300_000;

interface ScenarioVerdict {
	id: string;
	status: "pass" | "fail";
	detail: string;
	roster: string[];
}

const FIXTURE_FILES: Record<string, string> = {
	"calc.ts": `export function calcTotal(nums: number[]): number {\n\treturn nums.reduce((a, b) => a + b, 0);\n}\n`,
	"format.ts": `export function format(value: number): string {\n\treturn \`result: \${value}\`;\n}\n`,
	"main.ts": `import { calcTotal } from "./calc";\nimport { format } from "./format";\n\nexport function run(nums: number[]): string {\n\treturn format(calcTotal(nums));\n}\n`,
	"main.test.ts": `import { describe, expect, test } from "bun:test";\nimport { run } from "./main";\n\ndescribe("fixture", () => {\n\ttest("runs the pipeline", () => {\n\t\texpect(run([1, 2, 3])).toBe("result: 6");\n\t});\n});\n`,
};

async function buildFixture(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pstack-acc-fixture-"));
	for (const [name, content] of Object.entries(FIXTURE_FILES)) {
		await writeFile(join(dir, name), content, "utf8");
	}
	return dir;
}

/** Generated agent names the root actually spawned via the task tool. */
function spawnedAgents(messages: unknown[]): string[] {
	const names: string[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const record = value as Record<string, unknown>;
		if (record.type === "toolCall" && record.name === "task") {
			const args = record.arguments as Record<string, unknown> | undefined;
			const tasks = args?.tasks;
			if (Array.isArray(tasks)) {
				for (const item of tasks) {
					const agent = (item as Record<string, unknown> | null)?.agent;
					if (typeof agent === "string") names.push(agent);
				}
			}
			if (typeof args?.agent === "string") names.push(args.agent);
		}
		for (const nested of Object.values(record)) visit(nested);
	};
	visit(messages);
	return [...new Set(names)];
}

/** Hub delivery status plus the methodology marker in a spawned agent's result. */
function agentResult(transcript: string, agent: string): { hub: string | null; marker: string | null } {
	// The RPC text double-encodes quotes (literal backslashes); strip them
	// first so the patterns need no backslash escapes at all.
	const plain = transcript.replace(/\\/g, "");
	const escaped = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const tag = new RegExp(`agent="${escaped}" status="([a-z]+)"`).exec(plain);
	if (!tag) return { hub: null, marker: null };
	const region = plain.slice(tag.index, tag.index + 60000);
	// Primary: an explicit PASS/ISSUES/BLOCKED status token. Fallback: the
	// skill's pass log (`Pass 1 — explainer — ...`), which carries the same
	// per-pass accountability when the model phrases the envelope as prose.
	const marker = /(^|[^A-Z])(PASS|ISSUES|BLOCKED)([^A-Z]|$)/.exec(region)?.[2]
		?? (/pass log/i.test(region) ? "PASSLOG" : null);
	return { hub: tag[1] ?? null, marker };
}

async function runScenario(id: string, dist: string, timeoutScale: number): Promise<ScenarioVerdict> {
	const scenario = scenarioById(id);
	if (!scenario) throw new Error(`unknown scenario: ${id} (known: ${SCENARIOS.map(s => s.id).join(", ")})`);
	const profile = `pstack-acc-${id}-${process.pid}-${Date.now()}`;
	const profileDir = join(process.env.HOME ?? "/", ".omp", "profiles", profile);
	const fixtureDir = await buildFixture();
	let driver: RpcDriver | null = null;
	let transcript: unknown[] = [];
	try {
		await seedProfile(profile);
		await mustRunOmp(["plugin", "link", dist], profile);
		driver = await RpcDriver.start({ profile, cwd: fixtureDir });

		await driver.promptAndWait(`/setup-pstack --file ${MODELS_YML}`, SETUP_BUDGET_MS * timeoutScale);
		if (driver.extensionErrors().length > 0) {
			return { id, status: "fail", detail: `extension_error during setup: ${JSON.stringify(driver.extensionErrors())}`, roster: [] };
		}
		const profileAgentDir = join(process.env.HOME ?? "/", ".omp", "profiles", profile, "agent");
		const setupFiles = await Promise.all(
			["pstack/config.yml", "pstack/generated-agents.json"].map(async file => {
				try {
					await readFile(join(profileAgentDir, file), "utf8");
					return null;
				} catch {
					return file;
				}
			}),
		);
		const setupMissing = setupFiles.filter((file): file is string => file !== null);
		if (setupMissing.length > 0) {
			return { id, status: "fail", detail: `setup wrote no ${setupMissing.join(", ")}; cannot prove routing`, roster: [] };
		}

		const outcome = await driver.promptAndWait(scenario.prompt, scenario.timeoutMs * timeoutScale);
		if (driver.extensionErrors().length > 0) {
			return { id, status: "fail", detail: `extension_error frames observed: ${JSON.stringify(driver.extensionErrors())}`, roster: [] };
		}
		if (scenario.kind === "route" && !outcome.agentInvoked) {
			return { id, status: "fail", detail: "prompt completed without invoking the agent; no routing to prove", roster: [] };
		}

		// Evidence comes from the root transcript: get_subagents does not
		// report task-spawned role agents, but every spawn is a task toolCall
		// with the generated agent name in its arguments, and every result
		// carries a task-result envelope with a PASS/ISSUES/BLOCKED status.
		transcript = (await driver.getMessages()) as unknown[];
		const names = spawnedAgents(transcript);
		const missing = (scenario.expectations.agents ?? []).filter(expected => !names.includes(expected));
		if (missing.length > 0) {
			return { id, status: "fail", detail: `expected agents absent from task spawns: ${missing.join(", ")} (spawned: ${names.join(", ") || "none"})`, roster: names };
		}
		if ((scenario.expectations.requireEnvelope ?? true) && scenario.kind === "route") {
			const text = JSON.stringify(transcript);
			const results = (scenario.expectations.agents ?? []).map(agent => ({ agent, ...agentResult(text, agent) }));
			const bad = results.filter(result => result.hub !== "completed" || result.marker === null);
			if (bad.length > 0) {
				return { id, status: "fail", detail: `spawned agents without a completed+marked result: ${bad.map(result => `${result.agent}(hub=${result.hub ?? "none"},marker=${result.marker ?? "none"})`).join(", ")}`, roster: names };
			}
			const envelopes = results.map(result => `${result.agent}=${result.marker}`).join(", ");
			return { id, status: "pass", detail: `routed ${scenario.expectedRoute}; ${envelopes}`, roster: names };
		}
		return { id, status: "pass", detail: `routed ${scenario.expectedRoute}; spawned=${names.length}`, roster: names };
	} finally {
		await mkdir(ARTIFACTS_DIR, { recursive: true }).catch(() => undefined);
		if (transcript.length > 0) {
			await writeFile(join(ARTIFACTS_DIR, `${id}-transcript.json`), JSON.stringify(transcript)).catch(() => undefined);
		}
		await driver?.stop().catch(() => undefined);
		await mustRunOmp(["plugin", "uninstall", "poteto-omp"], profile).catch(() => undefined);
		await rm(profileDir, { recursive: true, force: true });
		await rm(fixtureDir, { recursive: true, force: true });
	}
}
function parseCli(args: string[]): { scenarios: string[]; timeoutScale: number; dist: string } {
	let scenarios = ["how", "feature"];
	let dist = DEFAULT_DIST;
	let timeoutScale = 1;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--scenarios") scenarios = (args[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean);
		else if (arg.startsWith("--scenarios=")) scenarios = arg.slice("--scenarios=".length).split(",").map(s => s.trim()).filter(Boolean);
		else if (arg === "--timeout-scale") timeoutScale = Number(args[++i] ?? "1");
		else if (arg.startsWith("--timeout-scale=")) timeoutScale = Number(arg.slice("--timeout-scale=".length));
		else if (arg === "--dist") dist = resolve(args[++i] ?? "");
		else if (arg.startsWith("--dist=")) dist = resolve(arg.slice("--dist=".length));
	}
	if (scenarios.length === 0) throw new Error("--scenarios requires at least one id");
	if (!Number.isFinite(timeoutScale) || timeoutScale <= 0) throw new Error("--timeout-scale must be a positive number");
	return { scenarios, timeoutScale, dist };
}

async function main(): Promise<void> {
	const { scenarios, timeoutScale, dist } = parseCli(process.argv.slice(2));
	const verdicts: ScenarioVerdict[] = [];
	for (const id of scenarios) {
		console.log(`--- scenario ${id} (timeout-scale ${timeoutScale})`);
		try {
			const verdict = await runScenario(id, dist, timeoutScale);
			verdicts.push(verdict);
			console.log(`${verdict.status === "pass" ? "✔" : "✘"} ${verdict.id}: ${verdict.detail}`);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			verdicts.push({ id, status: "fail", detail, roster: [] });
			console.log(`✘ ${id}: ${detail}`);
		}
	}
	await mkdir(join(REPO_ROOT, ".artifacts", "acceptance"), { recursive: true });
	await writeFile(REPORT_PATH, `${JSON.stringify({ status: verdicts.every(v => v.status === "pass") ? "pass" : "fail", verdicts }, null, 2)}\n`);
	if (verdicts.every(v => v.status === "pass")) {
		console.log(`PASS — acceptance pilot (report: ${REPORT_PATH})`);
	} else {
		console.error(`FAIL — acceptance pilot (report: ${REPORT_PATH})`);
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
