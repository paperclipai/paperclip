#requires -Version 5.1
<#
  Fail fast if the Paperclip HTTP listen port is already bound (loopback).
  Used by start-paperclip-dev-external.ps1 and `pnpm dev:prereqs`.

  Strict mode (PAPERCLIP_STRICT_PORTS, default via dev-runner) expects no silent port bump;
  this preflight surfaces conflicts before docker/pnpm.

  Usage (from repo root):
    pwsh -NoProfile -File .\scripts\ensure-paperclip-ports-free.ps1
    pwsh -NoProfile -File .\scripts\ensure-paperclip-ports-free.ps1 -Port 3101
#>
param(
  [int]$Port = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Port -le 0) {
  $parsed = 0
  if ($env:PORT -and [int]::TryParse($env:PORT, [ref]$parsed) -and $parsed -gt 0) {
    $Port = $parsed
  }
  else {
    $Port = 3100
  }
}

$listener = $null
try {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  $listener.Start()
}
catch {
  Write-Host ""
  Write-Host "Port $Port is already in use on 127.0.0.1." -ForegroundColor Red
  Write-Host "Stop the other process (e.g. pnpm dev:stop / dev:nuke), or set PORT to a free port." -ForegroundColor Yellow
  Write-Host "With PAPERCLIP_STRICT_PORTS=true, Paperclip will not auto-switch to the next port." -ForegroundColor Yellow
  Write-Host ""
  exit 1
}
finally {
  if ($null -ne $listener) {
    try { $listener.Stop() } catch { }
  }
}

Write-Host "Preflight: listen port $Port is free (loopback)." -ForegroundColor DarkGreen
