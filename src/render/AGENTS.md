# Report rendering

- Test rendering directly in `test/render/`; import new test modules
  from `test/index.ts`. The review command owns flag validation and
  finalization errors.
- JSON preserves raw strings. Only Markdown goes through `textsafe`.
  Build finding, verdict and usage objects explicitly to preserve their
  field order; sort top-level keys and nested budget keys separately.
- Report usage consumes the client's `RecordUsage` (snake-case fields),
  rather than the protocol adapter's internal `Usage`.
- Preserve absent vs empty collections. Use `deepEqual`, rather than
  tapzero's loose `equal`, when checking null versus undefined.
- Markdown rendering is pure. Stream writes live in `write.ts`, exported
  through `render.ts`; keep JSON before Markdown when writing both.
