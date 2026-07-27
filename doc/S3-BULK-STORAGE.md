# S3 bulk storage operations

Cloud runtimes (`PAPERCLIP_K8S_IN_CLUSTER=true`) default attachments to the configured S3 provider. Explicit `PAPERCLIP_STORAGE_PROVIDER` or `config.json` storage settings still win. Completed run logs use the same bucket/settings by default and are stored under `<storage-prefix>/run-logs/`; dedicated `RUN_LOG_S3_*` variables remain an override.

Encrypted state snapshots keep durable state at `instance-state/<instance>/...`. Manifest entries with retention are written separately at `retention/<days>-days/instance-state/<instance>/...`, so transcript/run-log retention cannot delete Codex sqlite snapshots. The approved transcript and run-log retention is 90 days.

Apply the lifecycle policy with:

```sh
PAPERCLIP_STORAGE_S3_BUCKET=paperclip \
PAPERCLIP_STORAGE_S3_PREFIX=production \
scripts/apply-s3-bulk-lifecycle.sh
```

The script uses `aws s3api put-bucket-lifecycle-configuration`. Set `AWS_ENDPOINT_URL` for an S3-compatible provider. Re-running it is idempotent but replaces the bucket lifecycle configuration, so merge additional bucket rules into the script payload before applying on a shared bucket.

Litestream was evaluated for Codex sqlite continuous point-in-time restore. It improves recovery point objectives, but adds a runtime binary/sidecar, per-database replica configuration, monitoring, restore orchestration, and ongoing version/security maintenance. P4 ships scheduled `sqlite3 .backup` copies without that dependency; adopting Litestream remains an operations decision for a later cloud phase.
