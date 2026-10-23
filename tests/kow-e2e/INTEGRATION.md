# Running Paperclip agents through kow (integration pattern)

Paperclip and [keys-on-the-wire (kow)](https://github.com/inflightsec/keys-on-the-wire)
integrate **today, with no changes to Paperclip core.** A `process`-adapter agent
runs an arbitrary command; wrapping that command in `kow run` routes the agent's
egress through kow, which swaps a placeholder for the real credential on the wire.
The agent process only ever holds the placeholder.

This directory's smoke test (`tests/smoke-core.ts`) exercises credential brokering
through `kow run` inside a disposable VM. It does not run Paperclip itself; that
layer is still pending. See `SPEC.md` for the acceptance criteria.

## The pattern

Point a `process`-adapter agent's command at `kow run -- <your agent command>`:

```jsonc
// agent adapterType: "process"
{
  "command": "kow",
  "args": [
    "run",
    "--ca-cert", "/path/to/kow-ca.pem",      // kow's proxy CA, trusted by the agent
    "--proxy",   "http://127.0.0.1:14322",    // the local kow proxy
    "--",
    "node", "my-agent.js"                      // your real agent command
  ]
}
```

`kow run` sets `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE` for the
child only, then execs it. Paperclip's own run-scoped env (`PAPERCLIP_API_URL`,
`PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`, …) is passed through untouched, so the
agent still talks to the Paperclip API normally — only its *outbound credentialed*
calls are brokered.

## What kow handles

- **Per-destination binding.** kow injects a secret only for the exact host +
  method + path you bind; everything else is forwarded unmodified.
- **The agent never sees the key.** The real secret lives in kow's backend
  (vault, Secret Manager, Keychain, or a static file for tests); the agent's
  environment, argv, and process memory carry only the placeholder.
- **Audit.** Every substitution is an `inject_decision` record in kow's audit log.

## Caveats

- The agent's HTTP client must honour `HTTPS_PROXY` (e.g. `curl`, or Node ≥20
  with `NODE_USE_ENV_PROXY=1`; Node 18's global `fetch` does **not** — this
  harness uses `curl`).
- This is the *process-adapter* pattern. A native, ergonomic integration (a kow
  secret-provider + pointing the sandbox egress proxy at kow) is a core change
  proposed separately after coordination — see the PR description.
