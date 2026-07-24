# SSI Explore Selector Validation

SAG-5649 built the fixture-testable `ssi_explore.js` path without live SSI
credentials. The remaining live-DOM selector validation is intentionally
deferred until the operator injects `SSI_BASE_URL`, one supported auth method
(`SSI_USERNAME` + `SSI_PASSWORD`, or `SSI_SESSION_TOKEN`), and
`SSI_AUTH_STATE_PATH` into the SSI Director runtime.

The script is read-only after login: non-GET/HEAD/OPTIONS requests are aborted
except the configured login POST. If live SSI selectors differ from the default
`data-ssi-*` selectors, provide the `SSI_*_SELECTOR` env overrides documented in
`parseConfigFromEnv`.
