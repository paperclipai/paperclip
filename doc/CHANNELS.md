# Release Channels

Paperclip ships on four channels. Pick the one that matches your appetite for
freshness versus stability — switching is just a matter of which version you
install.

| Channel | What it is | Updates | npm | Docker |
| --- | --- | --- | --- | --- |
| `stable` | The recommended release | every week or two | `paperclipai@latest` | `ghcr.io/paperclipai/paperclip:latest` |
| `beta` | Release candidates soaking before stable | when promoted | `paperclipai@beta` | `ghcr.io/paperclipai/paperclip:beta` |
| `nightly` | Yesterday's merges, smoke-tested as a unit | once a night | `paperclipai@nightly` | `ghcr.io/paperclipai/paperclip:nightly` |
| `canary` | Every merge to `master`, as it happens | many times a day | `paperclipai@canary` | `ghcr.io/paperclipai/paperclip:canary` |

## Choosing a channel

**stable** is the right choice for almost everyone. It only moves when a
release has been explicitly vetted and promoted by a maintainer, and every
stable must first soak as a beta for at least 3 days.

**beta** is for people who want the next stable early. A beta is a nightly
that a maintainer hand-picked and explicitly promoted behind an approval
gate, and it is re-smoked after publishing. Betas are the release candidates:
what you run on beta today is what stable becomes a few days later.

**nightly** is for people who want new features quickly but not the churn of
tracking every merge. Once a night, the newest master build that published
green is run through the full release smoke suite (real Docker container, real
onboarding flow, browser-driven). Only if that passes does it ship as the
nightly. If smoke fails, there is no nightly that night — the channel never
ships a build that failed its checks.

**canary** is the bleeding edge: it publishes on every merge to `master`.
It is primarily the lane that continuously exercises our release automation,
but it's available to anyone who wants the newest bits and accepts the risk.

## Installing from a channel

npm / npx:

```bash
npx paperclipai@latest onboard    # stable
npx paperclipai@beta onboard
npx paperclipai@nightly onboard
npx paperclipai@canary onboard
```

Docker:

```bash
docker pull ghcr.io/paperclipai/paperclip:latest    # stable
docker pull ghcr.io/paperclipai/paperclip:beta
docker pull ghcr.io/paperclipai/paperclip:nightly
docker pull ghcr.io/paperclipai/paperclip:canary
```

Every image is also published as `:sha-<short-sha>` for exact pinning, and
stable images additionally get `:YYYY.MDD.P` version tags.

## Switching channels

Channel choice is per-install: install from a different tag and you're on that
channel. Moving forward (stable → nightly) is always safe. Moving backward
(nightly → stable) can mean running an older schema than your data was created
with — treat a downgrade like a restore and keep a backup of your data
directory before switching down.

## Reading version strings

The version tells you which channel a build came from:

- `2026.807.0` — stable, published Aug 7 2026
- `2026.807.0-beta.0` — beta promoted on Aug 7 2026
- `2026.807.0-nightly.0` — nightly cut on Aug 7 2026
- `2026.807.0-canary.4` — the fifth canary for the Aug 7 line

Each promotion republishes the exact source commit of the previous lane's
build: a nightly shares its source SHA with a canary, and a beta with a
nightly. The version dates the promotion, and the shared SHA is visible in
the release job summaries and as git tags on the commit.

One quirk to be aware of: npm's semver ordering compares prerelease names
alphabetically, so `-beta.N` sorts below `-canary.N`, which sorts below
`-nightly.N` for the same base version. This never matters when installing by
dist-tag (the recommended way), only if you write version ranges by hand.

## For maintainers

The publishing mechanics, promotion flow, and release checklist live in
[`RELEASING.md`](RELEASING.md).
