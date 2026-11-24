# 45: `doctor`, part 4 -- roundtrip probe on `responses` and `anthropic`

**Blocked by:** 27, 28, 44
**Touches:** `src/cli/doctor.ts` (`doctorRoundtripCheck`),
`test/cli/doctor.ts`, fake-server helpers for the two-turn tool probe on
the `responses` and `anthropic` protocols
**Spec:** `spec/14-doctor-init-skill.md` 2.2 (`<role>-roundtrip`), 5
(doctor)
**Status:** done

## What to build

Extend the `<role>-roundtrip` check from ticket 44 to the `responses` and
`anthropic` protocols, using the adapters from tickets 27 and 28. Reuse
the `chat` probe and its fake; add only what each protocol needs.

## Acceptance criteria

- [x] The roundtrip on a `responses` profile makes exactly two requests
      to `/v1/responses`.
- [x] The two-turn tool loop passes on `responses` and `anthropic`
      against a fake that rejects forced tool choice and changed
      prefixes.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
