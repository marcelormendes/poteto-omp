/**
 * OMP task-capability checks for pstack workflows.
 *
 * pstack depends on precise OMP delegation capabilities: asynchronous workers
 * (Agent Hub), the batch task form, bounded concurrency, recursion depth 2
 * (root -> panel/slice -> worker), and per-call isolation for writers. The
 * check is read-only: it reports what is missing with an actionable fix; it
 * never mutates settings.
 */

/** Capability keys read from OMP settings. */
export type TaskCapabilityKey =
  | "async.enabled"
  | "async.maxJobs"
  | "task.batch"
  | "task.maxConcurrency"
  | "task.maxRecursionDepth"
  | "task.isolation.enabled";

/** One missing or undersized capability. */
export interface CapabilityFinding {
  readonly key: TaskCapabilityKey;
  readonly expected: string;
  readonly actual: string;
  readonly fix: string;
}

interface CapabilitySpec {
  readonly key: TaskCapabilityKey;
  readonly expected: (value: unknown) => boolean;
  readonly expectedLabel: string;
  readonly fix: string;
}

/**
 * Required baseline. `task.isolation.enabled` is mandatory: OMP rejects a
 * per-call `isolated: true` spawn when it is false, and every parallel writer
 * under pstack must be isolated.
 */
const REQUIRED_CAPABILITIES: readonly CapabilitySpec[] = [
  {
    key: "async.enabled",
    expected: (value) => value === true,
    expectedLabel: "true",
    fix: "Enable async workers (setting: async.enabled) so detached workers run under Agent Hub.",
  },
  {
    key: "async.maxJobs",
    expected: (value) => typeof value === "number" && value >= 100,
    expectedLabel: ">= 100",
    fix: "Raise async.maxJobs to at least 100 (pstack panels plus swarm slices run concurrently).",
  },
  {
    key: "task.batch",
    expected: (value) => value === true,
    expectedLabel: "true",
    fix: "Enable the batch task form (setting: task.batch) so one call can carry { context, tasks[] }.",
  },
  {
    key: "task.maxConcurrency",
    expected: (value) => typeof value === "number" && value >= 32,
    expectedLabel: ">= 32",
    fix: "Raise task.maxConcurrency to at least 32 (a full panel is 4 seats, a swarm up to 8 slices).",
  },
  {
    key: "task.maxRecursionDepth",
    expected: (value) => typeof value === "number" && value >= 2,
    expectedLabel: ">= 2",
    fix: "Raise task.maxRecursionDepth to at least 2 (root -> panel/slice -> worker).",
  },
  {
    key: "task.isolation.enabled",
    expected: (value) => value === true,
    expectedLabel: "true",
    fix: "Enable task.isolation.enabled — OMP rejects isolated:true spawns without it, and every parallel writer must run isolated.",
  },
];

const describe = (value: unknown): string => {
  if (value === undefined) return "unset";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
};

/**
 * Compare current setting values against the pstack baseline.
 *
 * @param getValue synchronous read of one setting by key (bound to the active
 *   Settings in production; an injected map getter in tests). A throwing
 *   getter is treated as unset.
 */
export const checkTaskCapabilities = (
  getValue: (key: TaskCapabilityKey) => unknown,
): CapabilityFinding[] => {
  const findings: CapabilityFinding[] = [];
  for (const spec of REQUIRED_CAPABILITIES) {
    let value: unknown;
    try {
      value = getValue(spec.key);
    } catch {
      value = undefined;
    }
    if (!spec.expected(value)) {
      findings.push({
        key: spec.key,
        expected: spec.expectedLabel,
        actual: describe(value),
        fix: spec.fix,
      });
    }
  }
  return findings;
};
