# Prompt conventions

- Import system templates from `src/prompts/templates/` through the
  esbuild text loader. The complete asset byte check is in
  `test/tooling/assets.ts`.
- Concatenate system pieces without separators: whitespace belongs to
  the template assets. Test assembly using whole asset containment and
  order rather than asserting prompt wording.
- Override paths arrive resolved by the config layer. Read their text
  verbatim, including empty files; only the base is replaced. Keep read
  failures as ordinary errors so CLI error classification stays intact.
- Prompt unit tests live in `test/prompts/` and must be imported by
  `test/index.ts` to run in the bundled suite.
- User renderers are pure, typed functions in `render.ts`. Finder data
  stays verbatim; every verifier string passes through `dataText`, and
  verifier inputs deliberately omit finder reasoning. Preserve template
  newlines and use `formatFixed2` for confidence.
- RE2's ASCII word boundary checks both adjacent characters. A captured
  tag ending in folded U+017F is non-word on its left side: before `>`
  there is no boundary, while before ASCII `x` there is one. Checking
  only the following character differs from Go for these inputs.
