# PLUGIN-GITHUB-SETUP — 给运营者的逐步指南

这份文档是给 **compliance-first-ai-company** 这家虚拟公司的运营者看的。

读完之后，你的 paperclip 实例里的 Merge Director / Build Verifier / Delivery
Lead / engineer 这几个 agent 都能用 typed `github_*` 工具去操作
`djcowork2.0` 仓 —— 不再让 codex agent 写 `gh` shell 命令。

预期耗时：~30 分钟。

> 前提：你已经把 `compliance-first-ai-company` 这个公司包导入 paperclip
> 实例了（如果没有，先看 `README.md` → Getting Started）。
> 同时假设 `djcowork2.0` 仓你有 admin 权限。

---

## 总览

九步：

1. 在 GitHub 上新建一个 **GitHub App**（不是 PAT，不是 OAuth App）
2. 给 App 配 fine-grained permissions
3. 把 App **安装**到 `djcowork2.0` 仓，记下 installation ID
4. 生成并下载 **private key** (PEM)
5. 在 paperclip **secret store** 里存 3 个 secret
6. 在 paperclip UI 装 **plugin**（指向本地 `packages/plugins/plugin-paperclip-github`）
7. 配置 **plugin instance**（5 个字段）
8. **Verification**：用 plugin tool 跑一次 dry-run smoke test
9. 切换公司 **agent 默认工具集**，让相关 agent 看到 6 个 `github_*` typed tools

---

## 1. 在 GitHub 上新建 GitHub App

进入 GitHub → 右上角头像 → **Settings → Developer settings → GitHub Apps →
New GitHub App**。

| 字段 | 填什么 |
|------|--------|
| GitHub App name | `paperclip-compliance-first-bot` |
| Homepage URL | 你的 paperclip 实例 URL，没有就填 `https://example.invalid` |
| Webhook → Active | **取消勾选**（v0.1 不用 webhook） |
| Webhook URL | 留空 |
| Webhook secret | 留空 |
| Where can this GitHub App be installed? | **Only on this account** |

> 名字 GitHub 全局唯一。如果 `paperclip-compliance-first-bot` 已被占用，
> 后面加一个数字后缀（`-2026` 等）即可，不影响功能。

先不要点 Create，下一节继续填 permissions。

---

## 2. 配置 fine-grained permissions

往下滚到 **Repository permissions**，按下表设置：

| Permission | 设置 | 用途 |
|-----------|------|------|
| Contents | Read & write | `github_open_pr` 推分支、改 PR head |
| Pull requests | Read & write | 开 / 读 / 合并 PR |
| Issues | Read & write | `github_list_issues`、把 PR 关联 issue |
| Checks | Read & write | Build Verifier 上传 check run 证据 |
| Metadata | Read（隐式，无法取消） | 列仓元信息 |

**其他所有 Repository permission 保持 No access。**

Organization permissions 和 Account permissions 全部保持 **No access**。

底部 **Subscribe to events**：v0.1 全部不勾选。

点 **Create GitHub App**。

创建成功后你会被带到 App 设置页 —— **把这一页的 App ID 记下来**
（顶部偏上一行，类似 `App ID: 1234567`），后面要存进 secret store。

---

## 3. 把 App 安装到 djcowork2.0

App 设置页左侧 **Install App** → 你的账号/组织 → **Install**。

在 "Repository access" 里选 **Only select repositories** →
勾选 `djcowork2.0` → 点 Install。

安装完成后浏览器 URL 形如：

```
https://github.com/settings/installations/87654321
```

URL 末尾的数字（这里是 `87654321`）就是 **installation ID** —— 也记下来。

或者用 gh CLI 查一下确认：

```bash
gh api /users/<your-login>/installation \
  --jq '.id, .app_slug, .account.login'
```

输出应该是三行：installation id、`paperclip-compliance-first-bot`、你的账号名。

---

## 4. 生成并下载 private key

回到 App 设置页（**Settings → Developer settings → GitHub Apps →
paperclip-compliance-first-bot**）。

往下滚到 **Private keys** → **Generate a private key**。

浏览器会下载一个文件，命名形如：

```
paperclip-compliance-first-bot.2026-05-14.private-key.pem
```

把它移到一个**临时**的安全位置 —— 比如 `~/.secrets/` 或 Windows 的
`%USERPROFILE%\.secrets\`。下一步存进 paperclip 之后，**立刻把这个文件
shred / 删掉**。

检查文件格式合法：

```bash
openssl rsa -in paperclip-compliance-first-bot.2026-05-14.private-key.pem \
  -check -noout
```

应该输出 `RSA key ok`。否则重新生成。

> 这把 key 每个季度轮换一次。轮换流程见本文档底部 *Rotation* 一节。

---

## 5. 在 paperclip secret store 里存 3 个 secret

paperclip UI → **Settings → Secrets** → **New Secret**，建三条：

| Secret name（你自己起） | Type | Value |
|------------------------|------|-------|
| `GITHUB_APP_COMPLIANCE_FIRST_ID` | string | 第 2 步记下的 App ID（纯数字） |
| `GITHUB_APP_COMPLIANCE_FIRST_KEY` | string (multiline) | 第 4 步那个 PEM 文件的**完整内容**，**包括** `-----BEGIN RSA PRIVATE KEY-----` 和 `-----END RSA PRIVATE KEY-----` 这两行 |
| `GITHUB_APP_COMPLIANCE_FIRST_INSTALL` | string | 第 3 步记下的 installation ID |

> Secret name 是你的引用句柄，叫什么都行，下一步配 plugin 时填的是这些
> name；plaintext value 不会出现在 plugin instance config 里。

如果你想用 CLI 而不是 UI（假设 paperclip CLI 装好了）：

```bash
paperclipai secrets put GITHUB_APP_COMPLIANCE_FIRST_ID --value "1234567"
paperclipai secrets put GITHUB_APP_COMPLIANCE_FIRST_KEY --from-file ./paperclip-compliance-first-bot.2026-05-14.private-key.pem
paperclipai secrets put GITHUB_APP_COMPLIANCE_FIRST_INSTALL --value "87654321"
```

**存完之后**：

```bash
# Linux/macOS/WSL2
shred -u paperclip-compliance-first-bot.2026-05-14.private-key.pem
# Windows PowerShell（无 shred，用 SDelete 或至少覆盖删除）
Remove-Item .\paperclip-compliance-first-bot.2026-05-14.private-key.pem -Force
```

---

## 6. 在 paperclip UI 装 plugin

plugin 目前在 paperclip 仓内，未发到 npm，**走本地路径安装**。

paperclip UI → **Settings → Plugins → Install Plugin** → 选 **Local path**：

```
D:\paperclip\packages\plugins\plugin-paperclip-github
```

（如果 paperclip 跑在 WSL2 里，路径换成 Linux 形式 `~/work/paperclip/packages/plugins/plugin-paperclip-github`。）

或者 CLI：

```bash
paperclipai plugins install --local D:\paperclip\packages\plugins\plugin-paperclip-github
```

第一次装会先 build：

```bash
pnpm --filter @paperclipai/plugin-paperclip-github build
```

build 完成之后，UI 的 Plugins 列表里应该出现：

```
GitHub (paperclipai.plugin-paperclip-github)  v0.1.0   Status: not configured
```

---

## 7. 配置 plugin instance

UI 里点上一步那个 plugin → **Add Instance** → **Instance name**：
`djcowork2`（任意，但建议跟仓名对应）。

填 5 个字段：

| 字段 | 输入 |
|------|------|
| `appId` | secret reference → 选 `GITHUB_APP_COMPLIANCE_FIRST_ID` |
| `privateKeyPem` | secret reference → 选 `GITHUB_APP_COMPLIANCE_FIRST_KEY` |
| `installationId` | secret reference → 选 `GITHUB_APP_COMPLIANCE_FIRST_INSTALL` |
| `repo` | plain string → `<your-login>/djcowork2.0` |
| `defaultBranch` | plain string → `main` |

（`mergeQueueEnabled` 留空 = 默认 true。等仓里真的开了 merge queue
ruleset 之后才有意义。）

Save。

---

## 8. Verification —— smoke test

### 8a. 健康面板

UI **Plugins → GitHub → djcowork2 → Health** 应该看到：

```json
{
  "status": "ok",
  "wired_to": "<your-login>/djcowork2.0",
  "appId": "1234567",
  "installation_token_ttl_seconds": 3540,
  "last_call": null
}
```

`status: "ok"` 且 `wired_to` 是你的仓名 = 通了。

CLI 等价：

```bash
paperclipai plugins inspect paperclipai.plugin-paperclip-github/djcowork2
```

### 8b. Dry-run：列 issue

UI **Plugins → GitHub → djcowork2 → Try Tool** → 选 `github_list_issues`：

```json
{ "state": "open", "perPage": 5 }
```

应该回来一个 `{ "issues": [ ... ] }`，最多 5 条。

也可以从 CLI 触发：

```bash
paperclipai plugins invoke \
  paperclipai.plugin-paperclip-github/djcowork2 \
  github_list_issues \
  --input '{"state":"open","perPage":5}'
```

### 8c. Dry-run：开 draft PR + 读 audit log

提前在 `djcowork2.0` 仓里推一个废分支（不会真合并）：

```bash
git -C ~/work/djcowork2.0 checkout -b smoke/plugin-verify
git -C ~/work/djcowork2.0 commit --allow-empty -m "smoke: verify plugin-paperclip-github"
git -C ~/work/djcowork2.0 push -u origin smoke/plugin-verify
```

然后调 `github_open_pr`：

```bash
paperclipai plugins invoke \
  paperclipai.plugin-paperclip-github/djcowork2 \
  github_open_pr \
  --input '{
    "issueId": "1",
    "branch": "smoke/plugin-verify",
    "title": "smoke: verify plugin",
    "body": "Smoke test from PLUGIN-GITHUB-SETUP.md verification step",
    "draft": true
  }'
```

回包应该带一个 `prNumber` 和 `url`。

去 paperclip UI → **Activity Log** 搜 `github_open_pr`，应该看到**一条**
entry，字段包含 `plugin_id`、`tool`、`outcome: "ok"`、`actor` (你触发用
的 agent 或 user)、`pr_number`、`repo`。

最后清理：

```bash
gh pr close <prNumber> --delete-branch
```

如果上面任何一步报错，跳到 **Troubleshooting**。

---

## 9. 让相关 agent 看到 6 个 typed tools

公司 agent 的默认工具集在
`doc/company-packages/compliance-first-ai-company/.paperclip.yaml`。需要给
这 4 类 agent 加 `tools:` 块，列出 plugin 暴露的 6 个 tool：

| Agent | 需要的 tool |
|-------|------------|
| Merge Director (`agents/merge-director/`) | `github_get_pr`, `github_get_check_runs`, `github_enqueue_merge` |
| Build Verifier (`agents/build-verifier/`) | `github_get_check_runs`, `github_create_check_run` |
| Delivery Lead (`agents/delivery-lead/`) | `github_list_issues` |
| Core / Desktop / DJ / Integration engineers (`agents/*-engineer-*/`) | `github_open_pr` |

`.paperclip.yaml` 片段示例（添加到对应 agent 节下）：

```yaml
agents:
  merge-director:
    tools:
      - plugin: paperclipai.plugin-paperclip-github
        instance: djcowork2
        allow:
          - github_get_pr
          - github_get_check_runs
          - github_enqueue_merge
  build-verifier:
    tools:
      - plugin: paperclipai.plugin-paperclip-github
        instance: djcowork2
        allow:
          - github_get_check_runs
          - github_create_check_run
  # … delivery-lead 和各 engineer 同理
```

改完之后重新导入公司包让 cwd / tools 重新下发：

```bash
paperclipai company import ./doc/company-packages/compliance-first-ai-company
```

UI **Agents → Merge Director → Tools** 应该能看到上面 allow 列表里的 tool
名（前面带一个 plugin 图标）。

---

## Troubleshooting

按出现频率从高到低排：

### 1. `401 Unauthorized: Bad credentials` —— 通常是 App ID 或 PEM 不匹配

健康面板里看到 `status: "error", code: "auth_failed"`。

检查：

- App ID 是不是从**对的那个 App** 复制的（不是 OAuth App，也不是 client ID）
- PEM 内容是不是**完整**的 —— 包括首尾的 `-----BEGIN ...-----` 和
  `-----END ...-----` 两行
- PEM 是不是被 paperclip secret store 把换行吃掉了 —— 必须 multi-line
  字段，不是 single-line

修复后必须在 plugin instance 里点 **Reload secrets**（或重启 plugin
worker），不然内存里的旧 token 还在用。

### 2. `404 Not Found: Resource not accessible by integration` —— installation 没装到这个仓 / installation ID 错

最常见：填的是另一个 App 的 installation ID，或者 App 装到了 user account
但 `repo` 字段写的是 org 名。

诊断：

```bash
# 拿到 App 的 JWT 然后列它能看到的所有 installation
# 用 gh + jwtgen，或者直接：
paperclipai plugins invoke \
  paperclipai.plugin-paperclip-github/djcowork2 \
  github_list_issues --input '{"perPage":1}' --debug
```

`--debug` 会把 raw HTTP response 打到 plugin worker log，包括 `X-GitHub-Request-Id`。

修复：去第 3 步 URL 里重新抄一次 installation ID，更新
`GITHUB_APP_COMPLIANCE_FIRST_INSTALL` secret 的值。

### 3. `error:0909006C:PEM routines:get_name:no start line` —— PEM 格式被破坏

通常是把 PEM 复制到 secret store 时用了富文本编辑器，或者换行变成 `\r\n` /
被去掉了。

修复：用 `cat` / `Get-Content -Raw` 读原始 PEM 文件，整段二次粘贴。或者
直接 `--from-file`：

```bash
paperclipai secrets put GITHUB_APP_COMPLIANCE_FIRST_KEY \
  --from-file ./paperclip-compliance-first-bot.YYYY-MM-DD.private-key.pem \
  --overwrite
```

### 4. `permission_denied: missing scope checks:write` —— App permissions 漏了

通常是在第 2 步把 Checks 留成 Read（或 No access）。

修复：回 App 设置页 → Permissions & events → 改 Checks 为 Read & write →
**保存** → GitHub 会要求 installation 方**点一次 accept** 才会下放新权限：
回 `Settings → Applications → paperclip-compliance-first-bot →
Review request` → Accept new permissions。

### 5. `github_enqueue_merge` 一直返回 `merge_queue_disabled`

这是 plugin **在代码里**的 refusal，不是 auth 问题。意思是仓还没开 merge
queue。

修复（在 djcowork2.0 那边做，不在 paperclip 这边）：仓
**Settings → Rules → Rulesets → New ruleset** → 启用 **Require merge
queue**。具体步骤在
`doc/plans/2026-05-14-djcowork2-github-hardening.md` PR 7。

或者临时把 plugin instance 的 `mergeQueueEnabled` 设成 `false` —— 这样
plugin 给的 refusal code 会更明确（运营者层面禁用），方便区分。

---

## Rotation

private key **每 90 天**轮换一次。流程：

1. App 设置页 → Private keys → **Generate a new private key**（旧的不要
   立刻删，先并存）
2. 下载新 PEM
3. 在 paperclip secret store 里把 `GITHUB_APP_COMPLIANCE_FIRST_KEY` 的值
   **覆盖**成新 PEM（同一个 secret name，不要建新的 —— 这样 plugin
   instance config 不用改）
4. plugin worker 自动在下一次 token 续约（最多 60 分钟）时用新 key
5. 用第 8a 节的健康面板确认 `status: "ok"`
6. 回 App 设置页 **删除旧 PEM**
7. 本地的两个 PEM 文件都 shred 掉

也可以热重启 worker：`paperclipai plugins reload
paperclipai.plugin-paperclip-github/djcowork2`。

---

## 验收清单

- [ ] App 创建好，App ID 已记
- [ ] 5 个 fine-grained permission 全部正确
- [ ] App 装到 `djcowork2.0` 仓，installation ID 已记
- [ ] PEM 下载完，`openssl rsa -check` 通过
- [ ] 3 个 secret 进了 paperclip secret store，本地 PEM 已 shred
- [ ] Plugin 装好，instance 配好 5 个字段
- [ ] 健康面板 `status: "ok" + wired_to: <repo>`
- [ ] `github_list_issues` 跑通
- [ ] `github_open_pr` 跑通 + Activity Log 有一条 entry
- [ ] Merge Director / Build Verifier / Delivery Lead / engineers 的
      Tools 面板里都能看到对应 `github_*` tool
- [ ] smoke PR 已关闭、smoke 分支已删

全打勾 = 这家公司从此告别 codex agent 写 `gh` 命令的日子。

---

## 相关文档

- Plugin 自身的 README：`packages/plugins/plugin-paperclip-github/README.md`
- Plugin 设计：`doc/plans/2026-05-14-plugin-paperclip-github-design.md`
- djcowork2.0 仓的硬化路径（CODEOWNERS / merge queue / ruleset / GitHub
  App）：`doc/plans/2026-05-14-djcowork2-github-hardening.md`
- Merge Director / Build Verifier / Delivery Lead 的 AGENTS.md 在
  `agents/<role>/AGENTS.md`
