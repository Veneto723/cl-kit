// arc-scope.exe — a docked, always-on-top desktop monitor for the arc operator feed.
//
// A native WPF app on .NET Framework 4.x — which ships INSIDE every Windows 10/11, so this .exe runs
// on any Windows machine with nothing to install (no Rust, no .NET SDK, no WebView2, no PowerShell).
// It is built by the C# compiler that also ships in Windows (Framework64\v4.0.30319\csc.exe) — see
// build.ps1. The whole UI is created from a XAML string via XamlReader.Parse (no XAML compile step).
//
// It is a TWO-LEVEL view of the arc board, polling the feed's /status (loopback) every ~1.5s:
//   OVERVIEW — a card per live git repo; click a card to drill in.
//   DETAIL   — that repo's board: SESSIONS (who is working + on what), COOPERATION (who pairs with
//              whom + recent replies), NOTE FLOW (who transmits to whom; unseen in red), ROADMAP.
//   Any note is click-to-read (its exact body). Back chevron returns to the overview.
//
// Material: Windows 11 acrylic via DWM (DwmSetWindowAttribute) + rounded corners; a docked frosted
// instrument. This is arc's opt-in COMPANION — it lives in the arc repo under scope/, kept out of the
// pure-Node src/ (arc ships the feed; this is one face for it).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace ArcScope {

  // ---- a tiny, dependency-free JSON reader (the feed emits well-formed JSON we control) ----
  static class J {
    public static object Parse(string s) { int i = 0; return Val(s, ref i); }
    static void Ws(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }
    static object Val(string s, ref int i) {
      Ws(s, ref i);
      char c = s[i];
      if (c == '{') return Obj(s, ref i);
      if (c == '[') return Arr(s, ref i);
      if (c == '"') return Str(s, ref i);
      if (c == 't') { i += 4; return true; }
      if (c == 'f') { i += 5; return false; }
      if (c == 'n') { i += 4; return null; }
      return Num(s, ref i);
    }
    static Dictionary<string, object> Obj(string s, ref int i) {
      var d = new Dictionary<string, object>(); i++; Ws(s, ref i);
      if (s[i] == '}') { i++; return d; }
      while (true) {
        Ws(s, ref i); string k = Str(s, ref i); Ws(s, ref i); i++;   // ':'
        d[k] = Val(s, ref i); Ws(s, ref i);
        if (s[i] == ',') { i++; continue; }
        i++; break;                                                   // '}'
      }
      return d;
    }
    static List<object> Arr(string s, ref int i) {
      var a = new List<object>(); i++; Ws(s, ref i);
      if (s[i] == ']') { i++; return a; }
      while (true) {
        a.Add(Val(s, ref i)); Ws(s, ref i);
        if (s[i] == ',') { i++; continue; }
        i++; break;                                                   // ']'
      }
      return a;
    }
    static string Str(string s, ref int i) {
      var sb = new StringBuilder(); i++;
      while (s[i] != '"') {
        char c = s[i++];
        if (c == '\\') {
          char e = s[i++];
          switch (e) {
            case '"': sb.Append('"'); break; case '\\': sb.Append('\\'); break; case '/': sb.Append('/'); break;
            case 'b': sb.Append('\b'); break; case 'f': sb.Append('\f'); break; case 'n': sb.Append('\n'); break;
            case 'r': sb.Append('\r'); break; case 't': sb.Append('\t'); break;
            case 'u': sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber)); i += 4; break;
            default: sb.Append(e); break;
          }
        } else sb.Append(c);
      }
      i++; return sb.ToString();
    }
    static object Num(string s, ref int i) {
      int st = i;
      while (i < s.Length) { char c = s[i]; if (char.IsDigit(c) || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') i++; else break; }
      return double.Parse(s.Substring(st, i - st), CultureInfo.InvariantCulture);
    }
  }

  static class Program {
    static Window win;
    static StackPanel cards, detail;
    static TextBlock meta, dName, dPath;
    static Ellipse dot;
    static Border rootBorder;
    static TranslateTransform ovShift, dtShift;
    static string statusUrl;
    static Mutex singleton;
    static List<object> repos = new List<object>();
    static bool showingDetail = false, autoOpened = false, autoExpanded = false;
    static Action lastToggle, firstFlowToggle;
    static string lastDetailSig = null;
    static readonly BrushConverter bc = new BrushConverter();

    // palette
    const string ACCENT = "#5AA3FF", LIVE = "#46C168", WAIT = "#E0A13A", ALERT = "#FF5B50";
    const string TXT = "#E8EDF4", TXT2 = "#9AA9BB", DIM = "#65768B", CARD = "#22FFFFFF", HAIR = "#18FFFFFF";
    const string MONO = "Cascadia Mono, Consolas", SANS = "Segoe UI Variable Display, Segoe UI";

    // ---- JSON walk helpers ----
    static object Get(object o, string k) { var d = o as Dictionary<string, object>; if (d != null && d.ContainsKey(k)) return d[k]; return null; }
    static List<object> A(object o) { var l = o as List<object>; return l != null ? l : new List<object>(); }
    static string S(object o, string k) { var v = Get(o, k); return v == null ? "" : Convert.ToString(v, CultureInfo.InvariantCulture); }
    static int I(object o, string k) { var v = Get(o, k); if (v is double) return (int)(double)v; int r; return int.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), out r) ? r : 0; }
    static bool Bo(object o, string k) { var v = Get(o, k); return v is bool && (bool)v; }
    static string Ago(string ts) {
      if (string.IsNullOrEmpty(ts)) return "";
      DateTime t;
      if (!DateTime.TryParse(ts, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out t)) return "";
      double sec = (DateTime.UtcNow - t).TotalSeconds; if (sec < 0) sec = 0;
      if (sec < 60) return ((int)sec) + "s";
      if (sec < 3600) return ((int)(sec / 60)) + "m";
      return ((int)(sec / 3600)) + "h";
    }
    static Brush Br(string hex) { return (Brush)bc.ConvertFromString(hex); }
    static Run RunC(string text, string hex) { var r = new Run(text); r.Foreground = Br(hex); return r; }
    static Run RunC(string text, string hex, string family) { var r = RunC(text, hex); r.FontFamily = new FontFamily(family); return r; }

    // ---- DWM material (Windows 11 acrylic + rounded corners) ----
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
    [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS m);
    [StructLayout(LayoutKind.Sequential)] struct MARGINS { public int L, T, R, B; }
    static void ApplyMaterial(IntPtr hwnd) {
      int dark = 1; DwmSetWindowAttribute(hwnd, 20, ref dark, 4);        // USE_IMMERSIVE_DARK_MODE
      int round = 2; DwmSetWindowAttribute(hwnd, 33, ref round, 4);      // WINDOW_CORNER_PREFERENCE = Round
      var m = new MARGINS(); m.L = -1; m.T = -1; m.R = -1; m.B = -1;     // extend the glass frame into the whole client
      DwmExtendFrameIntoClientArea(hwnd, ref m);                          // area — required for the backdrop to show
      int acrylic = 3;                                                    // SYSTEMBACKDROP_TYPE = Acrylic (transient)
      int rc = DwmSetWindowAttribute(hwnd, 38, ref acrylic, 4);
      // Acrylic took → a light tint so the blur shows; failed (older Windows) → near-opaque, never a
      // see-through-to-desktop ghost.
      rootBorder.Background = Br(rc == 0 ? "#5C0B0F16" : "#EA0B0F16");
    }

    [STAThread]
    static void Main(string[] args) {
      int port = 8791, interval = 1500;
      for (int a = 0; a < args.Length - 1; a++) {
        string f = args[a].ToLowerInvariant();
        if (f == "--port" || f == "-port") int.TryParse(args[a + 1], out port);
        if (f == "--interval") int.TryParse(args[a + 1], out interval);
      }
      bool created;
      singleton = new Mutex(false, "Local\\arc-scope-widget", out created);
      bool owns; try { owns = singleton.WaitOne(0); } catch (AbandonedMutexException) { owns = true; }
      if (!owns) return;

      statusUrl = "http://127.0.0.1:" + port + "/status";
      win = (Window)XamlReader.Parse(XAML);
      rootBorder = (Border)win.FindName("Root");
      cards = (StackPanel)win.FindName("Cards");
      detail = (StackPanel)win.FindName("Detail");
      meta = (TextBlock)win.FindName("Meta");
      dName = (TextBlock)win.FindName("DName");
      dPath = (TextBlock)win.FindName("DPath");
      dot = (Ellipse)win.FindName("Dot");
      ovShift = (TranslateTransform)win.FindName("OvShift");
      dtShift = (TranslateTransform)win.FindName("DtShift");
      Breathe(dot);
      ((Border)win.FindName("Header")).MouseLeftButtonDown += delegate { try { win.DragMove(); } catch { } };
      ((Border)win.FindName("DHeader")).MouseLeftButtonDown += delegate { try { win.DragMove(); } catch { } };
      ((Button)win.FindName("CloseBtn")).Click += delegate { win.Close(); };
      ((Button)win.FindName("MinBtn")).Click += delegate { win.WindowState = WindowState.Minimized; };
      ((Button)win.FindName("DCloseBtn")).Click += delegate { win.Close(); };
      ((Button)win.FindName("DMinBtn")).Click += delegate { win.WindowState = WindowState.Minimized; };
      ((Button)win.FindName("BackBtn")).Click += delegate { Back(); };

      var wa = SystemParameters.WorkArea;
      win.Left = wa.Right - win.Width - 8; win.Top = wa.Top + 34;
      dtShift.X = win.Width;   // detail parked off-screen right

      win.SourceInitialized += delegate { ApplyMaterial(new WindowInteropHelper(win).Handle); };
      var timer = new DispatcherTimer(); timer.Interval = TimeSpan.FromMilliseconds(interval);
      timer.Tick += delegate { Update(); };
      win.ContentRendered += delegate { Update(); };
      timer.Start();
      var app = new Application(); app.Run(win); GC.KeepAlive(singleton);
    }

    static void Update() {
      ThreadPool.QueueUserWorkItem(delegate {
        string json = null; bool ok = false;
        try { json = HttpGet(statusUrl, 2000); ok = true; } catch { ok = false; }
        try { win.Dispatcher.BeginInvoke(new Action(delegate { Render(json, ok); })); } catch { }
      });
    }
    static string HttpGet(string url, int timeoutMs) {
      var req = (HttpWebRequest)WebRequest.Create(url);
      req.Proxy = null; req.Timeout = timeoutMs; req.ReadWriteTimeout = timeoutMs;
      using (var resp = (HttpWebResponse)req.GetResponse())
      using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) return sr.ReadToEnd();
    }

    static void Render(string json, bool ok) {
      if (!ok || string.IsNullOrEmpty(json)) { Offline(); return; }
      object data; try { data = J.Parse(json); } catch { Offline(); return; }
      dot.Fill = Br(LIVE);
      repos = A(Get(data, "repos"));
      int sess = 0, waitAll = 0, unseen = 0;
      foreach (var rp in repos) { sess += I(rp, "sessionCount"); foreach (var w in A(Get(rp, "waiting"))) { waitAll++; if (!Bo(w, "seen")) unseen++; } }
      string rpl = repos.Count == 1 ? "" : "s", spl = sess == 1 ? "" : "s";
      meta.Inlines.Clear();
      meta.Inlines.Add(RunC(S(data, "host") + "   ·   " + repos.Count + " repo" + rpl + "   ·   " + sess + " session" + spl + "   ·   " + waitAll + " waiting", TXT2));
      if (unseen > 0) { meta.Inlines.Add(RunC("   ● ", ALERT)); meta.Inlines.Add(RunC(unseen + " unseen", ALERT)); }
      RenderOverview();
      // dev-only: ARC_SCOPE_AUTOOPEN=1 opens the first repo's detail on first data (for screenshots).
      if (!autoOpened && repos.Count > 0 && Environment.GetEnvironmentVariable("ARC_SCOPE_AUTOOPEN") == "1") { autoOpened = true; OpenDetail(repos[0]); }
      if (showingDetail) {   // refresh the open detail ONLY when its data changed — otherwise a poll
        object cur = FindRepo(Convert.ToString(dName.Tag));   // would rebuild it and collapse an expanded note / lose scroll
        if (cur == null) Back();
        else { string sig = RepoSig(cur); if (sig != lastDetailSig) { lastDetailSig = sig; RenderDetail(cur); } }
      }
    }
    static void Offline() {
      dot.Fill = Br(WAIT);
      meta.Inlines.Clear();
      meta.Inlines.Add(RunC("feed offline", WAIT)); meta.Inlines.Add(RunC("   —   start it:  ", DIM)); meta.Inlines.Add(RunC("arc feed", "#C7D2DE"));
      cards.Children.Clear();
      var tb = new TextBlock(); tb.Text = "no live arc sessions"; tb.Foreground = Br(DIM); tb.FontStyle = FontStyles.Italic; tb.Margin = new Thickness(5, 12, 0, 0);
      cards.Children.Add(tb);
    }
    static object FindRepo(string root) { foreach (var r in repos) if (S(r, "root") == root) return r; return null; }
    // a cheap signature of a repo's DETAIL-relevant state, so we skip rebuilding an unchanged detail.
    static string RepoSig(object r) {
      var sb = new StringBuilder();
      foreach (var x in A(Get(r, "roles"))) sb.Append(S(x, "role")).Append(I(x, "pid")).Append(S(x, "activity")).Append('|');
      sb.Append(";W"); foreach (var w in A(Get(r, "waiting"))) sb.Append(I(w, "seq")).Append(Bo(w, "seen") ? '1' : '0').Append('|');
      sb.Append(";C"); foreach (var c in A(Get(r, "cooperation"))) sb.Append(I(c, "seq")).Append('|');
      sb.Append(";R"); foreach (var m in A(Get(r, "roadmap"))) sb.Append(S(m, "title")).Append(S(m, "state")).Append('|');
      sb.Append(';').Append(I(r, "sessionCount")).Append(';').Append(I(Get(r, "board"), "notes"));
      return sb.ToString();
    }

    // ---- OVERVIEW ----
    static void RenderOverview() {
      cards.Children.Clear();
      if (repos.Count == 0) {
        var tb = new TextBlock(); tb.Text = "no live arc sessions"; tb.Foreground = Br(DIM); tb.FontStyle = FontStyles.Italic; tb.Margin = new Thickness(5, 12, 0, 0);
        cards.Children.Add(tb); return;
      }
      foreach (var rp in repos) {
        var repo = rp;
        int unseen = 0; foreach (var w in A(Get(repo, "waiting"))) if (!Bo(w, "seen")) unseen++;
        string chips = "";
        foreach (var r in A(Get(repo, "roles")))
          chips += "<Border Background='" + CARD + "' BorderBrush='" + HAIR + "' BorderThickness='1' CornerRadius='7' Padding='9,3,11,4' Margin='0,0,7,7'><StackPanel Orientation='Horizontal'>"
            + "<Ellipse Width='6' Height='6' Fill='" + LIVE + "' VerticalAlignment='Center' Margin='0,0,8,0'><Ellipse.Effect><DropShadowEffect BlurRadius='6' ShadowDepth='0' Color='" + LIVE + "' Opacity='0.85'/></Ellipse.Effect></Ellipse>"
            + "<TextBlock VerticalAlignment='Center'><Run Text='" + Esc(S(r, "role")) + "' FontFamily='Segoe UI' FontSize='12' Foreground='#DCE4EC'/><Run Text='  " + I(r, "pid") + "' FontFamily='" + MONO + "' FontSize='11' Foreground='" + DIM + "'/></TextBlock></StackPanel></Border>";
        if (chips == "") chips = "<TextBlock FontFamily='Segoe UI' FontSize='12' FontStyle='Italic' Foreground='" + DIM + "' Text='no live roles'/>";
        int sc = I(repo, "sessionCount"); string spl = sc == 1 ? "" : "s";
        int notes = I(Get(repo, "board"), "notes");
        string badge = unseen > 0 ? "<Border Background='#26FF5B50' BorderBrush='#4DFF5B50' BorderThickness='1' CornerRadius='6' Padding='6,1,6,1' VerticalAlignment='Center'><TextBlock FontFamily='" + MONO + "' FontSize='10' Foreground='" + ALERT + "' Text='" + unseen + " new'/></Border>"
                                  : "<TextBlock Foreground='#4A5B6F' FontSize='16' VerticalAlignment='Center' Text='&#x203A;'/>";
        string frag = "<Button xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' Style='{DynamicResource CardBtn}' Tag='" + Esc(S(repo, "root")) + "'>"
          + "<StackPanel>"
          + "<DockPanel><StackPanel DockPanel.Dock='Right' Margin='8,0,0,0'>" + badge + "</StackPanel>"
          + "<TextBlock FontFamily='" + SANS + "' FontSize='15.5' FontWeight='SemiBold' Foreground='" + TXT + "' Text='" + Esc(S(repo, "name")) + "'/></DockPanel>"
          + "<TextBlock FontFamily='" + MONO + "' FontSize='10.5' Foreground='" + DIM + "' Margin='0,2,0,0' TextTrimming='CharacterEllipsis' Text='" + Esc(S(repo, "root")) + "'/>"
          + "<WrapPanel Margin='0,12,0,0'>" + chips + "</WrapPanel>"
          + "<TextBlock FontFamily='" + MONO + "' FontSize='11.5' Foreground='" + TXT2 + "' Margin='0,10,0,0'><Run Text='" + sc + "' Foreground='#CBD6E2'/><Run Text=' session" + spl + "'/><Run Text='     &#183;     ' Foreground='#38485A'/><Run Text='" + notes + "' Foreground='#CBD6E2'/><Run Text=' notes'/></TextBlock>"
          + "</StackPanel></Button>";
        var btn = (Button)XamlReader.Parse(frag);
        btn.Style = (Style)win.FindResource(unseen > 0 ? "CardBtnAlert" : "CardBtn");
        var captured = repo;
        btn.Click += delegate { OpenDetail(captured); };
        cards.Children.Add(btn);
      }
    }

    // ---- navigation ----
    static void OpenDetail(object repo) {
      RenderDetail(repo); lastDetailSig = RepoSig(repo);
      detail.Dispatcher.BeginInvoke(new Action(delegate {
        var sv = detail.Parent as ScrollViewer;
        if (sv != null) { if (Environment.GetEnvironmentVariable("ARC_SCOPE_SCROLLBOTTOM") == "1") sv.ScrollToBottom(); else sv.ScrollToTop(); }
      }), DispatcherPriority.Loaded);
      showingDetail = true;
      Slide(dtShift, 0); Slide(ovShift, -win.Width * 0.22); Fade((UIElement)win.FindName("OverviewView"), 0.0);
      ((UIElement)win.FindName("DetailView")).IsHitTestVisible = true;
      ((UIElement)win.FindName("OverviewView")).IsHitTestVisible = false;
    }
    static void Back() {
      showingDetail = false;
      Slide(dtShift, win.Width); Slide(ovShift, 0); Fade((UIElement)win.FindName("OverviewView"), 1.0);
      ((UIElement)win.FindName("DetailView")).IsHitTestVisible = false;
      ((UIElement)win.FindName("OverviewView")).IsHitTestVisible = true;
    }
    static readonly IEasingFunction EASE = new CubicEase() { EasingMode = EasingMode.EaseOut };
    static void Slide(TranslateTransform t, double to) {
      var a = new DoubleAnimation(to, new Duration(TimeSpan.FromMilliseconds(340))); a.EasingFunction = EASE;
      t.BeginAnimation(TranslateTransform.XProperty, a);
    }
    static void Fade(UIElement e, double to) {
      var a = new DoubleAnimation(to, new Duration(TimeSpan.FromMilliseconds(300)));
      e.BeginAnimation(UIElement.OpacityProperty, a);
    }
    static void Breathe(UIElement dotEl) {
      var a = new DoubleAnimation(1.0, 0.5, new Duration(TimeSpan.FromMilliseconds(1500)));
      a.AutoReverse = true; a.RepeatBehavior = RepeatBehavior.Forever;
      dotEl.BeginAnimation(UIElement.OpacityProperty, a);
    }

    // ---- DETAIL ----
    static void RenderDetail(object repo) {
      dName.Text = S(repo, "name"); dName.Tag = S(repo, "root"); dPath.Text = S(repo, "root");
      detail.Children.Clear();

      // SESSIONS
      var roles = A(Get(repo, "roles"));
      detail.Children.Add(Section("SESSIONS", roles.Count + " live"));
      if (roles.Count == 0) detail.Children.Add(Empty("no live roles"));
      foreach (var r in roles) {
        var row = new DockPanel(); row.Margin = new Thickness(2, 5, 2, 5);
        var d = Dot(6, LIVE); d.VerticalAlignment = VerticalAlignment.Top; d.Margin = new Thickness(0, 5, 10, 0); Breathe(d);
        DockPanel.SetDock(d, Dock.Left); row.Children.Add(d);
        string act = S(r, "activity");
        if (act.Length > 0) {
          var a = new TextBlock(); a.FontFamily = new FontFamily(MONO); a.FontSize = 11; a.Foreground = Br(TXT2);
          a.TextAlignment = TextAlignment.Right; a.TextWrapping = TextWrapping.Wrap; a.MaxWidth = 210; a.Text = act; a.Margin = new Thickness(12, 0, 0, 0);
          DockPanel.SetDock(a, Dock.Right); row.Children.Add(a);
        }
        var lbl = new TextBlock(); lbl.VerticalAlignment = VerticalAlignment.Center;
        lbl.Inlines.Add(RunC(S(r, "role"), TXT, MONO)); lbl.Inlines.Add(RunC(" " + I(r, "pid"), DIM, MONO));
        if (act.Length == 0) { lbl.Inlines.Add(RunC("   — idle", DIM, MONO)); }
        row.Children.Add(lbl);
        detail.Children.Add(row);
      }

      // COOPERATION
      var coop = A(Get(repo, "cooperation"));
      detail.Children.Add(Section("COOPERATION", ""));
      // collaborating pair = the most-frequent from<->to among replies
      var pair = TopPair(coop);
      if (pair != null) {
        var p = new DockPanel(); p.Margin = new Thickness(2, 2, 2, 8);
        var badge = new Border(); badge.Background = Br(CARD); badge.CornerRadius = new CornerRadius(20); badge.Padding = new Thickness(9, 2, 9, 2);
        var bt = new TextBlock(); bt.FontFamily = new FontFamily(MONO); bt.FontSize = 10; bt.Foreground = Br("#8595A6"); bt.Text = pair[2] + " exchanges"; badge.Child = bt;
        DockPanel.SetDock(badge, Dock.Right); p.Children.Add(badge);
        var et = new TextBlock(); et.FontFamily = new FontFamily(MONO); et.FontSize = 13; et.VerticalAlignment = VerticalAlignment.Center;
        et.Inlines.Add(RunC(pair[0], ACCENT)); et.Inlines.Add(RunC("  ⇄  ", "#54657A")); et.Inlines.Add(RunC(pair[1], WAIT));
        p.Children.Add(et); detail.Children.Add(p);
      }
      // recent replies (latest first, cap 6) — clickable
      var cl = new List<object>(coop); int cstart = Math.Max(0, cl.Count - 6);
      var recent = new List<object>(); for (int k = cl.Count - 1; k >= cstart; k--) recent.Add(cl[k]);
      if (recent.Count == 0) detail.Children.Add(Empty("no replies yet"));
      foreach (var c in recent)
        detail.Children.Add(Note(false, S(c, "from"), "↩", S(c, "to"), LIVE, WAIT, "re #" + I(c, "reSeq"), S(c, "text")));

      // NOTE FLOW
      var waiting = A(Get(repo, "waiting")); int uc = 0; foreach (var w in waiting) if (!Bo(w, "seen")) uc++;
      var nf = new StackPanel(); var sec = Section("NOTE FLOW", waiting.Count + (uc > 0 ? "  ·  " + uc + " new" : ""));
      detail.Children.Add(sec);
      if (waiting.Count == 0) detail.Children.Add(Empty("nobody waiting"));
      firstFlowToggle = null; int wi = 0;
      foreach (var w in waiting) {
        bool un = !Bo(w, "seen");
        detail.Children.Add(Note(un, S(w, "from"), "→", S(w, "to"), ACCENT, un ? ALERT : WAIT, "#" + I(w, "seq") + "  ·  " + Ago(S(w, "ts")), S(w, "text")));
        if (wi == 0) firstFlowToggle = lastToggle;
        wi++;
      }

      // ROADMAP
      var road = A(Get(repo, "roadmap"));
      detail.Children.Add(Section("ROADMAP", road.Count + " open"));
      if (road.Count == 0) detail.Children.Add(Empty("nothing parked"));
      foreach (var m in road) {
        var row = new DockPanel(); row.Margin = new Thickness(2, 6, 2, 6);
        bool prog = S(m, "state") == "prog";
        var g = new Grid(); g.Width = 14; g.Height = 14; g.VerticalAlignment = VerticalAlignment.Center; g.Margin = new Thickness(0, 0, 11, 0);
        var ring = new Ellipse(); ring.Stroke = Br(prog ? LIVE : "#46566A"); ring.StrokeThickness = 1.6; g.Children.Add(ring);
        if (prog) { var fillE = new Ellipse(); fillE.Margin = new Thickness(3); fillE.Fill = Br(LIVE); g.Children.Add(fillE); }
        DockPanel.SetDock(g, Dock.Left); row.Children.Add(g);
        string own = S(m, "owner");
        if (own.Length > 0) { var o = new TextBlock(); o.FontFamily = new FontFamily(MONO); o.FontSize = 10.5; o.Foreground = Br(DIM); o.Text = "[" + own + "]"; o.VerticalAlignment = VerticalAlignment.Center; o.Margin = new Thickness(10, 0, 0, 0); DockPanel.SetDock(o, Dock.Right); row.Children.Add(o); }
        var t = new TextBlock(); t.FontSize = 13; t.Foreground = Br("#DCE4EC"); t.Text = S(m, "title"); t.VerticalAlignment = VerticalAlignment.Center; t.TextTrimming = TextTrimming.CharacterEllipsis;
        row.Children.Add(t); detail.Children.Add(row);
      }
      // dev-only: ARC_SCOPE_AUTOEXPAND=1 opens the first note's content once (for screenshots).
      if (!autoExpanded && firstFlowToggle != null && Environment.GetEnvironmentVariable("ARC_SCOPE_AUTOEXPAND") == "1") {
        autoExpanded = true; var tg = firstFlowToggle;
        detail.Dispatcher.BeginInvoke(new Action(delegate { tg(); }), DispatcherPriority.Loaded);
      }
    }

    // a section eyebrow + hairline rule + optional right count
    static UIElement Section(string label, string count) {
      var dp = new DockPanel(); dp.Margin = new Thickness(2, 17, 2, 9);
      var l = new TextBlock(); l.FontFamily = new FontFamily("Segoe UI"); l.FontSize = 10; l.FontWeight = FontWeights.SemiBold; l.Foreground = Br("#6D7E92"); l.Text = label;
      DockPanel.SetDock(l, Dock.Left); dp.Children.Add(l);
      if (count.Length > 0) { var c = new TextBlock(); c.FontFamily = new FontFamily(MONO); c.FontSize = 10; c.Foreground = Br("#8595A6"); c.Text = count; DockPanel.SetDock(c, Dock.Right); dp.Children.Add(c); }
      var rule = new Border(); rule.Height = 1; rule.Background = Br(HAIR); rule.Margin = new Thickness(12, 0, 12, 1); rule.VerticalAlignment = VerticalAlignment.Center;
      dp.Children.Add(rule); return dp;
    }
    static UIElement Empty(string text) { var t = new TextBlock(); t.FontFamily = new FontFamily("Segoe UI"); t.FontSize = 12; t.FontStyle = FontStyles.Italic; t.Foreground = Br(DIM); t.Text = text; t.Margin = new Thickness(4, 1, 0, 2); return t; }
    static Ellipse Dot(double sz, string hex) { var e = new Ellipse(); e.Width = sz; e.Height = sz; e.Fill = Br(hex); return e; }
    static string[] TopPair(List<object> coop) {
      var counts = new Dictionary<string, int>(); var label = new Dictionary<string, string[]>();
      foreach (var c in coop) {
        string a = S(c, "from"), b = S(c, "to"); if (a.Length == 0 || b.Length == 0) continue;
        string key = string.CompareOrdinal(a, b) < 0 ? a + "|" + b : b + "|" + a;
        if (!counts.ContainsKey(key)) { counts[key] = 0; label[key] = new string[] { a, b }; }
        counts[key]++;
      }
      string best = null; int bn = 0; foreach (var kv in counts) if (kv.Value > bn) { bn = kv.Value; best = kv.Key; }
      if (best == null) return null; return new string[] { label[best][0], label[best][1], bn.ToString() };
    }

    // a clickable note: header row (from -> to ... meta) + a collapsible body with the exact content
    static UIElement Note(bool unseen, string from, string arrow, string to, string fromColor, string toColor, string meta, string body) {
      var wrap = new StackPanel();
      var btn = new Button(); btn.Style = (Style)win.FindResource("NoteBtn");
      var row = new DockPanel();
      var pip = new Ellipse(); pip.Width = 5; pip.Height = 5; pip.VerticalAlignment = VerticalAlignment.Center; pip.Margin = new Thickness(0, 0, 9, 0);
      pip.Fill = Br(unseen ? ALERT : "#38485A");
      if (unseen) { var ef = new System.Windows.Media.Effects.DropShadowEffect(); ef.BlurRadius = 7; ef.ShadowDepth = 0; ef.Color = (Color)ColorConverter.ConvertFromString(ALERT); ef.Opacity = 0.8; pip.Effect = ef; }
      DockPanel.SetDock(pip, Dock.Left); row.Children.Add(pip);
      var mt = new TextBlock(); mt.FontFamily = new FontFamily(MONO); mt.FontSize = 11; mt.Foreground = Br(DIM); mt.Text = meta; mt.VerticalAlignment = VerticalAlignment.Center; mt.Margin = new Thickness(10, 0, 4, 0);
      DockPanel.SetDock(mt, Dock.Right); row.Children.Add(mt);
      var caret = new TextBlock(); caret.FontSize = 11; caret.Foreground = Br("#4A5B6F"); caret.Text = "›"; caret.VerticalAlignment = VerticalAlignment.Center; caret.Margin = new Thickness(0, 0, 8, 0);
      var ct = new RotateTransform(0); caret.RenderTransform = ct; caret.RenderTransformOrigin = new Point(0.5, 0.5);
      DockPanel.SetDock(caret, Dock.Right); row.Children.Add(caret);
      var edge = new TextBlock(); edge.FontFamily = new FontFamily(MONO); edge.FontSize = 12.5; edge.VerticalAlignment = VerticalAlignment.Center; edge.TextTrimming = TextTrimming.CharacterEllipsis;
      edge.Inlines.Add(RunC(from, fromColor)); edge.Inlines.Add(RunC("  " + arrow + "  ", "#54657A")); edge.Inlines.Add(RunC(to, toColor));
      row.Children.Add(edge);
      btn.Content = row;

      var bodyB = new Border(); bodyB.Background = Br("#14FFFFFF"); bodyB.BorderBrush = Br(HAIR); bodyB.BorderThickness = new Thickness(2, 0, 0, 0); bodyB.CornerRadius = new CornerRadius(0);
      bodyB.BorderBrush = Br(ACCENT); bodyB.Padding = new Thickness(11, 8, 12, 9); bodyB.Margin = new Thickness(22, 2, 2, 8); bodyB.MaxHeight = 0; bodyB.Opacity = 0;
      var inner = new StackPanel();
      var bm = new TextBlock(); bm.FontFamily = new FontFamily(MONO); bm.FontSize = 10; bm.Foreground = Br(DIM); bm.Text = from + " " + arrow + " " + to + "  ·  " + meta.Replace("  ·  ", " · "); bm.Margin = new Thickness(0, 0, 0, 5);
      var bt = new TextBlock(); bt.FontSize = 12.5; bt.Foreground = Br("#CDD8E4"); bt.TextWrapping = TextWrapping.Wrap; bt.Text = body.Length > 0 ? body : "(no content)";
      inner.Children.Add(bm); inner.Children.Add(bt); bodyB.Child = inner;

      bool[] open = new bool[] { false };
      Action doToggle = delegate {
        open[0] = !open[0];
        var ha = new DoubleAnimation(open[0] ? 240 : 0, new Duration(TimeSpan.FromMilliseconds(260))); ha.EasingFunction = EASE;
        var oa = new DoubleAnimation(open[0] ? 1 : 0, new Duration(TimeSpan.FromMilliseconds(open[0] ? 260 : 140)));
        var ra = new DoubleAnimation(open[0] ? 90 : 0, new Duration(TimeSpan.FromMilliseconds(200))); ra.EasingFunction = EASE;
        bodyB.BeginAnimation(FrameworkElement.MaxHeightProperty, ha);
        bodyB.BeginAnimation(UIElement.OpacityProperty, oa);
        ct.BeginAnimation(RotateTransform.AngleProperty, ra);
      };
      btn.Click += delegate { doToggle(); };
      lastToggle = doToggle;
      wrap.Children.Add(btn); wrap.Children.Add(bodyB);
      return wrap;
    }

    static string Esc(string s) {
      if (s == null) return "";
      return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;").Replace("'", "&#39;");
    }

    // ---- the window shell + styles (single-quoted XAML → drops into a C# verbatim string) ----
    const string XAML = @"
<Window xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'
        xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml'
        Title='arc scope' Width='452' Height='720' WindowStyle='None'
        AllowsTransparency='False' Background='Transparent' Topmost='True'
        ShowInTaskbar='True' FontFamily='Segoe UI' ResizeMode='NoResize'
        TextOptions.TextFormattingMode='Ideal' TextOptions.TextRenderingMode='ClearType'>
  <Window.Resources>
    <Style x:Key='ScrollNub' TargetType='RepeatButton'><Setter Property='OverridesDefaultStyle' Value='True'/><Setter Property='Focusable' Value='False'/><Setter Property='IsTabStop' Value='False'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='RepeatButton'><Border Background='Transparent'/></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='ScrollThumb' TargetType='Thumb'><Setter Property='OverridesDefaultStyle' Value='True'/><Setter Property='IsTabStop' Value='False'/><Setter Property='MinHeight' Value='30'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Thumb'><Border x:Name='Nub' CornerRadius='4' Background='#33FFFFFF' Margin='3,1,3,1'/>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='Nub' Property='Background' Value='#55FFFFFF'/></Trigger>
        <Trigger Property='IsDragging' Value='True'><Setter TargetName='Nub' Property='Background' Value='#5AA3FF'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style TargetType='ScrollBar'><Setter Property='OverridesDefaultStyle' Value='True'/><Setter Property='Width' Value='11'/><Setter Property='Background' Value='Transparent'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='ScrollBar'><Grid Background='Transparent'><Track x:Name='PART_Track' IsDirectionReversed='True'>
        <Track.Thumb><Thumb Style='{StaticResource ScrollThumb}'/></Track.Thumb>
        <Track.IncreaseRepeatButton><RepeatButton Style='{StaticResource ScrollNub}' Command='ScrollBar.PageDownCommand'/></Track.IncreaseRepeatButton>
        <Track.DecreaseRepeatButton><RepeatButton Style='{StaticResource ScrollNub}' Command='ScrollBar.PageUpCommand'/></Track.DecreaseRepeatButton></Track></Grid></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='HdrBtn' TargetType='Button'><Setter Property='Width' Value='26'/><Setter Property='Height' Value='24'/><Setter Property='Foreground' Value='#8FA0B4'/><Setter Property='Background' Value='Transparent'/><Setter Property='Cursor' Value='Hand'/><Setter Property='FontSize' Value='12'/><Setter Property='VerticalAlignment' Value='Top'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='bg' Background='{TemplateBinding Background}' CornerRadius='6'><ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/></Border>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bg' Property='Background' Value='#14FFFFFF'/><Setter Property='Foreground' Value='#EAF0F7'/></Trigger>
        <Trigger Property='IsPressed' Value='True'><Setter TargetName='bg' Property='Background' Value='#22FFFFFF'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='HdrClose' TargetType='Button' BasedOn='{StaticResource HdrBtn}'>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='bg' Background='{TemplateBinding Background}' CornerRadius='6'><ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/></Border>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bg' Property='Background' Value='#7A2B27'/><Setter Property='Foreground' Value='#FFE9E7'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='BackBtn' TargetType='Button' BasedOn='{StaticResource HdrBtn}'><Setter Property='Width' Value='28'/><Setter Property='Height' Value='26'/><Setter Property='FontSize' Value='15'/><Setter Property='VerticalAlignment' Value='Center'/></Style>
    <Style x:Key='CardBtn' TargetType='Button'><Setter Property='Cursor' Value='Hand'/><Setter Property='HorizontalContentAlignment' Value='Stretch'/><Setter Property='Margin' Value='0,0,0,11'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='bd' Background='#1EFFFFFF' BorderBrush='#18FFFFFF' BorderThickness='1' CornerRadius='13' Padding='15' RenderTransformOrigin='0.5,0.5'><ContentPresenter/></Border>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bd' Property='Background' Value='#2CFFFFFF'/><Setter TargetName='bd' Property='BorderBrush' Value='#26FFFFFF'/></Trigger>
        <Trigger Property='IsPressed' Value='True'><Setter TargetName='bd' Property='RenderTransform'><Setter.Value><ScaleTransform ScaleX='0.985' ScaleY='0.985'/></Setter.Value></Setter></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='CardBtnAlert' TargetType='Button' BasedOn='{StaticResource CardBtn}'>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='bd' Background='#1EFFFFFF' BorderBrush='#6BFF5B50' BorderThickness='1' CornerRadius='13' Padding='15' RenderTransformOrigin='0.5,0.5'><ContentPresenter/></Border>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bd' Property='Background' Value='#2CFFFFFF'/><Setter TargetName='bd' Property='BorderBrush' Value='#99FF5B50'/></Trigger>
        <Trigger Property='IsPressed' Value='True'><Setter TargetName='bd' Property='RenderTransform'><Setter.Value><ScaleTransform ScaleX='0.985' ScaleY='0.985'/></Setter.Value></Setter></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='NoteBtn' TargetType='Button'><Setter Property='Cursor' Value='Hand'/><Setter Property='HorizontalContentAlignment' Value='Stretch'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='bd' Background='Transparent' CornerRadius='8' Padding='7,6,8,6'><ContentPresenter/></Border>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bd' Property='Background' Value='#12FFFFFF'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
  </Window.Resources>
  <Border x:Name='Root' Background='#EA0B0F16' CornerRadius='12' BorderBrush='#1EFFFFFF' BorderThickness='1'>
    <Grid ClipToBounds='True'>
      <!-- OVERVIEW -->
      <DockPanel x:Name='OverviewView'><DockPanel.RenderTransform><TranslateTransform x:Name='OvShift' X='0'/></DockPanel.RenderTransform>
        <Border x:Name='Header' DockPanel.Dock='Top' Background='#14FFFFFF' CornerRadius='11,11,0,0' Padding='17,13,10,13' BorderBrush='#12FFFFFF' BorderThickness='0,0,0,1'>
          <StackPanel><DockPanel>
            <Ellipse x:Name='Dot' DockPanel.Dock='Left' Width='9' Height='9' Fill='#46C168' VerticalAlignment='Center' Margin='0,0,11,0'><Ellipse.Effect><DropShadowEffect BlurRadius='10' ShadowDepth='0' Color='#46C168' Opacity='0.95'/></Ellipse.Effect></Ellipse>
            <Button x:Name='CloseBtn' Style='{StaticResource HdrClose}' DockPanel.Dock='Right' Content='&#x2715;'/>
            <Button x:Name='MinBtn' Style='{StaticResource HdrBtn}' DockPanel.Dock='Right' Content='&#x2013;' FontSize='15' Margin='0,0,3,0'/>
            <TextBlock FontFamily='Segoe UI Variable Display, Segoe UI' FontSize='15' VerticalAlignment='Center'><Run Text='arc' FontWeight='SemiBold' Foreground='#E8EDF4'/><Run Text=' scope' Foreground='#E8EDF4'/></TextBlock>
          </DockPanel>
          <TextBlock x:Name='Meta' FontFamily='Segoe UI' FontSize='11.5' Foreground='#9AA9BB' Margin='20,5,0,0' Text='connecting&#x2026;' TextTrimming='CharacterEllipsis'/></StackPanel>
        </Border>
        <ScrollViewer VerticalScrollBarVisibility='Auto' HorizontalScrollBarVisibility='Disabled' Padding='0'><StackPanel x:Name='Cards' Margin='12,11,12,14'/></ScrollViewer>
      </DockPanel>
      <!-- DETAIL -->
      <DockPanel x:Name='DetailView' IsHitTestVisible='False'><DockPanel.RenderTransform><TranslateTransform x:Name='DtShift' X='452'/></DockPanel.RenderTransform>
        <Border x:Name='DHeader' DockPanel.Dock='Top' Background='#14FFFFFF' CornerRadius='11,11,0,0' Padding='11,11,10,12' BorderBrush='#12FFFFFF' BorderThickness='0,0,0,1'>
          <DockPanel>
            <Button x:Name='BackBtn' Style='{StaticResource BackBtn}' DockPanel.Dock='Left' Content='&#x2039;' Margin='0,0,11,0'/>
            <Button x:Name='DCloseBtn' Style='{StaticResource HdrClose}' DockPanel.Dock='Right' Content='&#x2715;'/>
            <Button x:Name='DMinBtn' Style='{StaticResource HdrBtn}' DockPanel.Dock='Right' Content='&#x2013;' FontSize='15' Margin='0,0,3,0'/>
            <StackPanel VerticalAlignment='Center'>
              <TextBlock x:Name='DName' FontFamily='Segoe UI Variable Display, Segoe UI' FontSize='15' FontWeight='SemiBold' Foreground='#E8EDF4'/>
              <TextBlock x:Name='DPath' FontFamily='Cascadia Mono, Consolas' FontSize='10.5' Foreground='#65768B' Margin='0,1,0,0'/>
            </StackPanel>
          </DockPanel>
        </Border>
        <ScrollViewer VerticalScrollBarVisibility='Auto' HorizontalScrollBarVisibility='Disabled' Padding='0'><StackPanel x:Name='Detail' Margin='13,10,14,16'/></ScrollViewer>
      </DockPanel>
    </Grid>
  </Border>
</Window>";
  }
}
