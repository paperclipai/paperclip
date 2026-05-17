# vendor · 第三方源码镜像

本目录放 **不入 npm workspace**、供人类或 MCP 本地对照的 **上游仓库快照**。

| 目录 | 上游 | 更新方式 |
| --- | --- | --- |
| **`postgres-mcp/`** | [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) | 删除该目录后重新浅克隆：`git clone --depth 1 https://github.com/crystaldba/postgres-mcp.git vendor/postgres-mcp`，再按需删掉 `.git` 以便与本仓库一并提交（见 `013` 专文说明）。 |

Paperclip 编排平面取证与 Cursor MCP 接入说明：**[`docs/项目计划/最佳实践/013-实践-编排平面AI查数据脚手架.md`](../docs/项目计划/最佳实践/013-实践-编排平面AI查数据脚手架.md)**。
