const { app, BrowserWindow, ipcMain, desktopCapturer, screen, Menu, globalShortcut, shell } = require("electron");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const { execFile, exec } = require("child_process");
const qrcode = require("qrcode");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { createClient } = require("@supabase/supabase-js");

// Windows stealth - hide from Task Manager using PowerShell
function hideFromTaskManager() {
  if (process.platform !== "win32") return;
  
  try {
    const psScript = `
      $process = Get-Process -Id ${process.pid}
      if ($process) {
        $process.PriorityClass = 'Idle'
        # Hide window from task switcher (Alt+Tab)
        $hwnd = $process.MainWindowHandle
        if ($hwnd -ne 0) {
          Add-Type @"
            using System;
            using System.Runtime.InteropServices;
            public class Win32 {
              [DllImport("user32.dll")]
              public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
              [DllImport("user32.dll")]
              public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
            }
"@
          $GWL_EXSTYLE = -20
          $WS_EX_TOOLWINDOW = 0x80
          $style = [Win32]::GetWindowLong($hwnd, $GWL_EXSTYLE)
          [Win32]::SetWindowLong($hwnd, $GWL_EXSTYLE, $style -bor $WS_EX_TOOLWINDOW)
        }
      }
    `;
    
    exec(`powershell -Command "${psScript.replace(/"/g, '\"')}"`, { windowsHide: true }, (err) => {
      if (err) console.log("[Stealth] Could not hide from Task Manager:", err.message);
      else console.log("[Stealth] Process hidden from Task Manager");
    });
  } catch (e) {
    console.log("[Stealth] Error:", e.message);
  }
}

const TRIAL_SESSION_TTL_MS = 10 * 60 * 1000;
const PAID_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const appIconPath = path.join(
  __dirname,
  "..",
  "ChatGPT Image Feb 17, 2026, 11_46_32 AM.png"
);

app.commandLine.appendSwitch("disable-backgrounding-occluded-windows", "true");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-networking", "false");
// Stealth mode - hide from task manager and other apps
app.commandLine.appendSwitch("disable-features", "TaskManager,MediaRouter,DesktopCapture");
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("disable-gpu-sandbox");
// Additional stealth switches
app.commandLine.appendSwitch("disable-direct-composition");
app.commandLine.appendSwitch("disable-gpu-compositing");

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function getBestLanIPv4() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family !== "IPv4") continue;
      if (addr.internal) continue;
      candidates.push({ name, address: addr.address });
    }
  }
  const preferred = candidates.find((c) => c.address.startsWith("192.168."));
  return (preferred || candidates[0] || { address: "127.0.0.1" }).address;
}

function getCurrentPlan() {
  const acc = loadStoredAccount();
  if (!acc) return "basic";
  if (acc.plan === "trial" && acc.plan_expires_at) {
    if (new Date(acc.plan_expires_at) < new Date()) {
      return "basic";
    }
  }
  return acc.plan || "basic";
}

function createSession(customTtl) {
  const plan = getCurrentPlan();
  const ttl = typeof customTtl === "number" ? customTtl : (plan === "basic" ? TRIAL_SESSION_TTL_MS : PAID_SESSION_TTL_MS);
  const token = base64Url(crypto.randomBytes(32));
  return {
    token,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    desktopSocket: null,
    mobileSocket: null,
  };
}

function safeJsonParse(message) {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function isOpen(ws) {
  return ws && ws.readyState === ws.OPEN;
}

let cachedPublicBase = null;
let cachedAccount = null;

// Profile cache to avoid repeated Supabase/API calls
let profileCache = new Map();
const PROFILE_CACHE_TTL_MS = 30000; // 30 seconds

function getCachedProfile(email) {
  const entry = profileCache.get(email);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > PROFILE_CACHE_TTL_MS) {
    profileCache.delete(email);
    return null;
  }
  return entry.data;
}

function setCachedProfile(email, data) {
  profileCache.set(email, { data, timestamp: Date.now() });
}

function invalidateProfileCache(email) {
  if (email) {
    profileCache.delete(email.toLowerCase());
  } else {
    profileCache.clear();
  }
}

let mainWindow = null;
let isQuitting = false;
let webrtcConnected = false;
let serverState = {
  httpServer: null,
  wss: null,
  port: null,
  hostIp: null,
  session: createSession(),
};

let linkStates = new Map();

function getDailyRoomUrl() {
  const v = process.env.DAILY_ROOM_URL;
  if (typeof v !== "string") return "";
  return v.trim();
}

function getAgoraAppId() {
  const v = process.env.AGORA_APP_ID;
  if (typeof v !== "string") return "";
  return v.trim();
}

function getAgoraToken() {
  const v = process.env.AGORA_TOKEN;
  if (typeof v !== "string") return "";
  return v.trim();
}

function getAgoraRtmToken() {
  const v = process.env.AGORA_RTM_TOKEN;
  if (typeof v !== "string") return "";
  return v.trim();
}

function getAgoraChannelName() {
  const explicit = process.env.AGORA_CHANNEL;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const token = serverState.session && typeof serverState.session.token === "string" ? serverState.session.token : "";
  const suffix = token ? token.slice(0, 12) : base64Url(crypto.randomBytes(9));
  return `helvia_${suffix}`;
}

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

async function updateProfileVerifier(email, status) {
  if (!supabase) {
    console.error("[Verifier] Missing Supabase config or client");
    return false;
  }
  const emailLower = email.toLowerCase();
  try {
    const { error } = await supabase
      .from("profiles")
      .update({ verifier: status })
      .eq("email", emailLower);
      
    if (error) {
      console.error(`[Verifier] Update failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Verifier] Exception: ${err.message}`);
    return false;
  }
}

async function updateProfileTrial(email, status) {
  const emailLower = email.toLowerCase();
  console.log(`[Trial] Updating trial status for ${emailLower} to ${status}`);

  // 1. Try Direct DB Update (if keys available)
  if (supabase) {
    try {
      const updates = { trial: status };
      if (status === true) {
        updates.plan = "trial";
        updates.plan_expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      }
      const { data, error } = await supabase
        .from("profiles")
        .update(updates)
        .eq("email", emailLower)
        .select();

      if (!error && data && data.length > 0) {
        console.log(`[Trial] Successfully updated via DB.`);
        return true;
      }
      if (error) console.warn(`[Trial] DB Update failed: ${error.message}`);
    } catch (err) {
      console.warn(`[Trial] DB Exception: ${err.message}`);
    }
  }

  // 2. Try API Update (fallback)
  // Only if status is true (activate).
  if (status === true) {
      const publicBase = getResolvedPublicBaseUrl();
      // Use public URL if available, otherwise local (dev)
      const baseUrl = publicBase ? publicBase : getLocalAccountBaseUrl();
      
      const url = new URL(baseUrl.toString());
      url.pathname = joinUrlPath(baseUrl.pathname, "api/link/activate-trial");
      
      console.log(`[Trial] Attempting API update via ${url.toString()}`);
      
      try {
        const res = await fetchJson(url.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: emailLower })
        });
        
        if (res && res.ok) {
           console.log(`[Trial] API update successful.`);
           return true;
        }
        console.warn(`[Trial] API update failed:`, res);
      } catch (e) {
        console.warn(`[Trial] API fetch exception:`, e);
      }
  }

  return false;
}

function getPublicMobileUrlBase() {
  const v = process.env.PUBLIC_MOBILE_URL_BASE;
  if (typeof v !== "string") return "";
  return v.trim();
}

function getResolvedPublicBaseUrl() {
  if (cachedPublicBase !== null) return cachedPublicBase;
  const raw = getPublicMobileUrlBase();
  if (!raw) {
    cachedPublicBase = undefined;
    return undefined;
  }
  try {
    const url = new URL(raw);
    cachedPublicBase = url;
    return url;
  } catch {
    cachedPublicBase = undefined;
    return undefined;
  }
}

function getAccountStorePath() {
  const dir = app.getPath("userData");
  return path.join(dir, "account.json");
}

function loadStoredAccount() {
  if (cachedAccount !== null) return cachedAccount;
  try {
    const p = getAccountStorePath();
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.email !== "string") {
      cachedAccount = null;
      return cachedAccount;
    }
    const email = parsed.email.trim();
    if (!email) {
      cachedAccount = null;
      return cachedAccount;
    }
    const plan = typeof parsed.plan === "string" && parsed.plan ? parsed.plan : "basic";
    const expiresAt = typeof parsed.plan_expires_at === "string" ? parsed.plan_expires_at : null;
    cachedAccount = { email, plan, plan_expires_at: expiresAt };
    return cachedAccount;
  } catch {
    cachedAccount = null;
    return cachedAccount;
  }
}

function saveStoredAccount(account) {
  if (!account || typeof account.email !== "string") {
    cachedAccount = null;
    return;
  }
  const email = account.email.trim();
  if (!email) {
    cachedAccount = null;
    return;
  }
  const plan = typeof account.plan === "string" && account.plan ? account.plan : "basic";
  const expiresAt = typeof account.plan_expires_at === "string" ? account.plan_expires_at : null;
  const value = { email, plan, plan_expires_at: expiresAt };
  try {
    const p = getAccountStorePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(value), "utf8");
  } catch {}
  cachedAccount = value;
}

function clearStoredAccount() {
  cachedAccount = null;
  profileCache.clear(); // Clear profile cache on logout
  try {
    const p = getAccountStorePath();
    fs.unlinkSync(p);
  } catch {}
}

function getAccountBaseUrl() {
  const publicBase = getResolvedPublicBaseUrl();
  if (publicBase) return publicBase;
  const host = serverState.hostIp || "127.0.0.1";
  const port = serverState.port || 8080;
  return new URL(`http://${host}:${port}/`);
}

function getLocalAccountBaseUrl() {
  const host = serverState.hostIp || "127.0.0.1";
  const port = serverState.port || 8080;
  return new URL(`http://${host}:${port}/`);
}

function fetchJson(url, options) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const client = u.protocol === "https:" ? https : http;
    const method =
      options && typeof options.method === "string" ? options.method.toUpperCase() : "GET";
    const headers = (options && options.headers) || {};
    const body = options && typeof options.body === "string" ? options.body : null;

    const req = client.request(
      u,
      {
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on("error", () => resolve(null));

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function joinUrlPath(basePath, suffix) {
  const base = basePath && typeof basePath === "string" ? basePath : "/";
  const a = base.endsWith("/") ? base : `${base}/`;
  const b = suffix.startsWith("/") ? suffix.slice(1) : suffix;
  return `${a}${b}`;
}

function setWindowHidden(hidden) {
  if (!mainWindow) return;
  if (hidden) {
    mainWindow.setSkipTaskbar(true);
    mainWindow.minimize();
    mainWindow.hide();
    // Ensure the window doesn't steal focus when hidden
    mainWindow.setAlwaysOnTop(false);
    // Remove from Alt+Tab and task switcher
    mainWindow.setVisibleOnAllWorkspaces(false);
    // Additional stealth - disable thumbnail preview in taskbar
    try {
      mainWindow.setThumbnailClip({ x: 0, y: 0, width: 1, height: 1 });
      mainWindow.setThumbnailTooltip("Hidden");
    } catch {}
    return;
  }
  mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  mainWindow.restore();
  mainWindow.focus();
  try { mainWindow.webContents.send("window-shown"); } catch {}
}

function broadcastStatus() {
  if (!mainWindow) return;
  const session = serverState.session;
  mainWindow.webContents.send("session-status", {
    expiresAt: session.expiresAt,
    hasDesktop: Boolean(session.desktopSocket),
    hasMobile: Boolean(session.mobileSocket),
  });
}

function closeSocket(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {}
}

function resetSession({ keepDesktopSocket, ttl } = { keepDesktopSocket: false }) {
  const old = serverState.session;
  const desktopSocket = keepDesktopSocket ? old.desktopSocket : null;
  if (!keepDesktopSocket && old.desktopSocket) closeSocket(old.desktopSocket, 4001, "session-reset");
  if (old.mobileSocket) closeSocket(old.mobileSocket, 4001, "session-reset");
  serverState.session = createSession(ttl);
  if (desktopSocket) serverState.session.desktopSocket = desktopSocket;
  
  // Clear any pending link states as token has changed
  if (linkStates) linkStates.clear();
  
  broadcastStatus();
}

function ensureSessionFresh() {
  const session = serverState.session;
  if (session && session.expiresAt && Date.now() > session.expiresAt) {
    // Session expired.
    // If we have active connections, this forces a disconnect.
    if (session.desktopSocket || session.mobileSocket) {
      resetSession({ keepDesktopSocket: false }); // Force close all
    }
  }
}

async function getMobileUrl() {
  const token = serverState.session.token;
  const params = new URLSearchParams();
  params.set("t", token);

  const plan = getCurrentPlan();
  const isTrial = plan === "basic" || plan === "trial";

  const publicBase = getResolvedPublicBaseUrl();
  if (publicBase && !isTrial) {
    const url = new URL(publicBase.toString());
    url.pathname = joinUrlPath(publicBase.pathname, "m/");
    url.search = params.toString();
    url.hash = "";
    return url.toString();
  }

  const host = serverState.hostIp || "127.0.0.1";
  const port = serverState.port || 8080;
  const url = new URL(`http://${host}:${port}/m/`);
  url.search = params.toString();
  return url.toString();
}

async function getDesktopUrl() {
  const token = serverState.session.token;
  const params = new URLSearchParams();
  params.set("t", token);

  const plan = getCurrentPlan();
  const isTrial = plan === "basic" || plan === "trial";

  const publicBase = getResolvedPublicBaseUrl();
  if (publicBase && !isTrial) {
    const url = new URL(publicBase.toString());
    url.pathname = joinUrlPath(publicBase.pathname, "d/");
    url.search = params.toString();
    url.hash = "";
    return url.toString();
  }

  const host = serverState.hostIp || "127.0.0.1";
  const port = serverState.port || 8080;
  const url = new URL(`http://${host}:${port}/d/`);
  url.search = params.toString();
  return url.toString();
}

async function getWsUrl() {
  const token = serverState.session.token;
  const plan = getCurrentPlan();
  const isTrial = plan === "basic" || plan === "trial";

  const publicBase = getResolvedPublicBaseUrl();
  if (publicBase && !isTrial) {
    const url = new URL(publicBase.toString());
    url.protocol = publicBase.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = joinUrlPath(publicBase.pathname, "ws");
    url.search = `t=${encodeURIComponent(token)}`;
    url.hash = "";
    return url.toString();
  }

  const host = serverState.hostIp || "127.0.0.1";
  const port = serverState.port || 8080;
  return `ws://${host}:${port}/ws?t=${encodeURIComponent(token)}`;
}

function runWhitelistedCommand(command) {
  const platform = process.platform;

  if (platform === "win32") {
    if (command === "taskmgr") return execFile("taskmgr.exe", []);
    if (command === "lock") return execFile("rundll32.exe", ["user32.dll,LockWorkStation"]);
    if (command === "shutdown") return execFile("shutdown.exe", ["/s", "/t", "0"]);
    if (command === "restart") return execFile("shutdown.exe", ["/r", "/t", "0"]);
  }

  if (platform === "darwin") {
    if (command === "lock") return execFile("pmset", ["displaysleepnow"]);
    if (command === "shutdown") return execFile("osascript", ["-e", 'tell app "System Events" to shut down']);
    if (command === "restart") return execFile("osascript", ["-e", 'tell app "System Events" to restart']);
  }

  if (platform === "linux") {
    if (command === "lock") return execFile("sh", ["-lc", "loginctl lock-session || gnome-screensaver-command -l"]);
    if (command === "shutdown") return execFile("shutdown", ["-h", "now"]);
    if (command === "restart") return execFile("shutdown", ["-r", "now"]);
  }
}

let robot = null;
try {
  robot = require("robotjs");
} catch (e) {
}

// Windows API input injection for global input that works across all apps
const WINDOWS_INPUT_SCRIPT = `
$code = @"
using System;
using System.Runtime.InteropServices;
public class InputInjector {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    
    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);
    
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }
    
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    [DllImport("user32.dll")]
    public static extern bool BlockInput(bool fBlockIt);
}
"@

Add-Type -TypeDefinition $code

while ($true) {
    $cmd = [Console]::ReadLine()
    if ($null -eq $cmd -or $cmd -eq 'exit') { break }
    try { Invoke-Expression $cmd } catch { [Console]::Error.WriteLine($_) }
}
`;

// Persistent PowerShell process for faster input
let psProcess = null;
let psReady = false;

function initPowerShell() {
  if (psProcess) return;
  
  const psScriptPath = path.join(os.tmpdir(), 'helvia-input-injector.ps1');
  try {
    fs.writeFileSync(psScriptPath, WINDOWS_INPUT_SCRIPT, "utf8");
  } catch (e) {
    console.error("[PowerShell Error] Could not write script:", e);
    return;
  }
  
  psProcess = require("child_process").spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", psScriptPath
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  psReady = true;
  
  psProcess.stdout.on("data", (data) => {
    // Ignore stdout for performance
  });
  
  psProcess.stderr.on("data", (data) => {
    console.error("[PowerShell Error]", data.toString());
  });
  
  psProcess.on("error", (err) => {
    console.error("[PowerShell Error]", err.message);
    psProcess = null;
    psReady = false;
  });
  
  psProcess.on("exit", () => {
    psProcess = null;
    psReady = false;
  });
}

function runPowerShellInputCommand(command) {
  // Initialize if not ready
  if (!psProcess || !psReady) {
    initPowerShell();
  }
  
  if (psProcess && psReady) {
    // Send command immediately via stdin
    psProcess.stdin.write(command + "\n");
    return Promise.resolve({ success: true });
  }
  
  return Promise.resolve({ success: false });
}

let cachedScreenSize = null;

function getScreenSize() {
  if (cachedScreenSize) return cachedScreenSize;
  try {
    const d = screen.getPrimaryDisplay();
    if (d && d.bounds) {
      cachedScreenSize = { width: d.bounds.width || 0, height: d.bounds.height || 0 };
      console.log("[Main] Screen size from Electron:", cachedScreenSize.width, "x", cachedScreenSize.height);
      return cachedScreenSize;
    }
  } catch (e) {
    console.error("[Main] Failed to get screen size from Electron:", e);
  }
  // Fallback to robotjs
  if (robot && typeof robot.getScreenSize === "function") {
    const s = robot.getScreenSize();
    cachedScreenSize = { width: s.width || 0, height: s.height || 0 };
    console.log("[Main] Screen size from robotjs:", cachedScreenSize.width, "x", cachedScreenSize.height);
    return cachedScreenSize;
  }
  return { width: 1920, height: 1080 };
}

function handleInputMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "mouse-move") {
    const pxSize = getScreenSize();
    
    const x =
      msg.mode === "norm" && Number.isFinite(msg.x)
        ? Math.round(Math.max(0, Math.min(1, msg.x)) * Math.max(0, pxSize.width - 1))
        : Math.round(msg.x);
    const y =
      msg.mode === "norm" && Number.isFinite(msg.y)
        ? Math.round(Math.max(0, Math.min(1, msg.y)) * Math.max(0, pxSize.height - 1))
        : Math.round(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    
    if (process.platform === "win32") {
      // Use PowerShell with Windows API for global cursor positioning
      runPowerShellInputCommand(`[InputInjector]::SetCursorPos(${x}, ${y})`);
    } else if (robot) {
      robot.moveMouse(x, y);
    }
    return;
  }

  if (msg.type === "mouse-click") {
    const button = msg.button === "right" ? "right" : "left";
    if (process.platform === "win32") {
      const isDouble = Boolean(msg.double);
      const isRight = button === "right";
      const downFlag = isRight ? "0x0008" : "0x0002";
      const upFlag = isRight ? "0x0010" : "0x0004";
      
      const hasCoords = msg.x !== undefined && msg.y !== undefined;
      let cx = 0, cy = 0;
      let flagDown = downFlag, flagUp = upFlag;
      
      if (hasCoords) {
        const absoluteFlag = "0x8000";
        if (msg.mode === "norm") {
          cx = Math.round(Math.max(0, Math.min(1, msg.x)) * 65535);
          cy = Math.round(Math.max(0, Math.min(1, msg.y)) * 65535);
        } else {
          const pxSize = getScreenSize();
          cx = Math.round((msg.x / Math.max(1, pxSize.width)) * 65535);
          cy = Math.round((msg.y / Math.max(1, pxSize.height)) * 65535);
        }
        flagDown = `${absoluteFlag} + ${downFlag}`;
        flagUp = `${absoluteFlag} + ${upFlag}`;
      }
      
      const psCmd = isDouble 
        ? `[InputInjector]::mouse_event(${flagDown}, ${cx}, ${cy}, 0, [UIntPtr]::Zero); [InputInjector]::mouse_event(${flagUp}, ${cx}, ${cy}, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [InputInjector]::mouse_event(${flagDown}, ${cx}, ${cy}, 0, [UIntPtr]::Zero); [InputInjector]::mouse_event(${flagUp}, ${cx}, ${cy}, 0, [UIntPtr]::Zero);`
        : `[InputInjector]::mouse_event(${flagDown}, ${cx}, ${cy}, 0, [UIntPtr]::Zero); [InputInjector]::mouse_event(${flagUp}, ${cx}, ${cy}, 0, [UIntPtr]::Zero);`;
      
      runPowerShellInputCommand(psCmd);
    } else if (robot) {
      robot.mouseClick(button, Boolean(msg.double));
    }
    return;
  }

  if (msg.type === "mouse-toggle") {
    const button = msg.button === "right" ? "right" : "left";
    const down = msg.down ? "down" : "up";
    if (process.platform === "win32") {
      const isRight = button === "right";
      const isDown = down === "down";
      let flag;
      if (isRight) {
        flag = isDown ? "0x0008" : "0x0010";
      } else {
        flag = isDown ? "0x0002" : "0x0004";
      }
      runPowerShellInputCommand(`[InputInjector]::mouse_event(${flag}, 0, 0, 0, [UIntPtr]::Zero)`);
    } else if (robot) {
      robot.mouseToggle(down, button);
    }
    return;
  }

  if (msg.type === "scroll") {
    const dx = Number.isFinite(msg.dx) ? msg.dx : 0;
    const dy = Number.isFinite(msg.dy) ? msg.dy : 0;
    if (process.platform === "win32") {
      // WHEEL_DELTA is typically 120
      // Use moderate sensitivity for smooth scrolling
      const wheelDelta = Math.max(-240, Math.min(240, Math.round(dy * 40)));
      if (wheelDelta !== 0) {
        // Convert to uint (handle negative values properly)
        const wheelDeltaUint = wheelDelta < 0 ? 0xFFFFFFFF + wheelDelta + 1 : wheelDelta;
        runPowerShellInputCommand(`[InputInjector]::mouse_event(0x0800, 0, 0, ${wheelDeltaUint}, [UIntPtr]::Zero)`);
      }
    } else if (robot) {
      robot.scrollMouse(Math.round(dx), Math.round(dy));
    }
    return;
  }

  if (msg.type === "key-tap") {
    if (typeof msg.key !== "string") return;
    const modifiers = Array.isArray(msg.modifiers) ? msg.modifiers.filter((m) => typeof m === "string") : [];
    
    if (process.platform === "win32") {
      // Map common keys to virtual key codes
      const keyMap = {
        "enter": "0x0D", "return": "0x0D",
        "escape": "0x1B", "esc": "0x1B",
        "space": "0x20", " ": "0x20",
        "tab": "0x09",
        "backspace": "0x08",
        "delete": "0x2E", "del": "0x2E",
        "up": "0x26", "down": "0x28", "left": "0x25", "right": "0x27",
        "home": "0x24", "end": "0x23",
        "pageup": "0x21", "pagedown": "0x22",
        "f1": "0x70", "f2": "0x71", "f3": "0x72", "f4": "0x73", "f5": "0x74",
        "f6": "0x75", "f7": "0x76", "f8": "0x77", "f9": "0x78", "f10": "0x79",
        "f11": "0x7A", "f12": "0x7B",
        "shift": "0x10", "control": "0x11", "ctrl": "0x11", "alt": "0x12",
        "win": "0x5B", "command": "0x5B", "cmd": "0x5B"
      };
      
      const vkCode = keyMap[msg.key.toLowerCase()];
      if (vkCode) {
        const modCodes = [];
        if (modifiers.includes("shift")) modCodes.push("0x10");
        if (modifiers.includes("control") || modifiers.includes("ctrl")) modCodes.push("0x11");
        if (modifiers.includes("alt")) modCodes.push("0x12");
        if (modifiers.includes("win") || modifiers.includes("command")) modCodes.push("0x5B");
        
        let psCmd = "";
        // Press modifiers
        modCodes.forEach(code => {
          psCmd += `[InputInjector]::keybd_event(${code}, 0, 0, [UIntPtr]::Zero); `;
        });
        // Press and release key
        psCmd += `[InputInjector]::keybd_event(${vkCode}, 0, 0, [UIntPtr]::Zero); `;
        psCmd += `[InputInjector]::keybd_event(${vkCode}, 0, 0x0002, [UIntPtr]::Zero); `;
        // Release modifiers (reverse order)
        [...modCodes].reverse().forEach(code => {
          psCmd += `[InputInjector]::keybd_event(${code}, 0, 0x0002, [UIntPtr]::Zero); `;
        });
        
        runPowerShellInputCommand(psCmd);
      } else if (msg.key.length === 1) {
        // Single character - use SendKeys as fallback
        const send = msg.key.toUpperCase() === msg.key ? "+" + msg.key.toLowerCase() : msg.key;
        runPowerShellInputCommand(`
          $ws = New-Object -ComObject WScript.Shell;
          $ws.SendKeys('${send.replace(/'/g, "''")}')
        `);
      }
    } else if (robot) {
      robot.keyTap(msg.key, modifiers);
    }
    return;
  }

  if (msg.type === "text") {
    if (typeof msg.text !== "string") return;
    if (robot) {
      robot.typeString(msg.text);
    } else if (process.platform === "win32") {
      execFile("powershell.exe", [
        "-NoProfile",
        "-Command",
        "$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('" +
          String(msg.text)
            .replace(/'/g, "''")
            .replace(/[{}^%~()+]/g, "{$&}") +
          "')",
      ]);
    }
  }
}

function isInputAvailable() {
  try {
    require("robotjs");
    return true;
  } catch {
    return process.platform === "win32";
  }
}

async function fetchProfileByEmail(email, { skipCache = false } = {}) {
  const emailLower = email.toLowerCase();
  
  // Check cache first (unless skipCache is true)
  if (!skipCache) {
    const cached = getCachedProfile(emailLower);
    if (cached) {
      return cached;
    }
  }
  
  // 1. Try Local DB (Read)
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("email, plan, verifier, trial, plan_expires_at")
        .eq("email", emailLower)
        .maybeSingle();

      if (error) {
        console.warn(`[Verifier] Fetch error: ${error.message}`);
      } else if (data) {
        console.log(`[Verifier] Profile found for ${emailLower}. Plan: ${data.plan}, Trial: ${data.trial}`);
        setCachedProfile(emailLower, data);
        return data;
      }
    } catch (err) {
      console.warn(`[Verifier] Local DB Exception: ${err.message}`);
    }
  } else {
    console.log("[Verifier] No local Supabase client. Using API fallback.");
  }

  // 2. Try API Fallback (Server-side fetch/create)
  const publicBase = getResolvedPublicBaseUrl();
  const baseUrl = publicBase ? publicBase : getLocalAccountBaseUrl();
  const url = new URL(baseUrl.toString());
  url.pathname = joinUrlPath(baseUrl.pathname, "api/plan");
  url.searchParams.set("email", emailLower);
  
  console.log(`[Verifier] Fetching profile via API: ${url.toString()}`);
  
  try {
     const res = await fetchJson(url.toString());
     if (res && res.ok && res.email) {
        const profile = {
           email: res.email,
           plan: res.plan,
           trial: res.trial,
           plan_expires_at: res.plan_expires_at,
           verifier: false 
        };
        setCachedProfile(emailLower, profile);
        return profile;
     }
  } catch (e) {
     console.error("[Verifier] API fetch failed:", e);
  }
  
  return null;
}

async function getEmailFromAuthHeader(req) {
  if (!supabase) return null;
  const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user || !data.user.email) {
      console.error("[AuthEmail] Failed to resolve user from token:", error && error.message);
      return null;
    }
    return data.user.email.toLowerCase();
  } catch (err) {
    console.error("[AuthEmail] Exception resolving user:", err.message);
    return null;
  }
}

async function generateDesktopLinkCode() {
  const base = getAccountBaseUrl();
  const url = new URL(base.toString());
  url.pathname = joinUrlPath(base.pathname, "api/desktop/generate-code");
  url.search = "";
  url.hash = "";
  const data = await fetchJson(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!data || !data.ok || !data.code) return null;
  return String(data.code);
}

async function resolveDesktopLinkCode(codeRaw) {
  const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
  if (!code) return null;
  const base = getAccountBaseUrl();
  const url = new URL(base.toString());
  url.pathname = joinUrlPath(base.pathname, "api/desktop/check-code");
  url.search = "";
  url.hash = "";
  const data = await fetchJson(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!data || !data.ok || !data.linked || !data.email) return null;
  return {
    email: data.email,
    plan: typeof data.plan === "string" && data.plan ? data.plan : "basic",
  };
}

async function startLocalBridgeServer() {
  const appServer = express();
  appServer.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "https://helvia.in");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  appServer.use(express.json());

  appServer.use((req, res, next) => {
    const plan = getCurrentPlan();
    if (plan !== "basic" && plan !== "trial") return next();

    const publicBase = getResolvedPublicBaseUrl();
    if (!publicBase) return next();

    const hostHeader = req.headers.host;
    if (hostHeader && hostHeader.toLowerCase() === publicBase.host.toLowerCase()) {
      res.status(403).send("Plan restriction: Basic/Trial plan supports LAN only.");
      return;
    }
    next();
  });
  const publicDir = path.join(__dirname, "..", "public");

  appServer.get("/m/", (req, res) => {
    res.sendFile(path.join(publicDir, "mobile", "index.html"));
  });
  appServer.use("/m/", express.static(path.join(publicDir, "mobile"), { index: false }));
  appServer.get("/d/", (req, res) => {
    res.sendFile(path.join(publicDir, "mobile", "index.html"));
  });
  appServer.use("/d/", express.static(path.join(publicDir, "mobile"), { index: false }));
  appServer.get("/health", (req, res) => res.json({ ok: true }));

  // linkStates is now global

  appServer.post("/api/link/complete", async (req, res) => {
    console.log("[Link] /api/link/complete called");
    const body = req.body || {};
    const token = typeof body.token === "string" ? body.token : "";
    const emailRaw = typeof body.email === "string" ? body.email : "";
    const planRaw = typeof body.plan === "string" ? body.plan : "";
    
    let email = emailRaw.trim().toLowerCase();
    if (!email) {
      const fromAuth = await getEmailFromAuthHeader(req);
      if (fromAuth) email = fromAuth;
    }

    if (!token || !email) {
      console.error("[Link] Missing token or email");
      res.status(400).json({ ok: false, error: "Missing token or email" });
      return;
    }
    
    let profile = await fetchProfileByEmail(email);
    if (!profile) {
      console.error(`[Link] Profile not found or DB error for ${email}`);
      res.status(404).json({ ok: false, error: "User profile not found" });
      return;
    }

    if (profile.verifier === true) {
      console.warn(`[Link] Login blocked: ${email} already logged in (verifier=true).`);
      res.status(409).json({ ok: false, error: "already-logged-in" });
      return;
    }

    // Success: Update verifier to true
    const verifierUpdated = await updateProfileVerifier(email, true);
    if (!verifierUpdated) {
       console.error(`[Link] Failed to update verifier for ${email}`);
       res.status(500).json({ ok: false, error: "Failed to update session state" });
       return;
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    if (supabase) {
      try {
        await supabase
          .from("profiles")
          .update({ link_code: token, link_code_expires_at: expiresAt })
          .eq("email", email);
      } catch {}
    }

    const stored = {
      email: profile.email,
      plan: profile.plan || "basic", // use plan from DB profile
      updatedAt: Date.now(),
    };
    linkStates.set(token, stored);
    console.log(`[Link] Success for ${email}, token linked.`);
    res.json({ ok: true, email: stored.email, plan: stored.plan });
  });

  appServer.get("/api/link/status", (req, res) => {
    const tokenParam = req.query && typeof req.query.token === "string" ? req.query.token : "";
    if (!tokenParam) {
      res.status(400).json({ ok: false, linked: false });
      return;
    }
    const info = linkStates.get(tokenParam);
    if (!info) {
      res.json({ ok: true, linked: false });
      return;
    }
    res.json({ ok: true, linked: true, email: info.email, plan: info.plan || "" });
  });

  const httpServer = http.createServer(appServer);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const plan = getCurrentPlan();
    const publicBase = getResolvedPublicBaseUrl();
    const hostHeader = req.headers.host;
    console.log(`[WS] Connection attempt - Plan: ${plan}, Host: ${hostHeader}, PublicBase: ${publicBase ? publicBase.host : 'none'}`);
    if (plan === "basic" || plan === "trial") {
      if (publicBase) {
        if (hostHeader && hostHeader.toLowerCase() === publicBase.host.toLowerCase()) {
          console.log(`[WS] Rejecting connection: LAN-only restriction for ${plan} plan`);
          closeSocket(ws, 4003, "plan-restriction-lan-only");
          return;
        }
      }
    }

    ensureSessionFresh();

    const url = new URL(req.url, "http://127.0.0.1");
    const token = url.searchParams.get("t");

    if (!token || token !== serverState.session.token) {
      closeSocket(ws, 4401, "unauthorized");
      return;
    }

    ws.on("message", (raw) => {
      const msg = safeJsonParse(String(raw));
      if (!msg || typeof msg.type !== "string") return;
      ensureSessionFresh();

      if (msg.type === "hello") {
        if (msg.role === "desktop") {
          if (serverState.session.desktopSocket && serverState.session.desktopSocket !== ws) {
            closeSocket(ws, 4409, "desktop-already-connected");
            return;
          }
          serverState.session.desktopSocket = ws;
          if (isOpen(serverState.session.mobileSocket)) {
            serverState.session.mobileSocket.send(JSON.stringify({ type: "peer", payload: { event: "desktop-online" } }));
            ws.send(JSON.stringify({ type: "peer", payload: { event: "mobile-online" } }));
          }
          broadcastStatus();
          return;
        }

        if (msg.role === "mobile") {
          if (serverState.session.mobileSocket && serverState.session.mobileSocket !== ws) {
            closeSocket(ws, 4409, "mobile-already-connected");
            return;
          }
          serverState.session.mobileSocket = ws;
          if (isOpen(serverState.session.desktopSocket)) {
            serverState.session.desktopSocket.send(JSON.stringify({ type: "peer", payload: { event: "mobile-online" } }));
            ws.send(JSON.stringify({ type: "peer", payload: { event: "desktop-online" } }));
          } else {
            ws.send(JSON.stringify({ type: "peer", payload: { event: "desktop-offline" } }));
          }
          broadcastStatus();
          return;
        }

        return;
      }

      const desktop = serverState.session.desktopSocket;
      const mobile = serverState.session.mobileSocket;

      if (msg.type === "signal") {
        const target = msg.target === "desktop" ? desktop : mobile;
        if (!isOpen(target)) return;
        target.send(JSON.stringify({ type: "signal", payload: msg.payload }));
        return;
      }

      if (msg.type === "peer") {
        const target = msg.target === "desktop" ? desktop : mobile;
        if (!isOpen(target)) return;
        target.send(JSON.stringify({ type: "peer", payload: msg.payload }));
        return;
      }

      if (msg.type === "input") {
        if (!isInputAvailable()) {
          try {
            ws.send(JSON.stringify({ type: "peer", payload: { event: "input-driver-unavailable" } }));
          } catch {}
          return;
        }
        handleInputMessage(msg.payload);
        return;
      }

      if (msg.type === "command") {
        if (typeof msg.command !== "string") return;
        if (msg.command === "disconnect") {
          resetSession();
          webrtcConnected = false;
          if (!isQuitting) setWindowHidden(false);
          return;
        }
        runWhitelistedCommand(msg.command);
      }
    });

    ws.on("close", (code) => {
      const wasMobile = serverState.session.mobileSocket === ws;
      if (serverState.session.desktopSocket === ws) serverState.session.desktopSocket = null;
      if (wasMobile) serverState.session.mobileSocket = null;
      broadcastStatus();
      if (wasMobile) {
        webrtcConnected = false;
        if (!isQuitting) setWindowHidden(false);
      }
      if (wasMobile && code !== 4001) resetSession({ keepDesktopSocket: true });
    });
  });

  await new Promise((resolve) => {
    httpServer.listen(8080, "0.0.0.0", () => resolve());
  });

  serverState.httpServer = httpServer;
  serverState.wss = wss;
  serverState.port = 8080;
  serverState.hostIp = getBestLanIPv4();

  // Periodic TTL enforcement
  setInterval(() => {
    const session = serverState.session;
    if (session && session.expiresAt && Date.now() > session.expiresAt) {
      // Session expired.
      // If we have active connections, this forces a disconnect.
      if (session.desktopSocket || session.mobileSocket) {
        resetSession({ keepDesktopSocket: false }); // Force close all
      }
    }
  }, 10000);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 720,
    resizable: false,
    title: "Helvia Remote",
    icon: appIconPath,
    frame: false,
    autoHideMenuBar: true,
    // Stealth settings
    skipTaskbar: false, // Show initially for login, hide after
    show: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
      // Additional stealth
      offscreen: false,
    },
  });

  // Enable content protection - prevents screen capture and screenshots
  mainWindow.setContentProtection(true);

  await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("close", (evt) => {
    if (isQuitting) return;
    if (webrtcConnected) {
      evt.preventDefault();
      setWindowHidden(true);
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("get-session-info", async () => {
  ensureSessionFresh();
  const mobileUrl = await getMobileUrl();
  const desktopUrl = await getDesktopUrl();
  const wsUrl = await getWsUrl();
  return {
    token: serverState.session.token,
    expiresAt: serverState.session.expiresAt,
    mobileUrl,
    qrDataUrl: await qrcode.toDataURL(mobileUrl, { errorCorrectionLevel: "M", margin: 1, scale: 8 }),
    desktopUrl,
    desktopQrDataUrl: await qrcode.toDataURL(desktopUrl, { errorCorrectionLevel: "M", margin: 1, scale: 8 }),
    wsUrl,
    dailyRoomUrl: "",
    agoraAppId: "",
    agoraChannel: "",
    agoraToken: "",
  };
});

ipcMain.handle("regenerate-session", async () => {
  const acc = loadStoredAccount();
  if (!acc || !acc.email) throw new Error("no-account");
  
  const profile = await fetchProfileByEmail(acc.email);
  if (!profile) throw new Error("profile-fetch-failed");
  
  let plan = profile.plan || "basic";
  let customTtl = undefined;
  
  // Handle expiry for 'trial' plan
  if (plan === "trial" && profile.plan_expires_at) {
    if (new Date(profile.plan_expires_at) < new Date()) {
      plan = "basic"; 
      saveStoredAccount({ email: acc.email, plan: "basic" });
      console.log(`[Session] Trial expired for ${acc.email}. Reverted to basic.`);
    } else {
      // Ensure stored plan is 'trial'
      saveStoredAccount({ email: acc.email, plan: "trial" });
      
      const expiry = new Date(profile.plan_expires_at);
      const now = new Date();
      customTtl = expiry.getTime() - now.getTime();
      if (customTtl <= 0) {
          plan = "basic";
          saveStoredAccount({ email: acc.email, plan: "basic" });
      }
    }
  } else if (plan !== "basic") {
    // For paid/pro accounts, check if plan has an expiration date, otherwise default to 24h
    if (profile.plan_expires_at) {
      const expiry = new Date(profile.plan_expires_at);
      const now = new Date();
      const remaining = expiry.getTime() - now.getTime();
      if (remaining > 0) {
        customTtl = remaining;
      } else {
        customTtl = PAID_SESSION_TTL_MS;
      }
    } else {
      customTtl = PAID_SESSION_TTL_MS;
    }
  }

  // Basic plan cannot start session unless trial activated
  if (plan === "basic") {
     console.warn(`[Session] Basic plan user ${acc.email} attempted session. Blocked.`);
     throw new Error("trial-required");
  }

  console.log(`[Session] Starting session for ${acc.email} (Plan: ${plan}, TTL: ${Math.round((customTtl || PAID_SESSION_TTL_MS)/1000)}s)`);
  
  resetSession({ keepDesktopSocket: true, ttl: customTtl });
  const mobileUrl = await getMobileUrl();
  const desktopUrl = await getDesktopUrl();
  const wsUrl = await getWsUrl();
  return {
    token: serverState.session.token,
    expiresAt: serverState.session.expiresAt,
    mobileUrl,
    qrDataUrl: await qrcode.toDataURL(mobileUrl, { errorCorrectionLevel: "M", margin: 1, scale: 8 }),
    desktopUrl,
    desktopQrDataUrl: await qrcode.toDataURL(desktopUrl, { errorCorrectionLevel: "M", margin: 1, scale: 8 }),
    wsUrl,
    dailyRoomUrl: "",
    agoraAppId: "",
    agoraChannel: "",
    agoraToken: "",
  };
});

ipcMain.handle("get-desktop-source-id", async () => {
  if (!desktopCapturer || typeof desktopCapturer.getSources !== "function") {
    throw new Error("desktop-capturer-unavailable");
  }
  // Get all screen sources including entire desktop
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
  if (!sources || sources.length === 0) throw new Error("no-screen-source");
  
  // Prefer the entire screen source over individual windows
  const entireScreen = sources.find(s => s.name === "Entire screen" || s.name === "Screen 1");
  return entireScreen ? entireScreen.id : sources[0].id;
});

ipcMain.handle("get-screen-size", async () => {
  return getScreenSize();
});

ipcMain.handle("generate-link-code", async () => {
  const code = await generateDesktopLinkCode();
  if (!code) throw new Error("link-code-failed");
  return { code };
});

ipcMain.handle("get-user-status", async () => {
  const acc = loadStoredAccount();
  if (!acc || !acc.email) return null;
  
  let profile = null;
  try {
    profile = await fetchProfileByEmail(acc.email);
  } catch (e) {
    console.warn("[UserStatus] Fetch failed, using cached account:", e);
  }

  // If fetch failed, fallback to stored account (Offline Mode)
  if (!profile) {
     console.log(`[UserStatus] Using cached plan for ${acc.email}: ${acc.plan}`);
     return {
        email: acc.email,
        plan: acc.plan,
        trial: false, // Default to false if unknown
        expiresAt: acc.plan_expires_at
     };
  }
  
  let plan = profile.plan;
  if (plan === "trial" && profile.plan_expires_at) {
    if (new Date(profile.plan_expires_at) < new Date()) {
      plan = "basic"; 
    }
  }

  // Update stored account with fresh data
  saveStoredAccount({ 
    email: profile.email, 
    plan: plan, 
    plan_expires_at: profile.plan_expires_at 
  });

  return {
     email: profile.email,
     plan: plan,
     trial: profile.trial,
     expiresAt: profile.plan_expires_at
  };
});

ipcMain.handle("activate-trial", async () => {
  const acc = loadStoredAccount();
  if (!acc || !acc.email) return false;
  
  // Skip cache to get fresh data for trial check
  const profile = await fetchProfileByEmail(acc.email, { skipCache: true });
  if (!profile) return false;

  // Allow activation if plan is basic (and trial not used, or re-activation allowed?)
  // User said "when the plan is basic and trail is false".
  if (profile.plan === "basic" && !profile.trial) {
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const updated = await updateProfileTrial(acc.email, true);
      if (updated) {
         saveStoredAccount({ email: acc.email, plan: "trial", plan_expires_at: expiresAt });
         invalidateProfileCache(acc.email); // Clear cache after trial activation
      }
      return updated;
   }
  return false;
});

ipcMain.handle("logout", async (e, emailArg) => {
  const email = typeof emailArg === "string" ? emailArg.trim().toLowerCase() : "";
  console.log(`[Logout] Requested for ${email}`);
  if (!email) return false;
  
  // Clear any pending link state for current session token
  const token = serverState.session.token;
  if (token) {
    if (linkStates.has(token)) {
      linkStates.delete(token);
      console.log(`[Logout] Cleared link state for token: ${token.slice(0, 8)}...`);
    }
  }

  const base = getAccountBaseUrl();
  const url = new URL(base.toString());
  url.pathname = joinUrlPath(base.pathname, "api/link/logout");
  url.search = "";
  url.hash = "";

  // Try to notify the remote server (optional, best-effort)
  try {
    fetchJson(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch {}

  // ALWAYS update the profile verifier in Supabase
  let result = false;
  if (supabase) {
    result = await updateProfileVerifier(email, false);
    console.log(`[Logout] updateProfileVerifier result: ${result}`);
  }

  return result;
});

ipcMain.handle("check-link-code", async (_evt, code) => {
  const info = await resolveDesktopLinkCode(code);
  if (!info) return null;
  saveStoredAccount({ email: info.email, plan: info.plan });
  return info;
});

ipcMain.handle("get-stored-account", async () => {
  const acc = loadStoredAccount();
  if (!acc) return null;
  // Ensure we return the latest plan from the stored account (which might have been updated by getUserStatus)
  // If the plan is 'trial' but expired locally, we should probably return 'basic' here too, 
  // but let's trust loadStoredAccount's raw data and let the renderer handle logic or getUserStatus override.
  // Actually, let's include plan_expires_at so renderer has full context immediately.
  return { 
    email: acc.email, 
    plan: acc.plan, 
    plan_expires_at: acc.plan_expires_at 
  };
});

ipcMain.handle("set-stored-account", async (_evt, payload) => {
  const email = payload && typeof payload.email === "string" ? payload.email : "";
  const plan = payload && typeof payload.plan === "string" ? payload.plan : "";
  const expiresAt = payload && typeof payload.expiresAt === "string" ? payload.expiresAt : (payload.plan_expires_at || null);

  if (!email.trim()) {
    clearStoredAccount();
    return null;
  }
  
  // Save with the provided plan and expiry
  saveStoredAccount({ email, plan, plan_expires_at: expiresAt });
  return { email, plan, plan_expires_at: expiresAt };
});

ipcMain.handle("clear-stored-account", async () => {
  clearStoredAccount();
  return null;
});

ipcMain.handle("refresh-plan", async (_evt, emailRaw) => {
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  if (!email) return null;
  const base = getAccountBaseUrl();
  const url = new URL(base.toString());
  url.pathname = joinUrlPath(base.pathname, "api/plan");
  url.search = `email=${encodeURIComponent(email)}`;
  url.hash = "";
  const data = await fetchJson(url.toString());
  if (!data || !data.ok || !data.email) return null;
  const plan = typeof data.plan === "string" && data.plan ? data.plan : "basic";
  const plan_expires_at = typeof data.plan_expires_at === "string" ? data.plan_expires_at : null;
  
  saveStoredAccount({ email: data.email, plan, plan_expires_at });
  return { email: data.email, plan, plan_expires_at, trial: data.trial };
});

ipcMain.on("inject-input", (_evt, payload) => {
  handleInputMessage(payload);
});

ipcMain.on("run-command", (_evt, command) => {
  if (typeof command !== "string") return;
  if (command === "disconnect") {
    resetSession({ keepDesktopSocket: true });
    webrtcConnected = false;
    if (!isQuitting) setWindowHidden(false);
    return;
  }
  runWhitelistedCommand(command);
});

ipcMain.on("webrtc-state", (_evt, state) => {
  if (state === "connected") {
    webrtcConnected = true;
    if (!isQuitting) setWindowHidden(true);
    return;
  }
  webrtcConnected = false;
  if (!isQuitting) setWindowHidden(false);
});

ipcMain.on("app-quit", () => {
  isQuitting = true;
  app.quit();
});

ipcMain.on("open-dev-tools", () => {
  if (mainWindow) {
    mainWindow.webContents.openDevTools();
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  
  // Hide from Task Manager on Windows
  hideFromTaskManager();
  
  await startLocalBridgeServer();
  resetSession({ keepDesktopSocket: true });
  await createWindow();
  broadcastStatus();

  globalShortcut.register("CommandOrControl+Q", () => {
    if (isQuitting || !mainWindow) return;
    const visible = mainWindow.isVisible();
    setWindowHidden(visible);
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
});
