/**
 * Evidence assertions shared by the OMP acceptance harness and its unit tests.
 *
 * Pure data contracts — no I/O, no SDK imports — so every rule can fail closed
 * on fabricated input. Runtime evidence is collected by tests/e2e/acceptance.ts
 * and passed in as plain data.
 */

// ============================================================================
// Subagent ledger: terminal-status retention
// ============================================================================

/**
 * Frame shapes mirror the OMP RPC protocol (src/modes/rpc/rpc-types.ts):
 * `subagent_lifecycle`, `subagent_progress`, and `subagent_event` frames with
 * payloads matching SubagentLifecyclePayload / SubagentProgressPayload /
 * SubagentEventPayload. Kept structural here so this module stays dependency
 * free and unit-testable.
 */

export type AgentSource = "bundled" | "custom" | "plugin" | string;

export type SubagentLedgerStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface SubagentLedgerEntry {
	/** Stable subagent id (lifecycle payload.id / progress progress.id / event payload.id). */
	id: string;
	/** Spawn order (may be undefined on event-only frames). */
	index?: number;
	/** Role agent name, e.g. `pstack-feature`. */
	agent: string;
	agentSource: AgentSource;
	description?: string;
	/** Human-readable task text (progress frames only). */
	task?: string;
	/** Standalone assignment text (progress frames only). */
	assignment?: string;
	/** Transcript file the subagent writes to. */
	sessionFile?: string;
	parentToolCallId?: string;
	/** Never regresses once terminal (completed | failed | aborted). */
	status: SubagentLedgerStatus;
	/** True when status is completed | failed | aborted. */
	terminal: boolean;
}

/** Terminal statuses; once recorded they are sticky for the subagent's lifetime. */
export const TERMINAL_STATUSES: ReadonlyArray<SubagentLedgerStatus> = [
	"completed",
	"failed",
	"aborted",
] as const;

const TERMINAL_SET: ReadonlySet<SubagentLedgerStatus> = new Set(TERMINAL_STATUSES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function framePayload(frame: Record<string, unknown>): Record<string, unknown> | undefined {
	return isRecord(frame.payload) ? frame.payload : undefined;
}

function progressStatus(payload: Record<string, unknown>): SubagentLedgerStatus | undefined {
	const progress = isRecord(payload.progress) ? payload.progress : undefined;
	const status = progress ? asString(progress.status) : undefined;
	if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "aborted") {
		return status;
	}
	return undefined;
}

function lifecycleStatus(payload: Record<string, unknown>): SubagentLedgerStatus | undefined {
	const status = asString(payload.status);
	if (status === "started") return "running";
	if (status === "completed" || status === "failed" || status === "aborted") return status;
	return undefined;
}

/**
 * Reduces raw RPC frames into a per-subagent ledger.
 *
 * Retention rule: a terminal status (completed | failed | aborted) recorded
 * for a subagent is sticky. Progress frames racing the lifecycle frame may
 * still report `running` (or a different terminal word via an out-of-order
 * tail), and an already-terminal entry must not regress. The first terminal
 * signal wins and is never overwritten.
 *
 * Unknown frame types and malformed payloads are skipped (they carry no
 * subagent evidence); later frames for the same id update only metadata.
 */
export function subagentSnapshotsFromFrames(frames: readonly unknown[]): SubagentLedgerEntry[] {
	const byId = new Map<string, SubagentLedgerEntry>();

	const upsert = (id: string, update: (entry: SubagentLedgerEntry) => void): void => {
		const existing = byId.get(id);
		if (existing) {
			update(existing);
			return;
		}
		const entry: SubagentLedgerEntry = {
			id,
			agent: "",
			agentSource: "custom",
			status: "pending",
			terminal: false,
		};
		update(entry);
		byId.set(id, entry);
	};

	for (const frame of frames) {
		if (!isRecord(frame)) continue;
		const type = asString(frame.type);
		if (type === "subagent_lifecycle") {
			const payload = framePayload(frame);
			if (!payload) continue;
			const id = asString(payload.id);
			const status = lifecycleStatus(payload);
			if (!id || !status) continue;
			upsert(id, entry => {
				const agent = asString(payload.agent);
				if (agent) entry.agent = agent;
				const source = asString(payload.agentSource);
				if (source) entry.agentSource = source;
				const description = asString(payload.description);
				if (description !== undefined) entry.description = description;
				const sessionFile = asString(payload.sessionFile);
				if (sessionFile !== undefined) entry.sessionFile = sessionFile;
				const parentToolCallId = asString(payload.parentToolCallId);
				if (parentToolCallId !== undefined) entry.parentToolCallId = parentToolCallId;
				if (typeof payload.index === "number") entry.index = payload.index;
				// Terminal retention: never regress, never replace an existing terminal status.
				if (!entry.terminal) {
					entry.status = status;
					entry.terminal = TERMINAL_SET.has(status);
				}
			});
			continue;
		}
		if (type === "subagent_progress") {
			const payload = framePayload(frame);
			if (!payload) continue;
			const progress = isRecord(payload.progress) ? payload.progress : undefined;
			const id = progress ? asString(progress.id) : undefined;
			const status = progressStatus(payload);
			if (!id || !status) continue;
			upsert(id, entry => {
				const agent = asString(payload.agent) ?? (progress ? asString(progress.agent) : undefined);
				if (agent) entry.agent = agent;
				const source = asString(payload.agentSource) ?? (progress ? asString(progress.agentSource) : undefined);
				if (source) entry.agentSource = source;
				const task = asString(payload.task);
				if (task !== undefined) entry.task = task;
				const assignment = asString(payload.assignment);
				if (assignment !== undefined) entry.assignment = assignment;
				const sessionFile = asString(payload.sessionFile);
				if (sessionFile !== undefined) entry.sessionFile = sessionFile;
				const parentToolCallId = asString(payload.parentToolCallId);
				if (parentToolCallId !== undefined) entry.parentToolCallId = parentToolCallId;
				if (typeof payload.index === "number") entry.index = payload.index;
				if (progress && typeof progress.description === "string" && entry.description === undefined) {
					entry.description = progress.description;
				}
				if (!entry.terminal) {
					entry.status = status;
					entry.terminal = TERMINAL_SET.has(status);
				}
			});
			continue;
		}
		if (type === "subagent_event") {
			const payload = framePayload(frame);
			if (!payload) continue;
			const id = asString(payload.id);
			if (!id) continue;
			upsert(id, entry => {
				// An event proves activity; never regress a terminal status.
				if (!entry.terminal) {
					entry.status = "running";
					entry.terminal = false;
				}
			});
			continue;
		}
	}

	const entries = Array.from(byId.values());
	return entries.sort((a, b) => {
		const ai = a.index ?? Number.MAX_SAFE_INTEGER;
		const bi = b.index ?? Number.MAX_SAFE_INTEGER;
		if (ai !== bi) return ai - bi;
		return a.id.localeCompare(b.id);
	});
}

// ============================================================================
// Arena isolation: artifact pointers, not cwd
// ============================================================================

export type ArenaCandidateStatus = "pass" | "issues" | "blocked" | "failed" | "aborted";

/** One arena candidate's yielded envelope and the observed parent-checkout delta. */
export interface ArenaCandidateEvidence {
	/** Subagent id that produced the candidate. */
	id: string;
	/** Status from the yielded envelope. */
	status: ArenaCandidateStatus;
	/** True when the coordinator selected this candidate as base/graft source. */
	selected: boolean;
	/** The yielded status envelope (structured output). Required for every candidate. */
	envelope?: {
		status?: string;
		/** Artifact pointer: agent://…, artifact://…, or a path inside an allowed artifact root. */
		artifact?: string;
		/** Claimed working directory reported by the candidate. */
		workspace?: string;
		cwd?: string;
	};
	/** Files this candidate changed inside the PARENT checkout (empty array = observed none). */
	parentChanges?: string[];
}

export interface ArenaIsolationEvidence {
	/** Absolute parent checkout root. Candidates must not claim or write under it. */
	parentRoot: string;
	/** Absolute roots where isolated candidate artifacts are allowed (worktrees, artifact dirs). */
	artifactRoots: string[];
	candidates: ArenaCandidateEvidence[];
}

export interface ArenaIsolationVerdict {
	ok: boolean;
	violations: string[];
}

function isSchemePointer(pointer: string): boolean {
	return /^(agent|artifact):\/\//.test(pointer);
}

function isUnderOrEqual(candidate: string, root: string): boolean {
	const normalized = candidate.replace(/\/+$/, "");
	const rootNormalized = root.replace(/\/+$/, "");
	return normalized === rootNormalized || normalized.startsWith(`${rootNormalized}/`);
}

/**
 * Fail-closed isolation audit for an arena run.
 *
 * Rules:
 * 1. At least one candidate must be evidenced.
 * 2. Every candidate must yield a status envelope (structured output).
 * 3. Successful candidates (pass | issues) must carry an artifact pointer that
 *    is scheme-based (agent://, artifact://) or inside an allowed artifact root.
 *    A bare relative path, the parent checkout root, or any path under the
 *    parent checkout is a violation.
 * 4. A candidate must never claim the parent checkout as its workspace.
 * 5. Unselected candidates must not have changed the parent checkout.
 * 6. Parent-change observation must exist for every candidate (empty array
 *    means "observed unchanged"); a missing observation is a violation.
 *
 * Dropout tolerance: blocked | failed | aborted candidates do not need an
 * artifact pointer, but they still need the envelope and the parent-change
 * observation, and they still may not touch the parent checkout.
 */
export function arenaIsolationFromAgents(evidence: ArenaIsolationEvidence): ArenaIsolationVerdict {
	const violations: string[] = [];
	const { parentRoot, artifactRoots, candidates } = evidence;

	if (candidates.length === 0) {
		violations.push("no candidate evidence recorded");
		return { ok: false, violations };
	}

	for (const candidate of candidates) {
		const id = candidate.id || "<unknown>";
		const envelope = candidate.envelope;

		if (!envelope) {
			violations.push(`${id}: missing yielded status envelope (structured output required)`);
		} else {
			if (candidate.status === "pass" || candidate.status === "issues") {
				const artifact = typeof envelope.artifact === "string" ? envelope.artifact : undefined;
				if (!artifact) {
					violations.push(`${id}: successful candidate has no artifact pointer`);
				} else {
					const schemePointer = isSchemePointer(artifact);
					const insideArtifactRoot = artifactRoots.some(root => isUnderOrEqual(artifact, root));
					const underParent = isUnderOrEqual(artifact, parentRoot);
					if (!schemePointer && !insideArtifactRoot) {
						violations.push(`${id}: artifact pointer is not isolated (${artifact})`);
					}
					if (underParent) {
						violations.push(`${id}: artifact pointer resolves into the parent checkout (${artifact})`);
					}
				}
			}

			const workspace = typeof envelope.workspace === "string" ? envelope.workspace : undefined;
			const cwd = typeof envelope.cwd === "string" ? envelope.cwd : workspace;
			if (cwd && isUnderOrEqual(cwd, parentRoot)) {
				violations.push(`${id}: candidate claims the parent checkout as its workspace (${cwd})`);
			}
		}

		if (!Array.isArray(candidate.parentChanges)) {
			violations.push(`${id}: missing parent-change observation`);
		} else if (!candidate.selected && candidate.parentChanges.length > 0) {
			violations.push(
				`${id}: unselected candidate changed the parent checkout (${candidate.parentChanges.join(", ")})`,
			);
		}
	}

	return { ok: violations.length === 0, violations };
}

// ============================================================================
// Shared discovery constants
// ============================================================================

/**
 * Pstack extension command names that must be discoverable through the native
 * OMP slash-command surface (`available_commands_update` over RPC). Slash-less
 * names, as the RPC protocol reports them.
 */
export const EXPECTED_PSTACK_COMMANDS: ReadonlyArray<string> = [
	"setup-pstack",
	"poteto-mode",
	"pstack-status",
] as const;

/** Skill commands (skills.enableSkillCommands defaults true) that must surface for a linked plugin. */
export const EXPECTED_PSTACK_SKILL_COMMANDS: ReadonlyArray<string> = [
	"skill:how",
	"skill:why",
	"skill:architect",
	"skill:arena",
	"skill:swarm",
	"skill:interrogate",
	"skill:reflect",
	"skill:poteto-mode",
] as const;

/**
 * Collects a machine-readable extension-error ledger from raw frames.
 * The acceptance harness treats ANY extension_error frame as fatal for its
 * session (extension code must load cleanly in a native OMP process).
 */
export interface ExtensionErrorRecord {
	extensionPath: string;
	event: string;
	error: string;
	line: number;
}

export function collectExtensionErrors(frames: readonly unknown[]): ExtensionErrorRecord[] {
	const errors: ExtensionErrorRecord[] = [];
	frames.forEach((frame, line) => {
		if (!isRecord(frame)) return;
		if (frame.type !== "extension_error") return;
		errors.push({
			extensionPath: asString(frame.extensionPath) ?? "<unknown>",
			event: asString(frame.event) ?? "unknown",
			error: asString(frame.error) ?? "unknown",
			line,
		});
	});
	return errors;
}
