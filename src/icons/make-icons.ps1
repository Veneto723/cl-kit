# Generates the arc-notify toast state icons (256px PNG circles):
#   done.png  green + check   |  wait.png  amber + pause  |  fail.png  red + cross
Add-Type -AssemblyName System.Drawing
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

function New-Icon([string]$name, [string]$bg, [scriptblock]$draw) {
  $bmp = New-Object System.Drawing.Bitmap 256, 256
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($bg))
  $g.FillEllipse($brush, 8, 8, 240, 240)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 26
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  & $draw $g $pen
  $out = Join-Path $dir "$name.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "wrote $out"
}

New-Icon 'done' '#22A55B' { param($g, $p)
  $pts = [System.Drawing.Point[]]@(
    (New-Object System.Drawing.Point 70, 132),
    (New-Object System.Drawing.Point 112, 176),
    (New-Object System.Drawing.Point 190, 86))
  $g.DrawLines($p, $pts)
}
New-Icon 'wait' '#E8A317' { param($g, $p)
  $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.FillRectangle($b, 88, 78, 30, 100)
  $g.FillRectangle($b, 140, 78, 30, 100)
}
New-Icon 'fail' '#DC3B45' { param($g, $p)
  $g.DrawLine($p, 88, 88, 168, 168)
  $g.DrawLine($p, 168, 88, 88, 168)
}
