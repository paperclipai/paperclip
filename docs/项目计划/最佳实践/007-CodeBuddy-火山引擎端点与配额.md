# CodeBuddy：火山引擎端点与配额（为何默认 429）

> 无头跑通≠有额度：**不带火山端点、只带腾讯/CodeBuddy 默认身份时**，很容易看到 **429、额度用尽、没钱** 类提示——那是**计费路由**问题，不是回形针适配器坏了。  
> 环境变量总表仍以官方为准：[CodeBuddy env](https://www.codebuddy.ai/docs/cli/env-vars)。

---

## 1. 现象与原因

| 情况 | 常见结果 |
| --- | --- |
| 仅用 **`CODEBUDDY_API_KEY`** + 国内 **`CODEBUDDY_INTERNET_ENVIRONMENT=internal`**（或未配 **`CODEBUDDY_BASE_URL`**） | 请求打到 **CodeBuddy / 腾讯侧**套餐；套餐或免费额度用尽 → **429 / 中文额度文案** |
| 智能体 `model` 选了 **`V-*`（Paperclip 展示为火山）**，但 **CLI 未配置火山网关** | `--model custom-local:xxx` 仍可能回落到**平台托管映射**；若无对应权益，同样 **429** |
| **`M-*` / `D-*` 或部分内置名** | 走各自厂商或 CodeBuddy 内置议价；**与火山 Ark 钱包不是同一个钱袋** |

**结论**：要用 **火山方舟（或其它自购 API）**，必须在 **CodeBuddy 进程环境**里显式 **BASE_URL + 该供应商接受的 Key**，并保证 **`custom-local:<id>` 在 CodeBuddy `models.json`（或等价自定义模型配置）里指向火山**，不能只指望「装了 CodeBuddy 就能用火山」。

---

## 2. 推荐配置面（不要在仓库里提交真密钥）

在 **Paperclip 智能体 JSON → `config.env`**（推荐）或 **`~/.codebuddy/settings.local.json` / 项目 `.codebuddy/settings.local.json` 的 `env`** 中设置：

| 变量 | 作用 |
| --- | --- |
| **`CODEBUDDY_BASE_URL`** | 火山 **OpenAI 兼容**网关根 URL（控制台里给的 API 地址，常见形如 `https://ark.cn-beijing.volces.com/api/v3`，**以控制台为准**） |
| **`CODEBUDDY_API_KEY`** | 火山侧 **API Key**（或文档要求放进 Bearer 的密钥；**勿**与腾讯 CodeBuddy 个人 key 混用） |
| **`CODEBUDDY_INTERNET_ENVIRONMENT`** | 国内网络环境仍可能需要 `internal`；**但若 BASE_URL 已是绝对 HTTPS 指向火山，核心以打通方舟为准**（冲突时以 CodeBuddy 官方说明为准） |

可选（多模型 / 子代理与时，与官方示例一致，便于统一走火山）：

- `CODEBUDDY_SMALL_FAST_MODEL` / `CODEBUDDY_BIG_SLOW_MODEL` / `CODEBUDDY_CODE_SUBAGENT_MODEL`：值为你在 **火山 + `models.json`** 里能解析的 **模型 id（或 ep-id）**。

**Paperclip `codebuddy_local`**：Board 里选 **`V-glm-5.1`** 等时，适配器会传 **`--model custom-local:glm-5.1`**（去掉 `V-` 前缀）。你必须让本机 CodeBuddy **把 `glm-5.1` 这一自定义 id 配到火山端点**，否则仍可能走平台默认路由。

---

## 3. 与三层 `settings.json` 的关系

- **项目级** `.codebuddy/settings.json`：**不要**把真 Key 写进 Git；团队约定用 **`settings.local.json`** 或各操作者本机环境 + Paperclip **per-agent `env`**。  
- 详见：[008-CodeBuddy-配置分层与仓库项目设置.md](008-CodeBuddy-配置分层与仓库项目设置.md)

---

## 4. 自检命令（本机）

```bat
cd <你的材料化工作区或本仓库根>
set CODEBUDDY_BASE_URL=<火山网关>
set CODEBUDDY_API_KEY=<火山 Key>
codebuddy -p "只回复一个字：H" --output-format json -y --model custom-local:glm-5.1 --max-turns 2
```

- 若仍 429：检查 **BASE_URL 末尾路径**、Key 是否 **Ark 控制台启用**、**`models.json` 是否把 `glm-5.1` 指到正确 ep**。  
- 实践样例（不含密钥）：[实践-CodeBuddy无头命令本机验证.md](../探查/008-实践-CodeBuddy无头命令本机验证.md)

---

*2026-05-15*
