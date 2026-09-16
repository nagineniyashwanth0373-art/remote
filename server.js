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
      .from("users")
      .select("id, email, plan, session_verifier, verifier, responses_remaining, responses_used, seconds_remaining, seconds_used, updated_at, created_at")
      .eq("email", emailLower)
      .maybeSingle();

    if (error) {
      console.error(`[Verifier] Fetch error: ${error.message}`);
      // Fallback query without session_verifier if column doesn't exist yet
      if (error.message && error.message.includes("session_verifier")) {
        const { data: fbData, error: fbError } = await supabase
          .from("users")
          .select("id, email, plan, verifier, responses_remaining, responses_used, seconds_remaining, seconds_used, updated_at, created_at")
          .eq("email", emailLower)
          .maybeSingle();
        if (!fbError && fbData) {
          return {
            ...fbData,
            session_verifier: fbData.verifier || false,
            verifier: fbData.verifier || false
          };
        }
      }
      return null;
    }

    if (data) {
      return {
        ...data,
        session_verifier: data.session_verifier !== undefined ? data.session_verifier : (data.verifier || false),
        verifier: data.session_verifier !== undefined ? data.session_verifier : (data.verifier || false)
      };
    }

    // Fallback: If user missing but exists in Auth, create user record in public.users
    console.log(`[Verifier] User missing for ${emailLower}, checking Auth...`);
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

    console.log(`[Verifier] Found user in Auth (ID: ${user.id}), creating user record...`);
    const newUser = {
      id: user.id,
      email: emailLower,
      plan: "basic",
      session_verifier: false,
      verifier: false,
      responses_remaining: 0,
      responses_used: 0,
      seconds_remaining: 0,
      seconds_used: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { error: insertError } = await supabase
      .from("users")
      .insert([newUser]);

    if (insertError) {
      console.error(`[Verifier] User creation failed: ${insertError.message}`);
      return null;
    }

    return {
      id: user.id,
      email: emailLower,
      plan: "basic",
      session_verifier: false,
      verifier: false,
      responses_remaining: 0,
      responses_used: 0,
      seconds_remaining: 0,
      seconds_used: 0
    };
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
      .from("users")
      .update({ session_verifier: status, verifier: status, updated_at: new Date().toISOString() })
      .eq("email", emailLower);
      
    if (error) {
      console.error(`[Verifier] Update failed: ${error.message}`);
      // Fallback if session_verifier doesn't exist yet
      if (error.message && error.message.includes("session_verifier")) {
        const { error: fbErr } = await supabase
          .from("users")
          .update({ verifier: status, updated_at: new Date().toISOString() })
          .eq("email", emailLower);
        if (!fbErr) return true;
      }
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

const TICK_INTERVAL_MS = 5000;
setInterval(async () => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    const desktopConnected = isOpen(session.desktopSocket);
    const mobileConnected = isOpen(session.mobileSocket);

    // Meter active connection time when desktop and mobile are actively connected
    if (desktopConnected && mobileConnected && supabase) {
      const email = session.email || (linkStates.get(token) && linkStates.get(token).email);
      if (email) {
        try {
          const { data: user, error } = await supabase
            .from("users")
            .select("plan, seconds_remaining, seconds_used")
            .eq("email", email.toLowerCase())
            .maybeSingle();

          if (!error && user) {
            // Lifetime BYOK plan has unlimited connection time
            if (user.plan === "pro plus+") {
              continue;
            }

            const currentSeconds = user.seconds_remaining ?? 0;
            if (currentSeconds <= 0) {
              console.log(`[Usage] Connection time exhausted for ${email}. Terminating.`);
              const expiredMsg = JSON.stringify({
                type: "peer",
                payload: { event: "time-expired", message: "Connection time finished. Please recharge your balance." }
              });
              if (isOpen(session.mobileSocket)) {
                try {
                  session.mobileSocket.send(expiredMsg);
                  session.mobileSocket.close(4402, "time-expired");
                } catch {}
              }
              if (isOpen(session.desktopSocket)) {
                try {
                  session.desktopSocket.send(expiredMsg);
                  session.desktopSocket.close(4402, "time-expired");
                } catch {}
              }
              sessions.delete(token);
              continue;
            }

            // Deduct 5 seconds
            const elapsed = Math.round(TICK_INTERVAL_MS / 1000);
            const newRemaining = Math.max(0, currentSeconds - elapsed);
            const newUsed = (user.seconds_used ?? 0) + elapsed;

            await supabase
              .from("users")
              .update({
                seconds_remaining: newRemaining,
                seconds_used: newUsed,
                updated_at: new Date().toISOString()
              })
              .eq("email", email.toLowerCase());

            // Broadcast tick update to sockets
            const tickMsg = JSON.stringify({
              type: "peer",
              payload: { event: "usage-tick", seconds_remaining: newRemaining }
            });
            if (isOpen(session.desktopSocket)) {
              try { session.desktopSocket.send(tickMsg); } catch {}
            }
            if (isOpen(session.mobileSocket)) {
              try { session.mobileSocket.send(tickMsg); } catch {}
            }

            if (newRemaining <= 0) {
              console.log(`[Usage] Connection time reached 0 for ${email}. Terminating.`);
              const expiredMsg = JSON.stringify({
                type: "peer",
                payload: { event: "time-expired", message: "Connection time finished. Please recharge your balance." }
              });
              if (isOpen(session.mobileSocket)) {
                try {
                  session.mobileSocket.send(expiredMsg);
                  session.mobileSocket.close(4402, "time-expired");
                } catch {}
              }
              if (isOpen(session.desktopSocket)) {
                try {
                  session.desktopSocket.send(expiredMsg);
                  session.desktopSocket.close(4402, "time-expired");
                } catch {}
              }
              sessions.delete(token);
              continue;
            }
          }
        } catch (err) {
          console.error("[Usage] Connection time tick error:", err.message);
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
}, TICK_INTERVAL_MS).unref();

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

// Dedicated Desktop Controller (Chrome Remote Desktop & AnyDesk native controls)
app.get("/d/", (req, res) => {
  res.sendFile(path.join(publicDir, "desktop", "index.html"));
});

app.use("/d/", express.static(path.join(publicDir, "desktop"), { index: false }));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/ice-servers", (req, res) => {
  res.json({
    ok: true,
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:openrelay.metered.ca:80" },
      {
        urls: [
          "turn:openrelay.metered.ca:80",
          "turn:openrelay.metered.ca:443",
          "turn:openrelay.metered.ca:443?transport=tcp",
          "turns:openrelay.metered.ca:443?transport=tcp"
        ],
        username: "openrelayproject",
        credential: "openrelayproject"
      }
    ]
  });
});

// Direct Email Login Endpoint
app.post("/api/auth/login-email", async (req, res) => {
  const body = req.body || {};
  const emailRaw = typeof body.email === "string" ? body.email : "";
  const force = Boolean(body.force);
  const email = emailRaw.trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ ok: false, error: "invalid-email", message: "Please provide a valid email address." });
  }

  const user = await fetchProfileByEmail(email);
  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "user-not-found",
      message: "No account found for this email. Please register on the website first."
    });
  }

  // If session_verifier is already true, block concurrent login unless forced
  const isAlreadyLoggedIn = user.session_verifier === true || user.verifier === true;
  if (isAlreadyLoggedIn && !force) {
    return res.status(409).json({
      ok: false,
      error: "already-logged-in",
      message: "Account is already active on another session. Log out from the other device or force login.",
      canForce: true
    });
  }

  // If session_verifier is false (or force login requested): set session_verifier = true and log in
  await updateProfileVerifier(email, true);

  return res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      plan: user.plan || "basic",
      session_verifier: true,
      verifier: true,
      responses_remaining: user.responses_remaining ?? 0,
      responses_used: user.responses_used ?? 0,
      seconds_remaining: user.seconds_remaining ?? 0,
      seconds_used: user.seconds_used ?? 0,
    }
  });
});

// Logout endpoint
app.post("/api/auth/logout", async (req, res) => {
  const body = req.body || {};
  const emailRaw = typeof body.email === "string" ? body.email : "";
  const email = emailRaw.trim().toLowerCase();
  if (email) {
    await updateProfileVerifier(email, false);
    for (const [t, data] of linkStates.entries()) {
      if (data.email && data.email.toLowerCase() === email) {
        linkStates.delete(t);
      }
    }
  }
  res.json({ ok: true });
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
    session_verifier: profile.session_verifier !== undefined ? profile.session_verifier : Boolean(profile.verifier),
    verifier: profile.session_verifier !== undefined ? profile.session_verifier : Boolean(profile.verifier),
    responses_remaining: profile.responses_remaining ?? 0,
    responses_used: profile.responses_used ?? 0,
    seconds_remaining: profile.seconds_remaining ?? 0,
    seconds_used: profile.seconds_used ?? 0
  });
});

// Catalog of plans defined in public.plans
const AVAILABLE_PLANS = [
  {
    id: "ee803f63-7ffc-4c93-bd79-2cb349c318b1",
    tier: "basic",
    name: "Basic Free Tier",
    price: 0,
    included_minutes: 0,
    included_responses: 0,
    dodo_product_id: null
  },
  {
    id: "4d569314-3b27-45c8-93ad-3d5c2eebffc0",
    tier: "usage",
    name: "Standard Plan",
    price: 8,
    included_minutes: 200,
    included_responses: 500,
    dodo_product_id: "pdt_0NnIPft32K3WxEEJbH04J"
  },
  {
    id: "fdbc4259-cdb8-42b8-a0d5-02b8a7392812",
    tier: "usage",
    name: "Pro+ Pro (Most Popular)",
    price: 15,
    included_minutes: 500,
    included_responses: 1000,
    dodo_product_id: "pdt_0NnIQ5VyQfhSXYsFLcojZ"
  },
  {
    id: "867a98bf-9dd0-4b22-bbf5-86d19193632e",
    tier: "usage",
    name: "Max+ Pro",
    price: 25,
    included_minutes: 1000,
    included_responses: 2000,
    dodo_product_id: "pdt_0NnIQFN75jtyT7fIvHQd1"
  },
  {
    id: "08545cec-6a37-4922-8456-54481379e290",
    tier: "usage",
    name: "Ultra+ Pro",
    price: 35,
    included_minutes: 2000,
    included_responses: 3000,
    dodo_product_id: "pdt_0NnIQOPYDlQBXyoHj0Mxv"
  },
  {
    id: "13969aad-7309-40ec-9b54-70b39d5b13f6",
    tier: "pro plus+",
    name: "Pro Plus+ Lifetime (BYOK)",
    price: 49,
    included_minutes: 0,
    included_responses: 0,
    dodo_product_id: "pdt_0NnIQqc0EzhEoVKHtBWTx"
  }
];

app.get("/api/plans", async (req, res) => {
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from("plans")
        .select("id, tier, name, price, included_minutes, included_responses, dodo_product_id")
        .order("price", { ascending: true });
      if (!error && data && data.length > 0) {
        return res.json({ ok: true, plans: data });
      }
    }
    res.json({ ok: true, plans: AVAILABLE_PLANS });
  } catch (err) {
    res.json({ ok: true, plans: AVAILABLE_PLANS });
  }
});

// Dodo Payments Webhook Endpoint to credit purchases directly to user's usage balance
app.post("/api/webhook/dodo", async (req, res) => {
  const event = req.body || {};
  console.log("[Dodo Webhook] Event received:", event.type || event.event || "unknown");

  try {
    const data = event.data || event;
    const customerEmail = (data.customer && data.customer.email) || data.email || (data.metadata && data.metadata.email);
    const productId = data.product_id || (data.product && data.product.id) || data.dodo_product_id;

    if (!customerEmail || !productId) {
      return res.status(200).json({ ok: true, message: "No email or product_id found in event" });
    }

    const email = String(customerEmail).trim().toLowerCase();

    // Query plan by dodo_product_id
    let plan = null;
    if (supabase) {
      const { data: dbPlan } = await supabase
        .from("plans")
        .select("id, tier, name, price, included_minutes, included_responses, dodo_product_id")
        .eq("dodo_product_id", productId)
        .maybeSingle();
      plan = dbPlan;
    }
    if (!plan) {
      plan = AVAILABLE_PLANS.find(p => p.dodo_product_id === productId);
    }

    if (!plan) {
      console.warn(`[Dodo Webhook] No matching plan found for product: ${productId}`);
      return res.status(200).json({ ok: true, message: "Unrecognized product ID" });
    }

    let user = await fetchProfileByEmail(email);
    if (!user && supabase) {
      console.warn(`[Dodo Webhook] User ${email} not yet registered in database.`);
      return res.status(200).json({ ok: true, message: "User not found" });
    }

    if (user && supabase) {
      const isLifetime = plan.tier === "pro plus+";
      const addSeconds = (plan.included_minutes || 0) * 60;
      const addResponses = plan.included_responses || 0;

      const updateFields = {
        plan: plan.tier,
        updated_at: new Date().toISOString()
      };

      if (!isLifetime) {
        updateFields.seconds_remaining = (user.seconds_remaining || 0) + addSeconds;
        updateFields.responses_remaining = (user.responses_remaining || 0) + addResponses;
      }

      const { error: updateErr } = await supabase
        .from("users")
        .update(updateFields)
        .eq("email", email);

      if (updateErr) {
        console.error(`[Dodo Webhook] Error updating user ${email}:`, updateErr.message);
      } else {
        console.log(`[Dodo Webhook] Successfully credited plan '${plan.name}' to ${email}`);
      }
    }

    return res.json({ ok: true, credited: true });
  } catch (err) {
    console.error("[Dodo Webhook] Error processing event:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
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
    
    // Check if user has responses remaining or is on BYOK plan
    let userEmail = await getEmailFromAuthHeader(req);
    if (!userEmail && req.body && req.body.email) {
      userEmail = String(req.body.email).trim().toLowerCase();
    }
    let userRecord = null;
    if (userEmail && supabase) {
      userRecord = await fetchProfileByEmail(userEmail);
    }
    const customOpenAiKey = req.headers["x-openai-key"] || (req.body && req.body.openaiKey) || null;
    const isByokPlan = userRecord && userRecord.plan === "pro plus+";

    if (!customOpenAiKey && userRecord && !isByokPlan && (userRecord.responses_remaining ?? 0) <= 0) {
      res.status(403).json({
        text: finalText,
        error: "insufficient-responses",
        answer: "You have 0 AI responses remaining. Please recharge your usage balance."
      });
      return;
    }

    // Check if OpenAI API key is configured or provided
    const activeApiKey = customOpenAiKey || process.env.OPENAI_API_KEY;
    if (!activeApiKey) {
      console.log("[Snap] OpenAI API key not configured, returning text only");
      res.json({
        text: finalText,
        answer: isByokPlan 
          ? "Pro Plus+ Lifetime (BYOK) plan: Please provide your OpenAI API key."
          : "OpenAI API key not configured. Add OPENAI_API_KEY environment variable for AI analysis."
      });
      return;
    }

    const aiClient = customOpenAiKey ? new OpenAI({ apiKey: customOpenAiKey }) : openai;
    
    // Send to OpenAI for analysis with improved prompt
    console.log("[Snap] Sending to OpenAI...");
    const completion = await aiClient.chat.completions.create({
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
    
    // Deduct 1 response for standard usage users
    if (userRecord && supabase && !isByokPlan && !customOpenAiKey) {
      const newRemaining = Math.max(0, (userRecord.responses_remaining || 0) - 1);
      const newUsed = (userRecord.responses_used || 0) + 1;
      await supabase
        .from("users")
        .update({
          responses_remaining: newRemaining,
          responses_used: newUsed,
          updated_at: new Date().toISOString()
        })
        .eq("email", userRecord.email);
      userRecord.responses_remaining = newRemaining;
    }

    res.json({
      text: finalText,
      answer: aiAnswer,
      responses_remaining: userRecord ? userRecord.responses_remaining : null
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

  // Usage Model: Verify user has AI responses remaining
  let userEmail = "";
  if (token && typeof token === "string") {
    const session = sessions.get(token);
    const linkState = linkStates.get(token);
    if (linkState && linkState.email) userEmail = linkState.email;
    if (!userEmail && session && session.email) userEmail = session.email;
  }
  if (!userEmail) {
    userEmail = await getEmailFromAuthHeader(req);
  }
  if (!userEmail && req.body && req.body.email) {
    userEmail = String(req.body.email).trim().toLowerCase();
  }

  let userRecord = null;
  if (userEmail && supabase) {
    userRecord = await fetchProfileByEmail(userEmail);
  }

  const session = (token && typeof token === "string") ? sessions.get(token) : null;
  const customOpenAiKey = req.headers["x-openai-key"] || (req.body && req.body.openaiKey) || (session && session.openaiKey) || null;
  const isByokPlan = (userRecord && userRecord.plan === "pro plus+") || (session && session.plan === "pro plus+");

  if (userRecord && !isByokPlan && !customOpenAiKey) {
    const remaining = userRecord.responses_remaining ?? 0;
    if (remaining <= 0) {
      console.warn(`[Analyze-Screen] 403 Blocked: 0 AI responses remaining for ${userEmail}`);
      return res.status(403).json({
        ok: false,
        error: "insufficient-responses",
        message: "You have 0 AI responses remaining. Please recharge your usage balance to continue."
      });
    }
  }

  // Check if OpenAI API key is configured or provided
  const activeApiKey = customOpenAiKey || process.env.OPENAI_API_KEY;
  if (!activeApiKey) {
    return res.status(403).json({
      ok: false,
      error: isByokPlan ? "byok-key-required" : "missing-api-key",
      message: isByokPlan
        ? "Pro Plus+ Lifetime (BYOK) plan: Please configure your OpenAI API key."
        : "OpenAI API key not configured on server."
    });
  }

  const aiClient = customOpenAiKey ? new OpenAI({ apiKey: customOpenAiKey }) : openai;

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
    const extractionResponse = await aiClient.chat.completions.create({
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
        const solverResponse = await aiClient.chat.completions.create({
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
        const fallbackResponse = await aiClient.chat.completions.create({
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
      const codeResponse = await aiClient.chat.completions.create({
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
      const generalResponse = await aiClient.chat.completions.create({
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

    // Deduct 1 response only for standard usage users (not BYOK / custom key)
    if (userRecord && supabase && !isByokPlan && !customOpenAiKey) {
      const newRemaining = Math.max(0, (userRecord.responses_remaining || 0) - 1);
      const newUsed = (userRecord.responses_used || 0) + 1;
      await supabase
        .from("users")
        .update({
          responses_remaining: newRemaining,
          responses_used: newUsed,
          updated_at: new Date().toISOString()
        })
        .eq("email", userRecord.email);
      userRecord.responses_remaining = newRemaining;
    }

    res.json({
      ok: true,
      answer: aiAnswer,
      type: contentType,
      responses_remaining: userRecord ? userRecord.responses_remaining : null
    });
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
      if (msg.email && typeof msg.email === "string") {
        session.email = msg.email.trim().toLowerCase();
      }
      const linkState = linkStates.get(token);
      if (!session.email && linkState && linkState.email) {
        session.email = linkState.email.trim().toLowerCase();
      }

      // Check if user has connection time remaining (exempt pro plus+ lifetime)
      if (session.email && supabase) {
        (async () => {
          try {
            const { data: u } = await supabase.from("users").select("plan, seconds_remaining").eq("email", session.email).maybeSingle();
            if (u && u.plan !== "pro plus+" && (u.seconds_remaining ?? 0) <= 0) {
              console.log(`[Hello] User ${session.email} has 0 seconds remaining. Closing.`);
              try {
                ws.send(JSON.stringify({
                  type: "peer",
                  payload: { event: "time-expired", message: "No connection time remaining. Please recharge your balance." }
                }));
                ws.close(4402, "no-seconds-remaining");
              } catch {}
            }
          } catch {}
        })();
      }

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
        if (msg.openaiKey && typeof msg.openaiKey === "string") {
          session.openaiKey = msg.openaiKey.trim();
        }
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
