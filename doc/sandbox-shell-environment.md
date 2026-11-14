# Codex shell certificate trust

Codex shell environment policies always allow these certificate-trust variable
names through `shell_environment_policy.include_only`:

`SSL_CERT_FILE`, `SSL_CERT_DIR`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`,
`DENO_CERT`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`.

Sandbox runtimes inject these variables into the execution environment when
they launch the agent, after the controller has already constructed the shell
environment policy. The policy therefore allows the names even when no value
exists on the controller at policy-construction time. Values come from the
execution environment at launch; missing variables remain unset; values are
never serialized into Codex arguments or configuration. The same names pass
the supervised-process and app-server environment filters so an injected value
survives every stage down to the model-issued shell command.

This list carries trust configuration only. Provider credentials keep their
existing exclusions, and shell inheritance stays bounded by the explicit
`include_only` allowlist. Allowing the names also grants no filesystem access:
the CA file or directory a variable points at must already be readable under
the sandbox's existing filesystem policy.

The canonical name list is `CERTIFICATE_ENVIRONMENT_KEYS` in
`packages/paperclip-runner/src/configured-environment.ts`; the legacy adapter
mirror lives in `packages/adapter-utils/src/codex-shell-environment.ts`.
