/**
 * Stable pstack error codes and the error type carrying them.
 *
 * Codes are part of the public contract: setup validation, mode-state
 * reconstruction, and status reporting surface them to users; skills and
 * tests match on them. Keep codes stable — never rename without a migration.
 */
export type PstackErrorCode =
  | "PSTACK_CONFIG_PARSE"
  | "PSTACK_CONFIG_INVALID"
  | "PSTACK_CONFIG_INCOMPLETE"
  | "PSTACK_IO"
  | "PSTACK_MODEL_SELECTOR"
  | "PSTACK_MODEL_UNAVAILABLE"
  | "PSTACK_NO_CROSS_FAMILY"
  | "PSTACK_REASONING_SUFFIX"
  | "PSTACK_MANIFEST_INVALID"
  | "PSTACK_OWNERSHIP_CONFLICT"
  | "PSTACK_MODE_CORRUPT"
  | "PSTACK_SETUP_MISSING"
  | "PSTACK_UNKNOWN_ROLE"
  | "PSTACK_NO_CONTRASTING_SEAT";

/** Base error for every pstack failure path. */
export class PstackError extends Error {
  readonly code: PstackErrorCode;

  constructor(code: PstackErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PstackError";
    this.code = code;
  }
}

/** Type guard for PstackError. */
export const isPstackError = (value: unknown): value is PstackError =>
  value instanceof PstackError;
