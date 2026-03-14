---
title: 貯存
summary: 本機磁碟與 S3 相容存儲
---
Paperclip 使用可設定的儲存提供者儲存上傳的檔案（問題附件、映像）。

## 本機磁碟（預設）

文件儲存在：

```
~/.paperclip/instances/default/data/storage
```

無需配置。適合本地開發和單機部署。

## S3 相容存儲

對於生產或多節點部署，請使用與 S3 相容的物件儲存（AWS S3、MinIO、Cloudflare R2 等）。

透過CLI配置：

```sh
pnpm paperclipai configure --section storage
```

## 配置

|供應商|最適合 |
|----------|----------|
| `local_disk` |本地開發、單機部署|
| `s3` |生產、多節點、雲端部署 |

儲存配置儲存在實例設定檔中：

```
~/.paperclip/instances/default/config.json
```