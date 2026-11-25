# 04: Trust offer after `init` writes a config that needs approval

**What to build:** When the project config `init` just wrote needs trust
approval (`requiresApproval` on its `trustProjection`, as happens with a
custom endpoint or key variable from ticket 03) and the terminals are
interactive, `init` prints the same summary `npx roast trust` prints
(`writeTrustSummary`) and asks for approval with a No default
(`promptNoDefault`). Yes records the approval with the existing trust
hash, exactly as `npx roast trust` would, so the first review is not
refused. No records nothing and prints a hint to run `npx roast trust`
later; `init` still succeeds. The offer comes after the login offer and
the custom key-variable hints. Without interactive terminals there is no
offer. ADR-0001 and ADR-0003 hold: approval is explicit, shows every
security-relevant value, and uses the existing hash.

Docs: README "### 2. Create the project config" (the trust offer).

**Blocked by:** 03

**Touches:** `src/cli/init.ts`, `src/cli/trust.ts` (`writeTrustSummary`),
`src/config/trust.ts` (`trustProjection`, `requiresApproval`,
`trustHash`), `src/trust/trust.ts` (`approve`, `isApproved`),
`src/cli/terminal.ts` (`promptNoDefault`), `test/cli/init.ts`,
`README.md`

**Status:** done

- [x] A custom endpoint with the trust offer answered Yes leaves the
      written config approved for this clone
- [x] A custom endpoint with the trust offer answered No (or Enter)
      leaves the config not approved, and `init` exits successfully
- [x] A config using only built-in providers gets no trust offer and
      reads no stdin for one
- [x] EOF at the trust offer leaves the config not approved and the
      project config written
