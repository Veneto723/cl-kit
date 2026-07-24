// arc-scope.exe — a desktop monitor for the arc operator feed (a normal, resizable window).
//
// A native WPF app on .NET Framework 4.x — which ships INSIDE every Windows 10/11, so this .exe runs
// on any Windows machine with nothing to install (no Rust, no .NET SDK, no WebView2, no PowerShell).
// It is built by the C# compiler that also ships in Windows (Framework64\v4.0.30319\csc.exe) — see
// build.ps1. The whole UI is created from a XAML string via XamlReader.Parse (no XAML compile step).
//
// It is a TWO-LEVEL view of the arc board, polling the feed's /status (loopback) every ~1.5s:
//   OVERVIEW — a card per live git repo; click a card to drill in.
//   DETAIL   — that repo's board: the GRAPH (every session, live or closed, coloured by state, with
//              an arrow per unconsumed note that dissolves when it is read), NOTE FLOW (the ledger
//              itself, newest first, click a row for the exact content), ROADMAP.
//   Any note is click-to-read (its exact body). Back chevron returns to the overview.
//
// Palette: a COMMITTED SOLID dark family (no translucency anywhere) — a translucent surface takes its
// colour from whatever is behind the window, which made the theme drift with the desktop. Neutrals are
// biased toward the azure accent; semantic colours (green live / amber waiting / red unseen) are kept
// separate from that accent. Corners use the WINDOWS SYSTEM radius
// (DWM rounds and clips; the WPF root stays square so no custom curve competes with the frame),
// normal z-order (not topmost), user-resizable —
// WindowChrome owns the non-client area so no system caption sliver shows. This is arc's opt-in
// COMPANION — it lives in the arc repo under scope/, kept out of the pure-Node src/ (arc ships the
// feed; this is one face for it).
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
    static TranslateTransform ovShift, dtShift, ntShift;
    static StackPanel notesPanel;
    static string statusUrl;
    static Mutex singleton;
    static List<object> repos = new List<object>();
    static bool showingDetail = false, showingNotes = false, autoOpened = false, autoExpanded = false, sizedOnce = false;
    static Action lastToggle, firstFlowToggle;
    static string lastDetailSig = null;
    static readonly BrushConverter bc = new BrushConverter();

    // palette
    const string ACCENT = "#5AA3FF", LIVE = "#46C168", WAIT = "#E0A13A", ALERT = "#FF5B50";
    const string TXT = "#E8EDF4", TXT2 = "#9AA9BB", DIM = "#65768B", CARD = "#161E2A", HAIR = "#232D3B";
    const string MONO = "Cascadia Mono, Consolas", SANS = "Segoe UI Variable Display, Segoe UI";
    const string CLOSED = "#3A4A5C";

    // Session status, ONE definition for every dot in the app (repo card chip, graph node).
    //   active  green   wrote to its transcript recently — it is working
    //   idle    yellow  live, but silent past the idle threshold
    //   closed  gray    no live claim; it appears only in note history
    // THERE IS NO DEAF/RED STATE, deliberately (operator's call). It was inferred from the `arc join`
    // listener marker, and a session is legitimately markerless while working — the listener exits on
    // delivery and re-arms only at turn end, and a revive deletes the marker outright. It painted
    // `research` red in the middle of a long investigation, twice. Reachability is still surfaced,
    // but on the statusline, where the check also requires a MISSED NOTE as evidence rather than a
    // missing file. An unknown or missing state reads ACTIVE — a silent session is working, not broken.
    static string StateColor(string state) {
      if (state == "idle") return WAIT;
      if (state == "closed") return CLOSED;
      return LIVE;
    }
    // The panel's DEFAULT width in content units — the window is user-resizable from here. The root is
    // scaled by --scale, so in-content offsets (the drill-down slide) live in THESE units, never the
    // scaled window width. And because the user can resize, they must be read LIVE, not hard-coded:
    // a stale constant would slide the detail the wrong distance the moment the window changed size.
    const double BASE_W = 380;
    static double ContentW() { double w = rootBorder != null ? rootBorder.ActualWidth : 0; return w > 1 ? w : BASE_W; }

    // ---- JSON walk helpers ----
    static object Get(object o, string k) { var d = o as Dictionary<string, object>; if (d != null && d.ContainsKey(k)) return d[k]; return null; }
    static List<object> A(object o) { var l = o as List<object>; return l != null ? l : new List<object>(); }
    static string S(object o, string k) { var v = Get(o, k); return v == null ? "" : Convert.ToString(v, CultureInfo.InvariantCulture); }
    static int I(object o, string k) { var v = Get(o, k); if (v is double) return (int)(double)v; int r; return int.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), out r) ? r : 0; }
    static bool Bo(object o, string k) { var v = Get(o, k); return v is bool && (bool)v; }
    // fractional reader — I() truncates to int, which would flatten every bond strength (0..1) to zero
    static double D(object o, string k) {
      var v = Get(o, k); if (v is double) return (double)v;
      double r; return double.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture),
        NumberStyles.Float, CultureInfo.InvariantCulture, out r) ? r : 0;
    }
    // Hours since a note was written. Unparseable/absent reads as ANCIENT, so a missing timestamp
    // can never sneak a stale pair into the "recent" band.
    static double AgeHours(string ts) {
      if (string.IsNullOrEmpty(ts)) return double.MaxValue;
      DateTime t;
      if (!DateTime.TryParse(ts, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out t)) return double.MaxValue;
      double h = (DateTime.UtcNow - t).TotalHours;
      return h < 0 ? 0 : h;
    }
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

    // ---- DWM window traits (dark title bar + the system corner radius) ----
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
    static void ApplyMaterial(IntPtr hwnd) {
      int dark = 1; DwmSetWindowAttribute(hwnd, 20, ref dark, 4);        // USE_IMMERSIVE_DARK_MODE
      // Corner rounding is DWM's, not ours: WINDOW_CORNER_PREFERENCE = Round gives the WINDOWS 11
      // SYSTEM radius, so the panel matches every other window. The WPF root deliberately keeps
      // CornerRadius=0 — a custom radius underneath would fight the frame and double the curve.
      int round = 2; DwmSetWindowAttribute(hwnd, 33, ref round, 4);
      // NO acrylic/mica backdrop, DELIBERATELY. A translucent surface takes its colour from whatever
      // happens to sit behind the window, so every card and hairline drifted with the desktop — the
      // panel looked like a different theme depending on what was underneath it. The palette is a
      // COMMITTED SOLID family instead: identical on every machine, over any background, every build.
    }

    [STAThread]
    static void Main(string[] args) {
      int port = 8791, interval = 1500;
      double scale = 1.2;                 // UI zoom: everything (type, chips, buttons, spacing) together
      for (int a = 0; a < args.Length - 1; a++) {
        string f = args[a].ToLowerInvariant();
        if (f == "--port" || f == "-port") int.TryParse(args[a + 1], out port);
        if (f == "--interval") int.TryParse(args[a + 1], out interval);
        if (f == "--scale") { double s; if (double.TryParse(args[a + 1], NumberStyles.Float, CultureInfo.InvariantCulture, out s) && s >= 0.6 && s <= 3.0) scale = s; }
      }
      bool created;
      singleton = new Mutex(false, "Local\\arc-scope-widget", out created);
      bool owns; try { owns = singleton.WaitOne(0); } catch (AbandonedMutexException) { owns = true; }
      if (!owns) return;

      statusUrl = "http://127.0.0.1:" + port + "/status";
      win = (Window)XamlReader.Parse(XAML);
      // WindowStyle=None + ResizeMode=CanResize leaves a SLIVER of the system non-client frame at the
      // top (a thin strip with little corner marks). WindowChrome takes the non-client area over:
      // no caption at all, real resize borders, no aero buttons — and GlassFrameThickness -1 keeps the
      // frame extended into the client area so the DWM acrylic backdrop still applies.
      var chrome = new System.Windows.Shell.WindowChrome();
      chrome.CaptionHeight = 0;
      chrome.ResizeBorderThickness = new Thickness(6);
      chrome.GlassFrameThickness = new Thickness(-1);
      chrome.CornerRadius = new CornerRadius(0);
      chrome.UseAeroCaptionButtons = false;
      System.Windows.Shell.WindowChrome.SetWindowChrome(win, chrome);
      rootBorder = (Border)win.FindName("Root");
      cards = (StackPanel)win.FindName("Cards");
      detail = (StackPanel)win.FindName("Detail");
      meta = (TextBlock)win.FindName("Meta");
      dName = (TextBlock)win.FindName("DName");
      dPath = (TextBlock)win.FindName("DPath");
      dot = (Ellipse)win.FindName("Dot");
      ovShift = (TranslateTransform)win.FindName("OvShift");
      dtShift = (TranslateTransform)win.FindName("DtShift");
      ntShift = (TranslateTransform)win.FindName("NtShift");
      notesPanel = (StackPanel)win.FindName("Notes");
      Breathe(dot);
      ((Border)win.FindName("Header")).MouseLeftButtonDown += delegate { try { win.DragMove(); } catch { } };
      ((Border)win.FindName("DHeader")).MouseLeftButtonDown += delegate { try { win.DragMove(); } catch { } };
      ((Border)win.FindName("NHeader")).MouseLeftButtonDown += delegate { try { win.DragMove(); } catch { } };
      ((Button)win.FindName("CloseBtn")).Click += delegate { win.Close(); };
      ((Button)win.FindName("MinBtn")).Click += delegate { win.WindowState = WindowState.Minimized; };
      ((Button)win.FindName("DCloseBtn")).Click += delegate { win.Close(); };
      ((Button)win.FindName("DMinBtn")).Click += delegate { win.WindowState = WindowState.Minimized; };
      ((Button)win.FindName("NCloseBtn")).Click += delegate { win.Close(); };
      ((Button)win.FindName("NMinBtn")).Click += delegate { win.WindowState = WindowState.Minimized; };
      ((Button)win.FindName("BackBtn")).Click += delegate { Back(); };
      ((Button)win.FindName("NBackBtn")).Click += delegate { BackFromNotes(); };

      // Zoom the whole panel as ONE unit (type, chips, buttons, spacing scale together), then let the
      // window HUG its content — a fixed 720pt height left half the panel empty on a short board, which
      // read as "big window, tiny text". MaxHeight caps it and the ScrollViewer takes over from there.
      rootBorder.LayoutTransform = new ScaleTransform(scale, scale);
      var wa = SystemParameters.WorkArea;
      win.Width = BASE_W * scale;
      win.SizeToContent = SizeToContent.Height;   // INITIAL fit only — handed back to the user in Render()
      win.MaxHeight = wa.Height * 0.92;
      win.Left = wa.Right - win.Width - 8; win.Top = wa.Top + 34;
      dtShift.X = BASE_W;   // detail parked off-screen right, in CONTENT units (inside the scaled root)
      ntShift.X = BASE_W;   // ...and the notes screen behind it
      // Keep the parked screens off-screen at ANY size — otherwise widening the window lets them peek in.
      win.SizeChanged += delegate {
        if (!showingDetail) dtShift.X = ContentW();
        if (!showingNotes) ntShift.X = ContentW();
      };

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
      // Rebuild the cards ONLY when they would actually differ — see OverviewSig: an unconditional
      // rebuild destroys the button a click is in the middle of.
      string ovSig = OverviewSig();
      if (ovSig != lastOverviewSig) { lastOverviewSig = ovSig; RenderOverview(); }
      // The auto-fit has to wait for REAL data (ContentRendered fires before the first fetch lands, so
      // sizing there would fit an empty shell). Once the first render is in, hand the size to the user —
      // SizeToContent would otherwise override every manual resize.
      if (!sizedOnce) {
        sizedOnce = true;
        win.Dispatcher.BeginInvoke(new Action(delegate {
          win.SizeToContent = SizeToContent.Manual;
          // The default opened HUGGING the content, so a quiet board — a couple of notes — came up a
          // thin sliver. Floor it: taller content still fits (capped by MaxHeight), but a short board
          // opens at a usable size instead. The floor is the WORK-AREA height (or MaxHeight, whichever
          // is smaller), so "default" is roughly double what content-hug gave and the graph + flow
          // are visible at a glance. The user can still shrink it from here.
          double floor = Math.Min(win.MaxHeight, SystemParameters.WorkArea.Height * 0.72);
          if (win.ActualHeight < floor) win.Height = floor;
          if (!showingDetail) dtShift.X = ContentW();
        }), DispatcherPriority.Background);
      }
      // dev-only: ARC_SCOPE_AUTOOPEN=1 opens the first repo's detail on first data (for screenshots);
      // ARC_SCOPE_AUTOOPEN=<name> opens THAT repo, so a capture can target the board being debugged.
      string ao = Environment.GetEnvironmentVariable("ARC_SCOPE_AUTOOPEN");
      if (!autoOpened && repos.Count > 0 && !string.IsNullOrEmpty(ao)) {
        object pick = null;
        if (ao == "1") pick = repos[0];
        else foreach (var rp0 in repos) if (S(rp0, "name") == ao) { pick = rp0; break; }
        if (pick != null) { autoOpened = true; OpenDetail(pick); }
      }
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
    // THE REPAINT KEY. Everything the detail view DRAWS must be hashed here, or the change-gate in
    // Render() silently suppresses the redraw and the panel shows a state that has already passed.
    // It missed state/roster/pending/flow when those fields arrived, which broke BOTH headline
    // features at once (audit #235 blocker 4): a chair going active->idle changed nothing
    // hashed so the dot never repainted, and consuming a directed non-request note drained `pending`
    // while leaving board.notes and waiting[].seen untouched — so THE ARROW NEVER DISSOLVED, the one
    // invariant this graph is built on and states twice in its own comments.
    // Rule: a field added to the render is a field added here, in the same commit.
    static string RepoSig(object r) {
      var sb = new StringBuilder();
      foreach (var x in A(Get(r, "roles"))) sb.Append(S(x, "role")).Append(I(x, "pid")).Append(S(x, "activity")).Append(S(x, "state")).Append('|');
      sb.Append(";S"); foreach (var c in A(Get(r, "roster"))) sb.Append(S(c, "role")).Append(S(c, "state")).Append('|');
      sb.Append(";P"); foreach (var p in A(Get(r, "pending"))) sb.Append(I(p, "seq")).Append(S(p, "to")).Append(Bo(p, "seen") ? '1' : '0').Append('|');
      sb.Append(";F"); foreach (var f in A(Get(r, "flow"))) sb.Append(I(f, "seq")).Append(Bo(f, "open") ? '1' : '0').Append('|');
      sb.Append(";W"); foreach (var w in A(Get(r, "waiting"))) sb.Append(I(w, "seq")).Append(Bo(w, "seen") ? '1' : '0').Append('|');
      sb.Append(";R"); foreach (var m in A(Get(r, "roadmap"))) sb.Append(S(m, "title")).Append(S(m, "state")).Append(S(m, "owner")).Append('|');
      sb.Append(';').Append(I(r, "sessionCount")).Append(';').Append(I(Get(r, "board"), "notes"))
        .Append(';').Append(Bo(r, "roadmapFile") ? '1' : '0');
      // LINGER: count edges still fading on THIS repo's graph (consumed, within the window, not currently
      // pending). The count DROPS as each ages out, changing the sig, so the change-gate re-renders exactly
      // when a fading arrow should clear — and NOT on the quiet ticks between (no click-swallowing churn).
      {
        string lroot = S(r, "root"); DateTime lnow = DateTime.Now;
        var pend = new HashSet<string>();
        foreach (var p in A(Get(r, "pending"))) pend.Add(S(p, "from") + "|" + S(p, "to"));
        int settleN = 0;
        foreach (var kv in _edgeSeen) {
          if (!kv.Key.StartsWith(lroot + "")) continue;
          if ((lnow - kv.Value).TotalMilliseconds < EDGE_LINGER_MS && !pend.Contains(kv.Key.Substring(lroot.Length + 1))) settleN++;
        }
        if (settleN > 0) sb.Append(";L").Append(settleN);
      }
      return sb.ToString();
    }

    // ---- OVERVIEW ----
    // Everything the OVERVIEW draws — the same rule as RepoSig, for the same reason, on the other
    // screen. Without it RenderOverview ran on EVERY poll, tearing down and rebuilding every card
    // Button 1.5s apart, and WPF only raises Click when press AND release land on the same element:
    // a click that straddled a rebuild was silently swallowed, so cards intermittently needed a
    // second click. The gate is not an optimisation — it is what keeps the buttons clickable.
    static string OverviewSig() {
      var sb = new StringBuilder();
      foreach (var r in repos) {
        sb.Append(S(r, "name")).Append(S(r, "root")).Append(I(r, "sessionCount"))
          .Append(I(Get(r, "board"), "notes"));
        foreach (var x in A(Get(r, "roles"))) sb.Append(S(x, "role")).Append(I(x, "pid")).Append(S(x, "state")).Append(',');
        int un = 0; foreach (var w in A(Get(r, "waiting"))) if (!Bo(w, "seen")) un++;
        sb.Append(';').Append(un).Append('|');
      }
      return sb.ToString();
    }
    static string lastOverviewSig = null;

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
        foreach (var r in A(Get(repo, "roles"))) {
          string sc2 = StateColor(S(r, "state"));
          chips += "<Border Background='" + CARD + "' BorderBrush='" + HAIR + "' BorderThickness='1' CornerRadius='7' Padding='9,3,11,4' Margin='0,0,7,7'><StackPanel Orientation='Horizontal'>"
            + "<Ellipse Width='6' Height='6' Fill='" + sc2 + "' VerticalAlignment='Center' Margin='0,0,8,0'><Ellipse.Effect><DropShadowEffect BlurRadius='6' ShadowDepth='0' Color='" + sc2 + "' Opacity='0.85'/></Ellipse.Effect></Ellipse>"
            + "<TextBlock VerticalAlignment='Center'><Run Text='" + Esc(S(r, "role")) + "' FontFamily='Segoe UI' FontSize='12' Foreground='#DCE4EC'/><Run Text='  " + I(r, "pid") + "' FontFamily='" + MONO + "' FontSize='11' Foreground='" + DIM + "'/></TextBlock></StackPanel></Border>";
        }
        if (chips == "") chips = "<TextBlock FontFamily='Segoe UI' FontSize='12' FontStyle='Italic' Foreground='" + DIM + "' Text='no live roles'/>";
        int sc = I(repo, "sessionCount"); string spl = sc == 1 ? "" : "s";
        int notes = I(Get(repo, "board"), "notes");
        string badge = unseen > 0 ? "<Border Background='#2A1512' BorderBrush='#5C2521' BorderThickness='1' CornerRadius='6' Padding='6,1,6,1' VerticalAlignment='Center'><TextBlock FontFamily='" + MONO + "' FontSize='10' Foreground='" + ALERT + "' Text='" + unseen + " new'/></Border>"
                                  : "";   // no chevron — the hover lift already reads as clickable
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
      Slide(dtShift, 0); Slide(ovShift, -ContentW() * 0.22); Fade((UIElement)win.FindName("OverviewView"), 0.0);
      ((UIElement)win.FindName("DetailView")).IsHitTestVisible = true;
      ((UIElement)win.FindName("OverviewView")).IsHitTestVisible = false;
    }
    static void Back() {
      if (showingNotes) { BackFromNotes(); return; }   // the chevron always steps ONE level out
      showingDetail = false;
      Slide(dtShift, ContentW()); Slide(ovShift, 0); Fade((UIElement)win.FindName("OverviewView"), 1.0);
      ((UIElement)win.FindName("DetailView")).IsHitTestVisible = false;
      ((UIElement)win.FindName("OverviewView")).IsHitTestVisible = true;
    }

    // The full ledger, as a THIRD screen of this window. It was a separate Window; the operator asked
    // for one surface, and a second top-level window also fell out of the back-chevron model, kept
    // its own z-order, and had to re-inherit every style by hand.
    static void OpenNotes(object repo, List<object> ordered) {
      notesPanel.Children.Clear();
      ((TextBlock)win.FindName("NName")).Text = S(repo, "name");
      ((TextBlock)win.FindName("NSub")).Text = ordered.Count + " note" + (ordered.Count == 1 ? "" : "s") + "  ·  newest first";
      // LAZY, in chunks. Every row is a real control tree (header, collapsible body, its own
      // ScrollViewer), so materialising the whole ledger at once scales with the board's ENTIRE
      // history — fine at today's 60-note cap, and a way to hang or exhaust the process the moment
      // that cap moves or this screen is pointed at a fuller list. Rendering is bounded to what the
      // reader can actually see, and the next chunk arrives as they approach the end.
      notesQueue = ordered; notesShown = 0;
      AppendNotesChunk();
      notesPanel.Dispatcher.BeginInvoke(new Action(delegate {
        var sv = notesPanel.Parent as ScrollViewer;
        if (sv != null) {
          sv.ScrollToTop();
          sv.ScrollChanged -= NotesScrolled;      // idempotent: OpenNotes runs on every visit
          sv.ScrollChanged += NotesScrolled;
        }
      }), DispatcherPriority.Loaded);
      showingNotes = true;
      // The layered screens are NOT opaque — each one hides the one under it by FADING, exactly as
      // OpenDetail hides the overview. Sliding alone left the detail fully painted underneath and
      // both screens rendered on top of each other.
      Slide(ntShift, 0); Slide(dtShift, -ContentW() * 0.22); Fade((UIElement)win.FindName("DetailView"), 0.0);
      ((UIElement)win.FindName("NotesView")).IsHitTestVisible = true;
      ((UIElement)win.FindName("DetailView")).IsHitTestVisible = false;
    }
    const int NOTES_CHUNK = 20;      // rows materialised per pass — a screenful plus headroom
    static List<object> notesQueue = new List<object>();
    static int notesShown = 0;

    static void AppendNotesChunk() {
      int n = Math.Min(NOTES_CHUNK, notesQueue.Count - notesShown);
      for (int i = 0; i < n; i++) notesPanel.Children.Add(FlowNote(notesQueue[notesShown + i]));
      notesShown += n;
      // A tail marker, so "there is more" is visible rather than inferred from a scrollbar.
      if (notesShown < notesQueue.Count) {
        var more = new TextBlock();
        more.FontFamily = new FontFamily(MONO); more.FontSize = 10.5; more.Foreground = Br(DIM);
        more.Margin = new Thickness(2, 10, 0, 6);
        more.Text = "… " + (notesQueue.Count - notesShown) + " older — keep scrolling";
        more.Tag = "more"; notesPanel.Children.Add(more);
      }
    }

    static void NotesScrolled(object sender, ScrollChangedEventArgs e) {
      var sv = sender as ScrollViewer; if (sv == null || notesShown >= notesQueue.Count) return;
      // within one screenful of the end — render the next chunk BEFORE the reader reaches the gap
      if (sv.VerticalOffset + sv.ViewportHeight < sv.ExtentHeight - sv.ViewportHeight) return;
      for (int i = notesPanel.Children.Count - 1; i >= 0; i--) {
        var tb = notesPanel.Children[i] as TextBlock;
        if (tb != null && (tb.Tag as string) == "more") { notesPanel.Children.RemoveAt(i); break; }
      }
      AppendNotesChunk();
    }

    static void BackFromNotes() {
      showingNotes = false;
      Slide(ntShift, ContentW()); Slide(dtShift, 0); Fade((UIElement)win.FindName("DetailView"), 1.0);
      ((UIElement)win.FindName("NotesView")).IsHitTestVisible = false;
      ((UIElement)win.FindName("DetailView")).IsHitTestVisible = true;
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

      // The note GRAPH leads: the topology at a glance (who is sending to whom, what is still owed).
      // The text sections below stay as the readable detail — the graph never has to carry the reading.
      var graph = BuildGraph(repo, Math.Max(250, ContentW() - 30));
      if (graph != null) detail.Children.Add(graph);

      // NO "SESSIONS" list. The graph above already draws every session — live or closed — with its
      // state colour, so a list beneath it repeated the same rows in worse form. The one thing the
      // list held that the graph does not is the self-reported `activity` line; that moved onto the
      // node's tooltip rather than being dropped.

      // NOTE FLOW — the ledger, newest first, top few inline; the rest open in their own window.
      // Fed by `flow` (every note kind), NOT by `waiting` (unanswered requests only) — a board with
      // 300 notes and 2 open asks used to render two rows and look like the history had vanished.
      var flow = A(Get(repo, "flow"));
      int uc = 0; foreach (var w in flow) if (Bo(w, "open")) uc++;
      var ordered = Newest(flow);
      detail.Children.Add(Section("NOTE FLOW", flow.Count + (uc > 0 ? "  ·  " + uc + " open" : "")));
      if (ordered.Count == 0) detail.Children.Add(Empty("no notes yet"));
      firstFlowToggle = null;
      int shown = Math.Min(FLOW_INLINE, ordered.Count);
      for (int i = 0; i < shown; i++) {
        detail.Children.Add(FlowNote(ordered[i]));
        if (i == 0) firstFlowToggle = lastToggle;
      }
      if (ordered.Count > shown) detail.Children.Add(ShowAllButton(repo, ordered, ordered.Count - shown));

      // ROADMAP
      var road = A(Get(repo, "roadmap"));
      bool hasFile = Bo(repo, "roadmapFile");
      detail.Children.Add(Section("ROADMAP", road.Count + " open"));
      // "nothing parked" is a CLAIM about the repo. Only make it when there is genuinely no roadmap
      // file. When one EXISTS but holds no numbered items, say exactly that — arc reads one shape
      // and will not invent items out of whatever else the file contains.
      if (road.Count == 0) detail.Children.Add(Empty(hasFile ? "docs/ROADMAP.md has no numbered items arc reads" : "nothing parked"));
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

      var bodyB = new Border(); bodyB.Background = Br("#131A24"); bodyB.BorderBrush = Br(HAIR); bodyB.BorderThickness = new Thickness(2, 0, 0, 0); bodyB.CornerRadius = new CornerRadius(0);
      bodyB.BorderBrush = Br(ACCENT); bodyB.Padding = new Thickness(11, 8, 12, 9); bodyB.Margin = new Thickness(22, 2, 2, 8); bodyB.MaxHeight = 0; bodyB.Opacity = 0;
      var inner = new StackPanel();
      var bm = new TextBlock(); bm.FontFamily = new FontFamily(MONO); bm.FontSize = 10; bm.Foreground = Br(DIM); bm.Text = from + " " + arrow + " " + to + "  ·  " + meta.Replace("  ·  ", " · "); bm.Margin = new Thickness(0, 0, 0, 5);
      var bt = new TextBlock(); bt.FontSize = 12.5; bt.Foreground = Br("#CDD8E4"); bt.TextWrapping = TextWrapping.Wrap; bt.Text = body.Length > 0 ? body : "(no content)";
      inner.Children.Add(bm); inner.Children.Add(bt);
      // A long note used to be CLIPPED mid-sentence at the expand height with no way to read the rest.
      // Scroll inside the box instead, so any length is reachable.
      var bsv = new ScrollViewer();
      bsv.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
      bsv.HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
      bsv.Content = inner;
      bodyB.Child = bsv;

      bool[] open = new bool[] { false };
      Action doToggle = delegate {
        open[0] = !open[0];
        var ha = new DoubleAnimation(open[0] ? 300 : 0, new Duration(TimeSpan.FromMilliseconds(260))); ha.EasingFunction = EASE;
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

    const int FLOW_INLINE = 5;   // note-flow rows shown inline; the rest live behind "show all"

    // Newest first. The board's seq is monotonic (append-only ledger), so DESCENDING seq is exactly
    // reverse-chronological — and it beats parsing ts, which can be absent or malformed on a note.
    static List<object> Newest(List<object> items) {
      var l = new List<object>(items);
      l.Sort(delegate (object a, object b) { return I(b, "seq") - I(a, "seq"); });
      return l;
    }

    // One NOTE FLOW row — shared by the inline list and the show-all window so they cannot drift.
    static UIElement FlowNote(object w) {
      bool op = Bo(w, "open");                                  // still awaiting an answer
      // A BLOCKER or CORRECTION is flagged in the list too, not only on the graph — the list is where
      // a reader scrolls, and an alert that only shows on an edge is missed whenever nothing is owed.
      bool alert = S(w, "priority") == "high";
      string kind = S(w, "kind");
      string to = S(w, "to");
      if (to.Length == 0) to = "all";                           // a broadcast has no single recipient
      string meta = "#" + I(w, "seq") + "  ·  " + Ago(S(w, "ts"));
      if (alert && kind.Length > 0) meta = kind.ToUpperInvariant() + "  ·  " + meta;
      return Note(alert || op, S(w, "from"), "→", to, alert ? ALERT : ACCENT, alert ? ALERT : op ? ALERT : WAIT,
                  meta, S(w, "text"));
    }

    static UIElement ShowAllButton(object repo, List<object> ordered, int hidden) {
      var b = new Button();
      b.Style = (Style)win.FindResource("NoteBtn");
      b.HorizontalAlignment = HorizontalAlignment.Left;
      b.Margin = new Thickness(0, 3, 0, 0);
      var t = new TextBlock(); t.FontFamily = new FontFamily(MONO); t.FontSize = 11.5; t.Foreground = Br(ACCENT);
      t.Text = "show all " + ordered.Count + "   (+" + hidden + " more)";
      b.Content = t;
      var rp = repo; var list = ordered;
      b.Click += delegate { ShowAllNotes(rp, list); };
      return b;
    }

    static void Log(string s) {
      try { System.IO.File.AppendAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "arc-scope-error.log"),
            DateTime.Now.ToString("HH:mm:ss") + "  " + s + "\r\n"); } catch { }
    }
    // The FULL note flow — a third SCREEN of this window (see OpenNotes), never a second window.
    static void ShowAllNotes(object repo, List<object> ordered) {
      try { OpenNotes(repo, ordered); }
      catch (Exception ex) { Log("[show-all] " + ex.GetType().Name + ": " + ex.Message); }
    }

    // ================= the note GRAPH =================
    // Sessions-as-roles are nodes; every pending note A->B is an arrow. MANY notes A->B collapse into
    // ONE arrow (14 parallel lines between the same pair is unreadable) labelled with as many ids as
    // the edge length affords, then "and more". Red while anything on it is unseen. When notes are
    // consumed the arrow thins and, at zero, dissolves — the board's "a note is owed until consumed"
    // invariant expressed as motion instead of a number.
    const double GRAPH_H = 200;
    static Dictionary<string, int> prevEdges = new Dictionary<string, int>();
    static string prevEdgesRoot = null;

    static double TextW(string s, double size, string family) {
      var ft = new FormattedText(s, CultureInfo.InvariantCulture, FlowDirection.LeftToRight,
        new Typeface(new FontFamily(family), FontStyles.Normal, FontWeights.Normal, FontStretches.Normal),
        size, Brushes.White);
      return ft.Width;
    }

    // Node placement: 1 centred, 2 stacked vertically (a narrow panel gives more label room that way),
    // 3+ evenly on a circle. Deliberately capped at a handful of roles, which is what a board has.
    // A note's sender is one of THREE things, and only the first is a session on this board:
    //   "research"    a peer here                       -> a normal node
    //   "arc/code"    a session on ANOTHER board, writing across with `--board`. arc-notes.js:458
    //                 always qualifies it as `<board>/<role>` precisely so a stranger's `code` is
    //                 not confused with ours -> an OUTSIDE node, drawn apart from the circle
    //   "arc"         arc ITSELF (the freshness brief, arc-invite.js:765) — a tool, not a peer
    //                 -> no node at all; it has no session, no state, and nothing to cooperate with
    // (`arc` is therefore a RESERVED sender name: a role literally called "arc" would be hidden here.)
    static bool IsOutside(string name) { return name.IndexOf('/') >= 0; }
    static bool IsSystem(string name) { return name == "arc"; }

    // Nodes are laid on a circle whose RADIUS is derived from what the pills actually measure, not a
    // fixed fraction of the canvas. At a fixed radius the pills overlapped as soon as a board had
    // more than a few sessions (whalephone drew 7 and two of them collided) — the circle has to be
    // big enough to seat the circumference its own labels need.
    // ============ LAYERED LAYOUT (Sugiyama), top -> bottom ============
    // Replaces a ring. A ring was the WORST geometry available here: every edge becomes a chord
    // through the interior, and the interior is exactly where every edge label wants to sit — so it
    // manufactured the collisions the label placer then failed to solve. It also encoded nothing,
    // which for a DIRECTED graph is a real loss. (research #239/#241.)
    // Layered is deterministic by construction — no seed, no settling, no rotation drift — which
    // matters more than quality here: a drawing that jitters between renders is worse than a plain
    // one. Every tie is broken on a STABLE key so the same data always yields the same picture.
    // Vertical flow because the panel's height is elastic and its width is fixed: rows cost 28px,
    // columns cost 70-130px, so the axis we can afford to subdivide is the one we layer along.
    class GN {
      public string Id; public double W, H; public bool IsLabel;
      public int Layer, Order; public double X, Y;
    }

    // ============ CIRCULAR LAYOUT ============
    // Sessions are PEERS — five or six of them all messaging each other, with no hierarchy. A layered
    // layout exists to show FLOW, so on peer data it MANUFACTURES a hierarchy that is not there and
    // charges for it in depth, wasted width, and long back-edges. A ring asserts no hierarchy, which
    // is the honest claim, and n=5-6 is comfortably inside where circular layouts are documented to
    // work (research #247, reversing its own #239).
    //
    // This is NOT the ring that was abandoned earlier. Four things differ, and they are the ones that
    // made the old one fail — the ring is not the deliverable, these are:
    //   1. node ORDER is chosen to shorten edges (it was arbitrary),
    //   2. long edges route OUTSIDE the ring (every edge used to be a chord through the middle,
    //      which is exactly where the labels want to live),
    //   3. edges are CURVED (they were straight chords),
    //   4. the label machinery from the layered build — fixed budget, 2D candidates — is kept.
    //
    // NO EDGE BUNDLING, deliberately. Bundling trades individual edge traceability for high-level
    // pattern, and tracing "who owes whom" is this view's whole job; the AVI study measures it as a
    // loss in both accuracy and time. It can also merge two disconnected edges into an implied
    // relationship that does not exist. At 0-6 edges there is no clutter to remedy anyway.

    // Same question for a CURVE. Bowing "outward from the ring centre" is a good default and a blind
    // one: on the left of a circle, outward means left, and if a session happens to sit there the
    // detour drives straight through it — which is what a two-way arc did to `uiux`. So the bow is
    // tested like any other path, and flipped when it would collide.
    static bool CurveHitsNode(Point a, Point c, Point b, string fromId, string toId,
                              Dictionary<string, Point> pos,
                              Dictionary<string, double> halfW, Dictionary<string, double> halfH) {
      foreach (var kv in pos) {
        if (kv.Key == fromId || kv.Key == toId) continue;
        double hw = halfW.ContainsKey(kv.Key) ? halfW[kv.Key] : 35;
        double hh = halfH.ContainsKey(kv.Key) ? halfH[kv.Key] : 14;
        var r = new Rect(kv.Value.X - hw - 5, kv.Value.Y - hh - 4, hw * 2 + 10, hh * 2 + 8);
        for (int s = 1; s < 24; s++) {
          double t = s / 24.0, u = 1 - t;
          var p = new Point(u * u * a.X + 2 * u * t * c.X + t * t * b.X,
                            u * u * a.Y + 2 * u * t * c.Y + t * t * b.Y);
          if (r.Contains(p)) return true;
        }
      }
      return false;
    }

    // Would a STRAIGHT line from a to b run through some other session's pill? That — not distance,
    // not aesthetics — is what earns an edge its curve. Sampled rather than solved: at n<=10 with a
    // handful of edges, walking the segment is trivially cheap and cannot get the geometry subtly
    // wrong the way a rect/segment intersection test can.
    static bool ChordHitsNode(Point a, Point b, string fromId, string toId,
                              Dictionary<string, Point> pos,
                              Dictionary<string, double> halfW, Dictionary<string, double> halfH) {
      foreach (var kv in pos) {
        if (kv.Key == fromId || kv.Key == toId) continue;          // its own endpoints never count
        double hw = halfW.ContainsKey(kv.Key) ? halfW[kv.Key] : 35;
        double hh = halfH.ContainsKey(kv.Key) ? halfH[kv.Key] : 14;
        var r = new Rect(kv.Value.X - hw - 5, kv.Value.Y - hh - 4, hw * 2 + 10, hh * 2 + 8);
        for (int s = 1; s < 20; s++) {
          double t = s / 20.0;
          if (r.Contains(new Point(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t))) return true;
        }
      }
      return false;
    }

    // RING ORDER IS ALPHABETICAL. Full stop.
    // It used to be 2-opt, reordering nodes to shorten edges — which is the textbook improvement and
    // was the wrong trade here. It made the ring's positions depend on the CURRENT NOTES, so a
    // session moved around the circle whenever traffic changed, and the drawing never looked like the
    // same drawing twice. A fixed alphabetical ring is predictable: a session is always in the same
    // place, you learn where to look, and edges simply cross where they cross. (Operator's call.)
    static List<string> RingOrder(List<string> nodes, Dictionary<string, List<string>> adj) {
      var o = new List<string>(nodes);
      o.Sort(delegate (string a, string b) { return string.CompareOrdinal(a, b); });
      return o;
    }

    // P1 CYCLE REMOVAL — reverse back-edges found by DFS so ranking terminates. Two-cycles (A->B and
    // B->A, the ordinary case here when two peers owe each other) are exactly what this handles.
    // The reversal is for LAYOUT ONLY; drawing still uses the true direction.
    static void BreakCycles(List<GN> ns, List<int[]> es) {
      var state = new int[ns.Count];                 // 0 unvisited, 1 on-stack, 2 done
      var adj = new List<List<int>>();
      for (int i = 0; i < ns.Count; i++) adj.Add(new List<int>());
      for (int i = 0; i < es.Count; i++) adj[es[i][0]].Add(i);
      var stack = new List<int>();
      for (int s = 0; s < ns.Count; s++) {
        if (state[s] != 0) continue;
        stack.Clear(); stack.Add(s);
        var it = new Dictionary<int, int>(); it[s] = 0; state[s] = 1;
        while (stack.Count > 0) {
          int v = stack[stack.Count - 1];
          if (it[v] < adj[v].Count) {
            int ei = adj[v][it[v]]; it[v]++;
            int u = es[ei][1];
            if (state[u] == 1) { int t = es[ei][0]; es[ei][0] = es[ei][1]; es[ei][1] = t; }  // back edge -> reverse
            else if (state[u] == 0) { state[u] = 1; stack.Add(u); if (!it.ContainsKey(u)) it[u] = 0; }
          } else { state[v] = 2; stack.RemoveAt(stack.Count - 1); }
        }
      }
    }

    // P2 LAYERING — longest path. Rank(v) = 1 + max(rank(preds)); sources land on layer 0.
    static void AssignLayers(List<GN> ns, List<int[]> es) {
      bool moved = true; int guard = 0;
      for (int i = 0; i < ns.Count; i++) ns[i].Layer = 0;
      while (moved && guard++ < ns.Count + 4) {
        moved = false;
        foreach (var e in es) {
          if (ns[e[1]].Layer < ns[e[0]].Layer + 1) { ns[e[1]].Layer = ns[e[0]].Layer + 1; moved = true; }
        }
      }
    }

    // P3 ORDERING — barycenter sweeps with a STABLE tie-break. Fixed pass count (no convergence
    // loop): at n<=10 four passes each way is past the point of return, and a fixed count is what
    // keeps the result reproducible.
    static void OrderLayers(List<GN> ns, List<int[]> es, int layerCount) {
      var byLayer = new List<List<int>>();
      for (int L = 0; L < layerCount; L++) byLayer.Add(new List<int>());
      for (int i = 0; i < ns.Count; i++) byLayer[ns[i].Layer].Add(i);
      // stable seed: alphabetical by id, so an unconnected graph is still deterministic
      for (int L = 0; L < layerCount; L++) {
        byLayer[L].Sort(delegate (int a, int b) { return string.CompareOrdinal(ns[a].Id, ns[b].Id); });
        for (int k = 0; k < byLayer[L].Count; k++) ns[byLayer[L][k]].Order = k;
      }
      for (int pass = 0; pass < 4; pass++) {
        for (int dir = 0; dir < 2; dir++) {
          for (int L = 0; L < layerCount; L++) {
            int cur = dir == 0 ? L : layerCount - 1 - L;
            var bary = new Dictionary<int, double>();
            foreach (int vi in byLayer[cur]) {
              double sum = 0; int cnt = 0;
              foreach (var e in es) {
                if (dir == 0 && e[1] == vi) { sum += ns[e[0]].Order; cnt++; }
                if (dir == 1 && e[0] == vi) { sum += ns[e[1]].Order; cnt++; }
              }
              bary[vi] = cnt > 0 ? sum / cnt : ns[vi].Order;
            }
            byLayer[cur].Sort(delegate (int a, int b) {
              int c = bary[a].CompareTo(bary[b]);
              return c != 0 ? c : string.CompareOrdinal(ns[a].Id, ns[b].Id);   // STABLE tie-break
            });
            for (int k = 0; k < byLayer[cur].Count; k++) ns[byLayer[cur][k]].Order = k;
          }
        }
      }
    }

    // P4/P5 COORDINATES — pack each layer left to right, centre it, then nudge toward the average x
    // of connected neighbours (a few passes). Brandes-Kopf is the "good" answer; at n<=10 this is
    // indistinguishable and a fraction of the code.
    static void PlaceCoords(List<GN> ns, List<int[]> es, int layerCount, double width) {
      const double GAP_X = 20, GAP_Y = 40;   // GAP_Y must fit a label chip (20px) plus air
      var byLayer = new List<List<GN>>();
      for (int L = 0; L < layerCount; L++) byLayer.Add(new List<GN>());
      foreach (var n in ns) byLayer[n.Layer].Add(n);
      for (int L = 0; L < layerCount; L++)
        byLayer[L].Sort(delegate (GN a, GN b) { return a.Order.CompareTo(b.Order); });

      // SPREAD EACH ROW ACROSS THE WIDTH, do not pack-and-centre. Packing left every row in a narrow
      // column down the middle: edges converged at steep angles, and their midpoints — where the
      // labels go — all landed in the same small band, so chips piled on top of each other while
      // most of the canvas sat empty. Widening the gaps fans the edges out and hands the label
      // placer the room it needs, at no cost.
      // A LAYER THAT DOES NOT FIT MUST WRAP. This is not an edge case, it is the COMMON case: with no
      // pending notes there are no edges, so every session lands on layer 0 and five pills at ~100px
      // each were crammed into one 380px row, overlapping each other into an unreadable smear. The
      // re-separation pass could not save it — the row simply did not fit, and clamping to the canvas
      // just stacked them. So each layer is chunked into as many sub-rows as the width needs.
      double usable = width - 16;
      double y = 0;
      for (int L = 0; L < layerCount; L++) {
        var layer = byLayer[L];
        // chunk in ORDER, so the crossing-reduction result survives the wrap
        var chunks = new List<List<GN>>(); var cur2 = new List<GN>(); double runW = 0;
        foreach (var n in layer) {
          double add = (cur2.Count > 0 ? GAP_X : 0) + n.W;
          if (cur2.Count > 0 && runW + add > usable) { chunks.Add(cur2); cur2 = new List<GN>(); runW = 0; add = n.W; }
          cur2.Add(n); runW += add;
        }
        if (cur2.Count > 0) chunks.Add(cur2);

        foreach (var row in chunks) {
          double hmax = 0; foreach (var n in row) if (n.H > hmax) hmax = n.H;
          double sumW = 0; foreach (var n in row) sumW += n.W;
          // share the slack between the nodes, but never let two pills drift so far apart that the row
          // stops reading as a row
          double gap = row.Count > 1 ? Math.Min(72, Math.Max(GAP_X, (usable - sumW) / (row.Count - 1))) : GAP_X;
          double total = sumW + gap * Math.Max(0, row.Count - 1);
          double x = (width - total) / 2; if (x < 8) x = 8;
          foreach (var n in row) { n.X = x + n.W / 2; n.Y = y + hmax / 2; x += n.W + gap; }
          y += hmax + (chunks.Count > 1 ? GAP_Y * 0.55 : GAP_Y);   // tighter between wrapped sub-rows
        }
        if (chunks.Count > 1) y += GAP_Y * 0.45;                   // ...but a full gap before the next layer
      }
      // the straighten pass below re-separates within byLayer[L]; after a wrap that list spans several
      // sub-rows, so re-group it by the y actually assigned or it will drag wrapped nodes back together
      var rowsByY = new Dictionary<double, List<GN>>();
      foreach (var n in ns) { if (!rowsByY.ContainsKey(n.Y)) rowsByY[n.Y] = new List<GN>(); rowsByY[n.Y].Add(n); }
      byLayer.Clear();
      foreach (var kv in rowsByY) {
        kv.Value.Sort(delegate (GN a, GN b) { return a.X.CompareTo(b.X); });
        byLayer.Add(kv.Value);
      }
      layerCount = byLayer.Count;
      // straighten: pull each node toward its neighbours' average x, then re-separate within the row
      for (int pass = 0; pass < 3; pass++) {
        foreach (var n in ns) {
          double sum = 0; int cnt = 0;
          foreach (var e in es) {
            if (ns[e[0]] == n) { sum += ns[e[1]].X; cnt++; }
            if (ns[e[1]] == n) { sum += ns[e[0]].X; cnt++; }
          }
          if (cnt > 0) n.X += (sum / cnt - n.X) * 0.5;
        }
        for (int L = 0; L < layerCount; L++) {
          var row = byLayer[L];
          for (int k = 1; k < row.Count; k++) {
            double minX = row[k - 1].X + row[k - 1].W / 2 + GAP_X + row[k].W / 2;
            if (row[k].X < minX) row[k].X = minX;
          }
          for (int k = row.Count - 2; k >= 0; k--) {
            double maxX = row[k + 1].X - row[k + 1].W / 2 - GAP_X - row[k].W / 2;
            if (row[k].X > maxX) row[k].X = maxX;
          }
          // keep the row inside the canvas
          foreach (var n in row) {
            if (n.X - n.W / 2 < 6) n.X = 6 + n.W / 2;
            if (n.X + n.W / 2 > width - 6) n.X = width - 6 - n.W / 2;
          }
        }
      }
    }

    static Dictionary<string, Point> LayoutNodes(List<string> nodes, Dictionary<string, double> halfW, double w, double cy) {
      var d = new Dictionary<string, Point>();
      int n = nodes.Count; double cx = w / 2;
      if (n == 0) return d;
      if (n == 1) { d[nodes[0]] = new Point(cx, cy); return d; }
      if (n == 2) { d[nodes[0]] = new Point(cx, cy - 46); d[nodes[1]] = new Point(cx, cy + 46); return d; }
      // AN ELLIPSE, NOT A CIRCLE. The panel is tall and narrow, so a circle is bounded by the ONE
      // dimension that is scarce: the radius the width allows was far smaller than the spacing five
      // pills need, and they ended up shoulder to shoulder with their labels on top of each other.
      // Height is the dimension we actually have. So take whatever horizontal radius fits, then
      // stretch VERTICALLY until the perimeter can seat every pill.
      double need = 0;
      foreach (var k in nodes) need += (halfW.ContainsKey(k) ? halfW[k] * 2 : 70) + 40;   // width + gap
      double rIdeal = need / (2 * Math.PI);                        // the radius a circle would want

      double cap = (w / 2) - 12;                                   // never push a pill off the canvas
      double rx = rIdeal;
      foreach (var k in nodes) { double lim = cap - (halfW.ContainsKey(k) ? halfW[k] : 35); if (lim < rx) rx = Math.Max(40, lim); }

      // Perimeter of an ellipse ≈ 2π·sqrt((rx²+ry²)/2). Solve that for the ry which restores the
      // circumference the pills need once rx has been clamped by the window.
      double ry = Math.Sqrt(Math.Max(rx * rx, 2 * rIdeal * rIdeal - rx * rx));
      ry = Math.Max(ry, Math.Min(58, rIdeal));                     // a floor, so two or three nodes still separate
      ry = Math.Min(ry, 230);                                      // ...and a ceiling, so the graph cannot run away

      for (int i = 0; i < n; i++) {
        double a = -Math.PI / 2 + i * 2 * Math.PI / n;
        d[nodes[i]] = new Point(cx + rx * Math.Cos(a), cy + ry * Math.Sin(a));
      }
      return d;
    }

    // Fit as many "#id" as the budget allows; always at least one; append "and more" when truncated.
    static string EdgeLabel(List<object> notes, double budget) {
      var ids = new List<string>();
      foreach (var n in notes) ids.Add("#" + I(n, "seq"));
      int fit = 0;
      for (int k = 1; k <= ids.Count; k++) {
        string cand = string.Join(", ", ids.GetRange(0, k).ToArray()) + (k < ids.Count ? " and more" : "");
        if (TextW(cand, 10.5, MONO) <= budget) fit = k; else break;
      }
      if (fit == 0) fit = 1;   // never show nothing — one id plus "and more" may overflow slightly
      return string.Join(", ", ids.GetRange(0, Math.Min(fit, ids.Count)).ToArray()) + (fit < ids.Count ? " and more" : "");
    }

    // stop the line at the node's rounded-rect boundary rather than its centre
    // Stop the line on the node's ROUNDED boundary. A plain box intersection (min of halfW/|ux| and
    // halfH/|uy|) is right for a rectangle and wrong for these pills: they carry a 14px corner
    // radius, so on any diagonal approach the box corner lies well outside the drawn shape and the
    // head landed off to one side of the edge with a visible gap, instead of touching it.
    // Shrink the box by the radius, intersect that, then push back out along the ray by the radius:
    // the result tracks the rounded outline on the straight runs AND around the corners.
    const double PILL_R = 14;
    static Point Inset(Point from, Point to, double halfW, double halfH) {
      double dx = to.X - from.X, dy = to.Y - from.Y;
      double len = Math.Sqrt(dx * dx + dy * dy); if (len < 0.001) return to;
      double ux = dx / len, uy = dy / len;
      double r = Math.Min(PILL_R, Math.Min(halfW, halfH) - 1); if (r < 0) r = 0;
      double iw = Math.Max(1, halfW - r), ih = Math.Max(1, halfH - r);
      double tx = Math.Abs(ux) < 1e-6 ? 1e9 : iw / Math.Abs(ux);
      double ty = Math.Abs(uy) < 1e-6 ? 1e9 : ih / Math.Abs(uy);
      double t = Math.Min(tx, ty) + r + 3;      // + a small breathing gap so the tip is not welded on
      return new Point(to.X - ux * t, to.Y - uy * t);
    }

    // ---- CARDINAL-PORT edge anchoring (operator design, 2026-07-21) -------------------------------
    // A card exposes four ports — the mid-points of its right/bottom/left/top edges. Every connection
    // is assigned a DISTINCT port per card (the one nearest the neighbour's direction; conflicts are
    // pushed to the next free port), and the TWO directions of a pair take two PARALLEL slots on that
    // port's side. So no directed edge shares a start or end point with another, and a card's arrows
    // spread across its sides instead of piling on one anchor — the operator's overlap fix. Replaces
    // the old centre-to-centre boundary anchoring (Inset), which put every edge on the same point.
    const double EDGE_SLOT = 6;    // half the gap between a pair's two directions, at the card
    const double EDGE_BOW  = 16;   // how far the bezier bows; the two directions bow to opposite sides
    const double EDGE_GAP  = 1;    // tiny float OUTSIDE the card edge — the head nearly touches, doesn't hover high
    const double HEAD_LIFT = 6;    // arrowhead TIP floats this far back OUTSIDE the card (bigger = retreated
    // LINGER: `pending` is the live truth, but a note read the INSTANT it lands leaves pending before the
    // eye catches the arrow. Keep a just-consumed edge on the graph for EDGE_LINGER_MS, drawn faint, then
    // drop it — display-only; it only DELAYS an edge's removal, never invents one. Keyed "root\x01from|to".
    const double EDGE_LINGER_MS = 10000;   // keep a just-consumed edge on the graph this long, drawn faint
    static readonly Dictionary<string, DateTime> _edgeSeen = new Dictionary<string, DateTime>();  // -> last time PENDING
    static readonly Dictionary<string, object>   _edgeNote = new Dictionary<string, object>();     // -> its newest note (faint label)
    static readonly double[] SIDE_ANGLE = { 0, 90, 180, 270 };   // R, B, L, T (screen y-down)
    // Cards are WIDE pills, so their top/bottom edges are long and their left/right edges short. A
    // neighbour sitting DIAGONALLY (near a 45° corner) reads better entering the long edge than being
    // crammed onto the short side — so give the vertical sides (T,B) a small edge on the near-45° call.
    // Modest on purpose: a clearly side-on neighbour (well past the diagonal) still takes left/right.
    const double VERT_BIAS = 22;   // degrees; shifts the top/right decision boundary from 315° to ~326°
    static double AngGap(double a, double b) { double d = Math.Abs(a - b) % 360; return d > 180 ? 360 - d : d; }
    static double BestGap(double a) { double b = 1e9; foreach (var pa in SIDE_ANGLE) b = Math.Min(b, AngGap(a, pa)); return b; }
    static Point PortPoint(Point c, double hw, double hh, int side) {
      switch (side) {                                       // + EDGE_GAP outward, so the wire/head floats off the card
        case 0: return new Point(c.X + hw + EDGE_GAP, c.Y);   // right-middle
        case 1: return new Point(c.X, c.Y + hh + EDGE_GAP);   // bottom-centre
        case 2: return new Point(c.X - hw - EDGE_GAP, c.Y);   // left-middle
        default: return new Point(c.X, c.Y - hh - EDGE_GAP);  // top-centre
      }
    }
    // OUTWARD normal of a card side (screen y-down): R:+x, B:+y, L:-x, T:-y. A wire leaves/arrives ALONG
    // this so it meets the card square; the arrowhead points the OPPOSITE way (into the card).
    static double SideNX(int side) { return side == 0 ? 1 : side == 2 ? -1 : 0; }
    static double SideNY(int side) { return side == 1 ? 1 : side == 3 ? -1 : 0; }
    // node -> (neighbour -> distinct side index). The most "decided" neighbour (closest to a cardinal
    // direction) claims its side first, so a clear direction is never bumped; a node with >4 neighbours
    // (rare) lets the extras share the nearest side rather than crash.
    static Dictionary<string, Dictionary<string, int>> AssignSides(
        List<string> nodes, Dictionary<string, Point> pos, Dictionary<string, HashSet<string>> nbr) {
      var res = new Dictionary<string, Dictionary<string, int>>();
      foreach (var n in nodes) {
        if (!pos.ContainsKey(n) || !nbr.ContainsKey(n)) continue;
        var ideal = new List<KeyValuePair<string, double>>();
        foreach (var m in nbr[n]) {
          if (!pos.ContainsKey(m)) continue;
          double ang = Math.Atan2(pos[m].Y - pos[n].Y, pos[m].X - pos[n].X) * 180 / Math.PI; if (ang < 0) ang += 360;
          ideal.Add(new KeyValuePair<string, double>(m, ang));
        }
        ideal.Sort((x, y) => BestGap(x.Value).CompareTo(BestGap(y.Value)));
        // The vertical bias favours top/bottom on a near-45 call. It HELPS a sparse leaf reach the long
        // pill edge (uiux's 1 neighbour, a 315 edge, correctly tips to TOP), but on a busier node it shoves
        // a down-diagonal edge onto the BOTTOM when nearest-cardinal would (correctly) give it the LEFT —
        // MEASURED from the live layout: android at 3 neighbours put its 135 uiux edge on the bottom, not
        // the left. So bias only LEAF-ish nodes (<=2 neighbours); a node with 3+ uses pure nearest-cardinal,
        // which distributes its edges across all four sides cleanly (android -> research=B, frontend=R, uiux=L).
        bool biasVert = ideal.Count <= 2;
        var used = new HashSet<int>(); var map = new Dictionary<string, int>();
        foreach (var kv in ideal) {
          int best = -1; double bd = 1e9;
          for (int p = 0; p < 4; p++) { if (used.Contains(p)) continue; double d = AngGap(kv.Value, SIDE_ANGLE[p]) - (biasVert && (p == 1 || p == 3) ? VERT_BIAS : 0); if (d < bd) { bd = d; best = p; } }
          if (best < 0) for (int p = 0; p < 4; p++) { double d = AngGap(kv.Value, SIDE_ANGLE[p]) - (biasVert && (p == 1 || p == 3) ? VERT_BIAS : 0); if (d < bd) { bd = d; best = p; } }  // >4 neighbours: share
          if (best >= 0) { used.Add(best); map[kv.Key] = best; }
        }
        res[n] = map;
      }
      return res;
    }

    // A session on ANOTHER board. Deliberately unlike a node pill: DASHED border, no state dot
    // (arc knows nothing about its state from here — it lives in a different board's ledger), and
    // the board it belongs to shown dim ahead of its role, so "arc/code" reads as "code, over on arc"
    // rather than as a peer of ours with a strange name.
    static Border OutsidePill(string qualified) {
      int cut = qualified.IndexOf('/');
      string boardName = cut > 0 ? qualified.Substring(0, cut) : "";
      string role = cut >= 0 ? qualified.Substring(cut + 1) : qualified;
      var b = new Border();
      b.ToolTip = role + " — a session on the \"" + boardName + "\" board, not this one";
      // A WPF Border cannot dash its own edge, so the SEPARATION is carried by the dashed rule and
      // caption above the row; the pill itself just reads flatter and dimmer than a real node.
      b.Background = Br("#141B25");
      b.BorderBrush = Br("#2A3646"); b.BorderThickness = new Thickness(1);
      b.CornerRadius = new CornerRadius(12);
      b.Padding = new Thickness(9, 4, 10, 5);
      var t = new TextBlock(); t.VerticalAlignment = VerticalAlignment.Center;
      t.Inlines.Add(RunC(boardName + "/", DIM, MONO));
      t.Inlines.Add(RunC(role, TXT2, MONO));
      b.Child = t;
      return b;
    }

    // `pid` and `activity` are "" for a closed node — it has no live session to report either.
    // The hover card. Removing the SESSIONS list took away the only place that answered "what is
    // this session doing" — this is where that answer lives now, and it is deliberately built from
    // EVIDENCE rather than self-report: `arc status` is optional and most sessions never call it, so
    // a card that only showed `activity` would be blank exactly when it mattered. The heartbeat
    // (when the transcript last grew) and the session's own most recent note are always there.
    static UIElement NodeCard(string role, string state, int pid, string activity, string lastTurn, string doing, string task) {
      // A ToolTip inherits the SYSTEM's light chrome — the previous card put this dark-theme text on
      // a near-white popup and was unreadable. The card carries its own surface.
      var shell = new Border();
      shell.Background = Br("#0F151F");
      shell.BorderBrush = Br("#2E3A4A"); shell.BorderThickness = new Thickness(1);
      shell.CornerRadius = new CornerRadius(8);
      shell.Padding = new Thickness(12, 10, 12, 11);
      // This card is READ, not glanced at — it carries a sentence of the session's own thinking. It
      // was sized like a tooltip (10.5-12.5pt in a 400px column) and came out cramped, so the whole
      // card is a step larger and wider.
      var sp = new StackPanel(); sp.MaxWidth = 460; shell.Child = sp;

      var head = new TextBlock(); head.Margin = new Thickness(0, 0, 0, 6); head.FontSize = 12.5;
      head.Inlines.Add(RunC(role, TXT, MONO));
      if (pid > 0) head.Inlines.Add(RunC("  " + pid, DIM, MONO));
      string when = lastTurn.Length > 0 ? "   worked " + Ago(lastTurn) + " ago" : "";
      head.Inlines.Add(RunC("   " + state, StateColor(state), MONO));
      if (when.Length > 0) head.Inlines.Add(RunC(when, DIM, MONO));
      sp.Children.Add(head);

      // THE TASK is the headline — the job, not the keystroke. "running Bash" is a true answer to the
      // wrong question; what the operator wants is "auditing the diff", "mining the OCR failures".
      // That is the last substantive thing the session's human ASKED, and it is already on disk.
      if (task.Length > 0) {
        var t = new TextBlock();
        t.TextWrapping = TextWrapping.Wrap; t.FontFamily = new FontFamily(SANS); t.FontSize = 14;
        t.Foreground = Br(TXT); t.LineHeight = 19; t.Text = task;
        sp.Children.Add(t);
      }
      // DOING is the live detail underneath — the tool running this second. Useful as corroboration
      // ("still moving"), useless as the headline, so it stays dimmer and smaller than the task.
      // NO MaxHeight. It had 46px, which is under three lines, so a real sentence — and `doing` runs
      // to 420 chars — was sliced through the middle of a word with nothing to say it had been cut.
      // A card that silently truncates is worse than a tall card.
      if (doing.Length > 0) {
        var d = new TextBlock(); d.Margin = new Thickness(0, task.Length > 0 ? 8 : 0, 0, 0);
        d.TextWrapping = TextWrapping.Wrap; d.FontFamily = new FontFamily(MONO); d.FontSize = 12;
        d.Foreground = Br(TXT2); d.LineHeight = 17;
        d.Text = doing.StartsWith("running ") ? doing : "→ " + doing;
        sp.Children.Add(d);
      }
      // The session's own `arc status` line, if it ever set one — a deliberate self-report outranks
      // nothing, but it is secondary to live evidence, so it sits under it and dimmer.
      if (activity.Length > 0) {
        var a = new TextBlock(); a.Margin = new Thickness(0, 8, 0, 0);
        a.TextWrapping = TextWrapping.Wrap; a.FontFamily = new FontFamily(MONO); a.FontSize = 12;
        a.Foreground = Br(DIM); a.Text = "self-reported: " + activity;
        sp.Children.Add(a);
      }
      if (task.Length == 0 && doing.Length == 0 && activity.Length == 0) {
        var q = new TextBlock();
        q.FontFamily = new FontFamily(SANS); q.FontSize = 13; q.FontStyle = FontStyles.Italic;
        q.Foreground = Br(DIM);
        q.Text = state == "closed" ? "closed — no session to report" : "no readable transcript";
        sp.Children.Add(q);
      }
      return shell;
    }

    static string Clip(string s, int n) {
      if (s == null) return "";
      s = s.Replace("\r", " ").Replace("\n", " ").Trim();
      return s.Length <= n ? s : s.Substring(0, n - 1) + "…";
    }

    // The freshest role record for a node, looked up at HOVER time out of the current snapshot.
    // `doing` changes every turn, so baking it into the card at render time would mean either a
    // stale card or hashing it into RepoSig — and hashing it would rebuild the detail on every turn,
    // collapsing expanded notes and re-creating the very destroy-under-the-cursor problem the
    // overview gate just fixed. Reading it on open costs nothing and is always current.
    static object LiveRole(string root, string role) {
      foreach (var rp in repos) {
        if (S(rp, "root") != root) continue;
        foreach (var r in A(Get(rp, "roles"))) if (S(r, "role") == role) return r;
      }
      return null;
    }

    static Border NodePill(string role, string state, int pid, string activity, string lastTurn, string doing, string task, string root) {
      bool live = state != "closed";
      var b = new Border();
      // Assigning a UIElement to .ToolTip wraps it in a ToolTip CONTROL that keeps its own default
      // chrome — white background, border, padding, drop shadow — so the styled dark card rendered
      // inside a white box. Strip the wrapper and let the card be the whole popup.
      var tt = new ToolTip();
      tt.Background = Brushes.Transparent;
      tt.BorderThickness = new Thickness(0);
      tt.Padding = new Thickness(0);
      tt.HasDropShadow = false;
      tt.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
      tt.VerticalOffset = 4;
      tt.Content = NodeCard(role, state, pid, activity, lastTurn, doing, task);
      // rebuild from the CURRENT snapshot each time it opens, so a card shown five minutes after the
      // last graph render still says what the session is doing now
      string rootC = root, roleC = role, stateC = state; int pidC = pid;
      tt.Opened += delegate {
        try {
          var live2 = LiveRole(rootC, roleC);
          if (live2 == null) return;   // closed since render — keep what we had rather than blank it
          tt.Content = NodeCard(roleC, S(live2, "state").Length > 0 ? S(live2, "state") : stateC,
                                pidC, S(live2, "activity"), S(live2, "lastTurn"), S(live2, "doing"), S(live2, "task"));
        } catch { }
      };
      b.ToolTip = tt;
      b.Background = Br(live ? "#1D2734" : "#161E2A");
      b.BorderBrush = Br(live ? "#2E3A4A" : HAIR);
      b.BorderThickness = new Thickness(1); b.CornerRadius = new CornerRadius(14);
      b.Padding = new Thickness(10, 5, 12, 6);
      var sp = new StackPanel(); sp.Orientation = Orientation.Horizontal;
      var d = new Ellipse(); d.Width = 6; d.Height = 6; d.Margin = new Thickness(0, 0, 7, 0);
      d.VerticalAlignment = VerticalAlignment.Center; d.Fill = Br(StateColor(state));
      if (live) Breathe(d);
      var t = new TextBlock(); t.Text = role; t.FontFamily = new FontFamily(MONO); t.FontSize = 12;
      t.Foreground = Br(live ? TXT : DIM); t.VerticalAlignment = VerticalAlignment.Center;
      sp.Children.Add(d); sp.Children.Add(t); b.Child = sp;
      return b;
    }

    static UIElement BuildGraph(object repo, double width) {
      var canvas = new Canvas(); canvas.Height = GRAPH_H; canvas.Margin = new Thickness(0, 4, 0, 2);
      var liveSet = new List<string>(); var stateOf = new Dictionary<string, string>();
      var pidOf = new Dictionary<string, int>(); var actOf = new Dictionary<string, string>();
      var turnOf = new Dictionary<string, string>(); var doingOf = new Dictionary<string, string>(); var taskOf = new Dictionary<string, string>();
      foreach (var r in A(Get(repo, "roles"))) {
        string rn = S(r, "role");
        if (rn.Length > 0 && !liveSet.Contains(rn)) {
          liveSet.Add(rn); stateOf[rn] = S(r, "state"); pidOf[rn] = I(r, "pid"); actOf[rn] = S(r, "activity");
          turnOf[rn] = S(r, "lastTurn"); doingOf[rn] = S(r, "doing"); taskOf[rn] = S(r, "task");
        }
      }
      // NODES = THE ROSTER: every chair on this board, live or closed. Membership is a CLAIM, never
      // an appearance in a note — a peer writing *about* arc's `code` once put a phantom `code`
      // node on whalephone's graph, a session that had never sat there.
      var nodes = new List<string>();
      foreach (var c in A(Get(repo, "roster"))) {
        string cn = S(c, "role");
        if (cn.Length == 0 || IsSystem(cn) || IsOutside(cn)) continue;
        if (!nodes.Contains(cn)) { nodes.Add(cn); if (!stateOf.ContainsKey(cn)) stateOf[cn] = S(c, "state"); }
      }
      foreach (var r in liveSet) if (!nodes.Contains(r)) nodes.Add(r);   // a claim arriving mid-poll

      // OUTSIDE = a session on another board, shown ONLY while it has a note still PENDING here.
      // Once its notes are consumed the cooperation is over, and a node that lingers claims a
      // relationship that has ended — the same rule the edges follow when they dissolve.
      // EDGES come from `pending` — notes the recipient has NOT CONSUMED. NOT from `waiting`, which
      // is unanswered REQUESTS: a request stays open long after it was read, so the graph showed a
      // quiz→research arrow for a note consumed days earlier while live traffic drew nothing.
      // "Dissolve when consumed" is the rule, so `pending` is the only honest source.
      var waiting = A(Get(repo, "pending"));
      var outside = new List<string>();
      foreach (var w in waiting) {
        string f = S(w, "from");
        if (f.Length > 0 && IsOutside(f) && !outside.Contains(f)) outside.Add(f);
      }
      if (nodes.Count == 0 && outside.Count == 0) return null;

      // bundle: one entry per (from -> to)
      var order = new List<string>(); var groups = new Dictionary<string, List<object>>();
      foreach (var w in waiting) {
        string k = S(w, "from") + "|" + S(w, "to");
        if (!groups.ContainsKey(k)) { groups[k] = new List<object>(); order.Add(k); }
        groups[k].Add(w);
      }
      // LINGER pass: stamp each LIVE edge's time+note, then re-add recently-consumed edges (drawn faint,
      // no longer in `pending`) so a note read the instant it lands still shows an arrow that ages out.
      var settling = new HashSet<string>();
      {
        string groot = S(repo, "root"); DateTime gnow = DateTime.Now;
        foreach (var lk in new List<string>(groups.Keys)) {
          var nl = Newest(groups[lk]); _edgeSeen[groot + "" + lk] = gnow; _edgeNote[groot + "" + lk] = nl.Count > 0 ? nl[0] : null;
        }
        foreach (var sk in new List<string>(_edgeSeen.Keys)) {
          if (!sk.StartsWith(groot + "")) continue;
          string ek = sk.Substring(groot.Length + 1);
          if ((gnow - _edgeSeen[sk]).TotalMilliseconds >= EDGE_LINGER_MS) { _edgeSeen.Remove(sk); _edgeNote.Remove(sk); continue; }
          if (groups.ContainsKey(ek)) continue;                          // still live — not settling
          string[] ep = ek.Split('|');
          if (ep.Length != 2 || !nodes.Contains(ep[0]) || !nodes.Contains(ep[1])) continue;  // an endpoint is gone
          groups[ek] = new List<object>(); if (_edgeNote.ContainsKey(sk) && _edgeNote[sk] != null) groups[ek].Add(_edgeNote[sk]);
          order.Add(ek); settling.Add(ek);
        }
      }
      var pills = new Dictionary<string, Border>(); var halfW = new Dictionary<string, double>(); var halfH = new Dictionary<string, double>();
      foreach (var n in nodes) {
        var pill = NodePill(n, stateOf.ContainsKey(n) ? stateOf[n] : "closed",
                            pidOf.ContainsKey(n) ? pidOf[n] : 0,
                            actOf.ContainsKey(n) ? actOf[n] : "",
                            turnOf.ContainsKey(n) ? turnOf[n] : "",
                            doingOf.ContainsKey(n) ? doingOf[n] : "",
                            taskOf.ContainsKey(n) ? taskOf[n] : "",
                            S(repo, "root"));
        pill.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        pills[n] = pill; halfW[n] = pill.DesiredSize.Width / 2; halfH[n] = pill.DesiredSize.Height / 2;
      }
      // ---- THE LABEL BUDGET IS FIXED BEFORE LAYOUT. This breaks a circular dependency that would
      // otherwise not terminate (research #241): a label's SIZE depends on its text, its text used to
      // depend on the space the drawn edge left over, that space depends on the layout, and the
      // layout now depends on the label's size. Deriving the budget from the canvas alone cuts it.
      // The semantics invert on purpose: the label no longer SHRINKS to fit leftover space, the
      // layout RESERVES the space the label declared. That is the whole point of a dummy node.
      double labelBudget = Math.Max(60, Math.Min(120, width / 3));
      var labelText = new Dictionary<string, string>();
      var labelSize = new Dictionary<string, Size>();
      foreach (var k in order) {
        string txt = EdgeLabel(Newest(groups[k]), labelBudget);
        labelText[k] = txt;
        double tw = TextW(txt, 10.5, MONO) + 14, th = 20;      // chip padding + border
        labelSize[k] = new Size(tw, th);
      }

      // ---- BUILD THE LAYOUT GRAPH: roles, plus ONE DUMMY NODE PER LABELLED EDGE ----
      // A label is a layout entity, not decoration placed afterwards. Splitting A->B into A->L->B
      // makes ranking, ordering and coordinate assignment reserve its space automatically, so it
      // cannot land on a node — which is precisely what no amount of post-hoc candidate searching
      // could achieve, because the space was never allocated to search.
      // LABELS LIVE IN THE GAP BETWEEN ROWS, NOT IN A ROW OF THEIR OWN. Making each label a full
      // layer node was the literal reading of "promote the label to a node", and it DOUBLED the
      // graph's depth: five sessions and six labels became an eleven-deep ladder, thin and tall and
      // unreadable. The reservation that matters is HORIZONTAL — that is where labels collide with
      // pills and with each other — so labels take part in ordering within the band between two
      // rows, and the row count stays the number of sessions.
      var gns = new List<GN>(); var idx = new Dictionary<string, int>();
      foreach (var n in nodes) {
        idx[n] = gns.Count;
        gns.Add(new GN { Id = "r:" + n, W = halfW[n] * 2, H = halfH[n] * 2, IsLabel = false });
      }
      var ges = new List<int[]>();
      foreach (var k in order) {
        string[] pr = k.Split('|');
        if (!idx.ContainsKey(pr[0]) || !idx.ContainsKey(pr[1])) continue;   // an outside endpoint
        ges.Add(new int[] { idx[pr[0]], idx[pr[1]] });
      }

      // ---- RING PLACEMENT ----
      var adjOf = new Dictionary<string, List<string>>();
      foreach (var k in order) {
        string[] pr0 = k.Split('|');
        if (!idx.ContainsKey(pr0[0]) || !idx.ContainsKey(pr0[1])) continue;
        if (!adjOf.ContainsKey(pr0[0])) adjOf[pr0[0]] = new List<string>();
        if (!adjOf.ContainsKey(pr0[1])) adjOf[pr0[1]] = new List<string>();
        adjOf[pr0[0]].Add(pr0[1]); adjOf[pr0[1]].Add(pr0[0]);
      }
      var ring = RingOrder(nodes, adjOf);
      var ringIndex = new Dictionary<string, int>();
      for (int i = 0; i < ring.Count; i++) ringIndex[ring[i]] = i;

      var pos = new Dictionary<string, Point>();
      int ringN = ring.Count;
      if (ringN == 1) {
        pos[ring[0]] = new Point(width / 2, halfH[ring[0]] + 8);
      } else if (ringN == 2) {
        pos[ring[0]] = new Point(width / 2, halfH[ring[0]] + 8);
        pos[ring[1]] = new Point(width / 2, halfH[ring[0]] + 8 + 92);
      } else {
        // A TRUE CIRCLE, EQUAL ANGLES. Not an ellipse fitted to the canvas — that stretched the ring
        // to whatever shape the window happened to be, so the same five sessions drew a different
        // figure at every width. One radius, evenly divided: the drawing has a shape of its own, and
        // it is the same shape every time. Height is elastic, so the circle is sized by the WIDTH and
        // the canvas simply grows to hold it.
        double need = 0, maxHalf = 0;
        foreach (var k in ring) { need += halfW[k] * 2 + 34; if (halfW[k] > maxHalf) maxHalf = halfW[k]; }
        double r0 = need / (2 * Math.PI);                       // radius the pills need to not touch (around the arc)
        double rCap = (width / 2) - maxHalf - 12;               // radius the width can afford
        double rr = Math.Max(46, Math.Min(r0, rCap));
        // ...but the arc budget only stops pills OVERLAPPING around the ring; on a SMALL ring the
        // straight-line CHORD between two ADJACENT pills is far shorter than that arc, so 3 nodes sit
        // research and code side by side at the bottom with barely a gap. Grow the radius until the
        // adjacent chord (2·rr·sin(π/N)) clears both widest half-widths plus a real gap — still capped
        // by the width so it never overflows. Only bites small N; for large N r0 already exceeds this.
        double chordNeed = (2 * maxHalf + 55) / (2 * Math.Sin(Math.PI / ringN));
        rr = Math.Min(Math.Max(rr, chordNeed), rCap);
        double cx0 = width / 2, cy0 = rr + 22;
        // start at the top and go clockwise, so the first name alphabetically is always at 12 o'clock
        for (int i = 0; i < ringN; i++) {
          double ang = -Math.PI / 2 + i * 2 * Math.PI / ringN;
          pos[ring[i]] = new Point(cx0 + rr * Math.Cos(ang), cy0 + rr * Math.Sin(ang));
        }
      }
      foreach (var g in gns) { if (pos.ContainsKey(g.Id.Substring(2))) { g.X = pos[g.Id.Substring(2)].X; g.Y = pos[g.Id.Substring(2)].Y; } }

      var labelPos = new Dictionary<string, Point>();   // vestigial: no chips are drawn
      var placed = new List<Rect>();
      foreach (var g in gns) placed.Add(new Rect(g.X - g.W / 2, g.Y - g.H / 2, g.W, g.H));

      double top = 1e9, bot = -1e9;
      foreach (var r in placed) { top = Math.Min(top, r.Top); bot = Math.Max(bot, r.Bottom); }
      if (placed.Count == 0) { top = 0; bot = 0; }
      double shiftY = 14 - top;
      var shifted = new Dictionary<string, Point>();
      foreach (var kv in pos) shifted[kv.Key] = new Point(kv.Value.X, kv.Value.Y + shiftY);
      pos = shifted;
      var shiftedL = new Dictionary<string, Point>();
      foreach (var kv in labelPos) shiftedL[kv.Key] = new Point(kv.Value.X, kv.Value.Y + shiftY);
      labelPos = shiftedL;
      double circleBot = bot + shiftY;
      double outTop = outside.Count > 0 ? circleBot + 26 : circleBot;
      canvas.Height = Math.Max(GRAPH_H, outTop + (outside.Count > 0 ? 46 : 14));

      // Outside pills are laid out HERE, before any wire is drawn, so a cross-board note is a real
      // arrow into the circle rather than a silently-dropped edge with no endpoint to land on.
      var outPills = new Dictionary<string, Border>();
      if (outside.Count > 0) {
        double ox = 12;
        foreach (var o in outside) {
          var op = OutsidePill(o);
          op.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
          double ow = op.DesiredSize.Width, oh = op.DesiredSize.Height;
          if (ox + ow > width - 12 && ox > 12) break;      // one row; the rest stay in NOTE FLOW
          outPills[o] = op;
          halfW[o] = ow / 2; halfH[o] = oh / 2;
          pos[o] = new Point(ox + ow / 2, outTop + oh / 2);
          ox += ow + 8;
        }
      }

      // ---- BONDS: how much each pair has ever worked together ----
      // Drawn FIRST, so everything else sits on top of it. A bond is a different KIND of fact from an
      // arrow and must not compete with one: an arrow is an event you may need to act on, a bond is
      // standing context. So it is a soft wide TIE rather than a line — no head, no label, no hard
      // edge — and both width and opacity scale with strength, which is relative to the strongest
      // pair on this board (an absolute count would saturate every tie on a busy board).
      // Undirected on purpose: who asked and who answered is what the arrows are for.
      foreach (var bd in A(Get(repo, "bonds"))) {
        string ba = S(bd, "a"), bb = S(bd, "b");
        if (!pos.ContainsKey(ba) || !pos.ContainsKey(bb)) continue;   // a peer that is not on this graph
        double str = D(bd, "strength");
        if (str <= 0) continue;
        // sqrt so a 1-note pair is still faintly visible next to an 80-note one; linear would erase it
        double k = Math.Sqrt(Math.Max(0, Math.Min(1, str)));
        Point ta = Inset(pos[bb], pos[ba], halfW[ba], halfH[ba]);
        Point tb = Inset(pos[ba], pos[bb], halfW[bb], halfH[bb]);
        // Every tie is a STRAIGHT line (the operator's call — no curves), tucked a few px INTO each card so
        // it connects FIRMLY at the pill edge instead of floating just outside it (bonds draw UNDER pills).
        double dax = pos[ba].X - ta.X, day = pos[ba].Y - ta.Y, dal = Math.Sqrt(dax * dax + day * day); if (dal < 0.001) dal = 1;
        double dbx = pos[bb].X - tb.X, dby = pos[bb].Y - tb.Y, dbl = Math.Sqrt(dbx * dbx + dby * dby); if (dbl < 0.001) dbl = 1;
        var tfig = new PathFigure();
        tfig.StartPoint = new Point(ta.X + dax / dal * 6, ta.Y + day / dal * 6);
        tfig.Segments.Add(new LineSegment(new Point(tb.X + dbx / dbl * 6, tb.Y + dby / dbl * 6), true));
        var tgeo = new PathGeometry(); tgeo.Figures.Add(tfig);
        var tie = new System.Windows.Shapes.Path();
        tie.Data = tgeo;
        tie.Stroke = Br(ACCENT);
        tie.StrokeThickness = 1.5 + k * 9.0;        // a hairline at the weak end, a band at the strong
        tie.Opacity = 0.07 + k * 0.17;              // never assertive — it is the substrate
        tie.StrokeStartLineCap = PenLineCap.Round; tie.StrokeEndLineCap = PenLineCap.Round;
        tie.ToolTip = ba + " — " + bb + "  ·  " + I(bd, "notes") + " notes exchanged, all time";
        canvas.Children.Add(tie);
      }

      // ---- dissolving edges: present last render, gone now ----
      bool sameRepo = prevEdgesRoot == S(repo, "root");
      if (sameRepo) {
        foreach (var kv in prevEdges) {
          if (groups.ContainsKey(kv.Key)) continue;
          string[] pr = kv.Key.Split('|');
          if (pr.Length != 2 || !pos.ContainsKey(pr[0]) || !pos.ContainsKey(pr[1])) continue;
          var ghost = new Line();
          Point ga = Inset(pos[pr[1]], pos[pr[0]], halfW[pr[0]], halfH[pr[0]]);
          Point gb = Inset(pos[pr[0]], pos[pr[1]], halfW[pr[1]], halfH[pr[1]]);
          ghost.X1 = ga.X; ghost.Y1 = ga.Y; ghost.X2 = gb.X; ghost.Y2 = gb.Y;
          ghost.Stroke = Br(ACCENT); ghost.StrokeThickness = 2; ghost.Opacity = 0.9;
          canvas.Children.Add(ghost);
          var fade = new DoubleAnimation(0, new Duration(TimeSpan.FromMilliseconds(900)));
          ghost.BeginAnimation(UIElement.OpacityProperty, fade);   // consumed -> dissolve
        }
      }

      // ---- live edges ----
      // Assign each node's neighbours to distinct card sides ONCE, up front, so both directions of a
      // pair agree on which side to use. Neighbours = every node this one shares an edge with (either
      // direction). Outside pills are absent from `ring`, so an edge to one falls back to Inset below.
      var nbr = new Dictionary<string, HashSet<string>>();
      foreach (var key in groups.Keys) {
        string[] kp = key.Split('|'); if (kp.Length != 2) continue;
        if (!nbr.ContainsKey(kp[0])) nbr[kp[0]] = new HashSet<string>();
        if (!nbr.ContainsKey(kp[1])) nbr[kp[1]] = new HashSet<string>();
        nbr[kp[0]].Add(kp[1]); nbr[kp[1]].Add(kp[0]);
      }
      var sideOf = AssignSides(ring, pos, nbr);

      var chipRects = new List<Rect>();   // chips placed so far, so later ones can dodge them
      foreach (var key in order) {
        string[] pr = key.Split('|');
        if (pr.Length != 2 || !pos.ContainsKey(pr[0]) || !pos.ContainsKey(pr[1])) continue;
        var list = groups[key];
        // ONE-WAY vs TWO-WAY: a lone direction (no reverse edge) is drawn as a clean STRAIGHT line —
        // no slot, no bow. The slot + bow exist only to split a pair that has BOTH directions.
        bool twoWay = groups.ContainsKey(pr[1] + "|" + pr[0]);
        bool unseen = false; foreach (var n in list) if (!Bo(n, "seen")) unseen = true;
        // THE EDGE RUNS THROUGH ITS LABEL. The label is a node in the layout, so the wire is a
        // POLYLINE — from -> label -> to — and the label sits on the path by construction rather
        // than being squeezed in beside it afterwards.
        // TIER A — BOUNDARY ANCHORING (likec4 / Graphviz style, replaces cardinal ports). Each end is
        // where the centre-to-centre line crosses the OTHER card's rounded boundary (Inset). A straight
        // line between those two points, with a TANGENT head, meets each card exactly where the line
        // points — so the head reads centred and square with NO lean, NO kink, NO curve. Graphviz never
        // uses fixed side-ports for this reason: it clips the routed edge at the boundary and aims the
        // head along it. A two-way pair is split onto opposite PARALLEL slots (the reverse edge, pr
        // swapped, flips the perpendicular so the two directions never share a point).
        Point a, b2;
        {
          Point ia = Inset(pos[pr[1]], pos[pr[0]], halfW[pr[0]], halfH[pr[0]]);   // source boundary, toward dest
          Point ib = Inset(pos[pr[0]], pos[pr[1]], halfW[pr[1]], halfH[pr[1]]);   // dest boundary, toward source
          double cdx = ib.X - ia.X, cdy = ib.Y - ia.Y, clen = Math.Sqrt(cdx * cdx + cdy * cdy); if (clen < 0.001) clen = 1;
          double ux = cdx / clen, uy = cdy / clen;
          double slot = twoWay ? EDGE_SLOT : 0;   // a lone direction sits dead-centre; a pair splits ±perp
          double sx = -cdy / clen * slot, sy = cdx / clen * slot;
          // Inset floats each end +3 OUTSIDE the boundary. Put the SOURCE end ON its boundary, and push the
          // DEST end past the boundary so the arrowhead TIP sinks HEAD_SINK px INTO the card — the (on-top)
          // head then seats on the edge instead of hovering above it (the operator's "lower" ask).
          a  = new Point(ia.X + sx - ux * 3, ia.Y + sy - uy * 3);
          b2 = new Point(ib.X + sx + ux * (3 - HEAD_LIFT), ib.Y + sy + uy * (3 - HEAD_LIFT));
        }
        // Two-way pairs no longer need a hand-tuned perpendicular nudge: each direction owns its own
        // label node, and the ordering phase has already given them different positions.
        // A NOTE IN FLIGHT IS NOT AN ALARM. These arrows were ALERT red, which reads as "something is
        // wrong" — but an unconsumed note is the board working normally: someone wrote, the recipient
        // has not read it yet. Red is reserved for things that need intervention. The accent blue
        // says "live traffic" without shouting; amber stays for the older/settled case.
        // ...and THIS is what earns red: a BLOCKER or a CORRECTION, which arc itself stamps
        // priority:high (arc-board.js:326). A correction retracts something already acted on and a
        // blocker says work has stopped — both are the operator's problem, not just the recipient's.
        bool alert = false;
        foreach (var w in list) if (S(w, "priority") == "high") { alert = true; break; }
        string col = alert ? ALERT : unseen ? ACCENT : WAIT;
        double thick = Math.Min(1.2 + list.Count * 0.35, 4.0);
        double opa = unseen ? 0.95 : 0.55;
        if (settling.Contains(key)) { col = WAIT; opa = 0.35; }   // a just-consumed edge lingers faint before it fades
        // STRAIGHT to the boundary, head SEATED on the card. A port edge is a plain straight line (a curve
        // reads wrong for a single arrow); only an outside-pill endpoint bows. Two things make the head sit
        // cleanly rather than hover: (1) the WIRE stops at the arrowhead's BASE, never the tip, so the
        // stroke's round end-cap can't poke through the solid head; (2) the head is drawn on TOP of the
        // pills with its tip sunk HEAD_SINK px into the destination card (see the Tier A block above).
        double mdx = b2.X - a.X, mdy = b2.Y - a.Y, mlen = Math.Sqrt(mdx * mdx + mdy * mdy); if (mlen < 0.001) mlen = 1;
        bool ported = sideOf.ContainsKey(pr[0]) && sideOf[pr[0]].ContainsKey(pr[1]) && sideOf.ContainsKey(pr[1]) && sideOf[pr[1]].ContainsKey(pr[0]);
        Point qctrl = new Point((a.X + b2.X) / 2, (a.Y + b2.Y) / 2);
        if (!ported) {                                     // outside-pill fallback: a gentle outward bow
          double bow = twoWay ? Math.Min(EDGE_BOW, mlen * 0.22) : 0;
          double perpx = -mdy / mlen, perpy = mdx / mlen;
          double cgx = 0, cgy = 0; foreach (var pp in pos.Values) { cgx += pp.X; cgy += pp.Y; }
          cgx /= Math.Max(1, pos.Count); cgy /= Math.Max(1, pos.Count);
          if (perpx * (qctrl.X - cgx) + perpy * (qctrl.Y - cgy) < 0) { perpx = -perpx; perpy = -perpy; }
          qctrl = new Point(qctrl.X + perpx * bow, qctrl.Y + perpy * bow);
        }
        // arrival tangent = head direction: a straight edge points a->b2; a bowed one points qctrl->b2
        double hl = 10, hw = 4.5;
        double hdx = b2.X - (ported ? a.X : qctrl.X), hdy = b2.Y - (ported ? a.Y : qctrl.Y);
        double hal = Math.Sqrt(hdx * hdx + hdy * hdy); if (hal < 0.001) hal = 1;
        double hux = hdx / hal, huy = hdy / hal;
        Point baseC = new Point(b2.X - hux * hl, b2.Y - huy * hl);   // arrowhead BASE — the wire ends HERE
        var fig = new PathFigure(); fig.StartPoint = a;
        if (ported) fig.Segments.Add(new LineSegment(baseC, true));
        else        fig.Segments.Add(new QuadraticBezierSegment(qctrl, baseC, true));
        var geo = new PathGeometry(); geo.Figures.Add(fig);
        var wire = new System.Windows.Shapes.Path();   // qualified: System.IO.Path is also in scope
        wire.Data = geo; wire.Stroke = Br(col); wire.StrokeThickness = thick; wire.Opacity = opa;
        wire.StrokeStartLineCap = PenLineCap.Round; wire.StrokeEndLineCap = PenLineCap.Round;
        canvas.Children.Add(wire);

        // Solid head, BASE -> TIP, drawn ON TOP of the pills so its sunk-in point shows instead of hiding.
        double opaHead = 1.0;   // the HEAD is always solid — never see-through — even when the wire is faint
        {
          var head = new Polygon(); head.Fill = Br(col); head.Opacity = opaHead;
          head.Points = new PointCollection();
          head.Points.Add(new Point(b2.X, b2.Y));                                // tip (sunk into the card)
          head.Points.Add(new Point(baseC.X - huy * hw, baseC.Y + hux * hw));    // base corner
          head.Points.Add(new Point(baseC.X + huy * hw, baseC.Y - hux * hw));    // base corner
          System.Windows.Controls.Canvas.SetZIndex(head, 5);                     // above the pills
          canvas.Children.Add(head);
        }
        // NO LABEL CHIPS ON THE GRAPH. This was tried five ways — 1D walk along the edge, 2D
        // candidates with a cost function, promotion to a layout node, anchoring on the curve apex —
        // and every version failed the same way: a chip that clears every obstacle ends up floating
        // near an edge it does not belong to. That is the AMBIGUITY failure Kakoulis & Tollis name,
        // and it is worse than an overlap, because a label reading against the wrong arrow is wrong
        // information rather than ugly information. A 380px canvas has nowhere to put 6 chips that is
        // both clear of everything AND unmistakably attached to one line.
        //
        // So the graph answers ONE question — who owes whom, and how much — with position, direction,
        // colour and thickness. WHICH notes is a different question, and NOTE FLOW directly below
        // already answers it perfectly: every id, newest first, click to read. Nothing is lost; the
        // ids moved to the surface that was already good at them.
        //
        // The wire itself carries the interaction: hovering names the notes, clicking opens them. A
        // transparent fat stroke over the thin visible one gives it a forgiving hit target.
        var edgeNotes = Newest(list); var rp = repo;
        string tipTxt = pr[0] + " → " + pr[1] + "  ·  " + EdgeLabel(edgeNotes, 400)
                      + (alert ? "   (blocker/correction)" : "");
        wire.ToolTip = tipTxt;
        var hit = new System.Windows.Shapes.Path();
        // 14px was a corridor, not a line — it swallowed pointer events well away from the wire and
        // made neighbouring edges hard to pick apart. 8 is still forgiving without being greedy.
        hit.Data = geo; hit.Stroke = Brushes.Transparent; hit.StrokeThickness = 8;
        hit.Cursor = System.Windows.Input.Cursors.Hand; hit.ToolTip = tipTxt;
        hit.MouseLeftButtonUp += delegate { ShowAllNotes(rp, edgeNotes); };
        // NO wire light-up on hover (operator's call): the note-badge hover already signals which edge
        // you are on, so the wire brightening/thickening under the pointer was redundant. The hit target
        // still makes the wire clickable (Hand cursor) and its tooltip still names the notes.
        canvas.Children.Add(hit);

        // THE NOTE CHIP, ON THE LINE ITSELF. This failed repeatedly on the old layouts and is worth
        // retrying here for a reason: the wire is now a KNOWN, collision-free path — it already
        // dodges every pill — so its apex is space that has been checked rather than guessed at.
        // The chip rides that point, which also makes it unambiguous: a label sitting ON a curve
        // cannot read as belonging to a different edge, which was the failure that killed the last
        // five attempts.
        string ltx = labelText.ContainsKey(key) ? labelText[key] : "";
        if (ltx.Length > 0) {
          var lbl2 = new TextBlock(); lbl2.Text = ltx;
          lbl2.FontFamily = new FontFamily(MONO); lbl2.FontSize = 10;
          lbl2.Foreground = Br(alert ? ALERT : unseen ? "#BFD6F5" : "#9AA9BB");
          var chip2 = new Border();
          chip2.Background = Br(alert ? "#2A1512" : "#111823");
          chip2.BorderBrush = Br(alert ? "#5C2521" : "#2C4A6E");
          chip2.BorderThickness = new Thickness(1);
          chip2.CornerRadius = new CornerRadius(5); chip2.Padding = new Thickness(5, 0, 5, 1);
          chip2.Child = lbl2;
          var b2n = new Button(); b2n.Style = (Style)win.FindResource("NoteBtn"); b2n.Content = chip2;
          b2n.Click += delegate { ShowAllNotes(rp, edgeNotes); };
          b2n.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
          double cw = b2n.DesiredSize.Width, ch = b2n.DesiredSize.Height;
          // walk ALONG the curve for a spot clear of the pills and of chips already placed
          // More stops, and they reach further along the curve. With only seven the walk ran out of
          // room whenever two edges crossed near their midpoints, and two chips settled almost on top
          // of each other — visibly, on #202 and #203.
          double[] tt = new double[] { 0.5, 0.44, 0.56, 0.38, 0.62, 0.31, 0.69, 0.24, 0.76, 0.18, 0.82 };
          Rect pick = Rect.Empty; double pickCost = double.MaxValue;
          for (int q = 0; q < tt.Length; q++) {
            double t = tt[q], u = 1 - t;
            double px, py;
            if (ported) {   // straight line point
              px = a.X + t * (b2.X - a.X);
              py = a.Y + t * (b2.Y - a.Y);
            } else {        // quadratic bezier point
              px = u * u * a.X + 2 * u * t * qctrl.X + t * t * b2.X;
              py = u * u * a.Y + 2 * u * t * qctrl.Y + t * t * b2.Y;
            }
            px = Math.Max(3 + cw / 2, Math.Min(px, width - 3 - cw / 2));
            var cand = new Rect(px - cw / 2, py - ch / 2, cw, ch);
            double cost = Math.Abs(t - 0.5) * 30;
            foreach (var kv in pos) {
              double hw2 = halfW.ContainsKey(kv.Key) ? halfW[kv.Key] : 35;
              double hh2 = halfH.ContainsKey(kv.Key) ? halfH[kv.Key] : 14;
              var nr = new Rect(kv.Value.X - hw2 - 2, kv.Value.Y - hh2 - 2, hw2 * 2 + 4, hh2 * 2 + 4);
              var ov = Rect.Intersect(nr, cand); if (ov != Rect.Empty) cost += ov.Width * ov.Height * 4;
            }
            foreach (var pr4 in chipRects) {
              var pr5 = pr4; pr5.Inflate(5, 4);   // keep a gap, not merely avoid overlap
              var ov = Rect.Intersect(pr5, cand); if (ov != Rect.Empty) cost += ov.Width * ov.Height * 6;
            }
            if (cost < pickCost) { pickCost = cost; pick = cand; }
            if (cost <= 12) break;
          }
          chipRects.Add(pick);
          Canvas.SetLeft(b2n, pick.X); Canvas.SetTop(b2n, pick.Y);
          canvas.Children.Add(b2n);
        }
      }

      // nodes on top of the wires
      foreach (var n in nodes) {
        var pill = pills[n];
        Canvas.SetLeft(pill, pos[n].X - halfW[n]);
        Canvas.SetTop(pill, pos[n].Y - halfH[n]);
        canvas.Children.Add(pill);
      }

      // ---- OUTSIDE: sessions on another board that wrote in here ----
      // Kept out of the circle on purpose. They are real cooperation and worth showing, but they
      // are not this repo's sessions — they hold no chair here, have no state here, and putting
      // them in the ring would claim they do. A dividing rule says "past this line is elsewhere".
      if (outside.Count > 0) {
        var rule = new Line();
        rule.X1 = 12; rule.X2 = Math.Max(12, width - 12); rule.Y1 = outTop - 13; rule.Y2 = outTop - 13;
        rule.Stroke = Br(HAIR); rule.StrokeThickness = 1;
        rule.StrokeDashArray = new DoubleCollection(new double[] { 3, 4 });
        canvas.Children.Add(rule);

        var caption = new TextBlock();
        caption.Text = "from another board"; caption.FontFamily = new FontFamily(MONO);
        caption.FontSize = 9; caption.Foreground = Br(DIM);
        caption.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        Canvas.SetLeft(caption, 12); Canvas.SetTop(caption, outTop - 24);
        canvas.Children.Add(caption);

        foreach (var kv in outPills) {
          Canvas.SetLeft(kv.Value, pos[kv.Key].X - halfW[kv.Key]);
          Canvas.SetTop(kv.Value, pos[kv.Key].Y - halfH[kv.Key]);
          canvas.Children.Add(kv.Value);
        }
      }

      prevEdges = new Dictionary<string, int>();
      foreach (var kv in groups) prevEdges[kv.Key] = kv.Value.Count;
      prevEdgesRoot = S(repo, "root");
      return canvas;
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
        AllowsTransparency='False' Background='Transparent' Topmost='False'
        ShowInTaskbar='True' FontFamily='Segoe UI' ResizeMode='CanResize'
        MinWidth='300' MinHeight='220'
        TextOptions.TextFormattingMode='Ideal' TextOptions.TextRenderingMode='ClearType'>
  <Window.Resources>
    <Style x:Key='ScrollNub' TargetType='RepeatButton'><Setter Property='OverridesDefaultStyle' Value='True'/><Setter Property='Focusable' Value='False'/><Setter Property='IsTabStop' Value='False'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='RepeatButton'><Border Background='Transparent'/></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='ScrollThumb' TargetType='Thumb'><Setter Property='OverridesDefaultStyle' Value='True'/><Setter Property='IsTabStop' Value='False'/><Setter Property='MinHeight' Value='30'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Thumb'><Border x:Name='Nub' CornerRadius='4' Background='#2E3B4B' Margin='3,1,3,1'/>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='Nub' Property='Background' Value='#43566A'/></Trigger>
        <Trigger Property='IsDragging' Value='True'><Setter TargetName='Nub' Property='Background' Value='#5AA3FF'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style TargetType='ScrollBar'><Setter Property='OverridesDefaultStyle' Value='True'/><Setter Property='Width' Value='11'/><Setter Property='Background' Value='Transparent'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='ScrollBar'><Grid Background='Transparent'><Track x:Name='PART_Track' IsDirectionReversed='True'>
        <Track.Thumb><Thumb Style='{StaticResource ScrollThumb}'/></Track.Thumb>
        <Track.IncreaseRepeatButton><RepeatButton Style='{StaticResource ScrollNub}' Command='ScrollBar.PageDownCommand'/></Track.IncreaseRepeatButton>
        <Track.DecreaseRepeatButton><RepeatButton Style='{StaticResource ScrollNub}' Command='ScrollBar.PageUpCommand'/></Track.DecreaseRepeatButton></Track></Grid></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='HdrBtn' TargetType='Button'><Setter Property='Width' Value='26'/><Setter Property='Height' Value='24'/><Setter Property='Foreground' Value='#8FA0B4'/><Setter Property='Background' Value='Transparent'/><Setter Property='Cursor' Value='Hand'/><Setter Property='FontSize' Value='12'/><Setter Property='VerticalAlignment' Value='Top'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='bg' Background='{TemplateBinding Background}' CornerRadius='6'><ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/></Border>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bg' Property='Background' Value='#202A38'/><Setter Property='Foreground' Value='#EAF0F7'/></Trigger>
        <Trigger Property='IsPressed' Value='True'><Setter TargetName='bg' Property='Background' Value='#202A38'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='HdrClose' TargetType='Button' BasedOn='{StaticResource HdrBtn}'>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='bg' Background='{TemplateBinding Background}' CornerRadius='6'><ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/></Border>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bg' Property='Background' Value='#7A2B27'/><Setter Property='Foreground' Value='#FFE9E7'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='BackBtn' TargetType='Button' BasedOn='{StaticResource HdrBtn}'><Setter Property='Width' Value='28'/><Setter Property='Height' Value='26'/><Setter Property='FontSize' Value='15'/><Setter Property='VerticalAlignment' Value='Center'/></Style>
    <Style x:Key='CardBtn' TargetType='Button'><Setter Property='Cursor' Value='Hand'/><Setter Property='HorizontalContentAlignment' Value='Stretch'/><Setter Property='Margin' Value='0,0,0,11'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='bd' Background='#161E2A' BorderBrush='#232D3B' BorderThickness='1' CornerRadius='13' Padding='15' RenderTransformOrigin='0.5,0.5'><ContentPresenter/></Border>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bd' Property='Background' Value='#1D2734'/><Setter TargetName='bd' Property='BorderBrush' Value='#2E3A4A'/></Trigger>
        <Trigger Property='IsPressed' Value='True'><Setter TargetName='bd' Property='RenderTransform'><Setter.Value><ScaleTransform ScaleX='0.985' ScaleY='0.985'/></Setter.Value></Setter></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='CardBtnAlert' TargetType='Button' BasedOn='{StaticResource CardBtn}'>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='bd' Background='#161E2A' BorderBrush='#6E2E2A' BorderThickness='1' CornerRadius='13' Padding='15' RenderTransformOrigin='0.5,0.5'><ContentPresenter/></Border>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bd' Property='Background' Value='#1D2734'/><Setter TargetName='bd' Property='BorderBrush' Value='#9A3B34'/></Trigger>
        <Trigger Property='IsPressed' Value='True'><Setter TargetName='bd' Property='RenderTransform'><Setter.Value><ScaleTransform ScaleX='0.985' ScaleY='0.985'/></Setter.Value></Setter></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style x:Key='NoteBtn' TargetType='Button'><Setter Property='Cursor' Value='Hand'/><Setter Property='HorizontalContentAlignment' Value='Stretch'/>
      <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Button'><Border x:Name='bd' Background='Transparent' CornerRadius='8' Padding='7,6,8,6'><ContentPresenter/></Border>
        <ControlTemplate.Triggers><Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bd' Property='Background' Value='#151D28'/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
  </Window.Resources>
  <Border x:Name='Root' Background='#0B0F16' CornerRadius='0' BorderBrush='#232D3B' BorderThickness='1'>
    <Grid ClipToBounds='True'>
      <!-- OVERVIEW -->
      <DockPanel x:Name='OverviewView'><DockPanel.RenderTransform><TranslateTransform x:Name='OvShift' X='0'/></DockPanel.RenderTransform>
        <Border x:Name='Header' DockPanel.Dock='Top' Background='#131A24' CornerRadius='0' Padding='17,13,10,13' BorderBrush='#232D3B' BorderThickness='0,0,0,1'>
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
        <Border x:Name='DHeader' DockPanel.Dock='Top' Background='#131A24' CornerRadius='0' Padding='11,11,10,12' BorderBrush='#232D3B' BorderThickness='0,0,0,1'>
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
      <!-- NOTES — the full ledger. A THIRD screen in this same window, not a second window: the
           app is one surface and 'show all' is a deeper level of it, reached and left by the same
           back chevron as the detail view. -->
      <DockPanel x:Name='NotesView' IsHitTestVisible='False'><DockPanel.RenderTransform><TranslateTransform x:Name='NtShift' X='452'/></DockPanel.RenderTransform>
        <Border x:Name='NHeader' DockPanel.Dock='Top' Background='#131A24' CornerRadius='0' Padding='11,11,10,12' BorderBrush='#232D3B' BorderThickness='0,0,0,1'>
          <DockPanel>
            <Button x:Name='NBackBtn' Style='{StaticResource BackBtn}' DockPanel.Dock='Left' Content='&#x2039;' Margin='0,0,11,0'/>
            <Button x:Name='NCloseBtn' Style='{StaticResource HdrClose}' DockPanel.Dock='Right' Content='&#x2715;'/>
            <Button x:Name='NMinBtn' Style='{StaticResource HdrBtn}' DockPanel.Dock='Right' Content='&#x2013;' FontSize='15' Margin='0,0,3,0'/>
            <StackPanel VerticalAlignment='Center'>
              <TextBlock x:Name='NName' FontFamily='Segoe UI Variable Display, Segoe UI' FontSize='15' FontWeight='SemiBold' Foreground='#E8EDF4'/>
              <TextBlock x:Name='NSub' FontFamily='Cascadia Mono, Consolas' FontSize='10.5' Foreground='#65768B' Margin='0,1,0,0'/>
            </StackPanel>
          </DockPanel>
        </Border>
        <ScrollViewer VerticalScrollBarVisibility='Auto' HorizontalScrollBarVisibility='Disabled' Padding='0'><StackPanel x:Name='Notes' Margin='13,10,14,16'/></ScrollViewer>
      </DockPanel>
    </Grid>
  </Border>
</Window>";
  }
}
