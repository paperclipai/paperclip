param(
  [string]$ApiBase = "http://127.0.0.1:3100/api",
  [string]$CompanyPrefix = "YOO",
  [int]$TimeoutSec = 420,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Invoke-PaperclipJson {
  param(
    [ValidateSet("GET", "POST", "PATCH")]
    [string]$Method,
    [string]$Path,
    [object]$Body = $null
  )

  $uri = "$ApiBase$Path"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri -TimeoutSec 30
  }

  return Invoke-RestMethod `
    -Method $Method `
    -Uri $uri `
    -ContentType "application/json" `
    -Body ($Body | ConvertTo-Json -Depth 12) `
    -TimeoutSec 30
}

function First-NonEmptyString {
  param(
    [object]$First,
    [object]$Second
  )
  if ($First -is [string] -and $First.Trim().Length -gt 0) {
    return $First
  }
  return $Second
}

$companies = Invoke-PaperclipJson -Method GET -Path "/companies"
$company = @($companies | Where-Object { $_.issuePrefix -eq $CompanyPrefix } | Select-Object -First 1)[0]
if (-not $company) {
  throw "Company prefix '$CompanyPrefix' was not found."
}

$agents = Invoke-PaperclipJson -Method GET -Path "/companies/$($company.id)/agents"
$hermes = @(
  $agents |
    Where-Object { $_.adapterType -eq "hermes_local" -or $_.name -match "Hermes" } |
    Select-Object -First 1
)[0]
if (-not $hermes) {
  throw "Hermes agent was not found in company '$($company.name)'."
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$issueBody = @{
  title = "Hermes E2E smoke $stamp"
  description = @"
YoonCompany Hermes E2E smoke test.

Expected behavior:
- Hermes receives this assigned issue through Paperclip.
- Hermes posts one concise proposal/comment.
- Hermes marks the issue done.
- Hermes does not edit repo files.

verification:
- run status succeeded
- issue status done
- at least one issue comment exists
"@
  priority = "medium"
  status = "todo"
  assigneeAgentId = $hermes.id
}

if ($DryRun) {
  [pscustomobject]@{
    company = $company.name
    companyId = $company.id
    hermes = $hermes.name
    hermesId = $hermes.id
    issue = $issueBody
    dryRun = $true
  } | ConvertTo-Json -Depth 8
  exit 0
}

$issue = Invoke-PaperclipJson -Method POST -Path "/companies/$($company.id)/issues" -Body $issueBody
$issueLabel = First-NonEmptyString -First $issue.identifier -Second $issue.id
Write-Host "Created issue $issueLabel"

$run = Invoke-PaperclipJson -Method POST -Path "/agents/$($hermes.id)/heartbeat/invoke" -Body @{
  reason = "YoonCompany Hermes E2E smoke"
  triggerDetail = "manual"
  forceFreshSession = $true
  payload = @{
    issueId = $issue.id
  }
}
Write-Host "Started run $($run.id)"

$deadline = (Get-Date).AddSeconds($TimeoutSec)
do {
  Start-Sleep -Seconds 5
  $run = Invoke-PaperclipJson -Method GET -Path "/heartbeat-runs/$($run.id)"
  Write-Host "status=$($run.status) lastOutputSeq=$($run.lastOutputSeq)"
} while ($run.status -in @("queued", "running") -and (Get-Date) -lt $deadline)

$finalIssue = Invoke-PaperclipJson -Method GET -Path "/issues/$($issue.id)"
$comments = @(Invoke-PaperclipJson -Method GET -Path "/issues/$($issue.id)/comments")

$passed = $run.status -eq "succeeded" -and $finalIssue.status -eq "done" -and $comments.Count -gt 0
$summary = [pscustomobject]@{
  passed = $passed
  issueId = $issue.id
  identifier = $issue.identifier
  runId = $run.id
  runStatus = $run.status
  exitCode = $run.exitCode
  issueStatus = $finalIssue.status
  commentCount = $comments.Count
  result = First-NonEmptyString -First $run.resultJson.summary -Second $run.resultJson.result
}

$summary | ConvertTo-Json -Depth 8
if (-not $passed) {
  exit 1
}
