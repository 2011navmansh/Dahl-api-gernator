param([int]$ProcessId)

# Browser window ko taskbar me minimize karta hai (SW_MINIMIZE = 6)
# Method 1: Get-Process ka MainWindowHandle (simple + reliable)
# Method 2: EnumWindows fallback

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinMin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
}
"@

function Try-Minimize([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return $false }
  [WinMin]::ShowWindowAsync($h, 6) | Out-Null
  Start-Sleep -Milliseconds 500
  return [WinMin]::IsIconic($h)
}

# window minimize hone ke baad 5 baar (~3.5s) check — kisi ne restore
# kiya dobara minimize kar do; stable rahe tabhi success
function Confirm-Minimized([IntPtr]$h) {
  for ($i = 0; $i -lt 5; $i++) {
    if (-not [WinMin]::IsIconic($h)) {
      [WinMin]::ShowWindowAsync($h, 6) | Out-Null
    }
    Start-Sleep -Milliseconds 700
  }
  return [WinMin]::IsIconic($h)
}

# --- Method 1: browser process ka main window handle (retry karta hai) ---
for ($i = 0; $i -lt 15; $i++) {
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($proc -and (Try-Minimize $proc.MainWindowHandle)) {
    if (Confirm-Minimized $proc.MainWindowHandle) { exit 0 }
  }
  Start-Sleep -Milliseconds 400
}

# --- Method 2: EnumWindows fallback ---
$script:found = [IntPtr]::Zero
$cb = [WinMin+EnumWindowsProc]{
  param($h, $l)
  $procId = [uint32]0
  [WinMin]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  if ($procId -eq [uint32]$ProcessId -and [WinMin]::IsWindowVisible($h)) {
    $script:found = $h
    return $false
  }
  return $true
}
[WinMin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($script:found -ne [IntPtr]::Zero) {
  if ((Try-Minimize $script:found) -and (Confirm-Minimized $script:found)) { exit 0 }
}

exit 1
