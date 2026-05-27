param([string]$ComponentsDir)

$results = Get-ChildItem -Recurse -Filter *.tsx -Path $ComponentsDir | ForEach-Object {
    $f = $_.FullName
    $lines = (Get-Content $f | Measure-Object -Line).Lines
    [PSCustomObject]@{File=$f; Lines=$lines}
} | Where-Object { $_.Lines -gt 300 } | Sort-Object Lines -Descending | Select-Object -First 30

$results | Format-Table -AutoSize -Wrap

Write-Host "`n--- Top files ---"
$results | Select-Object -First 5 | ForEach-Object { Write-Host "$($_.Lines) $($_.File)" }