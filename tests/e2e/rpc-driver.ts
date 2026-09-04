/**
 * Minimal OMP RPC driver for the acceptance harness.
 *
 * Spawns the real `omp` CLI with `--mode rpc` as a subprocess and speaks the
 * newline-delimited JSON protocol (src/modes/rpc). The harness never uses an
 * in-process SDK client: acceptance evidence must come from a separate native
 * OMP process.
 *
 * Protocol facts this driver relies on (verified against OMP 18.1.10 sources
 * and a live probe):
 * - Both directions are newline-delimited JSON frames.
 * - `negotiate_protocol` requires exactly protocolVersion 2.
 * - `prompt` answers immediately with a `response` frame; turn completion is
 *   signaled by an `agent_end` event, or by a `prompt_result`
 *   ({ agentInvoked: false }) for local-only commands.
 * - `extension_ui_request` frames must be answered to keep dialogs from
 *   hanging; this driver auto-answers every request with `cancelled: true`.
 * - Frames larger than 1 MiB are transported as `rpc_chunk` pieces under
 *   protocol v2; this driver reassembles them.
 */
import { spawn, type Subprocess } from "bun";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectExtensionErrors } from "./assertions";

export interface RpcDriverOptions {
	/** OMP binary (default `omp`). */
	omp?: string;
	/** Disposable seeded profile name; omit to use the default (real) profile. Empty profiles resolve no models — seed agent files first. */
	profile?: string;
	/** Working directory for the agent. */
	cwd: string;
	/** Session storage dir for the agent (defaults to the profile's). */
	sessionDir?: string;
	/** Extra CLI args appended verbatim. */
	extraArgs?: string[];
	env?: Record<string, string>;
}

export interface RpcResponse {
	id?: string;
	type: string;
	command?: string;
	success?: boolean;
	data?: Record<string, unknown>;
	error?: string;
}

export interface RpcAvailableCommand {
	name: string;
	description?: string;
	aliases?: string[];
	source?: string;
	subcommands?: Array<{ name: string; description?: string }>;
}

export interface RpcSubagentSnapshot {
	id: string;
	index?: number;
	agent?: string;
	agentSource?: string;
	description?: string;
	status?: string;
	task?: string;
	assignment?: string;
	sessionFile?: string;
	parentToolCallId?: string;
}

export class RpcDriverError extends Error {
	constructor(
		message: string,
		readonly phase: string,
		readonly stderrTail: string,
	) {
		super(message);
		this.name = "RpcDriverError";
	}
}

interface PendingRequest {
	resolve: (frame: RpcResponse) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	command: string;
}

type FrameListener = (frame: Record<string, unknown>) => void;

const FRAME_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 2_000;

export class RpcDriver {
	readonly frames: Array<Record<string, unknown>> = [];
	private process_: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	private pending = new Map<string, PendingRequest>();
	private listeners = new Set<FrameListener>();
	private nextId = 0;
	private closed = false;
	private stderrTail = "";
	private readonly chunked = new Map<string, Array<{ index: number; count: number; data: string } | null>>();
	private readonly lineBuffer: string[] = [];

	private constructor(private readonly options: RpcDriverOptions) {}

	/** Spawns the RPC process and completes the protocol handshake. */
	static async start(options: RpcDriverOptions): Promise<RpcDriver> {
		const driver = new RpcDriver(options);
		await driver.#spawn();
		await driver.#negotiate();
		return driver;
	}

	async #spawn(): Promise<void> {
		const args = ["--mode", "rpc"];
		const env = { ...process.env, ...this.options.env } as Record<string, string>;
		if (this.options.profile) args.push("--profile", this.options.profile);
		if (this.options.sessionDir) args.push("--session-dir", this.options.sessionDir);
		args.push("--cwd", this.options.cwd);
		if (this.options.extraArgs) args.push(...this.options.extraArgs);

		const proc = spawn({
			cmd: [this.options.omp ?? "omp", ...args],
			cwd: this.options.cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.process_ = proc;

		const decoder = new TextDecoder();
		let stdoutOpen = true;
		let stderrOpen = true;
		(proc.stdout as ReadableStream<Uint8Array>).pipeTo(
			new WritableStream<Uint8Array>({
				write: chunk => {
					this.#onStdout(decoder.decode(chunk, { stream: true }));
				},
			}),
		).catch(() => {
			stdoutOpen = false;
		});
		(proc.stderr as ReadableStream<Uint8Array>).pipeTo(
			new WritableStream<Uint8Array>({
				write: chunk => {
					this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-4096);
				},
			}),
		).catch(() => {
			stderrOpen = false;
		});
		proc.exited.then(code => {
			this.closed = true;
			const tail = this.stderrTail;
			for (const [id, request] of this.pending) {
				clearTimeout(request.timeout);
				request.reject(new RpcDriverError(`OMP exited (code ${code}) while awaiting ${request.command}`, "transport", tail));
				this.pending.delete(id);
			}
			if (!stdoutOpen || !stderrOpen) {
				// Stream teardown is normal on exit; nothing to add.
			}
		});
	}

	#onStdout(text: string): void {
		this.lineBuffer.push(text);
		const content = this.lineBuffer.join("");
		this.lineBuffer.length = 0;
		const lines = content.split("\n");
		const last = lines.pop() ?? "";
		if (last.length > 0) this.lineBuffer.push(last);
		for (const raw of lines) {
			const line = raw.trim();
			if (line.length === 0) continue;
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue; // A malformed line never carries protocol frames; skip it.
			}
			this.#dispatch(parsed);
		}
	}

	#dispatch(frame: Record<string, unknown>): void {
		if (frame.type === "rpc_chunk") {
			const reassembled = this.#reassembleChunk(frame);
			if (reassembled) this.#dispatch(reassembled);
			return;
		}
		this.frames.push(frame);
		if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
			this.#writeFrame({ type: "extension_ui_response", id: frame.id, cancelled: true });
			return;
		}
		if (frame.type === "response" && typeof frame.id === "string") {
			const request = this.pending.get(frame.id);
			if (request) {
				clearTimeout(request.timeout);
				this.pending.delete(frame.id);
        request.resolve(frame as unknown as RpcResponse);
			}
		}
		for (const listener of this.listeners) {
			try {
				listener(frame);
			} catch {
				// Listeners must not break the frame loop.
			}
		}
	}

	/** Protocol v2 chunk reassembly: emits the logical frame when the piece set is complete. */
	#reassembleChunk(frame: Record<string, unknown>): Record<string, unknown> | null {
		const chunkId = typeof frame.chunkId === "string" ? frame.chunkId : null;
		const index = typeof frame.index === "number" ? frame.index : null;
		const count = typeof frame.count === "number" ? frame.count : null;
		const data = typeof frame.data === "string" ? frame.data : null;
		if (!chunkId || index === null || count === null || count < 1 || data === null || index < 0 || index >= count) {
			return null;
		}
		const pieces = this.chunked.get(chunkId) ?? new Array<{ index: number; count: number; data: string } | null>(count).fill(null);
		pieces[index] = { index, count, data };
		this.chunked.set(chunkId, pieces);
		if (!pieces.every(piece => piece !== null)) return null;
		this.chunked.delete(chunkId);
		const json = pieces
			.filter((piece): piece is { index: number; count: number; data: string } => piece !== null)
			.sort((a, b) => a.index - b.index)
			.map(piece => Buffer.from(piece.data, "base64").toString("utf8"))
			.join("");
		try {
			return JSON.parse(json) as Record<string, unknown>;
		} catch {
			return null;
		}
	}

  #writeFrame(frame: Record<string, unknown>): void {
    if (this.closed) return;
    const stdin = this.process_?.stdin as unknown as { write(chunk: string): void } | undefined;
    stdin?.write(`${JSON.stringify(frame)}\n`);
  }

	async #negotiate(): Promise<void> {
		const response = await this.send({ type: "negotiate_protocol", protocolVersion: 2 });
		if (!response.success || (response.data as { protocolVersion?: number } | undefined)?.protocolVersion !== 2) {
			throw new RpcDriverError(`RPC negotiation failed: ${response.error ?? "unknown"}`, "negotiation", this.stderrTail);
		}
	}

  async send(command: Record<string, unknown>, timeoutMs = FRAME_TIMEOUT_MS): Promise<RpcResponse> {
    const id = typeof command.id === "string" ? command.id : `rpc-${++this.nextId}`;
		const body = { ...command, id };
		const promise = new Promise<RpcResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new RpcDriverError(`Timed out waiting for response to ${String(command.type)}`, "command", this.stderrTail));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout, command: String(command.type) });
		});
		this.#writeFrame(body);
		return promise;
	}

	onFrame(listener: FrameListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Sends a prompt and resolves when the turn ends (agent_end) or a local command consumed it. */
	async promptAndWait(message: string, timeoutMs = 300_000): Promise<{ agentInvoked: boolean; frames: Record<string, unknown>[] }> {
		const collected: Record<string, unknown>[] = [];
		let settled = false;
		const settle = (value: { agentInvoked: boolean }) => {
			if (settled) return;
			settled = true;
			resolvePromise(value);
		};
		const { promise: result, resolve: resolvePromise } = Promise.withResolvers<{ agentInvoked: boolean }>();

		const unsubscribe = this.onFrame(frame => {
			collected.push(frame);
			if (frame.type === "agent_end") {
				settle({ agentInvoked: true });
			} else if (frame.type === "prompt_result" && frame.id !== undefined) {
				settle({ agentInvoked: frame.agentInvoked === true });
			}
		});
		try {
			await this.send({ type: "prompt", message });
			const outcome = await Promise.race([
				result,
				sleep(timeoutMs).then(() => {
					throw new RpcDriverError(`Prompt timed out after ${timeoutMs}ms`, "prompt", this.stderrTail);
				}),
			]);
			return { ...outcome, frames: collected };
		} finally {
			unsubscribe();
		}
	}

	async getState(): Promise<Record<string, unknown>> {
		const response = await this.send({ type: "get_state" });
		this.#requireSuccess(response, "get_state");
		return response.data ?? {};
	}

	async getAvailableCommands(): Promise<RpcAvailableCommand[]> {
		const response = await this.send({ type: "get_available_commands" });
		this.#requireSuccess(response, "get_available_commands");
		const commands = (response.data as { commands?: RpcAvailableCommand[] } | undefined)?.commands ?? [];
		return commands;
	}

	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", ...(parentSession ? { parentSession } : {}) });
		this.#requireSuccess(response, "new_session");
		const data = response.data as { cancelled?: boolean } | undefined;
		return { cancelled: data?.cancelled ?? false };
	}

	async getSubagents(): Promise<RpcSubagentSnapshot[]> {
		const response = await this.send({ type: "get_subagents" });
		this.#requireSuccess(response, "get_subagents");
		const subagents = (response.data as { subagents?: RpcSubagentSnapshot[] } | undefined)?.subagents ?? [];
		return subagents;
	}

	async getSubagentMessages(input: { subagentId?: string; sessionFile?: string; fromByte?: number } = {}): Promise<Record<string, unknown>> {
		const response = await this.send({
			type: "get_subagent_messages",
			...(input.subagentId ? { subagentId: input.subagentId } : {}),
			...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
			...(input.fromByte ? { fromByte: input.fromByte } : {}),
		});
		this.#requireSuccess(response, "get_subagent_messages");
		return (response.data as Record<string, unknown>) ?? {};
	}

	async getMessages(): Promise<unknown[]> {
		const response = await this.send({ type: "get_messages" });
		this.#requireSuccess(response, "get_messages");
		return (response.data as { messages?: unknown[] } | undefined)?.messages ?? [];
	}

	/** All extension_error frames observed on this transport so far (fail-closed evidence). */
	extensionErrors(): Array<{ extensionPath: string; event: string; error: string; line: number }> {
		return collectExtensionErrors(this.frames);
	}

	/** Immediate pstack-session info without blocking on a model turn. */
	async currentSessionId(): Promise<string> {
		const state = await this.getState();
		const sessionId = state.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new RpcDriverError("get_state returned no sessionId", "state", this.stderrTail);
		}
		return sessionId;
	}

	async stop(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const proc = this.process_;
		if (!proc) return;
		proc.kill();
		await Promise.race([proc.exited, sleep(STOP_GRACE_MS)]);
		if (!(await Promise.race([proc.exited.then(() => true), sleep(0).then(() => false)]))) {
			proc.kill(9);
		}
	}

	stderr(): string {
		return this.stderrTail;
	}

	#requireSuccess(response: RpcResponse, command: string): void {
		if (!response.success) {
			throw new RpcDriverError(`${command} failed: ${response.error ?? "unknown"}`, command, this.stderrTail);
		}
	}
}

/** Creates a disposable working directory for a scenario. */
export async function makeScenarioDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}
