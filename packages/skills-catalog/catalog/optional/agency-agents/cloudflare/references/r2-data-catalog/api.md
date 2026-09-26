# R2 Data Catalog API Selection

Use the Iceberg REST catalog through an engine for table reads and writes; use the Cloudflare control-plane API for catalog administration. Copy the catalog connection values from the actual environment as described in [configuration](configuration.md).

| Task | Documentation |
|------|---------------|
| Enable or disable catalogs; inspect status, credentials, namespaces, tables, and maintenance configuration | [R2 Data Catalog control-plane API](https://developers.cloudflare.com/api/resources/r2_data_catalog/) — select the affected operation for its schema, pagination, and namespace encoding |
| Connect and create tables through Python | [PyIceberg configuration](https://developers.cloudflare.com/r2-data-catalog/config-examples/pyiceberg/) |
| Connect, create, write, and query through Spark | [PySpark configuration](https://developers.cloudflare.com/r2-data-catalog/config-examples/spark-python/) |
| Plan automatic compaction and snapshot expiration | [Table maintenance](https://developers.cloudflare.com/r2-data-catalog/table-maintenance/) |
| Delete rows, tables, or associated files | [Deleting data](https://developers.cloudflare.com/r2-data-catalog/deleting-data/) |

For engine-specific operations beyond these Cloudflare examples, follow the upstream engine documentation linked from the relevant configuration guide and check the installed version. Do not infer engine method signatures from the control-plane API.

## Get Table (repository-specific metadata introspection note)

This existing repository note is retained because the published control-plane API reference does not document this operation or its snapshot-pruning response. Verify availability and response behavior against the target service or authoritative implementation before relying on it; it is not a documented API guarantee. Do not substitute the documented list-tables response for this metadata response.

`GET /namespaces/{ns}/tables/{table}` returns schema, partition spec, sort order, and snapshot info — like Iceberg "load table" but on the control plane, with snapshots pruned to the most recent 10.

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/r2-catalog/$BUCKET/namespaces/live/tables/earthquakes" \
  -H "Authorization: Bearer $API_TOKEN"
```

```json
{"result": {
  "identifier": {"namespace": ["live"], "name": "earthquakes"},
  "table_uuid": "019edccf-3ac8-73e3-...",
  "metadata_location": "s3://live-data/__r2_data_catalog/.../metadata/01225-....metadata.json",
  "total_snapshots": 1225,
  "returned_snapshots": 10,
  "metadata": { /* standard Iceberg TableMetadata: schemas, partition-specs, sort-orders,
                   properties, current-snapshot-id, snapshots (≤10), snapshot-log, refs */ }
}, "success": true}
```

| Field | Description |
|-------|-------------|
| `identifier` | `{namespace: [...], name}` |
| `table_uuid` | Iceberg table UUID |
| `metadata_location` | R2 path to current metadata file |
| `total_snapshots` | Total before pruning |
| `returned_snapshots` | Count in `metadata.snapshots` (max 10) |
| `metadata` | Standard [Iceberg TableMetadata](https://iceberg.apache.org/spec/#table-metadata-fields), arrays pruned to 10 |

See [patterns](patterns.md) for engine selection and [troubleshooting](gotchas.md) for diagnosis.
