# Kimi Code CLI 适配器实现指南

> 本指南用于帮助 AI Agent 理解 Paperclip 适配器架构，并为 Protocol Bridge 项目提供实现参考。

---

## 1. 任务背景与目标

### 1.1 项目上下文

**Paperclip** 是一个 AI Agent 编排平台（类似 AI 代理公司的控制平面）。它支持多种本地 CLI 适配器：
- Claude Code (`claude_local`)
- Codex CLI (`codex_local`)
- Kimi Code CLI (`kimi_local`) ← **本次新增**

**你的任务**：理解 Paperclip 的适配器设计模式，并可选择性地将其中的 Session 管理、错误处理等机制借鉴到 Protocol Bridge 项目中。

### 1.2 核心文件位置

```
Paperclip 适配器目录：
packages/adapters/
├── claude-local/          ← 最完整的参考实现
├── codex-local/           ← 子命令风格的 CLI
├── kimi-local/            ← 本次新增的适配器
│   ├── src/server/        ← 执行逻辑、解析、测试
│   ├── src/ui/            ← UI 渲染和配置表单
│   └── src/cli/           ← 终端格式化

Protocol Bridge 适配器（用户本地）：
/Users/jameslee/ablemind/able-alilab/packages/protocol_bridge/
└── protocol_bridge/adapters/claude_code/
    └── adapter.py         ← 当前实现（Python）
```

---

## 2. 核心概念：适配器三层架构

Paperclip 适配器采用 **三层分离架构**：

```
┌─────────────────────────────────────────────────────────────┐
│  UI Layer (React + TypeScript)                              │
│  - ConfigFields: 代理配置表单（模型选择、参数设置）           │
│  - parseStdoutLine: 将 CLI 输出转为 TranscriptEntry[]       │
│  - buildAdapterConfig: 表单值 → adapterConfig JSON          │
├─────────────────────────────────────────────────────────────┤
│  Server Layer (Node.js)                                     │
│  - execute(): 核心执行逻辑（spawn CLI 进程）                 │
│  - parse.ts: 解析 CLI 的 stream-json 输出                    │
│  - test.ts: 环境检测（CLI 是否安装、是否登录）               │
│  - sessionCodec: 会话序列化/反序列化                         │
├─────────────────────────────────────────────────────────────┤
│  CLI Layer (Node.js)                                        │
│  - formatStdoutEvent: 终端输出美化（彩色、格式化）           │
└─────────────────────────────────────────────────────────────┘
```

**关键洞察**：三层完全独立，通过 TypeScript 接口契约通信。这种分离允许：
- 同一适配器在不同环境（Web UI / CLI / Server）中复用
- 独立测试和迭代各层

---

## 3. 必须理解的核心机制

### 3.1 Session 管理（最重要）

**问题**：Claude/Kimi 等 CLI 支持会话恢复（`--resume` / `--session`），但如何在多次请求间保持会话 ID？

**Paperclip 解决方案**：

```typescript
// packages/adapters/kimi-local/src/server/index.ts
export const sessionCodec: AdapterSessionCodec = {
  // 从数据库原始数据解析为运行时对象
  deserialize(raw: unknown): Record<string, unknown> | null {
    const obj = parseObject(raw);
    if (!obj) return null;
    const sessionId = asString(obj.sessionId, "");
    if (!sessionId) return null;
    return { sessionId, cwd: asString(obj.cwd, "") };
  },

  // 将运行时对象序列化为数据库存储格式
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null;
    const sessionId = asString(params.sessionId, "");
    if (!sessionId) return null;
    return { sessionId, cwd: asString(params.cwd, "") };
  },

  // UI 显示用（人类可读的会话标识）
  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    return asString(params.sessionId, null);
  },
};
```

**借鉴到 Python（Protocol Bridge）**：

```python
# 建议添加到 protocol_bridge/adapters/claude_code/session.py
from pydantic import BaseModel
from typing import Optional
import json
import os

class ClaudeSession(BaseModel):
    """可序列化的会话状态。"""
    session_id: str
    cwd: str
    model: str
    created_at: str
    
    def save(self, work_dir: str):
        """保存到 .claude/.paperclip_session.json"""
        path = os.path.join(work_dir, ".claude", ".paperclip_session.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(self.model_dump_json())
    
    @classmethod
    def load(cls, work_dir: str) -> Optional["ClaudeSession"]:
        """从文件加载会话。"""
        path = os.path.join(work_dir, ".claude", ".paperclip_session.json")
        if os.path.exists(path):
            with open(path) as f:
                return cls.model_validate_json(f.read())
        return None
```

### 3.2 Unknown Session 自动重试

**问题**：会话可能过期或被清理，直接报错会导致任务失败。

**Paperclip 解决方案**：

```typescript
// packages/adapters/kimi-local/src/server/execute.ts
// 执行流程
const initial = await runAttempt(sessionId ?? null);

// 检测到会话失效时，自动用新会话重试
if (
  sessionId &&
  !initial.proc.timedOut &&
  (initial.proc.exitCode ?? 0) !== 0 &&
  isKimiUnknownSessionError(initial.parsedStream.resultJson)  // ← 关键检测
) {
  await onLog("stdout", "Session unavailable; retrying with fresh session...\n");
  const retry = await runAttempt(null);  // null = 新会话
  return toAdapterResult(retry, { clearSessionOnMissingSession: true });
}
```

**错误检测模式**（从解析器中提取）：

```typescript
// packages/adapters/kimi-local/src/server/parse.ts
export function isKimiUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractKimiErrorMessages(parsed)]
    .map((m) => m.toLowerCase())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /session\s+not\s+found|unknown\s+session|invalid\s+session|会话.*不存在/.test(msg),
  );
}
```

### 3.3 CLI 输出解析（Stream JSON）

**Claude 的 stream-json 格式**：

```json
{"type":"system","subtype":"init","session_id":"sess_abc","model":"claude-opus-4"}
{"type":"assistant","session_id":"sess_abc","message":{"content":[{"type":"text","text":"Hello"}]}}
{"type":"result","session_id":"sess_abc","usage":{"input_tokens":100,"output_tokens":50},"total_cost_usd":0.001}
```

**解析策略**（参考 `kimi-local/src/server/parse.ts`）：

```typescript
export function parseKimiStreamJson(stdout: string): KimiStreamResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  const assistantTexts: string[] = [];
  
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    
    const event = parseJson(line);
    if (!event) continue;
    
    const role = asString(event.role, "");
    
    if (role === "assistant") {
      const content = Array.isArray(event.content) ? event.content : [];
      for (const block of content) {
        const blockType = asString(block.type, "");
        if (blockType === "text") {
          assistantTexts.push(asString(block.text, ""));
        } else if (blockType === "think") {
          // Thinking 模式内容
          assistantTexts.push(`[Thinking] ${asString(block.think, "")}`);
        } else if (blockType === "tool_use") {
          // 工具调用
          toolCalls.push({ name: asString(block.name, ""), input: block.input });
        }
      }
    }
  }
  
  return { sessionId, model, summary: assistantTexts.join("\n\n"), /* ... */ };
}
```

---

## 4. 对比：Paperclip vs Protocol Bridge

| 维度 | Paperclip | Protocol Bridge | 借鉴建议 |
|------|-----------|-----------------|----------|
| **输出目标** | 数据库存储 → Web UI 展示 | SSE 流 → AI SDK v6 前端 | 保持 SSE，但添加 Session 持久化 |
| **会话管理** | ✅ sessionCodec + DB 持久化 | ❌ 无状态（每次新建） | 🔴 添加 Session 文件存储 |
| **错误处理** | ✅ Unknown Session 自动重试 | ⚠️ 基础错误处理 | 🟡 添加特定错误检测 |
| **工具调用** | ✅ 完整 ToolCall/ToolResult | ✅ 已有基础实现 | 🟢 对齐即可 |
| **Cost 追踪** | ✅ 从 result 提取 | ⚠️ 解析但未使用 | 🟡 可考虑添加 |

---

## 5. 实施建议

### 5.1 为 Protocol Bridge 添加 Session 支持（推荐）

步骤：
1. 创建 `protocol_bridge/adapters/claude_code/session.py`
2. 在 `ClaudeCodeAdapter.__init__` 中添加 `resume_session: bool = True`
3. 在 `stream()` 方法开始时加载会话
4. 解析到 `system.init` 事件时保存新 session_id
5. 在命令构建时添加 `--resume` 参数
6. 添加 `_is_unknown_session_error()` 检测
7. 在异常处理中添加自动重试逻辑

### 5.2 参考代码片段

**检测 Unknown Session**：

```python
import re

CLAUDE_UNKNOWN_SESSION_PATTERNS = [
    r"no conversation found with session id",
    r"unknown session",
    r"session .* not found",
    r"conversation .* not found",
]

def is_unknown_session_error(stderr: str) -> bool:
    """Detect if error is due to invalid/resumed session."""
    text = stderr.lower()
    return any(re.search(p, text) for p in CLAUDE_UNKNOWN_SESSION_PATTERNS)
```

**自动重试装饰器**：

```python
async def stream_with_retry(self, **kwargs):
    """Stream with automatic session retry."""
    try:
        async for evt in self._stream_impl(**kwargs):
            yield evt
    except Exception as e:
        if self._session and is_unknown_session_error(str(e)):
            logger.warning("Session %s invalid, retrying fresh", self._session.session_id)
            self._session = None
            # 重试（不带 --resume）
            async for evt in self._stream_impl(**kwargs, force_fresh_session=True):
                yield evt
        else:
            raise
```

---

## 6. 前端消费建议

### 6.1 AI SDK v6 兼容展示

用户的 Protocol Bridge 已经输出 AI SDK v6 格式的 SSE，前端可以直接使用 Vercel AI SDK：

```tsx
import { useChat } from 'ai/react';

function Chat() {
  const { messages } = useChat({ api: '/api/claude-stream' });
  
  return messages.map(m => (
    <div key={m.id}>
      {m.toolInvocations?.map(tool => (
        <ToolCallCard 
          key={tool.toolCallId}
          name={tool.toolName}
          state={tool.state} // 'call' | 'result'
          args={tool.args}
          result={tool.result}
        />
      ))}
    </div>
  ));
}
```

### 6.2 状态展示（data-status）

用户的 `DataChannelEvent` 可以展示实时状态：

```tsx
// 消费 data-status 事件
function AgentStatus({ eventSource }) {
  const [status, setStatus] = useState(null);
  
  useEffect(() => {
    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'data-status') {
        setStatus(data.data);
      }
    };
  }, []);
  
  if (status?.action === 'tool_start') {
    return <Spinner>正在使用 {status.toolName}...</Spinner>;
  }
  
  if (status?.action === 'thinking') {
    return <div>{status.message}</div>; // 显示 cost 等信息
  }
}
```

---

## 7. 关键文件速查

| 文件 | 用途 | 核心内容 |
|------|------|----------|
| `kimi-local/src/server/execute.ts` | 执行逻辑 | `execute()`, `buildKimiArgs()`, 会话恢复 |
| `kimi-local/src/server/parse.ts` | 输出解析 | `parseKimiStreamJson()`, 错误检测函数 |
| `kimi-local/src/server/index.ts` | Server 导出 | `sessionCodec` 定义 |
| `kimi-local/src/ui/parse-stdout.ts` | UI 解析 | `TranscriptEntry` 转换 |
| `claude-local/src/server/execute.ts` | 完整参考 | Prompt Bundle, Skills 注入 |
| `claude-local/src/server/parse.ts` | Claude 解析 | 更复杂的流解析逻辑 |

---

## 8. 总结

**Paperclip 适配器核心设计原则**：
1. **分层解耦** - UI/Server/CLI 三层独立
2. **Session 持久化** - 通过 codec 抽象，支持跨请求恢复
3. **容错设计** - Unknown Session 自动检测和重试
4. **协议转换** - 将 CLI 的 stream-json 转为内部 TranscriptEntry

**建议优先级**：
1. 🔴 **高**：为 Protocol Bridge 添加 Session 持久化（用户体验提升最大）
2. 🟡 **中**：Unknown Session 自动重试（可靠性提升）
3. 🟢 **低**：Cost 追踪、Skills 注入（可选增强）

---

*Generated for: Paperclip ↔ Protocol Bridge 适配器对比分析*
*Date: 2026-04-18*
