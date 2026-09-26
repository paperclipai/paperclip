# R2 Data Catalog Configuration

Inspect the existing bucket, catalog, engine versions, and credential configuration before making changes. Use the project's installed tools and preserve its environment-variable or secret-management conventions.

| Task | Documentation |
|------|---------------|
| Enable a catalog and obtain connection details | [Enable R2 Data Catalog](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/#enable-r2-data-catalog-on-a-bucket) |
| Select credentials for readers, writers, or maintenance | [Authenticate your Iceberg engine](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/#authenticate-your-iceberg-engine) |
| Configure compaction and its service credential | [Enable compaction](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/#enable-compaction) |
| Configure snapshot retention | [Enable snapshot expiration](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/#enable-snapshot-expiration) |
| Choose file sizes, retention policy, and maintenance scope | [Table maintenance](https://developers.cloudflare.com/r2-data-catalog/table-maintenance/) |
| Connect a Python client | [PyIceberg](https://developers.cloudflare.com/r2-data-catalog/config-examples/pyiceberg/) |
| Connect Spark | [PySpark](https://developers.cloudflare.com/r2-data-catalog/config-examples/spark-python/) |
| Connect another query engine | [Engine configuration guides](https://developers.cloudflare.com/r2-data-catalog/config-examples/) |
| Disable catalog access | [Disable R2 Data Catalog](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/#disable-r2-data-catalog-on-a-bucket) |

Copy the Catalog URI and Warehouse name exactly from the catalog detail page or Wrangler enable output. Scope both catalog and storage permissions to the operations the client needs; readers do not need a blanket write-enabled token. Treat maintenance credentials separately from reader credentials. Verify connectivity with a read operation before attempting writes, then check catalog and credential status through the [control-plane API](api.md).
