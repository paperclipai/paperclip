# Codex shell certificate trust

Codex shells always allow these certificate-trust variable names:
`SSL_CERT_FILE`, `SSL_CERT_DIR`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`,
`DENO_CERT`, `REQUESTS_CA_BUNDLE`, and `CURL_CA_BUNDLE`.

The policy includes the names even when their values do not exist on the
Paperclip controller. Values come from the execution environment at launch.
Missing variables remain unset. Values are not written into Codex arguments.
Provider credentials retain their existing isolation.

A controlled local HTTPS fixture checks real `git` and `gh` requests with and
without a private CA after policy construction. It needs `git`, `gh`, `openssl`,
and permission to open a loopback listener:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/verify-codex-shell-ca.ts
```
