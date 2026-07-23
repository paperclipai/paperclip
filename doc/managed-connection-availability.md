# Managed connection availability

Managed ownership modes are declared in provider `AppDefinition` data but fail closed until an operator enables them. Paperclip reads the availability overlay on every gallery request and again when a new connection is created, so the same control is also the kill switch for stale wizard sessions.

## Live file-backed control

Set `PAPERCLIP_CONNECTION_OWNERSHIP_AVAILABILITY_FILE` to a JSON file readable by the Paperclip server:

```json
{
  "slack": { "platform_shared": true },
  "linear": { "platform_provisioned": true },
  "vercel": { "platform_shared": false }
}
```

To flip a provider **on**, atomically replace the file with its managed mode set to `true`. The mode appears on the next gallery request; no Paperclip code deploy or server restart is required.

To flip a provider **off**, atomically replace the file with its managed mode set to `false` or remove the provider entry. The mode disappears on the next gallery request, and new connection requests from already-open wizard sessions are rejected with `ownership_mode_unavailable`.

Only `platform_shared` and `platform_provisioned` are configurable. Customer-owned and dynamic-registration modes remain available so the operator kill switch cannot remove the sovereignty paths.

For process-managed environments that cannot mount a file, `PAPERCLIP_CONNECTION_OWNERSHIP_AVAILABILITY` accepts the same JSON inline. Inline changes take effect when the process environment is reloaded; use the file-backed form for live flips.
