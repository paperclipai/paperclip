---
title: Docker
summary: Docker 撰寫快速入門
---
在Docker中執行Paperclip，本地無需安裝Node或pnpm。

## Compose 快速入門（建議）

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

開啟【http://localhost:3100](http://localhost:3100）。

預設值：

- 主機連接埠：`3100`
- 資料目錄：`./data/docker-paperclip`

使用環境變數覆蓋：

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=./data/pc \
  docker compose -f docker-compose.quickstart.yml up --build
```

## 手動 Docker 構建

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## 資料持久化

所有資料都保存在綁定掛載下（`./data/docker-paperclip`）：

- 嵌入PostgreSQL數據
- 上傳的資源
- 本機秘密金鑰
- 智能體工作區數據

## Docker 中的 Claude 和 Codex 轉接器

Docker 映像預先安裝：

- `claude`（人類Claude Code CLI）
- `codex` (OpenAI Codex CLI)

傳遞 API 鍵以啟用本機轉接器在容器內運作：

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

如果沒有 API 金鑰，應用程式將正常運作 - 適配器環境檢查將顯示缺少的前置條件。