const loginCard = document.getElementById("loginCard");
const sessionCard = document.getElementById("sessionCard");
const loginConnectBtn = document.getElementById("loginConnectBtn");
const loginStatusText = document.getElementById("loginStatusText");
const loginCodeValue = document.getElementById("loginCodeValue");
const loginCodeCopyBtn = document.getElementById("loginCodeCopyBtn");
const qrImg = document.getElementById("qrImg");
const qrWrap = document.getElementById("qrWrap");
const mobileUrlEl = document.getElementById("mobileUrl");
const copyBtn = document.getElementById("copyBtn");
const regenBtn = document.getElementById("regenBtn");
const quitBtn = document.getElementById("quitBtn");
const desktopStatus = document.getElementById("desktopStatus");
const mobileStatus = document.getElementById("mobileStatus");
const ttlEl = document.getElementById("ttl");
const pairingControls = document.getElementById("pairingControls");
const desktopDisconnectRow = document.getElementById("desktopDisconnectRow");
const desktopDisconnectBtn = document.getElementById("desktopDisconnectBtn");
const logoutBtn = document.getElementById("logoutBtn");
const userLabel = document.getElementById("userLabel");
const startSection = document.getElementById("startSection");
const startSessionBtn = document.getElementById("startSessionBtn");
const activateTrialBtn = document.getElementById("activateTrialBtn");
const planWarning = document.getElementById("planWarning");
const sessionSub = document.getElementById("sessionSub");
const clientChoiceBackdrop = document.getElementById("clientChoiceBackdrop");
const chooseMobileBtn = document.getElementById("chooseMobileBtn");
const chooseDesktopBtn = document.getElementById("chooseDesktopBtn");
const choiceCancelBtn = document.getElementById("choiceCancelBtn");

let sessionInfo = null;
let ws = null;
let wsReconnectTimer = null;
let wsReconnectDelayMs = 500;
let pc = null;
let dataChannel = null;
let captureStream = null;
let cameraStream = null;
let micStream = null;
let screenVideoTrack = null;
let cameraVideoTrack = null;
let micAudioTrack = null;
let videoSender = null;
let audioSender = null;
let cameraEnabled = false;
let micEnabled = false;
let started = false;
let lastRestartAt = 0;
let statsTimer = null;
let lastBytesSent = 0;
let stableTicks = 0;
let restarting = false;
let disconnectTimer = null;
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
let dailyCall = null;
let agoraClient = null;
let agoraVideoTrack = null;
let agoraStreamId = null;
let uiConnected = false;
let linkPollTimer = null;
let currentAccount = null;
let planCheckTimer = null;
let controllerType = "mobile";
let planRefreshInProgress = false;
let pendingPlanRefresh = false;

// Internet check elements
const noInternetCard = document.getElementById("noInternetCard");
const retryInternetBtn = document.getElementById("retryInternetBtn");
const loadingCard = document.getElementById("loadingCard");

function setPill(el, ok, label) {
  el.classList.remove("good", "bad");
  el.classList.add(ok ? "good" : "bad");
  el.textContent = label;
}

function setUiConnected(connected) {
  uiConnected = connected;
  if (pairingControls) pairingControls.hidden = connected;
  if (desktopDisconnectRow) desktopDisconnectRow.hidden = !connected;
}

function showLoginView() {
  if (loadingCard) loadingCard.hidden = true;
  if (loginCard) loginCard.hidden = false;
  if (sessionCard) sessionCard.hidden = true;
  if (noInternetCard) noInternetCard.hidden = true;
  if (userLabel) userLabel.textContent = "";
  currentAccount = null;
}

function showSessionView() {
  if (loadingCard) loadingCard.hidden = true;
  if (loginCard) loginCard.hidden = true;
  if (sessionCard) sessionCard.hidden = false;
  if (noInternetCard) noInternetCard.hidden = true;
  
  // Reset to initial state
  if (startSection) startSection.hidden = false;
  if (pairingControls) pairingControls.hidden = true;
  if (desktopDisconnectRow) desktopDisconnectRow.hidden = true;
  if (planWarning) planWarning.style.display = "none";
  if (sessionSub) sessionSub.textContent = "Connect a mobile device to control this desktop.";
  if (clientChoiceBackdrop) clientChoiceBackdrop.hidden = true;
  controllerType = "mobile";

  if (startSessionBtn) startSessionBtn.style.display = "none";
  if (activateTrialBtn) activateTrialBtn.style.display = "none";

  // Stop any previous sessions if not connected
  if (!uiConnected) {
     // we could teardown, but maybe user just logged in. 
     // We'll leave teardown logic to logout or explicit disconnect.
  }
}

function showNoInternetView() {
  if (loadingCard) loadingCard.hidden = true;
  if (loginCard) loginCard.hidden = true;
  if (sessionCard) sessionCard.hidden = true;
  if (noInternetCard) noInternetCard.hidden = false;
}

// Check internet connectivity
async function checkInternet() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch("https://www.google.com/favicon.ico", {
      method: "HEAD",
      signal: controller.signal,
      cache: "no-store"
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

// Initialize app with internet check
async function initApp() {
  const hasInternet = await checkInternet();
  
  if (!hasInternet) {
    showNoInternetView();
    return;
  }
  
  // Internet available - proceed with stored account check
  await applyStoredAccount();
}

// Retry button handler
if (retryInternetBtn) {
  retryInternetBtn.addEventListener("click", async () => {
    retryInternetBtn.textContent = "Checking...";
    retryInternetBtn.disabled = true;
    
    const hasInternet = await checkInternet();
    
    retryInternetBtn.textContent = "Retry";
    retryInternetBtn.disabled = false;
    
    if (hasInternet) {
      await applyStoredAccount();
    }
  });
}

async function applyStoredAccount() {
  try {
    const acc = await window.bridge.getStoredAccount();
    if (!acc || !acc.email) {
      showLoginView();
      return;
    }
    currentAccount = acc;
    if (userLabel) {
    userLabel.textContent = acc.plan ? `${acc.email} (${acc.plan})` : acc.email;
  }
  showSessionView();

  // Listen for session status updates from main process
  if (window.bridge.onSessionStatus) {
    window.bridge.onSessionStatus((status) => {
      if (!status || !sessionInfo) return;
      if (status.expiresAt) {
        sessionInfo.expiresAt = status.expiresAt;
      }
    });
  }

  if (window.bridge.onWindowShown) {
    window.bridge.onWindowShown(() => {
      refreshPlanAndEnforce().catch(() => {});
    });
  }

  if (sessionSub) {
    sessionSub.textContent = "Connecting...";
  }
    if (planCheckTimer) {
      clearInterval(planCheckTimer);
      planCheckTimer = null;
    }
    refreshPlanAndEnforce().catch(() => {});
    planCheckTimer = setInterval(() => {
      refreshPlanAndEnforce().catch(() => {});
    }, 90000);
  } catch (err) {
    console.error(err);
    showLoginView();
  }
}

async function performDesktopDisconnect(message) {
  await teardownAgora();
  teardownDaily();
  teardownPeer();
  started = false;
  resetWs();
  window.bridge.runCommand("disconnect");
  showSessionView();
  if (message && planWarning) {
    planWarning.textContent = message;
    planWarning.style.display = "block";
  }
}

async function startCodeLinkFlow() {
  if (linkPollTimer) {
    clearInterval(linkPollTimer);
    linkPollTimer = null;
  }
  if (loginStatusText) loginStatusText.textContent = "Generating code...";
  if (loginCodeValue) {
    loginCodeValue.textContent = "------";
    loginCodeValue.classList.add("empty");
  }
  if (loginCodeCopyBtn) {
    loginCodeCopyBtn.disabled = true;
  }
  let code = "";
  try {
    const result = await window.bridge.generateLinkCode();
    if (result && result.code) code = String(result.code);
  } catch {
    if (loginStatusText) loginStatusText.textContent = "Failed to generate code. Please try again.";
    return;
  }
  if (!code) {
    if (loginStatusText) loginStatusText.textContent = "Failed to generate code. Please try again.";
    return;
  }
  if (loginCodeValue) {
    loginCodeValue.textContent = code;
    loginCodeValue.classList.remove("empty");
  }
  if (loginCodeCopyBtn) {
    loginCodeCopyBtn.disabled = false;
  }
  if (loginStatusText) loginStatusText.textContent = "Enter this code on helvia.in after logging in.";
  linkPollTimer = setInterval(async () => {
    try {
      const info = await window.bridge.checkLinkCode(code);
      if (info && info.email) {
        if (loginStatusText) loginStatusText.textContent = "";
        if (userLabel) {
          userLabel.textContent = info.plan ? `${info.email} (${info.plan})` : info.email;
        }
        currentAccount = { email: info.email, plan: info.plan || "basic" };
        try {
          await window.bridge.setStoredAccount(currentAccount);
        } catch {}
        showSessionView();
        clearInterval(linkPollTimer);
        linkPollTimer = null;
        if (planCheckTimer) {
          clearInterval(planCheckTimer);
          planCheckTimer = null;
        }
        planCheckTimer = setInterval(() => {
          refreshPlanAndEnforce().catch(() => {});
        }, 90000);
      }
    } catch {}
  }, 3000);
}

async function refreshPlanAndEnforce() {
  if (!currentAccount || !currentAccount.email) return;
  
  // Debounce: if already in progress, mark as pending and return
  if (planRefreshInProgress) {
    pendingPlanRefresh = true;
    return;
  }
  
  planRefreshInProgress = true;
  pendingPlanRefresh = false;
  
  let status = null;
  try {
    status = await window.bridge.getUserStatus();
  } catch (e) {
    console.error("Failed to get user status:", e);
  }

  if (status) {
    currentAccount = {
      email: status.email,
      plan: status.plan || "basic",
      trial: status.trial,
      expiresAt: status.expiresAt
    };
  } else {
    // Fallback to refreshPlan if getUserStatus fails
    try {
      const refreshed = await window.bridge.refreshPlan(currentAccount.email);
      if (refreshed) {
        currentAccount = {
          email: refreshed.email,
          plan: refreshed.plan || "basic",
          trial: refreshed.trial,
          expiresAt: refreshed.plan_expires_at
        };
      }
    } catch {}
  }

  try {
    await window.bridge.setStoredAccount(currentAccount);
  } catch {}

  if (userLabel) {
    let label = currentAccount.email;
    if (currentAccount.plan) label += ` (${currentAccount.plan})`;
    userLabel.textContent = label;
  }

  const plan = (currentAccount.plan || "").toLowerCase();
  
  // Double-check: if plan is 'trial' but expired, treat it as expired trial
  // BUT: The user specifically said "when logged in email and plan is pro make it to show start session".
  // The issue is likely that sometimes `plan` is not being updated correctly or falling back to basic/trial.
  // Let's ensure if it is PRO, it STAYS PRO in UI.

  let isExpired = false;
  if (currentAccount.expiresAt) {
    isExpired = new Date(currentAccount.expiresAt) < new Date();
  }

  const sessionActive = started || uiConnected;

  if (plan === "basic" && sessionActive) {
    window.bridge.quitApp();
    return;
  }

  if (plan === "trial" && isExpired && sessionActive) {
    window.bridge.quitApp();
    return;
  }

  if (plan === "pro") {
    if (startSessionBtn) startSessionBtn.style.display = "block";
    if (activateTrialBtn) activateTrialBtn.style.display = "none";
    if (planWarning) planWarning.style.display = "none";
    planRefreshInProgress = false;
    // If there was a pending refresh, trigger it
    if (pendingPlanRefresh) {
      setTimeout(() => refreshPlanAndEnforce().catch(() => {}), 100);
    }
    return; // Exit early to prevent any other logic from overriding
  }

  // Strict check for Trial (must be 'trial' AND not expired)
  if (plan === "trial" && !isExpired) {
    if (startSessionBtn) startSessionBtn.style.display = "block";
    if (activateTrialBtn) activateTrialBtn.style.display = "none";
    
    const mins = Math.ceil((new Date(currentAccount.expiresAt) - Date.now()) / 60000);
    if (planWarning) {
      planWarning.textContent = `Trial Active: ${mins}m remaining (LAN Only).`;
      planWarning.style.display = "block";
      planWarning.style.color = "#fbbf24";
    }
    planRefreshInProgress = false;
    if (pendingPlanRefresh) {
      setTimeout(() => refreshPlanAndEnforce().catch(() => {}), 100);
    }
    return;
  }
  
  // Default / Fallback to Basic behavior (Strictly Hidden)
  // This covers: plan="basic", plan="trial" (expired), or any other unknown state
  if (startSessionBtn) startSessionBtn.style.display = "none";
  
  if (plan === "trial" && isExpired) {
     if (activateTrialBtn) {
        activateTrialBtn.style.display = "block";
        activateTrialBtn.textContent = "Trial Expired";
        activateTrialBtn.disabled = true;
        activateTrialBtn.style.background = "#ef4444";
     }
     if (planWarning) {
        planWarning.textContent = "Trial Expired. Please upgrade to Pro.";
        planWarning.style.display = "block";
        planWarning.style.color = "#fca5a5";
     }
  } else {
     // Basic
     if (currentAccount.trial === true) {
        if (activateTrialBtn) {
           activateTrialBtn.style.display = "block";
           activateTrialBtn.textContent = "Trial Already Used";
           activateTrialBtn.disabled = true;
           activateTrialBtn.style.background = "#6b7280";
        }
     } else {
        if (activateTrialBtn) {
           activateTrialBtn.style.display = "block";
           activateTrialBtn.textContent = "Activate 10m Trial";
           activateTrialBtn.disabled = false;
           activateTrialBtn.style.background = "#eab308";
        }
     }
     if (planWarning) {
        planWarning.style.display = "none";
     }
  }
  
  planRefreshInProgress = false;
  if (pendingPlanRefresh) {
    setTimeout(() => refreshPlanAndEnforce().catch(() => {}), 100);
  }
}

if (activateTrialBtn) {
  activateTrialBtn.addEventListener("click", async () => {
    if (currentAccount && currentAccount.trial === true) {
      return;
    }
    activateTrialBtn.disabled = true;
    activateTrialBtn.textContent = "Activating...";
    try {
      const success = await window.bridge.activateTrial();
      if (success) {
        await refreshPlanAndEnforce();
      } else {
        alert("Failed to activate trial. Please try again.");
        activateTrialBtn.disabled = false;
        activateTrialBtn.textContent = "Activate 10m Trial";
      }
    } catch (e) {
      console.error(e);
      alert("Error activating trial.");
      activateTrialBtn.disabled = false;
      activateTrialBtn.textContent = "Activate 10m Trial";
    }
  });
}

async function handleStartSession() {
  if (!currentAccount) return;
  const plan = (currentAccount.plan || "").toLowerCase();
  
  // Strict Enforcement: Block Basic Plan
  // Only allow if plan is 'trial' or 'pro'
  if (plan !== "trial" && plan !== "pro") {
    // Should be hidden by UI, but double safety
    if (startSessionBtn) startSessionBtn.style.display = "none";
    alert("Please activate a trial or upgrade to Pro to start a session.");
    return;
  }
  
  // Show plan-specific warning
  if (plan === "pro") {
    if (planWarning) planWarning.style.display = "none";
  } else if (plan === "trial") {
    if (planWarning) {
        planWarning.textContent = "Trial Active: Session limited to 10 minutes (LAN only).";
        planWarning.style.display = "block";
    }
  }
    
  // Show choice dialog for all valid plans (Pro and Trial)
  if (clientChoiceBackdrop) {
      clientChoiceBackdrop.hidden = false;
      return;
  }
  
  // Fallback if backdrop doesn't exist
  controllerType = "mobile";
  if (startSection) startSection.hidden = true;
  if (pairingControls) pairingControls.hidden = false;
  if (sessionSub) sessionSub.textContent = "Scan this QR code from your phone to take control of this desktop.";
  await loadSessionInfo();
}

if (startSessionBtn) {
  startSessionBtn.addEventListener("click", handleStartSession);
}

function getControllerUrl() {
  if (!sessionInfo) return "";
  if (controllerType === "desktop") return (sessionInfo.desktopUrl && String(sessionInfo.desktopUrl)) || "";
  return (sessionInfo.mobileUrl && String(sessionInfo.mobileUrl)) || "";
}

function getControllerQrDataUrl() {
  if (!sessionInfo) return "";
  if (controllerType === "desktop") return (sessionInfo.desktopQrDataUrl && String(sessionInfo.desktopQrDataUrl)) || "";
  return (sessionInfo.qrDataUrl && String(sessionInfo.qrDataUrl)) || "";
}

function applyControllerChoiceUi() {
  const url = getControllerUrl();
  const qrDataUrl = getControllerQrDataUrl();

  if (qrWrap) qrWrap.hidden = controllerType === "desktop";
  if (qrImg && qrDataUrl) qrImg.src = qrDataUrl;

  if (mobileUrlEl) {
    mobileUrlEl.hidden = !url || controllerType !== "desktop";
    mobileUrlEl.textContent = url || "";
  }

  if (sessionSub) {
    sessionSub.textContent =
      controllerType === "desktop"
        ? "Open this link on another desktop to control this PC."
        : "Scan this QR code from your phone to take control of this desktop.";
  }
}

async function beginSession(nextType) {
  controllerType = nextType === "desktop" ? "desktop" : "mobile";
  if (clientChoiceBackdrop) clientChoiceBackdrop.hidden = true;
  if (startSection) startSection.hidden = true;
  if (pairingControls) pairingControls.hidden = false;
  await loadSessionInfo();
}

if (chooseMobileBtn) {
  chooseMobileBtn.addEventListener("click", () => {
    beginSession("mobile").catch(() => {});
  });
}

if (chooseDesktopBtn) {
  chooseDesktopBtn.addEventListener("click", () => {
    beginSession("desktop").catch(() => {});
  });
}

if (choiceCancelBtn) {
  choiceCancelBtn.addEventListener("click", () => {
    if (clientChoiceBackdrop) clientChoiceBackdrop.hidden = true;
  });
}

if (loginConnectBtn) {
  loginConnectBtn.addEventListener("click", () => {
    startCodeLinkFlow();
  });
}

if (loginCodeCopyBtn) {
  loginCodeCopyBtn.addEventListener("click", () => {
    if (!loginCodeValue) return;
    const text = (loginCodeValue.textContent || "").trim();
    if (!text || text === "------") return;
    window.bridge.copyText(text);
  });
}

if (desktopDisconnectBtn) {
  desktopDisconnectBtn.addEventListener("click", () => {
    performDesktopDisconnect().catch(() => {});
  });
}

function formatTtl(expiresAt) {
  const ms = Math.max(0, expiresAt - Date.now());
  const s = Math.floor(ms / 1000);
  return `${s}s`;
}

async function ensureCaptureStream() {
  if (captureStream) return captureStream;
  const sourceId = await window.bridge.getDesktopSourceId();
  
  // Get actual screen size for proper coordinate mapping
  const screenInfo = await window.bridge.getScreenSize();
  const screenWidth = screenInfo?.width || 1920;
  const screenHeight = screenInfo?.height || 1080;
  console.log("[Desktop] Capturing at screen resolution:", screenWidth, "x", screenHeight);
  
  // Request full screen capture at native resolution for accurate coordinate mapping
  captureStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        // Capture at native screen resolution for accurate coordinate mapping
        minWidth: screenWidth,
        maxWidth: screenWidth,
        minHeight: screenHeight,
        maxHeight: screenHeight,
        maxFrameRate: 30,
        // Disable features that add latency
        googLeakyBucket: false,
        googTemporalLayeredScreencast: false,
      },
    },
  });
  
  const track = captureStream.getVideoTracks()[0] || null;
  if (track) {
    screenVideoTrack = track;
    console.log("[Desktop] Capture track obtained:", track.label, "enabled:", track.enabled, "readyState:", track.readyState);
    // Set content hint for screen sharing - motion for smoother video
    track.contentHint = "motion";
    
    // Get actual captured dimensions
    const settings = track.getSettings();
    console.log("[Desktop] Actual capture dimensions:", settings.width, "x", settings.height);
    
    // Monitor track state
    track.onmute = () => console.log("[Desktop] Capture track muted");
    track.onunmute = () => console.log("[Desktop] Capture track unmuted");
    track.onended = () => console.log("[Desktop] Capture track ended");
  } else {
    console.log("[Desktop] No video track in capture stream!");
  }
  return captureStream;
}

async function ensureCameraStream() {
  if (cameraStream) return cameraStream;
  cameraStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: true,
  });
  cameraVideoTrack = cameraStream.getVideoTracks()[0] || null;
  return cameraStream;
}

async function ensureMicStream() {
  if (micStream) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  micAudioTrack = micStream.getAudioTracks()[0] || null;
  if (micAudioTrack) micAudioTrack.enabled = false;
  return micStream;
}

function createPeerConnection() {
  const peer = new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  });

  peer.onicecandidate = (evt) => {
    if (!evt.candidate) {
      console.log("[Desktop] ICE gathering complete");
      return;
    }
    console.log("[Desktop] Sending ICE candidate to mobile");
    sendSignal({ type: "candidate", candidate: evt.candidate });
  };

  peer.onconnectionstatechange = () => {
    const st = peer.connectionState;
    console.log("[Desktop] Connection state:", st);
    if (st === "connected") {
      window.bridge.setWebrtcState("connected");
      setUiConnected(true);
    }
    if (st === "failed") {
      console.log("[Desktop] Connection failed, scheduling restart");
      scheduleRestart("failed", false);
      return;
    }
    if (st === "disconnected") {
      // Give more time for connection to recover before restarting
      if (disconnectTimer) clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => {
        if (!pc) return;
        if (pc.connectionState === "disconnected") {
          console.log("[Desktop] Connection still disconnected after 8s, restarting");
          scheduleRestart("disconnected", false);
        }
      }, 8000); // Increased from 4s to 8s
      return;
    }
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  };

  // Monitor ICE connection state for better debugging
  peer.oniceconnectionstatechange = () => {
    console.log("[Desktop] ICE connection state:", peer.iceConnectionState);
  };

  // Handle connection errors
  peer.onerror = (err) => {
    console.error("[Desktop] Peer connection error:", err);
  };

  return peer;
}

function teardownPeer() {
  try {
    if (dataChannel) dataChannel.close();
  } catch {}
  dataChannel = null;

  try {
    if (pc && pc.connectionState !== "closed") pc.close();
  } catch {}
  pc = null;
  if (disconnectTimer) clearTimeout(disconnectTimer);
  disconnectTimer = null;
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  lastBytesSent = 0;
  stableTicks = 0;
  window.bridge.setWebrtcState("disconnected");
  setUiConnected(false);
}

function teardownDaily() {
  try {
    if (dailyCall) dailyCall.leave();
  } catch {}
  dailyCall = null;
  window.bridge.setWebrtcState("disconnected");
}

async function teardownAgora() {
  const client = agoraClient;
  agoraClient = null;

  try {
    if (agoraVideoTrack) agoraVideoTrack.close();
  } catch {}
  agoraVideoTrack = null;
  agoraStreamId = null;

  try {
    if (client) await client.leave();
  } catch {}

  window.bridge.setWebrtcState("disconnected");
  setUiConnected(false);
}

function sendSignal(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log("[Desktop] Cannot send signal - WebSocket not open, state=", ws ? ws.readyState : "null");
    return;
  }
  try {
    const msg = JSON.stringify({ type: "signal", target: "mobile", payload });
    console.log("[Desktop] Sending signal:", payload.type, "target: mobile");
    ws.send(msg);
  } catch (e) {
    console.log("[Desktop] Failed to send signal:", e);
  }
}

function sendPeer(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "peer", target: "mobile", payload }));
  } catch {}
}

async function handleMediaMessage(msg) {
  if (!msg || typeof msg.kind !== "string") return;
  if (!pc || pc.connectionState === "closed") return;

  if (msg.kind === "mic") {
    if (!micAudioTrack) return;
    micEnabled = Boolean(msg.enabled);
    micAudioTrack.enabled = micEnabled;
    return;
  }

  if (msg.kind === "camera") {
    if (msg.enabled) {
      if (cameraEnabled) return;
      cameraEnabled = true;
      try {
        await ensureCameraStream();
        const nextTrack = cameraVideoTrack;
        if (!nextTrack) {
          cameraEnabled = false;
          return;
        }
        const sender = videoSender || (pc.getSenders().find((s) => s.track && s.track.kind === "video") || null);
        if (!sender) return;
        videoSender = sender;
        await sender.replaceTrack(nextTrack);
      } catch {
        cameraEnabled = false;
      }
      return;
    }

    cameraEnabled = false;
    const sender = videoSender || (pc.getSenders().find((s) => s.track && s.track.kind === "video") || null);
    const nextTrack = screenVideoTrack || (captureStream && captureStream.getVideoTracks()[0]) || null;
    if (sender && nextTrack) {
      try {
        videoSender = sender;
        sender.replaceTrack(nextTrack).catch(() => {});
      } catch {}
    }
    if (cameraStream) {
      try {
        cameraStream.getTracks().forEach((t) => t.stop());
      } catch {}
      cameraStream = null;
      cameraVideoTrack = null;
    }
  }
}

async function refreshCaptureStream() {
  if (captureStream) {
    captureStream.getTracks().forEach((t) => t.stop());
  }
  captureStream = null;
   screenVideoTrack = null;
  return ensureCaptureStream();
}

async function loadIceServers() {
  iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
}

async function renegotiate(iceRestart) {
  if (!pc) return;
  const offer = await pc.createOffer({
    iceRestart: Boolean(iceRestart),
  });
  await pc.setLocalDescription(offer);
  sendSignal({ type: "offer", sdp: pc.localDescription });
}

function scheduleRestart(reason, refreshStream) {
  const now = Date.now();
  if (now - lastRestartAt < 1500) return;
  lastRestartAt = now;
  if (restarting) return;
  restarting = true;
  sendPeer({ event: "capture-restart", reason: String(reason || "") });
  setTimeout(async () => {
    try {
      if (!pc || pc.connectionState === "closed") {
        started = false;
        restarting = false;
        return startWebRtc();
      }
      if (refreshStream) {
        await refreshCaptureStream();
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        const newTrack = captureStream.getVideoTracks()[0];
        if (sender && newTrack) await sender.replaceTrack(newTrack);
      }
      await renegotiate(true);
    } catch {
      teardownPeer();
      started = false;
      return startWebRtc();
    } finally {
      restarting = false;
    }
  }, 700);
}

async function startWebRtc() {
  console.log("[Desktop] startWebRtc called, started=", started);
  if (started) return;
  started = true;

  try {
    console.log("[Desktop] Ensuring capture stream...");
    await ensureCaptureStream();
    console.log("[Desktop] Capture stream obtained");
    try {
      await ensureMicStream();
    } catch {}
  } catch (err) {
    console.log("[Desktop] Capture stream failed:", err);
    started = false;
    setPill(desktopStatus, false, "Desktop: capture failed");
    sendPeer({ event: "capture-failed", message: String(err && err.message ? err.message : err) });
    return;
  }

  pc = createPeerConnection();

  const track = screenVideoTrack || captureStream.getVideoTracks()[0];
  if (track) {
    console.log("[Desktop] Adding video track to peer connection:", track.label, "enabled:", track.enabled, "readyState:", track.readyState);
    track.contentHint = "detail";
    track.onended = () => scheduleRestart("ended", true);
    track.onmute = () => console.log("[Desktop] Track muted");
    track.onunmute = () => console.log("[Desktop] Track unmuted");
    screenVideoTrack = track;
    videoSender = pc.addTrack(track, captureStream);
    console.log("[Desktop] Video track added, captureStream tracks:", captureStream.getTracks().map(t => t.kind));
  } else {
    console.log("[Desktop] No video track available!");
  }

  // Add audio track if microphone is available
  if (micAudioTrack && micStream) {
    console.log("[Desktop] Adding audio track to peer connection");
    micAudioTrack.enabled = micEnabled;
    audioSender = pc.addTrack(micAudioTrack, micStream);
  }

  dataChannel = pc.createDataChannel("input", { ordered: true, negotiated: true, id: 0 });
  dataChannel.onopen = () => window.bridge.setWebrtcState("connected");
  dataChannel.onclose = () => window.bridge.setWebrtcState("disconnected");
  dataChannel.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "input") window.bridge.injectInput(msg.payload);
    if (msg.type === "command" && typeof msg.command === "string") window.bridge.runCommand(msg.command);
    if (msg.type === "media") handleMediaMessage(msg);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  console.log("[Desktop] Sending offer to mobile");
  console.log("[Desktop] Offer SDP has video:", offer.sdp.includes("m=video"));
  
  // Log transceivers
  const transceivers = pc.getTransceivers();
  console.log("[Desktop] Transceivers:", transceivers.length);
  transceivers.forEach((t, i) => {
    console.log(`[Desktop] Transceiver ${i}: direction=${t.direction}, currentDirection=${t.currentDirection}`);
    if (t.sender && t.sender.track) {
      console.log(`[Desktop] Transceiver ${i} sender track:`, t.sender.track.kind, t.sender.track.enabled);
    }
  });
  
  sendSignal({ type: "offer", sdp: pc.localDescription });

  if (statsTimer) clearInterval(statsTimer);
  lastBytesSent = 0;
  stableTicks = 0;
  statsTimer = setInterval(async () => {
    try {
      if (!pc) return;
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (!sender) {
        console.log("[Desktop] No video sender found");
        return;
      }
      const stats = await sender.getStats();
      let bytesSent = 0;
      let packetsSent = 0;
      stats.forEach((r) => {
        if (r.type === "outbound-rtp" && r.kind === "video") {
          if (typeof r.bytesSent === "number") bytesSent = r.bytesSent;
          if (typeof r.packetsSent === "number") packetsSent = r.packetsSent;
        }
      });
      console.log("[Desktop] Video stats - bytesSent:", bytesSent, "packetsSent:", packetsSent);
      if (!bytesSent) return;
      if (lastBytesSent && bytesSent <= lastBytesSent + 800) stableTicks += 1;
      else stableTicks = 0;
      lastBytesSent = bytesSent;
      if (stableTicks >= 10) {}
    } catch (err) {
      console.log("[Desktop] Stats error:", err);
    }
  }, 1500);

  setTimeout(() => {
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (!sender) return;
    sender
      .setParameters({
        encodings: [{ 
          maxBitrate: 2_000_000,
          maxFramerate: 30,
          priority: "high"
        }],
        degradationPreference: "maintain-framerate",
      })
      .catch(() => {});
  }, 500);
}

async function startDaily() {
  teardownPeer();
  resetWs();
  started = false;

  if (!sessionInfo || !sessionInfo.dailyRoomUrl) return;
  if (!window.DailyIframe || typeof window.DailyIframe.createCallObject !== "function") {
    setPill(desktopStatus, false, "Desktop: Daily SDK missing");
    return;
  }

  teardownDaily();
  setPill(desktopStatus, true, "Desktop: online");
  setPill(mobileStatus, false, "Mobile: offline");

  dailyCall = window.DailyIframe.createCallObject({
    audioSource: false,
    videoSource: false,
    subscribeToTracksAutomatically: false,
  });

  dailyCall.on("participant-joined", (ev) => {
    if (ev && ev.participant && !ev.participant.local) {
      setPill(mobileStatus, true, "Mobile: online");
      window.bridge.setWebrtcState("connected");
    }
  });

  dailyCall.on("participant-left", (ev) => {
    if (ev && ev.participant && !ev.participant.local) {
      setPill(mobileStatus, false, "Mobile: offline");
      window.bridge.setWebrtcState("disconnected");
    }
  });

  dailyCall.on("left-meeting", () => {
    setPill(desktopStatus, false, "Desktop: offline");
    setPill(mobileStatus, false, "Mobile: offline");
    window.bridge.setWebrtcState("disconnected");
  });

  dailyCall.on("app-message", (ev) => {
    const data = ev && ev.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "input") window.bridge.injectInput(data.payload);
    if (data.type === "command" && typeof data.command === "string") window.bridge.runCommand(data.command);
    if (data.type === "media") handleMediaMessage(data);
  });

  try {
    await dailyCall.join({ url: sessionInfo.dailyRoomUrl });
  } catch {
    teardownDaily();
    setPill(desktopStatus, false, "Desktop: Daily join failed");
    return;
  }

  try {
    await ensureCaptureStream();
    dailyCall.startScreenShare({ mediaStream: captureStream });
  } catch {
    setPill(desktopStatus, false, "Desktop: capture failed");
  }
}

async function startAgora() {
  teardownPeer();
  resetWs();
  started = false;

  const appId = sessionInfo && sessionInfo.agoraAppId ? String(sessionInfo.agoraAppId) : "";
  const channel = sessionInfo && sessionInfo.agoraChannel ? String(sessionInfo.agoraChannel) : "";
  const token = sessionInfo && sessionInfo.agoraToken ? String(sessionInfo.agoraToken) : "";

  if (!appId || !channel) return;
  if (!window.AgoraRTC || typeof window.AgoraRTC.createClient !== "function") {
    setPill(desktopStatus, false, "Desktop: Agora SDK missing");
    return;
  }

  await teardownAgora();
  teardownDaily();

  setPill(desktopStatus, true, "Desktop: online");
  setPill(mobileStatus, false, "Mobile: offline");

  const client = window.AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
  agoraClient = client;

  client.on("user-joined", () => {
    setPill(mobileStatus, true, "Mobile: online");
    window.bridge.setWebrtcState("connected");
  });
  client.on("user-left", () => {
    setPill(mobileStatus, false, "Mobile: offline");
    window.bridge.setWebrtcState("disconnected");
  });
  client.on("connection-state-change", (cur) => {
    if (cur === "DISCONNECTED") {
      setPill(mobileStatus, false, "Mobile: offline");
      window.bridge.setWebrtcState("disconnected");
    }
  });
  client.on("stream-message", (_uid, _sid, data) => {
    let text = "";
    try {
      if (typeof data === "string") text = data;
      else text = new TextDecoder().decode(data);
    } catch {}
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "input") window.bridge.injectInput(msg.payload);
    if (msg.type === "command" && typeof msg.command === "string") window.bridge.runCommand(msg.command);
    if (msg.type === "media") handleMediaMessage(msg);
  });

  try {
    await client.join(appId, channel, token || null, 1);
  } catch {
    await teardownAgora();
    setPill(desktopStatus, false, "Desktop: Agora join failed");
    return;
  }

  try {
    agoraStreamId = await client.createDataStream({ ordered: true, reliable: true });
  } catch {
    agoraStreamId = null;
  }

  try {
    await ensureCaptureStream();
    const track = captureStream.getVideoTracks()[0];
    if (!track) throw new Error("no-video-track");
    track.contentHint = "detail";
    agoraVideoTrack = window.AgoraRTC.createCustomVideoTrack({ mediaStreamTrack: track });
    await client.publish([agoraVideoTrack]);
  } catch {
    await teardownAgora();
    setPill(desktopStatus, false, "Desktop: capture failed");
  }
}

async function handleSignal(payload) {
  if (!payload || typeof payload.type !== "string") return;
  console.log("[Desktop] Received signal:", payload.type);

  if (payload.type === "answer") {
    if (!pc) {
      console.log("[Desktop] No peer connection when receiving answer");
      return;
    }
    console.log("[Desktop] Setting remote description (answer)");
    await pc.setRemoteDescription(payload.sdp);
    console.log("[Desktop] Remote description set successfully");
    return;
  }

  if (payload.type === "candidate") {
    if (!pc) {
      console.log("[Desktop] Received ICE candidate but no peer connection");
      return;
    }
    try {
      console.log("[Desktop] Adding ICE candidate");
      await pc.addIceCandidate(payload.candidate);
    } catch (err) {
      console.log("[Desktop] Failed to add ICE candidate:", err);
    }
  }
}

function resetWs() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
}

function connectSignaling() {
  resetWs();
  if (!sessionInfo || !sessionInfo.wsUrl) return;

  const url = sessionInfo.wsUrl;
  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    wsReconnectDelayMs = 500;
    setPill(desktopStatus, true, "Desktop: online");
    setPill(mobileStatus, false, "Controller: offline");
    const plan = (currentAccount && currentAccount.plan) || "basic";
    try {
      ws.send(JSON.stringify({ type: "hello", role: "desktop", plan }));
      ws.send(JSON.stringify({ type: "peer", target: "mobile", payload: { event: "desktop-online", plan } }));
    } catch {}
  });

  // Handle ping from server (respond with pong automatically by browser)
  ws.addEventListener("ping", () => {
    console.log("[Desktop] Received ping from server");
  });

  ws.addEventListener("message", async (evt) => {
    let msg;
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    console.log("[Desktop] Received message type:", msg.type);

    if (msg.type === "signal") {
      await handleSignal(msg.payload);
      return;
    }

    if (msg.type === "peer" && msg.payload && typeof msg.payload.event === "string") {
      const ev = msg.payload.event;
      console.log("[Desktop] Peer event:", ev);
      if (ev === "mobile-online") {
        setPill(mobileStatus, true, "Controller: online");
        console.log("[Desktop] Mobile online, started=", started);
        if (!started) {
          console.log("[Desktop] Starting WebRTC...");
          startWebRtc();
        }
      }
      if (ev === "mobile-offline") {
        setPill(mobileStatus, false, "Controller: offline");
      }
      if (ev === "capture-failed") {
        setPill(desktopStatus, false, "Desktop: capture failed");
      }
      if (ev === "capture-restart") {
        setPill(desktopStatus, true, "Desktop: online");
      }
      return;
    }

    // Handle command messages from mobile (e.g., disconnect)
    if (msg.type === "command" && typeof msg.command === "string") {
      console.log("[Desktop] Received command:", msg.command);
      if (msg.command === "disconnect") {
        performDesktopDisconnect("Mobile disconnected");
      } else {
        window.bridge.runCommand(msg.command);
      }
      return;
    }
  });

  ws.addEventListener("close", (evt) => {
    setPill(desktopStatus, false, "Desktop: offline");
    setPill(mobileStatus, false, "Controller: offline");
    ws = null;

    if (evt.code === 4001) {
       performDesktopDisconnect("Session Expired (10 min limit). Start a new session to continue.");
       return;
    }
    if (evt.code === 4003) {
       performDesktopDisconnect("Plan Restriction: Basic plan supports LAN only.");
       return;
    }

    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      wsReconnectDelayMs = Math.min(5000, Math.round(wsReconnectDelayMs * 1.7));
      connectSignaling();
    }, wsReconnectDelayMs);
  });

  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {}
  });
}

async function loadSessionInfo() {
  sessionInfo = await window.bridge.regenerateSession();
  
  if (sessionInfo && sessionInfo.expiresAt && sessionInfo.expiresAt <= Date.now() + 2000) {
     if (planWarning) {
       planWarning.textContent = "Trial session already used or expired.";
       planWarning.style.display = "block";
     }
     return;
  }

  applyControllerChoiceUi();
  await loadIceServers();
  await connectSignaling();
}

copyBtn.addEventListener("click", () => {
  if (!sessionInfo) return;
  const url = getControllerUrl();
  if (!url) return;
  window.bridge.copyText(url);
});

regenBtn.addEventListener("click", async () => {
  await teardownAgora();
  teardownDaily();
  teardownPeer();
  started = false;
  sessionInfo = await window.bridge.regenerateSession();
  // Show choice dialog again when generating new code
  if (clientChoiceBackdrop) {
    clientChoiceBackdrop.hidden = false;
    if (startSection) startSection.hidden = false;
    if (pairingControls) pairingControls.hidden = true;
  } else {
    applyControllerChoiceUi();
    await connectSignaling();
  }
});

quitBtn.addEventListener("click", () => {
  window.bridge.quitApp();
});

if (loginConnectBtn) {
  loginConnectBtn.addEventListener("click", async () => {
    if (linkPollTimer) {
      clearInterval(linkPollTimer);
      linkPollTimer = null;
    }
    if (loginStatusText) loginStatusText.textContent = "Opening browser to connect your account...";
    try {
      await window.bridge.openLogin();
    } catch {
      if (loginStatusText) loginStatusText.textContent = "Failed to open browser. Please try again.";
      return;
    }
    if (loginStatusText) loginStatusText.textContent = "Waiting for website to connect your account...";
    linkPollTimer = setInterval(async () => {
      try {
        const info = await window.bridge.getLinkedUser();
        if (info && info.email) {
          if (loginStatusText) loginStatusText.textContent = "";
          if (userLabel) {
            userLabel.textContent = info.plan ? `${info.email} (${info.plan})` : info.email;
          }
          currentAccount = { email: info.email, plan: info.plan || "basic" };
          try {
            await window.bridge.setStoredAccount(currentAccount);
          } catch {}
          showSessionView();
          clearInterval(linkPollTimer);
          linkPollTimer = null;
          if (planCheckTimer) {
            clearInterval(planCheckTimer);
            planCheckTimer = null;
          }
          planCheckTimer = setInterval(() => {
            refreshPlanAndEnforce().catch(() => {});
          }, 90000);
        }
      } catch {}
    }, 3000);
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    if (linkPollTimer) {
      clearInterval(linkPollTimer);
      linkPollTimer = null;
    }
    if (planCheckTimer) {
      clearInterval(planCheckTimer);
      planCheckTimer = null;
    }
    if (currentAccount && currentAccount.email) {
      try {
        await window.bridge.logout(currentAccount.email);
      } catch {}
    }
    currentAccount = null;
    if (userLabel) userLabel.textContent = "";
    try {
      await window.bridge.clearStoredAccount();
    } catch {}
    showLoginView();
  });
}

initApp().catch(() => {
  showNoInternetView();
});

document.querySelectorAll("button[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => window.bridge.runCommand(btn.dataset.cmd));
});

setInterval(() => {
  if (!sessionInfo) return;
  ttlEl.textContent = `Code: ${formatTtl(sessionInfo.expiresAt)}`;
}, 1000);

// Listen for online/offline events
window.addEventListener("online", async () => {
  console.log("[App] Internet connection restored");
  // If currently showing no internet view, try to init
  if (noInternetCard && !noInternetCard.hidden) {
    await initApp();
  } else if (currentAccount) {
    // If logged in, refresh plan
    await refreshPlanAndEnforce().catch(() => {});
  }
});

window.addEventListener("offline", () => {
  console.log("[App] Internet connection lost");
});

// Removed auto loadSessionInfo
// loadSessionInfo().catch(() => {});
