# Offline verification harness

Run the real catalog generator, the real brand validators, and the real catalog
tests without mutating the App checkout. Use this when you must verify before
you have permission to write to the repository, when another task owns the
working tree, or when you want to prove a failure is attributable to your change
and not to the environment.

**Check whether you need it first.** If you are already working in a disposable
worktree you created and own — the normal shape — the harness buys you little:
what it protects is a checkout other people depend on, and you do not have one.
Run the ladder in `references/catalog-contract.md` directly and `git status` at
the end. Reach for the harness when the checkout is shared, is someone else's,
or has to be provably untouched.

The recipe below builds it. It exports the needed files with `git archive` and
`git show` at a pinned commit and symlinks `node_modules` read-only, so the
checkout is untouched.

This used to ship as `scripts/make-harness.sh` inside the skill. It is inlined
here on purpose: a skill package containing anything under `scripts/` derives
the `scripts_executables` trust level (`deriveTrustLevel` in
`packages/skills-catalog/src/catalog-builder.ts`), and the shipped
catalog pins that set to exactly one key
(`packages/skills-catalog/src/shipped-catalog.test.ts`). Carrying the
recipe as documentation keeps this package `markdown_only` and installable
without an audit-allowlist change. Save it to a file yourself and `chmod +x` it
if you prefer to run it as a script.

## Build it

Save as `make-harness.sh` outside the App checkout, then:

```sh
./make-harness.sh <app-repo> <commit-ish> <corpus-dir> [out-dir]
```

Omit `[out-dir]` and the script allocates a fresh directory for you. That is the
recommended form.

### The script deletes nothing

An earlier revision of this recipe took the output directory as a required
argument and opened with `rm -rf "$OUT"`. That is a foot-gun: a contributor who
typed `/`, their checkout path, or any directory they cared about lost it before
verification started. The recipe below has no `rm -rf` on a caller-supplied
path, and no `rm` of any kind outside a directory it created itself.

The rules it follows:

| Input | What happens |
| --- | --- |
| No `out-dir` given | `mktemp -d` allocates a fresh unique directory under `TMPDIR`. The temp root is checked for containment *before* `mktemp` runs, so a refusal leaves nothing behind. |
| A relative path | Refused. It resolves against the current directory, which is too easy to get wrong. |
| `/` | Refused. |
| A path that already exists — file or directory, empty or not | Refused. Pass a new path or omit the argument. |
| A symlink | Refused before anything is read or written through it. |
| A path whose parent does not exist | Refused. The script creates one level, never a tree. |
| A path inside the App checkout or the corpus | Refused after resolving with `pwd -P`, so `..` and symlinked parents cannot slip past. The same check applies to `TMPDIR`, so the allocated form cannot land in a source tree either. |
| Anything else | `mkdir` creates it — not `mkdir -p`, so a race that creates it first is an error, not a silent reuse. |

Refusing every existing destination is what makes this safe, and it is why the
list above is short: `/`, the repository, and "some directory I cared about" are
all the same case. Nothing needs to decide which existing directories are
precious, because none of them are accepted.

The two helper scripts the harness writes each drop a marker file in their own
root and refuse to run without it, so neither can operate on your checkout if
you run it from the wrong directory.

<details>
<summary><code>make-harness.sh</code></summary>

```bash
#!/usr/bin/env bash
# Build an isolated harness that runs the real catalog generator, the real brand
# validators, and the real catalog tests against a copy of a pinned commit.
#
# This script deletes nothing. Nothing in the App checkout is modified: files
# are exported with `git archive` and `git show`, and node_modules is symlinked
# read-only.
#
# Usage:
#   make-harness.sh <app-repo> <commit-ish> <corpus-dir> [out-dir]
#
# With no [out-dir] a fresh directory is allocated with `mktemp -d`. With one,
# the path must be absolute and must not exist: the script creates it, and
# refuses every other case rather than clearing anything.

set -euo pipefail

APP_REPO=${1:?app repo path}
COMMIT=${2:?commit-ish}
CORPUS=${3:?ingestion corpus dir}
OUT=${4:-}

die() { printf 'make-harness: %s\n' "$*" >&2; exit 2; }

[ -d "$APP_REPO" ] || die "app repo not found: $APP_REPO"
[ -d "$CORPUS" ] || die "corpus not found: $CORPUS"
[ -d "$APP_REPO/node_modules" ] || die "install dependencies in $APP_REPO first"

APP_REPO_REAL=$(cd "$APP_REPO" && pwd -P)
CORPUS_REAL=$(cd "$CORPUS" && pwd -P)

# Applied to both branches below. An allocated TMPDIR can sit inside the
# checkout just as easily as a path somebody typed.
assert_outside() {
  case $1/ in
    "$APP_REPO_REAL"/|"$APP_REPO_REAL"/*) die "$2 is inside the App checkout: $1" ;;
    "$CORPUS_REAL"/|"$CORPUS_REAL"/*) die "$2 is inside the corpus: $1" ;;
  esac
}

# --- allocate the output directory -------------------------------------------
# Every branch below either creates a new directory or refuses. There is no
# path through this block that removes anything.
if [ -z "$OUT" ]; then
  # Check the temp root *before* mktemp, so a refusal leaves nothing behind.
  TMPROOT=${TMPDIR:-/tmp}
  [ -d "$TMPROOT" ] || die "TMPDIR does not exist: $TMPROOT"
  TMPROOT=$(cd "$TMPROOT" && pwd -P)
  assert_outside "$TMPROOT" "TMPDIR"
  OUT=$(mktemp -d "$TMPROOT/paperclip-harness.XXXXXXXX")
  echo "allocated a fresh harness directory: $OUT"
else
  case $OUT in
    /*) ;;
    *) die "out-dir must be an absolute path, got '$OUT'" ;;
  esac
  OUT=${OUT%/}
  [ -n "$OUT" ] || die "refusing the filesystem root as out-dir"
  # -L first: a dangling symlink is invisible to -e.
  if [ -L "$OUT" ]; then die "out-dir is a symlink, refusing to write through it: $OUT"; fi
  if [ -e "$OUT" ]; then die "out-dir already exists: $OUT (pass a new path, or omit it to allocate a fresh one)"; fi
  PARENT=$(dirname "$OUT")
  [ -d "$PARENT" ] || die "parent directory does not exist: $PARENT"
  # Resolve the parent so `..` and symlinked parents cannot escape the checks.
  OUT="$(cd "$PARENT" && pwd -P)/$(basename "$OUT")"
  assert_outside "$OUT" "out-dir"
  # mkdir, not `mkdir -p`: if something created the path in the meantime, stop.
  mkdir "$OUT" || die "could not create $OUT"
fi

SHA=$(git -C "$APP_REPO" rev-parse "$COMMIT")
mkdir -p "$OUT/gen/scripts" "$OUT/vt/packages/shared" "$OUT/vt/ui/public/brands"
printf '%s\n' "$SHA" > "$OUT/PINNED_COMMIT"
# Markers. The helper scripts below refuse to run without the one for their root.
: > "$OUT/gen/.paperclip-harness-gen"
: > "$OUT/vt/.paperclip-harness-vt"

# --- generator harness -------------------------------------------------------
for f in scripts/ingest-app-definitions.mjs \
         scripts/app-brand-validation.mjs \
         scripts/check-app-brand-assets.mjs \
         scripts/app-brand-validation.test.mjs; do
  git -C "$APP_REPO" show "$SHA:$f" > "$OUT/gen/$f"
done
git -C "$APP_REPO" archive "$SHA" ui/public/brands/apps | tar -x -C "$OUT/gen"
git -C "$APP_REPO" archive "$SHA" \
  packages/shared/src/app-definitions \
  packages/shared/src/app-definitions.generated.ts \
  packages/shared/src/app-definitions.ingestion-report.json \
  packages/shared/src/app-definitions.ts \
  packages/shared/src/self-serve-mcp-research.json | tar -x -C "$OUT/gen"

# Pristine copies, so fidelity and change can be told apart.
cp -r "$OUT/gen/packages/shared/src/app-definitions" "$OUT/gen/.baseline-definitions"
cp "$OUT/gen/packages/shared/src/app-definitions.generated.ts" "$OUT/gen/.baseline-generated.ts"
cp "$OUT/gen/packages/shared/src/app-definitions.ingestion-report.json" "$OUT/gen/.baseline-report.json"

cat > "$OUT/gen/verify-fidelity.sh" <<'FIDELITY'
#!/usr/bin/env bash
# Regenerate from the pristine source and prove the harness reproduces the
# checked-in output exactly. Run this BEFORE applying your own change.
set -euo pipefail
# The generator writes into its working directory. Refuse to run anywhere but
# the harness root, so a wrong `cd` cannot regenerate over a real checkout.
[ -f .paperclip-harness-gen ] || {
  echo "run this from the harness gen root (no .paperclip-harness-gen here)" >&2; exit 2; }
: "${PAPERCLIP_CONTENT_TEMPLATES:?point this at the ingestion corpus}"
node scripts/ingest-app-definitions.mjs
diff -rq .baseline-definitions packages/shared/src/app-definitions
diff -q .baseline-generated.ts packages/shared/src/app-definitions.generated.ts
diff -q .baseline-report.json packages/shared/src/app-definitions.ingestion-report.json
echo "fidelity OK: harness reproduces the checked-in output byte-for-byte"
FIDELITY
chmod +x "$OUT/gen/verify-fidelity.sh"

# --- vitest harness ----------------------------------------------------------
git -C "$APP_REPO" archive "$SHA" \
  packages/shared/src packages/shared/package.json packages/shared/tsconfig.json | tar -x -C "$OUT/vt"
git -C "$APP_REPO" show "$SHA:tsconfig.base.json" > "$OUT/vt/tsconfig.base.json"
ln -s "$(cd "$APP_REPO" && pwd)/node_modules" "$OUT/vt/node_modules"
ln -s "$(cd "$APP_REPO" && pwd)/packages/shared/node_modules" "$OUT/vt/packages/shared/node_modules"

cat > "$OUT/vt/sync-from-gen.sh" <<'SYNC'
#!/usr/bin/env bash
# Copy the generator harness's current output into the vitest harness, so the
# tests run against exactly what you generated.
set -euo pipefail
GEN=${1:?path to the gen harness}
# Both ends must be harness roots. The only `rm` below is a fixed relative path
# under a directory these two markers prove is a harness, never a checkout.
[ -f .paperclip-harness-vt ] || {
  echo "run this from the harness vt root (no .paperclip-harness-vt here)" >&2; exit 2; }
[ -f "$GEN/.paperclip-harness-gen" ] || {
  echo "not a harness gen root: $GEN" >&2; exit 2; }
mkdir -p ui/public/brands
rm -rf ./ui/public/brands/apps
cp -r "$GEN/ui/public/brands/apps" ui/public/brands/apps
cp "$GEN/packages/shared/src/app-definitions.ts" packages/shared/src/app-definitions.ts
cp "$GEN/packages/shared/src/app-definitions.generated.ts" packages/shared/src/app-definitions.generated.ts
cp "$GEN/packages/shared/src/app-definitions/"*.json packages/shared/src/app-definitions/
echo "synced from $GEN"
SYNC
chmod +x "$OUT/vt/sync-from-gen.sh"

echo "harness ready at $OUT (pinned $SHA)"
echo "  generator: $OUT/gen"
echo "  vitest:    $OUT/vt/packages/shared"
```

</details>

```text
$ ./make-harness.sh <app-repo> HEAD <corpus-dir>
allocated a fresh harness directory: /tmp/paperclip-harness.NWeZ7RkG
harness ready at /tmp/paperclip-harness.NWeZ7RkG (pinned 2a99de80ec52db01eead901f28323926ceaf3c1d)
  generator: /tmp/paperclip-harness.NWeZ7RkG/gen
  vitest:    /tmp/paperclip-harness.NWeZ7RkG/vt/packages/shared

$ ./make-harness.sh <app-repo> HEAD <corpus-dir> /tmp/named-harness
harness ready at /tmp/named-harness (pinned 2a99de80ec52db01eead901f28323926ceaf3c1d)
  generator: /tmp/named-harness/gen
  vitest:    /tmp/named-harness/vt/packages/shared
```

Both forms above are from runs on 20 September 2026 at Paperclip App commit
`2a99de80ec`, Node v24.20.0, bash 5. The recipe was previously exercised at
`728f7185` and `e558f25e` under its older signature; the only change since is
the output-directory handling.

### The refusals, executed

Every unsafe input below was run against a **real** path, each with a canary
file where a directory was involved. Nothing was deleted: the canaries, the App
checkout, and `/` were all intact afterwards.

```text
$ make-harness.sh <app-repo> HEAD <corpus> /
make-harness: refusing the filesystem root as out-dir                              exit 2

$ make-harness.sh <app-repo> HEAD <corpus> <app-repo>
make-harness: out-dir already exists: <app-repo>
              (pass a new path, or omit it to allocate a fresh one)                exit 2

$ make-harness.sh <app-repo> HEAD <corpus> /tmp/canary/existing
make-harness: out-dir already exists: /tmp/canary/existing
              (pass a new path, or omit it to allocate a fresh one)                exit 2

$ make-harness.sh <app-repo> HEAD <corpus> relative-harness
make-harness: out-dir must be an absolute path, got 'relative-harness'             exit 2

$ make-harness.sh <app-repo> HEAD <corpus> /tmp/canary/link       # → symlink-target
make-harness: out-dir is a symlink, refusing to write through it: /tmp/canary/link exit 2

$ make-harness.sh <app-repo> HEAD <corpus> <app-repo>/tmp-harness
make-harness: out-dir is inside the App checkout: <app-repo>/tmp-harness           exit 2

$ make-harness.sh <app-repo> HEAD <corpus> /tmp/no/such/parent/out
make-harness: parent directory does not exist: /tmp/no/such/parent                 exit 2
```

The allocated form is checked too. Containment is not something only an explicit
destination needs — `TMPDIR` can point into a source tree just as easily. It is
checked *before* `mktemp` runs, so a refusal leaves nothing behind:

```text
$ TMPDIR=<app-repo> make-harness.sh <app-repo> HEAD <corpus>
make-harness: TMPDIR is inside the App checkout: <app-repo>                        exit 2

$ TMPDIR=<corpus> make-harness.sh <app-repo> HEAD <corpus>
make-harness: TMPDIR is inside the corpus: <corpus>                                exit 2

$ TMPDIR=/tmp/repo-link make-harness.sh <app-repo> HEAD <corpus>   # → <app-repo>
make-harness: TMPDIR is inside the App checkout: <app-repo>                        exit 2

$ TMPDIR=/tmp/does-not-exist make-harness.sh <app-repo> HEAD <corpus>
make-harness: TMPDIR does not exist: /tmp/does-not-exist                           exit 2
```

The third case is the one worth noticing: `TMPDIR` was a **symlink** to the App
checkout, and `pwd -P` resolved it before the comparison. The checkout held the
same number of entries before and after all four runs.

The two helper guards were exercised the same way, by running each from the App
checkout instead of its own harness root:

```text
$ cd <app-repo> && <out-dir>/gen/verify-fidelity.sh
run this from the harness gen root (no .paperclip-harness-gen here)                exit 2

$ cd <app-repo> && <out-dir>/vt/sync-from-gen.sh <out-dir>/gen
run this from the harness vt root (no .paperclip-harness-vt here)                  exit 2
```

`git status` in the App checkout was empty after all nine runs.

Two roots, because they have different working directories:

- `gen/` — the generator runs from a repo-shaped root (`process.cwd()` is the
  root it reads `ui/public/brands/apps/manifest.json` from and writes
  `packages/shared/src/app-definitions/` into).
- `vt/` — the vitest root. `app-definitions.test.ts` resolves `../../../ui/public`
  relative to its own file, so `vt/ui/public/brands/apps` has to exist.

## Prove the harness first

Never trust a harness you have not checked. Regenerate from the pristine source
and confirm the output matches the checked-in files byte-for-byte:

```sh
cd <out-dir>/gen
PAPERCLIP_CONTENT_TEMPLATES=<corpus-dir> ./verify-fidelity.sh
```

```text
Parsed 99 captures and 179 states; emitted 72 Wave 1 definitions and flagged 63 states for review.
fidelity OK: harness reproduces the checked-in output byte-for-byte
```

That is today's run at `2a99de80ec`. The definition count tracks the commit —
it was 70 at `e558f25e` — so compare the `fidelity OK` line, not the number.

The corpus is in the non-public `paperclip-content` repository. Without it the
generator refuses to run and this harness cannot be built — report that as a
blocked prerequisite rather than editing the guard.

If that diff is not empty, stop. Either the corpus is wrong or the harness is
missing an input, and any later result is meaningless.

## Run your change through it

```sh
cd <out-dir>/gen
# edit scripts/ingest-app-definitions.mjs, ui/public/brands/apps/manifest.json,
# packages/shared/src/app-definitions.ts, and add the brand asset
node scripts/check-app-brand-assets.mjs
node --test scripts/app-brand-validation.test.mjs
PAPERCLIP_CONTENT_TEMPLATES=<corpus-dir> node scripts/ingest-app-definitions.mjs

cd <out-dir>/vt && ./sync-from-gen.sh <out-dir>/gen
cd <out-dir>/vt/packages/shared
node ../../node_modules/vitest/vitest.mjs run \
  src/app-definitions.test.ts src/app-definitions-url.test.ts
```

Expect the count assertion to fail first, then update it and rerun. Real output
from the Neon worked example at `e558f25e`:

```text
Validated 70 brand identities: local paths, aliases and artwork safety.
Parsed 99 captures and 179 states; emitted 71 Wave 1 definitions and flagged 63 states for review.

AssertionError: expected [ { schemaVersion: 1, …(8) }, …(46) ] to have a length of 46 but got 47
 ❯ src/app-definitions.test.ts:689:35
```

```text
Test Files  2 passed (2)
     Tests  27 passed (27)
```

The same two suites run green through a clean harness before you change
anything. On 20 September 2026 at `2a99de80ec`, straight after
`sync-from-gen.sh`:

```text
 RUN  v4.1.11 /tmp/named-harness/vt/packages/shared

 Test Files  2 passed (2)
      Tests  28 passed (28)
   Duration  632ms
```

Establish that baseline first. A red suite you did not cause is not your result.

Also diff the generated registry and confirm the only changes are positional.
At this commit one inserted provider moved 125 lines of `a<N>` imports in
`app-definitions.generated.ts` and changed nothing semantic in another
provider:

```sh
diff .baseline-generated.ts packages/shared/src/app-definitions.generated.ts \
  | grep '^[<>]' | grep -v 'a[0-9]'   # must print nothing
```

## What this harness does not cover

Be explicit about this in your report. The harness reaches the shared package
only. It does not run:

- the server suites (`tool-access-service`, `generic-mcp-connection`,
  `tool-connection-removal`) — they need the server package and its fixtures;
- the UI suites (`AppsConnect`, `Browse`) — they need the UI package;
- `pnpm check:token-gates`, `pnpm -r typecheck`, `pnpm build`, `pnpm test:e2e`;
- anything account-bound.

Source-inspecting those is a legitimate intermediate result. Reporting them as
passed is not.

Above all: a green run here proves the definition fits the tested contracts. It
is not provider validation, not an agent run, and not acceptance. See
`references/live-acceptance.md` for the gate that is.

## Notes

- `node_modules/.bin/vitest` is a shell wrapper that Node cannot execute
  directly. Call `node_modules/vitest/vitest.mjs`.
- `--reporter=basic` is not a valid reporter on vitest 4. Omit it.
- The harness needs `tsconfig.base.json` at the harness root; the script exports
  it, because the shared package's tsconfig extends it and the transform fails
  without it.
