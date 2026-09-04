# poteto-omp

Lauren Tan's pstack methodology as an Oh My Pi package: skills, playbooks,
role-backed agents, and a routing extension. Ported from upstream
`cursor/plugins` pstack. Twin of `poteto-pi` (same methodology, OMP runtime).

## Credits

All methodology is Lauren Tan's ([@poteto](https://x.com/poteto)) pstack:
go deep first, verify against the real surface, build the lever, then
parallelize with confidence. This package contributes only the OMP
adaptation layer. Upstream: https://github.com/cursor/plugins/tree/main/pstack (MIT).
If pstack makes you faster, the credit is hers.

Naming: the package is `poteto-omp`. The `pstack-*` namespace (role agents,
model roles, `~/.omp/agent/pstack/`) is the stable technical namespace
inherited from upstream pstack.

## Requirements

- OMP `18.1.10` (`omp --version`)
- Bun, Git, `gh` only for GitHub-backed workflows

## Build and link

```bash
bun install --frozen-lockfile
bun run build:plugin
omp plugin link "$PWD/dist/pstack-omp" --json
```

## Configure models

```text
/setup-pstack
```

## Verify

```bash
bun test
bun run typecheck
bun run build:plugin
bun run verify:generated
bun run test:omp
bun run test:e2e
```
