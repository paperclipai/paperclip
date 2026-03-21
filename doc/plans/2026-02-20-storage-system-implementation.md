# 存储系统实现计划（V1）

状态：草稿
负责人：后端 + UI
日期：2026-02-20

## 目标

为 Paperclip 添加统一的存储子系统，支持：

- 用于单用户本地部署的本地磁盘存储
- 用于云部署的 S3 兼容对象存储
- 用于任务图片和未来文件附件的提供商无关接口

## V1 范围

- 首个消费者：任务附件/图片。
- 存储适配器：`local_disk` 和 `s3`。
- 文件始终以公司为范围并进行访问控制。
- API 通过认证的 Paperclip 端点提供附件字节。

## 范围外（本草稿）

- 公共未认证对象 URL。
- CDN/签名 URL 优化。
- 图像转换/缩略图。
- 恶意软件扫描管道。

## 关键决策

- 默认本地路径在实例根目录下：`~/.paperclip/instances/<instanceId>/data/storage`。
- 对象字节存在于存储提供商中；元数据存在于 Postgres 中。
- `assets` 是通用元数据表；`issue_attachments` 将资产链接到任务/评论。
- S3 凭据来自运行时环境/默认 AWS 提供商链，而不是数据库行。
- 所有对象键包含公司前缀以保持硬租户边界。

## 阶段 1：共享配置 + 提供商合约

### 检查清单（按文件）

- [ ] `packages/shared/src/constants.ts`：添加 `STORAGE_PROVIDERS` 和 `StorageProvider` 类型。
- [ ] `packages/shared/src/config-schema.ts`：添加 `storageConfigSchema`，包含：
  - provider: `local_disk | s3`
  - localDisk.baseDir
  - s3.bucket、s3.region、s3.endpoint?、s3.prefix?、s3.forcePathStyle?
- [ ] `packages/shared/src/index.ts`：导出新的存储配置/类型。
- [ ] `cli/src/config/schema.ts`：确保重新导出包含新的存储模式/类型。
- [ ] `cli/src/commands/configure.ts`：添加 `storage` 部分支持。
- [ ] `cli/src/commands/onboard.ts`：初始化默认存储配置。
- [ ] `cli/src/prompts/storage.ts`：新的本地磁盘 vs S3 设置提示流程。
- [ ] `cli/src/prompts/index`（如果存在）或直接导入：连线新存储提示。
- [ ] `server/src/config.ts`：加载存储配置并解析主目录感知的本地路径。
- [ ] `server/src/home-paths.ts`：添加 `resolveDefaultStorageDir()`。
- [ ] `doc/CLI.md`：记录 `configure --section storage`。
- [ ] `doc/DEVELOPING.md`：记录默认本地存储路径和覆盖。

### 验收标准

- `paperclipai onboard` 默认写入有效的 `storage` 配置块。
- `paperclipai configure --section storage` 可以在本地和 S3 模式之间切换。
- 服务器启动读取存储配置，无需仅环境变量的黑客手段。

## 阶段 2：服务器存储子系统 + 提供商

### 检查清单（按文件）

- [ ] `server/src/storage/types.ts`：定义提供商 + 服务接口。
- [ ] `server/src/storage/service.ts`：提供商无关服务（键生成、验证、流 API）。
- [ ] `server/src/storage/local-disk-provider.ts`：实现带安全路径解析的本地磁盘提供商。
- [ ] `server/src/storage/s3-provider.ts`：实现 S3 兼容提供商（`@aws-sdk/client-s3`）。
- [ ] `server/src/storage/provider-registry.ts`：按配置 ID 查找提供商。
- [ ] `server/src/storage/index.ts`：导出存储工厂助手。
- [ ] `server/src/services/index.ts`：导出 `storageService` 工厂。
- [ ] `server/src/app.ts` 或路由连线点：在需要的地方注入/使用存储服务。
- [ ] `server/package.json`：如果不存在则添加 AWS SDK 依赖。

### 验收标准

- 在 `local_disk` 模式下，上传 + 读取文件在磁盘上往返字节。
- 在 `s3` 模式下，服务可以对 S3 兼容端点执行 `put/get/delete`。
- 无效的提供商配置产生清晰的启动/配置错误。

## 阶段 3：数据库元数据模型

### 检查清单（按文件）

- [ ] `packages/db/src/schema/assets.ts`：新的通用资产元数据表。
- [ ] `packages/db/src/schema/issue_attachments.ts`：任务到资产的链接表。
- [ ] `packages/db/src/schema/index.ts`：导出新表。
- [ ] `packages/db/src/migrations/*`：为两个表和索引生成迁移。
- [ ] `packages/shared/src/types/issue.ts`（或新的资产类型文件）：添加 `IssueAttachment` 类型。
- [ ] `packages/shared/src/index.ts`：导出新类型。

### 建议列

- `assets`：
  - `id`、`company_id`、`provider`、`object_key`
  - `content_type`、`byte_size`、`sha256`、`original_filename`
  - `created_by_agent_id`、`created_by_user_id`、时间戳
- `issue_attachments`：
  - `id`、`company_id`、`issue_id`、`asset_id`、`issue_comment_id`（可空）、时间戳

### 验收标准

- 迁移在空的和现有的本地开发数据库上干净应用。
- 元数据行以公司为范围并为任务查找建立索引。

## 阶段 4：任务附件 API

### 检查清单（按文件）

- [ ] `packages/shared/src/validators/issue.ts`：为上传/列表/删除附件操作添加模式。
- [ ] `server/src/services/issues.ts`：添加带公司检查的附件 CRUD 助手。
- [ ] `server/src/routes/issues.ts`：添加端点：
  - `POST /companies/:companyId/issues/:issueId/attachments`（多部分）
  - `GET /issues/:issueId/attachments`
  - `GET /attachments/:attachmentId/content`
  - `DELETE /attachments/:attachmentId`
- [ ] `server/src/routes/authz.ts`：重用/强制附件端点的公司访问。
- [ ] `server/src/services/activity-log.ts` 使用调用点：记录附件添加/移除变更。
- [ ] `server/src/app.ts`：确保上传路由的多部分解析中间件就位。

### API 行为

- V1 中强制最大大小和图片/内容类型白名单。
- 返回一致的错误：`400/401/403/404/409/422/500`。
- 流式传输字节而不是在内存中缓冲大负载。

### 验收标准

- 董事会和同公司智能体可以按任务权限上传和读取附件。
- 即使拥有有效的附件 ID，跨公司访问也被拒绝。
- 活动日志记录附件添加/移除操作。

## 阶段 5：UI 任务附件集成

### 检查清单（按文件）

- [ ] `ui/src/api/issues.ts`：添加附件 API 客户端方法。
- [ ] `ui/src/api/client.ts`：支持多部分上传助手（`FormData` 不使用 JSON `Content-Type`）。
- [ ] `ui/src/lib/queryKeys.ts`：添加任务附件查询键。
- [ ] `ui/src/pages/IssueDetail.tsx`：添加上传 UI + 附件列表/查询失效。
- [ ] `ui/src/components/CommentThread.tsx`：可选的评论图片附加或显示链接图片。
- [ ] `packages/shared/src/types/index.ts`：确保附件类型在 UI 中被干净消费。

### 验收标准

- 用户可以从任务详情上传图片并立即看到它列出。
- 上传的图片可以通过认证 API 路由打开/渲染。
- 上传和获取失败对用户可见（无静默错误）。

## 阶段 6：CLI Doctor + 运维加固

### 检查清单（按文件）

- [ ] `cli/src/checks/storage-check.ts`：添加存储检查（本地可写目录、可选 S3 可达性检查）。
- [ ] `cli/src/checks/index.ts`：导出新存储检查。
- [ ] `cli/src/commands/doctor.ts`：在 doctor 序列中包含存储检查。
- [ ] `doc/DATABASE.md` 或 `doc/DEVELOPING.md`：按部署模式提及存储后端行为。
- [ ] `doc/SPEC-implementation.md`：添加存储子系统和任务附件端点合约。

### 验收标准

- `paperclipai doctor` 报告可操作的存储状态。
- 本地单用户安装无需额外云凭据即可工作。
- 云配置支持 S3 兼容端点而无需代码更改。

## 测试计划

### 服务器集成测试

- [ ] `server/src/__tests__/issue-attachments.auth.test.ts`：公司边界和权限测试。
- [ ] `server/src/__tests__/issue-attachments.lifecycle.test.ts`：上传/列表/读取/删除流程。
- [ ] `server/src/__tests__/storage-local-provider.test.ts`：本地提供商路径安全和往返。
- [ ] `server/src/__tests__/storage-s3-provider.test.ts`：S3 提供商合约（模拟客户端）。
- [ ] `server/src/__tests__/activity-log.attachments.test.ts`：变更日志断言。

### CLI 测试

- [ ] `cli/src/__tests__/configure-storage.test.ts`：配置部分写入有效配置。
- [ ] `cli/src/__tests__/doctor-storage-check.test.ts`：存储健康输出和修复行为。

### UI 测试（如果当前技术栈中存在）

- [ ] `ui/src/...`：任务详情上传和错误处理测试。

## 合并前验证门控

运行：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

如果跳过任何命令，准确记录跳过了什么以及原因。

## 实现顺序

1. 阶段 1 和阶段 2（基础，无用户可见的破坏）
2. 阶段 3（数据库合约）
3. 阶段 4（API）
4. 阶段 5（UI 消费者）
5. 阶段 6（doctor/文档加固）
