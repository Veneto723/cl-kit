# cl-kit installer (Windows 11). Deploys the cl account switcher into ~/.claude
# and ~/.local/bin, wires hooks + statusline into settings.json (merging, never
# clobbering), registers the cl-focus: toast-click protocol, and generates icons.
# Re-runnable: existing files are overwritten from the kit, user settings merged.
$ErrorActionPreference = 'Stop'
$kit = Split-Path -Parent $MyInvocation.MyCommand.Path
$claudeDir = Join-Path $env:USERPROFILE '.claude'
$scripts = Join-Path $claudeDir 'scripts'
$commands = Join-Path $claudeDir 'commands'
$bin = Join-Path $env:USERPROFILE '.local\bin'

Write-Host "cl-kit installer" -ForegroundColor Cyan
node --version *> $null
if ($LASTEXITCODE -ne 0) { throw 'Node.js is required on PATH.' }

# 1. scripts
New-Item -ItemType Directory -Force $scripts, $commands, $bin, (Join-Path $scripts 'icons') | Out-Null
Copy-Item (Join-Path $kit 'src\*.js') $scripts -Force
Copy-Item (Join-Path $kit 'src\cl-focus.ps1') $scripts -Force
Copy-Item (Join-Path $kit 'src\cl-focus.vbs') $scripts -Force
Copy-Item (Join-Path $kit 'src\icons\make-icons.ps1') (Join-Path $scripts 'icons') -Force
Write-Host "  scripts -> $scripts"

# pool tooling (only used if cl-config has poolDb; harmless otherwise)
Copy-Item (Join-Path $kit 'pool\pool-query.js') $scripts -Force
Copy-Item (Join-Path $kit 'pool\pool-status.js') $scripts -Force
Copy-Item (Join-Path $kit 'pool\pool-neon-url.js') $scripts -Force
$mcpDest = Join-Path $scripts 'pool-mcp'
New-Item -ItemType Directory -Force $mcpDest | Out-Null
Copy-Item (Join-Path $kit 'pool\pool-mcp\server.js') $mcpDest -Force
Copy-Item (Join-Path $kit 'pool\pool-mcp\package.json') $mcpDest -Force

# 2. bin shim
Set-Content (Join-Path $bin 'cl.cmd') "@echo off`r`nnode `"%USERPROFILE%\.claude\scripts\cl-runner.js`" %*" -Encoding ascii
Write-Host "  cl.cmd  -> $bin (ensure it's on PATH)"

# 3. slash commands
Copy-Item (Join-Path $kit 'commands\*.md') $commands -Force
Write-Host "  commands -> $commands (/switch /restart /pool)"

# 4. toast icons
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'icons\make-icons.ps1') | Out-Null
Write-Host "  toast icons generated"

# 5. cl-focus: protocol (toast click -> focus the session's window)
$root = 'HKCU:\Software\Classes\cl-focus'
New-Item -Path $root -Force | Out-Null
Set-ItemProperty -Path $root -Name '(Default)' -Value 'URL:cl-focus Protocol'
Set-ItemProperty -Path $root -Name 'URL Protocol' -Value ''
New-Item -Path "$root\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$root\shell\open\command" -Name '(Default)' -Value ("wscript.exe //B //NoLogo `"$scripts\cl-focus.vbs`" `"%1`"")
Write-Host "  cl-focus: protocol registered (HKCU)"

# 6. enable toast banners for the PowerShell AppID (Win11 leaves it tray-only)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$nk = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\$appId"
New-Item -Path $nk -Force | Out-Null
Set-ItemProperty -Path $nk -Name 'Enabled' -Value 1 -Type DWord
Set-ItemProperty -Path $nk -Name 'ShowBanner' -Value 1 -Type DWord
Set-ItemProperty -Path $nk -Name 'ShowInActionCenter' -Value 1 -Type DWord
Write-Host "  toast banners enabled for the PowerShell AppID"

# 7. settings.json: merge hooks + statusline (never remove existing entries)
$settingsPath = Join-Path $claudeDir 'settings.json'
$settings = @{}
if (Test-Path $settingsPath) {
  Copy-Item $settingsPath "$settingsPath.bak-cl-kit" -Force
  $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
}
function Ensure-Hook($obj, [string]$event, [string]$command) {
  if (-not $obj.hooks) { $obj | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) -Force }
  $hooks = $obj.hooks
  $existing = $hooks.PSObject.Properties[$event]
  $frag = ($command -split '"')[1]  # match on the script path
  if ($existing -and (($existing.Value | ConvertTo-Json -Depth 10) -like "*$($frag -replace '\\','\\')*")) { return }
  $entry = [pscustomobject]@{ hooks = @([pscustomobject]@{ type = 'command'; command = $command }) }
  if ($existing) {
    # append our command into the first matcher group
    $existing.Value[0].hooks += [pscustomobject]@{ type = 'command'; command = $command }
  } else {
    $hooks | Add-Member -NotePropertyName $event -NotePropertyValue @($entry) -Force
  }
}
$node = 'node'
Ensure-Hook $settings 'UserPromptSubmit' "$node `"$($scripts -replace '\\','/')/cl-notify.js`" start"
Ensure-Hook $settings 'Stop' "$node `"$($scripts -replace '\\','/')/cl-notify.js`" done"
Ensure-Hook $settings 'Stop' "$node `"$($scripts -replace '\\','/')/cl-flag-retry.js`""
Ensure-Hook $settings 'StopFailure' "$node `"$($scripts -replace '\\','/')/cl-notify.js`" fail"
Ensure-Hook $settings 'Notification' "$node `"$($scripts -replace '\\','/')/cl-notify.js`" wait"
if (-not $settings.statusLine) {
  $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue ([pscustomobject]@{
    type = 'command'; command = "node `"$scripts\usage-monitor.js`" --compact"
  }) -Force
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding utf8
Write-Host "  settings.json hooks + statusline wired (backup at settings.json.bak-cl-kit)"

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  cl setup    # choose your account style (single / two subs / sub+pool / pool only)"
Write-Host "  cl doctor   # verify"
Write-Host "  cl          # launch"
