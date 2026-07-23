---
title: 环境变量 (Environment Variables)
summary: 完整的系统环境变量配置参考字典
---

这份清单列举了能够被底层的 Paperclip 服务器所识别提取并用于覆盖更改其基础配置运行的所有系统环境变量。

## 服务器基础配置 (Server Configuration)

| 环境变量参数 | 出厂默认值 | 描述说明 |
|----------|---------|-------------|
| `PORT` | `3100` | 主 API 服务器所监听的对外端口 |
| `HOST` | `127.0.0.1` | 服务器尝试监听绑定的接口 (即绑本机 localhost 还是 0.0.0.0 全网卡放行) |
| `DATABASE_URL` | (嵌入式) | 用来手填连外置 PostgreSQL 的那长串连接字符串 |
| `PAPERCLIP_HOME` | `~/.paperclip` | Paperclip 系统存放所有文件和落盘数据的终极底层核心根基目录区 |
| `PAPERCLIP_INSTANCE_ID` | `default` | 专用于这套特定环境实例的标示符身份 ID (主要是图在同一台机器上并排拉起多套互不干涉并行实例时不打架) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | 强制在系统运行时一键临时越权覆写当下的暴露安全策略级别 |

## 数据机密与钥匙环 (Secrets)

| 环境变量参数 | 出厂默认值 | 描述说明 |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (由文件提取) | 就是系统底层用于加密的一把长达 32-byte 字节的大母钥主键 (支持 base64/hex/纯字符 形式输入传入) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | 具体向系统指明去哪里生挖掏这把 master key 的确切文件物理落盘路径 |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | (强加密硬抗模式) 用来一键勒令在向智能体下发那种极其敏感的环境变量配置时，是否直接强制要求剥夺它认取明码并换上加密掩码引用 |

## 智能体运行时内置探针环境 (Agent Runtime)

注意：这几条统统是当底层在后台临时拉升、起动那一个个接单子的智能体工作包进程时，**被母系统强行硬塞通过代码动态注入**进去的独家私货：

| 环境变量参数 | 描述说明 |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | 那个活干正主的独家防伪标号 ID |
| `PAPERCLIP_COMPANY_ID` | 这个工位的名额到底是棣属在哪个名下的公司 ID |
| `PAPERCLIP_API_URL` | Paperclip 向内提供的内部调度专用 API 对内唤醒老巢网址 |
| `PAPERCLIP_API_KEY` | 一套系统用来让这单独一号终端能够勉强短期临时合法通讯向内部上报数据的微薄小权限口令 JWT |
| `PAPERCLIP_RUN_ID` | 当前正脉动跳搏着的这次心跳轮回周期的这唯一一趟序列标号 |
| `PAPERCLIP_TASK_ID` | 是什么样哪一个棘手的工作代号诱发掀被窝把本打工人从床上被强制唤醒强迫干活的起因源头 Issue ID |
| `PAPERCLIP_WAKE_REASON` | 大名鼎鼎的此次强制物理开机的系统性判决裁定的触发法理原由判决理由 (Wake trigger reason) |
| `PAPERCLIP_WAKE_COMMENT_ID` | 若是被谁半夜里疯狂在评论区 @ 圈叫起来的，那这条圈叫来源的证据帖子底号 |
| `PAPERCLIP_APPROVAL_ID` | （如果是因为一纸决议刚被盖章发落）那被处理结案的这张请示决议公文单号 |
| `PAPERCLIP_APPROVAL_STATUS` | 这个请示是准奏了还是被上面无情驳回腰斩了 |
| `PAPERCLIP_LINKED_ISSUE_IDS` | （若是涉及关联决断时）被逗号隔开粘在一起的那一整批倒霉的一并挂钩遭殃 Issue 档案列库清单 |

## LLM 大模型提供商钥匙 (用于投喂适配器)

| 环境变量参数 | 描述说明 |
|----------|-------------|
| `ANTHROPIC_API_KEY` | 专门用来给官方的 Anthropic 跑 Claude Local 号本地包子适配器灌粮的这把 Anthropic 服务大钥匙 |
| `OPENAI_API_KEY` | 给那套 OpenAI 嫡出的老派 Codex Local 本地适配器接力用的老朋友 OpenAI 家的钥匙环 |
