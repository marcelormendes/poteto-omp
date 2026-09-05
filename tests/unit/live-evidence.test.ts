import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertModelExecution, childEvidence } from "../e2e/live-evidence";

test("configured names and spawn-only records do not count as model execution", () => {
  expect(() => assertModelExecution([], "worker", "provider/model")).toThrow(
    "no assistant response",
  );
  expect(() =>
    assertModelExecution(
      [{ provider: "provider", model: "model", outputTokens: 0 }],
      "worker",
    ),
  ).toThrow("no assistant response");
  expect(() =>
    assertModelExecution(
      [{ provider: "provider", model: "other", outputTokens: 5 }],
      "worker",
      "provider/model",
    ),
  ).toThrow("observed provider/other");
  expect(() =>
    assertModelExecution(
      [
        {
          provider: "provider",
          model: "model",
          outputTokens: 5,
          stopReason: "error",
        },
      ],
      "worker",
    ),
  ).toThrow("error/abort");
});

test("worker proof requires both a collected completion and its actual model transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "pstack-proof-"));
  try {
    const file = join(root, "parent.jsonl");
    await mkdir(join(root, "parent"));
    await writeFile(
      join(root, "parent/child.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          provider: "provider",
          model: "model",
          usage: { output: 12 },
          stopReason: "stop",
        },
      }) + "\n",
    );
    const uncollected = await childEvidence(
      [{ id: "child", agent: "pstack-feature" }],
      file,
    );
    expect(uncollected[0].status).toBe("uncollected");
    const completed = await childEvidence(
      [
        {
          content: [
            {
              text: '<task-result id="child" agent="pstack-feature" status="completed">PASS</task-result>',
            },
          ],
        },
      ],
      file,
    );
    expect(completed[0].status).toBe("completed");
    expect(completed[0].models).toMatchObject([
      { provider: "provider", model: "model", outputTokens: 12 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coordinator cannot hide an uncollected grandchild", async () => {
  const root = await mkdtemp(join(tmpdir(), "pstack-nested-proof-"));
  try {
    await mkdir(join(root, "parent/coordinator"), { recursive: true });
    await writeFile(
      join(root, "parent/coordinator.jsonl"),
      JSON.stringify({
        message: {
          role: "toolResult",
          details: {
            progress: [{ id: "leaf", agent: "pstack-how-explainer" }],
          },
        },
      }),
    );
    await writeFile(
      join(root, "parent/coordinator/leaf.jsonl"),
      JSON.stringify({
        message: {
          role: "assistant",
          provider: "provider",
          model: "model",
          usage: { output: 42 },
        },
      }),
    );
    const proof = await childEvidence(
      [
        {
          text: '<task-result id="coordinator" agent="poteto-agent" status="completed">PASS</task-result>',
        },
      ],
      join(root, "parent.jsonl"),
    );
    expect(proof.map((child) => [child.id, child.status])).toEqual([
      ["coordinator", "completed"],
      ["leaf", "uncollected"],
    ]);
    expect(proof[1].models[0].outputTokens).toBe(42);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
