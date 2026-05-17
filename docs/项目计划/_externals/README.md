# `_externals`（本机联接口）

本目录位于 **`docs/项目计划`** 下，便于在「项目计划」里一眼看到入口。目录下应出现三条 **目录联接（junction）**，指向你本机在 `工具优化` 里的私货：

| 联接名             | 典型目标 |
|--------------------|----------|
| `02-智能体-agents` | …\工具优化\02-智能体-agents |
| `05-技能-skills`   | …\工具优化\05-技能-skills |
| `00-编程工具-AI`   | …\工具优化\00-编程工具-AI |

这些内容 **不入 Git**（见根目录 `.gitignore`）；惟有本 `README.md` 会入库作说明。

**首次或换机后：** 在仓库根执行（路径不对则先改脚本）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local-externals-junction.ps1
```

与 Paperclip 随仓库下发的 `skills/` 不是一回事；不要随便用联接覆盖同名 `skills/`。

旧版若曾在仓库根 `_externals` 建过联接，可只删该联接名（勿 `Remove-Item -Recurse` 远端目录），或直接删掉整个空壳根目录 `_externals` 文件夹后再跑脚本。
