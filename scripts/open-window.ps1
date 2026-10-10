# What the "Management Hub" Start menu and desktop shortcuts run: starts the
# hub if it isn't running, then opens it in its own window (no tabs or
# address bar) using Chrome, or Edge if Chrome isn't installed.
$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

$Port = 8787
if (Test-Path ".env") {
  $line = Get-Content ".env" | Where-Object { $_ -match '^\s*HUB_PORT\s*=\s*"?(\d+)' } | Select-Object -Last 1
  if ($line -match '(\d+)') { $Port = [int]$Matches[1] }
}
$Url = "http://localhost:$Port"

function Test-Running {
  try { Invoke-WebRequest "$Url/api/projects" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (-not (Test-Running)) {
  Start-ScheduledTask -TaskName "Management Hub" -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30 -and -not (Test-Running); $i++) { Start-Sleep -Milliseconds 500 }
}

$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Start-Process $Url; return }

# A separate browser profile just for the hub window, kept outside OneDrive,
# so it opens as its own app and never mixes with your normal browsing.
$profileDir = Join-Path $env:LOCALAPPDATA "Management Hub\window"
Start-Process $browser -ArgumentList "--app=$Url", "--user-data-dir=`"$profileDir`"", "--no-first-run", "--no-default-browser-check"
