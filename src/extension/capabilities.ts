export const TASK_SETTINGS = {
  "task.batch": true,
  "task.isolation.enabled": true,
  "task.isolation.apply": false,
} as const;

export type TaskCapabilityKey =
  | keyof typeof TASK_SETTINGS
  | "task.maxConcurrency"
  | "task.maxRecursionDepth";
export interface CapabilityFinding {
  readonly key: TaskCapabilityKey;
  readonly expected: string;
  readonly actual: string;
  readonly fix: string;
}

export const checkTaskCapabilities = (
  getValue: (key: TaskCapabilityKey) => unknown,
): CapabilityFinding[] => {
  const findings: CapabilityFinding[] = [];
  for (const key of [
    ...Object.keys(TASK_SETTINGS),
    "task.maxConcurrency",
    "task.maxRecursionDepth",
  ] as TaskCapabilityKey[]) {
    let value: unknown;
    try {
      value = getValue(key);
    } catch {
      value = undefined;
    }
    const expected =
      key === "task.maxConcurrency"
        ? ">= 1 (0 is unlimited)"
        : key === "task.maxRecursionDepth"
          ? ">= 2 (-1 is unlimited)"
          : String(TASK_SETTINGS[key]);
    const valid =
      key === "task.maxConcurrency"
        ? typeof value === "number" && Number.isInteger(value) && value >= 0
        : key === "task.maxRecursionDepth"
          ? typeof value === "number" &&
            Number.isInteger(value) &&
            (value >= 2 || value === -1)
          : value === TASK_SETTINGS[key];
    if (!valid)
      findings.push({
        key,
        expected,
        actual: value === undefined ? "unset" : String(value),
        fix: `Set ${key} to ${expected}; rerun /setup-pstack for the pstack task settings.`,
      });
  }
  return findings;
};
