# 代理公司规范清单

本文档索引了 Paperclip 代码库中所有涉及[代理公司规范（Agent Companies Specification）](docs/公司/01 公司规范 companies-spec.md)（`agentcompanies/v1-draft`）的部分。

在以下场景中使用本文档：

1. **更新规范** — 了解哪些实现代码需要同步修改。
2. **修改涉及规范的代码** — 快速找到所有相关文件。
3. **保持一致性** — 审计实现是否与规范对齐。

---

## 1. 规范与设计文档

| 文件 | 角色 |
|---|---|
| `docs/公司/01 公司规范 companies-spec.md` | **规范性文档** — 定义了以 Markdown 为核心的包格式（COMPANY.md、TEAM.md、AGENTS.md、PROJECT.md、TASK.md、SKILL.md）、保留文件、前置元数据（frontmatter）模式以及供应商扩展约定（`.paperclip.yaml`）。 |
| `doc/plans/2026-03-13-公司导入导出第二版 company-import-export-v2.md` | Markdown 核心包模型切换的实现计划 — 阶段划分、API 变更、UI 方案和发布策略。 |
| `doc/04 实现规格 SPEC-implementation.md` | V1 实现契约；引用了可移植性系统和 `.paperclip.yaml` 伴随文件格式。 |
| `docs/规格说明/02 cliphub计划 cliphub-plan.md` | 早期的蓝图包计划；部分已被 Markdown 核心规范取代（在 v2 计划中有说明）。 |
| `doc/plans/2026-02-16-模块系统 module-system.md` | 模块系统计划；JSON 专属的公司模板部分已被 Markdown 核心模型取代。 |
| `doc/plans/2026-03-14-技能UI产品计划 skills-ui-product-plan.md` | 技能 UI 计划；引用了可移植技能文件和 `.paperclip.yaml`。 |
| `doc/plans/2026-03-14-适配器技能同步推出 adapter-skill-sync-rollout.md` | 适配器技能同步发布计划；与 v2 导入/导出计划配套。 |

## 2. 共享类型与校验器

这些文件定义了服务端、CLI 和 UI 之间的契约。

| 文件 | 定义内容 |
|---|---|
| `packages/shared/src/types/company-portability.ts` | TypeScript 接口：`CompanyPortabilityManifest`、`CompanyPortabilityFileEntry`、`CompanyPortabilityEnvInput`，以及导出/导入/预览的请求和结果类型、代理、技能、项目、问题、周期性例程（recurring routines）、公司的清单条目类型。 |
| `packages/shared/src/validators/company-portability.ts` | 所有可移植性请求/响应结构的 Zod 模式 — 服务端路由和 CLI 均使用。 |
| `packages/shared/src/types/index.ts` | 重新导出可移植性类型。 |
| `packages/shared/src/validators/index.ts` | 重新导出可移植性校验器。 |

## 3. 服务端 — 服务层

| 文件 | 职责 |
|---|---|
| `server/src/services/company-portability.ts` | **核心可移植性服务。** 导出（清单生成、Markdown 文件输出、`.paperclip.yaml` 伴随文件）、导入（图解析、冲突处理、实体创建）、预览（计划操作摘要）。处理技能键派生、周期性任务与例程的映射、遗留周期性任务迁移以及包 README 生成。引用 `agentcompanies/v1` 版本字符串。 |
| `server/src/services/routines.ts` | Paperclip 例程运行时服务。可移植性现在将例程导出为周期性 `TASK.md` 条目，并通过此服务将周期性任务导入回来。 |
| `server/src/services/company-export-readme.ts` | 为导出的公司包生成 `README.md` 和 Mermaid 组织架构图。 |
| `server/src/services/index.ts` | 重新导出 `companyPortabilityService`。 |

## 4. 服务端 — 路由

| 文件 | 端点 |
|---|---|
| `server/src/routes/companies.ts` | `POST /api/companies/:companyId/export` — 旧版导出包<br>`POST /api/companies/:companyId/exports/preview` — 导出预览<br>`POST /api/companies/:companyId/exports` — 导出包<br>`POST /api/companies/import/preview` — 导入预览<br>`POST /api/companies/import` — 执行导入 |

路由注册位于 `server/src/app.ts`，通过 `companyRoutes(db, storage)` 完成。

## 5. 服务端 — 测试

| 文件 | 覆盖范围 |
|---|---|
| `server/src/__tests__/company-portability.test.ts` | 可移植性服务的单元测试（导出、导入、预览、清单结构、`agentcompanies/v1` 版本）。 |
| `server/src/__tests__/company-portability-routes.test.ts` | 可移植性 HTTP 端点的集成测试。 |

## 6. CLI

| 文件 | 命令 |
|---|---|
| `cli/src/commands/client/company.ts` | `company export` — 将公司包导出到磁盘（标志：`--out`、`--include`、`--projects`、`--issues`、`--projectIssues`）。<br>`company import <fromPathOrUrl>` — 从文件或文件夹导入公司包（标志：位置参数源路径/URL 或 GitHub 简写、`--include`、`--target`、`--companyId`、`--newCompanyName`、`--agents`、`--collision`、`--ref`、`--dryRun`）。<br>读写可移植文件条目并处理 `.paperclip.yaml` 过滤。 |

## 7. UI — 页面

| 文件 | 角色 |
|---|---|
| `ui/src/pages/CompanyExport.tsx` | 导出 UI：预览、清单展示、文件树可视化、ZIP 归档创建和下载。根据选择过滤 `.paperclip.yaml`。在编辑器中展示清单和 README。 |
| `ui/src/pages/CompanyImport.tsx` | 导入 UI：来源输入（上传/文件夹/GitHub URL/通用 URL）、ZIP 读取、带依赖树的预览面板、实体选择复选框、信任/许可警告、密钥需求、冲突策略、适配器配置。 |

## 8. UI — 组件

| 文件 | 角色 |
|---|---|
| `ui/src/components/PackageFileTree.tsx` | 可复用的文件树组件，用于导入和导出。从 `CompanyPortabilityFileEntry` 项构建树，解析前置元数据，显示操作指示器（创建/更新/跳过），并映射前置元数据字段标签。 |

## 9. UI — 工具库

| 文件 | 角色 |
|---|---|
| `ui/src/lib/portable-files.ts` | 可移植文件条目的辅助函数：`getPortableFileText`、`getPortableFileDataUrl`、`getPortableFileContentType`、`isPortableImageFile`。 |
| `ui/src/lib/zip.ts` | ZIP 归档创建（`createZipArchive`）和读取（`readZipArchive`）— 为公司包从零实现了 ZIP 格式。包含 CRC32、DOS 日期/时间编码。 |
| `ui/src/lib/zip.test.ts` | ZIP 工具的测试；验证可移植文件条目和 `.paperclip.yaml` 内容的往返一致性。 |

## 10. UI — API 客户端

| 文件 | 函数 |
|---|---|
| `ui/src/api/companies.ts` | `companiesApi.exportBundle`、`companiesApi.exportPreview`、`companiesApi.exportPackage`、`companiesApi.importPreview`、`companiesApi.importBundle` — 可移植性端点的类型化 fetch 封装。 |

## 11. 技能与代理指令

| 文件 | 相关性 |
|---|---|
| `skills/paperclip/references/company-skills.md` | 公司技能库工作流的参考文档 — 安装、检查、更新、分配。技能包是代理公司规范的子集。 |
| `server/src/services/company-skills.ts` | 公司技能管理服务 — 处理基于 SKILL.md 的导入和公司级技能库。 |
| `server/src/services/agent-instructions.ts` | 代理指令服务 — 解析 AGENTS.md 路径以加载代理指令。 |

## 12. 按规范概念快速交叉引用

| 规范概念 | 主要实现文件 |
|---|---|
| `COMPANY.md` 前置元数据与正文 | `company-portability.ts`（导出输出器 + 导入解析器） |
| `AGENTS.md` 前置元数据与正文 | `company-portability.ts`、`agent-instructions.ts` |
| `PROJECT.md` 前置元数据与正文 | `company-portability.ts` |
| `TASK.md` 前置元数据与正文 | `company-portability.ts` |
| `SKILL.md` 包 | `company-portability.ts`、`company-skills.ts` |
| `.paperclip.yaml` 供应商伴随文件 | `company-portability.ts`、`routines.ts`、`CompanyExport.tsx`、`company.ts`（CLI） |
| `manifest.json` | `company-portability.ts`（生成）、共享类型（模式定义） |
| ZIP 包格式 | `zip.ts`（UI）、`company.ts`（CLI 文件读写） |
| 冲突解决 | `company-portability.ts`（服务端）、`CompanyImport.tsx`（UI） |
| 环境变量/密钥声明 | 共享类型（`CompanyPortabilityEnvInput`）、`CompanyImport.tsx`（UI） |
| README + 组织架构图 | `company-export-readme.ts` |
