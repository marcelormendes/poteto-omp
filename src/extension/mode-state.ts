/**
 * Sticky pstack mode state: per-session on/off plus durable reconstruction.
 *
 * Mode entries are namespaced custom session entries (never sent to the LLM):
 *
 * - `dev.pstack-omp.mode.applied` records an explicit per-session on/off and
 *   its source ("session-on" / "session-off"). The LAST entry on the branch
 *   wins; absence falls back to the setup preference `config.autoEnable`.
 * - `dev.pstack-omp.router.loaded` records that the full routing contract was
 *   already delivered on this branch, so resume/branch do not re-inject it.
 *
 * A corrupted entry fails closed: mode disables and the caller surfaces
 * PstackError(PSTACK_MODE_CORRUPT).
 */
import type { CustomEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { PstackError } from "../core/errors";
import { isRecord } from "../core/guards";
import type { PstackConfig } from "../core/types";

export const MODE_ENTRY = "dev.pstack-omp.mode.applied";
export const ROUTER_ENTRY = "dev.pstack-omp.router.loaded";

/** Durable payload of one mode application. */
export interface ModeEntryData {
  readonly enabled: boolean;
  readonly source: "session-on" | "session-off";
}

/** Durable payload of the router-loaded marker. */
export interface RouterEntryData {
  readonly at: number;
}

/**
 * Current mode state for the session.
 * - enabled: does before_agent_start inject routing?
 * - source: what decided it — setup auto-enable or an explicit session toggle.
 * - routerLoaded: was the full contract already delivered on this branch?
 */
export interface PstackModeState {
  readonly enabled: boolean;
  readonly source: "auto" | "session-on" | "session-off";
  readonly routerLoaded: boolean;
}

export const isModeEntryData = (value: unknown): value is ModeEntryData =>
  isRecord(value) &&
  typeof value.enabled === "boolean" &&
  value.source === (value.enabled ? "session-on" : "session-off");

export const isRouterEntryData = (value: unknown): value is RouterEntryData =>
  isRecord(value) && typeof value.at === "number" && Number.isFinite(value.at);

const isCustomEntry = (entry: SessionEntry, customType: string): entry is CustomEntry =>
  entry.type === "custom" && entry.customType === customType;

/**
 * Reconstruct the mode state from a session branch.
 *
 * @param branch entries of the current leaf path, root first (sessionManager.getBranch()).
 * @param config parsed pstack config, or undefined when setup is missing.
 * @returns enabled/source per the last applied mode entry, else config.autoEnable.
 * @throws PstackError(PSTACK_MODE_CORRUPT) when a mode entry has an invalid
 *   payload — mode is disabled in that case and the caller surfaces the error.
 */
export const restoreModeState = (
  branch: readonly SessionEntry[],
  config: PstackConfig | undefined,
): PstackModeState => {
  let modeEntry: { enabled: boolean; source: "session-on" | "session-off" } | undefined;
  let routerLoaded = false;

  const newestFirst = [...branch].reverse();
  const latestMode = newestFirst.find(entry => isCustomEntry(entry, MODE_ENTRY));
  if (latestMode && isCustomEntry(latestMode, MODE_ENTRY)) {
    if (!isModeEntryData(latestMode.data)) {
      throw new PstackError("PSTACK_MODE_CORRUPT", `Session entry ${MODE_ENTRY} has an invalid payload; pstack mode is disabled. Run /poteto-mode on or off to replace the invalid setting.`);
    }
    modeEntry = latestMode.data;
  }
  const latestRouter = newestFirst.find(entry => isCustomEntry(entry, ROUTER_ENTRY));
  routerLoaded = latestRouter !== undefined && isCustomEntry(latestRouter, ROUTER_ENTRY) && isRouterEntryData(latestRouter.data);

  if (modeEntry) {
    return { ...modeEntry, routerLoaded };
  }
  const enabled =
    config !== undefined &&
    config.autoEnable === true &&
    config.setupChecksum !== undefined &&
    config.setupChecksum.length > 0;
  return { enabled, source: "auto", routerLoaded };
};

/** Build the payload for a mode entry; index.ts appends it on every toggle. */
export const modeEntryData = (enabled: boolean): ModeEntryData => ({
  enabled,
  source: enabled ? "session-on" : "session-off",
});

/** Build the payload for the router-loaded marker. */
export const routerEntryData = (at: number): RouterEntryData => ({ at });

/**
 * Mark the full router as delivered for the remainder of this branch
 * (persisted via appendEntry by the caller) or reset it after compaction so
 * the first post-compaction turn re-injects the full contract.
 */
export const withRouterLoaded = (
  state: PstackModeState,
  routerLoaded: boolean,
): PstackModeState => ({ ...state, routerLoaded });
