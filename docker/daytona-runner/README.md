# Paperclip Daytona runner image

This image is the Paperclip Cloud fleet sandbox image plus a source-built
`paperclip-runnerd` and immutable provider pack. The pack contains Node 24.11,
OpenCode 1.18.32, the compiled OpenCode proxy, ACPX 0.13.1 sidecar, qualified ACP
agents, and the production lockfile. Its manifest digests each executable bridge
and binds the pack to the runner source revision, avoiding artifact upload and
npm installation on every fresh lease.

The fleet pins are intentionally copied from
[`paperclip-cloud/fleet-sandbox-image/Dockerfile`](https://github.com/paperclipai/paperclip-cloud/blob/master/fleet-sandbox-image/Dockerfile).
Update both definitions together until the fleet base is published as a stable
image that this Dockerfile can extend directly.

## Harness versions

The September 22, 2026 refresh pins Codex 0.156.0, Claude Agent SDK
0.3.280 (Claude Code 2.1.280), and OpenCode 1.18.32 in the shared provider
pack. Claude Code 2.1.280 is the minimum for
[Opus 5.5](https://code.claude.com/docs/en/model-config); it also supports
Fable 5.1. Codex uses the current
[GPT-6 Sol and Luna model IDs](https://learn.chatgpt.com/docs/models).
Grok CLI 1.0.41 supports the current
[Grok 4.7](https://docs.x.ai/developers/grok-4-7) model family.

Keep the patched ACP bridge versions separate from their CLI runtime pins.
Their executable digests do not change when only the runtime dependency
changes. Refresh the runtime executable digests from integrity-verified npm
release archives for every supported platform, and keep the native runner,
provider manifest, and remote controller version checks aligned.

## Build and verify

Run `pnpm --filter @paperclipai/paperclip-runner test:opencode:qualification`
after installing dependencies to exercise the actual pinned OpenCode executable.
It checks health/version, session creation and retrieval, SSE messages, an async
prompt, and session deletion against a loopback mock provider. It uses an
isolated home, starts no paid model request, and retires its process group.
Set `PAPERCLIP_TEST_OPENCODE_BINARY` to the materialized Linux executable when
qualifying an assembled provider pack.


The fleet image is currently amd64-only because the pinned Cursor and GitHub CLI
checksums cover amd64.

```bash
content_id="$(pnpm --silent test:e2e:runner:image-id)"
docker buildx build \
  --platform linux/amd64 \
  --build-arg PAPERCLIP_RUNNER_CONTENT_ID="${content_id}" \
  --build-arg PAPERCLIP_RUNNER_SOURCE_REVISION="$(git rev-parse HEAD)" \
  --tag "paperclip-daytona-runner:e2e-content-${content_id}" \
  --load \
  --file docker/daytona-runner/Dockerfile \
  .

docker run --rm --platform linux/amd64 \
  --entrypoint paperclip-runnerd \
  "paperclip-daytona-runner:e2e-content-${content_id}" \
  --build-metadata
```

The metadata must advertise `dial_ws_loopback`, `dial_wss`, and `listen_ws`.
The explicit entrypoint is needed only for this local probe because Daytona's
base image uses its own long-running sandbox entrypoint.

`test:e2e:runner:image-id` hashes the audited Docker build dependency closure,
target platform, the immutable Dockerfile syntax-frontend digest, and every
immutable `FROM` reference. It fails before the paid workflow can build when
the frontend or a base is not pinned to a sha256 digest. When updating the
syntax version, resolve and review its registry digest and update both values in
the first Dockerfile line. Git commits that do not change those inputs reuse the
same content tag.

`PAPERCLIP_RUNNER_SOURCE_REVISION` remains the full Git SHA that built the first
published copy and is retained as provenance rather than cache identity.

## Use in Paperclip

Publish the image to a registry Daytona can pull, or use the environment
editor's **Configure image** flow to produce a Daytona snapshot. Set the
environment image to that immutable tag or snapshot. Paperclip probes the
sandbox user's `PATH` for `paperclip-runnerd` and `codex` and checks
`/opt/paperclip-runner/provider-pack` for OpenCode and ACPX. It uses the pack
only when its complete manifest matches the controller's build-owned pack;
otherwise it stages the pack configured by
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH`. Remote OpenCode and ACPX never
fall back to host-local processes.

Do not promote `paperclip-runner-e2e-20260826-v2` for OpenCode or ACPX. Build a
new immutable image or snapshot from a clean committed revision and pass that
full Git SHA as `PAPERCLIP_RUNNER_SOURCE_REVISION`.

Do not bake provider credentials, Paperclip bootstrap tickets, or Daytona
preview tokens into this image. They remain per-run secret material.

Provider CLI updates are manifest-only changes: repository CI owns the root
lockfile. The image build resolves the complete workspace manifest graph before
its frozen install, matching CI when a source commit precedes the lockfile bot.
The complete resolved lockfile must match `PAPERCLIP_RUNNER_LOCK_SHA256` before
package installation or lifecycle execution. Review and refresh that digest
with source dependency changes; registry-time resolution drift fails closed.
The Product E2E workflow resolves one lockfile before the image build. It
verifies the downloaded artifact, then passes that artifact's SHA-256 as the
`PAPERCLIP_RUNNER_LOCK_SHA256` build argument. The Dockerfile checks the resolved
lock against this value before installation. The fixed Dockerfile default is
for standalone builds; it must not replace a campaign's verified lock digest.
Keep one latest stable CLI installation per provider; refresh exact runtime
versions and qualification digests together, never install a private older copy
or download dependencies when a task starts.
