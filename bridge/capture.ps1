# Capture the ForeverAssistant frame field from the game window's client area.
# The process is DPI-aware: coordinates and sizes use physical pixels. While the game window
# is in the foreground the field is copied from the screen (CopyFromScreen); otherwise it is
# read from the window itself as DWM composes it (PrintWindow with PW_RENDERFULLCONTENT), so a
# game window behind other windows is still captured. A minimized window is not drawn at all
# and is reported as minimized. Output: JSON lines on stdout:
#   {"type":"status","code":"ok|not_configured|process_not_found|window_not_found|minimized|client_too_small|capture_failed","detail":"..."}
#   {"type":"frame","at":<unix ms>,"width":512,"height":96,"rgb":"<base64 RGB, row-major>"}
# The ok detail names the method: screen or window. Emit a frame only when the image changes;
# emit status only when its code or detail changes.
#
#   capture.ps1 -ProcessName WowB              capture continuously every IntervalMs
#   capture.ps1 -ProcessName WowB -Once        capture once for diagnostics
#   capture.ps1 -SelfTestRgbFile field.rgb     display an image in a test window and capture it
#   capture.ps1 -SelfTestRgbFile field.rgb -SelfTestCovered
#                                              cover the test window with another one and capture it from the window

param(
  [string]$ProcessName = '',
  [int]$IntervalMs = 250,
  [int]$OffsetX = 8,
  [int]$OffsetY = 8,
  [int]$Width = 512,
  [int]$Height = 96,
  [switch]$Once,
  [string]$SelfTestRgbFile = '',
  [switch]$SelfTestCovered,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class FaCapture {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

  // PW_CLIENTONLY | PW_RENDERFULLCONTENT: the client area as DWM composes it, DirectX content
  // included, whether or not other windows cover it. DWM serves it without the window's thread.
  const uint PrintClientFull = 3;

  // The first ShowWindow call for a process started with a hidden window receives SW_HIDE
  // from STARTUPINFO; a second call displays the self-test window.
  public static void ShowNormal(IntPtr hwnd) { ShowWindow(hwnd, 1); ShowWindow(hwnd, 1); }

  public static void Init() {
    try {
      // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
      if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
    } catch (EntryPointNotFoundException) { }
    SetProcessDPIAware();
  }

  // Return null on success or an unavailability code; on success detail is the method used.
  // A window outside the foreground is read through PrintWindow, falling back to the screen
  // if that fails, unless onlyWindow is set.
  public static string Grab(IntPtr hwnd, int ox, int oy, int w, int h, bool onlyWindow, out byte[] rgb, out string detail) {
    rgb = null;
    detail = "";
    if (!IsWindow(hwnd)) return "window_not_found";
    if (IsIconic(hwnd)) { detail = "a minimized window is not drawn; restore it, it can stay behind other windows"; return "minimized"; }
    RECT client;
    if (!GetClientRect(hwnd, out client)) return "window_not_found";
    int cw = client.Right - client.Left, ch = client.Bottom - client.Top;
    if (cw < ox + w || ch < oy + h) { detail = cw + "x" + ch; return "client_too_small"; }
    try {
      if (onlyWindow || GetForegroundWindow() != hwnd) {
        using (Bitmap bmp = new Bitmap(ox + w, oy + h, PixelFormat.Format24bppRgb)) {
          bool printed;
          using (Graphics g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            try { printed = PrintWindow(hwnd, hdc, PrintClientFull); } finally { g.ReleaseHdc(hdc); }
          }
          if (printed) { rgb = Pixels(bmp, ox, oy, w, h); detail = "window"; return null; }
          if (onlyWindow) { detail = "PrintWindow"; return "capture_failed"; }
        }
      }
      POINT origin = new POINT();
      if (!ClientToScreen(hwnd, ref origin)) return "window_not_found";
      using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
        using (Graphics g = Graphics.FromImage(bmp)) {
          g.CopyFromScreen(origin.X + ox, origin.Y + oy, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        }
        rgb = Pixels(bmp, 0, 0, w, h);
        detail = "screen";
      }
    } catch (Exception e) {
      detail = e.GetType().Name;
      return "capture_failed";
    }
    return null;
  }

  // The w x h rectangle at (x0, y0) as row-major RGB.
  static byte[] Pixels(Bitmap bmp, int x0, int y0, int w, int h) {
    BitmapData data = bmp.LockBits(new Rectangle(x0, y0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    try {
      byte[] row = new byte[w * 3];
      byte[] rgb = new byte[w * h * 3];
      for (int y = 0; y < h; y++) {
        Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
        for (int x = 0; x < w; x++) {
          int s = x * 3, d = (y * w + x) * 3;
          rgb[d] = row[s + 2]; rgb[d + 1] = row[s + 1]; rgb[d + 2] = row[s];
        }
      }
      return rgb;
    } finally {
      bmp.UnlockBits(data);
    }
  }

  public static bool Same(byte[] a, byte[] b) {
    if (a == null || b == null || a.Length != b.Length) return false;
    for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
    return true;
  }
}
'@

[FaCapture]::Init()

function Write-Line([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

function Write-Status([string]$code, [string]$detail = '') {
  $safe = $detail -replace '[\\"]', '' -replace '[\x00-\x1f]', ' '
  Write-Line ('{"type":"status","code":"' + $code + '","detail":"' + $safe + '"}')
}

function Write-Frame([byte[]]$rgb) {
  $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-Line ('{"type":"frame","at":' + $at + ',"width":' + $Width + ',"height":' + $Height + ',"rgb":"' + [Convert]::ToBase64String($rgb) + '"}')
}

# ProcessName accepts one name or comma-separated names in preference order.
function Find-GameWindow {
  $names = $ProcessName -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
  $process = Get-Process -Name $names -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
  if ($null -eq $process) { return [IntPtr]::Zero }
  return $process.MainWindowHandle
}

if ($SelfTestRgbFile -ne '') {
  # Self-test without the game: draw the image in our window's client area
  # at OffsetX/OffsetY and capture it through the same path as the game.
  Add-Type -AssemblyName System.Windows.Forms
  $bytes = [IO.File]::ReadAllBytes($SelfTestRgbFile)
  $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  for ($y = 0; $y -lt $Height; $y++) {
    for ($x = 0; $x -lt $Width; $x++) {
      $i = ($y * $Width + $x) * 3
      $bitmap.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($bytes[$i], $bytes[$i + 1], $bytes[$i + 2]))
    }
  }
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'ForeverAssistant capture self-test'
  $form.TopMost = $true
  $form.StartPosition = 'Manual'
  $form.Location = New-Object System.Drawing.Point(40, 40)
  $form.ClientSize = New-Object System.Drawing.Size(($Width + $OffsetX + 16), ($Height + $OffsetY + 16))
  $form.BackColor = [System.Drawing.Color]::FromArgb(128, 128, 128)
  $box = New-Object System.Windows.Forms.PictureBox
  $box.Location = New-Object System.Drawing.Point($OffsetX, $OffsetY)
  $box.Size = New-Object System.Drawing.Size($Width, $Height)
  $box.Image = $bitmap
  $form.Controls.Add($box)
  $form.Show()
  [FaCapture]::ShowNormal($form.Handle)
  $form.Activate()
  $form.Refresh()
  for ($i = 0; $i -lt 30; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
  # Covered: another window hides the test window, as when the game is behind other windows.
  $cover = $null
  if ($SelfTestCovered) {
    $cover = New-Object System.Windows.Forms.Form
    $cover.Text = 'ForeverAssistant capture self-test cover'
    $cover.TopMost = $true
    $cover.StartPosition = 'Manual'
    $cover.Location = $form.Location
    $cover.Size = $form.Size
    $cover.BackColor = [System.Drawing.Color]::FromArgb(128, 128, 128)
    $cover.Show()
    [FaCapture]::ShowNormal($cover.Handle)
    $cover.Activate()
    for ($i = 0; $i -lt 10; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
  }
  $rgb = $null; $detail = ''
  $code = [FaCapture]::Grab($form.Handle, $OffsetX, $OffsetY, $Width, $Height, $SelfTestCovered.IsPresent, [ref]$rgb, [ref]$detail)
  if ($null -ne $cover) { $cover.Close() }
  $form.Close()
  if ($null -eq $code) { Write-Status 'ok' $detail; Write-Frame $rgb } else { Write-Status $code $detail }
  exit 0
}

if ($ProcessName -eq '') {
  Write-Status 'not_configured' 'gameProcessName'
  exit 0
}

$hwnd = [IntPtr]::Zero
$lastStatus = ''
$lastFrame = $null
$lastLookup = [DateTime]::MinValue
$lastParentCheck = Get-Date
while ($true) {
  # The bridge crashed: capture must not keep running without it.
  if ($ParentPid -gt 0 -and ((Get-Date) - $lastParentCheck).TotalSeconds -ge 2) {
    $lastParentCheck = Get-Date
    if ($null -eq (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  }
  $code = $null; $detail = ''; $rgb = $null
  if ($hwnd -eq [IntPtr]::Zero -or -not [FaCapture]::IsWindow($hwnd) -or ((Get-Date) - $lastLookup).TotalSeconds -ge 5) {
    $hwnd = Find-GameWindow
    $lastLookup = Get-Date
  }
  if ($hwnd -eq [IntPtr]::Zero) {
    $code = 'process_not_found'; $detail = $ProcessName
  } else {
    $code = [FaCapture]::Grab($hwnd, $OffsetX, $OffsetY, $Width, $Height, $false, [ref]$rgb, [ref]$detail)
  }
  $status = if ($null -eq $code) { 'ok' } else { $code }
  if ("$status $detail" -ne $lastStatus -or $Once) {
    Write-Status $status $detail
    $lastStatus = "$status $detail"
  }
  if ($null -eq $code -and -not [FaCapture]::Same($rgb, $lastFrame)) {
    Write-Frame $rgb
    $lastFrame = $rgb
  }
  if ($Once) { break }
  Start-Sleep -Milliseconds $IntervalMs
}
