---
title: Storage
summary: Local disk와 S3-compatible storage
---

# Storage

Paperclip은 issue attachment, image 같은 uploaded file을 configurable storage provider에 저장합니다.

## Local disk

기본값입니다.

```text
~/.paperclip/instances/default/data/storage
```

추가 설정이 필요 없고, local development와 single-machine deployment에 적합합니다.

## S3-compatible storage

production이나 multi-node deployment에서는 AWS S3, MinIO, Cloudflare R2 같은 S3-compatible object storage를 사용할 수 있습니다.

```sh
pnpm paperclipai configure --section storage
```

## Provider 선택

| Provider | 적합한 경우 |
| --- | --- |
| `local_disk` | local development, single-machine deployment |
| `s3` | production, multi-node, cloud deployment |

storage config는 instance config에 저장됩니다.

```text
~/.paperclip/instances/default/config.json
```
