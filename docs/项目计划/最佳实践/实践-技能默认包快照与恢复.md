# 技能默认包快照与恢复（后悔药）

仓库根目录 **`skills/`** 下是一套可随 Paperclip CLI/心搏同步到各适配器技能目录的**默认技能树**（约 8 个顶层技能包及子引用）。在大幅改写或删除技能前，用 Git **孤立提交**整包快照，需要时可**只恢复 `skills/`**，不必回滚整库。

## 快照在哪里（真值）

> **当前仓库默认技能正文为中文**（由 `C:\Users\wuhen\工具优化\05-技能-skills` 迁入、路径仍为 `skills/<英文名>/`）。下列 **v1** 快照为**迁入前**的英文基线，仅供对比或刻意回滚时参考。

| 用途 | 值 |
| --- | --- |
| **分支** | `skills-baseline-8pack`（仅此分支历史：单提交根、与 `master` 无共同祖先） |
| **标签** | `skills-baseline-8pack-v1` |
| **提交** | `7a9b650`（若日后重做快照，以 `git show skills-baseline-8pack-v1` 当前指向为准） |

查看标签指向：

```sh
git show skills-baseline-8pack-v1 --no-patch --format=%H
```

## 恢复到当前工作区

在仓库根目录执行（会**覆盖**现有 `skills/` 下与快照同路径的文件）：

```sh
git fetch origin skills-baseline-8pack skills-baseline-8pack-v1 2>nul || true
git checkout skills-baseline-8pack-v1 -- skills/
```

或按分支名（与标签通常同一提交）：

```sh
git checkout skills-baseline-8pack -- skills/
```

然后按需：

```sh
git add skills
git status skills
git commit -m "chore(skills): restore from skills-baseline-8pack-v1"
```

## 推到远端（换机、防丢）

```sh
git push origin skills-baseline-8pack
git push origin skills-baseline-8pack-v1
```

## 注意

- 快照**只含** `skills/`：**不包含** 你已装到 `~/.cursor/skills` 等全局目录的链接；全局是否重链由适配器/Paperclip 下次同步决定。
- **不要**为了「把快照并进主线」盲目 `merge --allow-unrelated-histories`，除非明确要做历史嫁接；日常只需 **`checkout … -- skills/`**。
- 若重做一轮快照：可再建孤儿分支与 **v2** 标签，并**回写本节表格**中的分支/标签/提交行。

## 何时更新本文

- 默认技能包有重大增减（不仅改文案）且重新打了基线时；
- 标签名或分支策略变更时。
