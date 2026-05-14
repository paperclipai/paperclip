请严格遵循此检查清单。

1. 以认证模式（auth mode）启动 Paperclip。
```bash
cd <paperclip-repo-root>
pnpm dev --bind lan
```
然后验证：
```bash
curl -sS http://127.0.0.1:3100/api/health | jq
```

2. 启动一个干净/默认的 OpenClaw Docker 容器。
```bash
OPENCLAW_RESET_STATE=1 OPENCLAW_BUILD=1 ./scripts/smoke/openclaw-docker-ui.sh
```
在浏览器中打开打印出的 `Dashboard URL`（包含 `#token=...`）。

3. 在 Paperclip 界面中，访问 `http://127.0.0.1:3100/CLA/company/settings`。

4. 使用 OpenClaw 邀请提示（invite prompt）流程。
- 在邀请（Invites）部分，点击 `Generate OpenClaw Invite Prompt`。
- 从 `OpenClaw Invite Prompt` 复制生成的提示。
- 将其作为一条消息粘贴到 OpenClaw 主聊天中。
- 如果停滞不前，请发送一条跟进消息：`How is onboarding going? Continue setup now.`

安全/控制说明：
- OpenClaw 邀请提示是从受控端点创建的：
  - `POST /api/companies/{companyId}/openclaw/invite-prompt`
  - 具有邀请权限的董事会用户（board users）可以调用它
  - 代理调用者（agent callers）仅限于公司 CEO 代理

5. 在 Paperclip 界面中批准加入请求，然后确认 OpenClaw 代理出现在 CLA 代理列表中。

6. 网关（gateway）预检（任务测试前必需）。
- 确认创建的代理使用 `openclaw_gateway`（而非 `openclaw`）。
- 确认网关 URL 为 `ws://...` 或 `wss://...`。
- 确认网关令牌（token）非平凡（不为空/不是单字符占位符）。
- OpenClaw 网关适配器（adapter）界面不应在正常引导流程中暴露 `disableDeviceAuth`。
- 确认配对（pairing）模式是明确的：
  - 必需默认值：设备认证（device auth）启用（`adapterConfig.disableDeviceAuth` 为 false 或不存在）且持久化存储 `adapterConfig.devicePrivateKeyPem`
  - 不要依赖 `disableDeviceAuth` 进行正常引导
- 如果你可以使用董事会认证（board auth）运行 API 检查：
```bash
AGENT_ID="<newly-created-agent-id>"
curl -sS -H "Cookie: $PAPERCLIP_COOKIE" "http://127.0.0.1:3100/api/agents/$AGENT_ID" | jq '{adapterType,adapterConfig:{url:.adapterConfig.url,tokenLen:(.adapterConfig.headers["x-openclaw-token"] // .adapterConfig.headers["x-openclaw-auth"] // "" | length),disableDeviceAuth:(.adapterConfig.disableDeviceAuth // false),hasDeviceKey:(.adapterConfig.devicePrivateKeyPem // "" | length > 0)}}'
```
- 预期：`adapterType=openclaw_gateway`，`tokenLen >= 16`，`hasDeviceKey=true`，且 `disableDeviceAuth=false`。

配对握手（pairing handshake）说明：
- 干净运行预期：第一个任务应无需手动配对命令即可成功。
- 适配器会在首次出现 `pairing required` 时尝试一次自动配对批准 + 重试（当共享网关认证令牌/密码有效时）。
- 如果自动配对无法完成（例如令牌不匹配或没有待处理请求），首次网关运行可能仍会返回 `pairing required`。
- 这与 Paperclip 邀请批准是分开的。你必须在 OpenClaw 本身中批准待处理设备。
- 在 OpenClaw 中批准它，然后重试任务。
- 对于本地 docker 冒烟测试，你可以从主机批准：
```bash
docker exec openclaw-docker-openclaw-gateway-1 sh -lc 'openclaw devices approve --latest --json --url "ws://127.0.0.1:18789" --token "$(node -p \"require(process.env.HOME+\\\"/.openclaw/openclaw.json\\\").gateway.auth.token\")"'
```
- 你可以检查待处理与已配对设备：
```bash
docker exec openclaw-docker-openclaw-gateway-1 sh -lc 'TOK="$(node -e \"const fs=require(\\\"fs\\\");const c=JSON.parse(fs.readFileSync(\\\"/home/node/.openclaw/openclaw.json\\\",\\\"utf8\\\"));process.stdout.write(c.gateway?.auth?.token||\\\"\\\");\")\"; openclaw devices list --json --url \"ws://127.0.0.1:18789\" --token \"$TOK\"'
```

7. 案例 A（手动问题测试）。
- 创建一个分配给 OpenClaw 代理的问题。
- 输入说明：“发布评论 `OPENCLAW_CASE_A_OK_<timestamp>` 并标记完成。”
- 在界面中验证：问题状态变为 `done` 且评论存在。

8. 案例 B（消息工具测试）。
- 创建另一个分配给 OpenClaw 的问题。
- 说明：“通过消息工具将 `OPENCLAW_CASE_B_OK_<timestamp>` 发送到主网页聊天（main webchat），然后在问题上评论相同标记，最后标记完成。”
- 验证两者：
  - 问题上的标记评论
  - 标记文本出现在 OpenClaw 主聊天中

9. 案例 C（新会话记忆/技能测试）。
- 在 OpenClaw 中，启动 `/new` 会话。
- 要求它在 Paperclip 中创建一个新 CLA 问题，标题为唯一值 `OPENCLAW_CASE_C_CREATED_<timestamp>`。
- 在 Paperclip 界面中验证新问题存在。

10. 测试期间查看日志（可选但有帮助）：
```bash
docker compose -f /tmp/openclaw-docker/docker-compose.yml -f /tmp/openclaw-docker/.paperclip-openclaw.override.yml logs -f openclaw-gateway
```

11. 预期通过标准。
- 预检：`openclaw_gateway` + 非占位符令牌（`tokenLen >= 16`）。
- 配对模式：稳定的 `devicePrivateKeyPem` 配置，设备认证启用（默认路径）。
- 案例 A：`done` + 标记评论。
- 案例 B：`done` + 标记评论 + 主聊天消息可见。
- 案例 C：原始任务完成且从 `/new` 会话创建了新问题。

如果你需要，我也可以给你一个单一的“观察者模式（observer mode）”命令，该命令运行默认冒烟测试工具，同时你可以在界面中实时查看相同步骤。