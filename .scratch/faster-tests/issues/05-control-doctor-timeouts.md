# 05: Control doctor timeouts in tests

**Blocked by:** 01
**Touches:** `src/cli/doctor.ts`, `test/cli/doctor.ts`,
CLI context and test helpers as needed
**Status:** done

**What to build:** Exercise doctor timeout and cancellation outcomes
without waiting for production-length timeouts, using the smallest useful
injection seam while preserving production behavior.

- [x] A controlled timeout produces the expected observable doctor
  result without waiting for the production timeout.
- [x] Cancellation remains distinguishable and produces the expected
  observable outcome with resources cleaned up.
- [x] Production timeout values remain unchanged and representative
  real-clock integration coverage remains.
