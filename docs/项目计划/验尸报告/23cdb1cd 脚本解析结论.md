# 23cdb1cd · 运行验尸（ROU-4 冒烟 · cursor 无头）

**Run ID：** `23cdb1cd-e339-45fe-9acd-e69207cf9f5e`  
**事务：** ROU-4 · 回复我ok（评论唤醒：用户「回复一下」）  
**智能体：** `e89977f7-bf3b-4152-af0e-c0f06b2a78be`（cursor / cursor-local）  
**CLI：** `agent -p --output-format stream-json --model composer-2.5 --yolo`（`apiKeySource: login`）

**通则：** [`../最佳实践/022`](../最佳实践/022-实践-无头编排提示词叠层与可观测性.md) · 对照 [`2c4a30b3 脚本解析结论`](2c4a30b3%20脚本解析结论.md)（ROU-3 · 乱码 + retry）

---

## 1. 结论（先读）

| 问题 | 结论 |
|------|------|
| 是中文/乱码导致跑不起来吗？ | **否。** run-log 第二条 `user` 中「唤醒负载」「ROU-4」「回复一下」**均正常** |
| 是 Paperclip 任务太难吗？ | **否。** 任务仅为评论 `ok`；手动无头一行英文同样卡在 turn 1 |
| 实际失败形态 | `init` + `user` 后 **~2.5 分钟** 起 **reconnect/retry**（`checkpoint_turn_count` 恒为 1），stderr：`Failed to run step, exceeded max retries` |
| 根因归属 | **`cursor-agent` 无头运行时**（与 IDE 内对话非同一通路）；**非**当前 Routic 适配器编码修修补补能单独解决 |
| 处置 | **归档本 run**；**cursor 无头修复另开**（见 022 §9）；实例上 **CodeBuddy + 另一适配器** 已够研究，**暂不投入 cursor 适配器改造** |

---

## 2. 与 ROU-3（`2c4a30b3`）分工

| 维度 | ROU-3 / `2c4a30b3` | ROU-4 / `23cdb1cd` |
|------|---------------------|---------------------|
| 乱码 | invoke wake 正常；**stream-json user 整段乱**；脏 continuation | **无乱码** |
| 失败 | reconnect + 无 result | 同款 reconnect + `exceeded max retries` |
| 含义 | Windows 编码链 + retry 脏数据 **仍要修**（021） | 证明 **即使 prompt 正常，无头仍可能完全不可用** |

两条验尸 **并列**，不要混成「cursor 只会乱码」或「只会网络问题」。

---

## 3. 手动复现（排除 Paperclip）

在同一 Paperclip 项目 `cwd` 执行：

```powershell
echo "Reply with exactly: ok" | & "$env:LOCALAPPDATA\cursor-agent\agent.CMD" -p --output-format stream-json --model composer-2.5 --yolo
```

观察到：`system init` → `user`（英文正常）→ 随后 **connection/retry**（与 Paperclip run 同型）。  
**agent 版本（当时）：** `2026.05.16-0338208`。

---

## 4. 时间线摘要

| 时刻（UTC） | 事件 |
|-------------|------|
| 13:00:28 | `system init`，`session_id=aa6223b3-…` |
| 13:00:28 | `user`：完整 wake（含多技能摘要，末尾「技能摘要过长已截断」） |
| 13:03–13:06 | reconnect ×3，`checkpoint_turn_count: 1` |
| 13:07:57 | stderr：`Failed to run step, exceeded max retries` |

无 `assistant` / tool / `type:result`；工单侧 **未见** 评论 `ok`。

---

## 5. 修改记录

| 日期 | 说明 |
|------|------|
| 2026-05-19 | 初稿：ROU-4 排除编码；定性 cursor-agent 无头失败；修复暂缓 |

上级：[验尸报告目录](.) · [022 §9 cursor 暂缓](../最佳实践/022-实践-无头编排提示词叠层与可观测性.md#9-cursor-local-无头暂缓另开修复)
