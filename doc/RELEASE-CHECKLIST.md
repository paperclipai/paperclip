# Release Checklist

The release captain's checklist for every lane. The mechanics live in
[`RELEASING.md`](RELEASING.md); the user-facing channel guide is
[`CHANNELS.md`](CHANNELS.md).

## Canary (automatic, every `master` push)

- [ ] the push's `Release` run is green (verify + publish)
- [ ] `npm view paperclipai@canary version` matches the expected canary
- [ ] Docker `:canary` updated (the same push's `Docker` run)
- [ ] a canary publish failure is a release-infra regression — fix it before
      trusting later promotions

## Nightly (automatic, 09:00 UTC)

- [ ] the scheduled run selected the newest green canary, or skipped with a
      job-summary reason (no new candidate / already shipped / red smoke)
- [ ] the release smoke suite passed against the exact candidate canary
      before anything published
- [ ] `npm view paperclipai@nightly version` shows the new `-nightly.N`
- [ ] `nightly/v*` tag pushed; `:nightly` and `:nightly-cloud` images built
- [ ] on a tag-push rejection (workflows-permission error), follow the
      recovery commands in the job summary

To force a nightly: dispatch `release.yml` with `channel: nightly`
(optional exact canary in `source_version`; `dry_run` to preview).

## Beta (manual promotion)

Happy path:

- [ ] pick the nightly to promote (empty `source_version` selects the newest)
- [ ] dispatch `release.yml` with `channel: beta`
- [ ] approve the `npm-beta` environment gate
- [ ] `npm view paperclipai@beta version` shows the new `-beta.N`
- [ ] `beta/v*` tag pushed; `:beta` and `:beta-cloud` images built
- [ ] post-publish smoke (`smoke_beta`) is green

Fix path (cherry-picked candidate):

- [ ] cut `candidate/beta-<target>` from the chosen nightly's source commit
- [ ] cherry-pick only the required fixes; push the branch
- [ ] dispatch `channel: beta` with `candidate_branch`
- [ ] confirm the job summary records the cherry-picked commits and that
      full verification ran on the candidate head
- [ ] after shipping: reconcile the fixes to `master`, delete the branch

## Stable (manual promotion)

- [ ] pick the beta to promote; its source commit is `source_ref`
- [ ] the beta has soaked ≥ 3 days with no open beta-blocker issues
- [ ] author `releases/vYYYY.MDD.P.md` on that source ref
- [ ] dispatch `release.yml` with `channel: stable` (a dry run first shows
      the resolved version and soak state without publishing)
- [ ] approve the `npm-stable` environment gate
- [ ] `npm view paperclipai version` (dist-tag `latest`) shows the stable
- [ ] `vYYYY.MDD.P` tag pushed; GitHub Release created; `:latest` and the
      versioned Docker tags built
- [ ] if the soak gate was bypassed, `skip_soak_justification` carries a
      real written reason (it lands in the job summary)

Fix path: `candidate/release-<target>` from the beta's source commit; the
soak gate will demand a justification because the exact bits were not
soaked — write one that stands on its own.

## After any incomplete run

The failure playbooks in [`RELEASING.md`](RELEASING.md) cover: red canary,
skipped or failed nightly, a beta that looks bad during soak, partial
stable releases, broken `latest`, and rejected tag pushes. Every publish
job's summary names what completed and what remains.
