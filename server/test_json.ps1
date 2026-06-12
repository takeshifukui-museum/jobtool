try {
  $raw = Get-Content 'C:\dev\jobtool\server\config\company_overrides.json' -Encoding UTF8 -Raw
  $json = $raw | ConvertFrom-Json
  Write-Host 'JSON OK'
  Write-Host $json.sega.enabled
} catch {
  Write-Host 'ERROR:'
  Write-Host $_.Exception.Message
}