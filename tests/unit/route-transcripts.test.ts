import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { PstackError } from "../../src/core/errors";
import { PANEL_ROLES, SCALAR_ROLES } from "../../src/core/types";
import type { ModelChoice, PanelRole, PstackConfig, ScalarRole } from "../../src/core/types";
import { resolveRoute } from "../../src/extension/route-tool";
import type { ModelFacade, ModelLike } from "../../src/setup/catalog";
import {
	entryText,
	listProjectSessions,
	readSessionSlice,
	redactText,
	searchInSessions,
} from "../../src/transcripts/session-index";
import { registerTranscriptTool } from "../../src/transcripts/tool";

// ============================================================================
// Fixtures
// ============================================================================

const model = (selector: string): ModelChoice => ({ type: "model", selector });
const inherit: ModelChoice = { type: "inherit-parent" };

const CATALOG: ModelLike[] = [
	{ provider: "cursor", id: "gpt-5.6-sol" },
	{ provider: "cursor", id: "gpt-5.6-sol-fast" },
	{ provider: "opencode-go", id: "deepseek-v4-flash-vision-exp" },
	{ provider: "opencode-go", id: "glm-5.3-flash" },
];

const resolveSelector = (selector: string): ModelLike | undefined => {
	const trimmed = selector.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = trimmed.slice(0, slash);
	const rest = trimmed.slice(slash + 1);
	const modelId = rest.includes(":") ? rest.slice(0, rest.lastIndexOf(":")) : rest;
	return CATALOG.find(m => m.provider === provider && m.id === modelId);
};

const models: ModelFacade = {
	list: () => CATALOG,
	resolve: resolveSelector,
	family: m => (m.provider === "cursor" ? "cursor" : "opencode"),
};

function makeConfig(
	overrides: {
		roles?: Partial<Record<ScalarRole, ModelChoice>>;
		panels?: Partial<Record<PanelRole, readonly ModelChoice[]>>;
	} = {},
): PstackConfig {
	const roles = Object.fromEntries(
		SCALAR_ROLES.map(role => [role, model("cursor/gpt-5.6-sol")]),
	) as Record<ScalarRole, ModelChoice>;
	const panels = Object.fromEntries(
		PANEL_ROLES.map(panel => [
			panel,
			[
				model("cursor/gpt-5.6-sol-fast"),
				model("opencode-go/deepseek-v4-flash-vision-exp"),
				model("cursor/gpt-5.6-sol"),
				model("opencode-go/glm-5.3-flash"),
			],
		]),
	) as Record<PanelRole, ModelChoice[]>;
	return {
		schemaVersion: 1,
		upstreamCommit: "b9ddc83c32972210b8a94d389130713e8eed346e",
		autoEnable: true,
		roles: { ...roles, ...overrides.roles },
		panels: { ...panels, ...overrides.panels },
	};
}

const routeError = (fn: () => unknown): PstackError => {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(PstackError);
		return error as PstackError;
	}
	throw new Error("expected resolveRoute to throw");
};

// ============================================================================
// pstack_route resolution
// ============================================================================

describe("resolveRoute", () => {
	test("resolves a scalar role to exactly one generated agent with its selector", () => {
		const result = resolveRoute(makeConfig(), models, "feature");
		expect(result.role).toBe("feature");
		expect(result.agents).toEqual([
			{
				agent: "pstack-feature",
				role: "feature",
				selector: "cursor/gpt-5.6-sol",
				model: "cursor/gpt-5.6-sol",
			},
		]);
	});

	test("resolves a panel role to every seat in configured order", () => {
		const result = resolveRoute(makeConfig(), models, "how-critics");
		expect(result.agents.map(a => a.agent)).toEqual([
			"pstack-how-critics-1",
			"pstack-how-critics-2",
			"pstack-how-critics-3",
			"pstack-how-critics-4",
		]);
		expect(result.agents[0]).toMatchObject({
			selector: "cursor/gpt-5.6-sol-fast",
			model: "cursor/gpt-5.6-sol-fast",
		});
		expect(result.agents[1]).toMatchObject({
			selector: "opencode-go/deepseek-v4-flash-vision-exp",
			model: "opencode-go/deepseek-v4-flash-vision-exp",
		});
	});

	test("accepts a generated agent name for one panel seat", () => {
		const result = resolveRoute(makeConfig(), models, "pstack-arena-cross-judges-2");
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]).toMatchObject({
			agent: "pstack-arena-cross-judges-2",
			selector: "opencode-go/deepseek-v4-flash-vision-exp",
		});
	});

	test("reports inherit-parent seats without a model resolution", () => {
		const config = makeConfig({ roles: { feature: inherit } });
		const result = resolveRoute(config, models, "feature");
		expect(result.agents).toEqual([
			{ agent: "pstack-feature", role: "feature", selector: "inherit-parent", model: null },
		]);
	});

	test("keeps a reasoning suffix on the reported selector", () => {
		const config = makeConfig({ roles: { feature: model("cursor/gpt-5.6-sol:high") } });
		const result = resolveRoute(config, models, "feature");
		expect(result.agents[0].selector).toBe("cursor/gpt-5.6-sol:high");
		expect(result.agents[0].model).toBe("cursor/gpt-5.6-sol");
	});

	test("excludeSelector keeps only contrasting-family seats", () => {
		const result = resolveRoute(makeConfig(), models, "arena-cross-judges", "cursor/gpt-5.6-sol");
		expect(result.agents.map(a => a.agent)).toEqual([
			"pstack-arena-cross-judges-2",
			"pstack-arena-cross-judges-4",
		]);
	});

	test("fails closed when no contrasting seat exists (never same-family fallback)", () => {
		const config = makeConfig({
			panels: { "arena-cross-judges": [model("cursor/gpt-5.6-sol"), model("cursor/gpt-5.6-sol-fast")] },
		});
		const error = routeError(() => resolveRoute(config, models, "arena-cross-judges", "cursor/gpt-5.6-sol"));
		expect(error.code).toBe("PSTACK_NO_CONTRASTING_SEAT");
		expect(error.message).toContain("arena-cross-judges");
	});

	test("inherit-parent seats never satisfy a contrast filter", () => {
		const config = makeConfig({ panels: { "arena-cross-judges": [inherit, inherit] } });
		const error = routeError(() => resolveRoute(config, models, "arena-cross-judges", "cursor/gpt-5.6-sol"));
		expect(error.code).toBe("PSTACK_NO_CONTRASTING_SEAT");
		expect(error.message).toContain("arena-cross-judges");
	});

	test("rejects an unknown role with the role named", () => {
		const error = routeError(() => resolveRoute(makeConfig(), models, "bogus-role"));
		expect(error.code).toBe("PSTACK_UNKNOWN_ROLE");
		expect(error.message).toContain("bogus-role");
	});

	test("rejects a seat number beyond the configured cardinality", () => {
		const error = routeError(() => resolveRoute(makeConfig(), models, "pstack-how-critics-9"));
		expect(error.code).toBe("PSTACK_UNKNOWN_ROLE");
		expect(error.message).toContain("how-critics");
	});

	test("fails closed when setup is missing", () => {
		const error = routeError(() => resolveRoute(undefined, models, "feature"));
		expect(error.code).toBe("PSTACK_SETUP_MISSING");
		expect(error.message).toContain("/setup-pstack");
	});

	test("names the role when a configured selector is unavailable", () => {
		const config = makeConfig({ roles: { feature: model("openai/gpt-9.9") } });
		const error = routeError(() => resolveRoute(config, models, "feature"));
		expect(error.code).toBe("PSTACK_MODEL_UNAVAILABLE");
		expect(error.message).toContain("feature");
	});

	test("fails closed on an unresolvable excludeSelector", () => {
		const error = routeError(() => resolveRoute(makeConfig(), models, "arena-cross-judges", "openai/gpt-9.9"));
		expect(error.code).toBe("PSTACK_MODEL_UNAVAILABLE");
	});
});

// ============================================================================
// pstack_transcripts — scoping, bounds, redaction
// ============================================================================

interface SessionFixture {
	root: string;
	projA: string;
	projB: string;
}

const writeSession = async (
	root: string,
	projectBucket: string,
	fileName: string,
	lines: unknown[],
): Promise<void> => {
	const dir = join(root, projectBucket);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, fileName),
		lines.map(line => JSON.stringify(line)).join("\n") + "\n",
	);
};

const makeSessionFixture = async (): Promise<SessionFixture> => {
	const root = await mkdtemp(join(tmpdir(), "pstack-sessions-"));
	const projA = join(root, "proj-a");
	const projB = join(root, "proj-b");
	await writeSession(root, "-proj-a", "2026-05-26T18-13-08-860Z_sess-aaa.jsonl", [
		{ type: "session", id: "sess-aaa", timestamp: "2026-05-26T18:13:08.860Z", cwd: projA },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-05-26T18:13:09.192Z", model: "cursor/composer-2.5-fast" },
		{ type: "message", id: "msg-1", parentId: "m1", timestamp: "2026-05-26T18:13:09.210Z", message: { role: "user", content: [{ type: "text", text: "hello needle world" }] } },
		{ type: "message", id: "msg-2", parentId: "msg-1", timestamp: "2026-05-26T18:13:20.000Z", message: { role: "assistant", content: "needle answer" } },
		{ type: "message", id: "msg-3", parentId: "msg-2", timestamp: "2026-05-26T18:13:30.000Z", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file with sk-1234567890abcdef secret" }] } },
	]);
	await writeSession(root, "-proj-b", "2026-05-26T18-14-00-000Z_sess-bbb.jsonl", [
		{ type: "session", id: "sess-bbb", timestamp: "2026-05-26T18:14:00.000Z", cwd: projB },
		{ type: "message", id: "msg-1", parentId: null, timestamp: "2026-05-26T18:14:01.000Z", message: { role: "user", content: "needle in other project" } },
	]);
	await writeSession(root, "-proj-a", "2026-05-26T18-15-00-000Z_sess-ccc.jsonl", [
		{ type: "session", id: "sess-ccc", timestamp: "2026-05-26T18:15:00.000Z", cwd: "" },
		{ type: "message", id: "msg-1", parentId: null, timestamp: "2026-05-26T18:15:01.000Z", message: { role: "user", content: "no project recorded" } },
	]);
	await writeFile(
		join(root, "-proj-a", "2026-05-26T18-16-00-000Z_sess-mal.jsonl"),
		[
			JSON.stringify({ type: "session", id: "sess-mal", timestamp: "2026-05-26T18:16:00.000Z", cwd: projA }),
			"{not json",
			JSON.stringify({ type: "message", id: "msg-x", parentId: null, timestamp: "2026-05-26T18:16:01.000Z", message: { role: "user", content: "valid after garbage" } }),
			"",
		].join("\n"),
	);
	return { root, projA, projB };
};

describe("listProjectSessions", () => {
	test("returns only sessions recorded under the scoped cwd", async () => {
		const { root, projA, projB } = await makeSessionFixture();
		try {
			const rows = await listProjectSessions(root, projA);
			expect(rows.map(row => row.sessionId).sort()).toEqual(["sess-aaa", "sess-mal"]);
			const aaa = rows.find(row => row.sessionId === "sess-aaa");
			expect(aaa?.cwd).toBe(projA);
			expect(aaa?.messages).toBe(3);
			expect(aaa?.file).toContain("sess-aaa");
			expect(rows.find(row => row.sessionId === "sess-bbb")).toBeUndefined();
			expect(rows.find(row => row.sessionId === "sess-ccc")).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("returns the other project only when it is the explicit scope", async () => {
		const { root, projB } = await makeSessionFixture();
		try {
			const rows = await listProjectSessions(root, projB);
			expect(rows.map(row => row.sessionId)).toEqual(["sess-bbb"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("respects the limit", async () => {
		const { root, projA } = await makeSessionFixture();
		try {
			const rows = await listProjectSessions(root, projA, 1);
			expect(rows).toHaveLength(1);
			expect(rows[0].sessionId).toBe("sess-aaa");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("survives malformed JSONL lines", async () => {
		const { root, projA } = await makeSessionFixture();
		try {
			const rows = await listProjectSessions(root, projA);
			const mal = rows.find(row => row.sessionId === "sess-mal");
			expect(mal?.messages).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("readSessionSlice", () => {
	test("returns a redacted, bounded slice of the scoped session", async () => {
		const { root, projA } = await makeSessionFixture();
		try {
			const slice = await readSessionSlice(root, projA, "sess-aaa");
			expect(slice?.file).toContain("sess-aaa");
			expect(slice?.text).toContain("hello needle world");
			expect(slice?.text).toContain("needle answer");
			expect(slice?.text).toContain("[redacted]");
			expect(slice?.text).not.toContain("sk-1234567890abcdef");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("caps the message count", async () => {
		const { root, projA } = await makeSessionFixture();
		try {
			const slice = await readSessionSlice(root, projA, "sess-aaa", 2);
			expect(slice?.text).toContain("hello needle world");
			expect(slice?.text).toContain("needle answer");
			expect(slice?.text).not.toContain("sk-1234567890abcdef");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("caps the output bytes with a truncation marker", async () => {
		const { root, projA } = await makeSessionFixture();
		try {
			const slice = await readSessionSlice(root, projA, "sess-aaa", 200, 120);
			expect(slice?.text).toContain("[truncated at 120 bytes]");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("never reads a session from another project", async () => {
		const { root, projA } = await makeSessionFixture();
		try {
			const slice = await readSessionSlice(root, projA, "sess-bbb");
			expect(slice).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("searchInSessions", () => {
	test("matches only within the scoped project", async () => {
		const { root, projA } = await makeSessionFixture();
		try {
			const hits = await searchInSessions(root, projA, "needle");
			expect(hits).toHaveLength(2);
			expect(hits.every(hit => hit.file.includes("sess-aaa"))).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reaches another project only with its explicit scope", async () => {
		const { root, projB } = await makeSessionFixture();
		try {
			const hits = await searchInSessions(root, projB, "needle");
			expect(hits).toHaveLength(1);
			expect(hits[0].file).toContain("sess-bbb");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("credential-shaped text is redacted before matching", async () => {
		const { root, projA } = await makeSessionFixture();
		try {
			const hits = await searchInSessions(root, projA, "sk-1234567890abcdef");
			expect(hits).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("caps hits at the limit", async () => {
		const { root, projA } = await makeSessionFixture();
		try {
			const hits = await searchInSessions(root, projA, "needle", 1);
			expect(hits).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("redaction", () => {
	test("redacts common credential-shaped substrings", () => {
		expect(redactText("key sk-abcdef1234567890 and Bearer abc.def.ghi")).toBe(
			"key [redacted] and [redacted]",
		);
		expect(redactText("ghp_abcdefghijklmnopqrstuvwxyz12345678")).toBe("[redacted]");
		expect(redactText("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe("[redacted]");
	});

	test("entryText redacts before returning", () => {
		const text = entryText({
			type: "message",
			id: "m",
			parentId: null,
			timestamp: "t",
			message: { role: "user", content: "token xoxb-12345678901234567890" },
		});
		expect(text).toBe("token [redacted]");
	});
});

describe("registerTranscriptTool", () => {
	test("registers a tool whose list operation is project-scoped", async () => {
		const { root, projA } = await makeSessionFixture();
		try {
			let definition: ToolDefinition | undefined;
			const pi = {
				registerTool: (def: ToolDefinition) => {
					definition = def;
				},
			} as unknown as ExtensionAPI;
			registerTranscriptTool(pi, { sessionsRoot: root });
			expect(definition?.name).toBe("pstack_transcripts");
			const ctx = { cwd: projA } as unknown as ExtensionContext;
			const result = await definition!.execute("call-1", { operation: "list" }, undefined, undefined, ctx);
			const part = result.content[0];
			const text = part.type === "text" ? part.text : "";
			expect(text).toContain("sess-aaa");
			expect(text).not.toContain("sess-bbb");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("honors an explicit projectPath for cross-project read", async () => {
		const { root, projA, projB } = await makeSessionFixture();
		try {
			let definition: ToolDefinition | undefined;
			const pi = {
				registerTool: (def: ToolDefinition) => {
					definition = def;
				},
			} as unknown as ExtensionAPI;
			registerTranscriptTool(pi, { sessionsRoot: root });
			const ctx = { cwd: projA } as unknown as ExtensionContext;
			const result = await definition!.execute(
				"call-2",
				{ operation: "read", sessionId: "sess-bbb", projectPath: projB },
				undefined,
				undefined,
				ctx,
			);
			const part = result.content[0];
			const text = part.type === "text" ? part.text : "";
			expect(text).toContain("needle in other project");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
