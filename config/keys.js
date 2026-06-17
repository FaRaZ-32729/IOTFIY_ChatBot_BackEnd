import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const required = [
  "MONGODB_URI",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
];

const dataDir = path.join(process.cwd(), "data");
let defaultPdfPaths = [];
try {
  if (fs.existsSync(dataDir)) {
    defaultPdfPaths = fs.readdirSync(dataDir)
      .filter(file => file.toLowerCase().endsWith(".pdf"))
      .map(file => `./data/${file}`);
  }
} catch (err) {
  console.warn("Could not read data directory for PDFs", err);
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parsePdfPathList(value) {
  if (!value || typeof value !== "string") return [];
  return value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

let _cached = null;

export function getConfig() {
  if (_cached) return _cached;

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}\n` +
        "Copy .env.example → .env and fill in the values."
    );
  }

  _cached = {
    PORT: process.env.PORT || 5000,
    NODE_ENV: process.env.NODE_ENV || "development",
    FRONTEND_URL: process.env.FRONTEND_URL || "http://localhost:5174",
    PUBLIC_BASE_URL:
      process.env.PUBLIC_BASE_URL ||
      process.env.BACKEND_URL ||
      `http://localhost:${process.env.PORT || 5000}`,
    MONGODB_URI: process.env.MONGODB_URI,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_CHAT_MODEL:
      process.env.GEMINI_CHAT_MODEL ||
      process.env.GEMINI_MODEL ||
      "gemini-2.5-flash",
    GEMINI_CHAT_API_VERSION:
      process.env.GEMINI_CHAT_API_VERSION ||
      process.env.GEMINI_API_VERSION ||
      "v1beta",
    GEMINI_TRANSCRIBE_MODEL:
      process.env.GEMINI_TRANSCRIBE_MODEL ||
      process.env.GEMINI_CHAT_MODEL ||
      process.env.GEMINI_MODEL ||
      "gemini-2.5-flash",
    GEMINI_TRANSCRIBE_FALLBACK_MODEL:
      process.env.GEMINI_TRANSCRIBE_FALLBACK_MODEL || "",
    GEMINI_TRANSCRIBE_API_VERSION:
      process.env.GEMINI_TRANSCRIBE_API_VERSION ||
      process.env.GEMINI_CHAT_API_VERSION ||
      process.env.GEMINI_API_VERSION ||
      "v1beta",
    GEMINI_API_VERSION: process.env.GEMINI_API_VERSION || "v1beta",
    GEMINI_API_BASE_URL: process.env.GEMINI_API_BASE_URL || "",
    GEMINI_MAX_OUTPUT_TOKENS: toPositiveInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 4096),
    GEMINI_RAG_TOP_K: toPositiveInt(process.env.GEMINI_RAG_TOP_K, 2),
    GEMINI_LIVE_MODEL:
      process.env.GEMINI_LIVE_MODEL ||
      "gemini-3.1-flash-live-preview",
    ENABLE_TTS: process.env.ENABLE_TTS !== "false",
    TTS_TIMEOUT_MS: toPositiveInt(process.env.TTS_TIMEOUT_MS, 3500),
    PDF_PATHS: (() => {
      if (process.env.PDF_PATHS) {
        return parsePdfPathList(process.env.PDF_PATHS);
      }

      if (process.env.PDF_PATH) {
        const paths = parsePdfPathList(process.env.PDF_PATH);
        for (const fallback of defaultPdfPaths) {
          if (!paths.includes(fallback)) paths.push(fallback);
        }
        return paths;
      }

      return [...defaultPdfPaths];
    })(),
  };

  return _cached;
}
