$projectRoot = (Get-Location).Path
Write-Host "Checking for demo / placeholder patterns..."

$blockedPatterns = @(
    "TODO",
    "FIXME",
    "coming soon",
    "placeholder",
    "mock data",
    "fake data",
    "demo only",
    "lorem ipsum",
    "stub response",
    "hardcoded response",
    "sample response"
)

$files = Get-ChildItem -Path $projectRoot -Recurse -Include *.ts,*.tsx,*.js,*.jsx,*.json,*.py -File |
    Where-Object { $_.FullName -notmatch "node_modules|dist|\.git|coverage" }

$issues = @()
foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
    foreach ($pattern in $blockedPatterns) {
        if ($content -match [regex]::Escape($pattern)) {
            $issues += "$($file.FullName) -> $pattern"
        }
    }
}

if ($issues.Count -gt 0) {
    Write-Host "Placeholder content detected:"
    $issues | ForEach-Object { Write-Host $_ }
    exit 1
}

Write-Host "No placeholder content"
exit 0
