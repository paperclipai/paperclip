# R2 Data Catalog Troubleshooting

Identify whether the failure occurs in catalog administration, engine metadata access, or underlying object access before changing permissions or client settings.

| Check | Documentation |
|-------|---------------|
| Catalog enablement, Catalog URI, or Warehouse mismatch | [Manage catalogs](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/) |
| Reader/writer token scope or file-access denial | [Engine authentication](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/#authenticate-your-iceberg-engine) — inspect both catalog and storage permissions |
| Missing maintenance credentials or wrong table/catalog configuration | [Control-plane API](https://developers.cloudflare.com/api/resources/r2_data_catalog/) and [enable compaction](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/#enable-compaction) |
| Compaction backlog, retention, or orphaned files | [Table maintenance](https://developers.cloudflare.com/r2-data-catalog/table-maintenance/) |
| PyIceberg connection or table creation | [PyIceberg configuration](https://developers.cloudflare.com/r2-data-catalog/config-examples/pyiceberg/) |
| Spark dependency, credential-vending, or signing configuration | [PySpark configuration](https://developers.cloudflare.com/r2-data-catalog/config-examples/spark-python/) |
| Deleted data is still present | [Deleting data](https://developers.cloudflare.com/r2-data-catalog/deleting-data/) |
| Catalog request or maintenance-job diagnosis | [Metrics and analytics](https://developers.cloudflare.com/r2-data-catalog/observability/metrics/) |

Compare the client's configured URI and warehouse with the actual catalog values. Test a read operation first; do not grant write access merely to resolve a reader's failure. For schema or concurrency errors, inspect the installed engine's behavior and current table metadata before retrying. The [get-table note](api.md#get-table-repository-specific-metadata-introspection-note) is not a substitute for verifying the service's response contract.

See [configuration](configuration.md) and [patterns](patterns.md) for implementation choices.
