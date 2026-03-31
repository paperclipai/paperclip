# Paperclip CN UI 本地化指南

## 1. 目的

这份文档记录 Paperclip CN 中文增强版在当前仓库里的本地化策略，目标是：

- 保持默认中文体验，支持中英双语切换
- 尽量减少与上游 `origin/master` 同步时的冲突
- 避免把品牌替换和本地化做成一次性的大改造
- 让后续新增页面、组件、错误文案都能按同一套规则继续落地

这不是一份“把所有英文都替换掉”的说明，而是一份“如何低冲突持续本地化”的工作手册。

## 2. 总体原则

### 2.1 最小冲突原则

优先把改动集中在这些位置：

- `ui/public/locales/zh-CN/common.json`
- `ui/public/locales/en/common.json`
- 共享组件
- 页面级高频壳层文案
- 前后端共用的 locale helper

避免做这些事情：

- 不要粗暴全仓 `Paperclip -> Paperclip CN`
- 不要批量把所有 inherited 文案一次性改成 `t("xxx")`
- 不要为了中文化去改内部路径、包名、环境变量、数据库字段、API shape
- 不要在每个页面都复制一套相似翻译逻辑

### 2.2 用户可见与技术标识分离

下列内容属于用户可见层，可以本地化或品牌化：

- 页面标题
- 按钮、菜单、对话框、空状态、toast
- README/导入导出生成文案
- 站内帮助和品牌说明
- 服务端直接返回给用户展示的错误信息

下列内容属于技术标识，默认不改：

- GitHub 仓库名 `paperclip-cn`
- 公开 package 的 `package.json.name`
- `@penclipai/*` workspace 包名
- CLI npm package spec `penclip`
- `penclip` CLI 命令
- `PAPERCLIP_*` 环境变量
- 内部 localStorage key
- 内部 API 路径和数据结构
- 文件路径、代码块、日志原文、模型原文、用户自由输入内容

补充规则：

- 命令名归一化不等于命令调用方式归一化
- `paperclipai -> penclip` 属于品牌/命令名边界
- `pnpm penclip`、`penclip`、`npx penclip` 要按受众区分，不要机械全仓替换
- 仓库内开发、维护、脚本和工作树说明，默认保留 `pnpm penclip`
- 面向公开安装用户、运行中实例 operator、CLI 错误恢复、onboarding/snippet/generated text 的命令，优先使用 `penclip` 或 `npx penclip`

### 2.3 渐进迁移优先于一次性重写

新增或修改本地化时，优先顺序如下：

1. 共享壳层和高频组件
2. 当前用户最容易看到的页面
3. 常见错误路径和 toast
4. 深层详情页和低频页面

上游新代码进入后，如果某个新增文案还没有中文 key，可以先让它走英文 fallback，再补翻译。不要为了追求“零英文”而在同步上游时大面积重写。

## 3. 当前实现架构

### 3.1 前端

- 技术栈：`react-i18next` + `i18next` + `i18next-http-backend` + `i18next-browser-languagedetector`
- 默认语言：`zh-CN`
- 英文兜底：`en`
- 资源文件：
  - `ui/public/locales/zh-CN/common.json`
  - `ui/public/locales/en/common.json`
- 根接入点：
  - `ui/src/i18n.ts`
  - `ui/src/main.tsx`

关键约束：

- JSON 语言包是前端可见文案的唯一权威来源
- 不把翻译资源内联在 TypeScript 文件里
- 优先通过共享 key 收口，不要在组件里堆散乱的临时字符串

### 3.2 后端

服务端也承担了一部分用户可见文案的本地化职责：

- UI 请求统一带 `Accept-Language`
- 服务端响应写入 `Content-Language`
- 语言相关响应追加 `Vary: Accept-Language`
- 服务端错误中间件对用户可见错误做翻译
- 前后端尽量共用同一套 locale 内容，避免维护两套文案

原则上：

- 前端负责界面壳层
- 后端负责接口返回的人类可读错误

### 3.3 语言切换

- 默认语言为 `zh-CN`
- 语言切换器放在左下角工具区，样式与主题切换按钮一致
- Onboarding 弹层右上角也有同款语言切换按钮

### 3.4 首屏语言判定顺序

首屏语言不要只靠浏览器端默认值“猜”。
当前推荐的判定顺序是：

1. `?lng=` 这类显式参数
2. 用户已保存的语言选择（`localStorage`）
3. 服务端按请求头 `Accept-Language` 推断，并写入首屏 `html lang`
4. 浏览器 `navigator.language`
5. 最后才回退到 `DEFAULT_UI_LOCALE`

当前实现约定：

- 服务端首屏 HTML 会注入 `lang` 和 `data-ui-locale-source`
- 当前端检测来源是服务端请求时，`htmlTag` 必须先于 `navigator`
- 不支持的检测值不能直接强制归一化成 `zh-CN`
  - 例如 `?lng=fr`、脏的 localStorage 值、未知浏览器语言
  - 这些值应被忽略，让检测继续回退到下一个来源

这样可以避免：

- 英文浏览器首次进入时被错误强切成中文
- 用户手动切换后刷新页面又被浏览器语言抢回去
- 无效 querystring / localStorage 值把整个 UI 带偏

## 4. 品牌替换边界

Paperclip CN 品牌替换必须遵守以下边界：

### 4.1 可以替换

- 用户看到的产品名称：`Paperclip -> Paperclip CN`
- 用户看到的主命令/域名：`paperclipai -> penclip`、`penclip.ing`
- 国际镜像域名：`paperclip.ing -> penclip.ing`
- 中文文档主域名：`paperclipai.cn`

### 4.2 不要替换

- 仓库名 `paperclip-cn`
- package/workspace 名称
- 内部路径
- 技术常量
- 历史兼容 key

如果某处既是技术标识又会被最终用户直接看到，优先用显示层包装，而不是修改底层标识。

对命令类文案也是同样原则：

- 先判断命令的受众是谁，再决定保留 `pnpm penclip` 还是改成 `penclip` / `npx penclip`
- 不要因为这处文案最终会展示给用户，就顺手改掉底层脚本、workspace 命令或内部技术标识

## 5. 术语表

以下词汇应保持统一：

| 英文 | 中文 |
|---|---|
| Agent | 智能体 |
| Issue | 任务 |
| Routine | 例行任务 |
| Run | 运行 |
| Workspace | 工作区 |
| Project | 项目 |
| Goal | 目标 |
| Inbox | 收件箱 |
| Dashboard | 仪表盘 |
| Approvals | 审批 |
| Costs | 成本 |
| Org | 组织 |
| Skills | 技能 |
| Instance | 实例 |
| Heartbeats | 心跳 |

## 6. 不应翻译的内容

以下内容默认保持原样：

- `Paperclip CN`
- `GitHub`
- `OpenClaw`
- `CLI` / `API` / `URL` / `Webhook`
- provider、model、package 名称
- 环境变量名
- issue id、run id、company prefix
- 文件名、路径、命令行参数
- 日志正文、stdout、stderr
- 模型生成正文
- 用户输入名称
- 外部插件名称

特别约定：

- 插件名不翻译；插件描述和平台外围文案可以翻译
- `CEO` 不翻译
- `Onboarding` 作为默认保留名不翻译

## 7. Key 设计规则

### 7.1 优先使用稳定语义 key

适用于这些场景：

- 导航和壳层
- 重复按钮文案
- tabs、筛选器、状态词、优先级词
- 品牌文案
- 导入导出说明
- 后端错误 key

例子：

- `dashboard.noAgents`
- `companyImport.previewFailedTitle`
- `agentConfig.selectModelRequired`

### 7.2 受控使用原文 key

只在这些情况下允许直接用原文当 key：

- 页面内低复用的一次性 leaf 文案
- 上游高频变化，提前抽语义 key 反而更容易冲突
- 作为迁移过渡，而不是长期规范

如果一个文案开始复用、开始插值、开始出现在多个页面里，就应该升级成稳定语义 key。

## 8. 新增代码时的本地化流程

新增页面或组件时，建议按这个顺序做：

1. 先判断文案是否属于用户可见层
2. 如果是，优先复用已有 key
3. 如果没有合适 key，再新增到 `zh-CN/common.json` 和 `en/common.json`
4. 在组件里接入 `useTranslation()`
5. 对日期、时间、金额、词元数、相对时间，统一走 helper，不要手写格式化
6. 对服务端错误，优先走服务端翻译，不要在前端重复硬编码 fallback

## 9. 中文措辞准则

中文不应只是“字面对齐”，而要避免生硬直译。

### 9.1 推荐风格

- 简洁、面向操作
- 优先使用熟悉的中文产品语言
- 尽量减少“机翻味”的长句

### 9.2 例子

较好：

- “你还没有智能体。”
- “最近还没有智能体运行记录。”
- “确认归档公司“{{name}}”吗？归档后它将从侧边栏中隐藏。”

较差：

- “当前不存在任何 Agent。”
- “没有最近的 agent runs。”
- “归档公司以后它会被隐藏于 sidebar。”

### 9.3 常见处理建议

- `Create` 视上下文翻成“创建”或“新建”
- `Open` 视上下文翻成“打开”或“查看”
- `Review` 视上下文翻成“查看”或“审核”
- `Budget` 视上下文翻成“预算”，不要机械翻成“经费控制”

## 10. 金额、词元与格式化

### 10.1 金额

中文界面中的金额显示必须走统一 helper，不能在页面里直接拼接 `$`。

规则：

- 不手写 `$${value}`
- 不直接在组件里硬编码 `USD` / `CNY` 文案
- 任何金额展示和输入，都应经过统一格式化/反格式化逻辑
- 本地化只负责“显示格式”，不负责“业务语义变更”
  - 不要因为中文界面就自动把 USD 静默换算成 CNY
  - 不要在没有明确产品定义时引入固定汇率、自动反算或多币种存储假设

### 10.2 词元

中文下 `token` 统一翻成“词元”。

注意区分：

- 计量单位：`词元`
- 安全令牌、邀请 token 一类的凭证语义：保留“令牌”

### 10.3 时间

不要在页面里直接写死 `en-US` 或裸 `toLocaleString()`。

统一通过 locale-aware helper 处理：

- 日期
- 时间
- 相对时间
- 数字缩写

## 11. 回归检查清单

每轮本地化改动后，至少做下面这些检查：

### 11.1 静态检查

```sh
pnpm -r typecheck
pnpm build
```

如果只是 docs 改动，可以不重复跑。

### 11.2 页面检查

优先用 Playwright 检查高频入口：

- dashboard
- onboarding
- agents
- issues
- costs
- company settings
- instance settings
- plugin manager

重点看这些内容：

- 导航
- 空状态
- 按钮
- toast
- 对话框
- 页面标题
- 表格列头
- tabs 和筛选器

语言相关改动额外必须看：

- 首屏首次进入时，`html lang` 是否符合预期
- `?lng=` 是否能覆盖请求头和浏览器语言
- 语言切换后刷新页面是否保持用户选择
- onboarding / dialog / wizard 里的默认文案是否会跟随语言变化
  - 仅在用户尚未手动编辑默认草稿时，才应该自动同步
- 图表图例、状态词、优先级词是否全部走翻译 helper
  - 不要在组件里写死中文或英文枚举标签

### 11.3 特殊边界

检查时不要把这些误判成漏翻：

- 日志原文
- 模型生成内容
- 用户自定义名称
- 外部插件名称
- 代码块和路径

### 11.4 locale 资源检查

每次修改 `common.json` 之后，至少确认：

- 同一个 key 只定义一次
- `zh-CN` 和 `en` 都同步补齐
- 没有留下因为 `JSON.parse` “后者覆盖前者” 而静默失效的重复 key

如果新增了较大批量 key，建议补或更新自动化检查，而不是只靠肉眼扫 diff。

## 12. 上游同步时的工作方式

本地化相关改动，后续同步上游时要优先保住这些文件的设计思路：

- `ui/src/i18n.ts`
- `ui/src/main.tsx`
- `ui/public/locales/zh-CN/common.json`
- `ui/public/locales/en/common.json`
- 语言切换器和其挂载位置
- 前后端 locale 头处理

但注意：

- 不是简单保留整文件“ours”
- 而是尽量先接收上游结构，再把 Paperclip CN 的本地化接回去

具体合并策略见 `doc/UPSTREAM-MERGE-RUNBOOK.md`。

## 13. 实用建议

- 新功能优先先把英文 fallback 跑通，再补中文
- 优先修共享组件，不要到处复制相似翻译
- 遇到术语拿不准时，先查这份文档的术语表
- 改完以后，至少实际打开一遍对应页面，不要只靠全文搜索
- 避免为少量中文化去重写整个组件，尤其是高 churn 页
- 切语言时优先依赖 i18n rerender，不要轻易通过给根树加 `key` 的方式整棵 remount
  - 否则容易把对话框状态、wizard 步骤、输入草稿一起重置
- 如果默认文案需要在语言切换时自动更新，更新逻辑必须基于“上一版默认值”的快照
  - 不要在异步 `setState` updater 中直接读取随后会被改写的 ref

## 14. 维护原则总结

Paperclip CN 的本地化不是“一次翻译完”的项目，而是一个持续同步上游的演进过程。

正确做法是：

- 保持基础设施稳定
- 把文案集中收口
- 统一术语
- 接受英文 fallback 作为过渡
- 每次只做最有价值、最少冲突的一小步

这样才能在继续吃上游更新的同时，把中文版越做越完整。
