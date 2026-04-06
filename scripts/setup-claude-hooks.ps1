$projectRoot = (Get-Location).Path
$claudeDir = Join-Path $projectRoot ".claude"
if (!(Test-Path $claudeDir)) {
    New-Item -ItemType Directory -Path $claudeDir | Out-Null
}
$settingsExample = Join-Path $claudeDir "settings.example.json"
$settingsLocal = Join-Path $claudeDir "settings.local.json"
if (!(Test-Path $settingsExample)) {
    Write-Host "settings.example.json not found in .claude/"
    exit 1
}
$content = Get-Content $settingsExample -Raw
$escapedPath = $projectRoot.Replace("\", "/")
$content = $content.Replace('$PWD', $escapedPath)
Set-Content -Path $settingsLocal -Value $content -Encoding UTF8
Write-Host "settings.local.json generated successfully"
Write-Host "Project Root: $projectRoot"
