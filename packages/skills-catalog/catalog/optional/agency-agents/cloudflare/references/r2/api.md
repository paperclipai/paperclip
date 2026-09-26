# R2 API Reference

Fetch the relevant page before writing code. Use the Workers API for bucket bindings and the S3 API for S3 clients; their types and semantics differ.

| Task | Current documentation |
|------|-----------------------|
| Read, write, inspect, delete, or list objects; metadata, checksums, ranges, and return types | [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) |
| Implement a Worker that serves or writes objects | [Use R2 from Workers](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/) |
| Create, resume, complete, or abort multipart uploads | [Multipart Worker and client example](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/) |
| Check supported S3 operations and headers | [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) |
| Configure an S3 JavaScript client | [AWS SDK for JavaScript v3](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/) |
| Sign temporary upload or download access | [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| Encrypt with customer-provided keys | [SSE-C usage](https://developers.cloudflare.com/r2/examples/ssec/) |
| Manage buckets and objects from the command line | [Wrangler R2 commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/) |

Use generated project types rather than maintaining local copies of R2 interfaces; see [Workers TypeScript guidance](https://developers.cloudflare.com/workers/languages/typescript/). For pagination and conditional response handling, read [gotchas.md](./gotchas.md) alongside the API reference.
