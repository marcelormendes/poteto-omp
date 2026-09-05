import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSemanticModelRoles,
	generateAgentFiles,
	parseAgentFrontmatter,
	readGeneratedAgentManifest,
	renderGeneratedAgent,
	type GeneratedAgent,
} from "../../src/setup/agent-generator";

const SCALARS = [
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

const PANELS = [
	"how-critics",
	"arena-runners",
	"arena-cross-judges",
	"architect-runners",
	"interrogate-reviewers",
] as const;

type Config = Parameters<typeof generateAgentFiles>[0];

function completeConfig(): Config {
	const model = (selector: string) => ({ type: "model", selector }) as const;
	const roles = Object.fromEntries(SCALARS.map(role => [role, model("cursor/gpt-5.6-sol")]));
	const panels = Object.fromEntries(PANELS.map(role => [role, [model("cursor/gpt-5.6-sol-fast"), model("opencode-go/deepseek-v4-flash-vision-exp"), model("cursor/gpt-5.6-sol"), model("opencode-go/glm-5.3-flash")]]));
	// Rebuild as the literal config shape; structural typing validates the keys.
	return {
		schemaVersion: 1,
		upstreamCommit: "b9ddc83c32972210b8a94d389130713e8eed346e",
		autoEnable: true,
		roles: Object.assign(roles),
		panels: Object.assign(panels),
	} as Config;
}

// ============================================================================
// parseAgentFrontmatter — frontmatter parse contract
// ============================================================================

describe("parseAgentFrontmatter", () => {
	test("parses name, description, model (normalized to a list), tools, and body", () => {
		const parsed = parseAgentFrontmatter(
			[
				"---",
				"name: pstack-feature",
				'description: "Pstack feature role"',
				"model: cursor/gpt-5.6-sol",
				"tools: [read, grep, glob]",
				"---",
				"",
				"Do the assigned slice completely.",
			].join("\n"),
			"pstack-feature.md",
		);
		expect(parsed.name).toBe("pstack-feature");
		expect(parsed.description).toBe("Pstack feature role");
		expect(parsed.model).toEqual(["cursor/gpt-5.6-sol"]);
		expect(parsed.tools).toEqual(["read", "grep", "glob"]);
		expect(parsed.body).toContain("Do the assigned slice completely.");
	});

	test("accepts a YAML flow-list model value", () => {
		const parsed = parseAgentFrontmatter(
			['---', "name: pstack-how-explorer", 'description: "x"', "model: [cursor/gpt-5.6-sol, opencode-go/glm-5.3-flash]", "---", "body",].join("\n"),
		);
		expect(parsed.model).toEqual(["cursor/gpt-5.6-sol", "opencode-go/glm-5.3-flash"]);
	});

	test("fails closed on missing frontmatter", () => {
		expect(() => parseAgentFrontmatter("no frontmatter here", "bad.md")).toThrow();
	});

	test("fails closed on a missing name", () => {
		expect(() => parseAgentFrontmatter(["---", 'description: "x"', "---", "body"].join("\n"), "bad.md")).toThrow();
	});
});

// ============================================================================
// renderGeneratedAgent + coordinator closure
// ============================================================================

function coordinatorAgent(): Omit<GeneratedAgent, "content"> {
	return {
		file: "pstack-coordinator.md",
		name: "pstack-coordinator",
		description: "Pstack track coordinator: frames briefs and drains a track",
		body: "Own the track's briefs and drains. Never edit code. Spawn only through the declared closures.",
		tools: ["task", "hub", "read"],
		spawns: "*",
		modelRole: "@pstack-feature",
		semanticRole: "orchestrate",
		toolProfile: "coordinator",
	};
}

describe("renderGeneratedAgent + coordinator closure parsing", () => {
	test("renders the coordinator spawns closure and round-trips through the parser", () => {
		const rendered = renderGeneratedAgent(coordinatorAgent());
		expect(rendered).toMatch(/^---\n/);
		expect(rendered).toMatch(/spawns: "\*"\n/);
		expect(rendered).toMatch(/^model: "@pstack-feature"$/m);
		expect(rendered).toMatch(/^tools: \[task, hub, read\]$/m);

		const parsed = parseAgentFrontmatter(rendered);
		expect(parsed.name).toBe("pstack-coordinator");
		expect(parsed.model).toEqual(["@pstack-feature"]);
		expect(parsed.spawns).toEqual("*");
		expect(parsed.tools).toEqual(["task", "hub", "read"]);
		expect(parsed.body).toContain("Own the track's briefs");
	});

	test("renders a bounded spawn closure as a flow list", () => {
		const rendered = renderGeneratedAgent({
			...coordinatorAgent(),
			spawns: ["pstack-feature", "pstack-swarm-worker"],
		});
		expect(rendered).toMatch(/spawns: \[pstack-feature, pstack-swarm-worker\]\n/);
		const parsed = parseAgentFrontmatter(rendered);
		expect(parsed.spawns).toEqual(["pstack-feature", "pstack-swarm-worker"]);
	});

	test("omits the model line for inherit-parent agents and keeps the closure intact", () => {
		const rendered = renderGeneratedAgent({ ...coordinatorAgent(), modelRole: null });
		expect(rendered).not.toMatch(/^model:/m);
		const parsed = parseAgentFrontmatter(rendered);
		expect(parsed.model).toBeUndefined();
		expect(parsed.name).toBe("pstack-coordinator");
	});

	test("rendered content is stable: re-render equals the generated content field", () => {
		const agent = coordinatorAgent();
		const first = renderGeneratedAgent(agent);
		const second = renderGeneratedAgent(agent);
		expect(second).toBe(first);
	});
});

// ============================================================================
// generateAgentFiles — roster contract
// ============================================================================

describe("generateAgentFiles", () => {
	const config = completeConfig();
	const agents = generateAgentFiles(config);

	test("emits 16 scalars plus 5 four-seat panels (36 files)", () => {
		expect(agents).toHaveLength(36);
		expect(new Set(agents.map(agent => agent.file)).size).toBe(36);
	});

	test("names follow the flat pstack- prefix convention", () => {
		for (const agent of agents) {
			expect(agent.name).toMatch(/^pstack-[a-z0-9-]+$/);
			expect(agent.file).toBe(`${agent.name}.md`);
		}
	});

	test("scalar roles map to the configured model choices", () => {
		const feature = agents.find(agent => agent.name === "pstack-feature");
		expect(feature).toBeDefined();
		expect(feature?.modelRole).toBe("@pstack-feature");
		expect(feature?.semanticRole).toBe("feature");
		expect(feature?.toolProfile).toBe("writing");
		expect(parseAgentFrontmatter(feature!.content).autoloadSkills).toEqual(["poteto-mode"]);
	});

	test("panel seats carry the seat suffix on the semantic role and the @ model role", () => {
		const seats = agents
			.filter(agent => /^arena-runners-\d+$/.test(agent.semanticRole))
			.sort((a, b) => a.semanticRole.localeCompare(b.semanticRole));
		expect(seats.map(seat => seat.semanticRole)).toEqual([
			"arena-runners-1",
			"arena-runners-2",
			"arena-runners-3",
			"arena-runners-4",
		]);
		expect(seats[0]?.modelRole).toBe("@pstack-arena-runners-1");
	});

	test("generated content equals the rendered markdown of its own data (closure)", () => {
		for (const agent of agents) {
			const { content, ...data } = agent;
			expect(content).toBe(renderGeneratedAgent(data));
		}
	});

	test("no duplicate file names across scalar and panel agents", () => {
		const names = agents.map(agent => agent.file);
		expect(new Set(names).size).toBe(names.length);
	});
});

// ============================================================================
// buildSemanticModelRoles
// ============================================================================

describe("buildSemanticModelRoles", () => {
	test("maps every role to its exact selector under the pstack- model role names", () => {
		const roles = buildSemanticModelRoles(completeConfig());
		expect(roles).toMatchObject({
			"pstack-feature": "cursor/gpt-5.6-sol",
			"pstack-bug-fix": "cursor/gpt-5.6-sol",
			"pstack-how-explorer": "cursor/gpt-5.6-sol",
			"pstack-arena-runners-1": "cursor/gpt-5.6-sol-fast",
			"pstack-arena-runners-2": "opencode-go/deepseek-v4-flash-vision-exp",
			"pstack-interrogate-reviewers-4": "opencode-go/glm-5.3-flash",
		});
		expect(Object.keys(roles).length).toBe(36);
	});

	test("omits inherit-parent roles entirely (no inherit shorthand)", () => {
		const config = completeConfig();
		(config.roles as Record<string, { type: "model"; selector: string } | { type: "inherit-parent" }>)[
			"how-explainer"
		] = { type: "inherit-parent" };
		const roles = buildSemanticModelRoles(config);
		expect(roles["pstack-how-explainer"]).toBeUndefined();
		expect(Object.keys(roles)).toHaveLength(35);
	});
});

// ============================================================================
// readGeneratedAgentManifest
// ============================================================================

describe("readGeneratedAgentManifest", () => {
	test("returns null when the manifest does not exist", async () => {
		expect(await readGeneratedAgentManifest("/tmp/definitely-missing-pstack-manifest.json")).toBeNull();
	});

	test("round-trips a schemaVersion 1 manifest with sha256 entries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pstack-manifest-"));
		try {
			const manifestPath = join(dir, "generated-agents.json");
			await writeFile(
				manifestPath,
				JSON.stringify({
					schemaVersion: 1,
					entries: [
						{
							file: "pstack-feature.md",
							sha256: "a".repeat(64),
							semanticRole: "feature",
							toolProfile: "writing",
							modelRole: "@pstack-feature",
						},
					],
				}),
			);
			const manifest = await readGeneratedAgentManifest(manifestPath);
			expect(manifest?.schemaVersion).toBe(1);
			expect(manifest?.entries).toHaveLength(1);
			expect(manifest?.entries[0]).toMatchObject({
				file: "pstack-feature.md",
				sha256: "a".repeat(64),
				semanticRole: "feature",
				toolProfile: "writing",
				modelRole: "@pstack-feature",
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
