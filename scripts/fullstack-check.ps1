$projectRoot = (Get-Location).Path
Write-Host "Checking full-stack completeness..."

$frontendExists = Test-Path "$projectRoot\ui\src"
$backendExists = Test-Path "$projectRoot\server\src"

if ($frontendExists -and -not $backendExists) {
    Write-Host "Frontend without backend"
    exit 1
}

$apiFiles = Get-ChildItem -Path "$projectRoot\server\src" -Recurse -Include *route*.ts,*controller*.ts,*service*.ts -File -ErrorAction SilentlyContinue
if ($frontendExists -and $apiFiles.Count -eq 0) {
    Write-Host "No backend implementation found"
    exit 1
}

Write-Host "Full-stack validation passed"
exit 0
