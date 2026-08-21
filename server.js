const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const { createClient } = require("@supabase/supabase-js");
const Tesseract = require("tesseract.js");
const OpenAI = require("openai");
const sharp = require("sharp");

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

function safeJsonParse(message) {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function isOpen(ws) {
  // WebSocket.OPEN = 1 (readyState constant)
  return ws && ws.readyState === 1;
}

const SESSION_TTL_MS = 2 * 60 * 1000;
const sessions = new Map();
const linkStates = new Map();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

function generateLinkCode() {
  const n = Math.floor(100000 + Math.random() * 900000);
  return String(n);
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

async function fetchProfileByEmail(email) {
  if (!supabase) return null;
  const emailLower = email.toLowerCase();
  
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("email, plan, verifier, trial, plan_expires_at")
      .eq("email", emailLower)
      .maybeSingle();

    if (error) {
      console.error(`[Verifier] Fetch error: ${error.message}`);
      return null;
    }

    if (data) return data;

    // Fallback: If profile missing but user exists in Auth, create it.
    console.log(`[Verifier] Profile missing for ${emailLower}, checking Auth...`);
    const { data: authData, error: authError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    
    if (authError || !authData || !authData.users) {
      console.error(`[Verifier] Auth list error or no data: ${authError?.message}`);
      return null;
    }

    const users = authData.users;
    const user = users.find(u => u.email && u.email.toLowerCase() === emailLower);
    if (!user) {
      console.error(`[Verifier] User ${emailLower} not found in Auth.`);
      return null;
    }

    console.log(`[Verifier] Found user in Auth (ID: ${user.id}), creating profile...`);
    const newProfile = {
      id: user.id,
      email: emailLower,
      plan: "basic",
      verifier: false,
      updated_at: new Date().toISOString()
    };

    const { error: insertError } = await supabase
      .from("profiles")
      .insert([newProfile]);

    if (insertError) {
      console.error(`[Verifier] Profile creation failed: ${insertError.message}`);
      return null;
    }

    return { email: emailLower, plan: "basic", verifier: false };
  } catch (err) {
    console.error(`[Verifier] Exception in fetch: ${err.message}`);
    return null;
  }
}

async function updateProfileVerifier(email, status) {
  if (!supabase) return false;
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

function getSession(token) {
  const now = Date.now();
  let session = sessions.get(token);
  if (!session) {
    session = {
      desktopSocket: null,
      mobileSocket: null,
      expiresAt: now + SESSION_TTL_MS,
    };
    sessions.set(token, session);
  } else {
    session.expiresAt = now + SESSION_TTL_MS;
  }
  return session;
}

setInterval(async () => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    const desktopConnected = isOpen(session.desktopSocket);
    const mobileConnected = isOpen(session.mobileSocket);

    // Security 4: Mid-session plan expiration check
    // If a plan has an active expiry date (trial or timed pass) and it has expired, terminate session
    if (session.plan && session.plan !== "basic" && supabase) {
      const linkState = linkStates.get(token);
      if (linkState && linkState.email) {
        try {
          const { data: profile } = await supabase
            .from("profiles")
            .select("plan, plan_expires_at")
            .eq("email", linkState.email.toLowerCase())
            .maybeSingle();

          if (profile && profile.plan_expires_at) {
            const expiryTime = new Date(profile.plan_expires_at).getTime();
            if (!isNaN(expiryTime) && expiryTime > 0 && now > expiryTime) {
              console.log(`[Session] Plan expired for ${linkState.email} (token: ${token.substring(0, 8)}...). Terminating connection.`);
              session.plan = "basic";
              linkState.plan = "basic";
              try {
                if (isOpen(session.mobileSocket)) {
                  session.mobileSocket.send(JSON.stringify({
                    type: "peer",
                    payload: { event: "plan-expired", message: "Your plan duration has expired." }
                  }));
                  session.mobileSocket.close(4403, "plan-expired");
                }
                if (isOpen(session.desktopSocket)) {
                  session.desktopSocket.close(4403, "plan-expired");
                }
              } catch {}
              sessions.delete(token);
              continue;
            }
          }
        } catch (err) {
          console.error("[Session] Error checking mid-session plan expiry:", err.message);
        }
      }
    }

    if (session.expiresAt > now) continue;
    
    if (desktopConnected || mobileConnected) {
      // Extend session if still active
      session.expiresAt = now + SESSION_TTL_MS;
      continue;
    }
    
    // Only delete if both are disconnected
    sessions.delete(token);
    console.log(`[Session] Deleted expired session for token ${token.substring(0, 8)}...`);
  }
}, 60 * 1000).unref();

// Disposable email domains blocklist to prevent infinite free trial abuse
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com", "tempmail.com", "10minutemail.com", "guerrillamail.com",
  "sharklasers.com", "dispostable.com", "yopmail.com", "trashmail.com",
  "getairmail.com", "tempr.email", "mohmal.com", "generator.email",
  "fakemailgenerator.com", "mytemp.email", "emailondeck.com", "throwawaymail.com",
  "crazymailing.com", "armyspy.com", "cuvox.de", "dayrep.com", "fleckens.hu",
  "gustr.com", "jourrapide.com", "rhyta.com", "superrito.com", "teleworm.us"
]);

function isDisposableEmail(email) {
  if (!email || typeof email !== "string") return false;
  const parts = email.toLowerCase().split("@");
  if (parts.length !== 2) return false;
  const domain = parts[1].trim();
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

// In-memory rate limiter per IP / token
const ipRateLimits = new Map();
const aiRequestTracker = new Map(); // token -> { lastRequestAt, dailyCount, dateStr }

function checkIpRateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  let record = ipRateLimits.get(ip);
  if (!record || now - record.startTime > windowMs) {
    record = { count: 1, startTime: now };
    ipRateLimits.set(ip, record);
    return true;
  }
  record.count += 1;
  return record.count <= limit;
}

// Clean up stale rate limits every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of ipRateLimits.entries()) {
    if (now - record.startTime > 60000) ipRateLimits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://helvia.in");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // Global IP rate limiting: 100 requests per minute per IP
  const clientIp = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  if (!checkIpRateLimit(clientIp, 100, 60000)) {
    return res.status(429).json({ ok: false, error: "too-many-requests", message: "Rate limit exceeded. Please slow down." });
  }

  next();
});

// Reduced from 20mb to 6mb to prevent memory exhaustion attacks
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ limit: "6mb", extended: true }));
const publicDir = path.join(__dirname, "public");

app.get("/m/", (req, res) => {
  res.sendFile(path.join(publicDir, "mobile", "index.html"));
});

app.use("/m/", express.static(path.join(publicDir, "mobile"), { index: false }));

app.get("/d/", (req, res) => {
  res.sendFile(path.join(publicDir, "mobile", "index.html"));
});

app.use("/d/", express.static(path.join(publicDir, "mobile"), { index: false }));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/link/request-code", async (req, res) => {
  if (!supabase) {
    res.status(500).json({ ok: false });
    return;
  }
  const body = req.body || {};
  const emailRaw = typeof body.email === "string" ? body.email : "";
  const email = emailRaw.trim().toLowerCase();
  if (!email) {
    res.status(400).json({ ok: false });
    return;
  }
  const profile = await fetchProfileByEmail(email);
  if (!profile) {
    res.status(404).json({ ok: false });
    return;
  }
  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("profiles")
    .update({ link_code: code, link_code_expires_at: expiresAt })
    .eq("email", email);
  if (error) {
    res.status(500).json({ ok: false });
    return;
  }
  res.json({ ok: true, code });
});

app.post("/api/link/complete-code", async (req, res) => {
  if (!supabase) {
    res.status(500).json({ ok: false });
    return;
  }
  const body = req.body || {};
  const codeRaw = typeof body.code === "string" ? body.code : "";
  const code = codeRaw.trim();
  if (!code) {
    res.status(400).json({ ok: false });
    return;
  }
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("profiles")
    .select("email, plan, verifier")
    .eq("link_code", code)
    .gt("link_code_expires_at", nowIso)
    .maybeSingle();
  if (error) {
    res.status(500).json({ ok: false });
    return;
  }
  if (!data) {
    res.status(404).json({ ok: false });
    return;
  }
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  const plan = typeof data.plan === "string" && data.plan ? data.plan : "basic";
  if (!email) {
    res.status(500).json({ ok: false });
    return;
  }
  if (data.verifier === true) {
    res.status(403).json({ ok: false });
    return;
  }
  const { error: updateError } = await supabase
    .from("profiles")
    .update({
      verifier: true,
      link_code: null,
      link_code_expires_at: null,
      updated_at: nowIso,
    })
    .eq("link_code", code);
  if (updateError) {
    res.status(500).json({ ok: false });
    return;
  }
  res.json({ ok: true, email, plan });
});

app.post("/api/link/complete", async (req, res) => {
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
    plan: profile.plan || "basic",
    updatedAt: Date.now(),
  };
  linkStates.set(token, stored);
  console.log(`[Link] Success for ${email}, token linked.`);
  res.json({ ok: true, email: stored.email, plan: stored.plan });
});

app.post("/api/desktop/generate-code", async (req, res) => {
  if (!supabase) {
    res.status(500).json({ ok: false, error: "supabase-missing" });
    return;
  }
  let attempts = 0;
  while (attempts < 5) {
    attempts += 1;
    const code = generateLinkCode();
    try {
      const { error } = await supabase.from("link_codes").insert({ code });
      if (!error) {
        res.json({ ok: true, code });
        return;
      }
      if (error.code && error.code !== "23505") {
        console.error("[DesktopCode] Insert failed:", error.message);
        break;
      }
    } catch (err) {
      console.error("[DesktopCode] Insert exception:", err.message);
      break;
    }
  }
  res.status(500).json({ ok: false, error: "insert-failed" });
});

app.post("/api/desktop/check-code", async (req, res) => {
  if (!supabase) {
    res.status(500).json({ ok: false, error: "supabase-missing" });
    return;
  }
  const body = req.body || {};
  const codeRaw = typeof body.code === "string" ? body.code : "";
  const code = codeRaw.trim();
  if (!code) {
    res.status(400).json({ ok: false, error: "missing-code" });
    return;
  }
  let email = "";
  try {
    const { data, error } = await supabase
      .from("link_codes")
      .select("email")
      .eq("code", code)
      .maybeSingle();
    if (error) {
      console.error("[DesktopCode] Fetch failed:", error.message);
      res.status(500).json({ ok: false, error: "fetch-failed" });
      return;
    }
    if (!data || typeof data.email !== "string" || !data.email.trim()) {
      res.json({ ok: true, linked: false });
      return;
    }
    email = data.email.trim().toLowerCase();
  } catch (err) {
    console.error("[DesktopCode] Fetch exception:", err.message);
    res.status(500).json({ ok: false, error: "fetch-exception" });
    return;
  }

  const profile = await fetchProfileByEmail(email);
  if (!profile) {
    res.status(404).json({ ok: false, error: "profile-not-found" });
    return;
  }

  if (profile.verifier === true) {
    res.status(409).json({ ok: false, error: "already-logged-in" });
    return;
  }

  const verifierUpdated = await updateProfileVerifier(email, true);
  if (!verifierUpdated) {
    res.status(500).json({ ok: false, error: "verifier-update-failed" });
    return;
  }

  try {
    await supabase.from("link_codes").delete().eq("code", code);
  } catch {}

  res.json({
    ok: true,
    linked: true,
    email: profile.email,
    plan: profile.plan || "basic",
  });
});

app.get("/api/link/status", (req, res) => {
  const tokenParam = req.query && typeof req.query.token === "string" ? req.query.token : "";
  if (!tokenParam) {
    res.status(400).json({ ok: false, linked: false });
    return;
  }
  const info = linkStates.get(tokenParam);
  const session = sessions.get(tokenParam);
  const plan = (info && info.plan) || (session && session.plan) || "";
  const email = (info && info.email) || "";
  
  if (!info && !session) {
    res.json({ ok: true, linked: false });
    return;
  }
  res.json({ ok: true, linked: true, email: email, plan: plan });
});

app.get("/api/plan", async (req, res) => {
  const emailParam = req.query && typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  if (!emailParam) {
    res.status(400).json({ ok: false });
    return;
  }
  const profile = await fetchProfileByEmail(emailParam);
  if (!profile) {
    res.status(404).json({ ok: false });
    return;
  }
  res.json({
    ok: true,
    email: profile.email,
    plan: profile.plan || "basic",
    trial: !!profile.trial,
    plan_expires_at: profile.plan_expires_at
  });
});

app.post("/api/link/logout", async (req, res) => {
  const body = req.body || {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) {
    res.status(400).json({ ok: false });
    return;
  }
  const ok = await updateProfileVerifier(email, false);
  
  // Clear any pending link states for this email
  for (const [t, data] of linkStates.entries()) {
    if (data.email && data.email.toLowerCase() === email) {
      linkStates.delete(t);
    }
  }

  res.json({ ok });
});

app.post("/api/link/activate-trial", async (req, res) => {
  const body = req.body || {};
  const emailRaw = typeof body.email === "string" ? body.email : "";
  const email = emailRaw.trim().toLowerCase();
  
  if (!email) {
    res.status(400).json({ ok: false, error: "missing-email" });
    return;
  }

  // Security 1: Block disposable/temporary email services
  if (isDisposableEmail(email)) {
    console.warn(`[Trial] Blocked disposable email signup: ${email}`);
    res.status(400).json({
      ok: false,
      error: "disposable-email-blocked",
      message: "Temporary/disposable email addresses are not allowed. Please use a permanent email."
    });
    return;
  }
  
  if (!supabase) {
    res.status(500).json({ ok: false, error: "server-config-error" });
    return;
  }
  
  try {
    // Security 2: One-time trial check - prevent re-activation if user already used trial
    const { data: existingProfile, error: fetchErr } = await supabase
      .from("profiles")
      .select("trial, plan_expires_at")
      .eq("email", email)
      .maybeSingle();

    if (fetchErr) {
      console.error(`[Trial] Check failed for ${email}:`, fetchErr.message);
    }

    if (existingProfile && existingProfile.trial === true) {
      console.warn(`[Trial] Blocked duplicate trial claim for ${email}`);
      res.status(403).json({
        ok: false,
        error: "trial-already-claimed",
        message: "Free trial has already been used on this account. Please upgrade to Pro to continue."
      });
      return;
    }

    // Activate trial for 10 minutes
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    
    const { error } = await supabase
      .from("profiles")
      .update({ 
        trial: true,
        plan: "trial",
        plan_expires_at: expiresAt
      })
      .eq("email", email);
      
    if (error) {
      console.error(`[Trial] Update failed for ${email}: ${error.message}`);
      res.status(500).json({ ok: false, error: error.message });
      return;
    }
    
    console.log(`[Trial] Activated for ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[Trial] Exception: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Snap endpoint - OCR and OpenAI processing
app.post("/api/snap", async (req, res) => {
  const { image } = req.body;
  
  if (!image || typeof image !== "string") {
    res.status(400).json({ error: "missing-image" });
    return;
  }
  
  try {
    console.log("[Snap] Processing image...");
    
    // Extract base64 data from data URL
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    
    // Get image info
    const metadata = await sharp(buffer).metadata();
    console.log(`[Snap] Original image: ${metadata.width}x${metadata.height}`);
    
    // Try multiple preprocessing strategies and pick the best result
    const ocrAttempts = [];
    
    // For larger images (4x scale from client), skip upscaling
    const needsUpscale = metadata.width < 800 || metadata.height < 600;
    
    // Strategy 1: Clean grayscale with sharpening (best for clear text)
    console.log("[Snap] OCR Strategy 1: Clean grayscale...");
    try {
      let processor1 = sharp(buffer).grayscale().normalize();
      if (needsUpscale) {
        processor1 = processor1.resize({
          width: Math.max(metadata.width * 2, 800),
          fit: 'inside'
        });
      }
      processor1 = processor1.sharpen({ sigma: 1.5 });
      const processed1 = await processor1.toBuffer();
      
      const result1 = await Tesseract.recognize(processed1, "eng", {
        logger: () => {},
        errorHandler: (err) => console.error("[Snap] OCR1 error:", err),
      });
      ocrAttempts.push({ text: result1.data.text.trim(), confidence: result1.data.confidence, strategy: "clean" });
      console.log(`[Snap] Strategy 1: ${result1.data.confidence}% - "${result1.data.text.trim().substring(0, 80)}"`);
    } catch (e) {
      console.log("[Snap] Strategy 1 failed:", e.message);
    }
    
    // Strategy 2: High contrast for light backgrounds
    console.log("[Snap] OCR Strategy 2: High Contrast...");
    try {
      let processor2 = sharp(buffer).grayscale();
      if (needsUpscale) {
        processor2 = processor2.resize({
          width: Math.max(metadata.width * 2, 800),
          fit: 'inside'
        });
      }
      processor2 = processor2.modulate({ brightness: 1.1, contrast: 1.4 }).sharpen({ sigma: 1 });
      const processed2 = await processor2.toBuffer();
      
      const result2 = await Tesseract.recognize(processed2, "eng", {
        logger: () => {},
        errorHandler: (err) => console.error("[Snap] OCR2 error:", err),
      });
      ocrAttempts.push({ text: result2.data.text.trim(), confidence: result2.data.confidence, strategy: "contrast" });
      console.log(`[Snap] Strategy 2: ${result2.data.confidence}% - "${result2.data.text.trim().substring(0, 80)}"`);
    } catch (e) {
      console.log("[Snap] Strategy 2 failed:", e.message);
    }
    
    // Strategy 3: For dark backgrounds or inverted text
    console.log("[Snap] OCR Strategy 3: Inverted...");
    try {
      let processor3 = sharp(buffer).grayscale().negate();
      if (needsUpscale) {
        processor3 = processor3.resize({
          width: Math.max(metadata.width * 2, 800),
          fit: 'inside'
        });
      }
      processor3 = processor3.normalize().sharpen({ sigma: 1.2 });
      const processed3 = await processor3.toBuffer();
      
      const result3 = await Tesseract.recognize(processed3, "eng", {
        logger: () => {},
        errorHandler: (err) => console.error("[Snap] OCR3 error:", err),
      });
      ocrAttempts.push({ text: result3.data.text.trim(), confidence: result3.data.confidence, strategy: "inverted" });
      console.log(`[Snap] Strategy 3: ${result3.data.confidence}% - "${result3.data.text.trim().substring(0, 80)}"`);
    } catch (e) {
      console.log("[Snap] Strategy 3 failed:", e.message);
    }
    
    // Strategy 4: Original image (as fallback)
    console.log("[Snap] OCR Strategy 4: Original...");
    try {
      const result4 = await Tesseract.recognize(buffer, "eng", {
        logger: () => {},
        errorHandler: (err) => console.error("[Snap] OCR4 error:", err),
      });
      ocrAttempts.push({ text: result4.data.text.trim(), confidence: result4.data.confidence, strategy: "original" });
      console.log(`[Snap] Strategy 4: ${result4.data.confidence}% - "${result4.data.text.trim().substring(0, 80)}"`);
    } catch (e) {
      console.log("[Snap] Strategy 4 failed:", e.message);
    }
    
    // Pick the best result based on confidence and text length
    let bestResult = ocrAttempts[0];
    for (const attempt of ocrAttempts) {
      // Prefer results with higher confidence and reasonable text length
      const attemptScore = attempt.confidence + (attempt.text.length > 10 ? 10 : 0);
      const bestScore = bestResult.confidence + (bestResult.text.length > 10 ? 10 : 0);
      if (attemptScore > bestScore) {
        bestResult = attempt;
      }
    }
    
    const finalText = bestResult?.text || "";
    const finalConfidence = bestResult?.confidence || 0;
    const finalStrategy = bestResult?.strategy || "none";
    
    console.log(`[Snap] Best result from ${finalStrategy}: ${finalConfidence}% - "${finalText.substring(0, 150)}"`);
    
    if (!finalText || finalText.length < 3) {
      res.json({
        text: "No readable text found",
        answer: "Try selecting a region with clearer, larger text. Make sure text is well-lit and not blurry."
      });
      return;
    }
    
    // Check if OpenAI API key is configured
    if (!process.env.OPENAI_API_KEY) {
      console.log("[Snap] OpenAI API key not configured, returning text only");
      res.json({
        text: finalText,
        answer: "OpenAI API key not configured. Add OPENAI_API_KEY environment variable for AI analysis."
      });
      return;
    }
    
    // Send to OpenAI for analysis with improved prompt
    console.log("[Snap] Sending to OpenAI...");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an expert exam and problem-solving AI. The user will provide text extracted via OCR.
Provide ONLY:
1. The exact option letter (A, B, C, D) and option text.
2. A very short 1-2 sentence explanation.

Format:
🎯 Option [Letter]: [Answer Text]
💡 Explanation: [1-2 sentences]`
        },
        {
          role: "user",
          content: `OCR extracted text (may have errors): "${finalText}"`
        }
      ],
      max_tokens: 200,
      temperature: 0.1,
    });
    
    const aiAnswer = completion.choices[0]?.message?.content?.trim() || "Could not determine answer";
    console.log("[Snap] AI answer:", aiAnswer.substring(0, 150));
    
    res.json({
      text: finalText,
      answer: aiAnswer
    });
  } catch (err) {
    console.error(`[Snap] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Screen Analysis Endpoint (Vision with Server-Side Pro Plan Enforcement)
app.post("/api/analyze-screen", async (req, res) => {
  const { image, prompt, token } = req.body || {};

  if (!image || typeof image !== "string") {
    return res.status(400).json({ ok: false, error: "missing-image" });
  }

  // Server-side plan verification: Prevent users from bypassing plan check by editing URL
  let isPro = false;
  if (token && typeof token === "string") {
    const session = sessions.get(token);
    const linkState = linkStates.get(token);
    const sessionPlan = (session && session.plan) || (linkState && linkState.plan) || "";
    
    if (["pro", "premium", "enterprise"].includes(sessionPlan.toLowerCase())) {
      isPro = true;
    } else if (linkState && linkState.email && supabase) {
      try {
        const { data: profile } = await supabase
          .from("profiles")
          .select("plan")
          .eq("email", linkState.email.toLowerCase())
          .maybeSingle();
        if (profile && ["pro", "premium", "enterprise"].includes((profile.plan || "").toLowerCase())) {
          isPro = true;
        }
      } catch (err) {
        console.error("[Analyze-Screen] DB plan check error:", err.message);
      }
    }
  }

  if (!isPro) {
    console.warn(`[Analyze-Screen] 403 Forbidden: Blocked non-pro request (token: ${token ? token.substring(0, 8) + '...' : 'none'}).`);
    return res.status(403).json({
      ok: false,
      error: "pro-required",
      message: "AI Screen Analysis is available exclusively on Pro plans. Please upgrade to use this feature."
    });
  }

  // Security 3: Cooldown and Daily Quota to prevent auto-clickers / API Denial-of-Wallet
  const now = Date.now();
  const todayStr = new Date().toISOString().split("T")[0];
  const trackerKey = token || req.ip || "global";
  let tracker = aiRequestTracker.get(trackerKey);

  if (!tracker || tracker.dateStr !== todayStr) {
    tracker = { lastRequestAt: 0, dailyCount: 0, dateStr: todayStr };
    aiRequestTracker.set(trackerKey, tracker);
  }

  // 4-second cooldown between consecutive AI requests
  if (now - tracker.lastRequestAt < 4000) {
    const waitSec = Math.ceil((4000 - (now - tracker.lastRequestAt)) / 1000);
    return res.status(429).json({
      ok: false,
      error: "rate-limited",
      message: `Please wait ${waitSec}s before requesting another AI analysis.`
    });
  }

  // Daily quota: Max 300 answers per user per day to prevent runaway script abuse
  const DAILY_AI_LIMIT = 300;
  if (tracker.dailyCount >= DAILY_AI_LIMIT) {
    return res.status(429).json({
      ok: false,
      error: "daily-quota-exceeded",
      message: `Daily AI limit reached (${DAILY_AI_LIMIT} answers/day). Limit resets at midnight UTC.`
    });
  }

  tracker.lastRequestAt = now;
  tracker.dailyCount += 1;

  try {
    console.log("[Analyze-Screen] Step 1: Transcribing and classifying screen...");
    const base64Data = image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;

    // Step 1: Extract text and classify the screen type
    const extractionResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a precise screen OCR reader and classifier.
Task:
1. Transcribe the main question, coding problem, existing code on screen, and any options (A, B, C, D) verbatim.
2. Classify the content type into one of three categories:
   - "MCQ" (if there is a multiple-choice question with options like A, B, C, D)
   - "CODING" (if there is a coding problem, IDE code, function to implement, bug to fix, or error trace)
   - "GENERAL" (if it is general text, article, diagram, or conceptual question)

Respond strictly in this JSON format:
{
  "type": "MCQ" | "CODING" | "GENERAL",
  "transcription": "all transcribed text, code, or question and options verbatim"
}`
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe the content and classify whether it is MCQ, CODING, or GENERAL." },
            {
              type: "image_url",
              image_url: {
                url: base64Data,
                detail: "low"
              }
            }
          ]
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 600,
      temperature: 0.0,
    });

    const rawJson = extractionResponse.choices[0]?.message?.content?.trim() || "{}";
    let parsed = { type: "GENERAL", transcription: "" };
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = { type: "GENERAL", transcription: rawJson };
    }

    const contentType = (parsed.type || "GENERAL").toUpperCase();
    const extractedText = (parsed.transcription || "").trim();
    console.log(`[Analyze-Screen] Detected content type: ${contentType}`);

    if (!extractedText || extractedText.length < 5) {
      return res.json({ ok: true, answer: "Could not clearly read the screen. Please ensure the content is in view." });
    }

    let aiAnswer = "";

    // ROUTE 1: Multiple Choice Question (MCQ) -> Use o3-mini for deep reasoning
    if (contentType === "MCQ") {
      console.log("[Analyze-Screen] Solving MCQ with o3-mini...");
      try {
        const solverResponse = await openai.chat.completions.create({
          model: "o3-mini",
          messages: [
            {
              role: "user",
              content: `Solve this question and identify the exact answer value.

Question and Options:
"""
${extractedText}
"""

Strict Format Instructions:
1. Provide ONLY the pure answer value/result on the first line (do NOT include option letters like A, B, C, D).
2. Provide a 1-2 sentence concise reason/calculation on the second line.

Format:
🎯 **Answer: [Exact Answer Value/Result]**
💡 **Reason:** [1-2 sentence calculation or factual explanation]`
            }
          ]
        });
        aiAnswer = solverResponse.choices[0]?.message?.content?.trim() || "";
      } catch (o3Err) {
        console.warn("[Analyze-Screen] o3-mini fallback to gpt-4o:", o3Err.message);
        const fallbackResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: "You are an expert exam solver. Output ONLY the pure answer value at the top (no option letters) and a 1-2 sentence reason."
            },
            {
              role: "user",
              content: `Solve this question:
${extractedText}

Format:
🎯 **Answer: [Exact Answer Value/Result]**
💡 **Reason:** [1-2 sentences]`
            }
          ],
          max_tokens: 150,
          temperature: 0.0,
        });
        aiAnswer = fallbackResponse.choices[0]?.message?.content?.trim() || "No answer generated.";
      }
    } 
    // ROUTE 2: Coding Problem / Code Fix -> Use gpt-4o-mini (Fast & keeps existing methods/classes/parameters)
    else if (contentType === "CODING") {
      console.log("[Analyze-Screen] Solving Coding task with gpt-4o-mini...");
      const codeResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert software engineer.
STRICT RULES FOR CODING SOLUTIONS:
1. If there is existing code, DO NOT change existing method signatures, class names, or parameter types. Work directly within the existing structure.
2. Provide the clean, complete, and working code snippet inside a standard markdown code block (\`\`\`language ... \`\`\`).
3. After the code block, provide a concise 1-2 sentence explanation of the fix.
4. Do NOT include unnecessary filler text.`
          },
          {
            role: "user",
            content: `Here is the coding problem / current code on screen:
"""
${extractedText}
"""

Provide the exact working code fix that integrates seamlessly with existing code, keeping all original classes, methods, and parameters intact.`
          }
        ],
        max_tokens: 650,
        temperature: 0.0,
      });
      aiAnswer = codeResponse.choices[0]?.message?.content?.trim() || "No code generated.";
    }
    // ROUTE 3: General Text / Image / Conceptual Question -> Use gpt-4o-mini
    else {
      console.log("[Analyze-Screen] Explaining General content with gpt-4o-mini...");
      const generalResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are an intelligent assistant. Provide a direct, clear, and concise 2-3 sentence answer/explanation of the content shown on screen."
          },
          {
            role: "user",
            content: `Explain and answer what is shown on screen:
"""
${extractedText}
"""`
          }
        ],
        max_tokens: 250,
        temperature: 0.1,
      });
      aiAnswer = generalResponse.choices[0]?.message?.content?.trim() || "No explanation generated.";
    }

    console.log("[Analyze-Screen] Final answer ready:", aiAnswer.substring(0, 100));
    res.json({ ok: true, answer: aiAnswer, type: contentType });
  } catch (err) {
    console.error("[Analyze-Screen] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const token = url.searchParams.get("t");

  if (!token) {
    try {
      ws.close(4401, "missing-token");
    } catch {}
    return;
  }

  const session = getSession(token);

  // Setup keepalive ping-pong to prevent connection timeout
  let pingInterval = null;
  let pongTimeout = null;
  
  const startPing = () => {
    pingInterval = setInterval(() => {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.ping();
        // Wait for pong, if not received within 10 seconds, close connection
        pongTimeout = setTimeout(() => {
          console.log(`[Keepalive] No pong received, closing connection`);
          try { ws.close(4401, "ping-timeout"); } catch {}
        }, 10000);
      }
    }, 30000); // Ping every 30 seconds
  };
  
  ws.on("pong", () => {
    if (pongTimeout) {
      clearTimeout(pongTimeout);
      pongTimeout = null;
    }
  });
  
  ws.on("close", () => {
    if (pingInterval) clearInterval(pingInterval);
    if (pongTimeout) clearTimeout(pongTimeout);
  });
  
  startPing();

  ws.on("message", (raw) => {
    const msg = safeJsonParse(String(raw));
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "hello") {
      if (msg.role === "desktop") {
        console.log(`[Hello] Desktop connected, token: ${token.substring(0, 8)}...`);
        if (session.desktopSocket && session.desktopSocket !== ws) {
          console.log(`[Hello] Desktop already connected, rejecting`);
          try {
            ws.close(4409, "desktop-already-connected");
          } catch {}
          return;
        }
        session.desktopSocket = ws;
        if (msg.plan) session.plan = msg.plan;
        console.log(`[Hello] Desktop socket stored, mobile exists: ${!!session.mobileSocket}, plan: ${session.plan || "default"}`);
        if (isOpen(session.mobileSocket)) {
          try {
            session.mobileSocket.send(JSON.stringify({ type: "peer", payload: { event: "desktop-online", plan: session.plan || "basic" } }));
          } catch {}
          try {
            ws.send(JSON.stringify({ type: "peer", payload: { event: "mobile-online" } }));
          } catch {}
        } else {
          try {
            ws.send(JSON.stringify({ type: "peer", payload: { event: "mobile-offline" } }));
          } catch {}
        }
        return;
      }

      if (msg.role === "mobile") {
        console.log(`[Hello] Mobile connected, token: ${token.substring(0, 8)}...`);
        if (session.mobileSocket && session.mobileSocket !== ws) {
          console.log(`[Hello] Mobile already connected, rejecting`);
          try {
            ws.close(4409, "mobile-already-connected");
          } catch {}
          return;
        }
        session.mobileSocket = ws;
        console.log(`[Hello] Mobile socket stored, desktop exists: ${!!session.desktopSocket}`);
        if (isOpen(session.desktopSocket)) {
          try {
            session.desktopSocket.send(JSON.stringify({ type: "peer", payload: { event: "mobile-online" } }));
          } catch {}
          try {
            ws.send(JSON.stringify({ type: "peer", payload: { event: "desktop-online", plan: session.plan || "basic" } }));
          } catch {}
        } else {
          try {
            ws.send(JSON.stringify({ type: "peer", payload: { event: "desktop-offline" } }));
          } catch {}
        }
        return;
      }

      return;
    }

    const desktop = session.desktopSocket;
    const mobile = session.mobileSocket;

    if (msg.type === "signal") {
      const target = msg.target === "desktop" ? desktop : mobile;
      if (!isOpen(target)) {
        console.log(`[Signal] Target ${msg.target} not open`);
        return;
      }
      try {
        target.send(JSON.stringify({ type: "signal", payload: msg.payload }));
      } catch {}
      return;
    }

    if (msg.type === "peer") {
      const target = msg.target === "desktop" ? desktop : mobile;
      if (!isOpen(target)) return;
      try {
        target.send(JSON.stringify({ type: "peer", payload: msg.payload }));
      } catch {}
      return;
    }

    // Handle command messages (e.g., disconnect)
    if (msg.type === "command") {
      const target = msg.target === "desktop" ? desktop : mobile;
      const fromRole = session.desktopSocket === ws ? "desktop" : "mobile";
      console.log(`[Command] From ${fromRole} to ${msg.target}, command: ${msg.command}`);
      if (!isOpen(target)) {
        console.log(`[Command] FAILED: Target socket not open`);
        return;
      }
      try {
        target.send(JSON.stringify({ type: "command", command: msg.command }));
        console.log(`[Command] SUCCESS: Relayed ${msg.command} to ${msg.target}`);
      } catch (e) {
        console.log(`[Command] ERROR: Failed to relay:`, e.message);
      }
      return;
    }
  });

  ws.on("close", () => {
    if (session.desktopSocket === ws) session.desktopSocket = null;
    if (session.mobileSocket === ws) session.mobileSocket = null;
  });
});

const port = Number.parseInt(process.env.PORT || "8080", 10) || 8080;

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Remote bridge server listening on port ${port}`);
});
