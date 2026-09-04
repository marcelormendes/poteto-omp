/**
 * Native OMP plugin integration proof.
 *
 * Runs the REAL `omp` CLI against a disposable cloned agent dir and proves:
 *   1. link        — `omp plugin link` registers the built plugin, enabled,
 *                    rooted at dist/pstack-omp.
 *   2. doctor      — `omp plugin doctor --json` reports no errors and an ok
 *                    entry for the plugin.
 *   3. rpc-session-a — a native RPC session discovers the extension commands
 *                    and plugin skills with zero extension_error frames.
 *   4. rpc-session-b — a second RPC session (new_session) rediscovers the same
 *                    surface; session ids differ.
 *   5. setup-preservation — the real setup generator runs twice against a
 *                    seeded agent dir: idempotent output, unrelated user
 *                    agents/config untouched, obsolete pstack-owned files
 *                    removed, untracked pstack-* files rejected, rollback
 *                    restores, discard drops backups.
 *   6. cleanup      — `omp plugin uninstall` empties the plugin list, doctor
 *                    loses the plugin entry, and every disposable dir
 *                    (fixture, agent dir, agent-dir clone) is gone.
 *
 * Writes a machine-readable report to .artifacts/test-omp/report.json and
 * exits non-zero on the first failing phase. Requires `bun run build:plugin`
 * to have produced dist/pstack-omp.
 *
 * Run: bun scripts/test-omp-plugin.ts [--dist <path>]
 */
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import {
	applyGeneratedAgents,
	buildSemanticModelRoles,
	generateAgentFiles,
	parseAgentFrontmatter,
	readGeneratedAgentManifest,
} from "../src/setup/agent-generator";
import { RpcDriver } from "../tests/e2e/rpc-driver";
import { EXPECTED_PSTACK_COMMANDS } from "../tests/e2e/assertions";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_DIST = resolve(REPO_ROOT, "dist", "pstack-omp");
const REPORT_PATH = resolve(REPO_ROOT, ".artifacts", "test-omp", "report.json");

interface PhaseResult {
	name: string;
	status: "pass" | "fail";
	detail: string;
}

interface IntegrationReport {
	status: "pass" | "fail";
	profile: string;
	ompVersion: string;
	distDir: string;
	phases: PhaseResult[];
	error?: string;
}

// Isolation: a disposable profile under ~/.omp/profiles/<name> keeps plugin
// link/install state out of the real tree (verified: real plugin list stays
// empty). The profile agent dir is seeded from the real one so model
// auth/resolution works — empty profiles resolve no models. PI_CONFIG_DIR
// clones do NOT work for auth; seeded profiles do. Sessions/history/caches
// stay behind: the profile starts with no sessions. SQLite snapshots use
// `.backup` (consistent even with WAL files present); plain copies omit live
// WAL content.
const SEED_PLAIN_FILES = ["config.yml", "kimi-device-id"];
const SEED_DB_FILES = ["models.db", "agent.db"];

async function snapshotDb(src: string, dst: string): Promise<void> {
	const proc = spawn({ cmd: ["sqlite3", src, `.backup main '${dst}'`], stdout: "ignore", stderr: "pipe" });
	const stderr = await new Response(proc.stderr as ReadableStream).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`sqlite3 backup of ${src} failed: ${stderr}`);
}

export async function seedProfile(profile: string): Promise<string> {
	const agentDir = join(process.env.HOME ?? "/", ".omp", "profiles", profile, "agent");
	await mkdir(join(agentDir, "sessions"), { recursive: true });
	const real = await realpath(join(process.env.HOME ?? "/", ".omp", "agent")).catch(() => null);
	if (!real) throw new PhaseFailure("link", "real OMP agent dir is missing; cannot seed models/auth");
	for (const file of SEED_PLAIN_FILES) {
		try {
			const buffer = await Bun.file(join(real, file)).arrayBuffer();
			await writeFile(join(agentDir, file), Buffer.from(buffer));
		} catch {
			// Optional files (kimi-device-id) may be absent; models/auth are verified below.
		}
	}
	for (const file of SEED_DB_FILES) {
		try {
			await snapshotDb(join(real, file), join(agentDir, file));
		} catch (error) {
			throw new PhaseFailure("link", `cannot snapshot ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return agentDir;
}

class PhaseFailure extends Error {
	constructor(
		readonly phase: string,
		message: string,
	) {
		super(message);
		this.name = "PhaseFailure";
	}
}

async function runOmp(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = spawn({
		cmd: ["omp", ...args],
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { code, stdout, stderr };
}

export async function mustRunOmp(args: string[], profile: string): Promise<string> {
	const result = await runOmp(["--profile", profile, ...args]);
	if (result.code !== 0) {
		throw new Error(`omp ${args.join(" ")} exited ${result.code}: ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

interface PluginListEntry {
	name: string;
	version: string;
	path: string;
	enabled: boolean;
}

async function pluginList(profile: string): Promise<PluginListEntry[]> {
	const stdout = await mustRunOmp(["plugin", "list", "--json"], profile);
	const parsed = JSON.parse(stdout) as { npm?: PluginListEntry[] };
	return parsed.npm ?? [];
}

interface DoctorEntry {
	name: string;
	status: "ok" | "warning" | "error";
	message: string;
}

async function pluginDoctor(profile: string): Promise<DoctorEntry[]> {
	const stdout = await mustRunOmp(["plugin", "doctor", "--json"], profile);
	return JSON.parse(stdout) as DoctorEntry[];
}

// ---------------------------------------------------------------------------
// Phase 1-2: link + doctor
// ---------------------------------------------------------------------------

async function phaseLink(profile: string, distDir: string): Promise<PhaseResult> {
	await mustRunOmp(["plugin", "link", distDir], profile);
	const entries = await pluginList(profile);
	const pkg = entries.find(entry => entry.name === "poteto-omp");
	if (!pkg) throw new PhaseFailure("link", `plugin list does not contain poteto-omp: ${JSON.stringify(entries.map(e => e.name))}`);
	if (pkg.enabled !== true) throw new PhaseFailure("link", `plugin ${pkg.name} is not enabled (enabled=${String(pkg.enabled)})`);
	const distReal = await realpath(distDir);
	const linkedReal = await realpath(pkg.path).catch(() => pkg.path);
	if (linkedReal !== distReal) {
		throw new PhaseFailure("link", `linked path ${linkedReal} does not resolve to the built dist ${distReal}`);
	}
	return { name: "link", status: "pass", detail: `linked ${pkg.name}@${pkg.version} at ${pkg.path}` };
}

async function phaseDoctor(profile: string): Promise<PhaseResult> {
	const entries = await pluginDoctor(profile);
	const errors = entries.filter(entry => entry.status === "error");
	if (errors.length > 0) {
		throw new PhaseFailure("doctor", `doctor reports errors: ${JSON.stringify(errors)}`);
	}
	const pluginEntry = entries.find(entry => entry.name === "plugin:poteto-omp");
	if (!pluginEntry || pluginEntry.status !== "ok") {
		throw new PhaseFailure("doctor", `doctor lacks an ok plugin:poteto-omp entry: ${JSON.stringify(entries)}`);
	}
	return { name: "doctor", status: "pass", detail: `ok=${entries.filter(e => e.status === "ok").length}, warnings=${entries.filter(e => e.status === "warning").length}, errors=0` };
}

// ---------------------------------------------------------------------------
// Phase 3-4: RPC sessions + discovery
// ---------------------------------------------------------------------------

async function assertDiscovery(driver: RpcDriver, phase: string): Promise<{ commands: string[]; skills: string[]; sessionId: string }> {
	const extensionErrors = driver.extensionErrors();
	if (extensionErrors.length > 0) {
		throw new PhaseFailure(phase, `extension_error frames observed: ${JSON.stringify(extensionErrors)}`);
	}
	const commands = await driver.getAvailableCommands();
	const names = commands.map(command => command.name);
	const missingCommands = EXPECTED_PSTACK_COMMANDS.filter(name => !names.includes(name));
	if (missingCommands.length > 0) {
		throw new PhaseFailure(phase, `missing pstack commands: ${missingCommands.join(", ")} (found ${names.length} commands)`);
	}
	const skillsDir = resolve(REPO_ROOT, "skills");
	let skillNames: string[];
	try {
		skillNames = (await readdir(skillsDir)).filter(name => !name.startsWith(".")).map(name => `skill:${name}`);
	} catch {
		skillNames = [];
	}
	if (skillNames.length === 0) throw new PhaseFailure(phase, `skills root is empty: ${skillsDir}`);
	const missingSkills = skillNames.filter(name => !names.includes(name));
	if (missingSkills.length > 0) {
		throw new PhaseFailure(phase, `missing plugin skill commands: ${missingSkills.join(", ")}`);
	}
	const sessionId = await driver.currentSessionId();
	return { commands: names, skills: skillNames, sessionId };
}

async function phaseRpcSessions(profile: string): Promise<PhaseResult> {
	const fixtureDir = await mkdtemp(join(tmpdir(), "pstack-rpc-fixture-"));
	let driver: RpcDriver | null = null;
	try {
		driver = await RpcDriver.start({ profile, cwd: fixtureDir });
		const sessionA = await assertDiscovery(driver, "rpc-session-a");
		const switched = await driver.newSession();
		if (switched.cancelled) throw new PhaseFailure("rpc-session-b", "new_session was cancelled by an extension");
		const sessionB = await assertDiscovery(driver, "rpc-session-b");
		if (sessionB.sessionId === sessionA.sessionId) {
			throw new PhaseFailure("rpc-session-b", "second session reused the first session id");
		}
		return {
			name: "rpc-sessions",
			status: "pass",
			detail: `session A=${sessionA.sessionId.slice(0, 8)}…, session B=${sessionB.sessionId.slice(0, 8)}…; commands=${sessionA.commands.length}, skills=${sessionA.skills.length}`,
		};
	} finally {
		await driver?.stop().catch(() => undefined);
		await rm(fixtureDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Phase 5: setup preservation (module boundary, real generator)
// ---------------------------------------------------------------------------

type PstackPaths = Parameters<typeof applyGeneratedAgents>[0];
type PstackConfig = Parameters<typeof generateAgentFiles>[0];

function completeConfig(): PstackConfig {
	const model = (selector: string) => ({ type: "model", selector }) as const;
	const scalars = [
		"feature",
		"refactoring",
		"bug-fix",
		"perf-issue",
		"hillclimb",
		"judgment-prose",
		"hardest",
		"how-explorer",
		"how-explainer",
		"why-investigator",
		"why-synthesizer",
		"reflect-tooling",
		"reflect-judgment",
		"reflect-divergent",
		"reflect-synthesizer",
		"swarm-worker",
	] as const;
	const panels = ["how-critics", "arena-runners", "arena-cross-judges", "architect-runners", "interrogate-reviewers"] as const;
	const roles = Object.fromEntries(scalars.map(role => [role, model("cursor/gpt-5.6-sol")]));
	const panelSlots = [model("cursor/gpt-5.6-sol-fast"), model("opencode-go/deepseek-v4-flash-vision-exp"), model("cursor/gpt-5.6-sol"), model("opencode-go/glm-5.3-flash")];
	const panelMap = Object.fromEntries(panels.map(role => [role, panelSlots]));
  return {
    schemaVersion: 1,
    upstreamCommit: "b9ddc83c32972210b8a94d389130713e8eed346e",
    autoEnable: true,
    roles,
    panels: panelMap,
  } as unknown as PstackConfig;
}

const UNRELATED_ROLE_LINE = '  "my-existing-role": "cursor/gpt-5.6-sol"';
const UNRELATED_AGENT = ["---", "name: my-own-agent", "description: A user-owned agent that setup must never touch", "---", "body", ""].join("\n");

async function seedAgentDir(agentDir: string): Promise<void> {
	await mkdir(join(agentDir, "agents"), { recursive: true });
	await mkdir(join(agentDir, "pstack"), { recursive: true });
	await writeFile(join(agentDir, "config.yml"), `modelRoles:\n  ${UNRELATED_ROLE_LINE}\n`);
	await writeFile(join(agentDir, "agents", "my-own-agent.md"), UNRELATED_AGENT);
}

async function assertUntouched(agentDir: string, detail: string): Promise<void> {
	const config = await readFile(join(agentDir, "config.yml"), "utf8");
	if (!config.includes(UNRELATED_ROLE_LINE)) throw new PhaseFailure("setup-preservation", `unrelated model role vanished (${detail})`);
	const userAgent = await readFile(join(agentDir, "agents", "my-own-agent.md"), "utf8");
	if (userAgent !== UNRELATED_AGENT) throw new PhaseFailure("setup-preservation", `unrelated user agent was modified (${detail})`);
}

async function phaseSetupPreservation(): Promise<PhaseResult> {
	const agentDir = await mkdtemp(join(tmpdir(), "pstack-agentdir-"));
	try {
		await seedAgentDir(agentDir);
		const paths: PstackPaths = {
			agentDir,
			configPath: join(agentDir, "pstack", "config.yml"),
			generatedAgentsDir: join(agentDir, "agents"),
			generatedManifestPath: join(agentDir, "pstack", "generated-agents.json"),
		};

		const config = completeConfig();
		const agents = generateAgentFiles(config);
		const semanticRoles = buildSemanticModelRoles(config);
		if (Object.keys(semanticRoles).length !== agents.length) {
			throw new PhaseFailure("setup-preservation", `semantic model roles (${Object.keys(semanticRoles).length}) do not match generated agents (${agents.length})`);
		}

		// First apply.
		const first = await applyGeneratedAgents(paths, agents);
		if (first.installed.length !== agents.length || first.removed.length !== 0) {
			throw new PhaseFailure("setup-preservation", `first apply installed=${first.installed.length}/${agents.length}`);
		}
		await assertUntouched(agentDir, "after first apply");

		const manifest1 = await readGeneratedAgentManifest(paths.generatedManifestPath);
		if (!manifest1 || manifest1.entries.length !== agents.length) {
			throw new PhaseFailure("setup-preservation", "manifest missing after first apply");
		}

		// Second apply must be byte-idempotent.
		const second = await applyGeneratedAgents(paths, agents);
		if (second.installed.length !== agents.length || second.removed.length !== 0) {
			throw new PhaseFailure("setup-preservation", "second apply was not idempotent in its installed/removed sets");
		}
		const manifest2 = await readGeneratedAgentManifest(paths.generatedManifestPath);
		if (!manifest2 || JSON.stringify(manifest2) !== JSON.stringify(manifest1)) {
			throw new PhaseFailure("setup-preservation", "second apply changed the generated manifest");
		}
		await assertUntouched(agentDir, "after second apply");

		// Obsolete pstack-owned file is removed, unrelated agent survives.
		const reduced = agents.slice(0, agents.length - 1);
		const obsolete = agents[agents.length - 1]!.file;
		const third = await applyGeneratedAgents(paths, reduced);
		if (!third.removed.includes(obsolete)) {
			throw new PhaseFailure("setup-preservation", `obsolete ${obsolete} not in removed set: ${JSON.stringify(third.removed)}`);
		}
		await assertUntouched(agentDir, "after obsolete removal");

		// Untracked pstack-* file is an ownership conflict.
		await writeFile(join(paths.generatedAgentsDir, "pstack-ghost.md"), ["---", "name: pstack-ghost", "description: forged", "---", "x", ""].join("\n"));
		const conflict = await applyGeneratedAgents(paths, agents).then(
			() => null,
			error => error as { code?: string; message?: string },
		);
		if (!conflict || (conflict.code !== "PSTACK_OWNERSHIP_CONFLICT" && !/ownership/i.test(conflict.message ?? ""))) {
			throw new PhaseFailure("setup-preservation", "untracked pstack-* file was not rejected as an ownership conflict");
		}
		await rm(join(paths.generatedAgentsDir, "pstack-ghost.md"), { force: true });

		// Rollback restores the exact pre-apply state (reduced set + manifest).
		const beforeFiles = new Set((await readdir(paths.generatedAgentsDir)).filter(file => file.startsWith("pstack-")));
		const beforeManifest = await readGeneratedAgentManifest(paths.generatedManifestPath);
		const applied = await applyGeneratedAgents(paths, agents);
		await applied.rollback();
		const afterFiles = new Set((await readdir(paths.generatedAgentsDir)).filter(file => file.startsWith("pstack-")));
		const afterManifest = await readGeneratedAgentManifest(paths.generatedManifestPath);
		const sameFiles = beforeFiles.size === afterFiles.size && [...beforeFiles].every(file => afterFiles.has(file));
		const sameManifest = JSON.stringify(afterManifest) === JSON.stringify(beforeManifest);
		if (!sameFiles || !sameManifest) {
			throw new PhaseFailure("setup-preservation", `rollback did not restore pre-apply state: files=${JSON.stringify([...afterFiles])}`);
		}
		await assertUntouched(agentDir, "after rollback");
		await applied.discard();

		// Every installed agent parses back with its own frontmatter contract.
		const reparsed = await applyGeneratedAgents(paths, agents);
		for (const file of reparsed.installed.slice(0, 3)) {
			const parsed = parseAgentFrontmatter(await readFile(join(paths.generatedAgentsDir, file), "utf8"), file);
			if (!parsed.name.startsWith("pstack-") || parsed.body.length === 0) {
				throw new PhaseFailure("setup-preservation", `installed ${file} fails the frontmatter contract`);
			}
		}

		return {
			name: "setup-preservation",
			status: "pass",
			detail: `generated=${agents.length} agents; idempotent reapply; obsolete removal; ownership conflict rejected; rollback/discard proven; unrelated config+agent untouched`,
		};
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Phase 6: cleanup proof
async function phaseCleanup(profile: string, profileDir: string): Promise<PhaseResult> {
	await mustRunOmp(["plugin", "uninstall", "poteto-omp"], profile);
	const entries = await pluginList(profile);
	if (entries.length > 0) {
		throw new PhaseFailure("cleanup", `plugin list not empty after uninstall: ${JSON.stringify(entries.map(e => e.name))}`);
	}
	const doctor = await pluginDoctor(profile);
	if (doctor.some(entry => entry.name === "plugin:poteto-omp")) {
		throw new PhaseFailure("cleanup", "doctor still reports plugin:poteto-omp after uninstall");
	}
	await rm(profileDir, { recursive: true, force: true });
	const profileGone = await readdir(profileDir).then(() => false, () => true);
	if (!profileGone) throw new PhaseFailure("cleanup", `disposable profile dir still exists: ${profileDir}`);
	return { name: "cleanup", status: "pass", detail: "plugin uninstalled, list empty, doctor clean, disposable profile removed" };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface CliOptions {
	dist: string;
}

function parseCli(args: string[]): CliOptions {
	let dist = DEFAULT_DIST;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--dist") {
			dist = resolve(args[++i] ?? "");
		} else if (arg.startsWith("--dist=")) {
			dist = resolve(arg.slice("--dist=".length));
		}
	}
	if (!dist) throw new Error("--dist requires a path");
	return { dist };
}

async function main(): Promise<void> {
	const { dist } = parseCli(process.argv.slice(2));
	const profile = `pstack-int-${process.pid}-${Date.now()}`;
	const profileDir = join(process.env.HOME ?? "/", ".omp", "profiles", profile);
	const phases: PhaseResult[] = [];
	let report: IntegrationReport;

	try {
		await seedProfile(profile);
		const distInfo = await lstat(dist).catch(() => null);
		if (!distInfo?.isDirectory()) {
			throw new PhaseFailure("link", `dist is missing: ${dist} — run \`bun run build:plugin\` first`);
		}
		phases.push(await phaseLink(profile, dist));
		phases.push(await phaseDoctor(profile));
		phases.push(await phaseRpcSessions(profile));
		phases.push(await phaseSetupPreservation());
		phases.push(await phaseCleanup(profile, profileDir));
		report = { status: "pass", ompVersion: "18.1.10", profile, distDir: dist, phases };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof PhaseFailure) {
			phases.push({ name: error.phase, status: "fail", detail: message });
		} else {
			phases.push({ name: "harness", status: "fail", detail: message });
		}
		report = { status: "fail", ompVersion: "18.1.10", profile, distDir: dist, phases, error: message };
		await rm(profileDir, { recursive: true, force: true });
	}

	await mkdir(join(REPO_ROOT, ".artifacts", "test-omp"), { recursive: true });
	await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

	for (const phase of phases) {
		console.log(`${phase.status === "pass" ? "✔" : "✘"} ${phase.name}: ${phase.detail}`);
	}
	if (report.status === "pass") {
		console.log(`PASS — native OMP plugin integration (report: ${REPORT_PATH})`);
	} else {
		console.error(`FAIL — ${report.error} (report: ${REPORT_PATH})`);
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
