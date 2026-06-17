/**
 * TTS Service -> Google Translate TTS (Free alternative)
 * ─────────────────────────────────────────────
 * Bypasses OpenAI due to insufficient quota and uses
 * Google Translate's unofficial TTS API.
 */
import * as googleTTS from "google-tts-api";

/**
 * Strip markdown syntax so TTS reads clean prose.
 */
function cleanTextForTTS(text) {
  return text
    .replace(/!\[.*?\]\(.*?\)/g, "")           // remove images
    .replace(/\[([^\]]+)\]\(.*?\)/g, "$1")      // links → text only
    .replace(/#{1,6}\s?/g, "")                  // headings
    .replace(/(\*{1,3}|_{1,3})/g, "")           // bold / italic
    .replace(/`{1,3}[^`]*`{1,3}/g, "")          // inline / block code
    .replace(/>\s?/g, "")                        // blockquotes
    .replace(/[-*+]\s/g, "")                     // list bullets
    .replace(/\n{2,}/g, ". ")                    // paragraph breaks → pause
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Generate spoken audio from text via Google TTS.
 *
 * @param {string} text — the Gemini response (markdown)
 * @returns {string} base64-encoded MP3 audio
 */
export async function generateSpeech(text) {
  const clean = cleanTextForTTS(text);

  if (!clean || clean.length < 2) {
    return null; // nothing meaningful to speak
  }

  /* Truncate to ~4000 chars (TTS limit safety) */
  const truncated = clean.length > 4000 ? clean.slice(0, 4000) + "..." : clean;

  const isUrdu = /[\u0600-\u06FF]/.test(truncated);
  const lang = isUrdu ? "ur" : "en";

  try {
    const results = await googleTTS.getAllAudioBase64(truncated, {
      lang: lang,
      slow: false,
      host: "https://translate.google.com",
      splitPunct: ",.?!:\n",
    });

    const buffers = results.map(r => Buffer.from(r.base64, "base64"));
    const combinedBuffer = Buffer.concat(buffers);
    return combinedBuffer.toString("base64");
  } catch (err) {
    console.warn("⚠️ Google TTS error:", err.message);
    return null;
  }
}
