# DashScope 百炼适配器修复总结

## 问题诊断

1. **API Key 读取问题**：适配器只从 `config.env` 或 `authToken` 读取 API Key，不读取容器环境变量
2. **API 端点错误**：使用普通 DashScope 端点，但用户使用百炼 Coding Plan 专属套餐
3. **请求格式错误**：使用旧 DashScope 格式，百炼需要 OpenAI 兼容格式
4. **响应解析错误**：使用旧 DashScope 响应格式，百炼返回 OpenAI 兼容格式

## 修复内容

### 1. 添加环境变量 fallback

**文件**: `src/server/execute.ts`, `dist/server/execute.js`

```typescript
// Fallback to container environment variable if not set in config or authToken
if (!env.DASHSCOPE_API_KEY) {
  env.DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || "";
}
```

### 2. 修改 API 端点

**文件**: `src/server/execute.ts`, `dist/server/execute.js`, `src/index.ts`

```typescript
// 旧端点（错误）
const url = new URL("https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation");

// 新端点（正确）- 百炼 Coding Plan
const url = new URL("https://coding.dashscope.aliyuncs.com/v1/chat/completions");
```

### 3. 修改请求格式

```typescript
// 旧格式（错误）
{
  model,
  input: { messages },
  parameters: { temperature, top_p, max_tokens }
}

// 新格式（正确）- OpenAI 兼容
{
  model,
  messages,
  temperature,
  top_p,
  max_tokens
}
```

### 4. 修改响应解析

```typescript
// 旧解析（错误）
response.output.text
response.usage.input_tokens
response.usage.output_tokens

// 新解析（正确）- OpenAI 兼容
response.choices[0]?.message?.content
response.usage.prompt_tokens
response.usage.completion_tokens
```

## 提交记录

```
b822f2ae fix(dashscope-adapter): use OpenAI-compatible response format for Coding Plan
8e80286d fix(dashscope-adapter): use Coding Plan endpoint for BaiLian
a803a868 fix(dashscope-adapter): use BaiLian compatible mode endpoint
03041685 fix(dashscope-adapter): update API endpoint documentation
86828baf fix(dashscope-adapter): use BaiLian endpoint and OpenAI-compatible format
a972a0c8 fix(dashscope-adapter): fallback to container env for DASHSCOPE_API_KEY
```

## GitHub 仓库

https://github.com/liwenkai2026/paperclip

## 支持的模型（百炼 Coding Plan）

- ✅ qwen3.5-plus
- ✅ qwen3-max-2026-01-23
- ✅ qwen3-coder-next
- ✅ qwen3-coder-plus

## 配置要求

### docker-compose.yml

```yaml
environment:
  - DASHSCOPE_API_KEY=sk-sp-xxxxx  # 百炼 Coding Plan API Key
```

### Agent 配置

```json
{
  "adapter": "dashscope_local",
  "model": "qwen3.5-plus"
}
```

## NAS 部署步骤

由于修改的是 `dist` 目录（编译后的代码），需要确保修改持久化：

### 方案 1：挂载修改后的文件

```bash
# 1. 从容器复制修改后的文件
docker cp paperclip:/app/packages/adapters/dashscope-local/dist/server/execute.js /volume1/docker/paperclip-scripts/execute.js

# 2. 修改 docker-compose.yml 添加挂载
volumes:
  - /volume1/docker/paperclip-scripts/execute.js:/app/packages/adapters/dashscope-local/dist/server/execute.js:ro

# 3. 重启容器
docker compose down && docker compose up -d
```

### 方案 2：每次重启后应用补丁

创建脚本 `/volume1/docker/paperclip-scripts/fix-dashscope.sh`，每次重启后执行。

## 测试命令

```bash
# 测试 API 连接
curl -X POST https://coding.dashscope.aliyuncs.com/v1/chat/completions \
  -H "Authorization: Bearer sk-sp-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5-plus","messages":[{"role":"user","content":"hi"}]}'
```

## 常见问题

### 405 Method Not Allowed
- 原因：使用了错误的端点或请求格式
- 解决：确保使用 `https://coding.dashscope.aliyuncs.com/v1/chat/completions` 和 OpenAI 兼容格式

### InvalidApiKey
- 原因：API Key 错误或无效
- 解决：在百炼控制台确认 API Key 状态

### Model not supported
- 原因：Coding Plan 只支持特定模型
- 解决：使用 `qwen3.5-plus`、`qwen3-coder-plus` 等支持的模型
