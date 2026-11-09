# Sandbox file-sync lifecycle hooks

A sandbox environment provider moves workspace and asset files between the host
and the sandbox around every run. By default the runtime synthesizes that
transfer over the single `environmentExecute` verb: it base64-encodes bytes and
pipes them through `base64 -d` shell commands, one bounded round-trip per chunk.
That works everywhere but is slow for large workspaces because it cannot use a
provider's native bulk file transport.

The two **optional, opt-in** hooks documented here let a provider replace that
base64-over-exec transfer with its own native mechanism:

- **`onEnvironmentSyncIn`** — before execution: place a set of host
  files/directories at target sandbox paths.
- **`onEnvironmentSyncOut`** — after execution: copy a set of sandbox
  files/directories back to target host paths.

They are entirely opt-in. A provider that does not define them keeps the exact
base64 fallback, byte-for-byte — there is **zero behavior change** for existing
providers.

## Opt-in / no-op semantics

A hook is opted into exactly like `onEnvironmentExecute`: defining it on your
`PluginDefinition` makes the worker advertise the matching verb in
`InitializeResult.supportedMethods`; leaving it undefined omits the verb and the
guarded handler throws `METHOD_NOT_IMPLEMENTED` if it is ever called.

**Both hooks are advertised and consumed as a pair.** The host runtime uses the
native path only when the worker advertises **both** `environmentSyncIn` and
`environmentSyncOut`; if a provider advertises only one, the orchestrator keeps
the base64 fallback for both directions. Define both or neither.

```ts
export default definePlugin({
  async setup() { /* ... */ },
  async onEnvironmentSyncIn(params) {
    return { operations: await transferInbound(params) };
  },
  async onEnvironmentSyncOut(params) {
    return { operations: await transferOutbound(params) };
  },
});
```

## The operation / file-mapping contract

Each hook receives an ordered list of **operations**. Each operation carries an
opaque id and a list of source→target **file mappings**:

```ts
interface PluginSyncOperation {
  operationId: string;               // opaque, non-sensitive; do NOT interpret it
  files: PluginSyncFileMapping[];
}

interface PluginSyncFileMapping {
  sourcePath: string;                // absolute
  targetPath: string;                // absolute
  kind: "file" | "directory";
  mode?: number;                     // POSIX mode to apply at the target
  exclude?: string[];                // glob excludes for a directory mapping
  followSymlinks?: boolean;          // directory symlink handling; see below
}

interface PluginEnvironmentSyncResult {
  operations: { operationId: string; filesTransferred: number; bytesTransferred: number }[];
}
```

For `onEnvironmentSyncIn`, `sourcePath` is a **host** path and `targetPath` a
**sandbox** path. For `onEnvironmentSyncOut` the direction is reversed. All
sandbox paths are POSIX. Return per-operation `filesTransferred` /
`bytesTransferred` for observability.

### Ordering

Operations are applied strictly in array order, and the orchestrator invokes the
hooks in a fixed lifecycle order (inbound before execution, outbound after). The
orchestrator owns *what* and *when*; a provider only executes the opaque
transfers it is handed and must not reorder them.

### A provider may tar internally

The contract only describes the observable source→target result. How you move
the bytes is yours: bulk upload API, an internal `tar` stream, per-file
enumeration — all are fine. Whatever you do, the materialized target must be
observationally identical to the mapping (same files, same contents, same modes,
same symlink treatment) so the native and fallback paths are interchangeable.

### `operationId` is opaque

`operationId` is an opaque, non-sensitive token authored by the orchestrator. It
is **not** derived from any secret or user data, it is safe to log and safe to
expose to the sandbox, and a provider **must not** parse or depend on its value.
Do not echo it into a path or a place where it could collide with real data.

## Symlink contract (`followSymlinks`)

`followSymlinks` applies to `kind: "directory"` mappings and has exactly the
meaning of `tar`'s `-h` flag:

- **falsy (default)** — archive and recreate symlinks **as links** (preserve).
- **`true`** — **dereference** each symlink to its target bytes.

A provider honoring a directory mapping MUST reproduce this: preserve links when
falsy, dereference to bytes when `true`. The orchestrator passes the same value
it passes to its own tar create step, so native and fallback are observationally
identical. There is no separate extract-side symlink flag and no execution-time
special case — symlink handling lives entirely in this one flag.

## Atomicity contract

The required guarantee level is deliberately equal to the base64 fallback's
floor, so opting in never weakens integrity and never over-promises.

- **Single-file mappings (`kind: "file"`) MUST be atomic-replace (REQUIRED).**
  Stage the bytes to a provider-chosen temporary path, then atomically rename
  onto `targetPath`, so an interrupted transfer never leaves a truncated file at
  `targetPath`. This mirrors the fallback, which stages to
  `<path>.paperclip-upload` and then `mv -f`.
  - The temp file MUST live in the **same directory (same filesystem)** as
    `targetPath`. A cross-device rename degrades to copy-then-unlink and
    reintroduces the truncation window it is meant to close.
  - Reserve the `.paperclip-upload*` scratch names: a provider-chosen temp must
    not collide with the fallback scratch name or with a real target.

- **Directory mappings and the sync as a whole are NOT atomic / NOT
  transactional.** A directory transfer is destroy-then-replace: a crash
  mid-transfer can leave a partial tree, and the runtime does not roll back
  already-moved bytes across operations. This matches today's behavior; do not
  assume a directory operation is atomic. Where an individual file must be
  integrity-protected, deliver it as its own `kind: "file"` mapping so it inherits
  the single-file atomic-replace guarantee.

- **Every operation is fail-loud.** An operation either completes or raises to
  the orchestrator; never report partial success silently. The orchestrator may
  then retry or fall back.

## Secret material and file modes

This seam can carry credential-bearing files (for example an auth directory).
Treat `mode` as mandatory for such mappings:

- Apply the requested `mode` (e.g. `0o600`) with **no world-readable window** —
  create the target with the mode, or `chmod` **before** writing any bytes, never
  after.
- `mode` MUST be honored for files **inside a directory mapping** too, not only
  for `kind: "file"` mappings. If you tar internally, preserve permissions; if
  you enumerate, set the mode as each file lands. A credential that rides a
  directory mapping otherwise silently loses its `0o600` guarantee.
- A directory mapping is not atomic (see above). If a directory carries an
  individually-sensitive secret whose integrity matters, prefer delivering that
  secret as a `kind: "file"` mapping so it gets atomic-replace, or protect its
  integrity out of band.

## Host-side path confinement (required of the orchestrator)

The sandbox is untrusted relative to the host, so **the orchestrator — not the
provider — owns and confines every path**. Before an operation is handed to a
provider, the runtime canonicalizes each mapping's `sourcePath`/`targetPath` and
confines it to an orchestrator-owned root (the workspace directory or a specific
asset directory), rejecting absolute escapes and `..` traversal fail-closed. A
provider receives only already-confined, orchestrator-authored paths and MUST
NOT widen them (for example by following a sandbox-planted symlink out of the
intended root on an outbound write). Confinement is a host-side complete-mediation
guard and is never delegated below the trust boundary.

## Resource bounds

The base64 fallback enforces transfer caps so a runaway payload cannot exhaust
memory. A native provider MUST keep an equivalent bound — stream or chunk large
transfers rather than buffering unboundedly, and fail closed on an oversized
inline payload rather than silently removing the cap.

## Shell safety (native providers that shell out)

If your native transfer builds shell command strings (for example a pod-exec
`tar`/`base64`/`mv` pipeline), single-quote **every** interpolated path so a path
containing shell metacharacters is transferred literally, never interpreted.
Providers whose transport is a non-shell API (a typed bulk-upload call) do not
need this, but any shell interpolation must quote.

## Reference: minimal shape

```ts
async onEnvironmentSyncIn({ operations }) {
  const results = [];
  for (const op of operations) {          // apply in order
    let filesTransferred = 0;
    let bytesTransferred = 0;
    for (const f of op.files) {
      if (f.kind === "file") {
        // stage to a same-dir temp, then atomic rename onto f.targetPath,
        // applying f.mode with no world-readable window
      } else {
        // materialize f.sourcePath at f.targetPath (destroy-then-replace),
        // honoring f.exclude and f.followSymlinks, applying per-file modes
      }
    }
    results.push({ operationId: op.operationId, filesTransferred, bytesTransferred });
  }
  return { operations: results };
}
```
