import { isRecord } from "../../src/core/guards";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Pstack extension command names that must be discoverable through the native
 * OMP slash-command surface (`available_commands_update` over RPC). Slash-less
 * names, as the RPC protocol reports them.
 */
export const EXPECTED_PSTACK_COMMANDS: ReadonlyArray<string> = [
  "setup-pstack",
  "poteto-mode",
  "pstack-status",
] as const;

/**
 * Collects a machine-readable extension-error ledger from raw frames.
 * The acceptance harness treats ANY extension_error frame as fatal for its
 * session (extension code must load cleanly in a native OMP process).
 */
export interface ExtensionErrorRecord {
  extensionPath: string;
  event: string;
  error: string;
  line: number;
}

export function collectExtensionErrors(
  frames: readonly unknown[],
): ExtensionErrorRecord[] {
  const errors: ExtensionErrorRecord[] = [];
  frames.forEach((frame, line) => {
    if (!isRecord(frame)) return;
    if (frame.type !== "extension_error") return;
    errors.push({
      extensionPath: asString(frame.extensionPath) ?? "<unknown>",
      event: asString(frame.event) ?? "unknown",
      error: asString(frame.error) ?? "unknown",
      line,
    });
  });
  return errors;
}
