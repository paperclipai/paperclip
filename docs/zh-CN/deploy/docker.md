---
title: Docker 部署 (Docker)
summary: 使用 Docker Compose 快速首发
---

无需在本地安装 Node 或 pnpm 等复杂的开发依赖，直接在 Docker 中运行 Paperclip。

## Compose 快速首发 (推荐)

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

完成启动后，打开浏览器访问：[http://localhost:3100](http://localhost:3100)。

默认配置：

- 宿主机端口映射: `3100`
- 落盘数据目录: `./data/docker-paperclip`

可以使用环境变量来覆写变更这些配置：

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=./data/pc \
  docker compose -f docker-compose.quickstart.yml up --build
```

## 手动构建 Docker 镜像 (Manual Docker Build)

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## 数据持久化落盘 (Data Persistence)

所有的数据都会被持久化保存在挂载的绑定目录之下 (`./data/docker-paperclip`)：

- 嵌入式 PostgreSQL 的数据源
- 已上传的相关附件及资产
- 私有本地机密钥匙环
- 智能体跑业务时的沙盒工作区数据

## 在 Docker 中使用 Claude 和 Codex 适配器

当前官方构建的这个 Docker 镜像底层已经默认预装了：

- `claude` (即 Anthropic 的 Claude Code CLI)
- `codex` (即 OpenAI 的 Codex CLI)

只需要向内传递 API 密钥环境变量，即可直接在容器内部激活启用这些本地关联适配器的运行环境：

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

即便不提供 API 密钥，主应用程序依然也会正常启动并运行 — 只是当您尝试指派智能体时，适配器的运行前环境检查功能会直接在界面上提示缺少了某项必要前置依赖罢了。
