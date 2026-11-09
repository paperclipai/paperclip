# Native remote continuity regression

The opt-in case in
`server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts`
runs the real executor, PostgreSQL, TLS ingress, Rust runner, remote file transfer,
and backup validation against a deterministic fake Codex process in Linux. It
checks the same runner process identity and one provider process across three warm
turns, provider history reuse, and verified suspension at idle close. Separate
cases kill the actual controller process and recover the next turn. They reject
a still-live controller and a replacement sandbox before reconnecting. Legacy
checkpoints and changed process configuration require verified suspension and
replacement, while preserving the conversation and starting each turn once.
Recovery can restart a provider to refresh its tool contract; process reuse is
required for ordinary healthy follow-ups.
Each recovery case includes another healthy turn after the recovered turn and
asserts that it does not start another runner or provider process.
It does not qualify a live model or a sandbox provider API.

Use a disposable Linux container with Node.js, `sh`, `tar`, `base64`, `ps`, and
`setsid`. Build `paperclip-runnerd` and `fake-codex-app-server` from the checkout's
`packages/paperclip-runner/runner/Cargo.toml` for that container's architecture.
Keep the Linux runner binary on the host as well: the product hashes and stages
that artifact. Put the fake provider at `/opt/continuity/fake-codex-app-server`
inside the container. Do not put credentials in this container.

Start the container with `--init` and publish container port 43127 on localhost.
Read its assigned port with `docker port CONTAINER 43127`; an automatic host port
can change after a container restart. The test opens a local TLS tunnel to this
port. Create a test-only certificate and key:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /tmp/continuity-test.key -out /tmp/continuity-test.crt \
  -days 1 -subj '/CN=localhost' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'
```

Create an executable wrapper on the host at `/tmp/continuity-fake-codex`:

```sh
#!/bin/sh
if [ "$1" = '--version' ]; then
  echo 'codex-cli 0.999.0'
  exit 0
fi
exec /opt/continuity/fake-codex-app-server \
  --state-file-in-codex-home --durable-turn-ids --record-process-start \
  --call-log "$PWD/provider-calls.log" "$@"
```

Run the test with the container name, current host port, and Linux artifact path:

```sh
NODE_EXTRA_CA_CERTS=/tmp/continuity-test.crt \
PAPERCLIP_TEST_RUNNER_TLS_KEY=/tmp/continuity-test.key \
PAPERCLIP_TEST_RUNNER_CONTAINER=CONTAINER \
PAPERCLIP_TEST_RUNNER_PORT=HOST_PORT \
PAPERCLIP_TEST_LINUX_RUNNER_BINARY=/path/to/linux/paperclip-runnerd \
PAPERCLIP_TEST_FAKE_CODEX_WRAPPER=/tmp/continuity-fake-codex \
pnpm exec vitest run \
  server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts \
  -t 'preserves remote warm continuity' --maxWorkers=1
```

The caller owns the disposable container. Remove it after the run, including
after failure; failed cases can retain remote processes and files for inspection.
The test cleans up its database and host session directories.
