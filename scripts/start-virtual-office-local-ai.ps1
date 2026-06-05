param(
  [switch]$Restart,
  [switch]$CheckOnly,
  [string]$Model = "qwen2.5:14b",
  [string]$IssueId = "AI-98533",
  [string]$AgentId = "b2e4cbb8-ae14-4903-94a4-29fda4e60354"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = Split-Path -Parent $RepoRoot
$PnpmPath = Join-Path $WorkspaceRoot ".tools\pnpm.cmd"
$StatusReportPath = Join-Path $RepoRoot ".virtual-office-local-ai-status.json"
$PreviewScript = Join-Path $PSScriptRoot "start-virtual-office-preview.ps1"
$BridgeScript = Join-Path $PSScriptRoot "start-hermes-ollama-bridge.ps1"
$BackendHealthUrl = "http://127.0.0.1:3100/api/health"
$OllamaTagsUrl = "http://127.0.0.1:11434/api/tags"

if (Test-Path $PnpmPath) {
  $env:PATH = "$(Split-Path -Parent $PnpmPath);$env:PATH"
}

$env:HEARTBEAT_SCHEDULER_ENABLED = "false"

function Write-Section {
  param([Parameter(Mandatory = $true)][string]$Text)
  Write-Host ""
  Write-Host $Text
}

function Test-BackendOk {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $BackendHealthUrl -TimeoutSec 10
    $body = $response.Content | ConvertFrom-Json
    return [int]$response.StatusCode -eq 200 -and $body.status -eq "ok"
  } catch {
    return $false
  }
}

function Start-OllamaIfNeeded {
  if ($CheckOnly) {
    return
  }

  if (Test-OllamaOk) {
    return
  }

  $ollama = Get-Command ollama.exe -ErrorAction SilentlyContinue
  if (-not $ollama) {
    throw "ollama.exe was not found. Install or start Ollama before using the local AI helper."
  }

  Write-Host "Starting Ollama..."
  Start-Process -FilePath $ollama.Source -ArgumentList @("serve") -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    if (Test-OllamaOk) {
      return
    }
    Start-Sleep -Seconds 3
  }
}

function Test-OllamaOk {
  try {
    $response = Invoke-RestMethod -Uri $OllamaTagsUrl -TimeoutSec 10
    return $null -ne $response.models
  } catch {
    return $false
  }
}

function Get-OllamaModels {
  try {
    $response = Invoke-RestMethod -Uri $OllamaTagsUrl -TimeoutSec 10
    return @($response.models | ForEach-Object { if ($_.name) { $_.name } elseif ($_.model) { $_.model } })
  } catch {
    return @()
  }
}

function Start-BridgeIfNeeded {
  if ($CheckOnly) {
    return
  }

  $args = @()
  if ($Restart) {
    $args += "-Restart"
  }
  & powershell -ExecutionPolicy Bypass -File $BridgeScript @args
}

function Get-BridgeStatus {
  $path = Join-Path $RepoRoot ".hermes-ollama-bridge-status.json"
  if (-not (Test-Path $path)) {
    return $null
  }

  try {
    return Get-Content $path -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-WslModels {
  param([Parameter(Mandatory = $true)][string]$BaseUrl)

  $modelsUrl = "$BaseUrl/v1/models"
  $output = & wsl.exe -d Ubuntu -- curl -fsS --max-time 10 $modelsUrl 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($output)) {
    return @{ ok = $false; models = @() }
  }

  try {
    $json = $output | ConvertFrom-Json
    $models = @($json.data | ForEach-Object { $_.id })
    return @{ ok = $true; models = $models }
  } catch {
    return @{ ok = $false; models = @() }
  }
}

function Get-CompanyId {
  try {
    $companies = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/companies" -TimeoutSec 10
    $company = @($companies.value)[0]
    return $company.id
  } catch {
    return $null
  }
}

function Get-AgentSummary {
  param([Parameter(Mandatory = $true)][string]$Id)

  try {
    $agent = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/agents/$Id" -TimeoutSec 10
    return [ordered]@{
      id = $agent.id
      name = $agent.name
      status = $agent.status
      pauseReason = $agent.pauseReason
      adapterType = $agent.adapterType
    }
  } catch {
    return $null
  }
}

function Get-IssueSummary {
  param([Parameter(Mandatory = $true)][string]$Id)

  try {
    $issue = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/issues/$Id" -TimeoutSec 10
    $activeRun = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/issues/$($issue.id)/active-run" -TimeoutSec 10
    $liveRuns = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/issues/$($issue.id)/live-runs" -TimeoutSec 10
    $liveRunCount = if ($null -ne $liveRuns.Count) { [int]$liveRuns.Count } else { @($liveRuns.value).Count }
    return [ordered]@{
      id = $issue.id
      identifier = $issue.identifier
      title = $issue.title
      status = $issue.status
      checkoutRunId = $issue.checkoutRunId
      executionRunId = $issue.executionRunId
      activeRun = $activeRun
      liveRunCount = $liveRunCount
    }
  } catch {
    return $null
  }
}

function Test-NullishApiValue {
  param($Value)

  if ($null -eq $Value) {
    return $true
  }
  return [string]$Value -eq "null"
}

Write-Host "Virtual Office local AI helper"
Write-Host "Repo: $RepoRoot"
Write-Host "Heartbeat scheduler: $env:HEARTBEAT_SCHEDULER_ENABLED"

Write-Section "1. Virtual Office preview"
$previewArgs = @()
if ($Restart) {
  $previewArgs += "-Restart"
}
if ($CheckOnly) {
  $previewArgs += "-CheckOnly"
}
& powershell -ExecutionPolicy Bypass -File $PreviewScript @previewArgs
$backendOk = Test-BackendOk

Write-Section "2. Ollama"
Start-OllamaIfNeeded
$ollamaOk = Test-OllamaOk
$ollamaModels = @(Get-OllamaModels)
$modelVisibleInOllama = $ollamaModels -contains $Model
if ($ollamaOk) {
  Write-Host "Ollama OK: $OllamaTagsUrl"
  Write-Host "Model visible in Ollama: $Model = $modelVisibleInOllama"
} else {
  Write-Host "Ollama is not reachable: $OllamaTagsUrl"
}

Write-Section "3. Hermes Ollama bridge"
if ($ollamaOk) {
  Start-BridgeIfNeeded
} else {
  Write-Host "Skipping bridge start because Ollama is not reachable."
}
$bridgeStatus = Get-BridgeStatus
$bridgeBaseUrl = if ($bridgeStatus) { [string]$bridgeStatus.openAiCompatibleBaseUrl } else { $null }
$bridgeRootUrl = if ($bridgeStatus) { [string]$bridgeStatus.bridgeUrl } else { $null }
$wslModelsResult = if ($bridgeRootUrl) { Test-WslModels -BaseUrl $bridgeRootUrl } else { @{ ok = $false; models = @() } }
$modelVisibleFromWsl = @($wslModelsResult.models) -contains $Model
if ($wslModelsResult.ok) {
  Write-Host "Hermes bridge OK from WSL: $bridgeBaseUrl"
  Write-Host "Model visible through bridge: $Model = $modelVisibleFromWsl"
} else {
  Write-Host "Hermes bridge is not reachable from WSL."
}

Write-Section "4. Agent and issue safety"
$companyId = Get-CompanyId
$agent = Get-AgentSummary -Id $AgentId
$issue = Get-IssueSummary -Id $IssueId
$agentSafe = $agent -and $agent.status -eq "paused" -and $agent.pauseReason -eq "manual" -and $agent.adapterType -eq "hermes_local"
$issueSafe = $issue -and (Test-NullishApiValue $issue.checkoutRunId) -and (Test-NullishApiValue $issue.executionRunId) -and (Test-NullishApiValue $issue.activeRun) -and [int]$issue.liveRunCount -eq 0

if ($agent) {
  Write-Host "Agent: $($agent.name) ($($agent.status)/$($agent.pauseReason), $($agent.adapterType))"
} else {
  Write-Host "Agent: not found ($AgentId)"
}

if ($issue) {
  Write-Host "Issue: $($issue.identifier) $($issue.status), active/live runs: none/$($issue.liveRunCount)"
} else {
  Write-Host "Issue: not found ($IssueId)"
}

$allOk = $backendOk -and $ollamaOk -and $modelVisibleInOllama -and $wslModelsResult.ok -and $modelVisibleFromWsl -and $agentSafe -and $issueSafe

$status = [ordered]@{
  ok = [bool]$allOk
  checkedAt = (Get-Date).ToString("o")
  repo = $RepoRoot
  heartbeatSchedulerEnabled = $env:HEARTBEAT_SCHEDULER_ENABLED
  preview = [ordered]@{
    backendOk = [bool]$backendOk
    healthUrl = $BackendHealthUrl
    officeUrl = "http://localhost:5173/AI/office"
  }
  ollama = [ordered]@{
    ok = [bool]$ollamaOk
    tagsUrl = $OllamaTagsUrl
    model = $Model
    modelVisible = [bool]$modelVisibleInOllama
    models = $ollamaModels
  }
  hermesBridge = [ordered]@{
    okFromWsl = [bool]$wslModelsResult.ok
    bridgeUrl = $bridgeRootUrl
    openAiCompatibleBaseUrl = $bridgeBaseUrl
    modelVisible = [bool]$modelVisibleFromWsl
    models = @($wslModelsResult.models)
  }
  agent = $agent
  issue = $issue
  nextAction = if ($allOk) {
    "READY: local AI stack is healthy. A Hermes wake-up still requires a fresh explicit one-time authorization."
  } else {
    "WAIT: fix the failed local AI readiness item before any Hermes wake-up."
  }
}

$status | ConvertTo-Json -Depth 8 | Set-Content -Path $StatusReportPath -Encoding UTF8

Write-Section "Local AI readiness summary"
Write-Host "  Preview backend:    $(if ($backendOk) { 'OK' } else { 'blocked' })"
Write-Host "  Ollama:             $(if ($ollamaOk) { 'OK' } else { 'blocked' })"
Write-Host "  Model ${Model}:       $(if ($modelVisibleInOllama -and $modelVisibleFromWsl) { 'OK' } else { 'blocked' })"
Write-Host "  Hermes bridge:      $(if ($wslModelsResult.ok) { 'OK' } else { 'blocked' })"
Write-Host "  Eve safety state:   $(if ($agentSafe) { 'OK' } else { 'blocked' })"
Write-Host "  Issue run state:    $(if ($issueSafe) { 'OK' } else { 'blocked' })"
Write-Host "  Next action:        $($status.nextAction)"
Write-Host "Status report: $StatusReportPath"
Write-Host ""
Write-Host "Open Virtual Office:"
Write-Host "http://localhost:5173/AI/office"

if (-not $allOk) {
  exit 1
}
