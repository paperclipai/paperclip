# Paperclip Daytona runner image

This image is the Paperclip Cloud fleet sandbox image plus a source-built
`paperclip-runnerd` and immutable provider pack. The pack contains Node 24.11,
OpenCode 1.18.34, the compiled OpenCode proxy, ACPX 0.13.1 sidecar, qualified ACP
agents, and the production lockfile. Its manifest digests each executable bridge
and binds the pack to the runner source revision, avoiding artifact upload and
npm installation on every fresh lease.

The fleet pins are intentionally copied from
[`paperclip-cloud/fleet-sandbox-image/Dockerfile`](https://github.com/paperclipai/paperclip-cloud/blob/master/fleet-sandbox-image/Dockerfile).
Update both definitions together until the fleet base is published as a stable
image that this Dockerfile can extend directly.

## Harness versions

The October 2026 refreshes pin Codex 0.160.0, Claude Agent SDK
0.3.286 (Claude Code 2.1.286), and OpenCode 1.18.34 in the shared provider
pack. Claude Code 2.1.280 is the minimum for
[Opus 5.5](https://code.claude.com/docs/en/model-config) and 2.1.284 is the
minimum for Sonnet 5.5; the pinned runtime also supports Fable 5.1. Codex
0.160.0 ships bundled metadata for the current
[GPT-6.1 Sol, GPT-6 Sol, and GPT-6 Luna model IDs](https://learn.chatgpt.com/docs/models).
The same refresh pins Grok CLI 1.0.46, Gemini CLI 0.62.0, Kimi Code 2.1.1,
Cursor CLI 2026.10.01-e373342, and GitHub CLI 2.102.0 in the sandbox layer.
Grok CLI 1.0.46 supports the current
[Grok 4.7](https://docs.x.ai/developers/grok-4-7) model family. Hermes stays
at 0.19.0, the newest release on PyPI.

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

The provider-pack build pins the official Linux x64 Node 24.21.0 image by
manifest digest. Its bundled Undici is 7.29.1, which fixes
[GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v).
Pi separately verifies its private Node executable and nested npm dependency;
changing the outer interpreter does not replace either provider-owned pin.

Provider CLI updates are manifest-only changes: repository CI owns the root
lockfile. Resolve the complete workspace manifest graph in the build context
before invoking Docker, matching CI when a source commit precedes the lockfile
bot. The trusted workflow supplies this resolved lockfile as an immutable artifact.
The complete resolved lockfile must match `PAPERCLIP_RUNNER_LOCK_SHA256` before
package installation or lifecycle execution. Review and refresh that digest
with source dependency changes; registry-time resolution drift fails closed.
The Product E2E workflow resolves one lockfile before the image build. It
verifies the downloaded artifact, then passes that artifact's SHA-256 as the
`PAPERCLIP_RUNNER_LOCK_SHA256` build argument. The Dockerfile checks the resolved
lock against this value before installation. The fixed Dockerfile default is
for standalone builds; it must not replace a campaign's verified lock digest.
Refresh the default from the clean tracked lockfile using the exact
`pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile` command,
and verify a second resolution preserves the digest. A lockfile left by a
filtered or incremental install can retain stale importer patch identities.
Refresh exact runtime versions and qualification digests together; do not
download dependencies when a task starts.

## Candidate ACP qualification assets

Provider branches can build their pinned assets with
`node packages/paperclip-runner/scripts/build-provider-pack.mjs /absolute/pack --candidate-providers=cursor`
(or `copilot` or `pi`). The source revision must include the named provider's
builder. Assets are installed at build time under `provider-assets/<provider>/<platform>-<architecture>`.
The pack manifest binds each complete asset tree. Runtime admission separately
checks the provider's source-owned closure pins and copies a verified launch snapshot.
A pack with candidate assets does not qualify or enable that provider.

For an isolated Linux x64 Daytona qualification image, pass
`--build-arg PAPERCLIP_RUNNER_CANDIDATE_PROVIDERS=cursor` with the normal build arguments.
Compute its content ID with the same selection:
`pnpm --silent test:e2e:runner:image-id --candidate-providers=cursor`.
Candidate assets and the default pack have distinct image identities. Never reuse
the default image's content ID for a candidate build.
Use each provider branch's recorded version and explicit model. Keep credentials
out of images. Paid qualification requires bound provider and Daytona credentials,
inspectable spend, and the shared $100 ceiling recorded in the capability report.

The pack builder tests its copied Node interpreter after relocation. Use a
standalone Node distribution if the host interpreter depends on a package manager's
private shared libraries. Pi additionally pins its complete portable interpreter
and npm dependency graph.
Refresh exact runtime versions and qualification digests together; never download
dependencies when a task starts. Grok's additive native ACP profile keeps its
qualified 1.0.13 executable at the verified sandbox prerequisite path. It does not replace the
legacy adapter's `grok` command on PATH.

Native Grok is an image prerequisite at `/opt/paperclip/providers/grok/1.0.13/grok`.
Its checksum-verified provisioning is separate from the provider pack, which ships
only the built-in launcher. Public npm installation never downloads this binary.
