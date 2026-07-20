# arc installer (Windows). Deploys the arc account switcher into ~/.claude
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
# The birth template MUST land beside arc-invite.js — birthTemplate() resolves it via __dirname, so a
# missing copy here is a launcher that opens no tab at all.
Copy-Item (Join-Path $kit 'src\arc-birth.ps1') $scripts -Force
# The operator widget (`arc operator`) — arc-runner spawns it via __dirname, so it must land here too.
Copy-Item (Join-Path $kit 'src\arc-operator.ps1') $scripts -Force
Copy-Item (Join-Path $kit 'src\icons\make-icons.ps1') (Join-Path $scripts 'icons') -Force
Write-Host "  scripts -> $scripts"

# Stamp the deployed version so the runner knows what it is at launch (package.json is deliberately
# NOT copied to $scripts — one marker, read by arc-update.installedVersion). This is what makes the
# launch-time "a newer release is available" check possible on a machine that only RUNS arc.
$pkgVer = (Get-Content (Join-Path $kit 'package.json') -Raw | ConvertFrom-Json).version
$marker = @{ version = $pkgVer; installedAt = (Get-Date).ToString('o'); source = $kit } | ConvertTo-Json -Compress
# WriteAllText, not Set-Content -Encoding UTF8: Windows PowerShell 5.1 prepends a UTF-8 BOM, and
# JSON.parse chokes on it — the runner would read version 0.0.0 and offer a phantom "upgrade".
[System.IO.File]::WriteAllText((Join-Path $scripts 'arc-version.json'), $marker)
Write-Host "  version -> arc v$pkgVer"

# arc MCP server (account management tools)
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
  Write-Host "  arc MCP server installed + registered (account_* / config_update tools)"
} else {
  Write-Host "  arc MCP server installed (register later: claude mcp add --scope user arc node `"$mcpDest\server.js`")"
}

# 2. bin shims + PATH — THREE of them, and every one is load-bearing.
#    arc.cmd covers cmd.exe. It used to be described as covering PowerShell too, and that belief
#    silently corrupted every note a peer ever posted — see arc.ps1 below.
#    Bash does NOT do PATHEXT: it looks for a file literally named `arc`, so with only the .cmd
#    every `arc role` / `arc notes` / `arc await` died with 127 inside Claude Code's Bash tool —
#    which is exactly where the `peers` skill tells agents to run them. The bin dir was on PATH
#    the whole time; the NAME just wasn't resolvable. An extensionless shim fixes that, and it
#    cannot shadow the .cmd for PowerShell/cmd, since neither will execute an extensionless file.
$runnerCmd = "@echo off`r`nnode `"%USERPROFILE%\.claude\scripts\arc-runner.js`" %*"
Set-Content (Join-Path $bin 'arc.cmd') $runnerCmd -Encoding ascii
# LF endings + no BOM: a CRLF shebang makes sh fail with a bare "not found" that names the
# interpreter, not the file — one of the more confusing ways to lose an afternoon.
# $USERPROFILE not $HOME: node.exe is a Windows binary and cannot read a /c/Users/... MSYS path.
$runnerSh = "#!/bin/sh`nexec node `"`$USERPROFILE/.claude/scripts/arc-runner.js`" `"`$@`"`n"
[IO.File]::WriteAllText((Join-Path $bin 'arc'), $runnerSh, (New-Object Text.UTF8Encoding $false))

# arc.ps1 — PowerShell prefers it over arc.cmd for a bare `arc`, and that is a SECURITY fix.
#
# cmd.exe parses a batch file's command line BEFORE %* forwards anything, and mangles every
# argument three ways, all silent, all exit 0:
#   1. TRUNCATES at the first newline  — a batch command line is one line. A peer's multi-line
#      answer arrived as its FIRST LINE and the ✓ looked normal. (Board note #22: 91 chars.)
#   2. STRIPS double quotes.
#   3. EXPANDS %VAR%  — THE LEAK. A note that merely NAMES an env var stored its VALUE into
#      .arc/peer/notes.jsonl, a durable file that is then injected into other peers' contexts.
#      Proven with a fake secret: a body saying %ARC_FAKE_SECRET% stored as sk-ant-FAKE-...
#      An agent discussing config is the likeliest thing on earth to name an env var.
#      Gitignored is not the same as safe.
#
# WHY IT WENT UNNOTICED FOR SO LONG: the POSIX shim above is immune, and a session with the Bash
# tool uses it. But a STAFFED PEER may have only PowerShell (the first one reported "No such tool
# available: Bash"), so it went through arc.cmd — meaning every session that exists to ANSWER has
# been posting through the mangler, and the asker could not tell. Found by the research peer,
# which caught its OWN notes arriving corrupted and verified what STORED rather than trusting the
# checkmark.
#
# Measured, not assumed: with arc.ps1 on PATH, `arc` resolves to it, and on pwsh 7 (what the
# agent's PowerShell tool runs) newlines, quotes and literal %VAR% ALL survive. On Windows
# PowerShell 5.1 quotes are still dropped — its native-argument passing predates the fix — but
# the newline truncation and the leak are gone on both.
# ExecutionPolicy: a locally-written .ps1 runs under RemoteSigned (this machine's LocalMachine
# scope), verified before shipping. arc.cmd stays for cmd.exe and as the fallback.
$runnerPs1 = "node `"`$env:USERPROFILE\.claude\scripts\arc-runner.js`" @args`r`n"
Set-Content (Join-Path $bin 'arc.ps1') $runnerPs1 -Encoding utf8
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User')
  Write-Host "  arc.cmd + arc  -> $bin  (added to your user PATH — open a NEW terminal to use 'arc')" -ForegroundColor Yellow
} else {
  Write-Host "  arc.cmd  -> $bin  (already on PATH)"
  Write-Host "  arc      -> $bin  (POSIX shim, so 'arc' also works in Git Bash / the agent's Bash tool)"
}

# 3. every arc action is caught by the UserPromptSubmit hook at zero model tokens, in
#    ONE spelling (src/arc-slash.js): /arc-<verb>, whose / menu autocomplete comes
#    from the skill stubs copied below. Claude Code hands the hook the RAW typed
#    /command before any skill expansion, so it stays classifier-immune and
#    rate-limit-proof — these never reach a model.

# 3b. core agent skills — capabilities any agent can discover + invoke.
$skills = Join-Path $claudeDir 'skills'
New-Item -ItemType Directory -Force $skills | Out-Null
Copy-Item (Join-Path $kit 'skills\*') $skills -Recurse -Force
Write-Host "  Claude skills -> $skills"

# The peer protocol is runtime-neutral and uses arc's terminal commands, so
# publish it at the cross-agent discovery path as well.
$agentSkills = Join-Path $env:USERPROFILE '.agents\skills'
$peerSkill = Join-Path $agentSkills 'peers'
New-Item -ItemType Directory -Force $peerSkill | Out-Null
Copy-Item (Join-Path $kit 'skills\peers\*') $peerSkill -Recurse -Force
Write-Host "  shared skill -> $peerSkill"
# `peers` supersedes the earlier names: share-with-roommate + fridge-responder (two halves of
# one protocol) were merged into `roommates`, which the board/peer/claim rename made `peers`.
# Sweep ALL the historical names — a stale copy keeps matching and teaching the old vocabulary.
# (NB these are literal past names, NOT subject to the room->board rename.)
foreach ($stale in @('share-with-roommate', 'fridge-responder', 'roommates')) {
  foreach ($root in @($agentSkills, (Join-Path $env:USERPROFILE '.claude\skills'))) {
    $p = Join-Path $root $stale
    if (Test-Path $p) { Remove-Item -Recurse -Force $p; Write-Host "  removed superseded skill -> $p" -ForegroundColor DarkGray }
  }
}
# The /arc-* slash stubs are GENERATED from src/arc-slash.js and ride the copy above —
# but a copy only ever ADDS. When a verb is removed or renamed, its stale stub would
# keep advertising a /command the hook no longer matches, and (for the first time) its
# fallback BODY would actually load and teach a dead verb. Sweep deployed arc-* stubs
# the kit no longer ships. Deliberately narrow: only ~/.claude/skills, only arc-* names,
# only when the kit lacks them; junctions are skipped (not ours — the copy deploys real
# directories, and deleting through a user's junction would reach a foreign tree).
Get-ChildItem -Path $skills -Directory -Filter 'arc-*' -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
  if (-not (Test-Path (Join-Path $kit "skills\$($_.Name)"))) {
    Remove-Item -Recurse -Force $_.FullName
    Write-Host "  removed stale /arc stub -> $($_.FullName)" -ForegroundColor DarkGray
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

# 7. settings.json: hooks + permissions + statusline — DELEGATED to arc-wire-settings.js.
#    This used to be a second, hand-maintained copy of the wiring in PowerShell, and it drifted
#    the moment the node side grew something the PS side did not know about (a PreToolUse hook
#    needs a `matcher`, or it spawns node on EVERY tool call). One source of truth instead: the
#    installer runs the same merge the rest of arc uses. It backs up settings.json, merges
#    idempotently, and never removes a user's own entries.
node "$($scripts -replace '\\','/')/arc-wire-settings.js" "$scripts"
if ($LASTEXITCODE -ne 0) { throw 'settings.json wiring failed — nothing was changed.' }
#   (arc-wire-settings writes UTF-8 WITHOUT a BOM: Node's JSON.parse rejects a BOM'd settings.json.)
# (No Bash allow-rule: switching/restart use the zero-token /arc-switch /
# /arc-restart commands, caught by the UserPromptSubmit hook: no !-bash, no
# classifier. The OLD /switch /restart slash commands were !-bash-backed and
# needed the allow-rule; the NEW /arc-* commands are hook-eaten before any model
# runs, so the deadlock they were removed for cannot recur. arc-wire-settings
# also writes skillOverrides ("user-invocable-only") for every /arc-* stub, so
# the / menu shows them while the model's skill listing never pays for them.)

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  arc setup    # choose your account style (single / two subs / sub+gateway / gateway only)"
Write-Host "  arc doctor   # verify"
Write-Host "  arc          # launch"
