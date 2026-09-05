/**
 * Runtime type guards for externally sourced pstack data (config.yml,
 * generated-agents.json, session entries).
 *
 * Schema validation lives in src/setup/schema.ts; these guards are the narrow
 * primitives that schema, status, and mode-state all share so that "is this
 * record shaped like X?" has one definition.
 */
import { PSTACK_SCHEMA_VERSION, TOOL_PROFILES, type GeneratedAgentEntry, type GeneratedAgentsManifest, type ModelChoice } from "./types";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isString = (value: unknown): value is string => typeof value === "string";

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Model choice shape: `{ type: "model", selector }` or `{ type: "inherit-parent" }`. */
export const isModelChoice = (value: unknown): value is ModelChoice => {
  if (!isRecord(value)) return false;
  if (value.type === "inherit-parent") return true;
  return value.type === "model" && isNonEmptyString(value.selector);
};

/** Generated-agent manifest entry shape. */
export const isGeneratedAgentEntry = (value: unknown): value is GeneratedAgentEntry => {
  if (!isRecord(value)) return false;
  if (typeof value.file !== "string" || !/^pstack-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(value.file)) return false;
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return false;
  if (!isNonEmptyString(value.semanticRole)) return false;
  if (!(TOOL_PROFILES as readonly unknown[]).includes(value.toolProfile)) return false;
  return value.modelRole === null || isString(value.modelRole);
};

/** Generated-agents manifest shape (structural; schemaVersion checked by callers). */
export const isGeneratedAgentsManifest = (value: unknown): value is GeneratedAgentsManifest => {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== PSTACK_SCHEMA_VERSION) return false;
  if (!Array.isArray(value.entries)) return false;
  return value.entries.every(isGeneratedAgentEntry) && new Set(value.entries.map(entry => entry.file)).size === value.entries.length;
};
