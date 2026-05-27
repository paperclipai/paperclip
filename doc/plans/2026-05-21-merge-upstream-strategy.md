# my-local-changes 合并上游 master 策略

> **日期：** 2026-05-21
> **来源分支：** `my-local-changes`（14 个本地 commit）
> **目标上游：** `origin/master`
> **合并分支：** `my-local-20260521`（新建）
> **策略：** 合并非 ui 目录代码，暂存 i18n 改动

---

## 背景

本地分支 `my-local-changes` 对前端做了国际化改造，自 5 月 17 日分叉以来上游 `origin/master` 已推进约 30 个 commit。上游 `ui/src/` 目录有 20+ 文件变更。

**当前策略：** 暂不合并 ui 目录，只合入非前端代码，降低冲突风险。

---

## 方案

**方案 A（推荐）：基于上游新建分支 + cherry-pick 非 ui commit**

1. 基于 `origin/master` 创建新分支 `my-local-20260521`
2. Cherry-pick 本地分支中**不涉及 ui 目录**的 commit
3. 跳过 ui/i18n 相关修改，后续单独处理

**优点：**
- 避免复杂的 ui 目录冲突
- 快速合入后端/配置等修改
- i18n 改动保留在原分支，不丢失

---

## 执行步骤

### 第 0 步：创建 worktree 隔离（推荐）

```bash
# 0.1 创建隔离目录
mkdir -p ../paperclip-merge

# 0.2 使用 worktree 创建新分支
git worktree add ../paperclip-merge -b my-local-20260521

# 0.3 进入 worktree
cd ../paperclip-merge
```

### 第 1 步：准备工作

```bash
# 1.1 确认当前分支（应在 worktree 中）
git branch

# 1.2 确保工作区干净
git status

# 1.3 拉取上游最新代码
git fetch origin master

# 1.4 确认在上游 HEAD
git rev-parse origin/master
```

### 第 2 步：查看本地 commit 列表

```bash
# 2.1 查看本地所有 commit（相对于 master）
git log my-local-changes --oneline --not master

# 2.2 筛选出不含 ui 目录的 commit
git log my-local-changes --not master --pretty=format:"%h %s" | ForEach-Object {
    $hash = ($_ -split ' ')[0]
    $files = git diff $hash^..$hash --name-only
    if ($files -notmatch "^ui/") {
        $_
    }
}
```

### 第 3 步：Cherry-pick 非 ui commit

```bash
# 3.1 逐个 cherry-pick（推荐手动确认）
# 先列出要 cherry-pick 的 commit hash
git log my-local-changes --not master --pretty=format:"%h" | ForEach-Object {
    $commit = $_
    $msg = git log $_ -1 --pretty=format:"%s"
    $files = git diff $_^..$_ --name-only
    $isUiChange = $files -match "^ui/"
    Write-Host "Commit: $commit - $msg"
    Write-Host "  Files: $files"
    Write-Host "  Is UI change: $isUiChange"
    Write-Host "---"
}

# 3.2 手动 cherry-pick 非 ui commit
git cherry-pick <commit-hash-1>
git cherry-pick <commit-hash-2>
# ...
```

### 第 4 步：验证（非 ui 部分）

```bash
# 4.1 类型检查（全部）
pnpm -r typecheck

# 4.2 运行测试
pnpm test:run

# 4.3 构建验证
pnpm build
```

### 第 5 步：完成

```bash
# 5.1 查看合并后历史
git log --oneline --graph -15

# 5.2 切回主开发 worktree
cd ../../paperclip
git worktree remove ../paperclip-merge

# 5.3 my-local-20260521 就是新的工作分支
# my-local-changes 保留作为 i18n 备份
```

---

## 冲突预判

| 目录 | 上游改动 | 本地改动 | 处理原则 |
|------|---------|---------|---------|
| `packages/*` | ✅ | ❌ | 以上游为准 |
| `server/*` | ✅ | ✅ | 需要关注，可能小冲突 |
| `ui/*` | ✅ | ✅ | **暂不处理** |
| `cli/*` | ✅ | ❌ | 以上游为准 |
| `scripts/*` | ✅ | ❌ | 以上游为准 |
| `tests/*` | ✅ | ❌ | 以上游为准 |
| `doc/plans/*` | ✅ | ✅ | 保留双方 |
| `docs/*` | ✅ | ✅ | 保留双方 |
| `Dockerfile` | ✅ | ❌ | 以上游为准 |
| `screenshots/*` | ✅ | ❌ | 以上游为准 |
| `package.json` | ✅ | ✅ | 需要关注，可能冲突 |
| `pnpm-lock.yaml` | ✅ | ✅ | 保留上游 + `pnpm install` |
| `test_scripts/*` | ❌ | ✅ | 保留本地 |
| `.gitignore` | ❌ | ✅ | 保留本地 |
| `CLAUDE.md` | ❌ | ✅ | 保留本地 |
| `.claude/*` | ❌ | ✅ | 保留本地 |

---

## 回退方案

```bash
# 在 worktree 中
git cherry-pick --abort

# 或直接删除 worktree 重来
cd ../../paperclip
git worktree remove ../paperclip-merge --force
git branch -D my-local-20260521
```

---

## 后续计划：处理 i18n

等上游 UI 更稳定后，单独处理 i18n：

```bash
# 后续在 my-local-20260521 上操作
git cherry-pick <i18n-commit-hash>

# 或将 ui 目录的改动作为补丁导出
git diff my-local-changes -- ui/src/ > i18n-patch.diff
# 然后手动应用
```

---

## 合并后注意事项

1. **pnpm-lock.yaml** — 上游若有新依赖，运行 `pnpm install`
2. **i18n 在 my-local-changes 分支** — 不会丢失
3. **ui 目录保持原样** — 等待后续单独合并
4. **运行测试** — 确认非 ui 功能正常
