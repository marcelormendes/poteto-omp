import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord } from "../../src/core/guards";

export interface ModelCall {
  provider: string;
  model: string;
  outputTokens: number;
  stopReason?: string;
}
export interface ChildEvidence {
  id: string;
  agent: string;
  status: string;
  sessionFile?: string;
  cwd?: string;
  models: ModelCall[];
}
export function modelCalls(messages: unknown[]): ModelCall[] {
  return messages.flatMap((message) => {
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      typeof message.provider !== "string" ||
      typeof message.model !== "string"
    )
      return [];
    const usage = isRecord(message.usage) ? message.usage : {};
    return [
      {
        provider: message.provider,
        model: message.model,
        outputTokens: typeof usage.output === "number" ? usage.output : 0,
        stopReason:
          typeof message.stopReason === "string"
            ? message.stopReason
            : undefined,
      },
    ];
  });
}
export async function jsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const result: string[] = [];
  for (const e of entries) {
    const path = join(root, e.name);
    if (e.isDirectory()) result.push(...(await jsonlFiles(path)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) result.push(path);
  }
  return result;
}
export async function childEvidence(
  messages: unknown[],
  sessionFile: string,
): Promise<ChildEvidence[]> {
  const roster = new Map<string, string>();
  const statuses = new Map<string, string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!isRecord(v)) return;
    if (typeof v.id === "string" && typeof v.agent === "string")
      roster.set(v.id, v.agent);
    if (typeof v.text === "string")
      for (const match of v.text.matchAll(
        /<task-result id="([^"]+)" agent="([^"]+)" status="([^"]+)"/g,
      )) {
        roster.set(match[1]!, match[2]!);
        statuses.set(match[1]!, match[3]!);
      }
    if (typeof v.content === "string") visit({ text: v.content });
    for (const [key, value] of Object.entries(v))
      if (key !== "content" || typeof value !== "string") visit(value);
  };
  visit(messages);
  const files = await jsonlFiles(sessionFile.replace(/\.jsonl$/, ""));
  const transcripts = new Map<
    string,
    Array<{ type?: string; cwd?: string; message?: unknown }>
  >();
  for (const file of files) {
    const entries = (await readFile(file, "utf8"))
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    transcripts.set(file, entries);
    visit(entries.map((entry) => entry.message));
  }
  const result: ChildEvidence[] = [];
  for (const [id, agent] of roster) {
    const matches = files.filter((file) => basename(file) === `${id}.jsonl`);
    if (matches.length > 1)
      throw new Error(`${id}: ambiguous child transcript`);
    const file = matches[0];
    const entries = file ? transcripts.get(file)! : [];
    result.push({
      id,
      agent,
      status: statuses.get(id) ?? "uncollected",
      sessionFile: file,
      cwd: entries.find((entry) => entry.type === "session")?.cwd,
      models: modelCalls(entries.map((e) => e.message)),
    });
  }
  return result;
}

export function assertModelExecution(
  calls: ModelCall[],
  label: string,
  expected?: string,
): void {
  if (!calls.some((c) => c.outputTokens > 0))
    throw new Error(`${label}: no assistant response with model usage`);
  if (calls.some((c) => c.stopReason === "error" || c.stopReason === "aborted"))
    throw new Error(`${label}: model returned an error/abort`);
  if (expected && calls.some((c) => `${c.provider}/${c.model}` !== expected))
    throw new Error(
      `${label}: expected ${expected}, observed ${[...new Set(calls.map((c) => `${c.provider}/${c.model}`))].join(", ")}`,
    );
}

/** A native skill expansion or a successful read, never a model's claim alone. */
export function skillLoaded(messages: unknown[], skill: string): boolean {
  return messages.some((message) => {
    if (!isRecord(message)) return false;
    if (
      message.role === "custom" &&
      message.customType === "skill-prompt" &&
      String(message.content).includes(`User invoked the "${skill}" skill`)
    )
      return true;
    if (message.role !== "assistant" || !Array.isArray(message.content))
      return false;
    return message.content.some((part) => {
      if (
        !isRecord(part) ||
        part.type !== "toolCall" ||
        part.name !== "read" ||
        !isRecord(part.arguments)
      )
        return false;
      const path = part.arguments.path;
      if (
        path !== `skill://${skill}` &&
        !(
          typeof path === "string" && path.endsWith(`/skills/${skill}/SKILL.md`)
        )
      )
        return false;
      return messages.some(
        (result) =>
          isRecord(result) &&
          result.role === "toolResult" &&
          result.toolCallId === part.id &&
          result.isError !== true,
      );
    });
  });
}

/** Keep execution evidence without provider signatures or private reasoning. */
export function compactEvidence(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .filter((item) => !isRecord(item) || item.type !== "thinking")
      .map(compactEvidence);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["thinkingSignature", "signature"].includes(key))
      .map(([key, item]) => [key, compactEvidence(item)]),
  );
}
