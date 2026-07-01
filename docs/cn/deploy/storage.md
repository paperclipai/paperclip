---
title: 贮存
summary: 本地磁盘与 S3 兼容存储
---
Paperclip 使用可配置的存储提供程序存储上传的文件（问题附件、图像）。

## 本地磁盘（默认）

文件存储在：

```
~/.paperclip/instances/default/data/storage
```

无需配置。适合本地开发和单机部署。

## S3 兼容存储

对于生产或多节点部署，请使用与 S3 兼容的对象存储（AWS S3、MinIO、Cloudflare R2 等）。

通过CLI配置：

```sh
pnpm paperclipai configure --section storage
```

## 配置

|供应商|最适合 |
|----------|----------|
| `local_disk` |本地开发、单机部署|
| `s3` |生产、多节点、云部署 |

存储配置存储在实例配置文件中：

```
~/.paperclip/instances/default/config.json
```