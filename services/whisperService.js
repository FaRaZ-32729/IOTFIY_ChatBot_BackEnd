/**
 * Whisper Service -> Gemini Audio Transcription Service
 * ─────────────────────────────────────────────
 * Sends audio buffers to Google Gemini API (bypassing OpenAI
 * because of insufficient quota) and returns transcribed text.
 */
import fs from "fs";
import { getConfig } from "../config/keys.js";

/**
 * Transcribe an audio file using Google Gemini.
 *
 * @param {string} filePath — absolute path to the audio file on disk
 * @param {string} mimeType — MIME type of the audio file (optional)
 * @returns {{ text: string, language: string }}
 */
export async function transcribeAudio(filePath, mimeType = "audio/webm") {
  const {
    GOOGLE_API_KEY,
    GEMINI_API_VERSION,
    GEMINI_API_BASE_URL,
    GEMINI_TRANSCRIBE_MODEL,
    GEMINI_CHAT_MODEL,
    GEMINI_TRANSCRIBE_FALLBACK_MODEL,
    GEMINI_TRANSCRIBE_API_VERSION,
  } = getConfig();

  const fileData = fs.readFileSync(filePath);
  const base64Audio = fileData.toString("base64");
  const normalizedMime = (mimeType || "audio/webm").split(";")[0].trim() || "audio/webm";

  const baseUrl = (GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com")
    .replace(/\/+$/g, "");
  const primaryVersion = GEMINI_TRANSCRIBE_API_VERSION || GEMINI_API_VERSION || "v1";
  const primaryModel = GEMINI_TRANSCRIBE_MODEL || GEMINI_CHAT_MODEL || "gemini-2.5-flash";

  const attempts = buildTranscriptionAttempts(
    primaryVersion,
    primaryModel,
    GEMINI_TRANSCRIBE_FALLBACK_MODEL
  );

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const data = await requestTranscription(
        baseUrl,
        attempt.apiVersion,
        attempt.modelName,
        GOOGLE_API_KEY,
        base64Audio,
        normalizedMime
      );
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return finalizeTranscription(text);
    } catch (err) {
      lastError = err;
      if (!isModelAvailabilityError(err)) {
        throw err;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  return finalizeTranscription("");
}

function normalizeModelName(value) {
  return (value || "").replace(/^models\//, "").trim();
}

function buildTranscriptionAttempts(primaryVersion, primaryModel, fallbackModel) {
  const attempts = [];
  const seen = new Set();

  const addAttempt = (apiVersion, modelName) => {
    const normalized = normalizeModelName(modelName);
    if (!normalized) return;
    const key = `${apiVersion}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ apiVersion, modelName: normalized });
  };

  const version = (primaryVersion || "v1").trim();
  const model = normalizeModelName(primaryModel || "gemini-2.5-flash");

  addAttempt(version, model);
  if (fallbackModel) {
    addAttempt(version, fallbackModel);
  }

  if (model && !model.endsWith("-latest")) {
    addAttempt("v1beta", `${model}-latest`);
  }

  addAttempt("v1beta", model);
  addAttempt("v1", model);

  return attempts;
}

function isModelAvailabilityError(err) {
  const message = (err?.message || "").toLowerCase();
  return (
    message.includes("not found for api version") ||
    message.includes("not supported for generatecontent") ||
    message.includes("model is not found")
  );
}

async function requestTranscription(baseUrl, apiVersion, modelName, apiKey, base64Audio, mimeType) {
  const url = `${baseUrl}/${apiVersion}/models/${modelName}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: "Transcribe the following audio accurately. If it is spoken in English, output English. If it is spoken in Urdu, output Urdu. Only output the exact transcription, no additional conversational text." },
          {
            inlineData: {
              mimeType: mimeType || "audio/webm",
              data: base64Audio
            }
          }
        ]
      }]
    })
  });

  let data = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    const text = await response.text();
    throw new Error(text || "Gemini transcription failed");
  }

  if (!response.ok || data?.error) {
    const message = data?.error?.message || `Gemini transcription failed (${response.status})`;
    throw new Error(message);
  }

  return data;
}

function finalizeTranscription(text) {
  const trimmed = (text || "").trim();
  const isUrdu = /[\u0600-\u06FF]/.test(trimmed);

  return {
    text: trimmed,
    language: isUrdu ? "ur" : "en",
  };
}
