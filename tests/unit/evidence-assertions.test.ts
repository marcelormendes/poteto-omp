import { describe, expect, test } from "bun:test";
import {
	arenaIsolationFromAgents,
	collectExtensionErrors,
	subagentSnapshotsFromFrames,
	type ArenaIsolationEvidence,
} from "../e2e/assertions";

// ============================================================================
// subagentSnapshotsFromFrames — ledger terminal-status retention
// ============================================================================

describe("subagentSnapshotsFromFrames", () => {
	test("records lifecycle frames as ledger entries", () => {
		const entries = subagentSnapshotsFromFrames([
			{
				type: "subagent_lifecycle",
				payload: {
					id: "a1",
					index: 0,
					agent: "pstack-feature",
					agentSource: "custom",
					status: "started",
				},
			},
		]);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ id: "a1", agent: "pstack-feature", status: "running", terminal: false });
	});

	test("retains a terminal status when a stale progress frame races the lifecycle", () => {
		const entries = subagentSnapshotsFromFrames([
			{
				type: "subagent_lifecycle",
				payload: { id: "a1", index: 0, agent: "pstack-arena-runners-1", agentSource: "custom", status: "completed" },
			},
			{
				type: "subagent_progress",
				payload: {
					index: 0,
					agent: "pstack-arena-runners-1",
					agentSource: "custom",
					task: "brief",
					progress: { id: "a1", index: 0, agent: "pstack-arena-runners-1", agentSource: "custom", status: "running", task: "brief" },
				},
			},
		]);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.status).toBe("completed");
		expect(entries[0]?.terminal).toBe(true);
		// Metadata from the later progress frame is still merged.
		expect(entries[0]?.task).toBe("brief");
	});

	test("never replaces an existing terminal status with a different one", () => {
		const entries = subagentSnapshotsFromFrames([
			{
				type: "subagent_progress",
				payload: {
					index: 1,
					agent: "pstack-swarm-worker",
					agentSource: "custom",
					task: "slice",
					progress: { id: "s1", index: 1, agent: "pstack-swarm-worker", agentSource: "custom", status: "failed", task: "slice" },
				},
			},
			{
				type: "subagent_lifecycle",
				payload: { id: "s1", index: 1, agent: "pstack-swarm-worker", agentSource: "custom", status: "aborted" },
			},
		]);
		expect(entries[0]?.status).toBe("failed");
		expect(entries[0]?.terminal).toBe(true);
	});

	test("progress frames before the lifecycle frame are merged by id", () => {
		const entries = subagentSnapshotsFromFrames([
			{
				type: "subagent_progress",
				payload: {
					index: 2,
					agent: "pstack-how-explorer",
					agentSource: "custom",
					task: "explore",
					progress: { id: "h1", index: 2, agent: "pstack-how-explorer", agentSource: "custom", status: "pending", task: "explore" },
				},
			},
			{
				type: "subagent_lifecycle",
				payload: { id: "h1", index: 2, agent: "pstack-how-explorer", agentSource: "custom", status: "completed", sessionFile: "/tmp/h1.jsonl" },
			},
		]);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ id: "h1", status: "completed", sessionFile: "/tmp/h1.jsonl", task: "explore" });
	});

	test("event frames mark an entry active without regressing terminal status", () => {
		const entries = subagentSnapshotsFromFrames([
			{ type: "subagent_event", payload: { id: "e1", event: { type: "assistant_message" } } },
			{
				type: "subagent_lifecycle",
				payload: { id: "e1", index: 0, agent: "pstack-reflect-tooling", agentSource: "custom", status: "failed" },
			},
			{ type: "subagent_event", payload: { id: "e1", event: { type: "tool_call" } } },
		]);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.status).toBe("failed");
		expect(entries[0]?.agent).toBe("pstack-reflect-tooling");
	});

	test("skips unknown frames and malformed payloads", () => {
		const entries = subagentSnapshotsFromFrames([
			{ type: "ready", protocolVersion: 1 },
			{ type: "subagent_lifecycle", payload: null },
			{ type: "subagent_progress", payload: { index: 0 } },
			{ type: "extension_ui_request", id: "x" },
			"not-a-frame",
			null,
		]);
		expect(entries).toEqual([]);
	});

	test("orders entries by spawn index then id", () => {
		const entries = subagentSnapshotsFromFrames([
			{ type: "subagent_progress", payload: { index: 5, agent: "b", agentSource: "custom", task: "t", progress: { id: "b", index: 5, agent: "b", agentSource: "custom", status: "running", task: "t" } } },
			{ type: "subagent_progress", payload: { index: 1, agent: "a", agentSource: "custom", task: "t", progress: { id: "a", index: 1, agent: "a", agentSource: "custom", status: "completed", task: "t" } } },
		]);
		expect(entries.map(entry => entry.id)).toEqual(["a", "b"]);
	});
});

// ============================================================================
// arenaIsolationFromAgents — artifact pointers over cwd
// ============================================================================

function baseEvidence(overrides: Partial<ArenaIsolationEvidence> = {}): ArenaIsolationEvidence {
	return {
		parentRoot: "/work/parent",
		artifactRoots: ["/work/artifacts", "/work/worktrees/candidate"],
		candidates: [
			{
				id: "c1",
				status: "pass",
				selected: true,
				envelope: { status: "pass", artifact: "agent://c1", workspace: "/work/worktrees/candidate" },
				parentChanges: ["src/base.ts"],
			},
			{
				id: "c2",
				status: "issues",
				selected: false,
				envelope: { status: "issues", artifact: "/work/worktrees/candidate/out.patch" },
				parentChanges: [],
			},
		],
		...overrides,
	};
}

describe("arenaIsolationFromAgents", () => {
	test("accepts scheme pointers, artifact-root paths, and observed parent deltas", () => {
		const verdict = arenaIsolationFromAgents(baseEvidence());
		expect(verdict.ok).toBe(true);
		expect(verdict.violations).toEqual([]);
	});

	test("rejects an empty candidate set", () => {
		const verdict = arenaIsolationFromAgents({ parentRoot: "/p", artifactRoots: [], candidates: [] });
		expect(verdict.ok).toBe(false);
		expect(verdict.violations).toEqual(["no candidate evidence recorded"]);
	});

	test("requires a yielded status envelope from every candidate", () => {
		const evidence = baseEvidence();
		evidence.candidates[1] = { ...evidence.candidates[1]!, envelope: undefined };
		const verdict = arenaIsolationFromAgents(evidence);
		expect(verdict.ok).toBe(false);
		expect(verdict.violations).toContain("c2: missing yielded status envelope (structured output required)");
	});

	test("rejects a successful candidate without an artifact pointer", () => {
		const evidence = baseEvidence();
		evidence.candidates[0] = { ...evidence.candidates[0]!, envelope: { status: "pass" } };
		const verdict = arenaIsolationFromAgents(evidence);
		expect(verdict.ok).toBe(false);
		expect(verdict.violations).toContain("c1: successful candidate has no artifact pointer");
	});

	test("rejects a cwd-relative artifact pointer (evidence must not be cwd)", () => {
		const evidence = baseEvidence();
		evidence.candidates[0] = {
			...evidence.candidates[0]!,
			envelope: { status: "pass", artifact: "src/out.patch", workspace: "/work/parent" },
		};
		const verdict = arenaIsolationFromAgents(evidence);
		expect(verdict.ok).toBe(false);
		expect(verdict.violations).toEqual([
			"c1: artifact pointer is not isolated (src/out.patch)",
			"c1: candidate claims the parent checkout as its workspace (/work/parent)",
		]);
	});

	test("rejects an artifact pointer inside the parent checkout", () => {
		const evidence = baseEvidence();
		evidence.candidates[0] = {
			...evidence.candidates[0]!,
			envelope: { status: "pass", artifact: "/work/parent/candidate-a" },
		};
		const verdict = arenaIsolationFromAgents(evidence);
		expect(verdict.ok).toBe(false);
		expect(verdict.violations).toContain("c1: artifact pointer resolves into the parent checkout (/work/parent/candidate-a)");
	});

	test("rejects parent pollution by unselected candidates", () => {
		const evidence = baseEvidence();
		evidence.candidates[1] = { ...evidence.candidates[1]!, parentChanges: ["src/unrelated.ts"] };
		const verdict = arenaIsolationFromAgents(evidence);
		expect(verdict.ok).toBe(false);
		expect(verdict.violations).toContain("c2: unselected candidate changed the parent checkout (src/unrelated.ts)");
	});

	test("missing parent-change observation fails closed even for selected candidates", () => {
		const evidence = baseEvidence();
		evidence.candidates[0] = { ...evidence.candidates[0]!, parentChanges: undefined };
		const verdict = arenaIsolationFromAgents(evidence);
		expect(verdict.ok).toBe(false);
		expect(verdict.violations).toContain("c1: missing parent-change observation");
	});

	test("dropout tolerance: blocked candidates still need envelope and clean parent, not an artifact", () => {
		const evidence = baseEvidence();
		evidence.candidates.push({
			id: "c3",
			status: "blocked",
			selected: false,
			envelope: { status: "blocked" },
			parentChanges: [],
		});
		const verdict = arenaIsolationFromAgents(evidence);
		expect(verdict.ok).toBe(true);
	});

	test("does not isolate candidates for their claimed workspace alone when pointer is valid", () => {
		const evidence = baseEvidence();
		evidence.candidates[0] = {
			...evidence.candidates[0]!,
			envelope: { status: "pass", artifact: "agent://c1", workspace: "/work/worktrees/candidate-a" },
		};
		const verdict = arenaIsolationFromAgents(evidence);
		expect(verdict.ok).toBe(true);
	});
});

// ============================================================================
// collectExtensionErrors
// ============================================================================

describe("collectExtensionErrors", () => {
	test("collects extension_error frames with their source line", () => {
		const errors = collectExtensionErrors([
			{ type: "ready", protocolVersion: 1 },
			{ type: "extension_error", extensionPath: "plugin:/pstack", event: "load", error: "boom" },
			{ type: "response", command: "get_state", success: true },
		]);
		expect(errors).toEqual([
			{ extensionPath: "plugin:/pstack", event: "load", error: "boom", line: 1 },
		]);
	});

	test("ignores non-error frames", () => {
		expect(collectExtensionErrors([{ type: "extension_ui_request", id: "x" }, null, 42])).toEqual([]);
	});
});
