# paperclip-kow-smoketest

Run Paperclip agents through **[keys-on-the-wire (kow)](https://github.com/inflightsec/keys-on-the-wire)**
so the agent never holds the raw credential — **with no changes to Paperclip core** —
plus an end-to-end smoke test that proves it live inside a disposable KVM guest.

- **How to integrate:** `INTEGRATION.md` — the `process`-adapter pattern
  (`kow run -- <agent-cmd>`) and the config shape.
- **Proof it works:** the smoke test below, asserting the security claim from real
  evidence captured in the guest.

A native, ergonomic integration (a kow secret-provider + sandbox egress pointed at
kow) is a deeper core change proposed separately — see `INTEGRATION.md` and the PR
description.

## What it proves

An unprivileged `agent` user, wrapped by `kow run`, sends a **placeholder** to a
bound upstream. kow swaps in the real secret on the egress leg only. The test
asserts, from real evidence captured in the guest:

- **A1 — swap on the wire:** the mock upstream receives the real fixture (sha256
  fingerprint matches the stored secret).
- **A2a — no leak:** the real fixture value appears in no channel the agent can
  observe (its env, argv, result file).
- **A3 — audit:** kow logs exactly one allowed `inject_decision` for the bound
  secret and host.

Full acceptance criteria (A0–A8, negative controls, at-rest-read, wrong-CA,
egress hermeticity) and their adversarial-review history are in `SPEC.md`.

## Substrate

Root-free `qemu`/KVM guest run as an unprivileged user (via a world-accessible
`/dev/kvm`), user-mode networking, SSH over a loopback forward. Three isolated
in-guest users — `upstream`, `kowd`, `agent` — enforce that the agent cannot
read the secret at rest. Teardown is a single process kill; nothing persists.

## Prerequisites (host tools)

The smoke test boots a real KVM guest, so the host needs these tools on `PATH`
before the first run:

- `qemu-system-x86_64` and `qemu-img` (the `qemu` / `qemu-system-x86` package)
- `cloud-localds` (from `cloud-image-utils`)
- `ssh` (the OpenSSH client)
- `openssl`
- `curl`
- `bun`

A writable `/dev/kvm` is required for KVM acceleration. The unit tests (`bun test`)
need only `bun`.

## Setup (fetch the base image)

Run this once before the smoke test to download and verify the base cloud image:

```
bun run setup
```

`setup` downloads the pinned Ubuntu *noble* cloud image into `$PKST_SCRATCH/base/`
(default `~/.cache/paperclip-kow-smoketest`) only if it is absent, checks its size
and verifies its SHA-256 against the official `SHA256SUMS`, then prints the resolved
path. The download uses the **system CA bundle**
(`/etc/ssl/certs/ca-certificates.crt`), never a kow/AVP CA. Re-running is a no-op
when the cached image already matches. Override the release channel with
`PKST_NOBLE_CHANNEL`, the mirror with `PKST_BASE_URL`, or hard-pin an exact digest
with `PKST_BASE_SHA256`.

## Run

```
bun test        # pure-logic unit tests (fast)
bun run setup   # one-time: fetch + verify the base image (see above)
bun run smoke   # full boot + provision + live A1/A2a/A3 (~5-6 min)
```

The base cloud image is cached under `$PKST_SCRATCH`
(`~/.cache/paperclip-kow-smoketest` by default); large artifacts never enter git.

## Layout

- `harness/` — `lib.ts`, `up.ts` (boot), `provision.ts` (install + configure).
- `guest/` — `provision.sh`, `start.sh`, `run-agent.sh`, `lib.sh`, the mock
  upstream and agent programs, kow `static`-backend config generation.
- `tests/` — `lib.test.ts` (unit), `smoke-core.ts` (live core assertions).
- `INTEGRATION.md` — the integration pattern (how to run a Paperclip agent via kow).
- `SPEC.md`, `docs/` — spec, boot recipe, review log, status.
