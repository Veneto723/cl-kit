# arc-operator.ps1 — a docked, always-on-top DESKTOP widget for the arc operator feed.
#
# WPF via PowerShell — BOTH built into Windows: no toolchain, no npm/Rust, no third-party app (the
# doctrine-clean "face" the roadmap named as the Tauri alternative — same class as arc-focus.ps1). It
# polls the feed's /status (loopback, Host-guarded) every ~1.5s and renders the operator view as an
# INSTRUMENT PANEL: live roles as status chips, the who-waits-on-whom graph as a two-column readout
# (unseen asks in red, with a left severity stripe on the card), and recent replies. Drag by the
# header; the — minimizes to the taskbar, the ✕ closes.
# Launch STA + hidden console:  powershell.exe -STA -WindowStyle Hidden -File arc-operator.ps1
param([int]$Port = 8791, [int]$IntervalMs = 1500)

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$ErrorActionPreference = 'Stop'
$statusUrl = "http://127.0.0.1:$Port/status"

# Single-instance: if a widget is already up, this launch bows out instead of stacking a second
# window (or leaving a stray). A holder that crashed abandons the mutex, and WaitOne then throws
# AbandonedMutexException while STILL granting ownership — so the next launch reclaims it cleanly.
# Held (via script scope so the GC can't collect it) for the process lifetime; exit releases it.
$script:singleton = New-Object System.Threading.Mutex($false, 'Local\arc-operator-widget')
try { $ownsSingleton = $script:singleton.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $ownsSingleton = $true }
if (-not $ownsSingleton) { exit 0 }

function Esc([string]$s) {
  if ($null -eq $s) { return '' }
  $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&#39;')
}
function Ago($ts) {
  if (-not $ts) { return '' }
  try { $t = [datetime]::Parse($ts).ToUniversalTime() } catch { return '' }
  $s = ([datetime]::UtcNow - $t).TotalSeconds; if ($s -lt 0) { $s = 0 }
  if ($s -lt 60) { return ('{0}s' -f [int]$s) }
  if ($s -lt 3600) { return ('{0}m' -f [int]($s / 60)) }
  return ('{0}h' -f [int]($s / 3600))
}

# ---- window shell (XAML). Borderless + transparent so the rounded panel casts a soft shadow. ----
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="arc operator" Width="430" Height="648" WindowStyle="None"
        AllowsTransparency="True" Background="Transparent" Topmost="True"
        ShowInTaskbar="True" FontFamily="Segoe UI" ResizeMode="NoResize"
        TextOptions.TextFormattingMode="Ideal" TextOptions.TextRenderingMode="ClearType">
  <Window.Resources>
    <!-- A thin, arrow-less, dark scrollbar. The default WPF ScrollBar is the chunky Win32 gray one
         with up/down buttons and a raised track — it fights the flat dark panel. This retemplates it
         to a slim rounded thumb over a transparent track (implicit style, so the ScrollViewer's own
         bar picks it up), brightening on hover and turning accent-blue while dragging. -->
    <Style x:Key="ScrollNub" TargetType="RepeatButton">
      <Setter Property="OverridesDefaultStyle" Value="True"/>
      <Setter Property="Focusable" Value="False"/>
      <Setter Property="IsTabStop" Value="False"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="RepeatButton"><Border Background="Transparent"/></ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="ScrollThumb" TargetType="Thumb">
      <Setter Property="OverridesDefaultStyle" Value="True"/>
      <Setter Property="IsTabStop" Value="False"/>
      <Setter Property="MinHeight" Value="30"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Thumb">
            <Border x:Name="Nub" CornerRadius="4" Background="#2C3B4B" Margin="3,1,3,1"/>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Nub" Property="Background" Value="#425468"/></Trigger>
              <Trigger Property="IsDragging" Value="True"><Setter TargetName="Nub" Property="Background" Value="#5AA3FF"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="ScrollBar">
      <Setter Property="OverridesDefaultStyle" Value="True"/>
      <Setter Property="Width" Value="11"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Grid Background="Transparent">
              <Track x:Name="PART_Track" IsDirectionReversed="True">
                <Track.Thumb><Thumb Style="{StaticResource ScrollThumb}"/></Track.Thumb>
                <Track.IncreaseRepeatButton><RepeatButton Style="{StaticResource ScrollNub}" Command="ScrollBar.PageDownCommand"/></Track.IncreaseRepeatButton>
                <Track.DecreaseRepeatButton><RepeatButton Style="{StaticResource ScrollNub}" Command="ScrollBar.PageUpCommand"/></Track.DecreaseRepeatButton>
              </Track>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <!-- flat header buttons (minimize / close). The stock WPF Button hover is a light-blue Aero
         chrome that fights the dark panel; this gives a rounded dark hover + a brighter glyph. -->
    <Style x:Key="HdrBtn" TargetType="Button">
      <Setter Property="Width" Value="26"/>
      <Setter Property="Height" Value="24"/>
      <Setter Property="Foreground" Value="#8595A6"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="VerticalAlignment" Value="Top"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bg" Background="{TemplateBinding Background}" CornerRadius="6">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="bg" Property="Background" Value="#212D3A"/><Setter Property="Foreground" Value="#EAF0F7"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="HdrClose" TargetType="Button" BasedOn="{StaticResource HdrBtn}">
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bg" Background="{TemplateBinding Background}" CornerRadius="6">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="bg" Property="Background" Value="#7A2B27"/><Setter Property="Foreground" Value="#FFE9E7"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Border Margin="14" Background="#F50A0E15" CornerRadius="14" BorderBrush="#26323F" BorderThickness="1">
    <Border.Effect><DropShadowEffect BlurRadius="28" ShadowDepth="0" Opacity="0.5" Color="#000000"/></Border.Effect>
    <DockPanel>
      <Border x:Name="Header" DockPanel.Dock="Top" Background="#0E1420" CornerRadius="13,13,0,0" Padding="17,13,10,13" BorderBrush="#1B2532" BorderThickness="0,0,0,1">
        <StackPanel>
          <DockPanel>
            <Ellipse x:Name="Dot" DockPanel.Dock="Left" Width="9" Height="9" Fill="#46C168" VerticalAlignment="Center" Margin="0,0,11,0">
              <Ellipse.Effect><DropShadowEffect BlurRadius="10" ShadowDepth="0" Color="#46C168" Opacity="0.95"/></Ellipse.Effect>
            </Ellipse>
            <Button x:Name="CloseBtn" Style="{StaticResource HdrClose}" DockPanel.Dock="Right" Content="✕"/>
            <Button x:Name="MinBtn" Style="{StaticResource HdrBtn}" DockPanel.Dock="Right" Content="&#x2013;" FontSize="15" Margin="0,0,3,0"/>
            <TextBlock FontFamily="Segoe UI Variable Display, Segoe UI Semibold, Segoe UI" FontSize="15" VerticalAlignment="Center"><Run Text="arc" FontWeight="Bold" Foreground="#EAF0F7"/><Run Text="  operator" FontWeight="SemiBold" Foreground="#5AA3FF"/></TextBlock>
          </DockPanel>
          <TextBlock x:Name="Meta" FontFamily="Segoe UI" FontSize="11.5" Foreground="#93A2B4" Margin="20,5,0,0" Text="connecting&#x2026;" TextTrimming="CharacterEllipsis"/>
        </StackPanel>
      </Border>
      <ScrollViewer VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" Padding="0">
        <StackPanel x:Name="Cards" Margin="12,11,12,13"/>
      </ScrollViewer>
    </DockPanel>
  </Border>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Parse($xaml)
$Header = $win.FindName('Header'); $Cards = $win.FindName('Cards')
$Meta = $win.FindName('Meta'); $Dot = $win.FindName('Dot'); $CloseBtn = $win.FindName('CloseBtn'); $MinBtn = $win.FindName('MinBtn')
$bc = New-Object System.Windows.Media.BrushConverter
function B([string]$hex) { $bc.ConvertFromString($hex) }
function Run2([string]$text, [string]$hex) { $r = New-Object System.Windows.Documents.Run($text); $r.Foreground = B $hex; $r }

$Header.Add_MouseLeftButtonDown({ try { $win.DragMove() } catch {} })
$CloseBtn.Add_Click({ $win.Close() })
$MinBtn.Add_Click({ $win.WindowState = [System.Windows.WindowState]::Minimized })
$wa = [System.Windows.SystemParameters]::WorkArea
$win.Left = $wa.Right - $win.Width - 8; $win.Top = $wa.Top + 34

# ---- one repo card, built from a XAML fragment (single-quoted attrs so PS interpolation is clean;
#      Esc() strips & < > " ' from every board field, so nothing can break the markup). Every id,
#      age and role->role edge is set in Cascadia Mono/Consolas so the columns line up like a readout.
$MONO = "Cascadia Mono, Consolas"
function Card($repo) {
  # live-role status chips: a glowing green pip + role (text) + pid (mono, dim)
  $chips = ''
  foreach ($r in @($repo.roles)) {
    $chips += "<Border Background='#16202E' BorderBrush='#243040' BorderThickness='1' CornerRadius='7' Padding='9,3,11,4' Margin='0,0,7,7'><StackPanel Orientation='Horizontal'><Ellipse Width='6' Height='6' Fill='#46C168' VerticalAlignment='Center' Margin='0,0,8,0'><Ellipse.Effect><DropShadowEffect BlurRadius='6' ShadowDepth='0' Color='#46C168' Opacity='0.85'/></Ellipse.Effect></Ellipse><TextBlock VerticalAlignment='Center'><Run Text='$(Esc $r.role)' FontFamily='Segoe UI' FontSize='12' Foreground='#DCE4EC'/><Run Text='  $(Esc ([string]$r.pid))' FontFamily='$MONO' FontSize='11' Foreground='#5F7185'/></TextBlock></StackPanel></Border>"
  }
  if (-not $chips) { $chips = "<TextBlock FontFamily='Segoe UI' FontSize='12' FontStyle='Italic' Foreground='#5F7185' Text='no live roles'/>" }

  # waiting rows: from -> to on the left, #seq · age right-aligned; a status pip marks unseen in red
  $waiting = ''
  foreach ($w in @($repo.waiting)) {
    $toColor = if ($w.seen) { '#E0A13A' } else { '#F2564C' }
    $pip     = if ($w.seen) { '#38485A' } else { '#F2564C' }
    $waiting += "<Grid Margin='0,0,0,6'><Grid.ColumnDefinitions><ColumnDefinition Width='*'/><ColumnDefinition Width='Auto'/></Grid.ColumnDefinitions><StackPanel Grid.Column='0' Orientation='Horizontal'><Ellipse Width='5' Height='5' Fill='$pip' VerticalAlignment='Center' Margin='0,0,9,0'/><TextBlock FontFamily='$MONO' FontSize='12.5'><Run Text='$(Esc $w.from)' Foreground='#5AA3FF'/><Run Text='  &#x2192;  ' Foreground='#54657A'/><Run Text='$(Esc $w.to)' Foreground='$toColor'/></TextBlock></StackPanel><TextBlock Grid.Column='1' VerticalAlignment='Center' Margin='10,0,0,0' FontFamily='$MONO' FontSize='11' Foreground='#5F7185' Text='#$($w.seq)  &#183;  $(Ago $w.ts)'/></Grid>"
  }
  if (-not $waiting) { $waiting = "<TextBlock FontFamily='Segoe UI' FontSize='12' FontStyle='Italic' Foreground='#5F7185' Text='nobody waiting' Margin='0,1,0,2'/>" }

  # reply rows (latest first, cap 6): from <-] to on the left, re #seq right-aligned
  $coop = ''
  $cl = @($repo.cooperation)
  if ($cl.Count -gt 6) { $cl = $cl[($cl.Count - 6)..($cl.Count - 1)] }
  if ($cl.Count -gt 0) { [array]::Reverse($cl) }
  foreach ($c in $cl) {
    if (-not $c) { continue }
    $coop += "<Grid Margin='0,0,0,6'><Grid.ColumnDefinitions><ColumnDefinition Width='*'/><ColumnDefinition Width='Auto'/></Grid.ColumnDefinitions><StackPanel Grid.Column='0' Orientation='Horizontal'><Ellipse Width='5' Height='5' Fill='#38485A' VerticalAlignment='Center' Margin='0,0,9,0'/><TextBlock FontFamily='$MONO' FontSize='12.5'><Run Text='$(Esc $c.from)' Foreground='#46C168'/><Run Text='  &#x21A9;  ' Foreground='#54657A'/><Run Text='$(Esc $c.to)' Foreground='#E0A13A'/></TextBlock></StackPanel><TextBlock Grid.Column='1' VerticalAlignment='Center' Margin='10,0,0,0' FontFamily='$MONO' FontSize='11' Foreground='#5F7185' Text='re #$($c.reSeq)'/></Grid>"
  }
  if (-not $coop) { $coop = "<TextBlock FontFamily='Segoe UI' FontSize='12' FontStyle='Italic' Foreground='#5F7185' Text='no replies yet' Margin='0,1,0,2'/>" }

  # counts + severity stripe (the stripe appears ONLY when a card holds an unseen ask)
  $wCount = @($repo.waiting).Count
  $uCount = @($repo.waiting | Where-Object { -not $_.seen }).Count
  $cCount = @($repo.cooperation).Count
  $stripe = if ($uCount -gt 0) { '#F2564C' } else { 'Transparent' }
  $splural = if ($repo.sessionCount -eq 1) { '' } else { 's' }

  # eyebrow right-hand counts (dim total; unseen count in red)
  $wRight = "<Run Text='$wCount' Foreground='#8595A6'/>"
  if ($uCount -gt 0) { $wRight += "<Run Text='   $uCount new' Foreground='#F2564C'/>" }
  $cRight = "<Run Text='$cCount' Foreground='#8595A6'/>"

  $cardXaml = "<Border xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' Background='#121926' BorderBrush='#243040' BorderThickness='1' CornerRadius='11' Margin='0,0,0,11'>" +
    "<Grid><Border HorizontalAlignment='Left' Width='3' Background='$stripe' CornerRadius='11,0,0,11'/>" +
    "<StackPanel Margin='16,14,15,15'>" +
      "<TextBlock FontFamily='Segoe UI Variable Display, Segoe UI Semibold, Segoe UI' FontSize='15.5' FontWeight='SemiBold' Foreground='#E6ECF3' Text='$(Esc $repo.name)'/>" +
      "<TextBlock FontFamily='$MONO' FontSize='10.5' Foreground='#5F7185' Margin='0,3,0,0' TextTrimming='CharacterEllipsis' Text='$(Esc $repo.root)'/>" +
      "<WrapPanel Margin='0,13,0,0'>$chips</WrapPanel>" +
      "<TextBlock FontFamily='Segoe UI' FontSize='12' Foreground='#93A2B4' Margin='0,10,0,0'><Run Text='$($repo.sessionCount)' FontFamily='$MONO' Foreground='#C7D2DE'/><Run Text=' session$splural'/><Run Text='      &#183;      ' Foreground='#38485A'/><Run Text='$($repo.board.notes)' FontFamily='$MONO' Foreground='#C7D2DE'/><Run Text=' notes'/></TextBlock>" +
      "<DockPanel Margin='0,17,0,9'><TextBlock DockPanel.Dock='Left' FontFamily='Segoe UI' FontSize='10' FontWeight='SemiBold' Foreground='#6C7C8E' Text='WAITING ON'/><TextBlock DockPanel.Dock='Right' FontFamily='$MONO' FontSize='10'>$wRight</TextBlock><Border Height='1' Background='#1E2836' Margin='12,0,12,1' VerticalAlignment='Center'/></DockPanel>" +
      "<StackPanel>$waiting</StackPanel>" +
      "<DockPanel Margin='0,16,0,9'><TextBlock DockPanel.Dock='Left' FontFamily='Segoe UI' FontSize='10' FontWeight='SemiBold' Foreground='#6C7C8E' Text='RECENT REPLIES'/><TextBlock DockPanel.Dock='Right' FontFamily='$MONO' FontSize='10'>$cRight</TextBlock><Border Height='1' Background='#1E2836' Margin='12,0,12,1' VerticalAlignment='Center'/></DockPanel>" +
      "<StackPanel>$coop</StackPanel>" +
    "</StackPanel></Grid></Border>"
  [Windows.Markup.XamlReader]::Parse($cardXaml)
}

function Update {
  try {
    $data = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 2
    $Dot.Fill = B '#46C168'
    $repos = @($data.repos)
    $sess = 0; $waitAll = 0; $unseen = 0
    foreach ($rp in $repos) { $sess += [int]$rp.sessionCount; foreach ($w in @($rp.waiting)) { $waitAll++; if (-not $w.seen) { $unseen++ } } }
    $rplural = if ($repos.Count -eq 1) { '' } else { 's' }
    $splural = if ($sess -eq 1) { '' } else { 's' }
    $sep = [char]0x2003 + [char]0x00B7 + [char]0x2003   # em-space · em-space
    $Meta.Inlines.Clear()
    $Meta.Inlines.Add((Run2 "$($data.host)$sep$($repos.Count) repo$rplural$sep$sess session$splural$sep$waitAll waiting" '#93A2B4'))
    if ($unseen -gt 0) {
      $Meta.Inlines.Add((Run2 ('   ' + [char]0x25CF + ' ') '#F2564C'))
      $Meta.Inlines.Add((Run2 "$unseen unseen" '#F2564C'))
    }
    $Cards.Children.Clear()
    if ($repos.Count -eq 0) {
      $tb = New-Object System.Windows.Controls.TextBlock
      $tb.Text = 'no live arc sessions'; $tb.Foreground = B '#5F7185'; $tb.FontStyle = 'Italic'; $tb.Margin = '5,12,0,0'
      [void]$Cards.Children.Add($tb)
    } else { foreach ($rp in $repos) { [void]$Cards.Children.Add((Card $rp)) } }
  } catch {
    $Dot.Fill = B '#E0A13A'
    $Meta.Inlines.Clear()
    $Meta.Inlines.Add((Run2 'feed offline' '#E0A13A'))
    $Meta.Inlines.Add((Run2 '   —   start it:  ' '#5F7185'))
    $Meta.Inlines.Add((Run2 'arc feed' '#C7D2DE'))
  }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds($IntervalMs)
$timer.Add_Tick({ Update })
# Show the window FIRST, then fetch. The first poll is a synchronous HTTP call (up to 2s); running it
# before ShowDialog could delay — or with a hung socket, indefinitely stall — the window ever
# appearing, which showed up as a rare windowless launch (alive process, no visible window).
# ContentRendered fires once the window is actually on screen, so the panel is always up before we poll.
$win.Add_ContentRendered({ Update })
$timer.Start()
[void]$win.ShowDialog()
