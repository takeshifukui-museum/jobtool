$lines = Get-Content 'C:\dev\jobtool\server\src\index.ts' -Encoding UTF8
$i = 0
foreach ($line in $lines) {
  $i++
  if ($i -ge 1595 -and $i -le 1630) {
    Write-Host "$i : $line"
  }
}