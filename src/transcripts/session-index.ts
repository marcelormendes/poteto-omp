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
import { readdir, open, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { isRecord } from "../core/guards";

export const DEFAULT_LIST_LIMIT = 10;
export const DEFAULT_READ_LIMIT = 200;
export const DEFAULT_READ_MAX_BYTES = 65536;
export const DEFAULT_SEARCH_LIMIT = 20;
export const SEARCH_EXCERPT_LENGTH = 300;
export const ENTRY_TEXT_LIMIT = 4000;

/** Every `.jsonl` session file under the sessions root, sorted by path. */
export const sessionFiles = async (sessionsRoot: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(path);
    }
  };
  await visit(sessionsRoot);
  return files.sort().reverse();
};

const readBounded = async (path: string, maxBytes: number): Promise<string> => {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min((await file.stat()).size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
};

const scopedFiles = async (
  root: string,
  scope: string,
): Promise<
  Array<{ file: string; header: SessionHeaderInfo; modifiedMs: number }>
> => {
  const found: Array<{
    file: string;
    header: SessionHeaderInfo;
    modifiedMs: number;
  }> = [];
  for (const file of await sessionFiles(root)) {
    try {
      const prefix = (await readBounded(file, 65536))
        .split("\n")
        .flatMap((line) => {
          try {
            const value: unknown = JSON.parse(line);
            return isRecord(value) ? [value] : [];
          } catch {
            return [];
          }
        });
      const header = sessionHeader(prefix);
      if (header?.cwd && resolve(header.cwd) === resolve(scope))
        found.push({ file, header, modifiedMs: (await stat(file)).mtimeMs });
    } catch {
      /* A partial header cannot establish project scope. */
    }
  }
  return found.sort(
    (a, b) => b.modifiedMs - a.modifiedMs || b.file.localeCompare(a.file),
  );
};

/** Parse a JSONL transcript defensively; malformed lines are skipped. */
export const readEntries = async (
  path: string,
): Promise<Record<string, unknown>[]> => {
  const lines = (await readBounded(path, 8 * 1024 * 1024)).split("\n");
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
  readonly modifiedAt: string;
  readonly messages: number;
  readonly truncated: boolean;
  readonly file: string;
}

/**
 * Sessions recorded under `scope`, newest-sorted by modification time, bounded to
 * `limit`. Sessions with no recorded cwd are excluded (fail-closed).
 */
export const listProjectSessions = async (
  sessionsRoot: string,
  scope: string,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = [];
  for (const { file, header, modifiedMs } of (
    await scopedFiles(sessionsRoot, scope)
  ).slice(0, limit)) {
    const entries = await readEntries(file).catch(() => []);
    summaries.push({
      sessionId: header.id,
      cwd: header.cwd,
      timestamp: header.timestamp,
      modifiedAt: new Date(modifiedMs).toISOString(),
      messages: entries.filter((entry) => entry.type === "message").length,
      truncated: (await stat(file)).size > 8 * 1024 * 1024,
      file,
    });
    if (summaries.length >= limit) break;
  }
  return summaries;
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

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
  out = out.replace(
    /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,}]+)/gi,
    "$1[redacted]",
  );
  for (const pattern of SECRET_PATTERNS)
    out = out.replace(pattern, "[redacted]");
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
      .flatMap((part) => {
        if (!isRecord(part)) return [];
        if (part.type === "text" && typeof part.text === "string")
          return [part.text];
        if (part.type === "toolCall" && typeof part.name === "string")
          return [`tool ${part.name}: ${JSON.stringify(part.arguments ?? {})}`];
        return [];
      })
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
    const toolName =
      typeof message.toolName === "string" ? message.toolName : "";
    const model =
      role === "assistant" &&
      typeof message.provider === "string" &&
      typeof message.model === "string"
        ? ` ${message.provider}/${message.model}`
        : "";
    return toolName === ""
      ? `${type} ${role}${model}`
      : `${type} ${role} ${toolName}`;
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
  return redactText(body === "" ? header : `${header}\n${body}`);
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
  const matches = (await scopedFiles(sessionsRoot, scope)).filter(
    ({ file, header }) =>
      header.id.startsWith(sessionId) || basename(file) === sessionId,
  );
  if (matches.length > 1)
    throw new Error(`Ambiguous session prefix: ${sessionId}`);
  for (const { file } of matches) {
    const entries = await readEntries(file).catch(() => []);
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
      if (Buffer.byteLength(out + line + "\n") > maxBytes) {
        const marker = `\n[truncated at ${maxBytes} bytes]`;
        const remaining = Math.max(0, maxBytes - Buffer.byteLength(marker));
        const clipped = Buffer.from(out + line)
          .subarray(0, remaining)
          .toString("utf8")
          .replace(/\uFFFD$/, "");
        out = clipped + marker;
        break;
      }
      out += `${line}\n`;
    }
    const truncated =
      messageCount <
        entries.filter((entry) => entry.type === "message").length ||
      (await stat(file)).size > 8 * 1024 * 1024;
    if (truncated) {
      const marker = "\n[more entries omitted]";
      out =
        Buffer.from(out)
          .subarray(0, Math.max(0, maxBytes - Buffer.byteLength(marker)))
          .toString("utf8")
          .replace(/\uFFFD$/, "") + marker;
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
  const hits: SearchHit[] = [];
  for (const { file } of await scopedFiles(sessionsRoot, scope)) {
    const entries = await readEntries(file).catch(() => []);
    for (const entry of entries) {
      const text = entryText(entry);
      if (text.includes(query)) {
        hits.push({
          file,
          id: typeof entry.id === "string" ? entry.id : "",
          excerpt: text.slice(
            Math.max(0, text.indexOf(query) - 80),
            Math.max(0, text.indexOf(query) - 80) + SEARCH_EXCERPT_LENGTH,
          ),
        });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
};
