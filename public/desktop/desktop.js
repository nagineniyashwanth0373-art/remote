// Chrome Remote Desktop & AnyDesk style desktop client logic
const statusEl = document.getElementById("status");
const remoteVideo = document.getElementById("remoteVideo");
const touchLayer = document.getElementById("touchLayer");
const stage = document.getElementById("stage");
const disconnectBtn = document.getElementById("disconnectBtn");
const micToggle = document.getElementById("micToggle");
const cameraToggle = document.getElementById("cameraToggle");
const fsToggle = document.getElementById("fsToggle");

// AI Ans elements
const ansBtn = document.getElementById("ansBtn");
const aiAnsBox = document.getElementById("aiAnsBox");
const aiAnsClose = document.getElementById("aiAnsClose");
const aiAnsLoading = document.getElementById("aiAnsLoading");
const aiAnsText = document.getElementById("aiAnsText");
const aiAnsCopy = document.getElementById("aiAnsCopy");
const aiAnsRefresh = document.getElementById("aiAnsRefresh");

let micEnabled = false;
let cameraEnabled = false;
let clientPlan = "basic";

function getToken() {
  const url = new URL(location.href);
  return url.searchParams.get("t") || "";
}

function isProPlan() {
  return clientPlan === "pro" || clientPlan === "premium" || clientPlan === "enterprise";
}

function updateAnsBtnAppearance() {
  if (!ansBtn) return;
  if (isProPlan()) {
    ansBtn.innerHTML = '<span class="ai-icon">✨</span><span class="ai-label">Ans</span>';
    ansBtn.classList.remove("locked-tool");
    ansBtn.title = "AI Screen Analysis (Pro)";
  } else {
    ansBtn.innerHTML = '<span class="ai-icon">🔒</span><span class="ai-label">Ans</span>';
    ansBtn.classList.add("locked-tool");
    ansBtn.title = "Ans is a Pro feature (Locked on Trial/Basic)";
  }
}

async function fetchSessionPlan() {
  const token = getToken();
  if (!token) return;
  try {
    const res = await fetch(`/api/link/status?token=${encodeURIComponent(token)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.plan) {
        clientPlan = String(data.plan).trim().toLowerCase();
        updateAnsBtnAppearance();
      }
    }
  } catch (e) {
    console.log("[DesktopClient] Error checking session plan:", e.message);
  }
}

fetchSessionPlan();

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

// Coordinate calculation for exact pixel-perfect mouse mapping
function getNormFromPoint(clientX, clientY) {
  const rect = remoteVideo.getBoundingClientRect();
  const vw = remoteVideo.videoWidth || 1920;
  const vh = remoteVideo.videoHeight || 1080;

  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0.5, y: 0.5 };
  }

  // Calculate video render rect inside aspect ratio container (object-fit: contain)
  const videoAspect = vw / vh;
  const containerAspect = rect.width / rect.height;

  let renderW = rect.width;
  let renderH = rect.height;
  let renderLeft = rect.left;
  let renderTop = rect.top;

  if (containerAspect > videoAspect) {
    renderW = rect.height * videoAspect;
    renderLeft = rect.left + (rect.width - renderW) / 2;
  } else {
    renderH = rect.width / videoAspect;
    renderTop = rect.top + (rect.height - renderH) / 2;
  }

  const px = clientX - renderLeft;
  const py = clientY - renderTop;

  const nx = Math.max(0, Math.min(1, px / renderW));
  const ny = Math.max(0, Math.min(1, py / renderH));

  return { x: nx, y: ny };
}

let ws = null;
let pc = null;
let dc = null;
let keepAliveInterval = null;

function dcSend(msg) {
  if (!dc || dc.readyState !== "open") return;
  try {
    dc.send(JSON.stringify(msg));
  } catch (err) {
    console.error("[DesktopClient] DataChannel send error:", err);
  }
}

function initSignaling() {
  const token = getToken();
  if (!token) {
    setStatus("Missing session token.");
    return;
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/ws?t=${encodeURIComponent(token)}`;
  ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    setStatus("Connected to server. Establishing remote stream…");
    ws.send(JSON.stringify({ type: "hello", role: "mobile" }));

    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAliveInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 20000);
  });

  ws.addEventListener("message", async (evt) => {
    let msg;
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      return;
    }

    if (msg.type === "signal") {
      await handleSignal(msg.payload);
      return;
    }

    if (msg.type === "peer" && msg.payload && typeof msg.payload.event === "string") {
      if (msg.payload.event === "desktop-online") {
        if (msg.payload.plan) {
          clientPlan = String(msg.payload.plan).trim().toLowerCase();
          updateAnsBtnAppearance();
        }
        setStatus("Remote desktop connected.");
      }
      if (msg.payload.event === "desktop-offline") setStatus("Remote desktop offline.");
      if (msg.payload.event === "plan-expired") {
        setStatus("Session ended: Plan duration expired.");
        alert("Your plan duration has expired.");
      }
    }
  });

  ws.addEventListener("close", () => {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    setStatus("Disconnected.");
    teardown();
  });
}

function createPeerConnection() {
  const peer = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  peer.ontrack = (evt) => {
    if (evt.track.kind === "video") {
      remoteVideo.srcObject = evt.streams[0] || new MediaStream([evt.track]);
      remoteVideo.play().catch(() => {});
    }
  };

  peer.ondatachannel = (evt) => {
    dc = evt.channel;
    dc.onopen = () => {
      setStatus("Control active. Ready for input.");
    };
    dc.onclose = () => {
      setStatus("Control channel closed.");
    };
  };

  peer.onicecandidate = (evt) => {
    if (!evt.candidate) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "signal",
        target: "desktop",
        payload: { type: "candidate", candidate: evt.candidate }
      }));
    }
  };

  return peer;
}

async function handleSignal(payload) {
  if (!pc) pc = createPeerConnection();

  if (payload.type === "offer") {
    await pc.setRemoteDescription(new RTCSessionDescription(payload));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "signal",
        target: "desktop",
        payload: { type: "answer", sdp: answer.sdp }
      }));
    }
    return;
  }

  if (payload.type === "candidate" && payload.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    } catch {}
  }
}

function teardown() {
  if (dc) {
    try { dc.close(); } catch {}
    dc = null;
  }
  if (pc) {
    try { pc.close(); } catch {}
    pc = null;
  }
}

// ===== NATIVE ANYDESK & CHROME REMOTE DESKTOP STYLE MOUSE & KEYBOARD =====

// 1. Fluid Mouse Move
let lastMouseMoveTime = 0;
touchLayer.addEventListener("mousemove", (evt) => {
  const now = Date.now();
  if (now - lastMouseMoveTime < 16) return; // ~60fps throttle
  lastMouseMoveTime = now;

  const p = getNormFromPoint(evt.clientX, evt.clientY);
  dcSend({
    type: "input",
    payload: {
      type: "mouse-move",
      mode: "norm",
      x: p.x,
      y: p.y
    }
  });
});

// 2. Native Mouse Down & Up (Left, Middle, Right Click & Drag)
touchLayer.addEventListener("mousedown", (evt) => {
  stage.focus(); // Focus stage to capture keyboard events immediately
  const p = getNormFromPoint(evt.clientX, evt.clientY);
  let button = "left";
  if (evt.button === 1) button = "middle";
  if (evt.button === 2) button = "right";

  dcSend({
    type: "input",
    payload: {
      type: "mouse-toggle",
      button: button,
      down: true,
      mode: "norm",
      x: p.x,
      y: p.y
    }
  });
});

touchLayer.addEventListener("mouseup", (evt) => {
  const p = getNormFromPoint(evt.clientX, evt.clientY);
  let button = "left";
  if (evt.button === 1) button = "middle";
  if (evt.button === 2) button = "right";

  dcSend({
    type: "input",
    payload: {
      type: "mouse-toggle",
      button: button,
      down: false,
      mode: "norm",
      x: p.x,
      y: p.y
    }
  });
});

// 3. Double Click
touchLayer.addEventListener("dblclick", (evt) => {
  const p = getNormFromPoint(evt.clientX, evt.clientY);
  dcSend({
    type: "input",
    payload: {
      type: "mouse-click",
      button: "left",
      double: true,
      mode: "norm",
      x: p.x,
      y: p.y
    }
  });
});

// 4. Native Mouse Scroll (Wheel)
touchLayer.addEventListener("wheel", (evt) => {
  evt.preventDefault();
  const dy = Math.sign(evt.deltaY) * -1; // Standard Windows wheel delta
  dcSend({
    type: "input",
    payload: {
      type: "scroll",
      dx: 0,
      dy: dy
    }
  });
}, { passive: false });

// 5. Prevent Context Menu so Right Click works natively on remote desktop
touchLayer.addEventListener("contextmenu", (evt) => {
  evt.preventDefault();
});

// 6. Direct Hardware Keyboard Capture (All Keys, Ctrl, Alt, Shift, Arrows, Shortcuts)
window.addEventListener("keydown", (evt) => {
  // If typing in AI modal or input box, allow normal typing
  if (evt.target && (evt.target.tagName === "INPUT" || evt.target.tagName === "TEXTAREA")) {
    return;
  }

  // Prevent browser default actions for standard shortcuts (e.g. Ctrl+S, Tab, F5)
  if (evt.key === "Tab" || evt.key === "Alt" || (evt.ctrlKey && evt.key.toLowerCase() === "s")) {
    evt.preventDefault();
  }

  const modifiers = [];
  if (evt.shiftKey) modifiers.push("shift");
  if (evt.ctrlKey) modifiers.push("control");
  if (evt.altKey) modifiers.push("alt");
  if (evt.metaKey) modifiers.push("command");

  let key = evt.key;
  if (key === "Escape") key = "escape";
  if (key === "Enter") key = "enter";
  if (key === "Backspace") key = "backspace";
  if (key === "Tab") key = "tab";
  if (key === "Delete") key = "delete";
  if (key === "ArrowUp") key = "up";
  if (key === "ArrowDown") key = "down";
  if (key === "ArrowLeft") key = "left";
  if (key === "ArrowRight") key = "right";

  dcSend({
    type: "input",
    payload: {
      type: "key-tap",
      key: key,
      modifiers: modifiers
    }
  });
});

// ===== TOPBAR CONTROLS =====
if (disconnectBtn) {
  disconnectBtn.addEventListener("click", () => {
    dcSend({ type: "command", command: "disconnect" });
    teardown();
    setStatus("Disconnected.");
  });
}

if (micToggle) {
  micToggle.addEventListener("click", () => {
    micEnabled = !micEnabled;
    micToggle.classList.toggle("active", micEnabled);
    dcSend({ type: "media", kind: "mic", enabled: micEnabled });
    remoteVideo.muted = !micEnabled;
    micToggle.textContent = micEnabled ? "🔊 Listening" : "🎤 Listen";
  });
}

if (cameraToggle) {
  cameraToggle.addEventListener("click", () => {
    cameraEnabled = !cameraEnabled;
    cameraToggle.classList.toggle("active", cameraEnabled);
    dcSend({ type: "media", kind: "camera", enabled: cameraEnabled });
    cameraToggle.textContent = cameraEnabled ? "📷 Cam ON" : "📷 Camera";
  });
}

if (fsToggle) {
  fsToggle.addEventListener("click", async () => {
    if (!document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
        fsToggle.textContent = "⛶ Exit Full";
      } catch {}
    } else {
      try {
        await document.exitFullscreen();
        fsToggle.textContent = "⛶ Fullscreen";
      } catch {}
    }
  });
}

// ===== AI ANS SCREEN ANALYSIS (VISION) =====
async function captureAndAnalyzeVisionScreen() {
  if (!isProPlan()) {
    if (aiAnsBox) {
      aiAnsBox.hidden = false;
      if (aiAnsText) {
        aiAnsText.innerHTML = `
          <div style="text-align: center; padding: 10px 0;">
            <div style="font-size: 38px; margin-bottom: 10px;">🔒</div>
            <h3 style="margin: 0 0 8px 0; color: #f59e0b;">Pro Feature Locked</h3>
            <p style="color: #94a3b8; font-size: 14px; margin: 0 0 16px 0;">
              AI Screen Analysis is available exclusively on <strong>Pro Plans</strong>.
            </p>
          </div>
        `;
      }
    }
    return;
  }

  if (!remoteVideo.videoWidth || !remoteVideo.videoHeight) {
    setStatus("Error: Video feed not ready for analysis.");
    return;
  }

  if (ansBtn) ansBtn.classList.add("active");
  if (aiAnsBox) aiAnsBox.hidden = false;
  if (aiAnsLoading) aiAnsLoading.hidden = false;
  if (aiAnsText) aiAnsText.textContent = "";

  const canvas = document.createElement("canvas");
  canvas.width = remoteVideo.videoWidth;
  canvas.height = remoteVideo.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);

  const imageData = canvas.toDataURL("image/jpeg", 0.9);

  try {
    const token = getToken();
    const response = await fetch("/api/analyze-screen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageData, token: token })
    });

    const result = await response.json();
    if (aiAnsLoading) aiAnsLoading.hidden = true;

    if (result.ok && result.answer) {
      if (aiAnsText) aiAnsText.textContent = result.answer;
      setStatus("Analysis ready.");
    } else {
      if (aiAnsText) aiAnsText.textContent = "Error: " + (result.message || result.error || "Analysis failed");
    }
  } catch (err) {
    if (aiAnsLoading) aiAnsLoading.hidden = true;
    if (aiAnsText) aiAnsText.textContent = "Request Error: " + err.message;
  } finally {
    if (ansBtn) ansBtn.classList.remove("active");
  }
}

if (ansBtn) {
  ansBtn.addEventListener("click", captureAndAnalyzeVisionScreen);
}

if (aiAnsRefresh) {
  aiAnsRefresh.addEventListener("click", captureAndAnalyzeVisionScreen);
}

if (aiAnsClose) {
  aiAnsClose.addEventListener("click", () => {
    if (aiAnsBox) aiAnsBox.hidden = true;
  });
}

if (aiAnsCopy) {
  aiAnsCopy.addEventListener("click", () => {
    if (!aiAnsText) return;
    const text = aiAnsText.textContent || "";
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        aiAnsCopy.textContent = "Copied! ✓";
        setTimeout(() => { aiAnsCopy.textContent = "Copy"; }, 2000);
      });
    }
  });
}

// Start signaling
initSignaling();
