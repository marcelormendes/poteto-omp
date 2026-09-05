// Deterministic generation of pstack role/panel agent files.
//
// Agents are flat `pstack-*.md` files under ~/.omp/agent/agents with OMP
// task-agent frontmatter (name, description, model role alias, tools,
// optional spawns). A tracked manifest under ~/.omp/agent/pstack/
// (generated-agents.json) records what pstack owns so setup can replace and
// remove only its own files. The tool-profile and manifest vocabulary is the
// canonical one from src/core/types.

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type {
  GeneratedAgentEntry,
  GeneratedAgentsManifest,
  PanelRole,
  PstackConfig,
  ScalarRole,
  ToolProfile,
} from "../core/types";
import {
  PANEL_ROLES,
  PSTACK_SCHEMA_VERSION,
  SCALAR_ROLES,
  TOOL_PROFILES,
  panelSeatAgentName,
  scalarAgentName,
} from "../core/types";
import type { PstackPaths } from "../core/paths";
import { PstackError } from "../core/errors";
import { isRecord } from "../core/guards";
import { sha256Hex } from "./schema";

/** Read-only agent tool set (yield is auto-added by OMP for tool lists). */
const READONLY_TOOLS = ["read", "grep", "glob"];
const READONLY_GUIDANCE =
  "Read source with read, grep, and glob. When a necessary fact requires an unavailable command, identify the missing evidence in your result and return so the parent can obtain it. Do not emulate unavailable tools or scan binary Git objects. Keep findings proportional to the task; do not repeat shared context.";

/** A generated agent file, fully rendered. */
export interface GeneratedAgent {
  file: string;
  name: string;
  description: string;
  /** System prompt body (after frontmatter). */
  body: string;
  /** Explicit tool list; emitted only for read-only/coordinator profiles. */
  tools?: string[];
  /** Subagent spawn permissions; emitted only for coordinator agents. */
  spawns?: string[] | "*";
  autoloadSkills?: string[];
  /** ModelRoles alias (`@pstack-*`); null means inherit-parent (no model frontmatter). */
  modelRole: string | null;
  /** Semantic role: scalar name (`feature`) or panel seat (`how-critics-1`). */
  semanticRole: string;
  toolProfile: ToolProfile;
  /** Full rendered markdown (frontmatter + body). */
  content: string;
}

/** Frontmatter view of a generated agent file. */
export interface ParsedAgentFrontmatter {
  name: string;
  description: string;
  model?: string[];
  tools?: string[];
  spawns?: string[] | "*";
  autoloadSkills?: string[];
  thinkingLevel?: string;
  body: string;
}

interface RoleSpec {
  description: string;
  body: string;
  profile: ToolProfile;
}

const SCALAR_SPECS: Record<ScalarRole, RoleSpec> = {
  feature: {
    description:
      "Pstack feature role: implement a complete behavior slice with tests",
    body: "Implement the assigned behavior slice completely with focused tests. Read skill://how first when the subsystem is unfamiliar. Verify against the real surface and report evidence.",
    profile: "writing",
  },
  refactoring: {
    description:
      "Pstack refactoring role: behavior-preserving structural change",
    body: "Make the assigned behavior-preserving structural change. Pin behavior before edits, migrate callers, delete legacy paths in the same wave. Verify with the focused suite.",
    profile: "writing",
  },
  "bug-fix": {
    description:
      "Pstack bug-fix role: reproduce, root-cause, fix with runtime evidence",
    body: "Reproduce the defect on the real surface first, trace to the root cause, fix there, keep a regression test. Never ship a speculative guard.",
    profile: "writing",
  },
  "perf-issue": {
    description: "Pstack perf role: trace measured slowness against a baseline",
    body: "Capture the baseline number and trace first, then make one targeted change and re-measure. Report before/after with the sampling method.",
    profile: "writing",
  },
  hillclimb: {
    description:
      "Pstack hillclimb role: sustained metric improvement, one win per step",
    body: "Advance one metric with looped hypotheses and before/after measurement. One change per step; keep a decision log.",
    profile: "writing",
  },
  "judgment-prose": {
    description: "Pstack judgment role: prose decisions and adjudication",
    body: "Return judgment as structured prose with evidence pointers. No workspace mutation.",
    profile: "read-only",
  },
  hardest: {
    description:
      "Pstack hardest role: cross-cutting design and subtle algorithms",
    body: "Handle the assigned cross-cutting or algorithmic task end to end: ground first, implement, verify against the real surface.",
    profile: "writing",
  },
  "how-explorer": {
    description:
      "Pstack how-explorer role: read-only mechanics or integration evidence",
    body: "Investigate only the assigned slice. Read code and callers; cite exact paths and lines. Return PASS or ISSUES with evidence pointers. Never modify files.",
    profile: "read-only",
  },
  "how-explainer": {
    description: "Pstack how-explainer role: synthesize explorer evidence",
    body: "Synthesize assigned explorer evidence into an end-to-end explanation. Every material claim carries an evidence pointer. Never modify files.",
    profile: "read-only",
  },
  "why-investigator": {
    description:
      "Pstack why-investigator role: source-control and repository archaeology",
    body: "Investigate the assigned evidence category with broad-to-narrow searches. Prefix findings Direct/Indirect/Contradiction/Lead. Workspace mutation is forbidden; use a non-writing posture.",
    profile: "mcp-posture",
  },
  "why-synthesizer": {
    description:
      "Pstack why-synthesizer role: evidence-backed historical explanation",
    body: "Synthesize investigator evidence with explicit epistemics. Separate statements from inference. Workspace mutation is forbidden; use a non-writing posture.",
    profile: "mcp-posture",
  },
  "reflect-tooling": {
    description: "Pstack reflect-tooling role: review through the tooling lens",
    body: "Review the session through the tooling lens only. Workspace mutation is forbidden; return lens findings with evidence pointers.",
    profile: "mcp-posture",
  },
  "reflect-judgment": {
    description:
      "Pstack reflect-judgment role: review through the judgment lens",
    body: "Review the session through the judgment lens only. Workspace mutation is forbidden; return lens findings with evidence pointers.",
    profile: "mcp-posture",
  },
  "reflect-divergent": {
    description: "Pstack reflect-divergent role: contrarian review lens",
    body: "Review the session as a contrarian: missing alternatives, unchallenged assumptions. Workspace mutation is forbidden; return lens findings.",
    profile: "mcp-posture",
  },
  "reflect-synthesizer": {
    description: "Pstack reflect-synthesizer role: durable lesson synthesis",
    body: "Synthesize lens outputs into durable decision-changing lessons only. Workspace mutation is forbidden; propose precise changes, never apply them.",
    profile: "mcp-posture",
  },
  "swarm-worker": {
    description: "Pstack swarm worker role: one disjoint slice, fully owned",
    body: "Complete exactly the assigned slice and nothing else. Stay inside declared ownership. Integrate nothing; return PASS/ISSUES/BLOCKED with evidence and verification.",
    profile: "writing",
  },
};

const PANEL_SPECS: Record<PanelRole, RoleSpec> = {
  "how-critics": {
    description: "Pstack how-critics panel",
    body: "Skeptically assess the assigned explanation against the critique rubric in one pass. Return a scored verdict with exact evidence pointers. Never modify files.",
    profile: "read-only",
  },
  "arena-runners": {
    description: "Pstack arena-runners panel",
    body: "Implement the complete assigned artifact in the assigned isolated checkout only. Return status, artifact pointer, evidence, findings, rationale, rejected alternatives, confidence. Never touch the parent checkout.",
    profile: "writing",
  },
  "arena-cross-judges": {
    description: "Pstack arena-cross-judges panel",
    body: "Score blinded candidates against the rubric and recommend a base with cited evidence. You were selected from a contrasting model family; say nothing about candidate origins. Never modify files.",
    profile: "read-only",
  },
  "architect-runners": {
    description: "Pstack architect-runners panel",
    body: "Produce one complete design from caller usage through module boundaries with rationale, alternatives, and risks. Never modify files.",
    profile: "read-only",
  },
  "interrogate-reviewers": {
    description: "Pstack interrogate-reviewers panel",
    body: "Skeptically review the assigned identical evidence and rubric. Report findings with severity, exact file evidence, and confidence. Make no edits.",
    profile: "read-only",
  },
};

/**
 * Render one agent definition as a full markdown file: OMP task-agent
 * frontmatter (name, description, optional model role alias, tools, spawns)
 * followed by the system prompt body. Deterministic — no timestamps.
 */
export const renderGeneratedAgent = (
  agent: Omit<GeneratedAgent, "content">,
): string => {
  const lines = [
    "---",
    `name: ${agent.name}`,
    `description: ${JSON.stringify(agent.description)}`,
  ];
  if (agent.modelRole !== null) {
    lines.push(`model: ${JSON.stringify(agent.modelRole)}`);
  }
  if (agent.tools !== undefined) {
    lines.push(`tools: [${agent.tools.join(", ")}]`);
  }
  if (agent.spawns !== undefined) {
    lines.push(
      agent.spawns === "*"
        ? `spawns: "*"`
        : `spawns: [${agent.spawns.join(", ")}]`,
    );
  }
  if (agent.autoloadSkills?.length)
    lines.push(`autoloadSkills: ${JSON.stringify(agent.autoloadSkills)}`);
  lines.push("---", "", agent.body, "");
  return lines.join("\n");
};

const withContent = (
  agent: Omit<GeneratedAgent, "content">,
): GeneratedAgent => ({
  ...agent,
  content: renderGeneratedAgent(agent),
});

/**
 * Generate the complete set of role and panel agent files from a validated
 * config. Scalar roles get `pstack-<role>.md`; panel seats get
 * `pstack-<panel>-<n>.md` in configured order. inherit-parent choices produce
 * an agent without a model pin (subagent inherits the session model).
 */
export const generateAgentFiles = (config: PstackConfig): GeneratedAgent[] => {
  const agents: GeneratedAgent[] = [];
  for (const role of SCALAR_ROLES) {
    const spec = SCALAR_SPECS[role];
    const choice = config.roles[role];
    const modelRole =
      choice.type === "model" ? `@${scalarAgentName(role)}` : null;
    agents.push(
      withContent({
        file: `${scalarAgentName(role)}.md`,
        name: scalarAgentName(role),
        description: spec.description,
        body:
          spec.profile === "read-only"
            ? `${spec.body} ${READONLY_GUIDANCE}`
            : spec.body,
        tools: spec.profile === "read-only" ? READONLY_TOOLS : undefined,
        modelRole,
        semanticRole: role,
        toolProfile: spec.profile,
        autoloadSkills:
          spec.profile === "writing" && role !== "swarm-worker"
            ? ["poteto-mode"]
            : undefined,
      }),
    );
  }
  for (const panel of PANEL_ROLES) {
    const spec = PANEL_SPECS[panel];
    config.panels[panel].forEach((choice, index) => {
      const seat = index + 1;
      const name = panelSeatAgentName(panel, seat);
      const modelRole = choice.type === "model" ? `@${name}` : null;
      agents.push(
        withContent({
          file: `${name}.md`,
          name,
          description: `Pstack ${panel} seat ${seat}`,
          body:
            spec.profile === "read-only"
              ? `${spec.body} ${READONLY_GUIDANCE}`
              : spec.body,
          tools: spec.profile === "read-only" ? READONLY_TOOLS : undefined,
          modelRole,
          semanticRole: `${panel}-${seat}`,
          toolProfile: spec.profile,
        }),
      );
    });
  }
  return agents;
};

const parseStringOrList = (
  value: unknown,
  where: string,
): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    return items.length > 0 ? items : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (typeof item !== "string") {
        throw new PstackError(
          "PSTACK_CONFIG_INVALID",
          `${where} must be a list of strings`,
        );
      }
      return item.trim();
    });
    return items.filter((item) => item !== "");
  }
  throw new PstackError(
    "PSTACK_CONFIG_INVALID",
    `${where} must be a string or list of strings`,
  );
};

/**
 * Parse a generated agent file: YAML frontmatter plus body. Required fields
 * are name and description; model/tools/spawns/thinking are optional and
 * normalized (model and tools accept a string or list, spawns accepts `*` or
 * a list). Used to verify generated files and detect drift.
 */
export const parseAgentFrontmatter = (
  content: string,
  filePath = "generated agent",
): ParsedAgentFrontmatter => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (match === null) {
    throw new PstackError(
      "PSTACK_CONFIG_INVALID",
      `${filePath}: missing YAML frontmatter`,
    );
  }
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1], { prettyErrors: true });
  } catch (error) {
    throw new PstackError(
      "PSTACK_CONFIG_INVALID",
      `${filePath}: frontmatter YAML is invalid: ${String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(frontmatter)) {
    throw new PstackError(
      "PSTACK_CONFIG_INVALID",
      `${filePath}: frontmatter must be a mapping`,
    );
  }
  const name =
    typeof frontmatter.name === "string" ? frontmatter.name : undefined;
  const description =
    typeof frontmatter.description === "string"
      ? frontmatter.description
      : undefined;
  if (name === undefined || description === undefined) {
    throw new PstackError(
      "PSTACK_CONFIG_INVALID",
      `${filePath}: frontmatter must define string fields name and description`,
    );
  }
  const model = parseStringOrList(frontmatter.model, `${filePath}: model`);
  const tools = parseStringOrList(frontmatter.tools, `${filePath}: tools`);
  const autoloadSkills = parseStringOrList(
    frontmatter.autoloadSkills,
    `${filePath}: autoloadSkills`,
  );
  const spawns =
    frontmatter.spawns === "*"
      ? "*"
      : parseStringOrList(frontmatter.spawns, `${filePath}: spawns`);
  const thinkingLevel =
    typeof frontmatter.thinkingLevel === "string"
      ? frontmatter.thinkingLevel
      : typeof frontmatter.thinking === "string"
        ? frontmatter.thinking
        : undefined;
  return {
    name,
    description,
    ...(model !== undefined ? { model } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(autoloadSkills !== undefined ? { autoloadSkills } : {}),
    ...(spawns !== undefined ? { spawns } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    body: match[2].replace(/^\r?\n/, ""),
  };
};

const isToolProfile = (value: unknown): value is ToolProfile =>
  (TOOL_PROFILES as readonly string[]).includes(value as string);

const parseManifest = (
  raw: string,
  manifestPath: string,
): GeneratedAgentsManifest => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new PstackError(
      "PSTACK_MANIFEST_INVALID",
      `${manifestPath} is not valid JSON: ${String(error)}`,
      {
        cause: error,
      },
    );
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== PSTACK_SCHEMA_VERSION ||
    !Array.isArray(value.entries)
  ) {
    throw new PstackError(
      "PSTACK_MANIFEST_INVALID",
      `${manifestPath} must be { schemaVersion: ${PSTACK_SCHEMA_VERSION}, entries: [...] }`,
    );
  }
  const entries = value.entries.map((entry): GeneratedAgentEntry => {
    if (!isRecord(entry) || !isToolProfile(entry.toolProfile)) {
      throw new PstackError(
        "PSTACK_MANIFEST_INVALID",
        `${manifestPath} has an invalid manifest entry`,
      );
    }
    if (
      typeof entry.file !== "string" ||
      !/^pstack-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(entry.file) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.semanticRole !== "string" ||
      entry.semanticRole === "" ||
      (entry.modelRole !== null && typeof entry.modelRole !== "string")
    ) {
      throw new PstackError(
        "PSTACK_MANIFEST_INVALID",
        `${manifestPath} has an invalid manifest entry`,
      );
    }
    return {
      file: entry.file,
      sha256: entry.sha256,
      semanticRole: entry.semanticRole,
      toolProfile: entry.toolProfile,
      modelRole: entry.modelRole,
    };
  });
  if (new Set(entries.map((entry) => entry.file)).size !== entries.length) {
    throw new PstackError(
      "PSTACK_MANIFEST_INVALID",
      `${manifestPath} has duplicate manifest entries`,
    );
  }
  return { schemaVersion: PSTACK_SCHEMA_VERSION, entries };
};

/** Read and validate the generated-agent manifest. Returns null when absent. */
export const readGeneratedAgentManifest = async (
  manifestPath: string,
): Promise<GeneratedAgentsManifest | null> => {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PstackError(
      "PSTACK_IO",
      `cannot read generated-agent manifest ${manifestPath}: ${String(error)}`,
      {
        cause: error,
      },
    );
  }
  return parseManifest(raw, manifestPath);
};

/**
 * Build the pstack-owned subset of OMP modelRoles: one `pstack-*` key per
 * model-pinned role and panel seat, value = the exact configured selector
 * (including reasoning suffix). inherit-parent choices contribute no key.
 */
export const buildSemanticModelRoles = (
  config: PstackConfig,
): Record<string, string> => {
  const roles: Record<string, string> = {};
  for (const role of SCALAR_ROLES) {
    const choice = config.roles[role];
    if (choice.type === "model") roles[scalarAgentName(role)] = choice.selector;
  }
  for (const panel of PANEL_ROLES) {
    config.panels[panel].forEach((choice, index) => {
      if (choice.type === "model")
        roles[panelSeatAgentName(panel, index + 1)] = choice.selector;
    });
  }
  return roles;
};

/** Result of applying generated agents: what changed plus rollback/discard. */
export interface AgentApplyResult {
  /** Agent file names installed. */
  installed: string[];
  /** Obsolete pstack-owned file names removed. */
  removed: string[];
  /** Restore the pre-apply state (files, manifest). Safe to call once. */
  rollback(): Promise<void>;
  /** Drop the retained backups after the surrounding transaction succeeded. */
  discard(): Promise<void>;
}

type ApplyOp =
  | { kind: "create"; dest: string }
  | { kind: "replace"; dest: string; backup: string }
  | { kind: "remove"; dest: string; backup: string }
  | { kind: "manifest-write"; dest: string; backup: string | null };

const undoOps = async (ops: ApplyOp[]): Promise<void> => {
  const failures: unknown[] = [];
  for (const op of [...ops].reverse()) {
    try {
      if (op.kind === "create") {
        await unlink(op.dest);
      } else if (op.kind === "replace" || op.kind === "remove") {
        await rename(op.backup, op.dest);
      } else if (op.kind === "manifest-write") {
        if (op.backup !== null) await rename(op.backup, op.dest);
        else await unlink(op.dest);
      }
    } catch (error) {
      if (!(op.kind === "create" && isErrno(error, "ENOENT")))
        failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "generated agent rollback failed");
};

const isErrno = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === code;

/**
 * Apply generated agents atomically and without touching unrelated agents:
 * 1. Refuse (PSTACK_OWNERSHIP_CONFLICT) to overwrite a `pstack-*` file that
 *    is untracked by the previous manifest or whose checksum no longer
 *    matches it (user-modified).
 * 2. Stage every file under a temp dir, validate each via
 *    parseAgentFrontmatter, then rename into place, remove obsolete
 *    manifest-owned files, and write the new manifest — all-or-nothing.
 * 3. Retain backups until the caller either rollback()s (restore) or
 *    discard()s (cleanup). Unrelated agents are never read, written, or
 *    removed.
 */
export const applyGeneratedAgents = async (
  paths: PstackPaths,
  agents: GeneratedAgent[],
): Promise<AgentApplyResult> => {
  const previous = await readGeneratedAgentManifest(
    paths.generatedManifestPath,
  );
  const previousByFile = new Map<string, GeneratedAgentEntry>(
    (previous?.entries ?? []).map((entry) => [entry.file, entry]),
  );
  const owned = new Set(previousByFile.keys());
  for (const entry of previousByFile.values()) {
    const content = await readFile(
      join(paths.generatedAgentsDir, entry.file),
      "utf8",
    ).catch((error) => {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    });
    if (content !== null && sha256Hex(content) !== entry.sha256) {
      throw new PstackError(
        "PSTACK_OWNERSHIP_CONFLICT",
        `${entry.file} was modified since pstack generated it; refusing to replace or remove it`,
      );
    }
  }

  // Ownership and freshness checks before any mutation.
  const existingByFile = new Map<string, string | null>();
  for (const agent of agents) {
    const dest = join(paths.generatedAgentsDir, agent.file);
    let existing: string | null = null;
    try {
      existing = await readFile(dest, "utf8");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw new PstackError(
          "PSTACK_IO",
          `cannot read ${dest}: ${String(error)}`,
          { cause: error },
        );
      }
    }
    existingByFile.set(agent.file, existing);
    if (existing === null) continue;
    const prior = previousByFile.get(agent.file);
    if (prior === undefined) {
      throw new PstackError(
        "PSTACK_OWNERSHIP_CONFLICT",
        `${agent.file} exists in ${paths.generatedAgentsDir} but is not tracked by the pstack manifest; refusing to overwrite it`,
      );
    }
    if (sha256Hex(existing) !== prior.sha256) {
      throw new PstackError(
        "PSTACK_OWNERSHIP_CONFLICT",
        `${agent.file} was modified since pstack generated it; refusing to overwrite it`,
      );
    }
  }

  // Stray pstack-* files that neither the previous manifest nor this apply
  // set owns are an ownership conflict: silently leaving them would let
  // forged or stale files masquerade as generated agents.
  const incoming = new Set(agents.map((agent) => agent.file));
  let present: string[] = [];
  try {
    present = await readdir(paths.generatedAgentsDir);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw new PstackError(
        "PSTACK_IO",
        `cannot list ${paths.generatedAgentsDir}: ${String(error)}`,
        { cause: error },
      );
    }
  }
  const stray = present.filter(
    (file) =>
      file.startsWith("pstack-") && !owned.has(file) && !incoming.has(file),
  );
  if (stray.length > 0) {
    throw new PstackError(
      "PSTACK_OWNERSHIP_CONFLICT",
      `${stray[0]} exists in ${paths.generatedAgentsDir} but is not tracked by the pstack manifest; remove it or move it out of the pstack-* namespace before re-running setup`,
    );
  }

  const newFiles = new Set(agents.map((agent) => agent.file));
  const obsolete = [...owned].filter((file) => !newFiles.has(file));

  const pstackDir = join(paths.agentDir, "pstack");
  await mkdir(pstackDir, { recursive: true });
  const staging = await mkdtemp(join(pstackDir, ".pstack-apply-"));
  const stagedDir = join(staging, "new");
  const backupDir = join(staging, "backup");
  await mkdir(stagedDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });

  const ops: ApplyOp[] = [];
  try {
    for (const agent of agents) {
      parseAgentFrontmatter(agent.content, agent.file);
      await writeFile(join(stagedDir, agent.file), agent.content, "utf8");
    }

    await mkdir(paths.generatedAgentsDir, { recursive: true });
    for (const agent of agents) {
      const dest = join(paths.generatedAgentsDir, agent.file);
      const existing = existingByFile.get(agent.file) ?? null;
      if (existing !== null) {
        const backup = join(backupDir, agent.file);
        await writeFile(backup, existing, "utf8");
        ops.push({ kind: "replace", dest, backup });
      } else {
        ops.push({ kind: "create", dest });
      }
      await rename(join(stagedDir, agent.file), dest);
    }
    for (const file of obsolete) {
      const dest = join(paths.generatedAgentsDir, file);
      let existing: string | null = null;
      try {
        existing = await readFile(dest, "utf8");
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw new PstackError(
            "PSTACK_IO",
            `cannot read ${dest}: ${String(error)}`,
            { cause: error },
          );
        }
      }
      if (existing === null) continue;
      const backup = join(backupDir, file);
      await writeFile(backup, existing, "utf8");
      ops.push({ kind: "remove", dest, backup });
      await unlink(dest);
    }

    const manifest: GeneratedAgentsManifest = {
      schemaVersion: PSTACK_SCHEMA_VERSION,
      entries: agents.map((agent) => ({
        file: agent.file,
        sha256: sha256Hex(agent.content),
        semanticRole: agent.semanticRole,
        toolProfile: agent.toolProfile,
        modelRole: agent.modelRole,
      })),
    };
    const stagedManifest = join(staging, "generated-agents.json");
    await writeFile(
      stagedManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    let manifestBackup: string | null = null;
    let previousManifestRaw: string | null = null;
    try {
      previousManifestRaw = await readFile(paths.generatedManifestPath, "utf8");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw new PstackError(
          "PSTACK_IO",
          `cannot read ${paths.generatedManifestPath}: ${String(error)}`,
          {
            cause: error,
          },
        );
      }
    }
    if (previousManifestRaw !== null) {
      manifestBackup = join(backupDir, "generated-agents.json");
      await writeFile(manifestBackup, previousManifestRaw, "utf8");
    }
    ops.push({
      kind: "manifest-write",
      dest: paths.generatedManifestPath,
      backup: manifestBackup,
    });
    await rename(stagedManifest, paths.generatedManifestPath);
  } catch (error) {
    try {
      await undoOps(ops);
    } catch (rollbackError) {
      throw new PstackError(
        "PSTACK_IO",
        `agent apply failed: ${String(error)}; rollback failed: ${String(rollbackError)}. Backups retained at ${staging}`,
        { cause: error },
      );
    }
    await rm(staging, { recursive: true, force: true });
    throw new PstackError(
      "PSTACK_IO",
      `failed to apply generated agents: ${String(error)}`,
      {
        cause: error,
      },
    );
  }

  let finalized = false;
  const rollback = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    try {
      await undoOps(ops);
    } catch (error) {
      throw new PstackError(
        "PSTACK_IO",
        `rollback failed; backups retained at ${staging}`,
        { cause: error },
      );
    }
    await rm(staging, { recursive: true, force: true });
  };
  const discard = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    await rm(staging, { recursive: true, force: true });
  };
  return {
    installed: agents.map((agent) => agent.file),
    removed: obsolete,
    rollback,
    discard,
  };
};
