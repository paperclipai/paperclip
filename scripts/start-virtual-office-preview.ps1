param(
  [switch]$Restart,
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = Split-Path -Parent $RepoRoot
$PnpmPath = Join-Path $WorkspaceRoot ".tools\pnpm.cmd"
$ConfigPath = Join-Path $RepoRoot ".paperclip-dev-config.json"
$StatusReportPath = Join-Path $RepoRoot ".virtual-office-preview-status.json"
$BackendHealthUrl = "http://127.0.0.1:3100/api/health"
$OfficeUrl = "http://localhost:5173/AI/office"

if (Test-Path $PnpmPath) {
  $env:PATH = "$(Split-Path -Parent $PnpmPath);$env:PATH"
}

$env:HEARTBEAT_SCHEDULER_ENABLED = "false"
$env:PAPERCLIP_CONFIG = $ConfigPath

function Test-FrontendOk {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 10
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Test-BackendOk {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 10
    $body = $response.Content | ConvertFrom-Json
    return [int]$response.StatusCode -eq 200 -and $body.status -eq "ok"
  } catch {
    return $false
  }
}

function Wait-BackendOk {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-BackendOk -Url $Url) {
      return $true
    }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Wait-FrontendOk {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-FrontendOk -Url $Url) {
      return $true
    }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Get-StuckBackendProcesses {
  $patterns = @(
    "*scripts/dev-runner.ts*dev*",
    "*paperclip*scripts*dev-runner.ts*dev*",
    "*src/index.ts*",
    "*@paperclipai/server*exec*tsx*src/index.ts*",
    "*src/migration-status.ts*",
    "*@paperclipai/db*exec*tsx*src/migration-status.ts*",
    "*@embedded-postgres*windows-x64*native*bin*postgres.exe*",
    "*embedded-postgres*postgres.exe*"
  )

  $targets = Get-CimInstance Win32_Process |
    Where-Object {
      $commandLine = $_.CommandLine
      $matched = $false
      if ($commandLine) {
        foreach ($pattern in $patterns) {
          if ($commandLine -like $pattern) {
            $matched = $true
            break
          }
        }
      }
      $matched
    }
  $targets
}

function Get-ProcessDescendantIds {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  $children = @(Get-CimInstance Win32_Process |
    Where-Object { $_.ParentProcessId -eq $ProcessId })
  foreach ($child in $children) {
    Get-ProcessDescendantIds -ProcessId ([int]$child.ProcessId)
    [int]$child.ProcessId
  }
}

function Stop-StuckBackendProcesses {
  for ($pass = 1; $pass -le 4; $pass += 1) {
    $targets = @(Get-StuckBackendProcesses)
    if ($targets.Count -eq 0) {
      if ($pass -gt 1) {
        Write-Host "Backend process cleanup complete."
      }
      return
    }

    $targetIds = @()
    foreach ($target in $targets) {
      $targetIds += @(Get-ProcessDescendantIds -ProcessId ([int]$target.ProcessId))
      $targetIds += [int]$target.ProcessId
    }

    $targetIds = @($targetIds |
      Where-Object { $_ -ne $PID } |
      Sort-Object -Unique -Descending)

    foreach ($targetId in $targetIds) {
      $target = Get-Process -Id $targetId -ErrorAction SilentlyContinue
      if (-not $target) {
        continue
      }
      Write-Host "Stopping stuck backend process ${targetId}: $($target.ProcessName)"
      Stop-Process -Id $targetId -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Seconds 3
  }

  $remaining = @(Get-StuckBackendProcesses)
  if ($remaining.Count -gt 0) {
    Write-Host "Warning: backend cleanup still sees $($remaining.Count) matching process(es)."
  }
}

function Get-EmbeddedPostgresDataDir {
  if (-not (Test-Path $ConfigPath)) {
    return $null
  }

  try {
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    $dataDir = $config.database.embeddedPostgresDataDir
    if ([string]::IsNullOrWhiteSpace($dataDir)) {
      return $null
    }
    return $dataDir
  } catch {
    return $null
  }
}

function Get-EmbeddedPostgresPort {
  if (-not (Test-Path $ConfigPath)) {
    return $null
  }

  try {
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    $port = $config.database.embeddedPostgresPort
    if ($null -eq $port) {
      return $null
    }
    return [int]$port
  } catch {
    return $null
  }
}

function Get-PreviewDiagnosticPorts {
  $ports = @(3100, 5173)
  $dbPort = Get-EmbeddedPostgresPort
  if ($dbPort) {
    $ports += $dbPort
  }
  if ($dbPort -ne 54331) {
    $ports += 54331
  }
  return @($ports | Sort-Object -Unique)
}

function Get-PortOwnerSummary {
  param(
    [Parameter(Mandatory = $true)]
    [int[]]$Ports
  )

  foreach ($port in $Ports) {
    try {
      $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Sort-Object -Property OwningProcess -Unique)
      if ($connections.Count -eq 0) {
        Write-Host "  Port ${port}: no listener found"
        continue
      }

      foreach ($connection in $connections) {
        $processName = "unknown"
        try {
          $processName = (Get-Process -Id $connection.OwningProcess -ErrorAction Stop).ProcessName
        } catch {
          $processName = "unknown"
        }
        Write-Host "  Port ${port}: PID $($connection.OwningProcess) ($processName)"
      }
    } catch {
      Write-Host "  Port ${port}: unable to inspect"
    }
  }
}

function Get-PortOwnerSnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [int[]]$Ports
  )

  $snapshot = @()
  foreach ($port in $Ports) {
    $entries = @()
    try {
      $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Sort-Object -Property OwningProcess -Unique)
      foreach ($connection in $connections) {
        $processName = "unknown"
        try {
          $processName = (Get-Process -Id $connection.OwningProcess -ErrorAction Stop).ProcessName
        } catch {
          $processName = "unknown"
        }

        $entries += [ordered]@{
          pid = [int]$connection.OwningProcess
          processName = $processName
          state = [string]$connection.State
        }
      }
    } catch {
      $entries += [ordered]@{
        pid = $null
        processName = "unable to inspect"
        state = "unknown"
      }
    }

    $snapshot += [ordered]@{
      port = $port
      listeners = $entries
    }
  }

  return $snapshot
}

function Show-BackendRecoveryHint {
  Write-Host ""
  Write-Host "Backend recovery hints"

  $targets = @(Get-StuckBackendProcesses)
  if ($targets.Count -gt 0) {
    Write-Host "Matching backend-related processes still exist:"
    foreach ($target in $targets) {
      Write-Host "  PID $($target.ProcessId): $($target.Name)"
    }
  } else {
    Write-Host "No matching stuck backend processes were found."
  }

  $dataDir = Get-EmbeddedPostgresDataDir
  if ($dataDir) {
    $postmasterPidPath = Join-Path $dataDir "postmaster.pid"
    if (Test-Path $postmasterPidPath) {
      $pidFile = Get-Item $postmasterPidPath
      Write-Host "Embedded Postgres lock file exists:"
      Write-Host "  $postmasterPidPath"
      Write-Host "  Last write: $($pidFile.LastWriteTime)"
      Write-Host "Do not delete the database directory or lock file unless you intentionally choose database recovery."
    } else {
      Write-Host "No embedded Postgres postmaster.pid lock file was found."
    }
  } else {
    Write-Host "Embedded Postgres data directory could not be read from config."
  }

  Write-Host "Port ownership snapshot:"
  Get-PortOwnerSummary -Ports (Get-PreviewDiagnosticPorts)

  Write-Host "Suggested next steps: run pnpm run office:restart, then reopen the preview."
  Write-Host "If Windows shared memory remains stuck after cleanup, reboot Windows before retrying."
}

function Show-PreviewReadinessSummary {
  param(
    [Parameter(Mandatory = $true)]
    [bool]$BackendOk,
    [Parameter(Mandatory = $true)]
    [bool]$FrontendOk
  )

  Write-Host ""
  Write-Host "Preview readiness summary"
  Write-Host "  Backend health: $(if ($BackendOk) { 'OK' } else { 'blocked' })"
  Write-Host "  Frontend page:  $(if ($FrontendOk) { 'OK' } else { 'blocked' })"

  if ($BackendOk -and $FrontendOk) {
    Write-Host "  Next action: open the Office page and continue safe UI checks."
  } elseif (-not $BackendOk) {
    Write-Host "  Next action: keep data-changing checks paused; use office:restart, then reboot Windows if the embedded Postgres lock persists."
  } else {
    Write-Host "  Next action: restart the frontend preview only; the backend is ready."
  }
}

function Write-PreviewStatusReport {
  param(
    [Parameter(Mandatory = $true)]
    [bool]$BackendOk,
    [Parameter(Mandatory = $true)]
    [bool]$FrontendOk,
    [Parameter(Mandatory = $true)]
    [string]$Mode
  )

  $stuckProcesses = @(Get-StuckBackendProcesses | ForEach-Object {
    [ordered]@{
      pid = [int]$_.ProcessId
      name = [string]$_.Name
      commandLine = [string]$_.CommandLine
    }
  })

  $dataDir = Get-EmbeddedPostgresDataDir
  $lockFilePath = $null
  $lockFileExists = $false
  $lockFileLastWrite = $null
  if ($dataDir) {
    $lockFilePath = Join-Path $dataDir "postmaster.pid"
    if (Test-Path $lockFilePath) {
      $lockFileExists = $true
      $lockFileLastWrite = (Get-Item $lockFilePath).LastWriteTime.ToString("o")
    }
  }

  $nextAction = if ($BackendOk -and $FrontendOk) {
    "open-office"
  } elseif (-not $BackendOk) {
    "restart-backend-before-data-changing-checks"
  } else {
    "restart-frontend-preview"
  }

  $report = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    mode = $Mode
    repo = $RepoRoot
    officeUrl = $OfficeUrl
    backendHealthUrl = $BackendHealthUrl
    backendOk = $BackendOk
    frontendOk = $FrontendOk
    heartbeatSchedulerEnabled = $env:HEARTBEAT_SCHEDULER_ENABLED
    paperclipConfig = $ConfigPath
    embeddedPostgresDataDir = $dataDir
    embeddedPostgresLockFile = [ordered]@{
      path = $lockFilePath
      exists = $lockFileExists
      lastWrite = $lockFileLastWrite
    }
    stuckBackendProcesses = $stuckProcesses
    embeddedPostgresPort = Get-EmbeddedPostgresPort
    portOwnership = Get-PortOwnerSnapshot -Ports (Get-PreviewDiagnosticPorts)
    nextAction = $nextAction
  }

  $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -Path $StatusReportPath
  Write-Host "Status report: $StatusReportPath"
}

Write-Host "Virtual Office preview helper"
Write-Host "Repo: $RepoRoot"
Write-Host "Config: $ConfigPath"
Write-Host "Status report: $StatusReportPath"
Write-Host "Heartbeat scheduler: $env:HEARTBEAT_SCHEDULER_ENABLED"

if ($CheckOnly -and $Restart) {
  throw "Use either -CheckOnly or -Restart, not both."
}

$mode = if ($Restart) { "restart" } elseif ($CheckOnly) { "check-only" } else { "start" }

if ($Restart) {
  Write-Host "Stopping existing Paperclip dev service..."
  if (Test-Path $PnpmPath) {
    & $PnpmPath dev:stop
  } else {
    pnpm dev:stop
  }
  Write-Host "Cleaning backend processes so restart does not reuse a stale health server..."
  Stop-StuckBackendProcesses
}

$backendOk = Test-BackendOk -Url $BackendHealthUrl
if ($Restart -and $backendOk) {
  Write-Host "Backend still responds after stop; forcing a fresh backend start."
  Stop-StuckBackendProcesses
  $backendOk = $false
}
if (-not $backendOk) {
  if ($CheckOnly) {
    Write-Host "Backend is not healthy: $BackendHealthUrl"
  } else {
    Write-Host "Cleaning stuck Paperclip backend processes before start..."
    Stop-StuckBackendProcesses
    Write-Host "Backend is not healthy. Starting backend..."
    if (Test-Path $PnpmPath) {
      Start-Process `
        -FilePath $PnpmPath `
        -ArgumentList @("--filter", "@paperclipai/server", "exec", "tsx", "src/index.ts") `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden
    } else {
      Start-Process `
        -FilePath "pnpm" `
        -ArgumentList @("--filter", "@paperclipai/server", "exec", "tsx", "src/index.ts") `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden
    }

    $backendOk = Wait-BackendOk -Url $BackendHealthUrl -TimeoutSeconds 75
  }
}

if ($backendOk) {
  Write-Host "Backend OK: $BackendHealthUrl"
} else {
  Write-Host "Backend still not healthy after waiting: $BackendHealthUrl"
  Show-BackendRecoveryHint
}

$frontendOk = Test-FrontendOk -Url $OfficeUrl
if (-not $frontendOk) {
  if ($CheckOnly) {
    Write-Host "Frontend is not reachable: $OfficeUrl"
  } else {
    Write-Host "Frontend is not reachable. Starting frontend..."
    if (Test-Path $PnpmPath) {
      Start-Process `
        -FilePath $PnpmPath `
        -ArgumentList @("--filter", "@paperclipai/ui", "dev", "--", "--host", "localhost") `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden
    } else {
      Start-Process `
        -FilePath "pnpm" `
        -ArgumentList @("--filter", "@paperclipai/ui", "dev", "--", "--host", "localhost") `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden
    }

    $frontendOk = Wait-FrontendOk -Url $OfficeUrl -TimeoutSeconds 45
  }
}

if ($frontendOk) {
  Write-Host "Frontend OK: $OfficeUrl"
} else {
  Write-Host "Frontend still not reachable after waiting: $OfficeUrl"
}

Show-PreviewReadinessSummary -BackendOk $backendOk -FrontendOk $frontendOk
Write-PreviewStatusReport -BackendOk $backendOk -FrontendOk $frontendOk -Mode $mode

Write-Host ""
Write-Host "Open Virtual Office:"
Write-Host $OfficeUrl
