---
title: Docker
summary: Docker 撰写快速入门
---
在Docker中运行Paperclip，本地无需安装Node或pnpm。

## Compose 快速入门（推荐）

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

打开【http://localhost:3100](http://localhost:3100）。

默认值：

- 主机端口：`3100`
- 数据目录：`./data/docker-paperclip`

使用环境变量覆盖：

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=./data/pc \
  docker compose -f docker-compose.quickstart.yml up --build
```

## 手动 Docker 构建

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## 数据持久化

所有数据都保存在绑定挂载下（`./data/docker-paperclip`）：

- 嵌入PostgreSQL数据
- 上传的资源
- 本地秘密密钥
- 智能体工作区数据

## Docker 中的 Claude 和 Codex 适配器

Docker 映像预安装：

- `claude`（人类Claude Code CLI）
- `codex` (OpenAI Codex CLI)

传递 API 键以启用本地适配器在容器内运行：

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

如果没有 API 密钥，应用程序将正常运行 - 适配器环境检查将显示缺少的前置条件。