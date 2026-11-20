# Runner image contract

The Runner image is the Runner built alone, as a plain file tree with no
entrypoint and no operating system. An image build copies paths out of it
instead of compiling the Runner again. The application image of this
repository takes its Runner from the stage that builds it (see "The
application image"), or copies the published image when a repository variable
allows it (see "The Runner of the application image"). Its name is
`ghcr.io/paperclipai/paperclip-runner`, and one build makes two variants:

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

Three places ask pnpm the same question, with the same arguments
(`runnerLockState` in `scripts/runner-image-publish.mjs`):

- the publication workflow, which publishes nothing for a lockfile that is
  behind;
- the `runner-lockfile` stage of the `Dockerfile`, which fails an application
  image build and prints the command above. The application's dependency
  install starts from that stage, so it cannot start before the check passes.
  The Runner's toolchain and daemon stages do not depend on it, so they can
  already be running, and the failed check cancels them.
- `scripts/check-release-runner-lockfile.mjs`, which `scripts/release.sh`
  runs for a beta and for a stable release. It checks the committed files of
  the release commit, so a beta or stable tag always builds with a plain
  `docker build`. A canary or a nightly is not checked.

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

Read the image only with `COPY --from` or a read-only bind mount
(`RUN --mount=type=bind,from=`), and pin it by digest:

```dockerfile
FROM ghcr.io/paperclipai/paperclip-runner@sha256:<digest> AS runner-artifacts
FROM debian:trixie-slim
COPY --from=runner-artifacts /paperclip-runnerd /usr/local/bin/paperclip-runnerd
```

A Dockerfile with a `runner-artifacts` or `runner-artifacts-slim` stage of
its own, as in this repository, can take a built image or tree in its place
with `--build-context <stage>=<image or directory>`. The stage is then not
built.

### The application image

The `production` and `cloud` targets of the `Dockerfile` read only the
`runner-artifacts` stage, in two stages:

- `build` copies `/runner-package/dist` and the build stamp into
  `packages/paperclip-runner` and sets
  `PAPERCLIP_RUNNER_VENDOR_REQUIRE_CURRENT=1`. The server build then vendors
  that output, and fails when the stamp does not match the Runner inputs of
  the tree it builds. The lockfile is one of those inputs.
- `runner-provider-pack` copies `/provider-pack`, the receipt and the
  archives, and moves each pack file of 1 MiB or more to a tree of its own.
  `production` copies the three trees with the same three instructions as
  before, so the paths under `/opt/paperclip-runner/` and the layers are the
  same. A deployed server finds the transport layer of an application image
  by the text of the instruction
  `COPY --from=runner-provider-pack /provider-pack-transport/ /opt/paperclip-runner/`
  in the image history (`retained-provider-pack-oci.ts`). Do not change it.

Unless a workflow replaces the stage (see "The Runner of the application
image"), an application image build runs the Runner stages itself: an inline
Runner. An inline Runner is not this image, and an application image says so
in three ways:

- its pack names the build commit of the application image as
  `payload.runnerSourceRevision`, the value of `PAPERCLIP_BUILD_COMMIT`;
- its pack has no `payload.runnerInputsDigest`;
- the image has neither label of "Choosing the Runner for an image build".

A build without `PAPERCLIP_BUILD_COMMIT` has no pack, as before.

`build` also declares the build argument
`PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST`. It is for a build that replaces the
stage with a published image, and `docker.yml` sets it together with the
build context. When the argument is
set, `scripts/check-runner-image-expectation.mjs` reads `/runner-image.json`
of the `runner-artifacts` the build was given, and the build fails unless
that file has `publication: true` and names exactly those inputs. An inline
Runner is never a publication, so the argument without the image fails too.
The check runs before the server build vendors the Runner.

### Choosing the Runner for an image build

`scripts/runner-image-resolve.mjs` decides whether a build of a checkout can
copy the published image. The `runner_image` job of
`.github/workflows/docker.yml` runs it for the application image; see "The
Runner of the application image". The Runner package is public, so the lookup
needs no credential. The script has two commands, so that the one that builds
reads no credential:

```sh
node scripts/runner-image-resolve.mjs inputs --dir "$dir"
node scripts/runner-image-resolve.mjs resolve --dir "$dir"
```

`inputs` exports the Runner build context, checks the lockfile and computes
the inputs digest in the build, as the publication workflow does. Run it on
the committed files, before any step that rewrites `pnpm-lock.yaml`.
`resolve` looks up `inputs-<digest>` and reports:

- `mode`: `published` or `inline`, and `reason`;
- `image` and `slim_image`: both variants, pinned by index digest. The slim
  digest is the one the full index names (see "Pairing");
- `build_contexts`: one `--build-context` value on each line, which replace
  the `runner-artifacts` and `runner-artifacts-slim` stages;
- `labels`: `io.paperclip.runner.image` and
  `io.paperclip.runner.inputs-digest`, for the image that copies the Runner;
- `build_args`: `PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST=<digest>`, the build
  argument with which a build checks the Runner it is given.

`published` needs a complete publication whose full index names these inputs
and both platforms. Every other answer is `inline`, with the last five values
empty: the lockfile is behind the Runner's manifests (`lock-behind`), the
image does not exist (`absent`), a publication is `incomplete` or `broken`,
the full index does not match (`mismatch`), or the registry refused, failed
or could not be reached (`unknown`). A tree whose `Dockerfile` declares no
`PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST` argument is `inline` too
(`unsupported`): its build could not refuse a Runner of other inputs, so
`inputs` runs no build for it. An inline build runs the Runner stages itself
and carries neither label. For an `inline` answer `resolve` prints a notice
with the reason. The command does not verify the attestation of the image:
the workflow that uses the answer does.

### Waiting for a publication

A `master` push starts its own run of `.github/workflows/runner-image.yml`,
which may still be publishing when an image build of the same commit asks.
`resolve --dir "$dir" --wait` is for that build. When the first answer is
`absent` or `incomplete`, it lists the runs of that workflow for the push of
`GITHUB_SHA` to `master` (the Actions API, with `GITHUB_TOKEN` and
`actions: read`) and looks again when they end. Only a run of the `push`
event on `master` in this repository counts: a run of the same commit for a
pull request, for the weekly schedule or from a manual start publishes
nothing and is never waited for. Every other first answer is final and starts
no wait.

- **A run, not a time.** When every run of the commit has completed, the
  command looks up the image once more, and that answer is final. A run that
  failed, was cancelled, or published nothing because the lockfile is behind
  ends the wait as soon as it ends.
- **Published before the run ends.** While a run is in progress the command
  looks up the image every 30 seconds. The wait ends when the image is
  published, not when the last job of the run ends.
- **Not listed yet.** A run can be missing from the list just after the push.
  The command looks for it for two minutes, measured from the start of the
  wait. A commit with no run by then is not the head of a `master` push.
- **Limit.** The wait ends 40 minutes after the push
  (`RUNNER_IMAGE_WAIT_MINUTES` in the script). The push is the creation time
  of the oldest run of the commit, so a build that starts late waits less, and
  one that starts after the limit looks once and does not wait.
- **Actions API.** Three failed requests in a row end the wait. Without a
  token or a full commit SHA there is no wait.
- **Never an error.** After every ending the command looks up the image one
  last time. Without an image the answer is `inline`, with the reason of that
  lookup and what the wait saw.

### The Runner of the application image

The application image, `ghcr.io/paperclipai/paperclip`, gets its Runner in one
of two ways. The recipe is the same in both, so the Runner behaves the same.

- **Inline.** The image build runs the `runner-artifacts` stage itself.
- **Published.** The build receives
  `--build-context runner-artifacts=docker-image://ghcr.io/paperclipai/paperclip-runner@sha256:<full index digest>`.
  The stage is then not built, and the image copies the published Runner.

Only `.github/workflows/docker.yml` in this repository can choose
"published". A local `docker build`, a fork, the pull-request check
(`docker-app-check.yml`) and the merge-queue build
(`docker-merge-group.yml`) are always inline.

**Labels.** An image that copied the published Runner has two labels, on the
image of each platform:

| Label | Value |
| --- | --- |
| `io.paperclip.runner.image` | `ghcr.io/paperclipai/paperclip-runner@sha256:<full index digest>` |
| `io.paperclip.runner.inputs-digest` | The inputs digest of that Runner image. |

The workflow writes them, not the `Dockerfile`, and only together with the
build context. An image without them made its own Runner. Nothing else
follows from their absence: such an image is complete and supported. Its pack
has no `payload.runnerInputsDigest`, and the pack's `runnerSourceRevision` is
the commit of the image. In an image with the labels, `runnerSourceRevision`
is the commit that published the Runner image, which can be older than the
commit of the application image.

**The variable.** The repository variable `RUNNER_IMAGE_CONSUME_ENABLED`
turns this on. Only the exact value `true` does. With any other value, or no
variable, the `runner_image` job does not run and every build is inline, as
before the job existed.

**The job.** `runner_image` runs once for a workflow run, and both
architecture builds need it, so both always get the same answer.

1. `inputs`, on the committed files, with no credential.
2. `resolve`. For a `master` push it runs with `--wait` and a token that can
   read workflow runs. For a tag or a manual run it does not wait: no run of
   `runner-image.yml` belongs to that event.
3. For a `published` answer, the job verifies the attestation of the full
   index, with the command under "Create-only". Only this step writes the
   outputs of the job, so no build receives a digest that did not verify. An
   image that does not verify fails this step with a warning. The job is then
   red, the run is not, and the builds are inline.
4. The builds add the outputs to their own values: the build context, the two
   labels and the build argument `PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST`. With
   empty outputs a build has exactly the arguments, contexts and labels it
   had without the job.

The job holds no registry credential and cannot write anything. It cannot
fail the run or stop a build: every failure, a timeout included, leaves the
outputs empty and the builds inline. The 40 minutes of the wait end inside
the limit of its step (55 minutes) and of the job (70 minutes), so the script
ends the wait, with a notice, before the workflow would stop it.

**The check in the build.** With the build argument, the build fails unless
its `runner-artifacts` is the publication of those inputs (see "The
application image"). A wrong or missing build context then fails the build,
and no image carries labels for a Runner it does not have. The resolver
answers `unsupported` for a `Dockerfile` that does not declare the argument.

**The lockfile.** The published Runner was built from the committed
`pnpm-lock.yaml`, and its build stamp covers that whole file. A build that
copies it must therefore build the committed lockfile. `docker.yml` refreshes
the lockfile on the runner before an inline build, because the inline Runner
stages install frozen. It does not refresh it when the answer is `published`:
a refresh rewrites the file whenever the manifest of any package is ahead of
it, also a package the Runner does not read, and the server build would then
refuse the published Runner as built from other inputs. The resolver answers
`published` only when the committed lockfile matches the Runner's own
manifests, so the `runner-lockfile` stage passes, and the `deps` stage
resolves the manifests of the other packages inside the image, as it does for
a local `docker build`. A build that is given a published Runner and a
refreshed lockfile fails at the step that vendors the Runner.

**Merge-queue images.** `docker.yml` can push the image that the merge queue
built for a commit instead of building it. That image made its own Runner. A
run whose `runner_image` job answered `published` does not look for it and
builds from source, so one commit never has both kinds.

**Rollback.** Set `RUNNER_IMAGE_CONSUME_ENABLED` to another value, or delete
it. The next run of `docker.yml` builds inline. No revert is needed, and
images that exist do not change.

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

## Build cache

The build legs read a registry build cache,
`ghcr.io/paperclipai/paperclip-runner-buildcache:<arch>`. It is a package of
its own and holds no image, so the image package holds only attested images.
It covers the stages that do not take the commit: the Rust toolchain and the
compiled daemon. The last stage takes the source revision as a build
argument, so every build runs it: the frozen install, the Runner's build and
the provider pack. Of the two build commands of a leg, only the first reads
the registry cache; the second reads what the first left in the job's builder.

- **Effect.** BuildKit reuses a cached step only when the step and the
  content of every file it reads are the same. The cache changes how long a
  build takes, not what it builds, and the identity does not cover it.
- **Writer.** Only the `cache` job of the workflow writes it: on a `master`
  push in this repository, after the publish job, for inputs that had no
  image. When the image exists, nothing was built, and the run that published
  it wrote the cache for those inputs. That job cannot sign, builds no further
  than the daemon and never runs the install. Its token reaches the registry
  login and no other step. It reads the cache it writes and keeps every step
  of the cached stages (`mode=max`). Every other run reads the cache without
  a credential and cannot write it.
- **Not on the way to an image.** No job waits for the `cache` job. When it
  fails, the image is published and the next build is slower.
- **One write at a time.** The job holds one concurrency slot for each
  architecture. GitHub keeps one waiting job in a group and cancels the one
  that waited before it, so the newest write waits. A write from an older
  commit that lands last costs time and nothing else.
- **No Actions cache.** The workflow never uses it: workflows that handle
  pull requests can write it, and what they write must not reach a published
  image.
- **Trust.** The daemon in a published image can come from a cached step
  that an earlier `master` run compiled. Whoever can write the cache package
  can decide what a later build reuses, so write access to it must stay as
  narrow as write access to the image package.
- **Fetches.** A cached step does not run again. A download inside one (the
  toolchain installer, the toolchain, the crates) is not repeated until the
  inputs of that step change.
- **Weekly cold build.** A scheduled run builds both variants once a week
  with no cache: it passes `--no-cache` and reads no registry cache. Like a
  manual run, it resolves the lockfile, always builds, runs every check and
  publishes nothing. A fork's schedule runs nothing. It fails when a download
  is gone or when a step only works from the cache.
- **Missing cache.** A cache that does not exist or cannot be read is a
  line in the build log, not a failure. The build then runs every step.
- **First write.** GitHub creates the cache package private. A maintainer
  must make it public once. Until then every build runs cold.

## Reading the transport archives alone

The server needs the transport form of an older pack when a retained session
names a pack that is not the server's own. A pack with
`payload.runnerInputsDigest` came out of this image, so the server reads it
from `inputs-<digest>` (`retained-provider-pack-oci.ts`). It does not count
layers. It uses the rule of "Layers": the full image is the slim image, then
layers that hold transport content and nothing else.

- The full index must carry the annotations
  `io.paperclip.runner.inputs-digest`, equal to the pack's digest of inputs,
  `org.opencontainers.image.revision`, equal to the pack's
  `runnerSourceRevision`, and `io.paperclip.runner.slim-digest`.
- The server reads the slim index by that digest, never by the slim tag, and
  checks the bytes against the digest.
- For the pack's platform, the layers of the slim image must be the first
  layers of the full image, as the same blobs in the same order. The layers
  after them are the transport layers: at least one and at most eight.
- The server downloads only those layers. It refuses any entry in them that
  is not a transport archive or the receipt, and any file that is in two of
  them.
- The importer then checks every archive against the pack's manifest, as for
  any other source.
- The record the server keeps of the source names the digest of inputs and
  every transport layer under `runnerImage`. Its `transportLayerDigest` is
  then the last of those layers and `transportLayerBytes` their total.

When the image cannot be read (a tag or the slim index does not exist, or the
registry refuses a request), the server reads the application image tagged
`sha-<runnerSourceRevision>`, as it does for a pack without
`runnerInputsDigest`. An image that can be read and does not match fails.

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
