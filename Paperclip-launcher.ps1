$ErrorActionPreference = "SilentlyContinue"

$repoRoot  = "C:\Users\thepr\GitHub\paperclip"
$dbDir     = "C:\Users\thepr\.paperclip\instances\default\db"
$logDir    = "C:\Users\thepr\.paperclip"
$logFile   = "$logDir\server.log"
$pgCtl     = "$repoRoot\node_modules\.pnpm\@embedded-postgres+windows-x64@18.1.0-beta.16\node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe"
$pnpm      = "$env:APPDATA\npm\pnpm.cmd"
$npmDir    = "$env:APPDATA\npm"
$tsx       = "$repoRoot\node_modules\.pnpm\tsx@4.21.0\node_modules\tsx\dist\cli.mjs"

$LOG_MAX_MB    = 20      # rotate when log exceeds this size
$LOG_KEEP      = 5       # keep this many rotated logs
$SERVER_PORT   = 3100
$RESTART_DELAY = 5       # seconds to wait before auto-restart

# Ensure npm/pnpm global bin dir is in PATH
if ($env:PATH -notlike "*$npmDir*") {
    $env:PATH = "$npmDir;$env:PATH"
}

function Test-Port($port) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient("127.0.0.1", $port)
        $tcp.Close(); return $true
    } catch { return $false }
}

function Get-PaperclipPid {
    # Find the node process listening on SERVER_PORT
    $netstat = netstat -ano 2>$null | Select-String ":$SERVER_PORT\s.*LISTENING"
    if ($netstat) {
        $pid = ($netstat -split '\s+')[-1]
        return [int]$pid
    }
    return $null
}

function Stop-PaperclipServer {
    $pid = Get-PaperclipPid
    if ($pid) {
        Write-Host "Stopping existing Paperclip server (PID $pid)..."
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

function Rotate-Log {
    if (-not (Test-Path $logFile)) { return }
    $sizeMb = (Get-Item $logFile).Length / 1MB
    if ($sizeMb -lt $LOG_MAX_MB) { return }

    Write-Host "Rotating log ($([math]::Round($sizeMb,1)) MB)..."
    # Shift old rotated logs
    for ($i = $LOG_KEEP; $i -ge 1; $i--) {
        $src  = if ($i -eq 1) { $logFile } else { "$logFile.$($i-1)" }
        $dest = "$logFile.$i"
        if (Test-Path $src) {
            if (Test-Path $dest) { Remove-Item $dest -Force }
            Rename-Item $src $dest -Force
        }
    }
}

function Start-PaperclipServer {
    Rotate-Log
    $pathForServer = $env:PATH
    $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "set `"PATH=$pathForServer`" && node `"$tsx`" `"$repoRoot\server\src\index.ts`" >> `"$logFile`" 2>&1" `
        -WorkingDirectory "$repoRoot\server" `
        -WindowStyle Hidden `
        -PassThru
    return $proc
}

# If server is already up, just open Chrome and exit
if (Test-Port $SERVER_PORT) {
    Start-Process "chrome.exe" "http://localhost:$SERVER_PORT"
    exit
}

# Kill only the Paperclip server process (not all node processes)
Stop-PaperclipServer

# Stop postgres gracefully, then clean stale PID
if (Test-Path $pgCtl) {
    & $pgCtl stop -D $dbDir -m fast 2>$null
    Start-Sleep -Seconds 3
}
if (Test-Path "$dbDir\postmaster.pid") {
    Remove-Item "$dbDir\postmaster.pid" -Force -ErrorAction SilentlyContinue
}

# Start Ollama (no-op if already running)
Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Start server and wait for it to be ready
Write-Host "Starting Paperclip server..."
$serverProc = Start-PaperclipServer

$i = 0
while (-not (Test-Port $SERVER_PORT) -and $i -lt 60) {
    Start-Sleep -Seconds 3
    $i++
}

if (Test-Port $SERVER_PORT) {
    Write-Host "Server ready on port $SERVER_PORT"
    Start-Process "chrome.exe" "http://localhost:$SERVER_PORT"
} else {
    Write-Host "Server failed to start after 3 minutes. Check $logFile"
    exit 1
}

# Auto-restart monitor loop — keeps running in background after launch
# Detach so the launcher window can close; monitor runs in a hidden job
$monitorScript = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$logFile   = '$logFile'
`$tsx       = '$tsx'
`$repoRoot  = '$repoRoot'
`$port      = $SERVER_PORT
`$restartDelay = $RESTART_DELAY
`$LOG_MAX_MB = $LOG_MAX_MB
`$LOG_KEEP   = $LOG_KEEP
`$env:PATH   = '$($env:PATH)'

function Test-Port2(`$p) {
    try { `$t = New-Object System.Net.Sockets.TcpClient('127.0.0.1', `$p); `$t.Close(); return `$true } catch { return `$false }
}
function Rotate-Log2 {
    if (-not (Test-Path `$logFile)) { return }
    `$sizeMb = (Get-Item `$logFile).Length / 1MB
    if (`$sizeMb -lt `$LOG_MAX_MB) { return }
    for (`$i = `$LOG_KEEP; `$i -ge 1; `$i--) {
        `$src  = if (`$i -eq 1) { `$logFile } else { "`$logFile.`$(`$i-1)" }
        `$dest = "`$logFile.`$i"
        if (Test-Path `$src) { if (Test-Path `$dest) { Remove-Item `$dest -Force }; Rename-Item `$src `$dest -Force }
    }
}

while (`$true) {
    Start-Sleep -Seconds 15
    if (-not (Test-Port2 `$port)) {
        Add-Content `$logFile "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] watchdog: server down — restarting"
        Start-Sleep -Seconds `$restartDelay
        Rotate-Log2
        Start-Process -FilePath 'cmd.exe' ``
            -ArgumentList '/c', "set \`"PATH=`$(`$env:PATH)\`" && node \`"`$tsx\`" \`"`$repoRoot\server\src\index.ts\`" >> \`"`$logFile\`" 2>&1" ``
            -WorkingDirectory "`$repoRoot\server" ``
            -WindowStyle Hidden
        # Wait up to 3 min for recovery
        `$j = 0
        while (-not (Test-Port2 `$port) -and `$j -lt 36) { Start-Sleep -Seconds 5; `$j++ }
        if (Test-Port2 `$port) {
            Add-Content `$logFile "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] watchdog: server recovered"
        } else {
            Add-Content `$logFile "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] watchdog: recovery failed after 3 min"
        }
    }
}
"@

$encodedScript = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($monitorScript))
Start-Process "powershell.exe" `
    -ArgumentList "-WindowStyle", "Hidden", "-EncodedCommand", $encodedScript `
    -WindowStyle Hidden
