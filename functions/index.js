const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const FormData = require("form-data");

initializeApp();
const db = getFirestore();

/**
 * TALKO AI Platform — Secure Proxy
 * 
 * Uses OpenAI Responses API (/v1/responses)
 * Client sends: { assistantId, messages, idToken }
 * Function loads prompt + API key from Firestore → calls OpenAI → returns reply
 * Client NEVER sees: API key, system prompt
 */
exports.chat = onRequest(
  {
    cors: true,
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 120,
    maxInstances: 20,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const { assistantId, messages, idToken } = req.body;

      // ── 1. Validate input ──
      if (!assistantId || !messages || !idToken) {
        return res.status(400).json({
          error: "Missing required fields: assistantId, messages, idToken",
        });
      }

      // ── 2. Verify Firebase Auth ──
      let uid;
      try {
        const decoded = await getAuth().verifyIdToken(idToken);
        uid = decoded.uid;
      } catch (authErr) {
        return res.status(401).json({ error: "Invalid auth token" });
      }

      // ── 3. Load API key from Firestore ──
      const configDoc = await db.collection("config").doc("openai").get();
      if (!configDoc.exists || !configDoc.data().apiKey) {
        return res.status(500).json({ error: "API key not configured" });
      }
      const openaiKey = configDoc.data().apiKey;

      // ── 4. Load assistant from Firestore ──
      const assistantDoc = await db.collection("assistants").doc(assistantId).get();
      if (!assistantDoc.exists) {
        return res.status(404).json({ error: "Assistant not found" });
      }
      const assistant = assistantDoc.data();

      // ── 5. Build input messages array ──
      const inputMsgs = [
        { role: "developer", content: assistant.prompt || "Ти — AI-асистент." },
      ];

      for (const m of messages) {
        inputMsgs.push({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content).slice(0, 10000),
        });
      }

      // ── 6. Call OpenAI Responses API ──
      const model = assistant.model || "gpt-5.2";

      const openaiBody = {
        model,
        input: inputMsgs,
        tools: [{ type: "web_search_preview" }],
      };

      const reasoningModels = /^(o1|o3|o4|gpt-5)/i;
      if (reasoningModels.test(model)) {
        openaiBody.reasoning = { effort: "none" };
      }

      const openaiRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify(openaiBody),
      });

      if (!openaiRes.ok) {
        const errData = await openaiRes.json().catch(() => ({}));
        console.error("OpenAI error:", openaiRes.status, errData);
        return res.status(502).json({
          error: "AI service error",
          detail: errData?.error?.message || `Status ${openaiRes.status}`,
        });
      }

      const data = await openaiRes.json();

      // ── 7. Extract reply from Responses API format ──
      let reply = "";
      if (data.output) {
        for (const item of data.output) {
          if (item.type === "message" && item.content) {
            for (const c of item.content) {
              if (c.type === "output_text") reply += c.text;
            }
          }
        }
      }

      if (!reply) {
        reply = data.error?.message || "No response";
      }

      return res.status(200).json({
        reply,
        model,
        usage: data.usage || null,
      });
    } catch (err) {
      console.error("Chat function error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * TALKO AI Platform — Whisper Transcription
 *
 * Client sends: multipart/form-data { audio: <webm/ogg blob>, idToken, lang? }
 * Function loads API key from Firestore → calls Whisper → returns { text }
 */
exports.transcribe = onRequest(
  {
    cors: {
      origin: true, // allow all origins (same as cors: true)
      allowedHeaders: ["content-type", "x-id-token", "x-lang"],
    },
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 20,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const idToken = req.headers["x-id-token"];
      if (!idToken) {
        return res.status(400).json({ error: "Missing x-id-token header" });
      }

      // ── 1. Verify Firebase Auth ──
      try {
        await getAuth().verifyIdToken(idToken);
      } catch {
        return res.status(401).json({ error: "Invalid auth token" });
      }

      // ── 2. Load API key ──
      const configDoc = await db.collection("config").doc("openai").get();
      if (!configDoc.exists || !configDoc.data().apiKey) {
        return res.status(500).json({ error: "API key not configured" });
      }
      const openaiKey = configDoc.data().apiKey;

      // ── 3. Get raw audio bytes from request ──
      // Firebase Functions v2 exposes rawBody as Buffer
      const audioBuffer = req.rawBody;
      if (!audioBuffer || audioBuffer.length === 0) {
        return res.status(400).json({ error: "Empty audio body" });
      }

      const lang = req.headers["x-lang"] || "uk"; // default Ukrainian
      const rawMime = req.headers["content-type"] || "audio/webm";
      // Strip codec params: "audio/webm;codecs=opus" → "audio/webm"
      const mimeType = rawMime.split(";")[0].trim();
      const ext = mimeType.includes("ogg") ? "ogg" : "webm";

      // ── 4. Build multipart form for Whisper ──
      const form = new FormData();
      form.append("file", audioBuffer, {
        filename: `audio.${ext}`,
        contentType: mimeType,
      });
      form.append("model", "whisper-1");
      form.append("language", lang);

      // ── 5. Call Whisper API ──
      const whisperRes = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            ...form.getHeaders(),
          },
          body: form.getBuffer(),
        }
      );

      if (!whisperRes.ok) {
        const errData = await whisperRes.json().catch(() => ({}));
        console.error("Whisper error:", whisperRes.status, errData);
        return res.status(502).json({
          error: "Whisper error",
          detail: errData?.error?.message || `Status ${whisperRes.status}`,
        });
      }

      const data = await whisperRes.json();
      return res.status(200).json({ text: data.text || "" });
    } catch (err) {
      console.error("Transcribe function error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * TTS — Text-to-Speech via OpenAI
 * Client sends: POST raw JSON { text, voice?, idToken }
 * Returns: audio/mpeg stream
 */
exports.tts = onRequest(
  {
    cors: {
      origin: true,
      allowedHeaders: ["content-type", "x-id-token"],
    },
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 20,
  },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const { text, voice = "nova", idToken } = req.body;
      if (!text || !idToken) return res.status(400).json({ error: "Missing text or idToken" });

      try { await getAuth().verifyIdToken(idToken); }
      catch { return res.status(401).json({ error: "Invalid auth token" }); }

      const configDoc = await db.collection("config").doc("openai").get();
      if (!configDoc.exists || !configDoc.data().apiKey)
        return res.status(500).json({ error: "API key not configured" });
      const openaiKey = configDoc.data().apiKey;

      // Truncate to 4096 chars (OpenAI TTS limit)
      const truncated = String(text).slice(0, 4096);

      const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: "tts-1", input: truncated, voice, response_format: "mp3" }),
      });

      if (!ttsRes.ok) {
        const err = await ttsRes.json().catch(() => ({}));
        return res.status(502).json({ error: "TTS error", detail: err?.error?.message || `Status ${ttsRes.status}` });
      }

      const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", audioBuffer.length);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(audioBuffer);
    } catch (err) {
      console.error("TTS error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * parseFile — extract text from PDF / DOCX / TXT
 * Client sends: raw binary body, headers: content-type, x-id-token, x-filename
 * Returns: { text, chars, truncated }
 */
exports.parseFile = onRequest(
  {
    cors: {
      origin: true,
      allowedHeaders: ["content-type", "x-id-token", "x-filename"],
    },
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 60,
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const idToken = req.headers["x-id-token"];
      if (!idToken) return res.status(400).json({ error: "Missing x-id-token" });

      try { await getAuth().verifyIdToken(idToken); }
      catch { return res.status(401).json({ error: "Invalid auth token" }); }

      const audioBuffer = req.rawBody;
      if (!audioBuffer || audioBuffer.length === 0)
        return res.status(400).json({ error: "Empty body" });
      if (audioBuffer.length > 20 * 1024 * 1024)
        return res.status(413).json({ error: "File too large (max 20MB)" });

      const filename = (req.headers["x-filename"] || "file.txt").toLowerCase();
      const mime = (req.headers["content-type"] || "").split(";")[0].trim();

      let text = "";

      if (filename.endsWith(".txt") || mime === "text/plain") {
        text = audioBuffer.toString("utf-8");
      } else if (filename.endsWith(".pdf") || mime === "application/pdf") {
        // Use OpenAI vision to extract text from PDF via base64
        // We'll use the Files API + GPT-4o for robust extraction
        const configDoc = await db.collection("config").doc("openai").get();
        const openaiKey = configDoc.data().apiKey;

        const base64 = audioBuffer.toString("base64");
        const extractRes = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
          body: JSON.stringify({
            model: "gpt-4o",
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_file",
                    filename: filename,
                    file_data: `data:application/pdf;base64,${base64}`,
                  },
                  { type: "input_text", text: "Extract ALL text from this document. Return only the raw text, no commentary, no markdown formatting." },
                ],
              },
            ],
          }),
        });
        if (extractRes.ok) {
          const data = await extractRes.json();
          for (const item of (data.output || [])) {
            if (item.type === "message") {
              for (const c of (item.content || [])) {
                if (c.type === "output_text") text += c.text;
              }
            }
          }
        } else {
          return res.status(502).json({ error: "PDF extraction failed" });
        }
      } else if (
        filename.endsWith(".docx") ||
        mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        // DOCX: extract text by parsing XML inside zip
        const JSZip = require("jszip");
        const zip = await JSZip.loadAsync(audioBuffer);
        const xmlFile = zip.file("word/document.xml");
        if (xmlFile) {
          const xml = await xmlFile.async("text");
          // Strip XML tags, normalize whitespace
          text = xml
            .replace(/<w:br[^>]*\/>/gi, "\n")
            .replace(/<w:p[ >][^>]*>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        }
      } else {
        // Fallback: try UTF-8
        text = audioBuffer.toString("utf-8");
      }

      const MAX_CHARS = 12000;
      const truncated = text.length > MAX_CHARS;
      const finalText = truncated ? text.slice(0, MAX_CHARS) : text;

      return res.status(200).json({ text: finalText, chars: finalText.length, truncated });
    } catch (err) {
      console.error("parseFile error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);
