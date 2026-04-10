# @paperclipai/plugin-aws-file-store

S3-backed shared file store for Paperclip agents and users.

This plugin gives every organization a hierarchical knowledge base that lives
in an S3 bucket. It works against AWS S3, MinIO, or any S3-compatible backend
through the official `@aws-sdk/client-s3` client. Agents and humans share the
same view of the bucket, so anything one party writes is immediately available
to the other.

> Inspired by [paperclipai/paperclip#3230](https://github.com/paperclipai/paperclip/pull/3230),
> which proposed the same capability as a shell-based skill. This plugin
> packages the same idea as a first-class Paperclip plugin so the host owns
> capability scoping, configuration, lifecycle, and metrics instead of relying
> on agents to chain raw `aws` CLI commands.

## Layout

Every organization gets two top-level directories under the configured prefix:

```
<bucket>/<prefix>/
├── knowledge-base/        # curated documents agents use for their work
│   ├── originals/         # native files (PDF, DOCX, images, etc.)
│   └── markdown/          # markdown-converted versions
└── income/                # incoming files that still need triage
```

The recommended workflow:

1. New material lands in `income/`.
2. An agent reads it, converts it to markdown, files it under
   `knowledge-base/markdown/<topic>/`, and removes the original from `income/`.
3. Agents prefer reading from `knowledge-base/markdown/` because the content is
   already plain text and cheap to feed into a model.

The plugin keeps a small JSON file index in plugin state that records each
file's tags, description, author, and timestamps. Search queries hit this
index instead of scanning the bucket, so they stay fast even with thousands of
files.

## Tools the plugin contributes

| Tool | Purpose |
|---|---|
| `fs-write` | Write a file (text or base64) at a path, with optional tags and description. |
| `fs-read` | Read a file. Text files come back as UTF-8; binaries come back as base64. |
| `fs-list` | List a directory's immediate children, or recursively when asked. |
| `fs-tree` | Render a visual tree of a subtree, capped by a configurable max depth. |
| `fs-mkdir` | Create a directory (and any missing parents). |
| `fs-move` | Move or rename a file or directory and update the file index in lockstep. |
| `fs-remove` | Remove a file, or a directory with `recursive: true`. |
| `fs-stat` | Return size, type, timestamps, tags, and description for a path. |
| `fs-search` | Search files by name pattern, tags, free-text query, or path subtree. |

All tools are scoped through the standard plugin context, so audit logging,
metrics, and capability checks happen on the host side.

## Configuration

Configured per plugin instance via `instanceConfigSchema`:

| Field | Default | Notes |
|---|---|---|
| `s3Bucket` | `paperclip` | Required. S3 bucket name. |
| `s3Region` | `us-east-1` | AWS region (or any region the backend accepts). |
| `s3Endpoint` | `http://localhost:9000` | Override for MinIO / S3-compatible backends. Leave empty for AWS S3. |
| `s3Prefix` | `file-store` | Key prefix in the bucket — lets you share a bucket with other services. |
| `s3ForcePathStyle` | `true` | Required for MinIO. Set to `false` for AWS S3 virtual-hosted style. |
| `s3AccessKeyId` | _empty_ | Falls back to the AWS default credential chain when empty. |
| `s3SecretAccessKey` | _empty_ | Falls back to the AWS default credential chain when empty. |
| `maxFileSizeMb` | `50` | Files larger than this are rejected on write. |
| `maxTreeDepth` | `10` | Max depth the `fs-tree` tool will descend by default. |

## Running locally with MinIO

The repository's `docker/docker-compose.yml` ships a `minio` service plus a
one-shot `minio-init` container that creates the bucket. With it, the plugin
works out of the box:

```bash
export MINIO_ROOT_PASSWORD=devsecret  # required by docker-compose.yml
export BETTER_AUTH_SECRET=devsecret
docker compose -f docker/docker-compose.yml up
```

The `server` service receives the matching `AWS_*` and `FILE_STORE_*` env vars,
so when you create an instance of this plugin from the marketplace, the
defaults above will Just Work.

The MinIO console is on `http://localhost:9001` (default credentials
`paperclip` / `$MINIO_ROOT_PASSWORD`).

## Tests

```bash
pnpm --filter @paperclipai/plugin-aws-file-store test
```

The test suite uses a mocked `@aws-sdk/client-s3`, so it does not require a
running MinIO container or any network access. It covers:

- Key prefixing and leading-slash normalization
- Path traversal protection
- `HeadObject` / `ListObjectsV2` fallback in `stat()` to detect directories
- `listDir` filtering of nested entries
- `listRecursive` pagination across `ContinuationToken`
- `move` (copy + delete pair) and the safety check `remove` performs against
  non-empty directories
- The `healthy()` probe used by the plugin's health diagnostics

## Building

```bash
pnpm --filter @paperclipai/plugin-aws-file-store build
```

The build outputs `dist/manifest.js` and `dist/worker.js`, which the Paperclip
plugin loader picks up via the `paperclipPlugin` field in `package.json`.
