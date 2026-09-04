/**
 * Reproducibility verification: rebuild the plugin into a fresh temporary
 * directory and byte-compare it against the checked-in `dist/pstack-omp`.
 *
 * Exits 0 only when the rebuilt tree is byte-identical to the shipped dist
 * (content, relative layout, and file modes). Any difference — including a
 * stale dist after source changes — is a hard failure with the first
 * divergences printed.
 *
 * Run: bun scripts/verify-generated.ts
 */
import { mkdtemp, readdir, readFile, lstat, rm, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildPlugin, type BuildReport } from "./build-plugin";

const DIST_DIR = resolve(import.meta.dir, "..", "dist", "pstack-omp");
const MAX_REPORTED_DIFFS = 50;

export interface TreeDiff {
	path: string;
	kind: "missing" | "extra" | "content" | "mode" | "symlink";
	detail: string;
}

export interface ReproducibilityReport {
	ok: boolean;
	distDir: string;
	rebuiltDir: string;
	fileCount: number;
	diffs: TreeDiff[];
	build: BuildReport;
}

interface NodeInfo {
	type: "file" | "dir" | "symlink";
	size: number;
	mode: number;
	content?: Buffer;
	target?: string;
}

async function nodeInfo(path: string): Promise<NodeInfo | null> {
	const info = await lstat(path).catch(() => null);
	if (!info) return null;
	if (info.isSymbolicLink()) {
		return { type: "symlink", size: 0, mode: info.mode, target: await readlink(path) };
	}
	if (info.isDirectory()) {
		return { type: "dir", size: 0, mode: info.mode };
	}
	return { type: "file", size: info.size, mode: info.mode, content: await readFile(path) };
}

async function listTree(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				out.push(`${relative(root, path)}/`);
				await walk(path);
			} else {
				out.push(relative(root, path));
			}
		}
	};
	await walk(root);
	return out.sort();
}

async function compareTrees(expected: string, actual: string): Promise<TreeDiff[]> {
	const diffs: TreeDiff[] = [];
	const expectedPaths = new Set(await listTree(expected));
	const actualPaths = new Set(await listTree(actual));

	for (const path of expectedPaths) {
		if (!actualPaths.has(path)) {
			diffs.push({ path, kind: "missing", detail: "present in dist but absent in the clean rebuild" });
			continue;
		}
		const expectedNode = await nodeInfo(join(expected, path));
		const actualNode = await nodeInfo(join(actual, path));
		if (!expectedNode || !actualNode) {
			diffs.push({ path, kind: "missing", detail: "unreadable node" });
			continue;
		}
		if (expectedNode.type !== actualNode.type) {
			diffs.push({ path, kind: "symlink", detail: `node kind differs: ${expectedNode.type} vs ${actualNode.type}` });
			continue;
		}
		if (expectedNode.type === "symlink") {
			if (expectedNode.target !== actualNode.target) {
				diffs.push({ path, kind: "symlink", detail: `target differs: ${expectedNode.target} vs ${actualNode.target}` });
			}
			continue;
		}
		if (expectedNode.type === "file") {
			if (!expectedNode.content?.equals(actualNode.content ?? Buffer.alloc(0))) {
				diffs.push({ path, kind: "content", detail: "byte content differs" });
				continue;
			}
		}
		if ((expectedNode.mode & 0o777) !== (actualNode.mode & 0o777)) {
			diffs.push({
				path,
				kind: "mode",
				detail: `mode differs: ${(expectedNode.mode & 0o777).toString(8)} vs ${(actualNode.mode & 0o777).toString(8)}`,
			});
		}
	}
	for (const path of actualPaths) {
		if (!expectedPaths.has(path)) {
			diffs.push({ path, kind: "extra", detail: "present in the clean rebuild but absent from dist" });
		}
	}
	return diffs;
}

export async function verifyReproducibility(outDir: string = DIST_DIR): Promise<ReproducibilityReport> {
	const distInfo = await lstat(outDir).catch(() => null);
	if (!distInfo?.isDirectory()) {
		throw new Error(`dist is missing: ${outDir} — run \`bun run build:plugin\` first`);
	}
	const rebuiltDir = await mkdtemp(join(tmpdir(), "pstack-rebuild-"));
	try {
		const build = await buildPlugin({ outDir: join(rebuiltDir, "pstack-omp") });
		const rebuilt = build.outDir;
		const diffs = await compareTrees(outDir, rebuilt);
		return {
			ok: diffs.length === 0,
			distDir: outDir,
			rebuiltDir: rebuilt,
			fileCount: build.counts.files,
			diffs,
			build,
		};
	} finally {
		await rm(rebuiltDir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const report = await verifyReproducibility();
	if (report.ok) {
		console.log(
			`verified: clean rebuild byte-identical to ${report.distDir} (${report.fileCount} files; extensions=${report.build.counts.extensions}, skills=${report.build.counts.skills}, agents=${report.build.counts.agents})`,
		);
		return;
	}
	console.error(`reproducibility FAILED: ${report.diffs.length} difference(s)`);
	for (const diff of report.diffs.slice(0, MAX_REPORTED_DIFFS)) {
		console.error(`  ${diff.path} [${diff.kind}] ${diff.detail}`);
	}
	if (report.diffs.length > MAX_REPORTED_DIFFS) {
		console.error(`  … and ${report.diffs.length - MAX_REPORTED_DIFFS} more`);
	}
	process.exitCode = 1;
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
