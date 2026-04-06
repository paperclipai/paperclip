$projectRoot = (Get-Location).Path
Write-Host "Running Claude project guardrails..."

$pathCheck = & "$projectRoot\scripts\validate-path.ps1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Path validation failed"
    exit 1
}

$demoCheck = & "$projectRoot\scripts\no-demo-check.ps1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Demo / placeholder validation failed"
    exit 1
}

$fullstackCheck = & "$projectRoot\scripts\fullstack-check.ps1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Full-stack completion validation failed"
    exit 1
}

Write-Host "All Claude guardrails passed"
exit 0
