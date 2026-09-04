/**
 * Bounded natural-language acceptance scenarios for the separate real-OMP run.
 *
 * Every scenario drives the REAL `omp` CLI over RPC in a separate process and
 * never names its target skill in the prompt: routing must be proven from
 * natural language, not from an explicit `/how`-style invocation. The only
 * exceptions are the native `loop` and `goal` scenarios, which exercise OMP's
 * own `/loop` and `/goal` commands with a bounded predicate.
 *
 * Per-scenario timeouts are wall-clock budgets for the whole scenario
 * (fixture build + prompt + evidence). The harness scales them with
 * `--timeout-scale`.
 */

export type ScenarioId =
	| "how"
	| "why"
	| "architect"
	| "arena"
	| "swarm"
	| "interrogate"
	| "reflect"
	| "feature"
	| "bug"
	| "refactor"
	| "performance"
	| "verification"
	| "loop"
	| "goal";

export interface ScenarioExpectations {
	/** Role agents that MUST appear in the subagent roster (exact names). */
	agents?: string[];
	/** Skills that MUST appear in the root transcript as skill-prompt entries. */
	skills?: string[];
	/** When true, every spawned subagent's final text must carry a status envelope. Default true. */
	requireEnvelope?: boolean;
}

export interface Scenario {
	id: ScenarioId;
	/** "route" = natural-language prompt; "command" = native OMP command (loop/goal). */
	kind: "route" | "command";
	prompt: string;
	/** Human-readable route expectation for the report. */
	expectedRoute: string;
	timeoutMs: number;
	expectations: ScenarioExpectations;
}

/** Default wall-clock budgets (ms). Adjustable with --timeout-scale. */
const T = {
	how: 420_000,
	why: 420_000,
	architect: 480_000,
	arena: 720_000,
	swarm: 720_000,
	interrogate: 420_000,
	reflect: 420_000,
	feature: 600_000,
	bug: 600_000,
	refactor: 600_000,
	performance: 600_000,
	verification: 480_000,
	loop: 360_000,
	goal: 600_000,
} as const;

const PANEL = (role: string, seats = 4): string[] =>
	Array.from({ length: seats }, (_, index) => `pstack-${role}-${index + 1}`);

export const SCENARIOS: readonly Scenario[] = [
	{
		id: "how",
		kind: "route",
		prompt:
			"Before touching anything, explain how the fixture's main.ts reaches its result: which modules it imports, what each does, and the exact call chain with file:line evidence.",
		expectedRoute: "how-explainer single pass (simple fixture per skill)",
		timeoutMs: T.how,
		expectations: { agents: ["pstack-how-explainer"] },
	},
	{
		id: "why",
		kind: "route",
		prompt:
			"The fixture changed this behavior between the initial commit and HEAD. Explain what changed, when, and why, using the repository history as evidence.",
		expectedRoute: "why-investigator + why-synthesizer",
		timeoutMs: T.why,
		expectations: { agents: ["pstack-why-investigator", "pstack-why-synthesizer"] },
	},
	{
		id: "architect",
		kind: "route",
		prompt:
			"Design the module boundary the fixture needs for its next feature: split the current single file so the new report formatter can be added without touching the data layer. Produce one complete design with alternatives and risks.",
		expectedRoute: "architect-runners (4-seat panel)",
		timeoutMs: T.architect,
		expectations: { agents: PANEL("architect-runners") },
	},
	{
		id: "arena",
		kind: "route",
		prompt:
			"Implement the fixture's missing dedup behavior. Build competing candidate implementations and pick the best one by evidence; keep the unselected work isolated and never auto-apply it.",
		expectedRoute: "arena-runners (4 seats) + arena-cross-judges (4 seats)",
		timeoutMs: T.arena,
		expectations: {
			agents: [...PANEL("arena-runners"), ...PANEL("arena-cross-judges")],
			requireEnvelope: true,
		},
	},
	{
		id: "swarm",
		kind: "route",
		prompt:
			"The fixture needs three independent test files covering the three exported functions. Partition the coverage into disjoint slices, one worker per slice, and merge nothing yourself.",
		expectedRoute: "swarm-worker",
		timeoutMs: T.swarm,
		expectations: { agents: ["pstack-swarm-worker"] },
	},
	{
		id: "interrogate",
		kind: "route",
		prompt:
			"A teammate prepared this diff (see fixture diff.md). Review it skeptically against the stated requirements: find what is wrong, what is missing, and what is over-engineered, with exact evidence.",
		expectedRoute: "interrogate-reviewers (4-seat panel)",
		timeoutMs: T.interrogate,
		expectations: { agents: PANEL("interrogate-reviewers") },
	},
	{
		id: "reflect",
		kind: "route",
		prompt:
			"The fixture has a session transcript of a previous run. Extract what should change in how we work on this project next time — the durable lessons, not the trivia.",
		expectedRoute: "reflect tooling/judgment/divergent + synthesizer",
		timeoutMs: T.reflect,
		expectations: {
			agents: [
				"pstack-reflect-tooling",
				"pstack-reflect-judgment",
				"pstack-reflect-divergent",
				"pstack-reflect-synthesizer",
			],
		},
	},
	{
		id: "feature",
		kind: "route",
		prompt:
			"Add a `summarize` function to the fixture's main.ts: it takes an array of numbers and returns the count, sum, and average. Include tests, keep existing behavior intact.",
		expectedRoute: "feature",
		timeoutMs: T.feature,
		expectations: { agents: ["pstack-feature"] },
	},
	{
		id: "bug",
		kind: "route",
		prompt:
			"The fixture's average() returns the wrong value when the array is empty or contains a single element. Reproduce it, find the root cause, and fix it with a regression test.",
		expectedRoute: "bug-fix",
		timeoutMs: T.bug,
		expectations: { agents: ["pstack-bug-fix"] },
	},
	{
		id: "refactor",
		kind: "route",
		prompt:
			"Rename the fixture's `calc` module to `math` and its exported `calcTotal` to `total`, updating every caller. Behavior must be unchanged; prove it with the existing test.",
		expectedRoute: "refactoring",
		timeoutMs: T.refactor,
		expectations: { agents: ["pstack-refactoring"] },
	},
	{
		id: "performance",
		kind: "route",
		prompt:
			"The fixture's doubleLoop function is quadratic. Measure it against a baseline, trace the slow path, and make one targeted improvement. Report before/after with the measurement method.",
		expectedRoute: "perf-issue",
		timeoutMs: T.performance,
		expectations: { agents: ["pstack-perf-issue"] },
	},
	{
		id: "verification",
		kind: "route",
		prompt:
			"The fixture ships a small CLI (bin/tool.sh) whose behavior we need to trust. Set up project verification for it so any future change can be proven on the real command, and exercise it once.",
		expectedRoute: "verification workflow (create-verification-skill)",
		timeoutMs: T.verification,
		expectations: { skills: ["create-verification-skill"] },
	},
	{
		id: "loop",
		kind: "command",
		prompt: "/loop 2 -- append one line per iteration to count.txt until the file has exactly two lines, then stop",
		expectedRoute: "native /loop with iteration cap 2",
		timeoutMs: T.loop,
		expectations: { requireEnvelope: false },
	},
	{
		id: "goal",
		kind: "command",
		prompt: "/goal -- write done.txt containing the fixture's version number, and stop only after the file exists",
		expectedRoute: "native goal mode to a verified predicate",
		timeoutMs: T.goal,
		expectations: { requireEnvelope: false },
	},
] as const;

export function scenarioById(id: string): Scenario | undefined {
	return SCENARIOS.find(scenario => scenario.id === id);
}
