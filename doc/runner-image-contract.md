# Runner image contract

The Runner image is the Runner built alone, as a plain file tree with no
entrypoint and no operating system: the `runner-artifacts` target of the
`Dockerfile`. An image build copies paths out of it instead of compiling the
Runner again. Its name is `ghcr.io/paperclipai/paperclip-runner`. Nothing in
this repository consumes it yet.

Nothing publishes it yet: `.github/workflows/runner-image.yml` builds and
checks it.

## Layout

Every path a consumer may copy (`RUNNER_IMAGE_PATHS` in
`scripts/runner-image-layout.mjs`). Every file is readable by every user.

| Path | Content |
| --- | --- |
| `/runner-image.json` | Identity and description of this image. |
| `/paperclip-runnerd` | The daemon. A stripped release binary, mode `0755`. |
| `/provider-pack/` | The remote provider pack, with `provider-pack.json`. |
| `/provider-pack.archive.json` | Receipt of the pack's transport archives. |
| `/provider-pack.archives/` | The transport archives the receipt lists. |
| `/runner-package/package.json` | The Runner package manifest. |
| `/runner-package/dist/` | The Runner's complete build output. `dist/bin/paperclip-runnerd` is the same file as `/paperclip-runnerd`. |
| `/runner-package/node_modules/.cache/paperclip-runner-build-inputs.json` | The build stamp the Runner's build recorded for that output. |
| `/runner-package/scripts/provision-grok.mjs` | Provisions the native Grok executable. Reads `platforms.json` by relative path. |
| `/runner-package/src/providers/grok/platforms.json` | The Grok release pins. |
| `/runner-package/src/live/runnerd-codex-transport.ts` | The transport source, as a contract file. It defines `RUNNER_CLIENT_VERSION`. |
| `/bundles/runnerd-codex-transport.mjs` | The pack's `dist/live/runnerd-codex-transport.js` as one module. It imports without `node_modules`. |
| `/pnpm-lock.yaml` | The lockfile the image was installed from. |

Paths under `/runner-package/` keep their place inside
`packages/paperclip-runner`. `runner-image.json` describes one platform:

- `inputsDigest` (the identity below) and `buildInputsDigest` (the digest in
  the Runner's build stamp);
- `sourceRevision`: the commit given to the build, also in the pack as
  `payload.runnerSourceRevision`;
- `publication`: `true` only for a build with the build argument
  `PAPERCLIP_RUNNER_IMAGE_PUBLICATION=1`. Only then does the pack carry the
  identity, as `payload.runnerInputsDigest`. Another image build that runs
  the stage inline builds the same Runner but is not this image;
- `platform` (`linux`, `amd64` or `arm64`) and `libc`: the glibc the daemon
  was compiled on (Debian bookworm, the oldest a consumer runs) and the
  newest glibc version it needs;
- `providerPack`: the pack's digest and target;
- `paths` and `sha256`: the table above, and the digest of every single file.

## Identity

An image is named `inputs-<digest>`. `scripts/runner-image-identity.mjs`
computes the digest from:

- every file under the paths the build copies from the build context
  (`RUNNER_IMAGE_CONTEXT_INPUTS`, which include `pnpm-lock.yaml`): path,
  executable bit and content, and each symbolic link by its target;
- the whole `Dockerfile`: the recipe, the base image pinned by digest and the
  toolchain pins. Any edit to it makes a new image;
- the two platforms, `linux/amd64` and `linux/arm64`.

The source revision is not part of it, and neither is the text of
`.dockerignore`: a rule changes the digest only when it changes which of
those files the build receives. The build computes the digest for itself:

```sh
docker buildx build --target runner-artifacts-identity --output type=local,dest=/tmp/identity .
jq -r .digest /tmp/identity/runner-image-identity.json
```

The install is frozen. It fails when the lockfile is behind the manifests the
build reads (the root one, `packages/paperclip-runner` and
`packages/paperclip-eval-kernel`). A contributor cannot edit the lockfile, so
pull-request runs resolve it first. For a local build, run
`pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile`.

## Checks

`node scripts/runner-image-layout.mjs check <tree>` runs in the build and
again on the exported tree. It fails unless:

- every documented path exists, matches its digest in `runner-image.json`,
  and resolves inside the tree;
- the build stamp names the inputs the identity names;
- every artifact in `provider-pack.json` has its digest, the `dist` tree and
  each provider asset tree match their tree digests, and the pack names this
  image's revision and platform;
- the pack names the inputs digest in a publication build and in no other.
  `--expect-inputs-digest` fails on any other build;
- every transport archive matches its receipt, and the archives
  extract to the pack. The check extracts them as a sandbox does (GNU tar
  with the options in `provider-pack-layers.ts`) and compares paths, content,
  link targets and all twelve permission bits, after the `a+rX` grant the
  build makes once the archives are written.

The build also runs `paperclip-runnerd --build-metadata` on every base image
in `docker/runner-image/Dockerfile.smoke`. Add a base there before a consumer
uses it.

## Consuming the image

Read the image only with `COPY --from`, and pin it by digest:

```dockerfile
FROM ghcr.io/paperclipai/paperclip-runner@sha256:<digest> AS runner-artifacts
FROM debian:trixie-slim
COPY --from=runner-artifacts /paperclip-runnerd /usr/local/bin/paperclip-runnerd
```

A Dockerfile with a `runner-artifacts` stage of its own, as in this
repository, can take a built image or tree in its place with
`--build-context runner-artifacts=<image or directory>`. The stage is then
not built.

## Known limits

- A build without `PAPERCLIP_RUNNER_SOURCE_REVISION` or
  `PAPERCLIP_BUILD_COMMIT` has no pack. It is for local use.
- The build runs the steps of the Runner's `build` script that write output,
  not its drift checks; repository CI runs those.
- A build that vendors `/runner-package/` reuses `dist` only when its own
  Runner build-inputs digest equals the stamp's. The image computes that
  digest in the `.dockerignore`-filtered context; a checkout gives another.
- `# syntax=docker/dockerfile:1.20` is a tag. A new frontend release under it
  does not change the identity.
- The archive check does not tell a directory with its own archive member
  from one created only as a file's parent.
