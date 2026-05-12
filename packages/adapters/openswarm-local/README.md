# @paperclipai/adapter-openswarm-local

Paperclip adapter that wakes an [OpenSwarm](https://github.com/unohee/OpenSwarm)
or [VRSEN/OpenSwarm](https://github.com/VRSEN/openswarm) subprocess on each
heartbeat.

Adapter type: `openswarm_local`.

## Two flavors, one adapter

OpenSwarm is two distinct projects with the same name. Both install a binary
called `openswarm`, so a host can only have one of them globally at a time.

| Flavor | Project | npm | Wake shape |
|---|---|---|---|
| `unohee` (default) | [unohee/OpenSwarm](https://github.com/unohee/OpenSwarm) | `@intrect/openswarm` | `openswarm exec "<prompt>" -p <cwd> --local --pipeline` |
| `vrsen` | [VRSEN/openswarm](https://github.com/VRSEN/openswarm) | `@vrsen/openswarm` | `openswarm "<prompt>"` |

You pick a flavor when hiring the agent. The adapter assembles the right argv
shape for each. If both are installed on the host, set `command` to the
absolute path to disambiguate.

## What this adapter does

- Renders Paperclip's standard wake payload into a prompt string
- Joins it with optional `instructionsFilePath` content + `promptTemplate`
- Spawns one OpenSwarm process per heartbeat run with the right argv for the
  flavor
- Streams stdout/stderr into Paperclip's transcript
- Reports exit code, timeout, and a `resultJson` blob with full stdout/stderr

## What this adapter does NOT do (yet)

- No session resume — each heartbeat is a fresh `openswarm exec` invocation.
  unohee's daemon mode (`openswarm start`) keeps state in `better-sqlite3` +
  LanceDB but is intentionally out of band of this adapter for clean
  heartbeat semantics.
- No usage/cost ingestion — OpenSwarm tracks cost in its own data store; the
  Paperclip-side billing pipeline is best-effort.
- No skills sync — Paperclip skills aren't symlinked into OpenSwarm yet. Use
  OpenSwarm's own configuration (`config.yaml` for unohee, env vars for
  vrsen) to manage agent capability.

These are deliberate trade-offs to ship the adapter today; expand any of them
when you have a concrete need.

## Configuration

See `agentConfigurationDoc` in `src/index.ts` for the full field reference. At
a minimum you'll set:

```yaml
flavor: unohee     # or "vrsen"
cwd: /path/to/working/dir
env:
  ANTHROPIC_API_KEY: ...   # via secret store, not committed
  # for unohee with daemon-style features:
  LINEAR_API_KEY: ...
  DISCORD_TOKEN: ...
```

## Why a custom adapter rather than the built-in `process` adapter

Paperclip's built-in `process` adapter takes static `command`/`args`. This
adapter renders the Paperclip wake payload (issue, comments, status,
priority) into a prompt string at run time and threads it into argv. That
unlocks issue-driven OpenSwarm wakes — i.e. an OpenSwarm-backed agent
actually responds to the right Paperclip issue per heartbeat instead of
running a fixed command.
