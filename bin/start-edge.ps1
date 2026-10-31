param(
  [string]$Url = 'https://item.upload.taobao.com/sell/v2/publish.htm?catId=150704'
)

$ErrorActionPreference = 'Stop'
$port = 39333
$profile = Join-Path $env:LOCALAPPDATA 'tbupproduct\edge-profile'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'

if (-not (Test-Path -LiteralPath $edge)) {
  throw "Edge executable not found: $edge"
}

try {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 2
  if ($response.StatusCode -eq 200) {
    Write-Host "Dedicated Edge is already running on port $port"
    exit 0
  }
} catch {
  # Browser is not running yet.
}

New-Item -ItemType Directory -Force -Path $profile | Out-Null
$arguments = @(
  "--remote-debugging-port=$port",
  '--remote-debugging-address=127.0.0.1',
  "--user-data-dir=$profile",
  '--no-first-run',
  '--start-maximized',
  $Url
)
Start-Process -FilePath $edge -ArgumentList $arguments | Out-Null
Write-Host 'Dedicated Edge opened. Please sign in to QianNiu in that window on first use.'
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) { exit 0 }
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
throw "Dedicated Edge did not start its debugging port $port"
