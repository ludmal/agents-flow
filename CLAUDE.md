# agents-flow

Read `product/STATUS.md` first, and update it in the same change whenever you finish something.

A Claude Code mod (function hooks): `hooks/register.tsx` is the code, `types/index.d.ts` its state contract, `tests/` its tests.

- Check before pushing: `claude plugin validate .` and `claude plugin test <path to this folder>`.
- Raise `version` in `.claude-plugin/plugin.json` with every release, or users keep the old copy.
- Keep the plugin dependency-free: no network, no files, no commands. The README's "Privacy" section must stay true.
