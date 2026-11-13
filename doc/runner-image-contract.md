# Runner image contract

The Runner image is the Runner built alone, as a plain file tree with no
entrypoint and no operating system. An image build copies paths out of it
instead of compiling the Runner again. Nothing in this repository consumes it
yet. Its name is `ghcr.io/paperclipai/paperclip-runner`, and one build makes
two variants:

- full, the `runner-artifacts` target of the `Dockerfile`: every path below;
- slim, the `runner-artifacts-slim` target: the same without the two paths
  marked "full only", the provider pack's transport archives.

## Layout

Every path a consumer may copy (`RUNNER_IMAGE_PATHS` in
`scripts/runner-image-layout.mjs`). Every file is readable by every user.

| Path | Content |
| --- | --- |
| `/runner-image.json` | Identity and description of this image. |
| `/paperclip-runnerd` | The daemon. A stripped release binary, mode `0755`. |
| `/provider-pack/` | The remote provider pack, with `provider-pack.json`. |
| `/provider-pack.archive.json` | Full only. Receipt of the pack's transport archives. |
| `/provider-pack.archives/` | Full only. The transport archives the receipt lists. |
| `/runner-package/package.json` | The Runner package manifest. |
| `/runner-package/dist/` | The Runner's complete build output. `dist/bin/paperclip-runnerd` is the same file as `/paperclip-runnerd`. |
| `/runner-package/node_modules/.cache/paperclip-runner-build-inputs.json` | The build stamp the Runner's build recorded for that output. |
| `/runner-package/scripts/provision-grok.mjs` | Provisions the native Grok executable. Reads `platforms.json` by relative path. |
| `/runner-package/src/providers/grok/platforms.json` | The Grok release pins. |
| `/runner-package/src/live/runnerd-codex-transport.ts` | The transport source, as a contract file. It defines `RUNNER_CLIENT_VERSION`. |
| `/bundles/runnerd-codex-transport.mjs` | The pack's `dist/live/runnerd-codex-transport.js` as one module. It imports without `node_modules`. |
| `/pnpm-lock.yaml` | The lockfile the image was installed from. |

Paths under `/runner-package/` keep their place inside
`packages/paperclip-runner`. `runner-image.json` describes one platform, and
is the same file in both variants:

- `inputsDigest` (the identity below) and `buildInputsDigest` (the digest in
  the Runner's build stamp);
- `sourceRevision`: the commit that built the image, also in the pack as
  `payload.runnerSourceRevision`. An image is published once for its
  inputs, so later commits with the same inputs keep this revision;
- `publication`: `true` only for a build with the build argument
  `PAPERCLIP_RUNNER_IMAGE_PUBLICATION=1`. Only then does the pack carry the
  identity, as `payload.runnerInputsDigest`. Another image build that runs
  the stage inline builds the same Runner but is not this image;
- `platform` (`linux`, `amd64` or `arm64`) and `libc`: the glibc the daemon
  was compiled on (Debian bookworm, the oldest a consumer runs) and the
  newest glibc version it needs;
- `providerPack`: the pack's digest and target;
- `paths` and `sha256`: the table above, and the digest of every single file;
- `fullImageOnly`: the names in `paths` that only the full image has.

## Layers

1. The pack's dependency files of 1 MiB or more: provider binaries and Node.
2. Everything else, with `runner-image.json`.
3. Full only: the transport archive of each file in layer 1.
4. Full only: the other transport archives, the overlay archive, the receipt.

The slim image is layers 1 and 2. The full image is those same two layer
blobs, then layers 3 and 4, which hold transport content and nothing else.
Layers 1 and 3 have the same bytes in every build with the same dependency
files, so a new image shares them with the one before it. A large file under
the pack's `dist` is the Runner's own output: it and its archive are in
layers 2 and 4. An archive is named by its file's place in the receipt, which
lists the dependency files first, so their names do not depend on `dist`.

## Identity

Both variants are named by one digest: the variant is not part of the
identity. The full image has the tag `inputs-<digest>` and the slim image
`inputs-<digest>-slim`. `scripts/runner-image-identity.mjs` computes the
digest from:

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

CI builds each variant as an OCI archive and nothing else.
`node scripts/runner-image-oci.mjs unpack <oci archive> --out <tree>` writes
the tree of an image from its layers, so the tree CI checks is the bytes of
the image. It refuses a whiteout, an absolute or `..` path, a path written
twice and an entry behind a link.

`node scripts/runner-image-layout.mjs check <tree> --variant slim|full` runs
in the build and again on each unpacked tree. The variant has no default: a
slim tree with the transport paths fails, and so does a full tree without
them. The check fails unless:

- every documented path exists, matches its digest in `runner-image.json`,
  and resolves inside the tree;
- the build stamp names the inputs the identity names;
- every artifact in `provider-pack.json` has its digest, the `dist` tree and
  each provider asset tree match their tree digests, and the pack names this
  image's revision and platform;
- the pack names the inputs digest in a publication build and in no other.
  `--expect-inputs-digest` fails on any other build;
- in a full image, every transport archive matches its receipt, and the
  archives extract to the pack. The check extracts them as a sandbox does (GNU tar
  with the options in `provider-pack-layers.ts`) and compares paths, content,
  link targets and all twelve permission bits, after the `a+rX` grant the
  build makes once the archives are written.

`node scripts/runner-image-oci.mjs check-layers --slim <oci archive> --full <oci archive>`
checks "Layers" on the two archives, and that no file is in two layers.

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

A Dockerfile with a `runner-artifacts` or `runner-artifacts-slim` stage of
its own, as in this repository, can take a built image or tree in its place
with `--build-context <stage>=<image or directory>`. The stage is then not
built.

## Publication

`.github/workflows/runner-image.yml` publishes on a `master` push in this
repository and nowhere else. Other runs build and check, and publish nothing.

- **Lockfile.** A `master` push builds from the committed `pnpm-lock.yaml`,
  so the digest is a function of the commit. When that file is behind the
  Runner's manifests, the run writes a notice, publishes nothing and stays
  green. The commit that merges the lockfile refresh publishes the image.
- **Once.** The build runs only when `inputs-<digest>` does not exist.
- **Verified bytes.** The build legs cannot write to the registry. The
  publish job pushes the images they checked by digest and joins each
  variant into a multi-platform index under a `candidate-` tag. It attests
  both indexes, and only then writes the two `inputs-` tags. `candidate-`
  tags are internal: one can name an index that is not attested, and the
  next run overwrites it. Do not consume them.
- **Order.** It writes `inputs-<digest>-slim` first and `inputs-<digest>`
  last, so the full tag marks a complete publication. The full index names
  its slim index in the annotation `io.paperclip.runner.slim-digest`.
- **Pairing.** Resolve the full tag first. Take the slim digest from that
  annotation of the full index, and pull the slim image by that digest. Never
  resolve `inputs-<digest>-slim` by tag on its own: while a publication is
  incomplete, that tag can name the slim image of another run.
- **Recovery.** A run that stops between the two tags leaves a slim tag
  alone. Those inputs are not published. The next run for them builds again,
  replaces that tag with its own slim image and then writes the full tag. A
  full tag whose slim tag is missing or names another image fails every run
  for those inputs. An operator must then delete both package versions and
  re-run the workflow run of a `master` push with those inputs.
- **Create-only.** The workflow never moves a tag of a complete publication,
  but the registry does not enforce that. Pin the index digest and verify it:
  `gh attestation verify oci://ghcr.io/paperclipai/paperclip-runner@sha256:<digest> --repo paperclipai/paperclip --signer-workflow paperclipai/paperclip/.github/workflows/runner-image.yml --source-ref refs/heads/master`
- **First publication.** GitHub creates the package private. A maintainer
  must make it public once.

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
- A lockfile that the lockfile refresh cannot bring up to the Runner's
  manifests leaves every `master` run green with only a notice, for as long
  as it lasts. No image is published in that time, and nothing fails.
