/**
 * pstack_transcripts: project-scoped, bounded access to OMP session
 * transcripts (list / read / search).
 *
 * Scoped to the current project cwd by default; sessions from other projects
 * are only reachable through an explicit `projectPath` in the call. Output is
 * bounded by message count and bytes and redacted before it is returned.
 */
import { join, resolve } from "node:path";
import { getAgentDir, z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_MAX_BYTES,
  DEFAULT_SEARCH_LIMIT,
  listProjectSessions,
  readSessionSlice,
  searchInSessions,
} from "./session-index";

export interface TranscriptToolOptions {
  /** Session storage root; defaults to the active OMP agent dir's `sessions`. */
  readonly sessionsRoot?: string;
}

/** The active OMP sessions root (~/.omp/agent/sessions, agent-dir override first). */
export const defaultSessionsRoot = (): string => join(getAgentDir(), "sessions");

const clampLimit = (value: number | undefined, fallback: number): number => {
  const raw = value ?? fallback;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(1, Math.floor(raw)), 1000);
};

const clampBytes = (value: number | undefined, fallback: number): number => {
  const raw = value ?? fallback;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(1024, Math.floor(raw)), 10_000_000);
};

const textResult = (text: string, details: unknown = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

/** pstack_transcripts parameter schema (a named const so TParams inference is stable). */
const transcriptParamsSchema = z.object({
  operation: z.enum(["list", "read", "search"]),
  sessionId: z
    .string()
    .describe("Session id prefix or file name (operation read)")
    .optional(),
  query: z.string().describe("Literal substring to search (operation search)").optional(),
  limit: z.number().describe("Max sessions or matches (default 10/20)").optional(),
  maxBytes: z
    .number()
    .describe("Max bytes for read output (default 65536)")
    .optional(),
  projectPath: z
    .string()
    .describe("Explicit cross-project path; leave unset for the current project")
    .optional(),
});

export function registerTranscriptTool(
  pi: ExtensionAPI,
  options: TranscriptToolOptions = {},
): void {
  pi.registerTool({
    name: "pstack_transcripts",
    label: "Pstack transcripts",
    description:
      "List, read, or search current-project OMP session transcripts with " +
      "bounds. Scoped to the project cwd by default; pass an explicit " +
      "projectPath only when the user authorizes another project.",
    parameters: transcriptParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const defaultRoot = defaultSessionsRoot();
      const sessionDir = ctx.sessionManager?.getSessionDir();
      const sessionsRoot = options.sessionsRoot ?? (sessionDir && !resolve(sessionDir).startsWith(resolve(defaultRoot) + "/") ? sessionDir : defaultRoot);
      const scope =
        params.projectPath !== undefined && params.projectPath.trim() !== ""
          ? resolve(params.projectPath.trim())
          : ctx.cwd;

      if (params.operation === "list") {
        const limit = clampLimit(params.limit, DEFAULT_LIST_LIMIT);
        const rows = await listProjectSessions(sessionsRoot, scope, limit);
        const text =
          rows.map((row) => JSON.stringify(row)).join("\n") ||
          `(no sessions in scope: ${scope})`;
        return textResult(text, { sessions: rows });
      }

      if (params.operation === "read") {
        const sessionId = params.sessionId?.trim() ?? "";
        if (sessionId === "") return textResult("read requires sessionId");
        const slice = await readSessionSlice(
          sessionsRoot,
          scope,
          sessionId,
          clampLimit(params.limit, DEFAULT_READ_LIMIT),
          clampBytes(params.maxBytes, DEFAULT_READ_MAX_BYTES),
        );
        if (slice === undefined) return textResult(`session not found in scope: ${sessionId}`);
        return textResult(slice.text, { file: slice.file });
      }

      const query = params.query?.trim() ?? "";
      if (query === "") return textResult("search requires query");
      const hits = await searchInSessions(
        sessionsRoot,
        scope,
        query,
        clampLimit(params.limit, DEFAULT_SEARCH_LIMIT),
      );
      const text = hits.map((hit) => JSON.stringify(hit)).join("\n") || "(no matches)";
      return textResult(text, { hits });
    },
  });
}
