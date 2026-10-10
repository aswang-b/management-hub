# Runs the hub in the background on Windows: a task starts it hidden each
# time you sign in. The window itself is the page installed as an app from
# Chrome (install opens it in Chrome for that). Used by `npm run app:install`,
# `app:restart`, `app:stop`, `app:status` and `app:uninstall`, and by the
# Install/Uninstall .cmd files in the hub folder.
param([Parameter(Mandatory)][ValidateSet("install", "restart", "stop", "status", "uninstall")][string]$Command)

$ErrorActionPreference = "Stop"
$TaskName = "Management Hub"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

# The port comes from HUB_PORT in .env, like the server itself.
$Port = 8787
if (Test-Path ".env") {
  $line = Get-Content ".env" | Where-Object { $_ -match '^\s*HUB_PORT\s*=\s*"?(\d+)' } | Select-Object -Last 1
  if ($line -match '(\d+)') { $Port = [int]$Matches[1] }
}
$Url = "http://localhost:$Port"

# Chrome puts the shortcut of an app installed from it here.
$Programs = [Environment]::GetFolderPath("Programs")
$ChromeAppShortcut = Join-Path $Programs "Chrome Apps\Management Hub.lnk"
# Shortcuts made by an earlier version of this script; removed when found.
$OldShortcuts = @(
  (Join-Path $Programs "Management Hub.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "Management Hub.lnk")
)

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

function Test-Running {
  try { Invoke-WebRequest "$Url/api/projects" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

# Stops whatever node process holds the hub's port (the task, or an `npm start`
# left running), so the port is free for a fresh start.
function Stop-Hub {
  if (Get-Task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($id in $owners) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq "node") { taskkill /PID $id /T /F | Out-Null }
    elseif ($p) { throw "Port $Port is used by another program ($($p.ProcessName)). Close it or set HUB_PORT in .env." }
  }
}

function Build-Page {
  Write-Host "Building the page..."
  npm run build --silent
  if ($LASTEXITCODE -ne 0) { throw "The page didn't build. Run 'npm run build' to see why." }
}

function Start-Hub {
  Start-ScheduledTask -TaskName $TaskName
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Running) { Write-Host "The hub is running at $Url"; return }
  }
  throw "The hub didn't start. See data\hub.log for the reason."
}

function Find-Chrome {
  @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}

switch ($Command) {
  "install" {
    Build-Page
    $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless `"$Root\scripts\run-hidden.cmd`"" -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
      -Description "Runs the Management Hub ($Root) in the background." -Force | Out-Null
    $OldShortcuts | Where-Object { Test-Path $_ } | Remove-Item
    Write-Host "Installed: the hub now starts by itself when you sign in to Windows."
    Stop-Hub
    Start-Hub
    if (Test-Path $ChromeAppShortcut) {
      Write-Host "Open it from 'Management Hub' in the Start menu."
    } elseif ($chrome = Find-Chrome) {
      Write-Host ""
      Write-Host "Last step: in the Chrome window that just opened, click the install icon"
      Write-Host "at the right of the address bar (or menu > Cast, save and share > Install page"
      Write-Host "as app). Management Hub then gets its own window, Start menu entry and"
      Write-Host "taskbar icon."
      Start-Process $chrome -ArgumentList $Url
    } else {
      Write-Host "To get the hub's own window, install Google Chrome, open $Url in it and click"
      Write-Host "the install icon at the right of the address bar. Until then, open $Url in any browser."
    }
  }
  "restart" {
    if (-not (Get-Task)) { throw "The background app isn't installed. Run 'npm run app:install' first." }
    Build-Page
    Stop-Hub
    Start-Hub
  }
  "stop" {
    Stop-Hub
    Write-Host "Stopped. It starts again next time you sign in (or run 'npm run app:restart')."
  }
  "status" {
    if (Get-Task) { Write-Host "Background app: installed" } else { Write-Host "Background app: not installed" }
    if (Test-Running) { Write-Host "Hub: running at $Url" } else { Write-Host "Hub: not running" }
    if (Test-Path $ChromeAppShortcut) { Write-Host "Window: installed from Chrome" } else { Write-Host "Window: not installed" }
  }
  "uninstall" {
    Stop-Hub
    if (Get-Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    $OldShortcuts | Where-Object { Test-Path $_ } | Remove-Item
    Write-Host "Removed: the hub no longer starts by itself."
    Write-Host "Your projects and tokens are kept (data\hub.db and .env). 'npm start' still works."
    if (Test-Path $ChromeAppShortcut) {
      Write-Host "To remove its window too, right-click 'Management Hub' in the Start menu and choose Uninstall."
    }
  }
}
