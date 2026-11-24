# 07: Trust hash v2 and `roast trust`

**Blocked by:** 06
**Touches:** `src/config/trust.ts` (`TrustProjection`, `trustProjection`,
`requiresApproval`, `trustHashDocument`, `trustHash`),
`src/config/canonical.ts` (`canonicalJson`), `src/trust/trust.ts`
(`stateDir`, `trustPath`, `readTrustRecord`, `isApproved`, `approve`),
`src/cli/trust.ts` (`trust` command, `requireTrust`,
`writeTrustSummary`, `promptNoDefault`), `src/cli/terminal.ts` (yes/no
answer parsing if not already there), `test/config/`, `test/trust/`,
`test/cli/`
**Spec:** `spec/03-trust-credentials.md` 2.1-2.11, 2.15, 3 (all but
`credentials.ts`), 5.1-5.4; `docs/adr/0003-trust-hash-v2.md`,
`docs/adr/0001-trusted-project-config.md`; spec.md "Deliberate changes"
4, "Further Notes" (malformed trust record exits 4)
**Status:** done

## What to build

A project config that sends code or credentials anywhere other than a
built-in provider's standard endpoint and key variable, or that overrides
a prompt file, must be approved per clone before Roast sends anything.
`npx roast trust` prints a summary of every security-relevant value
(profiles, endpoints, protocols, credential variables, prompt paths) to
stdout, asks `[y/N]`, and records approval only on consent; `--yes`
records without reading stdin. A config that needs no approval says so
and writes nothing.

The approval hash is v2 (ADR-0003): SHA-256 over RFC 8785 canonical JSON
of the deduplicated, sorted destinations and the fixed-order prompt
overrides, stored as `sha256:<hex>`. `canonicalJson` is in-house and
throws on a lone surrogate. Approvals live in
`<git-common-dir>/roast/trust.json` with `version: 2`, written atomically
with mode `0o600` through `fsutil` (ticket 03). A Go-era `version: 1`
record reads as `legacy`: not approved, and approving replaces it with a
version 2 record. A malformed record makes both `isApproved` and
`approve` throw and leaves the file unchanged.

`requireTrust(dir, cfg, io)` is built and unit-tested here: it does
nothing for configs that need no approval, fails with a usage error
naming `npx roast trust` on non-terminals without reading stdin, prompts
inline on stderr when both stdin and stderr are terminals (swappable
`interactiveTerminals`), and rethrows a record read error as a non-usage
error. Git runs through the shared git runner (ticket 03); terminal
helpers live in `src/cli/terminal.ts` (seam resolution 3), not
`src/cli/prompt.ts`.

Deferred to ticket 20 (they need `review`): a built-in-only config
reviews with no trust state written, an untrusted config fails closed
with zero requests, non-security edits keep approval through a review,
security edits require re-approval before a review, approval shared with
a linked worktree, inline prompting during review, legacy and malformed
records during review (exit 2 and exit 4, zero requests). Stored
credentials are ticket 08.

## Acceptance criteria

- [x] `requiresApproval` matches the single-profile table in 03 section
      5.1 (standard and missing key variables on OpenAI, Anthropic, and
      OpenRouter; implicit endpoint and protocol; trailing slash; custom
      key variable; another provider's variable; mismatched protocol;
      gateway with and without key variable).
- [x] The projection lists roles sorted, author routes after their role,
      excludes unselected profiles, and keeps prompt overrides in fixed
      order.
- [x] `canonicalJson` and `trustHash` reproduce known-answer vectors 1
      and 2 from 03 section 2.4 exactly.
- [x] Duplicate destinations collapse; the hash is independent of role
      order; renaming a profile or changing which role selects an
      already-listed destination keeps the hash; changing an endpoint,
      protocol, credential variable, or prompt path changes it.
- [x] `canonicalJson` sorts keys and escapes strings per RFC 8785,
      including a non-ASCII key and a control character; destinations
      sort by UTF-16 code units (astral vs high-BMP case); empty lists
      hash as `[]`; a lone surrogate throws.
- [x] Trust record in a temp Git repo: absent file is not approved;
      `approve` writes version 2 with one hash and mode `0o600`; approving
      twice keeps one entry.
- [x] A version 1 record reads as `legacy`; `approve` replaces it with
      version 2 holding the new hash.
- [x] Malformed JSON, `version: 3`, missing version, and non-array
      `approved` make `isApproved` and `approve` throw and leave the file
      byte-identical.
- [x] `trust` on a built-in-only config exits 0 and creates no state
      directory.
- [x] `trust` stdout names every profile, endpoint, protocol, credential
      variable, and prompt path of the config (assert presence of the
      config values, not wording).
- [x] Control characters in profile names, route families, and prompt
      paths never reach stdout raw, and no config value starts its own
      output line.
- [x] `trust` records approval for `y`, `Y`, `yes`, and `y` without a
      newline; for `""`, `\n`, `n`, `no`, `yy`, `sure` it exits 2 and
      writes nothing.
- [x] `trust --yes` records approval without reading stdin (a stdin that
      errors on read does not affect it).
- [x] `trust` outside a Git repository, with extra positional arguments,
      with no config, or with an invalid config exits 2.
- [x] `requireTrust` (module seam with injected io): approved -> resolves;
      not approved or legacy on non-terminals -> usage error whose
      message names `npx roast trust`, stdin untouched; simulated
      terminals with `y` -> record written, summary on stderr; declined
      -> usage error, nothing written; malformed record -> non-usage
      error.
- [x] Default terminal detection rejects non-TTY streams.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass, and
      the Go build and `go test ./...` still pass.
