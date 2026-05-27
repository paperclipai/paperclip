$enPath = Join-Path $PSScriptRoot 'en.json'
$zhPath = Join-Path $PSScriptRoot 'zh-CN.json'

$enContent = Get-Content $enPath -Raw | ConvertFrom-Json
$zhContent = Get-Content $zhPath -Raw | ConvertFrom-Json

function Get-FlatKeys($obj, $prefix) {
    $result = @()
    foreach ($key in $obj.PSObject.Properties.Name) {
        $fullKey = if ($prefix) { "$prefix.$key" } else { $key }
        $value = $obj.$key
        if ($value -is [string]) {
            $result += $fullKey
        } elseif ($null -ne $value) {
            $result += Get-FlatKeys $value $fullKey
        }
    }
    return $result
}

$enKeys = Get-FlatKeys $enContent '' | Sort-Object
$zhKeys = Get-FlatKeys $zhContent '' | Sort-Object

Write-Host "en.json keys: $($enKeys.Count)"
Write-Host "zh-CN.json keys: $($zhKeys.Count)"

$diff = Compare-Object $enKeys $zhKeys
$onlyInEn = $diff | Where-Object { $_.SideIndicator -eq '<=' } | Select-Object -ExpandProperty InputObject
$onlyInZh = $diff | Where-Object { $_.SideIndicator -eq '=>' } | Select-Object -ExpandProperty InputObject

Write-Host ""
Write-Host "=== Keys in en.json but MISSING in zh-CN.json ($($onlyInEn.Count)) ==="
$onlyInEn | ForEach-Object { Write-Host "  $_" }

Write-Host ""
Write-Host "=== Keys in zh-CN.json but NOT in en.json (orphans) ($($onlyInZh.Count)) ==="
$onlyInZh | ForEach-Object { Write-Host "  $_" }