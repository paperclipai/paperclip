# AI Search Troubleshooting Routes

| Symptom or question | Documentation |
|---------------------|---------------|
| API request fails, including authentication or missing instances | [API error codes](https://developers.cloudflare.com/ai-search/troubleshooting/api-error-codes/) |
| Upload or sync succeeds but content fails during processing | [Indexing error codes](https://developers.cloudflare.com/ai-search/troubleshooting/indexing-error-codes/) |
| Content is missing or stale | [Syncing](https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/) and [supported data sources and formats](https://developers.cloudflare.com/ai-search/configuration/data-source/) |
| Filters return unexpected documents or no matches | [Filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/) and [metadata attributes](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/) |
| Thresholds exclude results or responses need tuning | [Result controls](https://developers.cloudflare.com/ai-search/configuration/retrieval/result-controls/) |
| Binding types, response parsing, or streaming fail after an upgrade | [Workers binding migration](https://developers.cloudflare.com/ai-search/api/migration/workers-binding/) |
| Capacity, file-size, or billing questions | [Limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/) |

For legacy binding behavior, start with [API routes](api.md). Do not apply current filter syntax or response shapes to legacy calls without following the migration guide.
