# 实践：项目计划下外链「工具优化」目录（junction）

**目的：** 在个人本机不把 `02-智能体-agents` / `05-技能-skills` / `00-编程工具-AI` 搬进 Paperclip；在 **`docs\项目计划\_externals`** 下联接到 `C:\Users\wuhen\工具优化\…`，便于文件管理器在「项目计划」里就看到入口。

## 做一次

仓库根：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local-externals-junction.ps1
```

脚本与联接名见：**[`_externals/README.md`](./_externals/README.md)**、**[`scripts/setup-local-externals-junction.ps1`](../../scripts/setup-local-externals-junction.ps1)**。

## 约定

- 联接内容与目标目录为**本人独有**；**不入库**（`.gitignore` 屏蔽 `docs/项目计划/_externals/*`，仅放行 **`docs/项目计划/_externals/README.md`**）。
- 勿用语义覆盖仓库根自带的 **`skills/`**；外链技能树挂 `docs\项目计划\_externals\05-技能-skills`。

## 换机或路径变迁

改编译表 `junctions` 内目标路径后再跑脚本；目标目录不存在时会 **跳过该行** 并告警。
