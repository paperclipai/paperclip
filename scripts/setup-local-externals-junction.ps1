#Requires -Version 5.1
<#
  在本机创建 docs/项目计划/_externals 下的 NTFS 目录联接（junction），指向「工具优化」侧目录。

  用法（仓库根）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local-externals-junction.ps1

  若路径不符，请先改下方 $junctions。
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$externRoot = Join-Path $repoRoot "docs\项目计划\_externals"

$junctions = [ordered]@{
  "02-智能体-agents" = "C:\Users\wuhen\工具优化\02-智能体-agents"
  "05-技能-skills"   = "C:\Users\wuhen\工具优化\05-技能-skills"
  "00-编程工具-AI"   = "C:\Users\wuhen\工具优化\00-编程工具-AI"
}

New-Item -ItemType Directory -Force -Path $externRoot | Out-Null

foreach ($entry in $junctions.GetEnumerator()) {
  $name = [string]$entry.Key
  $target = [string]$entry.Value
  $link = Join-Path $externRoot $name

  if (-not (Test-Path -LiteralPath $target)) {
    Write-Warning "跳过 $($name)：目标不存在 → $target"
    continue
  }

  if (Test-Path -LiteralPath $link) {
    $rp = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", ('rmdir "{0}"' -f $link)) -Wait -PassThru -NoNewWindow
    if ($rp.ExitCode -ne 0) {
      throw "无法删除「$link」。请确认它只是联接或非空前先手动处理。"
    }
  }

  $mp = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", ('mklink /J "{0}" "{1}"' -f $link, $target)) -Wait -PassThru -NoNewWindow
  if ($mp.ExitCode -ne 0) {
    throw "mklink 失败: $name （exit $($mp.ExitCode)）"
  }
}

Write-Host "完成。联接根目录：" $externRoot
