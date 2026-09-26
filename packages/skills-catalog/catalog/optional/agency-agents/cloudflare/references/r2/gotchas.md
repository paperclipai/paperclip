# R2 Gotchas & Troubleshooting

Use the current references to diagnose the actual response or error instead of copying a workaround.

| Symptom or decision | What to check |
|---------------------|---------------|
| Listing stops early or escapes the intended prefix | Follow `truncated` and the returned cursor, retaining the original prefix, delimiter, and metadata options on subsequent requests. See the listing section of the [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). |
| Conditional read has no body, or conditional write returns null | Distinguish a missing object from a failed condition; choose the HTTP response for the actual request condition. See conditional operations in the [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). |
| ETag, metadata, checksum, or stream upload behaves unexpectedly | Check supported values and return types in the [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), the [Worker upload example](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/), and [Workers streams](https://developers.cloudflare.com/workers/runtime-apis/streams/). |
| Multipart upload fails or cannot be resumed | Check part constraints and handle an upload that has already completed or aborted: [multipart guide](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/) and [API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). |
| S3 authentication or signed URL fails | Verify credentials, endpoint, region, operation, signed headers, and expiry using [SDK setup](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/), [authentication](https://developers.cloudflare.com/r2/api/tokens/), and [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/). |
| Browser fails but an HTTP client succeeds | Check [CORS](https://developers.cloudflare.com/r2/buckets/cors/) and [troubleshooting](https://developers.cloudflare.com/r2/platform/troubleshooting/). |
| Local and deployed data or behavior differ | Check [local development](https://developers.cloudflare.com/workers/local-development/), [supported bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/), and the local persistence options in [Wrangler R2 commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/). |
| Reads serve old or missing content after an update | Check the [consistency model and cache interactions](https://developers.cloudflare.com/r2/reference/consistency/). |
| Upload size, metadata size, storage cost, or lifecycle behavior is unexpected | Fetch [limits](https://developers.cloudflare.com/r2/platform/limits/), [pricing](https://developers.cloudflare.com/r2/pricing/), [storage classes](https://developers.cloudflare.com/r2/buckets/storage-classes/), and [object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/). |

For other failures, start with [R2 troubleshooting](https://developers.cloudflare.com/r2/platform/troubleshooting/) and [error codes](https://developers.cloudflare.com/r2/api/error-codes/).
