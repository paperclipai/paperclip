# R2 Data Catalog

Use R2 Data Catalog for Iceberg analytics and data pipelines on object storage. For transactional application queries, consider a database; for unstructured objects, use [R2](../r2/).

Distinguish the Iceberg REST catalog used by query engines from Cloudflare's control-plane API for catalog administration. Start with the workflow you need:

| Task | Reference |
|------|-----------|
| Enable a catalog, discover connection values, and choose credentials | [Configuration](configuration.md) |
| Select administration or engine APIs | [API selection](api.md) |
| Choose a Python, Spark, or SQL workflow | [Patterns](patterns.md) |
| Diagnose authentication, maintenance, or client problems | [Troubleshooting](gotchas.md) |

Copy the actual **Catalog URI** and **Warehouse name** from the catalog detail page or Wrangler's enable output. Pass both to the selected engine; do not reconstruct them from an assumed bucket naming convention. Retrieve [Manage catalogs](https://developers.cloudflare.com/r2-data-catalog/manage-catalogs/) before setup or permission changes.

Related workflows: [Pipelines](../pipelines/) for ingest and [R2 SQL](../r2-sql/) for querying tables.
