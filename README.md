# poteto-omp

Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack)
methodology adapted to Oh My Pi: go deep, verify the real surface, build reusable
tools, and use independent model passes when they improve the result. This port
provides 45 skills, native OMP task agents, model-role setup, and a small routing
extension. The methodology and original MIT-licensed material are Lauren's.

The package is `poteto-omp`; `pstack-*` is its agent/configuration namespace.
Upstream reference: pstack 0.14.8 at `93b00b89ef425a9c1bac0d0b317dfc49c930ac99`.

## Local installation

Requires OMP 18.1.10, Bun 1.3.14 or newer, Git, and authenticated model providers.
GitHub workflows additionally need `gh`. Local workflows do not need a cloud
agent service, SSH, Tailscale, or Graphite.

```bash
bun install --frozen-lockfile
bun run build:plugin
omp plugin link "$PWD/dist/pstack-omp" --json
omp
```

Inside OMP, configure each role and panel seat:

```text
/setup-pstack
/pstack-status
```

Setup validates exact authenticated model selectors, generates the agents,
preserves unrelated settings and agents, and reloads OMP. It enables task
batches and isolation, disables automatic patch application, and ensures the
recursion depth permits delegation. Existing worker concurrency limits are
preserved. Edited generated agents cause an ownership conflict; keep or move
those edits before rerunning setup.

Implementation role agents load `poteto-mode` through OMP's native
`autoloadSkills`. Specialist review and exploration agents keep their narrower
briefs. The installed `poteto-agent` coordinator also supports nested delegation.

For reproducible setup, use `/setup-pstack --file /absolute/path/models.yml`.
Quoted paths containing spaces are supported. [The acceptance model file](tests/e2e/models.yml)
shows the schema; replace its selectors with models available to your account.
Use `omp models <provider> --json` to inspect the catalog. Each role choice is
`{ type: model, selector: provider/model:low }` or `{ type: inherit-parent }`.
Configure at least two model families in the cross-judge panel so it can contrast
with the parent. There are no hidden model defaults or silent same-model passes.

With an OMP profile, link and run using that same `--profile <name>`. Setup writes
under the active profile, not another profile's configuration.

## Use

```text
/poteto-mode Implement the requested feature and verify it locally
/skill:how Explain this subsystem
/skill:interrogate Review the current diff
/skill:swarm Audit these independent modules
/skill:create-verification-skill Create a verification skill for this project
```

`/poteto-mode` enables the full workflow for the session; `on`, `off`, and `status`
control its sticky state. `/skill:poteto-mode <task>` invokes the skill directly.
Other skills use `/skill:<name>`, including `/skill:loop` for the bundled bounded
loop workflow. OMP's native `/loop` is a separate command.

Writers use OMP isolation and return retained patches. The parent reviews and
applies changes within the user's requested scope, then verifies the result.
Panels collect every worker through `hub`; spawning a job alone is not success.
`pstack_route` resolves actual configured agents, and `pstack_transcripts`
provides bounded project-scoped history. These tools may appear through OMP's
`xd://` extension gateway.

## Validation

```bash
bun run test
bun run typecheck
bun run build:plugin
bun run verify:generated
bun run test:omp
bun run test:package
bun run test:setup-ui
bun run test:e2e
bun audit
```

`test:omp` checks native link/discovery, sessions, ownership, and uninstall.
`test:package` installs a tarball in a disposable OMP package store outside the
checkout, then checks setup and discovery. OMP 18.1.10's registry installer does
not accept local tarball paths; this test uses Bun to populate the same store.
`test:setup-ui` exercises every interactive model choice, cancellation, and mode
restoration through OMP's real UI request protocol.

`test:e2e` uses real models and consumes provider quota. It creates disposable
profiles and Git fixtures, exercises setup → generated verification → poteto-mode,
and invokes every bundled skill. It fails if a skill is missing from the matrix,
a required worker is missing, a worker remains uncollected, the actual model
differs from its assignment, or an artifact check fails. Parent and child model
usage is read from actual transcripts. Reports live under `.artifacts/` and are
not packaged. Copied credential databases are removed when the run finishes.
Additional scenarios exercise complex `how`, natural-language routing, nested
coordination, role dispatch, and parallel history mining. Synthetic history is
explicitly labeled; it never counts as model-execution evidence. Arena patches
are replayed and tested independently. Automatic OMP QA reporting is disabled
in the test processes.

To rerun selected skills:

```bash
bun run test:e2e --scenarios=how,interrogate,swarm
```

Environment overrides: `PSTACK_TEST_MODEL`, `PSTACK_TEST_MODELS`,
`PSTACK_TEST_TIMEOUT_MS`, `PSTACK_TEST_CONCURRENCY` (default 2),
`PSTACK_TEST_ARTIFACTS`, `PSTACK_TEST_PLUGIN`, and `PSTACK_OMP_BIN`.
The [audit report](docs/audit.md) records findings and evidence.
The repository remains private/unpublished until a separate release decision.
