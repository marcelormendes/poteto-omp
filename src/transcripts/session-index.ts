/**
 * OMP session transcript discovery, scoping, and bounded rendering.
 *
 * Session JSONL lives under the OMP agent dir's sessions root, one directory
 * per project. Discovery reads each session header (`type: "session"`) and
 * matches its recorded cwd against the requested scope. Sessions without a
 * recorded cwd are never returned, so cross-project leakage is impossible by
 * default; leaving the current project requires an explicit projectPath.
 *
 * Every rendered text is redacted (credential-shaped substrings and sensitive
 * JSON keys) before it leaves the module, and every read is bounded by message
 * count and bytes.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRecord } from "../core/guards";

export const DEFAULT_LIST_LIMIT = 10;
export const DEFAULT_READ_LIMIT = 200;
export const DEFAULT_READ_MAX_BYTES = 65536;
export const DEFAULT_SEARCH_LIMIT = 20;
export const SEARCH_EXCERPT_LENGTH = 300;
export const ENTRY_TEXT_LIMIT = 4000;

/** Every `.jsonl` session file under the sessions root, sorted by path. */
export const sessionFiles = async (sessionsRoot: string): Promise<string[]> => {
  const projects = await readdir(sessionsRoot).catch(() => []);
  const files: string[] = [];
  for (const project of projects) {
    const dir = join(sessionsRoot, project);
    if (!(await stat(dir).then((info) => info.isDirectory()).catch(() => false))) continue;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name.endsWith(".jsonl")) files.push(join(dir, name));
    }
  }
  return files.sort();
};

/** Parse a JSONL transcript defensively; malformed lines are skipped. */
export const readEntries = async (path: string): Promise<Record<string, unknown>[]> => {
  const lines = (await readFile(path, "utf8")).split("\n");
  const entries: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) entries.push(value);
    } catch {
      // A torn tail write must not fail the whole transcript.
    }
  }
  return entries;
};

export interface SessionHeaderInfo {
  readonly id: string;
  readonly cwd: string;
  readonly timestamp: string;
}

/** First `type: "session"` entry's header fields; undefined when absent. */
export const sessionHeader = (
  entries: readonly Record<string, unknown>[],
): SessionHeaderInfo | undefined => {
  for (const entry of entries) {
    if (entry.type !== "session") continue;
    return {
      id: typeof entry.id === "string" ? entry.id : "",
      cwd: typeof entry.cwd === "string" ? entry.cwd : "",
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
    };
  }
  return undefined;
};

export interface SessionSummary {
  readonly sessionId: string;
  readonly cwd: string;
  readonly timestamp: string;
  readonly messages: number;
  readonly file: string;
};

/**
 * Sessions recorded under `scope`, newest-sorted by file path, bounded to
 * `limit`. Sessions with no recorded cwd are excluded (fail-closed).
 */
export const listProjectSessions = async (
  sessionsRoot: string,
  scope: string,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<SessionSummary[]> => {
  const resolvedScope = resolve(scope);
  const files = await sessionFiles(sessionsRoot);
  const summaries: SessionSummary[] = [];
  for (const file of files) {
    const entries = await readEntries(file).catch(() => []);
    const header = sessionHeader(entries);
    if (header === undefined || header.cwd === "") continue;
    if (resolve(header.cwd) !== resolvedScope) continue;
    summaries.push({
      sessionId: header.id,
      cwd: header.cwd,
      timestamp: header.timestamp,
      messages: entries.filter((entry) => entry.type === "message").length,
      file,
    });
    if (summaries.length >= limit) break;
  }
  return summaries;
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

/** Replace credential-shaped substrings in arbitrary text. */
export const redactText = (text: string): string => {
  let out = text.replace(PRIVATE_KEY_BLOCK, "[redacted]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Redacted message text (string content or text parts), capped at `maxLength`. */
export const entryText = (
  entry: Record<string, unknown>,
  maxLength: number = Number.POSITIVE_INFINITY,
): string => {
  const message = isRecord(entry.message) ? entry.message : undefined;
  if (message === undefined) return "";
  const content = message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .flatMap((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("\n");
  }
  const redacted = redactText(text);
  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength)}…[truncated]`
    : redacted;
};

const entryLabel = (entry: Record<string, unknown>): string => {
  const type = typeof entry.type === "string" ? entry.type : "entry";
  const message = isRecord(entry.message) ? entry.message : undefined;
  if (message !== undefined) {
    const role = typeof message.role === "string" ? message.role : "message";
    const toolName = typeof message.toolName === "string" ? message.toolName : "";
    return toolName === "" ? `${type} ${role}` : `${type} ${role} ${toolName}`;
  }
  if (type === "model_change") {
    return typeof entry.model === "string" ? `${type} ${entry.model}` : type;
  }
  // provider metadata (model_usage, api keys) is excluded: not needed for analysis
  return type;
};

/** One bounded, redacted line (header + text) for a transcript entry. */
export const renderReadEntry = (entry: Record<string, unknown>): string => {
  const id = typeof entry.id === "string" ? entry.id : "";
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
  const body = entryText(entry, ENTRY_TEXT_LIMIT);
  const header = `[${id}] ${timestamp} ${entryLabel(entry)}`;
  return body === "" ? header : `${header}\n${body}`;
};

/**
 * Bounded slice of one session: entries in file order, capped by message
 * count (`limit`) and output bytes (`maxBytes`, with a truncation marker).
 * Non-message entries are included only as a leading prefix (header, model
 * changes) so the count bound always applies to messages.
 */
export const readSessionSlice = async (
  sessionsRoot: string,
  scope: string,
  sessionId: string,
  limit: number = DEFAULT_READ_LIMIT,
  maxBytes: number = DEFAULT_READ_MAX_BYTES,
): Promise<{ file: string; text: string } | undefined> => {
  const resolvedScope = resolve(scope);
  const files = await sessionFiles(sessionsRoot);
  for (const file of files) {
    const entries = await readEntries(file).catch(() => []);
    const header = sessionHeader(entries);
    if (header === undefined || header.cwd === "") continue;
    if (resolve(header.cwd) !== resolvedScope) continue;
    if (!(header.id.startsWith(sessionId) || file.includes(sessionId))) continue;
    const picked: Record<string, unknown>[] = [];
    let messageCount = 0;
    for (const entry of entries) {
      if (entry.type === "message") {
        if (messageCount >= limit) break;
        messageCount += 1;
        picked.push(entry);
      } else if (messageCount === 0) {
        picked.push(entry);
      }
    }
    let out = "";
    for (const entry of picked) {
      const line = renderReadEntry(entry);
      if (out.length + line.length + 1 > maxBytes) {
        out += `\n[truncated at ${maxBytes} bytes]`;
        break;
      }
      out += `${line}\n`;
    }
    return { file, text: out.trim() || "(empty session)" };
  }
  return undefined;
};

export interface SearchHit {
  readonly file: string;
  readonly id: string;
  readonly excerpt: string;
}

/**
 * Literal substring search over scoped sessions, matching redacted text so an
 * excerpt can never leak a credential. Bounded to `limit` hits.
 */
export const searchInSessions = async (
  sessionsRoot: string,
  scope: string,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<SearchHit[]> => {
  const resolvedScope = resolve(scope);
  const files = await sessionFiles(sessionsRoot);
  const hits: SearchHit[] = [];
  for (const file of files) {
    const entries = await readEntries(file).catch(() => []);
    const header = sessionHeader(entries);
    if (header === undefined || header.cwd === "") continue;
    if (resolve(header.cwd) !== resolvedScope) continue;
    for (const entry of entries) {
      const text = entryText(entry);
      if (text.includes(query)) {
        hits.push({
          file,
          id: typeof entry.id === "string" ? entry.id : "",
          excerpt: text.slice(0, SEARCH_EXCERPT_LENGTH),
        });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
};
