import { describe, expect, test } from "bun:test";
import { checkTaskCapabilities, type TaskCapabilityKey } from "../../src/extension/capabilities";

const ALL_KEYS: TaskCapabilityKey[] = [
	"async.enabled",
	"async.maxJobs",
	"task.batch",
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.isolation.enabled",
] as const;

function healthyGetter(): (key: TaskCapabilityKey) => unknown {
	const values: Record<TaskCapabilityKey, unknown> = {
		"async.enabled": true,
		"async.maxJobs": 100,
		"task.batch": true,
		"task.maxConcurrency": 32,
		"task.maxRecursionDepth": 2,
		"task.isolation.enabled": true,
	};
	return key => values[key];
}

describe("checkTaskCapabilities", () => {
	test("passes when every baseline capability is satisfied", () => {
		expect(checkTaskCapabilities(healthyGetter())).toEqual([]);
	});

	test("fails closed when the settings source is empty", () => {
		const findings = checkTaskCapabilities(() => undefined);
		expect(findings.map(finding => finding.key).sort()).toEqual(ALL_KEYS.slice().sort());
		for (const finding of findings) {
			expect(finding.expected.length).toBeGreaterThan(0);
			expect(finding.fix.length).toBeGreaterThan(0);
		}
	});

	test("reports a below-baseline concurrency cap", () => {
		const findings = checkTaskCapabilities(
			key => (key === "task.maxConcurrency" ? 24 : healthyGetter()(key)),
		);
		expect(findings).toEqual([
			{
				key: "task.maxConcurrency",
				expected: ">= 32",
				actual: "24",
				fix: "Raise task.maxConcurrency to at least 32 (a full panel is 4 seats, a swarm up to 8 slices).",
			},
		]);
	});

	test("reports a disabled isolation switch (parallel writers must be isolated)", () => {
		const findings = checkTaskCapabilities(
			key => (key === "task.isolation.enabled" ? false : healthyGetter()(key)),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ key: "task.isolation.enabled", actual: "false" });
	});

	test("reports a low job cap and a shallow recursion depth as separate findings", () => {
		const findings = checkTaskCapabilities(
			key =>
				key === "async.maxJobs" ? 50 : key === "task.maxRecursionDepth" ? 1 : healthyGetter()(key),
		);
		expect(findings.map(finding => finding.key).sort()).toEqual(["async.maxJobs", "task.maxRecursionDepth"]);
	});

	test("reports every disabled flag independently (no silent aggregation)", () => {
		const findings = checkTaskCapabilities(
			key => (key === "async.enabled" || key === "task.batch" ? false : healthyGetter()(key)),
		);
		expect(findings.map(finding => finding.key).sort()).toEqual(["async.enabled", "task.batch"]);
	});
});
