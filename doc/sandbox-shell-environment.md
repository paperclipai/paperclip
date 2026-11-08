# Codex shell certificate trust

Codex shell environment policies allow these certificate-trust variable names:
`SSL_CERT_FILE`, `SSL_CERT_DIR`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`,
`DENO_CERT`, `REQUESTS_CA_BUNDLE`, and `CURL_CA_BUNDLE`.

The policy includes the names even when their values do not exist on the
Paperclip controller. Values come from the execution environment at launch.
Missing variables remain unset. Values are not written into Codex arguments.
Provider credentials retain their existing isolation.

For ACPX Codex, this policy is emitted when an agent identity or configured task
environment keys are present.

Preserving these variables does not grant filesystem access to the CA files or
directories they reference. Those paths must already be readable under the
sandbox’s existing filesystem policy. Custom CA files outside the sandbox’s
existing readable paths remain unsupported.
