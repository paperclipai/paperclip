# 存储系统实施方案（V1）

状态：草案
所有者：后端+UI
日期：2026-02-20

## 目标

为 Paperclip 添加单个存储子系统，支持：

- 用于单用户本地部署的本地磁盘存储
- 用于云部署的S3兼容对象存储
- 用于问题图像和未来文件附件的与提供商无关的界面

## V1 范围

- 第一个消费者：发出附件/图像。
- 存储适配器：`local_disk` 和 `s3`。
- 文件始终属于公司范围并受访问控制。
- API 通过经过身份验证的 Paperclip 端点提供附件字节。

## 超出范围（本草案）

- 公共未经身份验证的对象 URL。
- CDN/签名 URL 优化。
- 图像转换/缩略图。
- 恶意软件扫描管道。

## 关键决策

- 默认本地路径位于实例根目录下：`~/.paperclip/instances/<instanceId>/data/storage`。
- 对象字节存在于存储提供者中；元数据存在于 Postgres 中。
- `assets` 是通用元数据表； `issue_attachments` 将资产链接到问题/评论。
- S3 凭证来自运行时环境/默认 AWS 提供商链，而不是数据库行。
- 所有对象键都包含公司前缀以保留硬租赁边界。

## 第 1 阶段：共享配置 + 提供者合约

### 清单（每个文件）

- [ ] `packages/shared/src/constants.ts`：添加`STORAGE_PROVIDERS`和`StorageProvider`类型。
- [ ] `packages/shared/src/config-schema.ts`：添加 `storageConfigSchema`：
  - 提供商：`local_disk | s3`
  - localDisk.baseDir
  - s3.bucket、s3.region、s3.endpoint？、s3.prefix？、s3.forcePathStyle？
- [ ] `packages/shared/src/index.ts`：导出新的存储配置/类型。
- [ ] `cli/src/config/schema.ts`：确保重新导出包括新的存储架构/类型。
- [ ] `cli/src/commands/configure.ts`：添加`storage`部分支持。
- [ ] `cli/src/commands/onboard.ts`：初始化默认存储配置。
- [ ] `cli/src/prompts/storage.ts`：本地磁盘与 s3 设置的新提示流程。
- [ ] `cli/src/prompts/index`（如果存在）或直接导入：连接新存储提示。
- [ ] `server/src/config.ts`：加载存储配置并解析家庭感知本地路径。
- [ ] `server/src/home-paths.ts`：添加`resolveDefaultStorageDir()`。
- [ ] `doc/CLI.md`：文档`configure --section storage`。
- [ ] `doc/DEVELOPING.md`：文档默认本地存储路径和覆盖。

### 验收标准

- `paperclipai onboard` 默认写入有效的 `storage` 配置块。
- `paperclipai configure --section storage` 可以在本地和 s3 模式之间切换。
- 服务器启动读取存储配置，无需仅环境黑客。

## 第 2 阶段：服务器存储子系统 + 提供商

### 清单（每个文件）- [ ] `server/src/storage/types.ts`：定义提供者+服务接口。
- [ ] `server/src/storage/service.ts`：与提供商无关的服务（密钥生成、验证、流 API）。
- [ ] `server/src/storage/local-disk-provider.ts`：实现具有安全路径解析的本地磁盘提供程序。
- [ ] `server/src/storage/s3-provider.ts`：实现 S3 兼容提供程序 (`@aws-sdk/client-s3`)。
- [ ] `server/src/storage/provider-registry.ts`：通过配置的 ID 查找提供商。
- [ ] `server/src/storage/index.ts`：导出存储工厂助手。
- [ ] `server/src/services/index.ts`：出口`storageService`工厂。
- [ ] `server/src/app.ts` 或路由接线点：在需要的地方注入/使用存储服务。
- [ ] `server/package.json`：添加 AWS SDK 依赖项（如果不存在）。

### 验收标准

- 在`local_disk`模式下，上传+读取文件在磁盘上往返字节。
- 在 `s3` 模式下，服务可以针对 S3 兼容端点 `put/get/delete`。
- 无效的提供程序配置会产生明显的启动/配置错误。

## 第 3 阶段：数据库元数据模型

### 清单（每个文件）

- [ ] `packages/db/src/schema/assets.ts`：新的通用资产元数据表。
- [ ] `packages/db/src/schema/issue_attachments.ts`：发行到资产的链接表。
- [ ] `packages/db/src/schema/index.ts`：导出新表。
- [ ] `packages/db/src/migrations/*`：为表和索引生成迁移。
- [ ] `packages/shared/src/types/issue.ts`（或新资产类型文件）：添加 `IssueAttachment` 类型。
- [ ] `packages/shared/src/index.ts`：导出新类型。

### 建议专栏

- `assets`：
  - `id`、`company_id`、`provider`、`object_key`
  - `content_type`、`byte_size`、`sha256`、`original_filename`
  - `created_by_agent_id`、`created_by_user_id`、时间戳
- `issue_attachments`：
  - `id`、`company_id`、`issue_id`、`asset_id`、`issue_comment_id`（可为空）、时间戳

### 验收标准

- 迁移完全适用于空的和现有的本地开发数据库。
- 元数据行是公司范围内的，并为问题查找建立索引。

## 第四阶段：发布附件API

### 清单（每个文件）

- [ ] `packages/shared/src/validators/issue.ts`：添加上传/列出/删除附件操作的模式。
- [ ] `server/src/services/issues.ts`：添加带有公司检查的附件 CRUD 助手。
- [ ] `server/src/routes/issues.ts`：添加端点：
  - `POST /companies/:companyId/issues/:issueId/attachments`（多部分）
  - `GET /issues/:issueId/attachments`
  - `GET /attachments/:attachmentId/content`
  - `DELETE /attachments/:attachmentId`
- [ ] `server/src/routes/authz.ts`：重用/强制公司访问附件端点。
- [ ] `server/src/services/activity-log.ts` 使用调用站点：记录附件添加/删除突变。
- [ ] `server/src/app.ts`：确保上传路由具有分段解析中间件。

### API 行为

- 在 V1 中强制执行最大尺寸和图像/内容类型白名单。
- 返回一致错误：`400/401/403/404/409/422/500`。
- 流字节而不是在内存中缓冲大量有效负载。

### 验收标准

- 董事会和同一公司智能体可以根据问题权限上传和读取附件。
- 即使附件 ID 有效，跨公司访问也会被拒绝。
- 活动日志记录附件添加/删除操作。

## 第 5 阶段：UI 问题附件集成### 清单（每个文件）

- [ ] `ui/src/api/issues.ts`：添加附件API客户端方法。
- [ ] `ui/src/api/client.ts`：支持分段上传助手（`FormData` 没有 JSON `Content-Type`）。
- [ ] `ui/src/lib/queryKeys.ts`：添加问题附件查询键。
- [ ] `ui/src/pages/IssueDetail.tsx`：添加上传UI + 附件列表/查询失效。
- [ ] `ui/src/components/CommentThread.tsx`：可选评论图像附加或显示链接图像。
- [ ] `packages/shared/src/types/index.ts`：确保附件类型在 UI 中被干净地消耗。

### 验收标准

- 用户可以上传问题详细信息中的图像并立即看到它列出。
- 上传的图像可以通过经过身份验证的 API 路由打开/渲染。
- 上传和获取失败对用户可见（无静默错误）。

## 第六阶段：CLI医生+操作强化

### 清单（每个文件）

- [ ] `cli/src/checks/storage-check.ts`：添加存储检查（本地可写目录，可选的S3可达性检查）。
- [ ] `cli/src/checks/index.ts`：导出新存储检查。
- [ ] `cli/src/commands/doctor.ts`：在医生序列中包含存储检查。
- [ ] `doc/DATABASE.md` 或 `doc/DEVELOPING.md`：按部署模式提及存储后端行为。
- [ ] `doc/SPEC-implementation.md`：添加存储子系统和发布附件端点合约。

### 验收标准

- `paperclipai doctor` 报告可操作的存储状态。
- 本地单用户安装无需额外的云凭据即可工作。
- 云配置支持 S3 兼容端点，无需更改代码。

## 测试计划

### 服务器集成测试

- [ ] `server/src/__tests__/issue-attachments.auth.test.ts`：公司边界和权限测试。
- [ ] `server/src/__tests__/issue-attachments.lifecycle.test.ts`：上传/列出/读取/删除流程。
- [ ] `server/src/__tests__/storage-local-provider.test.ts`：本地提供商路径安全和往返。
- [ ] `server/src/__tests__/storage-s3-provider.test.ts`：s3 提供商合约（模拟客户端）。
- [ ] `server/src/__tests__/activity-log.attachments.test.ts`：突变记录断言。

### CLI 测试

- [ ] `cli/src/__tests__/configure-storage.test.ts`：配置部分写入有效的配置。
- [ ] `cli/src/__tests__/doctor-storage-check.test.ts`：存储健康输出和修复行为。

### UI 测试（如果当前堆栈中存在）

- [ ] `ui/src/...`：问题详细上传和错误处理测试。

## 合并前的验证门

运行：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

如果跳过任何命令，请准确记录跳过的内容及其原因。

## 实施令

1. 第一阶段和第二阶段（地基，无用户可见的破损）
2. 第三阶段（DB合同）
3. 第四阶段（API）
4. 第5阶段（UI消费者）
5. 第6阶段（医生/文档强化）