# AGENTS.md

Memory Fusion repo rules.

- Canonical package: `@vacinc/memfusion`, plugin id `memfusion`. Never rename either; installs update in place.
- `assets/icon.png` is the plugin icon (square PNG, 512 px). `test/manifest.test.ts` fails if it is missing.
- Behavior changes ship with tests. Before merging: `pnpm test`, `pnpm check`, `pnpm build`.
- Types in `src/types.ts` mirror the OpenClaw memory provider contract. When OpenClaw changes that contract, update them and the README requirements together.
- Keep README install, configuration and release steps accurate whenever behavior or metadata changes.
