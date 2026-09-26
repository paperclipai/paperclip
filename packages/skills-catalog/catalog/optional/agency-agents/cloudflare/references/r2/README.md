# Cloudflare R2 Object Storage

Use R2 for objects such as uploads, media, backups, and static assets. Fetch the linked documentation before implementing; API signatures, configuration, limits, and pricing belong in the current docs.

## Choose an access path

- Use a Workers binding for object access inside a Worker: [Workers API setup](https://developers.cloudflare.com/r2/get-started/workers-api/).
- Use the S3-compatible API for existing S3 clients or direct client access through presigned URLs: [S3 setup](https://developers.cloudflare.com/r2/get-started/s3/). Check supported operations rather than assuming full S3 parity.
- Decide whether objects need application authorization, temporary access, or public delivery before exposing the bucket. See [patterns.md](./patterns.md).

## Find the task

| Task | Reference |
|------|-----------|
| Bindings, credentials, local development, bucket settings | [configuration.md](./configuration.md) |
| Object operations, metadata, conditions, multipart, CLI | [api.md](./api.md) |
| Uploads, streaming, caching, public delivery, event processing | [patterns.md](./patterns.md) |
| Pagination, conditional responses, failed uploads, limits | [gotchas.md](./gotchas.md) |

For other topics, discover pages through the [R2 documentation index](https://developers.cloudflare.com/r2/llms.txt). Check [pricing](https://developers.cloudflare.com/r2/pricing/) before estimating costs.

## See also

- [Workers](https://developers.cloudflare.com/workers/) for request handling.
- [KV](../kv/) or [D1](../d1/) for application metadata associated with objects.
- [Queues](../queues/) for asynchronous processing of object events.
