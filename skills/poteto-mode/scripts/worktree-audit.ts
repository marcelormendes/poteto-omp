import { resolve } from "node:path";

async function run(args: string[], cwd?: string) {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), code };
}
const root = resolve(process.argv[2] ?? process.cwd());
const listing = await run(
  ["git", "worktree", "list", "--porcelain", "-z"],
  root,
);
if (listing.code) {
  console.error("Not a git repository");
  process.exit(1);
}
const records = listing.stdout.split("\0\0").map((block) =>
  Object.fromEntries(
    block
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf(" ");
        return i < 0 ? [line, "true"] : [line.slice(0, i), line.slice(i + 1)];
      }),
  ),
);
const current = (await run(["git", "rev-parse", "--show-toplevel"], root))
  .stdout;
const base =
  (
    await run(
      ["git", "rev-parse", "--verify", "refs/remotes/origin/main"],
      root,
    )
  ).code === 0
    ? "refs/remotes/origin/main"
    : "refs/heads/main";
console.log(
  "SIZE_KB\tAGE_DAYS\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_SESSION\tBUCKET\tWORKTREE",
);
for (const [index, record] of records.entries()) {
  const wt = record.worktree;
  if (!wt || index === 0) continue;
  const status = await run(["git", "status", "--porcelain"], wt);
  const dirty =
    status.code !== 0 ? "unknown" : status.stdout ? "dirty" : "clean";
  const merged =
    (await run(["git", "merge-base", "--is-ancestor", record.HEAD!, base], wt))
      .code === 0;
  const branch = record.branch?.replace(/^refs\/heads\//, "");
  const remote = branch
    ? await run(
        ["git", "rev-parse", "--verify", `refs/remotes/origin/${branch}`],
        wt,
      )
    : undefined;
  const remoteState = !branch
    ? "detached"
    : remote?.code !== 0
      ? "no-remote"
      : remote.stdout === record.HEAD
        ? "pushed"
        : "diverged";
  const size = await run(["du", "-sk", wt]);
  const timestamp = await run(["git", "log", "-1", "--format=%ct"], wt);
  const age =
    timestamp.code === 0
      ? Math.max(
          0,
          Math.floor(Date.now() / 86400000 - Number(timestamp.stdout) / 86400),
        )
      : "?";
  // "review" is a candidate, never deletion authorization. Open sessions and PRs still need checking.
  const bucket =
    wt === current
      ? "hold-current"
      : record.locked
        ? "hold-locked"
        : dirty !== "clean"
          ? "hold-work"
          : merged
            ? "review-merged"
            : "review-unmerged";
  console.log(
    [
      size.stdout.split(/\s+/)[0] || "?",
      age,
      merged ? "YES" : "no",
      dirty,
      remoteState,
      "unchecked",
      "unchecked",
      bucket,
      wt,
    ].join("\t"),
  );
}
