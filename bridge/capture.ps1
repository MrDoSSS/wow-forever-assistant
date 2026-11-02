# Capture the ForeverAssistant frame field from the game window's client area.
# The process is DPI-aware: coordinates and sizes use physical pixels. The field is copied
# from the screen (CopyFromScreen), so an obscured game window or
# minimized window is unsupported. Output: JSON lines on stdout:
#   {"type":"status","code":"ok|not_configured|process_not_found|window_not_found|minimized|client_too_small|capture_failed","detail":"..."}
#   {"type":"frame","at":<unix ms>,"width":512,"height":96,"rgb":"<base64 RGB, row-major>"}
# Emit a frame only when the image changes; emit status only when its code changes.
#
#   capture.ps1 -ProcessName WowB              capture continuously every IntervalMs
#   capture.ps1 -ProcessName WowB -Once        capture once for diagnostics
#   capture.ps1 -SelfTestRgbFile field.rgb     display an image in a test window and capture it

param(
  [string]$ProcessName = '',
  [int]$IntervalMs = 250,
  [int]$OffsetX = 8,
  [int]$OffsetY = 8,
  [int]$Width = 512,
  [int]$Height = 96,
  [switch]$Once,
  [string]$SelfTestRgbFile = '',
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

  // Return null on success or an unavailability code.
  public static string Grab(IntPtr hwnd, int ox, int oy, int w, int h, out byte[] rgb, out string detail) {
    rgb = null;
    detail = "";
    if (!IsWindow(hwnd)) return "window_not_found";
    if (IsIconic(hwnd)) return "minimized";
    RECT client;
    if (!GetClientRect(hwnd, out client)) return "window_not_found";
    int cw = client.Right - client.Left, ch = client.Bottom - client.Top;
    if (cw < ox + w || ch < oy + h) { detail = cw + "x" + ch; return "client_too_small"; }
    POINT origin = new POINT();
    if (!ClientToScreen(hwnd, ref origin)) return "window_not_found";
    try {
      using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
        using (Graphics g = Graphics.FromImage(bmp)) {
          g.CopyFromScreen(origin.X + ox, origin.Y + oy, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        }
        BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try {
          byte[] row = new byte[data.Stride];
          rgb = new byte[w * h * 3];
          for (int y = 0; y < h; y++) {
            Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, data.Stride);
            for (int x = 0; x < w; x++) {
              int s = x * 3, d = (y * w + x) * 3;
              rgb[d] = row[s + 2]; rgb[d + 1] = row[s + 1]; rgb[d + 2] = row[s];
            }
          }
        } finally {
          bmp.UnlockBits(data);
        }
      }
    } catch (Exception e) {
      detail = e.GetType().Name;
      return "capture_failed";
    }
    return null;
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
  $rgb = $null; $detail = ''
  $code = [FaCapture]::Grab($form.Handle, $OffsetX, $OffsetY, $Width, $Height, [ref]$rgb, [ref]$detail)
  $form.Close()
  if ($null -eq $code) { Write-Frame $rgb } else { Write-Status $code $detail }
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
    $code = [FaCapture]::Grab($hwnd, $OffsetX, $OffsetY, $Width, $Height, [ref]$rgb, [ref]$detail)
  }
  $status = if ($null -eq $code) { 'ok' } else { $code }
  if ($status -ne $lastStatus -or $Once) {
    Write-Status $status $detail
    $lastStatus = $status
  }
  if ($null -eq $code -and -not [FaCapture]::Same($rgb, $lastFrame)) {
    Write-Frame $rgb
    $lastFrame = $rgb
  }
  if ($Once) { break }
  Start-Sleep -Milliseconds $IntervalMs
}
