---
name: config-parity-auditor
description: >
  Audit configuration parity between strategy deployments: verify that the
  parameters loaded by the live trading engine match the declared config in
  version control, and flag any drift. Use after config deployments and on
  periodic health-check cycles.
---

# Config Parity Auditor

Compares the live-running configuration against the authoritative config
stored in version control (or a designated config registry). Reports any
drift that could affect trading behavior.

## Parity Checks

### Parameter Equality
- Every parameter in the authoritative config exists in the live config.
- Every parameter in the live config is declared in the authoritative config
  (no undocumented overrides).
- For numeric parameters: `|live - authoritative| ≤ tolerance` where
  tolerance is defined per-parameter in the config schema.

### Secrets and Credentials
- API keys, webhook secrets, and exchange credentials are NOT compared for
  value equality (obviously). Instead, verify that the secret *exists* in
  the live environment and that its name/alias matches the authoritative config.
- Flag any live credential that references a deprecated or rotated key name.

### Environment Variables
- `NODE_ENV`, `PAPERCLIP_DEPLOYMENT_MODE`, `LOG_LEVEL`, and all
  `POLY_WEATHER_*` env vars match their declared values.

### Strategy Version
- The git commit SHA or Docker image tag running live matches the SHA
  declared in the deployment manifest.

## Output

Return `{parity: boolean, drifts: DriftEntry[], discrepancies: Discrepancy[]}`.

- `drifts`: parameters that differ and should be investigated.
- `discrepancies`: parameters missing from live or authoritative config
  (always require human review before continuing).

If parity is false and discrepancies exist, halt trading until resolved.
