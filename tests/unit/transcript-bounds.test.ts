import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listProjectSessions,
  readSessionSlice,
  redactText,
  searchInSessions,
} from "../../src/transcripts/session-index";

test("recent sessions win and UTF-8 output stays within its byte cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "pstack-transcript-"));
  try {
    await mkdir(join(root, "project"));
    for (const [name, date] of [
      ["a", "2026-01-01"],
      ["b", "2026-09-04"],
    ]) {
      await writeFile(
        join(root, "project", `${name}.jsonl`),
        [
          { type: "session", id: name, cwd: "/project", timestamp: date },
          {
            type: "message",
            id: "m",
            message: { role: "user", content: "🍠".repeat(800) + "needle" },
          },
        ]
          .map((x) => JSON.stringify(x))
          .join("\n"),
      );
    }
    expect((await listProjectSessions(root, "/project", 1))[0]?.sessionId).toBe(
      "b",
    );
    expect(
      Buffer.byteLength(
        (await readSessionSlice(root, "/project", "b", 10, 1024))!.text,
      ),
    ).toBeLessThanOrEqual(1024);
    expect(
      (await searchInSessions(root, "/project", "needle", 1))[0]?.excerpt,
    ).toContain("needle");
    // Resuming an old conversation makes it more recent than a newer session.
    const resumed = new Date("2030-01-01");
    await utimes(join(root, "project/a.jsonl"), resumed, resumed);
    expect((await listProjectSessions(root, "/project", 1))[0]).toMatchObject({
      sessionId: "a",
      modifiedAt: resumed.toISOString(),
    });
    expect(
      (await searchInSessions(root, "/project", "needle", 1))[0]?.file,
    ).toEndWith("a.jsonl");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redacts arbitrary credential values, not only recognizable provider prefixes", () => {
  expect(
    redactText(
      'api_key: "secret-value-here"\nAuthorization: Bearer private-token\n{"refresh_token":"opaque-value"}',
    ),
  ).not.toContain("secret-value-here");
  expect(redactText('{"refresh_token":"opaque-value"}')).not.toContain(
    "opaque-value",
  );
});

test("recognizes native OMP title records, nested children, and custom session roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pstack-native-transcript-"));
  try {
    await mkdir(join(root, "children"));
    const header = {
      type: "session",
      id: "native-parent",
      cwd: "/project",
      timestamp: "2026-09-04",
    };
    const entries = [
      { type: "title", title: "Native session" },
      header,
      {
        type: "message",
        message: { role: "user", content: "native evidence" },
      },
    ];
    await writeFile(
      join(root, "parent.jsonl"),
      entries.map((e) => JSON.stringify(e)).join("\n"),
    );
    await writeFile(
      join(root, "children/child.jsonl"),
      JSON.stringify({ ...header, id: "native-child" }) + "\n",
    );
    expect(
      (await listProjectSessions(root, "/project"))
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["native-child", "native-parent"]);
    expect(
      (await readSessionSlice(root, "/project", "native-parent"))?.text,
    ).toContain("native evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
