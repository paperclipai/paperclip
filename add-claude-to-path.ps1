$claudePath = "$env:APPDATA\Claude\claude-code\2.1.92"
$machine = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
if ($machine -like "*$claudePath*") {
    Write-Host "Already in Machine PATH — no change needed."
} else {
    [Environment]::SetEnvironmentVariable('PATH', "$machine;$claudePath", 'Machine')
    Write-Host "Added to Machine PATH successfully."
}
Write-Host "Done. Press Enter to close."
Read-Host
