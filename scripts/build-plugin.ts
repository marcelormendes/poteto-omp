/**
 * Deterministic OMP plugin assembly.
 *
 * Assembles `dist/pstack-omp/` from the repository's live package inputs:
 *   - package.json (native `omp` manifest: extensions / skills / agents)
 *   - extension/**  (extension sources, byte-copied)
 *   - skills/**     (skill trees, byte-copied)
 *   - agents/**     (role agents, byte-copied)
 *   - LICENSE, README.md
 *
 * The build fails closed when:
 *   - a declared manifest target is missing or empty,
 *   - a forbidden Cursor/PI construct appears anywhere in the shipped content,
 *   - the package manifest is malformed.
 *
 * Output is deterministic: the assembled file set plus
 * `build-manifest.json` (counts, per-file sha256, forbidden-scan record) are
 * byte-stable across runs — no timestamps, no unordered lists.
 *
 * Run: bun scripts/build-plugin.ts
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, cp } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export interface ForbiddenPattern {
	label: string;
	/** Regex applied per line (or to whole text for string scans). */
	pattern: RegExp;
	/** When true, the match must be the only token on its line and is exempt when the line carries an explicit negation marker. */
	negatable?: boolean;
}

export interface ForbiddenViolation {
	path: string;
	pattern: string;
	line: number;
	text: string;
}

export interface BuildCounts {
	extensions: number;
	skills: number;
	agents: number;
	files: number;
}

export interface BuildFileEntry {
	path: string;
	size: number;
	sha256: string;
}

export interface BuildReport {
	outDir: string;
	packageName: string;
	packageVersion: string;
	counts: BuildCounts;
	files: BuildFileEntry[];
	forbiddenViolations: ForbiddenViolation[];
	manifestPath: string;
}

// ---------------------------------------------------------------------------
// Forbidden constructs
// ---------------------------------------------------------------------------

/**
 * Cursor-only and PI-only runtime constructs that must never ship in an OMP
 * plugin. Scans only shipped content (extension/, skills/, agents/,
 * package.json) — historical/provenance discussion lives in planning/ and
 * docs/, which are not part of the artifact.
 */
export const FORBIDDEN_STRING_PATTERNS: ReadonlyArray<{ label: string; needle: string }> = [
	{ label: "cursor-subagent_type", needle: "subagent_type" },
	{ label: "cursor-run_in_background", needle: "run_in_background" },
	{ label: "cursor-cloud_base_branch", needle: "cloud_base_branch" },
	{ label: "cursor-generalPurpose", needle: "generalPurpose" },
	{ label: "cursor-home-path", needle: "~/.cursor" },
	{ label: "cursor-skills-path", needle: ".cursor/skills" },
	{ label: "cursor-automations-path", needle: ".cursor/automations" },
	{ label: "cursor-transcripts-path", needle: "agent-transcripts" },
	{ label: "cursor-todowrite", needle: "TodoWrite" },
	{ label: "cursor-team-kit", needle: "cursor-team-kit" },
	{ label: "cursor-slug-grok", needle: "grok-4.6" },
	{ label: "cursor-slug-claude-fable", needle: "claude-fable" },
	{ label: "cursor-slug-claude-opus", needle: "claude-opus" },
	{ label: "pi-extension", needle: "pi-subagents" },
	{ label: "pi-home-path", needle: "~/.pi" },
	{ label: "pi-agent-path", needle: ".pi/agent" },
	{ label: "pi-skills-path", needle: ".pi/skills" },
	{ label: "pi-install", needle: "pi install" },
  { label: "nonexistent-todo-tool", needle: "pstack_todo" },
  { label: "nonexistent-memory-tool", needle: "pstack_memory" },
];

export const FORBIDDEN_REGEX_PATTERNS: ReadonlyArray<ForbiddenPattern> = [
	{
		label: "cursor-cloud-environment",
		// `environment: cloud` (Cursor cloud worker field), any quoting.
		pattern: /environment:\s*["']?cloud["']?\s*$/m,
	},
	{
		label: "cursor-automate-trigger",
		// Cursor `/automate` trigger. `/automate-me` (an official pstack skill
		// entry point) is explicitly allowed by the negative lookahead.
		pattern: /\/automate(?!-)\b/,
	},
	{
		label: "cursor-askquestion",
		// Cursor-only AskQuestion tool; a line that documents its absence is allowed.
		pattern: /\bAskQuestion\b/,
		negatable: true,
	},
	{
		label: "cursor-pi-cli-print",
		// PI non-interactive invocation; OMP uses `omp`.
		pattern: /\bpi\s+(?:-p\b|--[a-z])/,
	},
];

/** Bare Cursor model slugs that must be provider-qualified on OMP (cursor/…, opencode-go/…, …). */
const BARE_MODEL_SLUG = /(^|[^/\w-])(gpt-5\.6-(?:sol|sol-fast|luna|luna-fast|terra|terra-fast))(?![\w-])/g;

function scrubProviderQualified(source: string): string {
	return source.replace(/[A-Za-z0-9_.-]+\/gpt-5\.6-(?:sol|sol-fast|luna|luna-fast|terra|terra-fast)/g, "");
}

// ---------------------------------------------------------------------------
// Input inventory
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
	return stat(path)
		.then(() => true)
		.catch(() => false);
}

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", ".artifacts"].includes(entry.name)) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
			} else if (entry.isFile()) {
				files.push(path);
			}
		}
	};
	await walk(root);
	return files.sort();
}

interface Manifest {
	name: string;
	version: string;
	type: string;
	description: string;
	license: string;
	keywords: string[];
	dependencies: Record<string, string>;
	omp: { extensions: string[]; skills: string[]; agents: string[] };
}

async function readManifest(root: string): Promise<Manifest> {
	const raw = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
		name?: unknown;
		version?: unknown;
		type?: unknown;
		description?: unknown;
		license?: unknown;
		keywords?: unknown;
		dependencies?: unknown;
		omp?: { extensions?: unknown; skills?: unknown; agents?: unknown };
	};
	const omp = raw.omp;
	if (!omp || typeof omp !== "object") {
		throw new Error("package.json must declare an `omp` manifest");
	}
	const list = (value: unknown, key: string): string[] => {
		if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string")) {
			throw new Error(`package.json omp.${key} must be a non-empty string array`);
		}
		return value as string[];
	};
	if (typeof raw.name !== "string" || typeof raw.version !== "string") {
		throw new Error("package.json must declare name and version");
	}
  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" ? value : fallback;
  return {
    name: raw.name,
    version: raw.version,
    type: str(raw.type, "module"),
    description: str(raw.description, ""),
    license: str(raw.license, ""),
		keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((item): item is string => typeof item === "string") : [],
		dependencies: (raw.dependencies ?? {}) as Record<string, string>,
		omp: {
			extensions: list(omp.extensions, "extensions"),
			skills: list(omp.skills, "skills"),
			agents: list(omp.agents, "agents"),
		},
	};
}

// ---------------------------------------------------------------------------
// Forbidden scan
// ---------------------------------------------------------------------------

export function scanForbidden(files: ReadonlyArray<{ path: string; text: string }>): ForbiddenViolation[] {
	const violations: ForbiddenViolation[] = [];
	for (const file of files) {
		const lines = file.text.split("\n");
		for (const { label, needle } of FORBIDDEN_STRING_PATTERNS) {
			if (file.text.includes(needle)) {
				const lineIndex = lines.findIndex(line => line.includes(needle));
				violations.push({
					path: file.path,
					pattern: label,
					line: lineIndex + 1,
					text: lines[lineIndex]?.trim() ?? "",
				});
			}
		}
		for (const { label, pattern, negatable } of FORBIDDEN_REGEX_PATTERNS) {
			lines.forEach((line, index) => {
				if (negatable && /no (AskQuestion|AskQuestion tool)/i.test(line)) return;
				if (pattern.test(line)) {
					violations.push({ path: file.path, pattern: label, line: index + 1, text: line.trim() });
				}
				pattern.lastIndex = 0;
			});
		}
		const scrubbed = scrubProviderQualified(file.text);
		for (const match of scrubbed.matchAll(BARE_MODEL_SLUG)) {
			const slug = match[2];
			if (!slug) continue;
			const lineIndex = lines.findIndex(line => line.includes(slug));
			violations.push({
				path: file.path,
				pattern: "cursor-slug-bare-model",
				line: lineIndex + 1,
				text: lines[lineIndex]?.trim() ?? "",
			});
		}
		BARE_MODEL_SLUG.lastIndex = 0;
	}
	return violations;
}

async function collectScanFiles(root: string, scanRoots: string[], extraFiles: string[]): Promise<Array<{ path: string; text: string }>> {
	const collected: Array<{ path: string; text: string }> = [];
	for (const scanRoot of scanRoots) {
		if (!(await exists(scanRoot))) continue;
		for (const file of await listFiles(scanRoot)) {
			if (!/\.(ts|js|mjs|md|sh)$/.test(file)) continue;
			collected.push({ path: relative(root, file), text: await readFile(file, "utf8") });
		}
	}
	for (const file of extraFiles) {
		if (await exists(file)) {
			collected.push({ path: relative(root, file), text: await readFile(file, "utf8") });
		}
	}
	return collected;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

async function sha256(file: string): Promise<string> {
	return createHash("sha256").update(await readFile(file)).digest("hex");
}

export interface BuildOptions {
	/** Output dir; defaults to <repo>/dist/pstack-omp. */
	outDir?: string;
	/** Repo root; defaults to the parent of scripts/. */
	sourceRoot?: string;
}

export async function buildPlugin(options: BuildOptions = {}): Promise<BuildReport> {
	const root = resolve(options.sourceRoot ?? join(import.meta.dir, ".."));
	const outDir = resolve(options.outDir ?? join(root, "dist", "pstack-omp"));
	const manifest = await readManifest(root);

	const extensionRoot = resolve(root, dirname(manifest.omp.extensions[0]!));
	// Manifest entries are directories relative to root (e.g. ./extension).
	const skillRoot = resolve(root, manifest.omp.skills[0] ?? "");
	const agentRoot = resolve(root, manifest.omp.agents[0] ?? "");

	// Fail closed on missing/empty declared inputs.
	for (const [label, dir] of [
		["extensions", extensionRoot],
		["skills", skillRoot],
		["agents", agentRoot],
	] as const) {
		if (!(await exists(dir))) throw new Error(`Cannot build: declared omp.${label} root is missing (${dir})`);
		if ((await listFiles(dir)).length === 0) throw new Error(`Cannot build: declared omp.${label} root is empty (${dir})`);
	}
	const licensePath = join(root, "LICENSE");
	if (!(await exists(licensePath))) throw new Error("Cannot build: LICENSE is missing from the package root");

	// Forbidden scan over shipped inputs, before any copy.
	const scanFiles = await collectScanFiles(
		root,
		[extensionRoot, skillRoot, agentRoot, join(root, "src", "setup"), join(root, "src", "core"), join(root, "src", "transcripts")],
		[join(root, "package.json")],
	);
	const forbiddenViolations = scanForbidden(scanFiles);
	if (forbiddenViolations.length > 0) {
		throw new Error(
			`Forbidden constructs found in shipped content:\n${forbiddenViolations
				.map(v => `  ${v.path}:${v.line} [${v.pattern}] ${v.text}`)
				.join("\n")}`,
		);
	}

	// Assemble into a fresh temp sibling, then swap atomically.
	const staging = join(outDir, "..", `.pstack-build-${process.pid}`);
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });

	const copyRoots: Array<[string, string]> = [
		[extensionRoot, "extension"],
		[skillRoot, "skills"],
		[agentRoot, "agents"],
		// Extension entry imports shared setup/core modules; ship them
		// alongside so dist-relative imports resolve in the installed copy.
		[join(root, "src", "setup"), "setup"],
		[join(root, "src", "core"), "core"],
		[join(root, "src", "transcripts"), "transcripts"],
	];
	try {
		for (const [source, target] of copyRoots) {
			await cp(source, join(staging, target), { recursive: true, filter: path => !path.split(/[\\/]/).some(part => ["node_modules", ".git", ".artifacts"].includes(part)) });
		}
		await cp(licensePath, join(staging, "LICENSE"));
		const readmePath = join(root, "README.md");
		if (await exists(readmePath)) await cp(readmePath, join(staging, "README.md"));

	// Deterministic plugin package.json (fixed key order, no scripts/devDeps).
	// Copy roots land under dist/extension, dist/skills, dist/agents, so the
	// shipped omp manifest is remapped to the dist layout.
	const distOmp = {
		extensions: manifest.omp.extensions.map(entry => `./extension/${entry.split("/").pop()}`),
		skills: manifest.omp.skills,
		agents: manifest.omp.agents,
	};
	const distPackage = {
		name: manifest.name,
		version: manifest.version,
		private: true,
		type: manifest.type,
		description: manifest.description,
		license: manifest.license,
		keywords: manifest.keywords,
		dependencies: manifest.dependencies,
		omp: distOmp,
	};
		await writeFile(join(staging, "package.json"), `${JSON.stringify(distPackage, null, 2)}\n`);

		// Inventory + deterministic manifest.
		const stagedFiles = (await listFiles(staging)).filter(file => relative(staging, file) !== "build-manifest.json");
		const entries = await Promise.all(
			stagedFiles.map(async file => ({
				path: relative(staging, file),
				size: (await stat(file)).size,
				sha256: await sha256(file),
			})),
		);
		entries.sort((a, b) => a.path.localeCompare(b.path));

		const counts: BuildCounts = {
			extensions: entries.filter(entry => entry.path.startsWith("extension/")).length,
			skills: entries.filter(entry => entry.path.startsWith("skills/") && entry.path.endsWith("/SKILL.md")).length,
			agents: entries.filter(entry => entry.path.startsWith("agents/") && entry.path.endsWith(".md")).length,
			files: entries.length,
		};

		const buildManifest = {
			packageName: manifest.name,
			packageVersion: manifest.version,
			counts,
			files: entries,
			forbiddenScan: {
				patterns: FORBIDDEN_STRING_PATTERNS.length + FORBIDDEN_REGEX_PATTERNS.length + 1,
				violations: 0,
			},
		};
		await writeFile(join(staging, "build-manifest.json"), `${JSON.stringify(buildManifest, null, 2)}\n`);

		// Atomic swap: replace outDir only after a complete staging build.
		await rm(outDir, { recursive: true, force: true });
		await mkdir(join(outDir, ".."), { recursive: true });
		await rename(staging, outDir);

		return {
			outDir,
			packageName: manifest.name,
			packageVersion: manifest.version,
			counts,
			files: entries,
			forbiddenViolations,
			manifestPath: join(outDir, "build-manifest.json"),
		};
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

async function main(): Promise<void> {
	const report = await buildPlugin();
	console.log(
		`built ${report.packageName}@${report.packageVersion} -> ${report.outDir} (extensions=${report.counts.extensions}, skills=${report.counts.skills}, agents=${report.counts.agents}, files=${report.counts.files})`,
	);
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
