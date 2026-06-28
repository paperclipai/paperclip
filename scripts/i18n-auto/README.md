# i18n-auto — Paperclip 全自动汉化流水线

**创建时间**: 2026-06-27  
**位置**: `/www/wwwroot/paperclip/scripts/i18n-auto/`

---

## 这是什么

一套可复用的 i18n 提取+翻译+部署流水线。AST 自动扫描源码里的硬编码英文，提取到 locale 字典，翻译成中文，替换源码，build 并部署。

**upstream 升级后，rebase 再跑一次就自动补齐新增的英文。**

---

## 文件结构

```
scripts/i18n-auto/
├── extract.mjs           # 主工具：AST 扫描 + 提取 + 替换 + 同步
├── translate-zh-CN.mjs   # 中文翻译脚本（批量翻译）
└── README.md             # 本文档
```

---

## 使用方法

### 基本用法

```bash
# 扫描所有文件（dry-run，只看不改）
node scripts/i18n-auto/extract.mjs --dry-run

# 扫描指定文件
node scripts/i18n-auto/extract.mjs --file=Secrets

# 执行提取（会修改源码 + locale 文件）
node scripts/i18n-auto/extract.mjs --file=Secrets

# 扫描所有文件并执行
node scripts/i18n-auto/extract.mjs
```

### 翻译

```bash
# 翻译新增的 key 到中文
node scripts/i18n-auto/translate-zh-CN.mjs

# 查看某语言还有多少未翻译
node scripts/i18n-auto/extract.mjs --report=ja
```

### 部署

```bash
pnpm --filter @paperclipai/ui build
rm -rf server/ui-dist && cp -r ui/dist server/ui-dist
pm2 restart paperclip
```

---

## 工作原理

1. **AST 扫描**: 用 TypeScript Compiler API 解析每个 .tsx 文件
2. **识别硬编码英文**: JSX 文本、aria-label、title、placeholder、pushToast、return 字符串、对象属性
3. **生成 key**: `{文件名}.{上下文}.{camelCase描述}`，如 `secrets.text.createSecret`
4. **替换源码**: 硬编码字符串 → `t("key")` 调用
5. **同步 locale**: 新 key 自动添加到全部 40 个 locale 文件
6. **翻译**: 批量翻译到目标语言

---

## 其他语言贡献者使用方式

1. Fork 项目
2. 运行 `node scripts/i18n-auto/extract.mjs --report=你的语言代码`
3. 系统导出所有未翻译的 key 到 `_translate-你的语言.json`
4. 翻译这个文件里的 value
5. 运行 `node scripts/i18n-auto/extract.mjs --import=你的语言代码` 导入翻译
6. 提交 PR

---

## 已知限制

1. **多行 JSX 文本**: 跨多行的 JSX 文本可能导致位置偏移（IssueDetail.tsx 触发过此问题）
2. **模板字符串**: `` `Hello ${name}` `` 不会被提取（需要手动处理）
3. **条件表达式**: `cond ? "A" : "B"` 只提取外层字符串字面量
4. **品牌名跳过**: Paperclip、Claude Code、Codex 等品牌名不翻译

---

## 本次运行结果（2026-06-27）

| 指标 | 数值 |
|------|------|
| 提取文件数 | 5 个（Secrets + ImportFromVaultDialog + StageSecretsPanel + IssueProperties + IssuesList）|
| 提取硬编码英文 | 190 个 |
| 中文翻译 | 246 条 |
| Build | ✅ 通过 |
| 部署 | ✅ 已部署到线上 |
