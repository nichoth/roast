# 44: `doctor`, part 3 -- roundtrip probe on `chat`

**Blocked by:** 43
**Touches:** `src/cli/doctor.ts` (`doctorRoundtripCheck`),
`test/cli/doctor.ts`, fake-server helper for the two-turn tool probe on
the `chat` protocol
**Spec:** `spec/14-doctor-init-skill.md` 2.2 (`<role>-roundtrip`), 3
(`src/cli/doctor.ts`), 5 (doctor); spec.md cross-cutting rule "Network"
**Status:** done

## What to build

`<role>-roundtrip`: the two-turn tool probe through the LLM client and
agent loop from tickets 13 and 14, run after `<role>-endpoint` in the
place ticket 43 left. It uses the swappable `fetch` with the 35 s
timeout from section 3.

This ticket covers the `chat` protocol only. The `responses` and
`anthropic` adapters do not exist yet (tickets 27 and 28); ticket 45
adds roundtrip coverage for them. Do not create those adapters here. A
profile on a protocol with no adapter yet should fail `<role>-roundtrip`
with a plain detail, not crash doctor.

## Acceptance criteria

- [x] The two-turn tool loop passes on `chat` against a fake that
      rejects forced tool choice and changed prefixes.
- [x] A model that skips `doctor_lookup` and guesses the token fails
      `<role>-roundtrip`.
- [x] A configured session header is sent on both probe requests.
- [x] `doctor --json --config <path>` for an approved working `chat`
      config prints a parseable array of at least 8 results and exits
      0. The finder credential detail names `DOCTOR_KEY (profile
      api_key_env)`, and no secret appears in stdout.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
