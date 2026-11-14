[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('CaptureBaseline', 'PrepareStage', 'VerifySandbox', 'VerifyStage', 'StopStage')][string]$Mode,
  [string]$StageName = "compat-$(Get-Date -Format 'yyyyMMdd-HHmmss')",
  [string]$CandidateImage = 'paperclip-local:latest',
  [ValidateSet('docker-default', 'live-unconfined')][string]$StageSecurityMode = 'live-unconfined',
  [string]$KnownReadFile = 'Trinity Agent Memory/Start Here.md',
  [string]$ReportDirectory = 'D:\Trinity Legacy Systems\Trinity Projects\Trinity Reports',
  [int]$StagePort = 3110,
  [int]$TimeoutMinutes = 12
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stageDataRoot = Join-Path $repoRoot "data\paperclip-compatibility\$StageName"
$composeFile = Join-Path $repoRoot 'docker\docker-compose.compatibility-stage.yml'
$liveContainerName = 'docker-paperclip-1'
$liveUrl = 'http://localhost:3100'
$peterId = '8f129999-6674-4f73-b7b4-357c60311745'
$trinityHost = 'D:\Trinity Legacy Systems\Trinity Projects'

function Invoke-Docker([string[]]$Arguments) {
  $output = & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker $($Arguments -join ' ') failed ($LASTEXITCODE)" }
  return $output
}
function Get-Api([string]$Uri) { Invoke-RestMethod -Uri $Uri -TimeoutSec 20 }
function Assert-StageName {
  if ($StageName -notmatch '^compat-[a-zA-Z0-9-]{8,48}$') { throw 'StageName must start compat- and contain only letters, digits, or hyphens.' }
}
function New-SecretHex {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  [Convert]::ToHexString($bytes).ToLowerInvariant()
}
function Expand-Gzip([string]$Source, [string]$Destination) {
  $inputStream = [IO.File]::OpenRead($Source)
  try {
    $gzip = [IO.Compression.GzipStream]::new($inputStream, [IO.Compression.CompressionMode]::Decompress)
    try {
      $outputStream = [IO.File]::Create($Destination)
      try { $gzip.CopyTo($outputStream) } finally { $outputStream.Dispose() }
    } finally { $gzip.Dispose() }
  } finally { $inputStream.Dispose() }
}
function Capture-Baseline {
  if (-not (Test-Path -LiteralPath $ReportDirectory -PathType Container)) { throw "Missing report directory: $ReportDirectory" }
  $inspect = (Invoke-Docker @('inspect', $liveContainerName) | ConvertFrom-Json)[0]
  $health = Get-Api "$liveUrl/api/health"
  $agent = Get-Api "$liveUrl/api/agents/$peterId"
  $security = @(Invoke-Docker @('exec', $liveContainerName, 'sh', '-lc', 'grep -E "^(Seccomp|Seccomp_filters|CapEff):" /proc/self/status'))
  $bwrapLookup = & docker exec $liveContainerName sh -lc 'command -v bwrap' 2>$null
  $backup = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'data\paperclip\instances\default\data\backups') -Filter '*.sql.gz' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $parts = (docker version --format '{{.Client.Version}}|{{.Server.Version}}') -split '\|', 2
  $regSlash = [char]92
  $uninstallSuffix = @('Software','Microsoft','Windows','CurrentVersion','Uninstall','*') -join $regSlash
  $uninstallPaths = @(('HKLM:' + $regSlash + $uninstallSuffix), ('HKCU:' + $regSlash + $uninstallSuffix))
  $dockerDesktop = Get-ItemProperty -Path $uninstallPaths -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Docker Desktop*' } | Select-Object -First 1
  $codexCliVersion = (Invoke-Docker @('exec', $liveContainerName, 'codex', '--version') | Select-Object -First 1)
  $runningContainers = @(docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' | ForEach-Object {
    $containerParts = $_ -split '\|', 3
    [ordered]@{ name = $containerParts[0]; image = $containerParts[1]; status = $containerParts[2] }
  })
  $hermesCommand = Get-Command hermes -ErrorAction SilentlyContinue
  $hermesVersion = $null
  if ($hermesCommand -and $hermesCommand.Source -and (Test-Path -LiteralPath $hermesCommand.Source -PathType Leaf)) {
    $hermesVersionOutput = & $hermesCommand.Source --version 2>$null
    if ($LASTEXITCODE -eq 0) { $hermesVersion = $hermesVersionOutput | Select-Object -First 1 }
  }
  $snapshot = [ordered]@{
    capturedAt = (Get-Date).ToString('o')
    dockerClientVersion = $parts[0]
    dockerEngineVersion = $parts[1]
    dockerDesktopVersion = $dockerDesktop.DisplayVersion
    codexCliVersion = $codexCliVersion
    hermesExecutable = if ($hermesCommand) { $hermesCommand.Source } else { $null }
    hermesExecutableVersion = $hermesVersion
    runningContainers = $runningContainers
    paperclipVersion = $health.version
    paperclipCommit = (git -C $repoRoot rev-parse HEAD).Trim()
    composeSha256 = (Get-FileHash -Algorithm SHA256 (Join-Path $repoRoot 'docker\docker-compose.quickstart.yml')).Hash
    changedPathsAtCapture = @(git -C $repoRoot status --short)
    container = [ordered]@{
      name = $liveContainerName; id = $inspect.Id; image = $inspect.Config.Image
      imageId = $inspect.Image; manifestDigest = $inspect.ImageManifestDescriptor.digest
      status = $inspect.State.Status; securityOpt = $inspect.HostConfig.SecurityOpt
      privileged = $inspect.HostConfig.Privileged; capAdd = $inspect.HostConfig.CapAdd
      capDrop = $inspect.HostConfig.CapDrop; readOnlyRootfs = $inspect.HostConfig.ReadonlyRootfs
      pidsLimit = $inspect.HostConfig.PidsLimit
      mounts = @($inspect.Mounts | ForEach-Object { [ordered]@{ source = $_.Source; destination = $_.Destination; readWrite = $_.RW } })
    }
    peter = [ordered]@{
      id = $agent.id; companyId = $agent.companyId; adapterType = $agent.adapterType
      engine = if ($agent.adapterConfig.engine) { $agent.adapterConfig.engine } else { 'acp (default)' }
      cwd = $agent.adapterConfig.cwd
      permissionMode = if ($agent.adapterConfig.permissionMode) { $agent.adapterConfig.permissionMode } else { 'approve-all (default)' }
      acpPermissionMode = $agent.adapterConfig.acpPermissionMode
      bypass = $agent.adapterConfig.dangerouslyBypassApprovalsAndSandbox
      heartbeatEnabled = $agent.runtimeConfig.heartbeat.enabled
      provider = $agent.runtimeConfig.aiConnection.provider; connectionMode = $agent.runtimeConfig.aiConnection.mode
    }
    processSecurity = $security
    standaloneBwrapOnPath = [bool]$bwrapLookup
    latestDatabaseBackup = if ($backup) { [ordered]@{ name = $backup.Name; bytes = $backup.Length; lastWrite = $backup.LastWriteTime.ToString('o') } } else { $null }
    health = $health.status
  }
  $destination = Join-Path $ReportDirectory 'TRI-45-Paperclip-Compatibility-Baseline.json'
  $snapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $destination -Encoding utf8
  Write-Output "Baseline saved: $destination"
}
function Prepare-Stage {
  Assert-StageName
  if (Test-Path -LiteralPath $stageDataRoot) { throw "Stage directory exists; left untouched: $stageDataRoot" }
  $live = (Invoke-Docker @('inspect', $liveContainerName) | ConvertFrom-Json)[0]
  $liveData = $live.Mounts | Where-Object Destination -eq '/paperclip' | Select-Object -First 1
  if (-not $liveData -or -not $liveData.RW) { throw 'Live data mount could not be verified.' }
  $health = Get-Api "$liveUrl/api/health"
  if ($health.status -ne 'ok') { throw 'Live Paperclip health is not ok.' }
  $null = Invoke-RestMethod -Method Post -Uri "$liveUrl/api/instance/database-backups" -ContentType 'application/json' -Body '{}' -TimeoutSec 120
  $backupDir = Join-Path $liveData.Source 'instances/default/data/backups'
  $backup = Get-ChildItem -LiteralPath $backupDir -Filter '*.sql.gz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $backup) { throw 'No live SQL backup found.' }
  foreach ($key in @('master.key', 'decision-signing.key')) {
    if (-not (Test-Path -LiteralPath (Join-Path $liveData.Source "instances/default/secrets/$key"))) { throw "Missing live encryption key: $key" }
  }
  $knownHostPath = Join-Path $trinityHost $KnownReadFile
  if (-not (Test-Path -LiteralPath $knownHostPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $trinityHost 'Agent Output') -PathType Container)) { throw 'Required Trinity read file or Agent Output directory is missing.' }
  New-Item -ItemType Directory -Path (Join-Path $stageDataRoot 'init') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stageDataRoot 'home\instances\default\secrets') -Force | Out-Null
  Expand-Gzip $backup.FullName (Join-Path $stageDataRoot 'init\001-paperclip.sql')
  Copy-Item (Join-Path $liveData.Source 'instances/default/secrets/master.key') (Join-Path $stageDataRoot 'home\instances\default\secrets\master.key')
  Copy-Item (Join-Path $liveData.Source 'instances/default/secrets/decision-signing.key') (Join-Path $stageDataRoot 'home\instances\default\secrets\decision-signing.key')
  $envFile = Join-Path $stageDataRoot '.env'
  $flatRoot = $stageDataRoot -replace '\\','/'
  @(
    "PAPERCLIP_COMPAT_STAGE_NAME=$StageName"
    "PAPERCLIP_COMPAT_DATA_DIR=$flatRoot"
    "PAPERCLIP_COMPAT_HTTP_PORT=$StagePort"
    "PAPERCLIP_COMPAT_IMAGE=$CandidateImage"
    "PAPERCLIP_COMPAT_SECCOMP=$(if ($StageSecurityMode -eq 'live-unconfined') { 'seccomp=unconfined' } else { 'seccomp=builtin' })"
    "PAPERCLIP_STAGE_DB_PASSWORD=$(New-SecretHex)"
    "PAPERCLIP_STAGE_AUTH_SECRET=$(New-SecretHex)"
  ) | Set-Content -LiteralPath $envFile -Encoding ascii
  Invoke-Docker @('compose', '--env-file', $envFile, '-p', $StageName, '-f', $composeFile, 'up', '-d') | Out-Null
  $stageUrl = "http://localhost:$StagePort"
  $deadline = (Get-Date).AddMinutes(5)
  do {
    Start-Sleep -Seconds 3
    try { $stageHealth = Get-Api "$stageUrl/api/health" } catch { $stageHealth = $null }
  } while ((-not $stageHealth -or $stageHealth.status -ne 'ok') -and (Get-Date) -lt $deadline)
  if (-not $stageHealth -or $stageHealth.status -ne 'ok') { throw "Stage did not become healthy; inspect $StageName logs. Production was not changed." }
  $stageAgent = Get-Api "$stageUrl/api/agents/$peterId"
  if ($stageAgent.adapterType -ne 'codex_local') { throw 'Restored Peter agent was not found in the isolated stage.' }
  # The normal API update validates the provider by starting Codex first. For a
  # compatibility test that is meant to expose a broken sandbox, configure only
  # this disposable database directly so the check can reach that failure.
  $sql = "UPDATE agents SET adapter_config = adapter_config || jsonb_build_object('dangerouslyBypassApprovalsAndSandbox', false, 'engine', 'acp', 'cwd', '/trinity/projects', 'permissionMode', 'deny-all') WHERE id = '$peterId';"
  Invoke-Docker @('exec', "$StageName-db", 'psql', '-U', 'paperclip', '-d', 'paperclip', '-v', 'ON_ERROR_STOP=1', '-c', $sql) | Out-Null
  $stageAgent = Get-Api "$stageUrl/api/agents/$peterId"
  if ($stageAgent.adapterConfig.dangerouslyBypassApprovalsAndSandbox -ne $false) { throw 'Could not disable Peter bypass in stage database.' }
  $stage = [ordered]@{
    createdAt = (Get-Date).ToString('o'); stageName = $StageName; stageUrl = $stageUrl
    stageContainer = $StageName; databaseContainer = "$StageName-db"; dataDirectory = $stageDataRoot
    image = $CandidateImage; stageSecurityMode = $StageSecurityMode; sourceDatabaseBackup = $backup.Name; paperclipAgentId = $peterId
    companyId = $stageAgent.companyId; readFile = "/trinity/projects/$($KnownReadFile -replace '\\','/')"
    writeDirectory = '/trinity/projects/Agent Output'; productionChanged = $false
  }
  $stage | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stageDataRoot 'stage.json') -Encoding utf8
  Write-Output "Stage ready at $stageUrl. Peter bypass is disabled in the staged copy only."
}
function Get-RunLog([string]$Url, [string]$RunId) {
  $response = Invoke-RestMethod -Uri "$Url/api/heartbeat-runs/$RunId/log?limitBytes=1048576" -TimeoutSec 30
  if ($response -is [string]) { return $response }
  foreach ($name in @('text','log','content','stdout','output')) { if ($response.$name -is [string]) { return $response.$name } }
  return ($response | ConvertTo-Json -Depth 10 -Compress)
}
function Verify-Sandbox {
  Assert-StageName
  $stageFile = Join-Path $stageDataRoot 'stage.json'
  if (-not (Test-Path -LiteralPath $stageFile -PathType Leaf)) { throw "No prepared stage record: $stageFile" }
  $stageConfig = Get-Content -LiteralPath $stageFile -Raw | ConvertFrom-Json
  $inspect = (Invoke-Docker @('inspect', $StageName) | ConvertFrom-Json)[0]
  if ($inspect.State.Status -ne 'running') { throw 'Stage container is not running.' }
  $expectedSeccomp = if ($stageConfig.stageSecurityMode -eq 'live-unconfined') { 'seccomp=unconfined' } else { 'seccomp=builtin' }
  if ($inspect.HostConfig.SecurityOpt -notcontains $expectedSeccomp) { throw "Stage seccomp does not match selected mode $($stageConfig.stageSecurityMode)." }
  $mount = $inspect.Mounts | Where-Object Destination -eq '/trinity/projects' | Select-Object -First 1
  if (-not $mount -or -not $mount.RW) { throw 'The stage does not have the required Trinity Projects read/write mount.' }
  $token = [guid]::NewGuid().ToString('N')
  $allowed = "/trinity/projects/Agent Output/paperclip-compat-probe-$token.txt"
  $outside = "/paperclip/compatibility-outside-probe-$token"
  $content = "paperclip-compatibility-$token"
  $command = @(
    'set -eu'
    "known='$('/trinity/projects/' + $KnownReadFile.Replace('\','/'))'"
    "probe='$allowed'"
    "outside='$outside'"
    "content='$content'"
    'test -r "$known"'
    'test ! -e "$probe"'
    'test ! -e "$outside"'
    'printf %s "$content" > "$probe"'
    'test "$(cat "$probe")" = "$content"'
    'rm -- "$probe"'
    'test ! -e "$probe"'
    'printf "COMPATIBILITY_TRINITY_READ=PASS\nCOMPATIBILITY_WRITE_READ=PASS\nCOMPATIBILITY_PROBE_REMOVED=PASS\n"'
    'if printf %s "$content" > "$outside" 2>/dev/null; then rm -- "$outside"; printf "COMPATIBILITY_OUTSIDE_DENIED=FAIL\n"; exit 21; fi'
    'printf "COMPATIBILITY_OUTSIDE_DENIED=PASS\n"'
  ) -join "`n"
  try {
    $dockerArgs = @(
      'exec', '--user', '1000:1000', $StageName, 'codex', 'sandbox',
      '-P', ':workspace',
      '-c', 'sandbox_workspace_write.writable_roots=["/trinity/projects"]',
      '-c', 'sandbox_workspace_write.network_access=false',
      '-C', '/trinity/projects', '--', 'sh', '-lc', $command
    )
    $output = & docker @dockerArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Codex sandbox command failed ($LASTEXITCODE): $($output -join ' ')" }
    $required = @('COMPATIBILITY_TRINITY_READ=PASS','COMPATIBILITY_WRITE_READ=PASS','COMPATIBILITY_PROBE_REMOVED=PASS','COMPATIBILITY_OUTSIDE_DENIED=PASS')
    foreach ($marker in $required) { if (($output -join "`n") -notlike "*$marker*") { throw "Sandbox returned without $marker." } }
    Write-Output ($output -join [Environment]::NewLine)
  } catch {
    $evidence = [ordered]@{
      checkedAt = (Get-Date).ToString('o')
      stage = $StageName
      status = 'failed'
      image = $inspect.Config.Image
      securityOpt = $inspect.HostConfig.SecurityOpt
      seccompProfile = $inspect.HostConfig.SecurityOpt
      stageSecurityMode = $stageConfig.stageSecurityMode
      error = $_.Exception.Message
      productionChanged = $false
    }
    $resultPath = Join-Path $stageDataRoot "sandbox-failure-$((Get-Date).ToString('yyyyMMdd-HHmmss')).json"
    $evidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding utf8
    Write-Error "Codex sandbox compatibility check failed. Evidence: $resultPath"
  } finally {
    foreach ($path in @($allowed, $outside)) {
      & docker exec $StageName sh -lc "test -e '$path'" 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { Invoke-Docker @('exec', $StageName, 'rm', '-f', '--', $path) | Out-Null }
    }
  }
}
function Verify-Stage {
  Assert-StageName
  $stageFile = Join-Path $stageDataRoot 'stage.json'
  if (-not (Test-Path -LiteralPath $stageFile -PathType Leaf)) { throw "No prepared stage record: $stageFile" }
  $stage = Get-Content -LiteralPath $stageFile -Raw | ConvertFrom-Json
  $stageName = $stage.stageName
  $url = $stage.stageUrl
  if ($url -eq $liveUrl) { throw 'Refusing to run against production.' }
  $inspect = (Invoke-Docker @('inspect', $stageName) | ConvertFrom-Json)[0]
  $expectedSeccomp = if ($stage.stageSecurityMode -eq 'live-unconfined') { 'seccomp=unconfined' } else { 'seccomp=builtin' }
  if ($inspect.State.Status -ne 'running' -or $inspect.HostConfig.SecurityOpt -notcontains $expectedSeccomp) { throw 'Stage stopped or its seccomp setting differs from the recorded mode.' }
  $mounts = $inspect.Mounts
  $projectsMount = $mounts | Where-Object Destination -eq '/trinity/projects' | Select-Object -First 1
  $dataMount = $mounts | Where-Object Destination -eq '/paperclip' | Select-Object -First 1
  $live = (Invoke-Docker @('inspect', $liveContainerName) | ConvertFrom-Json)[0]
  $liveData = $live.Mounts | Where-Object Destination -eq '/paperclip' | Select-Object -First 1
  if (-not $projectsMount -or -not $projectsMount.RW -or -not $dataMount -or $dataMount.Source -eq $liveData.Source) { throw 'Stage mount isolation or Trinity read/write mount check failed.' }
  if ((Get-Api "$url/api/health").status -ne 'ok') { throw 'Staged Paperclip health is not ok.' }
  $agent = Get-Api "$url/api/agents/$($stage.paperclipAgentId)"
  if ($agent.adapterType -ne 'codex_local' -or $agent.adapterConfig.dangerouslyBypassApprovalsAndSandbox -ne $false -or
      $agent.adapterConfig.cwd -ne '/trinity/projects' -or $agent.adapterConfig.permissionMode -ne 'deny-all' -or
      ($agent.adapterConfig.engine -and $agent.adapterConfig.engine -ne 'acp')) { throw 'Stage Peter is not in scoped normal ACP mode.' }
  Verify-Sandbox
  Invoke-Docker @('exec', $stageName, 'test', '-r', $stage.readFile) | Out-Null
  $token = [guid]::NewGuid().ToString('N')
  $allowedPath = "/trinity/projects/Agent Output/paperclip-compat-probe-$token.txt"
  $outsidePath = "/paperclip/compatibility-outside-probe-$token"
  Invoke-Docker @('exec', $stageName, 'test', '!', '-e', $allowedPath) | Out-Null
  Invoke-Docker @('exec', $stageName, 'test', '!', '-e', $outsidePath) | Out-Null
  $content = "paperclip-compatibility-$token"
  $taskDescription = @(
    'Perform only this safe file access check in your normal Codex ACP mode. Do not use bypass, approval override, fallback, another engine, host execution, or Docker commands.'
    'Do not edit or delete any file except the unique probe specified below.'
    '1. Run a harmless shell command and print COMPATIBILITY_SHELL_STARTED.'
    "2. Read $($stage.readFile)."
    "3. Create $allowedPath with exactly $content, read it back and verify the exact content, remove it, and confirm it is absent."
    "4. Try to create $outsidePath with content $token. It must be denied by the sandbox. If it succeeds, remove only that exact path and report outsideWriteDenied=false."
    '5. Finish with one line COMPATIBILITY_RESULT_JSON: followed by a JSON object with boolean fields shellStarted, trinityRead, probeWriteRead, probeRemoved, outsideWriteDenied, outsideProbeRemoved, bypassOrFallbackUsed. Derive each value from a completed tool result.'
  ) -join "`n"
  $runId = $null
  $issueId = $null
  $gatePassed = $false
  try {
    $issueBody = @{
      title = "Paperclip compatibility check $token"
      description = $taskDescription
      status = 'todo'
      priority = 'low'
      assigneeAgentId = $stage.paperclipAgentId
      idempotencyKey = "paperclip-compatibility-$token"
    } | ConvertTo-Json -Depth 5
    $issue = Invoke-RestMethod -Method Post -Uri "$url/api/companies/$($stage.companyId)/issues" -ContentType 'application/json' -Body $issueBody -TimeoutSec 30
    $issueId = $issue.id
    if (-not $issueId -or $issue.assigneeAgentId -ne $stage.paperclipAgentId) { throw 'Could not create the staged Peter compatibility task.' }
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    do {
      Start-Sleep -Seconds 5
      $runs = @(Get-Api "$url/api/companies/$($stage.companyId)/heartbeat-runs?agentId=$($stage.paperclipAgentId)&limit=30")
      $run = $runs | Where-Object { $_.contextSnapshot.issueId -eq $issueId } | Select-Object -First 1
    } while ((-not $run -or $run.status -notin @('succeeded','failed','cancelled','timed_out','budget_exceeded')) -and (Get-Date) -lt $deadline)
    if (-not $run) { throw "Peter did not receive the staged compatibility task $($issue.identifier)." }
    $runId = $run.id
    $run = Get-Api "$url/api/heartbeat-runs/$runId"
    if ($run.status -ne 'succeeded') { throw "Staged Peter run failed or timed out: $($run.status), run $runId" }
    $run = Get-Api "$url/api/heartbeat-runs/$runId"
    $log = Get-RunLog $url $runId
    $match = [regex]::Match([string]$run.resultJson.summary, 'COMPATIBILITY_RESULT_JSON:\s*(\{[^\r\n]*\})')
    if (-not $match.Success) { throw "Staged run has no structured result; inspect run $runId." }
    $result = $match.Groups[1].Value | ConvertFrom-Json
    foreach ($field in @('shellStarted','trinityRead','probeWriteRead','probeRemoved','outsideWriteDenied','outsideProbeRemoved')) {
      if ($result.$field -ne $true) { throw "Compatibility check failed at $field (run $runId)." }
    }
    if ($result.bypassOrFallbackUsed -ne $false) { throw "The run reported bypass/fallback (run $runId)." }
    if ($run.resultJson.permissionMode -ne 'deny-all') { throw "Staged ACP permission mode was not deny-all (run $runId)." }
    foreach ($expectedPath in @($stage.readFile, $allowedPath, $outsidePath)) {
      if ($log -notlike "*$expectedPath*") { throw "Staged ACP log does not show the requested path $expectedPath (run $runId)." }
    }
    $cwdMatch = [regex]::Match($run.stdoutExcerpt, '"runtimeSessionName":"acpx:v2:([A-Za-z0-9_=-]+)"')
    if (-not $cwdMatch.Success) { throw "Staged ACP session metadata is missing (run $runId)." }
    $runtimeBase64 = $cwdMatch.Groups[1].Value.Replace('-', '+').Replace('_', '/')
    $runtimeBase64 += '=' * ((4 - ($runtimeBase64.Length % 4)) % 4)
    $runtimeSession = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($runtimeBase64)) | ConvertFrom-Json
    if ($runtimeSession.cwd -ne '/trinity/projects') { throw "Staged ACP cwd was not /trinity/projects (run $runId)." }
    Invoke-Docker @('exec', $stageName, 'test', '!', '-e', $allowedPath) | Out-Null
    Invoke-Docker @('exec', $stageName, 'test', '!', '-e', $outsidePath) | Out-Null
    $record = [ordered]@{
      checkedAt = (Get-Date).ToString('o'); stage = $StageName; image = $stage.image
      securityOpt = $inspect.HostConfig.SecurityOpt; stageSecurityMode = $stage.stageSecurityMode
      processSeccomp = @(Invoke-Docker @('exec', $stageName, 'sh', '-lc', 'grep -E "^(Seccomp|Seccomp_filters):" /proc/self/status'))
      issueId = $issueId; issueIdentifier = $issue.identifier
      runId = $runId; status = $run.status; result = $result; productionChanged = $false
    }
    $resultPath = Join-Path $stageDataRoot "result-$((Get-Date).ToString('yyyyMMdd-HHmmss')).json"
    $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8
    $gatePassed = $true
    Write-Output "COMPATIBILITY GATE PASSED. Evidence: $resultPath"
  } finally {
    foreach ($probe in @($allowedPath, $outsidePath)) {
      if ($probe) {
        & docker exec $stageName sh -lc "test -e '$probe'" 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
          Invoke-Docker @('exec', $stageName, 'rm', '-f', '--', $probe) | Out-Null
          Write-Warning "Removed only this run's leftover probe: $probe"
        }
      }
    }
    if ($issueId) {
      try {
        $finalIssueStatus = if ($gatePassed) { 'done' } else { 'cancelled' }
        $closeBody = @{ status = $finalIssueStatus } | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Patch -Uri "$url/api/issues/$issueId" -ContentType 'application/json' -Body $closeBody -TimeoutSec 20 | Out-Null
      } catch { Write-Warning "Could not close staged compatibility issue $issueId; it remains only in the isolated stage." }
    }
  }
}
function Stop-Stage {
  Assert-StageName
  $envFile = Join-Path $stageDataRoot '.env'
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'Stage .env is missing; no containers stopped.' }
  Invoke-Docker @('compose','--env-file',$envFile,'-p',$StageName,'-f',$composeFile,'stop') | Out-Null
  Write-Output "Stopped $StageName; staged data and evidence were preserved at $stageDataRoot."
}

switch ($Mode) {
  CaptureBaseline { Capture-Baseline }
  PrepareStage { Prepare-Stage }
  VerifySandbox { Verify-Sandbox }
  VerifyStage { Verify-Stage }
  StopStage { Stop-Stage }
}
