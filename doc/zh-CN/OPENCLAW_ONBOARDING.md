使用这个精确的清单。

1. 以认证模式启动Paperclip。
```bash
cd <paperclip-repo-root>
pnpm dev --tailscale-auth
```
然后验证：
```bash
curl -sS http://127.0.0.1:3100/api/health | jq
```

2. 启动清理/库存 OpenClaw Docker。
```bash
OPENCLAW_RESET_STATE=1 OPENCLAW_BUILD=1 ./scripts/smoke/openclaw-docker-ui.sh
```
在浏览器中打开打印的`Dashboard URL`（包括`#token=...`）。

3. 在Paperclip界面，进入`http://127.0.0.1:3100/CLA/company/settings`。

4. 使用OpenClaw邀请提示流程。
- 在“邀请”部分中，单击“`Generate OpenClaw Invite Prompt`”。
- 从 `OpenClaw Invite Prompt` 复制生成的提示。
- 将其作为一条消息粘贴到 OpenClaw 主聊天中。
- 如果停止，发送一封后续邮件：`How is onboarding going? Continue setup now.`

安全/控制说明：
- OpenClaw 邀请提示是从受控端点创建的：
  - `POST /api/companies/{companyId}/openclaw/invite-prompt`
  - 拥有邀请权限的board用户可以调用
  - 智能体来电者仅限于公司CEO 智能体

5. 在 Paperclip UI 中批准加入请求，然后确认 OpenClaw 智能体出现在 CLA 智能体中。

6. 网关预检（任务测试前需要）。
- 确认创建的智能体使用`openclaw_gateway`（不是`openclaw`）。
- 确认网关URL为`ws://...`或`wss://...`。
- 确认网关令牌非常重要（非空/非 1 字符占位符）。
- OpenClaw 网关适配器 UI 不应公开 `disableDeviceAuth` 进行正常登录。
- 确认配对模式是明确的：
  - 必需的默认值：启用设备身份验证（`adapterConfig.disableDeviceAuth` 错误/不存在）并保留 `adapterConfig.devicePrivateKeyPem`
  - 不要依赖 `disableDeviceAuth` 进行正常入职
- 如果您可以使用板授权运行 API 检查：
```bash
AGENT_ID="<newly-created-agent-id>"
curl -sS -H "Cookie: $PAPERCLIP_COOKIE" "http://127.0.0.1:3100/api/agents/$AGENT_ID" | jq '{adapterType,adapterConfig:{url:.adapterConfig.url,tokenLen:(.adapterConfig.headers["x-openclaw-token"] // .adapterConfig.headers["x-openclaw-auth"] // "" | length),disableDeviceAuth:(.adapterConfig.disableDeviceAuth // false),hasDeviceKey:(.adapterConfig.devicePrivateKeyPem // "" | length > 0)}}'
```
- 预计：`adapterType=openclaw_gateway`、`tokenLen >= 16`、`hasDeviceKey=true` 和 `disableDeviceAuth=false`。

配对握手注意事项：
- 干净运行期望：第一个任务应该成功，无需手动配对命令。
- 适配器尝试一次自动配对批准 + 在第一个 `pairing required` 上重试（当共享网关身份验证令牌/密码有效时）。
- 如果自动配对无法完成（例如令牌不匹配或没有待处理的请求），第一次网关运行可能仍会返回 `pairing required`。
- 这是与 ZX​​QQ00043QQXZ 邀请批准分开的批准。您必须在 OpenClaw 本身中批准待处理的设备。
- 在OpenClaw中批准它，然后重试该任务。
- 对于本地 docker Smoke，您可以从主机处批准：
```bash
docker exec openclaw-docker-openclaw-gateway-1 sh -lc 'openclaw devices approve --latest --json --url "ws://127.0.0.1:18789" --token "$(node -p \"require(process.env.HOME+\\\"/.openclaw/openclaw.json\\\").gateway.auth.token\")"'
```
- 您可以检查待处理设备与已配对设备：
```bash
docker exec openclaw-docker-openclaw-gateway-1 sh -lc 'TOK="$(node -e \"const fs=require(\\\"fs\\\");const c=JSON.parse(fs.readFileSync(\\\"/home/node/.openclaw/openclaw.json\\\",\\\"utf8\\\"));process.stdout.write(c.gateway?.auth?.token||\\\"\\\");\")\"; openclaw devices list --json --url \"ws://127.0.0.1:18789\" --token \"$TOK\"'
```

7. 案例A（手动发布测试）。
- 创建分配给 OpenClaw 智能体的问题。
- 放置说明：“发表评论 `OPENCLAW_CASE_A_OK_<timestamp>` 并标记为完成。”
- 在 UI 中验证：问题状态变为 `done` 并且评论存在。

8. 案例B（消息工具测试）。
- 创建另一个分配给 OpenClaw 的问题。
- 说明：“通过消息工具发送 `OPENCLAW_CASE_B_OK_<timestamp>` 到主网络聊天，然后在问题上评论相同的标记，然后标记为完成。”
- 验证两者：
  - 对问题的标记评论
  - 标记文本出现在 OpenClaw 主聊天中9. 案例 C（新会话记忆/技能测试）。
- 在OpenClaw中，启动`/new`会话。
- 要求它在 Paperclip 中创建一个新的 CLA 问题，其唯一标题为 `OPENCLAW_CASE_C_CREATED_<timestamp>`。
- 在 Paperclip UI 中验证是否存在新问题。

10. 在测试期间观察日志（可选但有帮助）：
```bash
docker compose -f /tmp/openclaw-docker/docker-compose.yml -f /tmp/openclaw-docker/.paperclip-openclaw.override.yml logs -f openclaw-gateway
```

11. 预期通过标准。
- 预检：`openclaw_gateway` + 非占位符令牌 (`tokenLen >= 16`)。
- 配对模式：稳定的 `devicePrivateKeyPem` 配置为启用设备身份验证（默认路径）。
- 案例 A：`done` + 标记注释。
- 案例B：`done` + 标记评论 + 主聊天消息可见。
- 案例 C：原始任务完成并从 `/new` 会话创建新问题。

如果您愿意，我还可以为您提供一个“观察者模式”命令，该命令可以在您在 UI 中实时观看相同步骤时运行库存排烟装置。