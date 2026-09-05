import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { command, fixture } from "./fixtures";
import type { ChildEvidence } from "./live-evidence";
import { isRecord } from "../../src/core/guards";

export function verifyTddOrder(messages: unknown[]) {
  const testCalls = new Set<string>();
  let productionEdit = -1;
  let red = -1;
  let green = -1;
  messages.forEach((message, index) => {
    if (!isRecord(message)) return;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          !isRecord(part) ||
          part.type !== "toolCall" ||
          !isRecord(part.arguments)
        )
          continue;
        if (
          part.name === "bash" &&
          typeof part.id === "string" &&
          /\bbun test\b/.test(String(part.arguments.command))
        )
          testCalls.add(part.id);
        if (
          productionEdit < 0 &&
          ["edit", "write"].includes(String(part.name)) &&
          /\bmath\.ts\b/.test(JSON.stringify(part.arguments))
        )
          productionEdit = index;
      }
    }
    if (
      message.role === "toolResult" &&
      testCalls.has(String(message.toolCallId))
    ) {
      const text = JSON.stringify(message.content);
      if (
        red < 0 &&
        text.includes("Expected: 4") &&
        text.includes("Received: 2") &&
        /1 fail/.test(text)
      )
        red = index;
      if (
        productionEdit >= 0 &&
        /0 fail/.test(text) &&
        /[1-9]\d* pass/.test(text)
      )
        green = index;
    }
  });
  if (!(red >= 0 && productionEdit > red && green > productionEdit))
    throw new Error(
      "TDD evidence does not prove a failing regression before the production edit and a passing rerun afterward",
    );
  return { red, productionEdit, green };
}

/** Replay the native artifacts independently; completed task labels are not proof. */
export async function verifyArenaArtifacts(
  parent: string,
  children: ChildEvidence[],
) {
  const candidates = children.filter((child) =>
    child.agent.startsWith("pstack-arena-runners-"),
  );
  const workspaces = new Set<string>();
  const results = [];
  for (const child of candidates) {
    if (!child.sessionFile) throw new Error(`${child.id}: missing transcript`);
    const entries = (await readFile(child.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const workspace = entries.find((entry) => entry.type === "session")?.cwd;
    if (!workspace || workspace === parent || workspaces.has(workspace))
      throw new Error(`${child.id}: missing or shared native workspace`);
    workspaces.add(workspace);
    const patch = child.sessionFile.replace(/\.jsonl$/, ".patch");
    const replay = await fixture(`arena-replay-${child.id}`);
    const applied = await command(replay, ["git", "apply", "--", patch]);
    if (applied.code)
      throw new Error(`${child.id}: cannot replay patch: ${applied.stderr}`);
    const writes = new Map<string, string>();
    for (const entry of entries) {
      if (entry.message?.role !== "assistant") continue;
      for (const part of entry.message.content ?? []) {
        if (
          part.type === "toolCall" &&
          part.name === "write" &&
          typeof part.arguments?.path === "string" &&
          typeof part.arguments.content === "string"
        )
          writes.set(basename(part.arguments.path), part.arguments.content);
      }
    }
    for (const file of ["unique.ts", "unique.test.ts"]) {
      const actual = await readFile(join(replay, file), "utf8");
      if (writes.has(file) && writes.get(file) !== actual)
        throw new Error(
          `${child.id}: retained ${file} differs from the worker's write`,
        );
    }
    const tests = await command(replay, ["bun", "test"]);
    const behavior = await command(replay, [
      "bun",
      "-e",
      'import {unique} from "./unique"; for (const [input, expected] of [[[],[]], [[3,-1,3,0,-1,2],[3,-1,0,2]], [[2,2,2],[2]]]) {const before=JSON.stringify(input);const out=unique(input);if(JSON.stringify(out)!==JSON.stringify(expected)||out===input||JSON.stringify(input)!==before)throw Error("unique contract failed");}',
    ]);
    if (tests.code || behavior.code)
      throw new Error(
        `${child.id}: replay verification failed: ${tests.stderr} ${behavior.stderr}`,
      );
    results.push({
      id: child.id,
      workspace,
      patch,
      replay,
      tests: tests.stderr,
      behavior: "pass",
      writesMatch: true,
    });
  }
  if (candidates.length !== 4)
    throw new Error("Arena requires all four candidate artifacts");
  if (await Bun.file(join(parent, "unique.ts")).exists())
    throw new Error("Arena applied an unselected candidate to the parent");
  return results;
}
