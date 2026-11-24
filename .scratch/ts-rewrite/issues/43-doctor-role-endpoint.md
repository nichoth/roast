# 43: `doctor`, part 2 -- per-role credential, profile, and endpoint checks

**Blocked by:** 35
**Touches:** `src/cli/doctor.ts` (`doctorChecks` per-role slot,
`doctorEndpointCheck`), `test/cli/doctor.ts`, fake-server helper for
`GET <base>/models`
**Spec:** `spec/14-doctor-init-skill.md` 2.2 ("Per-role checks",
`<role>-endpoint`), 3 (`src/cli/doctor.ts`), 5 (doctor);
`spec/03-trust-credentials.md` 2.14, 5.6 (doctor rows); spec.md
cross-cutting rule "Network"
**Status:** done

## What to build

Fill the per-role slot that ticket 35 left in `doctorChecks`. For
finder, then verifier: `<role>-credential`, `<role>-profile`, and
`<role>-endpoint` (models listing probe), following "Per-role checks" in
2.2. If the config is not trusted, stop before any probe.

`doctorEndpointCheck` uses the swappable `fetch` with the 5 s timeout
from section 3.

The `<role>-roundtrip` check is ticket 44. Do not build it here; leave
the place where it runs after `<role>-endpoint`.

Tests that probe a custom endpoint chdir into a temp Git repo and
approve there, never in this checkout.

## Acceptance criteria

- [x] `doctorEndpointCheck` sends `GET <base>/models` with the bearer
      key (and the `x-api-key` / `anthropic-version` pair for
      `anthropic`), passes on 2xx, and its detail contains no key.
- [x] A withheld ambient key fails the finder credential (naming the
      variable) and the finder profile, and the verifier passes with its
      own key. No endpoint receives the withheld key.
- [x] An unapproved custom endpoint and a seeded Go-era (v1) trust
      record each cause zero requests to the endpoint. After
      `trust --yes` the endpoint is probed.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
