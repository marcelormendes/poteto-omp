/**
 * pstack doctor/status inspection.
 *
 * Reports, without mutating anything: upstream pin and OMP version, setup
 * checksum validity and drift, generated-agent drift against the ownership
 * manifest, OMP task capabilities, external prerequisites (git / gh / gt),
 * and the current mode state.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { VERSION as OMP_VERSION } from "@oh-my-pi/pi-coding-agent";
import { parsePstackConfig, verifySetupChecksum } from "../setup/schema";
import {
  PANEL_ROLES,
  SCALAR_ROLES,
  UPSTREAM_COMMIT,
  UPSTREAM_PSTACK_VERSION,
  panelSeatAgentName,
  scalarAgentName,
} from "../core/types";
import type { PstackConfig } from "../core/types";
import { isGeneratedAgentsManifest } from "../core/guards";
import { parseYaml } from "../core/yaml";
import { currentSetupChecksum } from "./router";
import { checkTaskCapabilities } from "./capabilities";
import type { CapabilityFinding, TaskCapabilityKey } from "./capabilities";
import type { PstackModeState } from "./mode-state";
import type { PstackPaths } from "../core/paths";

export interface AgentDriftFinding {
  readonly file: string;
  readonly kind: "manifest-missing" | "missing" | "checksum" | "manifest-entry-missing" | "unexpected";
  readonly detail: string;
}

export interface PrerequisiteStatus {
  readonly command: string;
  readonly present: boolean;
  readonly version: string | undefined;
  readonly requirementLevel: "required" | "workflow";
  readonly requiredFor: string;
}

export interface PstackStatusReport {
  readonly ompVersion: string;
  readonly upstreamCommit: string;
  readonly upstreamPstackVersion: string;
  readonly configPath: string;
  readonly configPresent: boolean;
  readonly configValid: boolean;
  readonly checksumValid: boolean;
  readonly configError: string | undefined;
  readonly recordedChecksum: string;
  readonly currentChecksum: string;
  readonly scalarRoles: number;
  readonly panelSeats: number;
  readonly agentDrift: readonly AgentDriftFinding[];
  /** False when the Settings reader was unavailable (capabilities unknown). */
  readonly capabilitiesChecked: boolean;
  readonly capabilityFindings: readonly CapabilityFinding[];
  readonly prerequisites: readonly PrerequisiteStatus[];
  readonly mode: PstackModeState;
  /** True when setup is present, checksummed, agents intact, capabilities okay, and git installed. */
  readonly ok: boolean;
}

/** Injectable I/O so unit tests never touch the real filesystem or Settings. */
export interface StatusDependencies {
  readonly readText: (path: string) => Promise<string | undefined>;
  readonly readDir: (path: string) => Promise<string[]>;
  readonly sha256: (content: string) => string;
  readonly getTaskValue: (key: TaskCapabilityKey) => unknown;
  readonly probe: (command: string) => Promise<{ present: boolean; version?: string }>;
}

const ENOENT = "ENOENT";

const defaultReadText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === ENOENT) return undefined;
    throw error;
  }
};

const defaultReadDir = async (path: string): Promise<string[]> => {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === ENOENT) return [];
    throw error;
  }
};

const defaultSha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

/** Probe `<command> --version`; a spawn failure means the CLI is not installed. */
const defaultProbe = async (
  command: string,
): Promise<{ present: boolean; version?: string }> => {
  try {
    const proc = Bun.spawn([command, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, _stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) return { present: false };
    const firstLine = (stdout || "").trim().split("\n")[0]?.trim() ?? "";
    return { present: true, version: firstLine || undefined };
  } catch {
    return { present: false };
  }
};

const PREREQUISITES: readonly {
  command: string;
  requirementLevel: "required" | "workflow";
  requiredFor: string;
}[] = [
  { command: "git", requirementLevel: "required", requiredFor: "worktree isolation, arena candidates, swarm slices" },
  { command: "gh", requirementLevel: "workflow", requiredFor: "opening-a-pr, shipping, babysit, PR workflows" },
  { command: "gt", requirementLevel: "workflow", requiredFor: "stacked PRs and Graphite workflows" },
];

/**
 * Inspect the installed pstack setup.
 *
 * `mode` is the caller's live mode state (this module never owns it). I/O is
 * injectable only for tests; production callers omit `deps` and get Bun/Node
 * implementations.
 */
export const inspectPstackStatus = async (
  paths: PstackPaths,
  mode: PstackModeState,
  deps: Partial<StatusDependencies> = {},
): Promise<PstackStatusReport> => {
  const readText = deps.readText ?? defaultReadText;
  const readDir = deps.readDir ?? defaultReadDir;
  const sha256 = deps.sha256 ?? defaultSha256;
  const probe = deps.probe ?? defaultProbe;

  const capabilitiesChecked = deps.getTaskValue !== undefined;
  const capabilityFindings = capabilitiesChecked
    ? checkTaskCapabilities(deps.getTaskValue as (key: TaskCapabilityKey) => unknown)
    : [];

  const configText = await readText(paths.configPath);
  const configPresent = configText !== undefined;

  let config: PstackConfig | undefined;
  let configError: string | undefined;
  if (configText !== undefined) {
    try {
      config = parsePstackConfig(configText);
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
    }
  }
  const configValid = config !== undefined;
  const checksumValid = configText !== undefined && verifySetupChecksum(configText);

  const drift: AgentDriftFinding[] = [];
  const expectedFiles: string[] = [];
  if (config !== undefined) {
    for (const role of SCALAR_ROLES) expectedFiles.push(`${scalarAgentName(role)}.md`);
    for (const panel of PANEL_ROLES) {
      const seats = config.panels[panel];
      for (let seat = 1; seat <= seats.length; seat += 1) {
        expectedFiles.push(`${panelSeatAgentName(panel, seat)}.md`);
      }
    }
  }

  const manifestText = await readText(paths.generatedManifestPath);
  if (manifestText === undefined) {
    if (config !== undefined) {
      drift.push({
        file: paths.generatedManifestPath,
        kind: "manifest-missing",
        detail: "generated-agents.json is missing; rerun /setup-pstack to rebuild the ownership manifest.",
      });
    }
  } else {
    let manifestEntries: { file: string; sha256: string }[] | undefined;
    try {
      const parsed = parseYaml(manifestText, paths.generatedManifestPath);
      manifestEntries = isGeneratedAgentsManifest(parsed) ? [...parsed.entries] : undefined;
    } catch {
      manifestEntries = undefined;
    }
    if (manifestEntries === undefined) {
      drift.push({
        file: paths.generatedManifestPath,
        kind: "manifest-missing",
        detail: "generated-agents.json is unreadable or malformed; rerun /setup-pstack to rebuild it.",
      });
    } else {
      const declared = new Set(manifestEntries.map((entry) => entry.file));
      for (const entry of manifestEntries) {
        const agentPath = join(paths.generatedAgentsDir, entry.file);
        const content = await readText(agentPath);
        if (content === undefined) {
          drift.push({
            file: entry.file,
            kind: "missing",
            detail: `Agent file ${entry.file} is declared in the manifest but missing on disk; rerun /setup-pstack.`,
          });
        } else if (sha256(content) !== entry.sha256) {
          drift.push({
            file: entry.file,
            kind: "checksum",
            detail: `Agent file ${entry.file} no longer matches its manifest checksum; rerun /setup-pstack.`,
          });
        }
      }
      for (const file of expectedFiles) {
        if (!declared.has(file)) {
          drift.push({
            file,
            kind: "manifest-entry-missing",
            detail: `Expected agent ${file} has no manifest entry; rerun /setup-pstack.`,
          });
        }
      }
      const actual = await readDir(paths.generatedAgentsDir);
      for (const file of actual) {
        if (/^pstack-.*\.md$/.test(file) && !declared.has(file)) {
          drift.push({
            file,
            kind: "unexpected",
            detail: `pstack-owned agent ${file} is not declared in the manifest (stale from an earlier setup).`,
          });
        }
      }
    }
  }

  const prerequisites: PrerequisiteStatus[] = [];
  for (const prerequisite of PREREQUISITES) {
    const result = await probe(prerequisite.command);
    prerequisites.push({
      command: prerequisite.command,
      present: result.present,
      version: result.version,
      requirementLevel: prerequisite.requirementLevel,
      requiredFor: prerequisite.requiredFor,
    });
  }

  const recordedChecksum = config?.setupChecksum ?? "";
  const currentChecksum = config !== undefined ? currentSetupChecksum(config) : "";

  const scalarRoles = config !== undefined ? SCALAR_ROLES.length : 0;
  const panelSeats =
    config !== undefined
      ? PANEL_ROLES.reduce((total, panel) => total + config.panels[panel].length, 0)
      : 0;

  const gitPresent = prerequisites.find((entry) => entry.command === "git")?.present === true;
  const ok =
    configPresent &&
    configValid &&
    checksumValid &&
    recordedChecksum === currentChecksum &&
    drift.length === 0 &&
    capabilitiesChecked &&
    capabilityFindings.length === 0 &&
    gitPresent;

  return {
    ompVersion: OMP_VERSION,
    upstreamCommit: UPSTREAM_COMMIT,
    upstreamPstackVersion: UPSTREAM_PSTACK_VERSION,
    configPath: paths.configPath,
    configPresent,
    configValid,
    checksumValid,
    configError,
    recordedChecksum,
    currentChecksum,
    scalarRoles,
    panelSeats,
    agentDrift: drift,
    capabilitiesChecked,
    capabilityFindings,
    prerequisites,
    mode,
    ok,
  };
};
