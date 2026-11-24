# Trust

`src/config/trust.ts`, `src/config/canonical.ts`, `src/trust/trust.ts`,
`src/cli/trust.ts`. Design: ADR-0001, ADR-0003. How CLI tests approve a
config is in `typescript.md`.

- `trustProjection(cfg)` is the security-relevant projection; its
  `trustHash` covers only endpoint, protocol, credential variable, and
  prompt-override paths. A new security-relevant config field goes into
  the projection, or it can change without re-approval.
- Approvals live in `<git-common-dir>/roast/trust.json`. `roast review`
  calls `requireTrust` before building scope; untrusted is a usage error
  (exit 2), never the findings exit.
- `src/config/trust.ts` (projection, `requiresApproval`, hash v2) is
  pure. `src/config/canonical.ts` is the only JSON canonicalizer; its
  input types must be `type` aliases, not interfaces, to be assignable
  to `CanonicalValue`.
- `src/trust/trust.ts` takes a trailing `{signal, env}` for git.
  `src/cli/trust.ts` has the command, `writeTrustSummary` (every value
  through `textsafe.line`) and `requireTrust(dir, cfg, io)`.
  `promptNoDefault` (`[y/N]`) lives in `src/cli/terminal.ts`.
