# Runs ONE interleaved round: starts a worker trial in each arm (a0, a, b1),
# then polls until every arm has DECIDED — replied to dispatch, or deferred to
# edge (with a grace window for secondary data) — or the cap hits.
# Exit 0 = all decided; exit 2 = cap hit (score from artifacts anyway).
param([string]$Variant = 'p1', [int]$CapMinutes = 10, [int]$GraceSeconds = 120)

$arms = @('a0','a','b1')
# Pristine fixture SHAs — must match harness.js FIXTURE. Asserted at launch, per round, per arm:
# the one harness fault found so far (unpinned branch pointer) inflates the headline contrast,
# so pristineness is verified mechanically, not assumed (code's #47, reason 2).
$pristine = @{ p1 = @{a0='0a879fb'; a='75e5283'; b1='44794b6'}; p2 = @{a0='05fb9cc'; a='a67eb13'; b1='5692e7f'} }
foreach ($arm in $arms) {
  node E:\arc-ab\harness\harness.js start $arm $Variant
  if ($LASTEXITCODE -ne 0) { Write-Host "START FAILED: $arm"; exit 1 }
  $h = git -C E:\arc-ab\$arm log --format=%h -1
  if ($h -ne $pristine[$Variant][$arm]) { Write-Host "!! $arm HEAD=$h not pristine $($pristine[$Variant][$arm]) — VOID THIS TRIAL"; exit 3 }
  Write-Host "[$arm] pristine at $h"
  Start-Sleep -Seconds 8   # stagger tab launches so wt keeps up
}

$deadline = (Get-Date).AddMinutes($CapMinutes)
$done = @{}; $deferSeen = @{}
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 20
  foreach ($arm in $arms) {
    if ($done[$arm]) { continue }
    $s = node E:\arc-ab\harness\harness.js check $arm | ConvertFrom-Json
    if ($s.replyToDispatch.Count -gt 0) { $done[$arm] = $true; Write-Host "[$arm] replied at $(Get-Date -Format HH:mm:ss)"; continue }
    if ($s.deferNotes.Count -gt 0) {
      if (-not $deferSeen[$arm]) { $deferSeen[$arm] = Get-Date; Write-Host "[$arm] deferred at $(Get-Date -Format HH:mm:ss) — grace ${GraceSeconds}s for secondaries" }
      elseif (((Get-Date) - $deferSeen[$arm]).TotalSeconds -ge $GraceSeconds) { $done[$arm] = $true; Write-Host "[$arm] decided (deferred, grace elapsed)" }
    }
  }
  if ($done.Count -eq 3) { Write-Host 'ROUND DONE: all arms decided'; exit 0 }
}
Write-Host "ROUND CAP at $CapMinutes min — decided: $($done.Keys -join ', ')"
exit 2
