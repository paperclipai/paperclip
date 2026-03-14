---
title: 寫技能
summary: SKILL.md 格式和最佳實踐
---
技能是智能體可以在心跳期間調用的可重複使用指令。它們是教導智能體如何執行特定任務的降價文件。

## 技能結構

技能是一個包含 `SKILL.md` 檔案的目錄，該檔案帶有 YAML frontmatter：

```
skills/
└── my-skill/
    ├── SKILL.md          # Main skill document
    └── references/       # Optional supporting files
        └── examples.md
```

## SKILL.md 格式

```markdown
---
name: my-skill
description: >
  Short description of what this skill does and when to use it.
  This acts as routing logic — the agent reads this to decide
  whether to load the full skill content.
---

# My Skill

Detailed instructions for the agent...
```

### Frontmatter 字段

- **名稱** — 技能的唯一識別碼（kebab-case）
- **描述** — 告訴智能體何時使用此技能的路由描述。將其寫為決策邏輯，而不是行銷文案。

## 技能在運作時如何發揮作用

1. 智能體在其上下文中查看技能元資料（名稱+描述）
2. Agent決定該技能是否與其目前任務相關
3. 如果相關，智能體程式載入完整的 SKILL.md 內容
4. Agent依照技能中的指示進行操作

這使得基本提示很小——完整的技能內容僅按需加載。

## 最佳實踐

- **將描述寫入路由邏輯** — 包括「何時使用」和「何時不使用」指導
- **具體且可操作** - 座席應該能夠毫不含糊地遵循技能
- **包含程式碼範例** — 具體的 API 呼叫和命令範例比散文更可靠
- **保持技能集中** — 每個問題一項技能；不要合併不相關的程序
- **謹慎參考文件** — 將支援細節放在 `references/` 中，而不是讓主要的 SKILL.md 變得臃腫

## 技能注入

適配器負責使技能可供智能體程式運行時發現。 `claude_local` 轉接器使用帶有符號連結和 `--add-dir` 的臨時目錄。 `codex_local` 轉接器使用全域技能目錄。詳情請參閱【建立適配器】(/zh-Hant/adapters/creating-an-adapter)指南。