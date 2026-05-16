# 实践：CodeBuddy 无头命令本机验证（Windows）

- **环境**：`codebuddy --version` → **2.97.1**（路径：`%AppData%\Roaming\npm\codebuddy`）  
- **cwd**：仓库根 `paperclip-latest-20260512`  
- **日期**：2026-05-15（会话内以用户侧时钟为准）

---

## 1. 最小无头 JSON（成功）

```bat
set CODEBUDDY_DISABLE_CRON=1
set CODEBUDDY_DISABLE_HOT_RELOAD=1
codebuddy -p "Respond with exactly the word PING and nothing else." --output-format json -y --max-turns 2
```

- **结果**：退出码 0；stdout 为 JSON 数组，末元素 `type: "result"`，`result: "PING"`，`session_id` 存在。  
- **结论**：`-p` + `--output-format json` + `-y` + `--max-turns` **可用**；两环境变量 **未阻止启动**（是否「少后台行为」需长时间对照，本条只证 **不炸**）。

---

## 2. 适配器风格 `--model`（成功）

```bat
codebuddy -p "Reply only: Z" --output-format json -y --model custom-local:mimo-v2.5-pro --max-turns 2
```

- **结果**：退出码 0；`providerData.model` / `result` 正常。  
- **结论**：**`--model custom-local:mimo-v2.5-pro`** 与 Paperclip `codebuddy_local` 去前缀再拼 `custom-local:` 的路径 **一致且可用**。

---

## 3. `--model glm-5.1`（CLI 接受，账号侧失败）

```bat
codebuddy -p "Output exactly ONE ascii digit 7 only." --output-format json -y --model glm-5.1 --max-turns 2
```

- **结果**：退出码 0 但 stdout 为 **429 额度用尽** 中文提示（非 JSON）。  
- **结论**：**参数被接受**；失败来自 **额度/套餐**，不是「参数非法」。**若预期走火山**：须 **`CODEBUDDY_BASE_URL` + 火山 Key** + `models.json` 映射，否则常仍走腾讯/CodeBuddy 默认计费——见 [CodeBuddy-火山引擎端点与配额.md](../最佳实践/007-CodeBuddy-火山引擎端点与配额.md)。

---

## 4. 豆包式虚构 flag（失败）

```bat
codebuddy -p "hi" -y --no-watch
```

- **结果**：退出码 1，`error: unknown option '--no-watch'`。  
- **结论**：**当前版本不存在该开关**；写进 `extraArgs` 会直接 **起不来**。

---

## 5. `codebuddy ps`（成功）

- **结果**：`No active sessions.`  
- **结论**：**单次 `-p` 会话结束后无残留 Worker 登记**（至少在本序列跑完瞬间如此）。

---

## 6. 项目级上下文（观察）

- 成功响应里 **system-reminder 注入了仓库内 `codebuddy.md`**，说明 **cwd 下项目规则被加载**；与 **`.codebuddy/settings.json`** 并存时，仍以官方合并规则为准（本条未做单变量对照）。

---

*验证人：自动化终端；若你方额度/模型策略变更，请重跑 §1–§3 三条。*
