/**
 * Pstack OMP extension entry point.
 *
 * Wires:
 * - `/setup-pstack [--file models.yml]`: configure model roles and generate
 *   pstack agents (interactive flow or file import), then persist atomically.
 * - `/poteto-mode on|off|status`: explicit per-session mode toggle.
 * - `/pstack-status`: doctor report (checksum, drift, capabilities,
 *   prerequisites, mode).
 * - `pstack_route`: resolve roles to generated agent names and live selectors.
 * - `pstack_transcripts`: project-scoped, bounded session transcript access.
 * - before_agent_start injection: full routing contract once per branch
 *   (re-injected after compaction), compact reminder on later turns.
 * - session restore hooks: mode and router state reconstructed from custom
 *   session entries on start, switch, branch, tree, and compaction.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { configurePstack } from "../setup/service";
import { parsePstackConfig, validateCompleteConfig, verifySetupChecksum } from "../setup/schema";
import { bunConfigRunner, readConfigValue, readModelRoles } from "../setup/omp-config";
import { isPstackError } from "../core/errors";
import { isGeneratedAgentsManifest } from "../core/guards";
import { parseYaml } from "../core/yaml";
import { PANEL_ROLES, PSTACK_SCHEMA_VERSION, SCALAR_ROLES, UPSTREAM_COMMIT } from "../core/types";
import type {
  GeneratedAgentsManifest,
  ModelChoice,
  PanelRole,
  PstackConfig,
  ScalarRole,
} from "../core/types";
import { parseModeCommand, parseSetupArgs } from "./commands";
import { activePstackPaths } from "../core/paths";
import {
  MODE_ENTRY,
  ROUTER_ENTRY,
  modeEntryData,
  restoreModeState,
  routerEntryData,
  withRouterLoaded,
} from "./mode-state";
import type { PstackModeState } from "./mode-state";
import { buildFullRouter, buildReminder } from "./router";
import { registerRouteTool } from "./route-tool";
import { registerTranscriptTool } from "../transcripts/tool";
import { inspectPstackStatus } from "./status";
import type { StatusDependencies } from "./status";
import type { TaskCapabilityKey } from "./capabilities";

type ModelLike = { readonly provider: string; readonly id: string };

const ROLE_LABELS: Readonly<Record<ScalarRole, string>> = {
  feature: "Feature implementation",
  refactoring: "Behavior-preserving refactor",
  "bug-fix": "Bug fix with reproduction",
  "perf-issue": "Performance fix against a baseline",
  hillclimb: "Sustained metric improvement",
  "judgment-prose": "Prose judgment and adjudication",
  hardest: "Cross-cutting design (hardest)",
  "how-explorer": "How: explorer (read-only)",
  "how-explainer": "How: explainer (read-only)",
  "why-investigator": "Why: investigator (MCP posture)",
  "why-synthesizer": "Why: synthesizer (MCP posture)",
  "reflect-tooling": "Reflect: tooling lens (MCP posture)",
  "reflect-judgment": "Reflect: judgment lens (MCP posture)",
  "reflect-divergent": "Reflect: divergent lens (MCP posture)",
  "reflect-synthesizer": "Reflect: synthesis (MCP posture)",
  "swarm-worker": "Swarm slice worker",
};

const PANEL_LABELS: Readonly<Record<PanelRole, string>> = {
  "how-critics": "How critics panel",
  "arena-runners": "Arena candidate panel",
  "arena-cross-judges": "Arena cross-judge panel",
  "architect-runners": "Architect design panel",
  "interrogate-reviewers": "Interrogate reviewers panel",
};

const PANEL_SEAT_COUNT = 4;

const defaultSeatCount = (panel: PanelRole, previous: PstackConfig | undefined): number =>
  Math.max(previous?.panels[panel]?.length ?? PANEL_SEAT_COUNT, 1);

const modelSelectors = (models: readonly ModelLike[]): string[] => [
  ...new Set(models.map((model) => `${model.provider}/${model.id}`)),
];

/** Options for one role choice: previous value first, then all live selectors. */
const choiceOptions = (
  selectors: readonly string[],
  previous: ModelChoice | undefined,
): string[] => {
  const ordered =
    previous?.type === "model" ? [previous.selector, ...selectors] : [...selectors];
  return [...new Set(ordered), "inherit-parent"];
};

const toChoice = (picked: string): ModelChoice =>
  picked === "inherit-parent"
    ? { type: "inherit-parent" }
    : { type: "model", selector: picked.trim() };

/**
 * Present every scalar role and every panel seat with OMP UI selections.
 * Returns undefined when the user cancels anywhere — nothing is written then.
 */
const promptForConfig = async (
  ctx: ExtensionCommandContext,
  previous: PstackConfig | undefined,
): Promise<PstackConfig | undefined> => {
  const models = ctx.models.list();
  if (models.length === 0) {
    ctx.ui.notify("No authenticated models are available; authenticate a provider first.", "error");
    return undefined;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("Interactive setup needs the TUI; pass --file models.yml instead.", "error");
    return undefined;
  }
  const selectors = modelSelectors(models);
  const pick = async (
    title: string,
    defaultChoice: ModelChoice | undefined,
  ): Promise<ModelChoice | undefined> => {
    const options = choiceOptions(selectors, defaultChoice);
    const label = await ctx.ui.select(title, options, { initialIndex: 0 });
    return label === undefined ? undefined : toChoice(label);
  };

  const roles = {} as Record<ScalarRole, ModelChoice>;
  for (const role of SCALAR_ROLES) {
    const choice = await pick(ROLE_LABELS[role], previous?.roles[role]);
    if (choice === undefined) return undefined;
    roles[role] = choice;
  }
  const panels = {} as Record<PanelRole, ModelChoice[]>;
  for (const panel of PANEL_ROLES) {
    const seats: ModelChoice[] = [];
    for (let seat = 1; seat <= defaultSeatCount(panel, previous); seat += 1) {
      const choice = await pick(
        `${PANEL_LABELS[panel]} — seat ${seat}`,
        previous?.panels[panel]?.[seat - 1],
      );
      if (choice === undefined) return undefined;
      seats.push(choice);
    }
    panels[panel] = seats;
  }
  return {
    schemaVersion: PSTACK_SCHEMA_VERSION,
    upstreamCommit: UPSTREAM_COMMIT,
    autoEnable: true,
    roles,
    panels,
  };
};

const readOptionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const formatSetupReport = (report: {
  readonly config: PstackConfig;
  readonly agents: readonly unknown[];
  readonly preservedRoles: readonly string[];
  readonly requiresNewSession: boolean;
  readonly modelRoles: Readonly<Record<string, string>>;
}): string => {
  const lines = [
    "Setup complete.",
    `- pstack config: ${activePstackPaths().configPath}`,
    `- generated ${report.agents.length} role agents`,
    `- merged ${Object.keys(report.modelRoles).length} pstack model roles`,
    ...(report.preservedRoles.length > 0
      ? [`- preserved ${report.preservedRoles.length} unrelated model role(s)`]
      : []),
  ];
  if (report.requiresNewSession) {
    lines.push("- reloading OMP to discover the generated agents and model roles");
  }
  return lines.join("\n");
};

const renderStatus = (report: Awaited<ReturnType<typeof inspectPstackStatus>>): string => {
  const lines = [
    `Pstack status: ${report.ok ? "clean" : "attention needed"}`,
    `OMP ${report.ompVersion} / upstream pstack ${report.upstreamPstackVersion} (${report.upstreamCommit.slice(0, 12)})`,
  ];
  if (!report.configPresent) {
    lines.push("Setup: NOT RUN — run /setup-pstack first (or /setup-pstack --file models.yml)");
  } else if (!report.configValid) {
    lines.push(`Setup: config invalid — ${report.configError ?? "unreadable"}`);
  } else if (!report.checksumValid) {
    lines.push(
      `Setup: checksum DRIFT — recorded ${report.recordedChecksum.slice(0, 12) || "(none)"}, recomputed ${report.currentChecksum.slice(0, 12)}`,
    );
  } else {
    lines.push("Setup: config present, checksum valid");
  }
  lines.push(
    `Roles: ${report.configValid ? `${report.scalarRoles} scalar, ${report.panelSeats} panel seats` : "unknown (no valid config)"}`,
  );
  lines.push(
    `Mode: ${report.mode.enabled ? "on" : "off"} (${report.mode.source}${report.mode.routerLoaded ? ", router loaded" : ""})`,
  );
  for (const finding of report.agentDrift) {
    lines.push(`Agent drift: ${finding.file} — ${finding.detail}`);
  }
  if (!report.capabilitiesChecked) {
    lines.push("Capabilities: not checked (settings unavailable)");
  } else {
    for (const finding of report.capabilityFindings) {
      lines.push(
        `Capability ${finding.key}: expected ${finding.expected}, got ${finding.actual}. ${finding.fix}`,
      );
    }
  }
  for (const prerequisite of report.prerequisites) {
    lines.push(
      `Prerequisite ${prerequisite.command}: ${prerequisite.present ? prerequisite.version ?? "installed" : "MISSING"} ` +
        `(${prerequisite.requirementLevel}; for ${prerequisite.requiredFor})`,
    );
  }
  return lines.join("\n");
};

export default function pstackExtension(pi: ExtensionAPI): void {
  let config: PstackConfig | undefined;
  let manifest: GeneratedAgentsManifest | undefined;
  let mode: PstackModeState = { enabled: false, source: "auto", routerLoaded: false };

  registerRouteTool(pi, { getConfig: () => config });
  registerTranscriptTool(pi);

  /** Load config + manifest; restore mode from the session branch. */
  const refreshRuntime = async (ctx: ExtensionContext): Promise<void> => {
    const paths = activePstackPaths();
    const configText = await readOptionalText(paths.configPath);
    if (configText === undefined) {
      config = undefined;
    } else {
      try {
        config = verifySetupChecksum(configText) ? parsePstackConfig(configText) : undefined;
      } catch (error) {
        pi.logger.error(
          `pstack: config unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
        config = undefined;
      }
    }
    const manifestText = await readOptionalText(paths.generatedManifestPath);
    if (manifestText === undefined) {
      manifest = undefined;
    } else {
      try {
        const parsed = parseYaml(manifestText, paths.generatedManifestPath);
        manifest = isGeneratedAgentsManifest(parsed) ? parsed : undefined;
      } catch (error) {
        pi.logger.error(
          `pstack: generated-agents.json unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
        manifest = undefined;
      }
    }
    if (config === undefined) {
      mode = { enabled: false, source: "auto", routerLoaded: false };
      return;
    }
    try {
      mode = restoreModeState(ctx.sessionManager.getBranch(), config);
    } catch (error) {
      if (isPstackError(error) && error.code === "PSTACK_MODE_CORRUPT") {
        pi.logger.error(error.message);
        mode = { enabled: false, source: "auto", routerLoaded: false };
      } else {
        throw error;
      }
    }
  };

  pi.registerCommand("setup-pstack", {
    description:
      "Configure pstack model roles and generate pstack agents (--file imports a models.yml)",
    handler: async (args, ctx) => {
      const parsed = parseSetupArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      try {
        let configInput: PstackConfig;
        if (parsed.file !== undefined) {
          const filePath = isAbsolute(parsed.file) ? parsed.file : join(ctx.cwd, parsed.file);
          configInput = parsePstackConfig(await readFile(filePath, "utf8"));
        } else {
          const previous = await readOptionalText(activePstackPaths().configPath)
            .then((text) => (text === undefined ? undefined : parsePstackConfig(text)))
            .catch(() => undefined);
          const prompted = await promptForConfig(ctx, previous);
          if (prompted === undefined) {
            ctx.ui.notify("Setup cancelled; nothing was written.", "info");
            return;
          }
          configInput = validateCompleteConfig(prompted);
        }
        const report = await configurePstack({
          config: configInput,
          deps: { models: ctx.models, runner: bunConfigRunner(getAgentDir()), agentDir: getAgentDir() },
        });
        ctx.ui.notify(formatSetupReport(report), "info");
        await ctx.reload();
      } catch (error) {
        ctx.ui.notify(
          isPstackError(error)
            ? `${error.code}: ${error.message}`
            : `Setup failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("poteto-mode", {
    description: "Use poteto-mode for a task, or set on|off|status for this session",
    handler: async (args, ctx) => {
      const command = parseModeCommand(args ?? "");
      const action = command.action;
      if (action !== "status") {
        if (config === undefined) {
          ctx.ui.notify("Pstack is not set up. Run /setup-pstack first.", "error");
          return;
        }
        const enabled = action !== "off";
        mode = {
          ...mode,
          enabled,
          source: enabled ? "session-on" : "session-off",
          routerLoaded: enabled ? false : mode.routerLoaded,
        };
        pi.appendEntry(MODE_ENTRY, modeEntryData(enabled));
        if (command.action === "task") {
          pi.sendUserMessage(`Read skill://poteto-mode and follow it for this task:

${command.task}`);
        } else {
          ctx.ui.notify(`Pstack mode ${action} for this session.`, "info");
        }
      } else if (action === "status") {
        ctx.ui.notify(
          config === undefined
            ? "Pstack mode is off (setup missing; run /setup-pstack)."
            : `Pstack mode is ${mode.enabled ? "on" : "off"} (source: ${mode.source}).`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("pstack-status", {
    description:
      "Show pstack setup, checksum, agent drift, capabilities, prerequisites, and mode",
    handler: async (_args, ctx) => {
      await refreshRuntime(ctx);
      let deps: Partial<StatusDependencies> = {};
      try {
        const runner = bunConfigRunner(getAgentDir());
        const keys: TaskCapabilityKey[] = ["task.batch", "task.maxConcurrency", "task.maxRecursionDepth", "task.isolation.enabled", "task.isolation.apply"];
        const entries = await Promise.all(keys.map(async key => [key, await readConfigValue(runner, key)] as const));
        const values = new Map(entries);
        deps = { getTaskValue: key => values.get(key), getModelRoles: () => readModelRoles(runner) };
      } catch {
        deps = {};
      }
      const report = await inspectPstackStatus(activePstackPaths(), mode, deps);
      ctx.ui.notify(renderStatus(report), report.ok ? "info" : "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await refreshRuntime(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await refreshRuntime(ctx);
  });

  pi.on("session_branch", async (_event, ctx) => {
    await refreshRuntime(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await refreshRuntime(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    await refreshRuntime(ctx);
    mode = withRouterLoaded(mode, false);
  });

  pi.on("before_agent_start", async (event) => {
    if (!mode.enabled || config === undefined || !pi.getActiveTools().includes("task")) return;
    if (!mode.routerLoaded) {
      mode = withRouterLoaded(mode, true);
      pi.appendEntry(ROUTER_ENTRY, routerEntryData(Date.now()));
      return {
        message: {
          customType: ROUTER_ENTRY,
          content: buildFullRouter(config, manifest),
          display: false,
          details: {},
        },
        systemPrompt: [...event.systemPrompt],
      };
    }
    return { systemPrompt: [...event.systemPrompt, "", buildReminder(config, mode, manifest)] };
  });
}
