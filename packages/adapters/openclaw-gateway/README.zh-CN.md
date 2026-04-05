# OpenClaw 网关适配器

[English](./README.md) | **简体中文** | [繁體中文](./README.zh-TW.md)

本文档介绍了`@paperclipai/adapter-openclaw-gateway`如何通过网关协议调用OpenClaw。

## 传输

该适配器始终使用 WebSocket 网关传输。

- URL必须是`ws://`或`wss://`
- 连接流程遵循网关协议：
1. 接收`connect.challenge`
2. 发送`req connect`（协议/客户端/身份验证/设备负载）
3. 发送`req agent`
4. 通过`req agent.wait`等待完成
5. 将 `event agent` 帧流式传输到 Paperclip 日志/脚本解析中

## 身份验证模式

可以通过以下任一方式提供网关凭据：

- 适配器配置中的 `authToken` / `token`
- `headers.x-openclaw-token`
- `headers.x-openclaw-auth`（旧版）
- `password`（共享密码模式）

当存在令牌并且缺少 `authorization` 标头时，适配器将派生 `Authorization: Bearer <token>`。

## 设备验证

默认情况下，适配器在 `connect` 参数中发送签名的 `device` 有效负载。

- 设置 `disableDeviceAuth=true` 忽略设备签名
- 设置 `devicePrivateKeyPem` 固定稳定的签名密钥
- 如果没有 `devicePrivateKeyPem`，适配器每次运行都会生成一个临时 Ed25519 密钥对
- 当启用 `autoPairOnFirstConnect` 时（默认），适配器通过共享身份验证调用 `device.pair.list` + `device.pair.approve` 来处理一个初始 `pairing required`，然后重试一次。

## 会话策略

该适配器支持与 HTTP OpenClaw 模式相同的会话路由模型：

- `sessionKeyStrategy=issue|fixed|run`
- 当策略为 `fixed` 时，使用 `sessionKey`

解析的会话密钥以 `agent.sessionKey` 形式发送。

## 有效负载映射

智能体请求构建为：

- 必填字段：
  - `message`（唤醒文本加上可选的 `payloadTemplate.message`/`payloadTemplate.text` 前缀）
  - `idempotencyKey` (Paperclip `runId`)
  - `sessionKey`（已解决策略）
- 可选添加：
  - 所有 `payloadTemplate` 字段合并
  - `agentId` 来自配置（如果已设置且尚未在模板中）

## 超时

- `timeoutSec` 控制适配器级请求预算
- `waitTimeoutMs` 控制 `agent.wait.timeoutMs`

如果 `agent.wait` 返回 `timeout`，则适配器返回 `openclaw_gateway_wait_timeout`。

## 日志格式

结构化网关事件日志使用：

- `[openclaw-gateway] ...` 用于生命周期/系统日志
- `[openclaw-gateway:event] run=<id> stream=<stream> data=<json>` 适用于 `event agent` 框架

UI/CLI 解析器使用这些行来呈现记录更新。
