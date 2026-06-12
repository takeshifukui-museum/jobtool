$content = Get-Content 'C:\dev\jobtool\server\config\company_overrides.json' -Encoding UTF8 -Raw
$utf8NoBOM = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText('C:\dev\jobtool\server\config\company_overrides.json', $content, $utf8NoBOM)
Write-Host "done"