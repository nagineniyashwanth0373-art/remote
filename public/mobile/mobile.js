const statusEl = document.getElementById("status");
const remoteVideo = document.getElementById("remoteVideo");
const touchLayer = document.getElementById("touchLayer");
const fsToggle = document.getElementById("fsToggle");
const disconnectBtn = document.getElementById("disconnectBtn");
const typeSheet = document.getElementById("typeSheet");
const typeInput = document.getElementById("typeInput");
const stage = document.getElementById("stage");
const dragBtn = document.getElementById("dragBtn");
const scrollBtn = document.getElementById("scrollBtn");
const typeBtn = document.getElementById("typeBtn");
const micToggle = document.getElementById("micToggle");
const cameraToggle = document.getElementById("cameraToggle");
const snapBtn = document.getElementById("snapBtn");
const snapResult = document.getElementById("snapResult");
const snapResultContent = document.getElementById("snapResultContent");
const snapCloseResult = document.getElementById("snapCloseResult");
const stopTypingBtn = document.getElementById("stopTypingBtn");

// State variables
let micEnabled = false;
let cameraEnabled = false;
let dragMode = false;
let scrollMode = false;
let typeMode = false;
let snapMode = false;
let lastExtractedText = ""; // Store last OCR text

function setStatus(text) {
  statusEl.textContent = text;
}

function getToken() {
  const url = new URL(location.href);
  return url.searchParams.get("t") || "";
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getContentMetrics() {
  const rect = stage.getBoundingClientRect();
  const vw = remoteVideo.videoWidth || 0;
  const vh = remoteVideo.videoHeight || 0;
  console.log("[Mobile] getContentMetrics - videoWidth:", vw, "videoHeight:", vh, "stageRect:", rect.width, "x", rect.height);
  if (vw <= 0 || vh <= 0) {
    return { rect, contentW: rect.width, contentH: rect.height, offsetX: 0, offsetY: 0 };
  }
  const aspect = vw / vh;
  const boxAspect = rect.width / Math.max(1, rect.height);
  const contentW = boxAspect > aspect ? rect.height * aspect : rect.width;
  const contentH = boxAspect > aspect ? rect.height : rect.width / aspect;
  const offsetX = (rect.width - contentW) / 2;
  const offsetY = (rect.height - contentH) / 2;
  console.log("[Mobile] getContentMetrics - contentW:", contentW, "contentH:", contentH, "offsetX:", offsetX, "offsetY:", offsetY);
  return { rect, contentW, contentH, offsetX, offsetY };
}

function getNormFromPoint(clientX, clientY) {
  const { rect, contentW, contentH, offsetX, offsetY } = getContentMetrics();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const ux = (px - panX) / Math.max(1, zoom);
  const uy = (py - panY) / Math.max(1, zoom);
  const x = (ux - offsetX) / Math.max(1, contentW);
  const y = (uy - offsetY) / Math.max(1, contentH);
  const result = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  console.log("[Mobile] getNormFromPoint - client:", clientX, clientY, "px:", px, py, "norm:", result.x.toFixed(3), result.y.toFixed(3));
  return result;
}

let zoom = 1;
let panX = 0;
let panY = 0;
let pinchStartDist = null;
let pinchStartZoom = 1;
let pinchLastCenter = null;

function applyTransform() {
  remoteVideo.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

function clampPan() {
  const { rect } = getContentMetrics();
  const maxX = Math.max(0, (rect.width * zoom - rect.width) / 2);
  const maxY = Math.max(0, (rect.height * zoom - rect.height) / 2);
  panX = clamp(panX, -maxX, maxX);
  panY = clamp(panY, -maxY, maxY);
}

function zoomAt(nextZoom, clientX, clientY) {
  const { rect } = getContentMetrics();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const clamped = clamp(nextZoom, 1, 3.2);
  const ratio = clamped / zoom;
  panX = cx - ratio * (cx - panX);
  panY = cy - ratio * (cy - panY);
  zoom = clamped;
  clampPan();
  applyTransform();
}

let ws = null;
let pc = null;
let dc = null;
let disconnectTimer = null;

function wsSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function dcSend(obj) {
  if (!dc || dc.readyState !== "open") return;
  dc.send(JSON.stringify(obj));
}

async function connectSignaling() {
  const token = getToken();
  if (!token) {
    setStatus("Missing pairing token.");
    return;
  }

  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsScheme}://${location.host}/ws?t=${encodeURIComponent(token)}`;
  ws = new WebSocket(wsUrl);

  // Keepalive ping interval
  let keepAliveInterval = null;
  
  ws.addEventListener("open", () => {
    wsSend({ type: "hello", role: "mobile" });
    wsSend({ type: "peer", target: "desktop", payload: { event: "mobile-online" } });
    setStatus("Waiting for desktop…");
    
    // Start keepalive ping every 20 seconds to prevent timeout
    keepAliveInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ type: "ping" });
        console.log("[Mobile] Sent keepalive ping");
      }
    }, 20000);
  });

  // Handle ping from server (browser auto-responds with pong)
  ws.addEventListener("ping", () => {
    console.log("[Mobile] Received ping from server");
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
      if (msg.payload.event === "desktop-online") setStatus("Desktop online. Waiting for stream…");
      if (msg.payload.event === "desktop-offline") setStatus("Desktop app not connected.");
      if (msg.payload.event === "capture-failed") setStatus(`Desktop capture failed: ${msg.payload.message || ""}`.trim());
      if (msg.payload.event === "capture-restart") setStatus("Reconnecting stream…");
      if (msg.payload.event === "input-driver-unavailable") setStatus("Input driver missing on desktop. Install robotjs.");
      if (msg.payload.event === "desktop-online") {
        if (!document.fullscreenElement) {
          const stage = document.getElementById("stage");
          try {
            await stage.requestFullscreen();
          } catch {}
        }
        if (screen.orientation && screen.orientation.lock) {
          try {
            await screen.orientation.lock("landscape");
          } catch {}
        }
      }
    }
  });

  ws.addEventListener("close", () => {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    setStatus("Disconnected.");
    teardown();
  });
  
  ws.addEventListener("error", (err) => {
    console.error("[Mobile] WebSocket error:", err);
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
  });
}

function createPeerConnection() {
  const peer = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  // Create a single MediaStream to hold all tracks
  let remoteStream = null;
  
  peer.ontrack = (evt) => {
    console.log("[Mobile] ontrack fired:", evt.track.kind, "stream count:", evt.streams ? evt.streams.length : 0);
    
    // Use the existing remote stream or create one
    if (!remoteStream) {
      remoteStream = evt.streams && evt.streams[0] ? evt.streams[0] : new MediaStream();
    }
    
    // Add the track to the stream if not already there
    const existingTrack = remoteStream.getTracks().find(t => t.id === evt.track.id);
    if (!existingTrack) {
      remoteStream.addTrack(evt.track);
      console.log("[Mobile] Added track:", evt.track.kind, "to stream");
    }
    
    console.log("[Mobile] Stream now has video tracks:", remoteStream.getVideoTracks().length, "audio tracks:", remoteStream.getAudioTracks().length);
    
    // Ensure video element is visible
    remoteVideo.style.display = 'block';
    remoteVideo.style.visibility = 'visible';
    
    // Only set srcObject if it's not already set to our stream
    if (remoteVideo.srcObject !== remoteStream) {
      remoteVideo.srcObject = remoteStream;
      console.log("[Mobile] Video srcObject set to stream");
    }
    
    // Force play with user interaction workaround for mobile
    const playVideo = () => {
      remoteVideo.play().then(() => {
        console.log("[Mobile] Video playing successfully");
      }).catch((e) => {
        console.log("[Mobile] Play failed:", e);
        // Retry on user interaction
        document.addEventListener('touchstart', function retryPlay() {
          remoteVideo.play().catch(() => {});
          document.removeEventListener('touchstart', retryPlay);
        }, { once: true });
      });
    };
    playVideo();
    
    // Monitor track state
    evt.track.onmute = () => console.log("[Mobile] Track muted:", evt.track.kind);
    evt.track.onunmute = () => console.log("[Mobile] Track unmuted:", evt.track.kind);
    evt.track.onended = () => console.log("[Mobile] Track ended:", evt.track.kind);
    
    // Monitor video element state (only for video tracks)
    if (evt.track.kind === "video") {
      remoteVideo.onloadedmetadata = () => console.log("[Mobile] Video metadata loaded, dimensions:", remoteVideo.videoWidth, "x", remoteVideo.videoHeight);
      remoteVideo.onloadeddata = () => console.log("[Mobile] Video data loaded");
      remoteVideo.onplay = () => console.log("[Mobile] Video play event");
      remoteVideo.onerror = (e) => console.log("[Mobile] Video error:", e);
    }
  };

  peer.onicecandidate = (evt) => {
    if (!evt.candidate) return;
    wsSend({ type: "signal", target: "desktop", payload: { type: "candidate", candidate: evt.candidate } });
  };

  // Create negotiated data channel to match desktop (id: 0)
  dc = peer.createDataChannel("input", { ordered: true, negotiated: true, id: 0 });
  dc.onopen = () => setStatus("Connected.");
  dc.onclose = () => setStatus("Disconnected.");

  peer.onconnectionstatechange = () => {
    const st = peer.connectionState;
    console.log("[Mobile] Connection state:", st);
    if (st === "connected") {
      console.log("[Mobile] Transceivers after connect:", peer.getTransceivers().length);
      peer.getTransceivers().forEach((t, i) => {
        console.log(`[Mobile] Transceiver ${i}: direction=${t.direction}, currentDirection=${t.currentDirection}`);
        if (t.receiver && t.receiver.track) {
          console.log(`[Mobile] Transceiver ${i} receiver track:`, t.receiver.track.kind, t.receiver.track.readyState);
        }
      });
    }
    if (st === "failed") {
      teardown();
      return;
    }
    if (st === "disconnected") {
      if (disconnectTimer) clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => {
        if (!pc) return;
        if (pc.connectionState === "disconnected") teardown();
      }, 4000);
      return;
    }
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  };

  return peer;
}

async function handleSignal(payload) {
  if (!payload || typeof payload.type !== "string") return;

  if (payload.type === "offer") {
    if (pc) teardown();
    pc = createPeerConnection();
    await pc.setRemoteDescription(payload.sdp);
    console.log("[Mobile] Remote SDP set, creating answer...");
    const answer = await pc.createAnswer();
    console.log("[Mobile] Answer created, SDP has video:", answer.sdp.includes("m=video"));
    await pc.setLocalDescription(answer);
    console.log("[Mobile] Local description set");
    wsSend({ type: "signal", target: "desktop", payload: { type: "answer", sdp: pc.localDescription } });
    setStatus("Connecting…");
    return;
  }

  if (payload.type === "candidate") {
    if (!pc) return;
    try {
      await pc.addIceCandidate(payload.candidate);
    } catch {}
  }
}

function teardown() {
  try {
    if (dc) dc.close();
  } catch {}
  dc = null;
  try {
    if (pc) pc.close();
  } catch {}
  pc = null;
  if (disconnectTimer) clearTimeout(disconnectTimer);
  disconnectTimer = null;
}

// Type button - toggle type mode
typeBtn.addEventListener("click", () => {
  typeMode = !typeMode;
  typeBtn.classList.toggle("active", typeMode);
  typeSheet.hidden = !typeMode;
  if (typeMode) {
    // Disable other modes
    dragMode = false;
    dragBtn.classList.remove("active");
    scrollMode = false;
    scrollBtn.classList.remove("active");
    typeInput.focus();
    setStatus("Type mode - use mobile keyboard");
  } else {
    setStatus("Type mode disabled");
  }
});

// Scroll button - toggle scroll mode
scrollBtn.addEventListener("click", () => {
  scrollMode = !scrollMode;
  scrollBtn.classList.toggle("active", scrollMode);
  if (scrollMode) {
    // Disable other modes
    dragMode = false;
    dragBtn.classList.remove("active");
    typeMode = false;
    typeBtn.classList.remove("active");
    typeSheet.hidden = true;
    setStatus("Scroll mode enabled");
  } else {
    setStatus("Scroll mode disabled");
  }
});

// Drag button - toggle drag mode
// When active, touch only zooms/pans the screen view, no desktop mouse actions
dragBtn.addEventListener("click", () => {
  dragMode = !dragMode;
  dragBtn.classList.toggle("active", dragMode);
  if (dragMode) {
    // Disable other modes
    scrollMode = false;
    scrollBtn.classList.remove("active");
    typeMode = false;
    typeBtn.classList.remove("active");
    typeSheet.hidden = true;
    setStatus("Drag mode - touch to zoom and pan screen only");
  } else {
    setStatus("Drag mode disabled");
  }
});

// Mic toggle button
micToggle.addEventListener("click", () => {
  micEnabled = !micEnabled;
  micToggle.classList.toggle("active", micEnabled);
  dcSend({ type: "media", kind: "mic", enabled: micEnabled });
  // Unmute video element to hear audio from PC microphone
  remoteVideo.muted = !micEnabled;
  setStatus(micEnabled ? "Microphone enabled - listening to PC audio" : "Microphone disabled");
});

// Camera toggle button
cameraToggle.addEventListener("click", () => {
  cameraEnabled = !cameraEnabled;
  cameraToggle.classList.toggle("active", cameraEnabled);
  dcSend({ type: "media", kind: "camera", enabled: cameraEnabled });
  setStatus(cameraEnabled ? "Camera enabled" : "Camera disabled");
});

// Type input handler - send each character with delay, allow interruption
let lastInputValue = "";
let typingQueue = [];
let isTyping = false;
let charDelayTimeout = null;
let clearInputTimeout = null;

async function typeCharactersWithDelay(chars) {
  isTyping = true;
  typingQueue = chars.split('');
  
  for (let i = 0; i < typingQueue.length; i++) {
    if (!isTyping) {
      // Typing was interrupted - don't send any more characters
      console.log("[Type] Interrupted, stopped at:", i);
      typingQueue = [];
      return;
    }
    
    const char = typingQueue[i];
    dcSend({ type: "input", payload: { type: "text", text: char } });
    
    // Wait 75ms between characters (not after last one)
    if (i < typingQueue.length - 1) {
      await new Promise(resolve => {
        charDelayTimeout = setTimeout(() => {
          charDelayTimeout = null;
          resolve();
        }, 75);
      });
    }
  }
  
  isTyping = false;
  typingQueue = [];
  charDelayTimeout = null;
}

// Interrupt typing on any key press (only keys, not clicks/touches)
let typingJustInterrupted = false;
let interruptKeyChar = null;

typeInput.addEventListener("keydown", (e) => {
  if (isTyping) {
    isTyping = false;
    typingJustInterrupted = true;
    interruptKeyChar = e.key.length === 1 ? e.key : null; // Store printable character
    if (charDelayTimeout) {
      clearTimeout(charDelayTimeout);
      charDelayTimeout = null;
    }
    console.log("[Type] Interrupted by key:", e.key);
    // Reset flag after a short delay
    setTimeout(() => { 
      typingJustInterrupted = false; 
      interruptKeyChar = null;
    }, 200);
  }
  
  if (e.key === "Enter") {
    dcSend({ type: "input", payload: { type: "key-tap", key: "enter", modifiers: [] } });
    e.preventDefault();
  } else if (e.key === "ArrowLeft" || e.key === "Backspace") {
    dcSend({ type: "input", payload: { type: "key-tap", key: "backspace", modifiers: [] } });
    e.preventDefault();
  }
});

typeInput.addEventListener("input", (e) => {
  const value = typeInput.value;
  
  // Handle backspace (content deleted) - only send once
  if (e.inputType === "deleteContentBackward" || value.length < lastInputValue.length) {
    // Don't send backspace here - let keyup handle it to avoid double
    // Just update lastInputValue
  } else {
    // Send only the new character(s) typed/pasted
    const newChars = value.slice(lastInputValue.length);
    if (newChars) {
      // If we just interrupted, only send the interrupting key, ignore the rest
      if (typingJustInterrupted && interruptKeyChar) {
        console.log("[Type] Sending only interrupt key:", interruptKeyChar);
        // Only send if this matches the interrupt key
        if (newChars.includes(interruptKeyChar)) {
          dcSend({ type: "input", payload: { type: "text", text: interruptKeyChar } });
        }
        // Don't start new typing - the paste was interrupted
      } else if (!isTyping && !typingJustInterrupted) {
        // Start typing with delay (normal paste) - only if not interrupted recently
        typeCharactersWithDelay(newChars);
      }
    }
  }
  
  lastInputValue = value;
  
  // Clear the input field after a delay to allow next paste
  clearTimeout(clearInputTimeout);
  clearInputTimeout = setTimeout(() => {
    typeInput.value = "";
    lastInputValue = "";
  }, 500);
});

// Handle backspace only in keyup to avoid double firing
typeInput.addEventListener("keyup", (e) => {
  if (e.key === "Backspace") {
    dcSend({ type: "input", payload: { type: "key-tap", key: "backspace", modifiers: [] } });
    e.preventDefault();
    // Update lastInputValue to match cleared content
    lastInputValue = typeInput.value;
  }
});

// Stop typing button - interrupt paste typing immediately
if (stopTypingBtn) {
  stopTypingBtn.addEventListener("click", () => {
    if (isTyping) {
      // Clear the queue immediately
      typingQueue = [];
      isTyping = false;
      typingJustInterrupted = true;
      interruptKeyChar = null;
      
      // Clear any pending timeouts
      if (charDelayTimeout) {
        clearTimeout(charDelayTimeout);
        charDelayTimeout = null;
      }
      
      setStatus("Typing stopped");
      console.log("[Type] Stopped by button - queue cleared");
      
      // Reset flag after delay
      setTimeout(() => { 
        typingJustInterrupted = false; 
      }, 300);
    }
  });
}

fsToggle.addEventListener("click", async () => {
  const stage = document.getElementById("stage");
  if (!document.fullscreenElement) {
    try {
      await stage.requestFullscreen();
      if (screen.orientation && screen.orientation.lock) {
        try {
          await screen.orientation.lock("landscape");
        } catch {}
      }
    } catch {}
  } else {
    try {
      await document.exitFullscreen();
    } catch {}
  }
});

disconnectBtn.addEventListener("click", () => {
  dcSend({ type: "command", command: "disconnect" });
  teardown();
  setStatus("Disconnected.");
});

stage.addEventListener("dblclick", (evt) => {
  if (zoom > 1.01) {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyTransform();
    return;
  }
  zoomAt(2, evt.clientX, evt.clientY);
});

const pointers = new Map();
let dragActive = false;
let dragStartedAt = 0;
let lastMoveAt = 0;
let lastScrollCenter = null;

function sendMoveFromEvent(evt) {
  const p = getNormFromPoint(evt.clientX, evt.clientY);
  dcSend({ type: "input", payload: { type: "mouse-move", mode: "norm", x: p.x, y: p.y } });
}

touchLayer.addEventListener("pointerdown", (evt) => {
  touchLayer.setPointerCapture(evt.pointerId);
  pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY, t: Date.now() });

  if (pointers.size === 1) {
    dragActive = false;
    dragStartedAt = 0;
    lastMoveAt = 0;
    lastScrollCenter = null;
    pinchStartDist = null;
    pinchLastCenter = null;
    
    if (scrollMode) {
      // In scroll mode: first move cursor to touch location, then prepare to scroll
      const p = getNormFromPoint(evt.clientX, evt.clientY);
      dcSend({ type: "input", payload: { type: "mouse-move", mode: "norm", x: p.x, y: p.y } });
      lastScrollCenter = { cx: evt.clientX, cy: evt.clientY };
    } else if (dragMode) {
      // In drag mode: only zoom/pan the screen view, no desktop mouse actions
      // Just track the pointer for potential zoom/pan gestures
      // No mouse events sent to desktop
    } else {
      // Default mode: move cursor and click immediately on touch
      const p = getNormFromPoint(evt.clientX, evt.clientY);
      console.log("[Mobile] Clicking at:", p.x.toFixed(3), p.y.toFixed(3));
      dcSend({ type: "input", payload: { type: "mouse-move", mode: "norm", x: p.x, y: p.y } });
      dcSend({ type: "input", payload: { type: "mouse-click", button: "left", double: false, mode: "norm", x: p.x, y: p.y } });
      console.log("[Mobile] Click sent");
    }
  } else {
    lastScrollCenter = null;
    const ids = Array.from(pointers.keys());
    if (ids.length === 2) {
      const a = pointers.get(ids[0]);
      const b = pointers.get(ids[1]);
      pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchStartZoom = zoom;
      pinchLastCenter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
});

touchLayer.addEventListener("pointermove", (evt) => {
  if (!pointers.has(evt.pointerId)) return;
  const prev = pointers.get(evt.pointerId);
  pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY, t: prev.t });

  if (pointers.size === 1) {
    if (!scrollMode && !dragMode) {
      // Default and click mode: do nothing on move (click already happened on pointerdown)
      return;
    }
    
    if (dragMode) {
      // In drag mode: pan the screen with single finger drag
      const dx = evt.clientX - prev.x;
      const dy = evt.clientY - prev.y;
      panX += dx;
      panY += dy;
      applyTransform();
      return;
    }
    
    if (scrollMode && lastScrollCenter) {
      // In scroll mode, send scroll events based on vertical movement
      const dy = evt.clientY - lastScrollCenter.cy;
      // Only scroll on vertical movement, with reduced sensitivity
      if (Math.abs(dy) > 5) {
        lastScrollCenter = { cx: evt.clientX, cy: evt.clientY };
        // Negative dy means scrolling up (finger moving up)
        // Positive dy means scrolling down (finger moving down)
        dcSend({ type: "input", payload: { type: "scroll", dx: 0, dy: Math.round(dy * 2) } });
      }
      return;
    }
    
    // Default mode: do nothing on move
    return;
  }

  if (pointers.size === 2) {
    const ids = Array.from(pointers.keys());
    const a = pointers.get(ids[0]);
    const b = pointers.get(ids[1]);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchStartDist) {
      if (pinchLastCenter) {
        panX += cx - pinchLastCenter.x;
        panY += cy - pinchLastCenter.y;
      }
      zoomAt(pinchStartZoom * (dist / pinchStartDist), cx, cy);
      pinchLastCenter = { x: cx, y: cy };
      return;
    }
    if (!lastScrollCenter) lastScrollCenter = { cx, cy };
    const dy = cy - lastScrollCenter.cy;
    const dx = cx - lastScrollCenter.cx;
    lastScrollCenter = { cx, cy };
    dcSend({ type: "input", payload: { type: "scroll", dx: Math.round(dx * 0.5), dy: Math.round(dy * 0.8) } });
  }
});

touchLayer.addEventListener("pointerup", (evt) => {
  if (!pointers.has(evt.pointerId)) return;
  const start = pointers.get(evt.pointerId);
  pointers.delete(evt.pointerId);

  if (pointers.size === 0) {
    lastScrollCenter = null;
    pinchStartDist = null;
    pinchLastCenter = null;
    
    if (!scrollMode && !dragMode) {
      // Default mode: click already happened on pointerdown, do nothing here
      return;
    }
    
    if (dragMode && dragActive) {
      // In drag mode, release mouse button
      dragActive = false;
      dcSend({ type: "input", payload: { type: "mouse-toggle", button: "left", down: false } });
      return;
    }
    
    if (dragActive) {
      dragActive = false;
      return;
    }

    const dt = Date.now() - start.t;
    const moved = Math.hypot(evt.clientX - start.x, evt.clientY - start.y);
    // Only click in normal mode (not scroll mode, not drag mode)
    if (!scrollMode && !dragMode && dt < 450 && moved < 10) {
      sendMoveFromEvent(evt);
      dcSend({ type: "input", payload: { type: "mouse-click", button: "left", double: false } });
    }
  }
});

touchLayer.addEventListener("pointercancel", () => {
  pointers.clear();
  dragActive = false;
  pinchStartDist = null;
  pinchLastCenter = null;
});

// Disconnect when page is being closed (not on minimize/app switch)
// Only disconnect on actual page close/refresh, not visibility change
let isClosing = false;

// Handle back button - show confirmation if connected
window.addEventListener("popstate", (e) => {
  if (pc && pc.connectionState === "connected") {
    // Prevent default back action
    history.pushState(null, "", location.href);
    
    // Show confirmation dialog
    if (confirm("You are currently connected. Do you want to disconnect and exit?")) {
      isClosing = true;
      // Send disconnect command
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "command", target: "desktop", command: "disconnect" }));
      }
      teardown();
      // Close the window/tab
      window.close();
      // If window.close() didn't work (mobile), redirect
      setTimeout(() => {
        location.href = "about:blank";
      }, 100);
    }
    // If user presses Cancel, do nothing - stay connected
  }
});

// Push initial state to enable popstate detection
history.pushState(null, "", location.href);

window.addEventListener("beforeunload", (e) => {
  if (isClosing) return; // Already handled by confirmation
  
  // Use sendBeacon for reliable delivery during page unload
  if (wsUrl) {
    const blob = new Blob([JSON.stringify({ type: "command", target: "desktop", command: "disconnect" })], { type: "application/json" });
    navigator.sendBeacon(wsUrl.replace("wss://", "https://").replace("ws://", "http://"), blob);
  }
  teardown();
});

// Handle page being closed (for mobile browsers)
window.addEventListener("pagehide", (evt) => {
  // Only disconnect if page is actually being closed, not frozen
  if (!evt.persisted) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "command", target: "desktop", command: "disconnect" }));
    }
    teardown();
  }
});

// ===== SNAP FEATURE =====
// snapMode and lastExtractedText already declared above

// Snap button - toggle snap mode
snapBtn.addEventListener("click", async () => {
  // One-click automatic capture
  await captureAndProcessScreen();
});

// Function to capture full screen and process
async function captureAndProcessScreen() {
  // Check if video is ready
  if (!remoteVideo.videoWidth || !remoteVideo.videoHeight) {
    setStatus("Error: Video not ready");
    snapMode = false;
    snapBtn.classList.remove("active");
    return;
  }
  
  console.log("[Snap] Video dimensions:", remoteVideo.videoWidth, "x", remoteVideo.videoHeight);
  
  // Capture the entire video frame (full desktop)
  const captureW = remoteVideo.videoWidth;
  const captureH = remoteVideo.videoHeight;
  
  console.log("[Snap] Capturing full screen:", captureW, "x", captureH);
  
  // Create canvas - scale down significantly to avoid 413 error
  const maxDimension = 1280; // Reduced from 1920 to keep payload small
  let canvasW = captureW;
  let canvasH = captureH;
  
  if (captureW > maxDimension || captureH > maxDimension) {
    const ratio = Math.min(maxDimension / captureW, maxDimension / captureH);
    canvasW = Math.round(captureW * ratio);
    canvasH = Math.round(captureH * ratio);
  }
  
  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");
  
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  
  ctx.drawImage(remoteVideo, 0, 0, captureW, captureH, 0, 0, canvasW, canvasH);
  
  // Use JPEG with 85% quality to reduce size (PNG is too large)
  const imageData = canvas.toDataURL("image/jpeg", 0.85);
  
  console.log("[Snap] Image size:", Math.round(imageData.length / 1024), "KB");
  
  setStatus("Analyzing screen with OCR...");
  
  try {
    const response = await fetch("/api/snap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageData })
    });
    
    // Check if response is OK
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Snap] Server error:", response.status, errorText);
      throw new Error(`Server error: ${response.status}`);
    }
    
    const result = await response.json();
    
    // Store the extracted text for Text button
    lastExtractedText = result.text || "No text extracted";
    
    // Show result popup - only answer, no extracted text
    snapResultContent.innerHTML = `
      <strong>Answer:</strong><br>${result.answer || "No answer"}
    `;
    snapResult.hidden = false;
    setStatus("Analysis complete");
    
    // Reset snap mode
    snapMode = false;
    snapBtn.classList.remove("active");
    
  } catch (err) {
    snapResultContent.innerHTML = `<strong>Error:</strong><br>${err.message}`;
    snapResult.hidden = false;
    setStatus("Analysis failed");
    snapMode = false;
    snapBtn.classList.remove("active");
  }
}

function hideSnapOverlay() {
  snapResult.hidden = true;
}

// Close result button
snapCloseResult.addEventListener("click", () => {
  snapResult.hidden = true;
});

connectSignaling();
