# arc installer (Windows 11). Deploys the arc account switcher into ~/.claude
# and ~/.local/bin, wires hooks + statusline into settings.json (merging, never
# clobbering), registers the arc-focus: toast-click protocol, and generates icons.
# Re-runnable: existing files are overwritten from the kit, user settings merged.
$ErrorActionPreference = 'Stop'
$kit = Split-Path -Parent $MyInvocation.MyCommand.Path
$claudeDir = Join-Path $env:USERPROFILE '.claude'
$scripts = Join-Path $claudeDir 'scripts'
$commands = Join-Path $claudeDir 'commands'
$bin = Join-Path $env:USERPROFILE '.local\bin'

Write-Host "arc installer" -ForegroundColor Cyan
node --version *> $null
if ($LASTEXITCODE -ne 0) { throw 'Node.js is required on PATH.' }
$hasClaude = $null -ne (Get-Command claude -ErrorAction SilentlyContinue)
if (-not $hasClaude) {
  Write-Host "  ! 'claude' CLI not found on PATH — install Claude Code first (https://claude.com/claude-code)." -ForegroundColor Yellow
  Write-Host "    Continuing; the arc MCP server registration will be skipped." -ForegroundColor Yellow
}

# 1. scripts
New-Item -ItemType Directory -Force $scripts, $commands, $bin, (Join-Path $scripts 'icons') | Out-Null
Copy-Item (Join-Path $kit 'src\*.js') $scripts -Force
Copy-Item (Join-Path $kit 'src\arc-focus.ps1') $scripts -Force
Copy-Item (Join-Path $kit 'src\arc-focus.vbs') $scripts -Force
Copy-Item (Join-Path $kit 'src\icons\make-icons.ps1') (Join-Path $scripts 'icons') -Force
Write-Host "  scripts -> $scripts"

# pool-DB metrics tooling (feeds the statusline + pool MCP tools when arc-config
# has poolDb; harmless otherwise). No /pool slash command — it wasn't universal.
Copy-Item (Join-Path $kit 'pool\pool-query.js') $scripts -Force
Copy-Item (Join-Path $kit 'pool\pool-neon-url.js') $scripts -Force

# arc MCP server (account management + pool metrics tools)
$mcpDest = Join-Path $scripts 'arc-mcp'
New-Item -ItemType Directory -Force $mcpDest | Out-Null
Copy-Item (Join-Path $kit 'mcp\server.js') $mcpDest -Force
Copy-Item (Join-Path $kit 'mcp\package.json') $mcpDest -Force
if (-not (Test-Path (Join-Path $mcpDest 'node_modules'))) {
  Push-Location $mcpDest
  npm install --silent 2>$null | Out-Null
  Pop-Location
}
# register at user scope (idempotent: remove-then-add) — only if claude is present.
if ($hasClaude) {
  # Native `claude` stderr (e.g. "No MCP server named arc" on a clean first run)
  # becomes a terminating error under $ErrorActionPreference='Stop' in PS 5.1;
  # relax it just around these idempotent calls so remove-then-add is safe.
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  claude mcp remove --scope user arc 2>$null | Out-Null
  claude mcp add --scope user arc node (Join-Path $mcpDest 'server.js') 2>$null | Out-Null
  $ErrorActionPreference = $eap
  Write-Host "  arc MCP server installed + registered (account_* / config_update / pool_* tools)"
} else {
  Write-Host "  arc MCP server installed (register later: claude mcp add --scope user arc node `"$mcpDest\server.js`")"
}

# 2. bin shim + PATH
$runnerCmd = "@echo off`r`nnode `"%USERPROFILE%\.claude\scripts\arc-runner.js`" %*"
Set-Content (Join-Path $bin 'arc.cmd') $runnerCmd -Encoding ascii
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User')
  Write-Host "  arc.cmd  -> $bin  (added to your user PATH — open a NEW terminal to use 'arc')" -ForegroundColor Yellow
} else {
  Write-Host "  arc.cmd  -> $bin  (already on PATH)"
}

# 3. no slash commands — every arc action is a zero-token arc: sentinel (arc:switch,
#    arc:restart, arc:peek, arc:help, …) caught by the UserPromptSubmit hook.

# 3b. core agent skills — capabilities any agent can discover + invoke.
$skills = Join-Path $claudeDir 'skills'
New-Item -ItemType Directory -Force $skills | Out-Null
Copy-Item (Join-Path $kit 'skills\*') $skills -Recurse -Force
Write-Host "  Claude skills -> $skills"

# The roommate protocol is runtime-neutral and uses arc's terminal commands, so
# publish it at the cross-agent discovery path as well.
$agentSkills = Join-Path $env:USERPROFILE '.agents\skills'
$roommateSkill = Join-Path $agentSkills 'roommates'
New-Item -ItemType Directory -Force $roommateSkill | Out-Null
Copy-Item (Join-Path $kit 'skills\roommates\*') $roommateSkill -Recurse -Force
Write-Host "  shared skill -> $roommateSkill"
# `roommates` replaced share-with-roommate + fridge-responder (one protocol, one skill).
# Sweep the superseded pair so a stale copy can't keep matching and teaching the old split.
foreach ($stale in @('share-with-roommate', 'fridge-responder')) {
  foreach ($root in @($agentSkills, (Join-Path $env:USERPROFILE '.claude\skills'))) {
    $p = Join-Path $root $stale
    if (Test-Path $p) { Remove-Item -Recurse -Force $p; Write-Host "  removed superseded skill -> $p" -ForegroundColor DarkGray }
  }
}

# 3c. bundles — first-party add-ons under bundles/<name>/arc-bundle.json, deployed by
#     the data-driven bundle installer (arc-bundle.js) instead of being hardcoded here.
#     Each bundle stays self-contained + independently installable, outside arc core.
$bundlesDir = Join-Path $kit 'bundles'
if (Test-Path $bundlesDir) {
  node (Join-Path $scripts 'arc-bundle.js') install-all $bundlesDir
  Write-Host "  bundles installed from $bundlesDir"
}

# 4. toast icons
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'icons\make-icons.ps1') | Out-Null
Write-Host "  toast icons generated"

# 5. arc-focus: protocol (toast click -> focus the session's window)
$root = 'HKCU:\Software\Classes\arc-focus'
New-Item -Path $root -Force | Out-Null
Set-ItemProperty -Path $root -Name '(Default)' -Value 'URL:arc-focus Protocol'
Set-ItemProperty -Path $root -Name 'URL Protocol' -Value ''
New-Item -Path "$root\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$root\shell\open\command" -Name '(Default)' -Value ("wscript.exe //B //NoLogo `"$scripts\arc-focus.vbs`" `"%1`"")
Write-Host "  arc-focus: protocol registered (HKCU)"

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
  Copy-Item $settingsPath "$settingsPath.bak-arc" -Force
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
# classifier-immune switch fallback FIRST (so `arc:switch` works even rate-limited)
Ensure-Hook $settings 'UserPromptSubmit' "$node `"$($scripts -replace '\\','/')/arc-switch-hook.js`""
Ensure-Hook $settings 'UserPromptSubmit' "$node `"$($scripts -replace '\\','/')/arc-notify.js`" start"
Ensure-Hook $settings 'Stop' "$node `"$($scripts -replace '\\','/')/arc-notify.js`" done"
Ensure-Hook $settings 'StopFailure' "$node `"$($scripts -replace '\\','/')/arc-notify.js`" fail"
Ensure-Hook $settings 'Notification' "$node `"$($scripts -replace '\\','/')/arc-notify.js`" wait"
# the fridge's git-derived "done": baseline HEAD on task creation, diff it on completion.
# Fires in an ordinary session — no agent team, no experimental flag.
Ensure-Hook $settings 'TaskCreated' "$node `"$($scripts -replace '\\','/')/arc-done.js`""
Ensure-Hook $settings 'TaskCompleted' "$node `"$($scripts -replace '\\','/')/arc-done.js`""
if (-not $settings.statusLine) {
  $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue ([pscustomobject]@{
    type = 'command'; command = "node `"$scripts\usage-monitor.js`" --compact"
  }) -Force
}
# (No Bash allow-rule: switching/restart use the zero-token arc:switch / arc:restart
# sentinels caught by the UserPromptSubmit hook — no !-bash, no classifier. The
# old /switch /restart slash commands that needed the allow-rule were removed.)

# Write UTF-8 *without* BOM: PS 5.1's `Set-Content -Encoding utf8` prepends a BOM
# that Node's JSON.parse (used by arc-runner / doctor) rejects as invalid JSON.
[System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  settings.json hooks + statusline wired (backup at settings.json.bak-arc)"

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  arc setup    # choose your account style (single / two subs / sub+pool / pool only)"
Write-Host "  arc doctor   # verify"
Write-Host "  arc          # launch"
