# `doc/plans/` — Design Log (append-only)

These are **dated design plans**, not living documentation. Each file is a
record of what was planned on a given date (filename prefix `YYYY-MM-DD-…`).

**Treat them as an append-only log, not a current spec.**

- A plan reflects intent *at its date*. It is **not** updated to match what
  shipped — the code, [`../SPEC.md`](../SPEC.md), the subsystem docs in
  [`../`](..), and [`../../docs/`](../../docs) are the current truth.
- Superseded plans are kept, not deleted — the dated history is the value.
  Where two plans cover the same topic, the **later date wins**.
- Do not link to a plan as the canonical description of a feature. Link to the
  spec or the user doc instead.

When a plan is fully shipped and a real spec/user-doc exists, it stays here as
history. The convention — *dated = historical* — is what resolves the
"active vs historical" ambiguity, so individual files do not need to be moved.
