---
name: container-runtime
description: What build tooling your agent runtime actually has — the Go toolchain (go, gofmt, tinygo) on PATH, and how to use Docker-in-Docker (docker build, docker run, kind) when your adapter has it enabled.
key: paperclipai/bundled/software-development/container-runtime
recommendedForRoles:
  - engineer
tags:
  - containers
  - docker
  - kind
  - go
  - tinygo
  - testing
---

# Container & build runtime

This is what your execution environment provides. Check here before concluding
"tool X isn't installed" — most of the time it is, and the real issue is a stale
PATH assumption or a capability your adapter has not opted into.

## Go toolchain

`go`, `gofmt`, and `tinygo` are baked into the `paperclip-agent` image and are on
`PATH`:

```sh
go version        # e.g. go1.24.4
gofmt -l ./...    # list files needing formatting
tinygo version    # WASM / embedded Go targets
```

Notes:

- If a repo's README tells you to run `PATH=/usr/local/go/bin:$PATH go build ...`,
  that prefix is only needed on a bare base image. On `paperclip-agent`, `go` is
  already on `PATH` — the bare command works.
- `tinygo` shells out to `go`; both come from the same image, so
  `tinygo build -o out.wasm -target=wasm ./...` works without extra setup.
- If `which go` genuinely returns nothing, your agent is running on the **base**
  worker image, not `paperclip-agent`. That's an adapter-config issue (the
  agent's `adapter_config.image` is unset) — flag it rather than self-installing
  Go into your home dir, which is lost on workspace reset.

## Docker-in-Docker (opt-in)

Docker is **only** available when your adapter is configured with
`enableDocker: true`. When it is, a `docker:dind` sidecar runs alongside your
container and `DOCKER_HOST` is preset, so the Docker CLI works out of the box.

Check whether you have it before assuming:

```sh
test -S /var/run/docker.sock && echo "docker available" || echo "no dind sidecar"
echo "$DOCKER_HOST"   # unix:///var/run/docker.sock when enabled
docker info           # talks to the sidecar daemon
```

When enabled you can:

```sh
docker build -t myimage .
docker run --rm myimage
kind create cluster        # nested k8s on top of dind
```

Resource limits & gotchas:

- The dind sidecar defaults to **4 CPU / 8Gi memory** (`dockerCpuLimit` /
  `dockerMemoryLimit` in the adapter config). Heavy stacks (CIAB, orc8r-kind,
  large testcontainers suites) can OOM the daemon at the default — if a build is
  killed mid-layer, request higher limits rather than retrying blindly.
- The pod is **privileged** when DinD is on. This is deliberate and scoped to
  build/test engineering agents; don't treat it as a general capability.
- If you need Docker and `/var/run/docker.sock` is absent, your adapter doesn't
  have `enableDocker: true`. Ask for it to be enabled — don't try to start a
  daemon yourself (you can't, and it isn't the intended path).
