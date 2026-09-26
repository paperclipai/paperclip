# R2 Data Catalog Patterns

Choose the engine based on the project's existing runtime and workload, then retrieve its current connection example.

| Need | Starting point |
|------|----------------|
| Python catalog operations and ingestion without a Spark deployment | [PyIceberg](https://developers.cloudflare.com/r2-data-catalog/config-examples/pyiceberg/) |
| Existing Spark ETL and distributed table processing | [PySpark](https://developers.cloudflare.com/r2-data-catalog/config-examples/spark-python/) |
| Connect an existing SQL engine | [Engine configuration guides](https://developers.cloudflare.com/r2-data-catalog/config-examples/) |
| Query through Cloudflare's serverless SQL service | [R2 SQL](../r2-sql/) |
| Stream events into tables | [Pipelines patterns](../pipelines/patterns.md) |

Use the discovered Catalog URI and Warehouse name from [configuration](configuration.md). Match dependencies to the installed engine and the current guide instead of adopting a universal pinned Spark/Iceberg combination.

Plan ingestion, query, and maintenance responsibilities together. Prefer [automatic table maintenance](https://developers.cloudflare.com/r2-data-catalog/table-maintenance/) when it meets the workload; align retention with time-travel needs before enabling expiration. For engine-specific partitioning, schema evolution, or manual procedures, consult that engine's linked upstream documentation and verify behavior on representative data.

When multiple writers share a table, design recovery around the actual failed operation and the engine's commit semantics. Reproduce conflicts and ensure retries do not duplicate application work. See [API selection](api.md) and [troubleshooting](gotchas.md).
