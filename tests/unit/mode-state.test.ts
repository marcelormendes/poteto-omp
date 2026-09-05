import { expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  MODE_ENTRY,
  ROUTER_ENTRY,
  modeEntryData,
  restoreModeState,
} from "../../src/extension/mode-state";
const entry = (customType: string, data: unknown): SessionEntry => ({
  type: "custom",
  id: "fixture",
  parentId: null,
  timestamp: "2026-09-04",
  customType,
  data,
});
test("an explicit valid toggle repairs an older corrupt mode record", () => {
  const branch = [
    entry(MODE_ENTRY, {}),
    entry(MODE_ENTRY, modeEntryData(true)),
  ];
  expect(restoreModeState(branch, undefined).enabled).toBe(true);
  expect(
    restoreModeState(
      [...branch, entry(MODE_ENTRY, modeEntryData(false))],
      undefined,
    ).enabled,
  ).toBe(false);
});
test("a corrupt latest toggle fails closed; corrupt routing metadata simply reloads the contract", () => {
  expect(() =>
    restoreModeState(
      [entry(MODE_ENTRY, { enabled: true, source: "session-off" })],
      undefined,
    ),
  ).toThrow("invalid payload");
  expect(
    restoreModeState([entry(ROUTER_ENTRY, {})], undefined).routerLoaded,
  ).toBe(false);
});
