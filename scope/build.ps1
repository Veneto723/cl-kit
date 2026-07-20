# build.ps1 - compile arc-scope.exe with the C# compiler that ships INSIDE Windows.
# No .NET SDK, no Rust, no MSBuild project, no NuGet - just csc.exe + the WPF runtime assemblies,
# both present on every Windows 10/11. Produces a single, tiny, self-contained-on-Windows .exe.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fw   = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc  = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc (is .NET Framework 4.x present?)" }

# Reference the WPF runtime assemblies directly (no reference-assemblies pack required).
$refs = @(
  'WPF\PresentationFramework.dll',
  'WPF\PresentationCore.dll',
  'WPF\WindowsBase.dll',
  'System.Xaml.dll',
  'System.dll',
  'System.Core.dll'
) | ForEach-Object { '/reference:' + (Join-Path $fw $_) }

$out = Join-Path $here 'arc-scope.exe'
$src = Join-Path $here 'arc-scope.cs'
$icon = Join-Path $here 'arc-scope.ico'
$iconArg = if (Test-Path $icon) { "/win32icon:$icon" } else { $null }

$cscArgs = @('/nologo', '/target:winexe', '/platform:anycpu', '/codepage:65001', "/out:$out") + $refs
if ($iconArg) { $cscArgs += $iconArg }
$cscArgs += $src

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed (exit $LASTEXITCODE)" }
$kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host "built  ->  $out  ($kb KB)"
