import { readdir } from "node:fs/promises";

export interface SkillCase {
  id: string;
  skill?: string;
  directPrompt?: boolean;
  prompt: string;
  agents?: Record<string, number>;
  readOnly?: boolean;
  artifact?: string;
  seedHistory?: boolean;
}
const panel = (name: string) =>
  Object.fromEntries([1, 2, 3, 4].map((n) => [`pstack-${name}-${n}`, 1]));
const cases: Record<string, Omit<SkillCase, "id">> = {
  "setup-pstack": {
    prompt:
      "Setup has already completed in this disposable profile. Explain the exact interactive setup, file-based setup, and status commands in under 100 words. Do not change settings or run another setup. This tests the setup skill's guidance; the native setup command is tested separately.",
    readOnly: true,
  },
  how: {
    prompt:
      "Explain how main.ts gets its result. This is a simple utility; use the direct-explain path. Do not change files.",
    agents: { "pstack-how-explainer": 1 },
    readOnly: true,
  },
  why: {
    prompt:
      "Why does total use an initial zero? Use local git history and DECISIONS.md. This is a local-only fixture with no remote services. Do not change files.",
    agents: { "pstack-why-investigator": 1, "pstack-why-synthesizer": 1 },
    readOnly: true,
  },
  interrogate: {
    prompt:
      "Review the uncommitted diff. The sum command must keep returning zero for empty input. Use every configured reviewer seat and the same rubric; do not apply fixes.",
    agents: panel("interrogate-reviewers"),
    readOnly: true,
  },
  swarm: {
    prompt:
      "Use three workers, one each to inspect math.ts, format.ts, and main.ts. Each worker should read its slice and return a brief evidence-backed report. Coverage only; no repository changes.",
    agents: { "pstack-swarm-worker": 3 },
    readOnly: true,
  },
  arena: {
    prompt:
      "Build competing implementations of stable unique(values: number[]): number[] in unique.ts, one per configured arena runner. Keep first occurrence order, including negatives, empty input, and duplicates. Each candidate must test its implementation. Use one contrasting-family cross-judge. Leave every candidate isolated for review; do not apply any patch to this checkout.",
    agents: panel("arena-runners"),
    readOnly: true,
  },
  architect: {
    prompt:
      "Design a ReportFormatter boundary for main.ts so plain text and JSON reports can share the same calculation. Produce competing complete caller-first sketches using every configured architect seat, compare them, and stop after the design. Do not implement or change repository files.",
    agents: panel("architect-runners"),
    readOnly: true,
  },
  reflect: {
    prompt:
      "Reflect on session-notes.md as an explicitly supplied session digest. Use the three lens roles and the configured synthesizer. Return Accepted/Rejected/Backlog. Do not edit skills or file external tickets.",
    agents: {
      "pstack-reflect-tooling": 1,
      "pstack-reflect-judgment": 1,
      "pstack-reflect-divergent": 1,
      "pstack-reflect-synthesizer": 1,
    },
    readOnly: true,
  },
  "create-verification-skill": {
    prompt:
      "Create .omp/skills/verify-number-cli/SKILL.md and its feature map for this CLI. Use actual commands to prove sum, empty input, invalid input, and version. You are authorized to create the local skill and scripts and run all checks. No commit or PR.",
    artifact: ".omp/skills/verify-number-cli/SKILL.md",
  },
  "maintain-verification-skill": {
    prompt:
      "Audit .omp/skills/verify-number-cli. Drive every CLI feature and correct only verified drift in its feature map. You are authorized to edit that local skill. Keep evidence locally; no commit or PR.",
    artifact: ".omp/skills/verify-number-cli/references/features.md",
    agents: { "pstack-how-explorer": 1 },
  },
  "poteto-mode": {
    prompt:
      "Add exported summarize(values: number[]) to main.ts returning {count, sum, average}, with average 0 for empty input. Include regression tests and preserve run(). Implement through the configured feature role, review and apply its patch, then run tests in this checkout. Architect may be skipped with reason because the requested shape is fully specified. You are authorized to apply the implementation locally. No commit, push, or PR.",
    agents: { "pstack-feature": 1 },
    artifact: "main.ts",
  },
  tdd: {
    prompt:
      "Fix average() in math.ts: average([4]) must be 4 and average([]) must be 0. Write a regression test and run it failing before editing production code, then fix and rerun. No commit or PR.",
    artifact: "math.ts",
  },
  "no-comments": {
    prompt:
      "Review and remove the redundant comment in format.ts using Comment Sicko, preserving behavior. You are authorized to apply accepted comment deletions. No commit or PR.",
    agents: { "comment-sicko": 1 },
    artifact: "format.ts",
  },
  "blast-radius": {
    prompt:
      "Inspect the uncommitted change to total(). Prove its effect on empty CLI input by running the real command. Report the broken invariant without fixing it.",
    readOnly: true,
  },
  teach: {
    prompt:
      "Teach me how this three-module number pipeline works and why empty input returns zero. Use how and why, with local git evidence only. Explain briefly, no repository edits.",
    agents: {
      "pstack-how-explainer": 1,
      "pstack-why-investigator": 1,
      "pstack-why-synthesizer": 1,
    },
    readOnly: true,
  },
  recall: {
    prompt:
      "Recall recent work on this fixture from project-scoped transcripts and local git evidence. Report only what the record supports. No edits or external services.",
    readOnly: true,
  },
  "automate-me": {
    prompt:
      "Create .omp/skills/audit-mode/SKILL.md for handle audit. My confirmed preferences are concise prose, local CLI verification with observed output, and no publication without a request. session-notes.md supplies repeated evidence. Use these as my answers to the preference questions; no further questions are needed. Create the local draft only, no commit or PR.",
    artifact: ".omp/skills/audit-mode/SKILL.md",
  },
  "show-me-your-work": {
    prompt:
      "Keep a decision trail at decisions.tsv while verifying the sum, empty-input, and invalid-input CLI commands. Record the actual commands and observations, audit the rows, and obtain a contrasting-model review. No source changes or publication.",
    artifact: "decisions.tsv",
  },
  "figure-it-out": {
    prompt:
      "Design and execute a bounded local readiness audit for this CLI. The done predicate is observed correct sum, zero for empty input, version 1.0.0, and exit 2 for invalid input. This spans inventory, an executable verification script, and a decision trail. Create audit-check.ts and decisions.tsv, run the script, and report evidence. No feature work, commit, or publication.",
    artifact: "audit-check.ts",
  },
  loop: {
    prompt:
      "Run exactly two iterations. On each, invoke bun cli.ts sum 1 2 3 and append its verified output as one line to count.txt. Stop when there are exactly two lines; cap two iterations. No publication.",
    artifact: "count.txt",
  },
  unslop: {
    prompt:
      'Rewrite this sentence as one plain sentence and nothing else: "It is important to note that our robust and seamless calculator leverages cutting-edge summation capabilities to empower users."',
    readOnly: true,
  },
  bro: {
    prompt:
      'Restate this in plain English: "The reducer folds the numeric input sequence into an additive identity and propagates the aggregate to the formatter."',
    readOnly: true,
  },
  "technical-writing": {
    prompt:
      "Write a concise local QUICKSTART.md explaining CLI sum, empty input, version and invalid-input behavior. Verify every example against the actual CLI. No source changes or publication.",
    artifact: "QUICKSTART.md",
  },
  "typescript-best-practices": {
    prompt:
      "Review math.ts and main.ts for type-system discipline. Explain one concrete improvement if justified, or state why no additional type machinery is warranted. Read actual source; do not change files.",
    readOnly: true,
  },
};

export async function skillCases(): Promise<SkillCase[]> {
  const names = (
    await readdir(new URL("../../skills/", import.meta.url))
  ).sort();
  return names.map((id) => {
    if (id.startsWith("principle-"))
      return {
        id,
        prompt: `Apply this principle to the Number CLI in this checkout. Read the relevant source, identify one concrete decision the principle changes (or explain with evidence why no change is warranted), and report your reasoning in under 180 words. This is a read-only exercise; do not edit files or start unrelated workflows.`,
        readOnly: true,
      };
    const entry = cases[id];
    if (!entry) throw new Error(`Missing live scenario for ${id}`);
    return { id, ...entry };
  });
}

export const extraSkillCases: SkillCase[] = [
  {
    id: "recall-history",
    skill: "recall",
    seedHistory: true,
    prompt:
      "Recall the six synthetic prior sessions seeded for this project in the disposable profile. They are the intended corpus for this test, so include these fixtures. Partition them into three read-only history workers, two sessions each. This is activity recall only; no external shared-record sweep is needed. Report supported decisions and next actions, with session citations. No edits.",
    agents: { "pstack-swarm-worker": 3 },
    readOnly: true,
  },
  {
    id: "automate-history",
    skill: "automate-me",
    seedHistory: true,
    prompt:
      "Mine the six synthetic prior sessions seeded for this project in the disposable profile using three read-only history workers, two sessions each. They are the intended corpus for this test. Create .omp/skills/audit-mode/SKILL.md for handle audit. Confirmed preferences: concise prose, local CLI verification with observed output, and no publication without a request. Use those as my interview answers. Create the draft only; no commit or PR.",
    agents: { "pstack-swarm-worker": 3 },
    artifact: ".omp/skills/audit-mode/SKILL.md",
  },
  {
    id: "poteto-coordinator",
    skill: "poteto-mode",
    prompt:
      "Delegate this entire bounded task to the installed poteto-agent coordinator: explain main.ts using the configured how-explainer role and return the explanation. The coordinator must actually call that child role. This is read-only; no implementation, design contest, edits, or publication. Collect the coordinator and all of its children.",
    agents: { "poteto-agent": 1, "pstack-how-explainer": 1 },
    readOnly: true,
  },
  {
    id: "role-dispatch",
    skill: "swarm",
    prompt:
      "Exercise five explicit role assignments as a local model-routing smoke test. Spawn exactly one worker each using pstack-refactoring, pstack-bug-fix, pstack-perf-issue, pstack-hillclimb, and pstack-hardest. Each worker only reads math.ts and returns one relevant observation with a file pointer in under 120 words. Do not run their full implementation workflows or change any files. Collect every worker and report actual models.",
    agents: Object.fromEntries(
      ["refactoring", "bug-fix", "perf-issue", "hillclimb", "hardest"].map(
        (role) => [`pstack-${role}`, 1],
      ),
    ),
    readOnly: true,
  },
  {
    id: "how-critique",
    skill: "how",
    prompt:
      "Explain and critique the whole CLI flow. Exercise the complex path: two exploration angles (calculation and CLI integration), then the explainer, then all four configured critic seats using the same rubric. Keep worker reports concise, cite actual files, and do not edit repository files.",
    agents: {
      "pstack-how-explorer": 2,
      "pstack-how-explainer": 1,
      ...panel("how-critics"),
    },
    readOnly: true,
  },
  {
    id: "natural-how",
    skill: "how",
    directPrompt: true,
    prompt:
      "Explain how this small CLI produces its sum output, with actual file evidence. Do not edit files.",
    agents: { "pstack-how-explainer": 1 },
    readOnly: true,
  },
];
