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

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt > now) continue;
    
    // Don't expire if either socket is still connected
    const desktopConnected = isOpen(session.desktopSocket);
    const mobileConnected = isOpen(session.mobileSocket);
    
    if (desktopConnected || mobileConnected) {
      // Extend session if still active
      session.expiresAt = now + SESSION_TTL_MS;
      console.log(`[Session] Extended session for token ${token.substring(0, 8)}...`);
      continue;
    }
    
    // Only delete if both are disconnected
    sessions.delete(token);
    console.log(`[Session] Deleted expired session for token ${token.substring(0, 8)}...`);
  }
}).unref();

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://helvia.in");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));
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
  if (!info) {
    res.json({ ok: true, linked: false });
    return;
  }
  res.json({ ok: true, linked: true, email: info.email, plan: info.plan || "" });
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
  
  if (!supabase) {
    res.status(500).json({ ok: false, error: "server-config-error" });
    return;
  }
  
  try {
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

// Screen Analysis Endpoint (Vision)
app.post("/api/analyze-screen", async (req, res) => {
  const { image, prompt } = req.body || {};

  if (!image || typeof image !== "string") {
    return res.status(400).json({ ok: false, error: "missing-image" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "OpenAI API key not configured on server (please set OPENAI_API_KEY in Railway)."
    });
  }

  try {
    console.log("[Analyze-Screen] Processing screen vision...");
    const base64Data = image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
    const userPrompt = prompt && typeof prompt === "string" && prompt.trim().length > 0
      ? prompt.trim()
      : `Carefully examine the question and all multiple-choice options in the screenshot.
Follow this procedure:
1. Solve the question step-by-step internally to find the exact correct value or answer.
2. Match your solved result to the corresponding multiple-choice option (A, B, C, or D).
3. Output ONLY the matched option and a 1-2 sentence explanation.

Format:
🎯 **Option [Letter]: [Exact Option Value/Text]**

💡 **Explanation:** [1-2 sentences showing the quick formula/calculation or reason]`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an expert exam solver. You MUST calculate and verify the correct answer mathematically/logically before picking the option. Always match your final calculated result to the exact option letter (A, B, C, D) visible on screen. Do not output multiple contradictory numbers. Output ONLY the final correct option and a brief explanation."
        },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            {
              type: "image_url",
              image_url: {
                url: base64Data,
                detail: "high"
              }
            }
          ]
        }
      ],
      max_tokens: 250,
      temperature: 0.0,
    });

    const aiAnswer = completion.choices[0]?.message?.content?.trim() || "No answer generated.";
    console.log("[Analyze-Screen] AI response received:", aiAnswer.substring(0, 100));
    res.json({ ok: true, answer: aiAnswer });
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
        console.log(`[Hello] Desktop socket stored, mobile exists: ${!!session.mobileSocket}`);
        if (isOpen(session.mobileSocket)) {
          try {
            session.mobileSocket.send(JSON.stringify({ type: "peer", payload: { event: "desktop-online" } }));
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
            ws.send(JSON.stringify({ type: "peer", payload: { event: "desktop-online" } }));
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
