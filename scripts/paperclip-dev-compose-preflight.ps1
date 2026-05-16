#requires -Version 5.1
<#
  一条龙前置：校验根 .env 的 DATABASE_URL 是否对齐本仓库 Compose db 映射；若 db 容器已在跑且健康则跳过 `docker compose up`，避免反复起容器。

  用法（仓库根、相对路径）：
    pwsh -NoProfile -File .\scripts\paperclip-dev-compose-preflight.ps1 -RepoRoot (Get-Location)
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,
  [string]$ComposeFileRel = "docker/docker-compose.yml",
  [switch]$SkipDocker,
  [switch]$NoWait,
  [switch]$SkipDatabaseUrlCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$composePath = Join-Path $RepoRoot $ComposeFileRel
if (-not (Test-Path -LiteralPath $composePath)) {
  Write-Host "找不到 Compose 文件: $composePath" -ForegroundColor Red
  exit 1
}

function Read-DotEnvValue {
  param(
    [string]$Path,
    [string]$Key
  )
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $prefix = "$Key="
    if ($t.StartsWith($prefix)) {
      $v = $t.Substring($prefix.Length).Trim()
      if (
        ($v.StartsWith('"') -and $v.EndsWith('"')) -or
        ($v.StartsWith("'") -and $v.EndsWith("'"))
      ) {
        $v = $v.Substring(1, $v.Length - 2)
      }
      return $v
    }
  }
  return $null
}

function Get-ComposePostgresPublishedPort {
  param([string]$ComposePath)
  $raw = Get-Content -LiteralPath $ComposePath -Raw
  $patterns = @(
    'ports:\s*(?:\r?\n\s*-\s*)["''](\d+):5432["'']',
    'ports:\s*(?:\r?\n\s*-\s*)(\d+):5432\b'
  )
  foreach ($pattern in $patterns) {
    if ($raw -match $pattern) { return [int]$Matches[1] }
  }
  return 5432
}

function Parse-DevPostgresUrl {
  param([string]$Url)
  if ($Url -notmatch '^(postgres|postgresql)://') { return $null }
  if ($Url -notmatch '^(?:postgres|postgresql)://([^:]+):([^@]+)@([^/:]+)(?::(\d+))?/([^/?#]+)') {
    return $null
  }
  return [pscustomobject]@{
    User = $Matches[1]
    Password = $Matches[2]
    Host = $Matches[3]
    Port = if ($Matches[4]) { [int]$Matches[4] } else { 5432 }
    Database = $Matches[5]
  }
}

function Normalize-PostgresHost {
  param([string]$HostPart)
  $h = $HostPart.Trim().ToLowerInvariant()
  if ($h -eq 'db') { return 'container-internal-db' }
  return $h
}

if (-not $SkipDocker) {
  if (-not $SkipDatabaseUrlCheck) {
    $envPath = Join-Path $RepoRoot ".env"
    $dbUrl = Read-DotEnvValue -Path $envPath -Key "DATABASE_URL"
    if ([string]::IsNullOrWhiteSpace($dbUrl)) {
      Write-Host ""
      Write-Host "根目录 .env 里没配 DATABASE_URL。一条龙默认连 Compose 里的 Postgres，请先按 .env.example 写好再跑。" -ForegroundColor Red
      Write-Host ""
      exit 1
    }

    $parsed = Parse-DevPostgresUrl -Url $dbUrl
    if (-not $parsed) {
      Write-Host "DATABASE_URL 不是可解析的 postgres 连接串。" -ForegroundColor Red
      exit 1
    }

    $pub = Get-ComposePostgresPublishedPort -ComposePath $composePath
    $normHost = Normalize-PostgresHost -HostPart $parsed.Host
    if ($normHost -eq 'container-internal-db') {
      Write-Host ""
      Write-Host "DATABASE_URL 用了主机名 ``db``，那是给「容器内 server」连库用的。你在本机跑 pnpm dev 时请改成 127.0.0.1 或 localhost，端口用宿主机映射口（本 Compose 映射为 ${pub}）。" -ForegroundColor Red
      Write-Host ""
      exit 1
    }

    $okHost = ($normHost -eq '127.0.0.1' -or $normHost -eq 'localhost' -or $normHost -eq '::1')
    if (-not $okHost) {
      Write-Host ""
      Write-Host "DATABASE_URL 主机是 ``$($parsed.Host)``。一条龙校验只认本机连 Docker：127.0.0.1 / localhost / ::1（当前映射端口 ${pub}）。" -ForegroundColor Red
      Write-Host ""
      exit 1
    }

    if ($parsed.Port -ne $pub) {
      Write-Host ""
      Write-Host "DATABASE_URL 端口是 $($parsed.Port)，与当前 ``$ComposeFileRel`` 里 db 映射的宿主机端口 ${pub} 不一致（常见是把内嵌 54329 或别的库端口写进来了）。请改 .env 或对齐 Compose。" -ForegroundColor Red
      Write-Host ""
      exit 1
    }

    if ($parsed.User -ne 'paperclip' -or $parsed.Database -ne 'paperclip') {
      Write-Host ""
      Write-Host "DATABASE_URL 用户或库名与 docker-compose.yml 默认（paperclip / paperclip）不一致。若你改过 Compose 凭据，请加 -SkipDatabaseUrlCheck 跳过此校验。" -ForegroundColor Red
      Write-Host ""
      exit 1
    }
  }

  Push-Location -LiteralPath $RepoRoot
  try {
    $waitArgs = @()
    if (-not $NoWait) { $waitArgs += "--wait" }

    $dcPsOutput = docker compose -f $ComposeFileRel ps -q db 2>&1
    $dcPsCode = $LASTEXITCODE
    if ($dcPsCode -ne 0) {
      Write-Host ""
      Write-Host "无法查询 Compose db 容器状态（docker compose 退出码 $dcPsCode）。请确认 Docker 已运行。" -ForegroundColor Red
      Write-Host $dcPsOutput
      Write-Host ""
      exit $dcPsCode
    }

    $containerId = ""
    if ($null -ne $dcPsOutput -and "$dcPsOutput".Trim().Length -gt 0) {
      $lines = @($dcPsOutput | ForEach-Object { "$_" })
      $containerId = $lines[0].Trim()
    }

    $skipUp = $false
    if ($containerId) {
      $inspect = (& docker inspect $containerId --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>$null)
      $parts = $inspect -split '\|', 2
      $state = $parts[0]
      $health = if ($parts.Length -gt 1) { $parts[1] } else { 'none' }
      if ($state -eq 'running' -and ($health -eq 'healthy' -or $health -eq 'none')) {
        $skipUp = $true
      }
    }

    if ($skipUp) {
      Write-Host "Compose db 已在运行且健康，跳过 docker compose up。" -ForegroundColor DarkGreen
    }
    else {
      Write-Host ("docker compose -f {0} up -d {1}" -f $ComposeFileRel, ($waitArgs -join " ")) -ForegroundColor DarkGray
      & docker compose -f $ComposeFileRel up -d @waitArgs
      if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "docker compose 失败（退出码 $LASTEXITCODE）。请检查 Docker 是否起来、Compose 是否可用。" -ForegroundColor Red
        Write-Host ""
        exit $LASTEXITCODE
      }
    }
  }
  finally {
    Pop-Location
  }
}

exit 0
