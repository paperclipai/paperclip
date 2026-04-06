$projectRoot = (Get-Location).Path
Write-Host "Validating project path..."

if ($projectRoot -match "Desktop" -or $projectRoot -match "Downloads") {
    Write-Host "Unsafe project location"
    exit 1
}
if (!(Test-Path "$projectRoot\scripts")) {
    Write-Host "scripts folder missing"
    exit 1
}
if (!(Test-Path "$projectRoot\.claude")) {
    Write-Host ".claude folder missing"
    exit 1
}

Write-Host "Path validation passed"
exit 0
