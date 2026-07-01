/**
 * Per-query RAG for Live voice: relevant context + images for the slideshow.
 *
 * Key design: each new user fragment REPLACES the previous accumulated text
 * so image retrieval stays focused on the current topic, not a growing blob
 * of every topic ever discussed in the session.
 */
import { retrieveContextAndImages } from "./geminiService.js";
import { getImageMetadata } from "./pdfService.js";


const pendingBySession = new Map();
const utteranceBySession = new Map();
const lastQueryBySession = new Map();
const LIVE_RAG_SILENCE_MS = 1000;
const LIVE_RAG_TIMEOUT_MS = 5000;

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}


function normalizeKey(str) {
  return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sourceBoost(query, entry) {
  const q = normalizeKey(query);
  if (!q) return 0;

  const pdfKey = normalizeKey(entry.pdf_name);   // e.g. "easysolar", "iotfiygateway"
  const topic = normalizeKey(entry.topic);

  if (!pdfKey) return 0;

  let score = 0;

  if (pdfKey === q) score += 200;                          // exact: "easy_solar" === "easysolar"
  else if (pdfKey.includes(q) || q.includes(pdfKey)) score += 150;  // partial: "iotfiy" inside "iotfiygateway"
  else {
    const qWords = tokenize(query);
    const hayWords = tokenize(`${entry.pdf_name || ""} ${entry.topic || ""}`);
    const overlap = qWords.filter((w) => hayWords.includes(w)).length;
    if (overlap > 0) score += overlap * 30;
  }

  return score;
}


function localImagesForQuery(query, limit = 8) {
  const entries = getImageMetadata();
  if (!Array.isArray(entries) || !entries.length || !query?.trim()) return [];

  const scored = [];

  for (const entry of entries) {
    const score = sourceBoost(query, entry);

    if (score > 50) {
      const imagePath = String(entry.image_path || "").replace(/^[/\\]+/, "");
      if (!imagePath) continue;
      scored.push({
        score,
        image: {
          topic: entry.topic || "",
          image_path: imagePath,
          url: `/${imagePath}`,
          page_number: entry.page_number || null,
          pdf_name: entry.pdf_name || "",
          alt: entry.topic || "Related image",
        },
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const unique = [];
  const seen = new Set();
  for (const { image } of scored) {
    if (seen.has(image.image_path)) continue;
    seen.add(image.image_path);
    unique.push(image);
    if (unique.length >= limit) break;
  }

  console.log(`🔍 LOCAL SEARCH: Query = "${query}" | Found ${unique.length} images`);
  return unique;
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Live RAG image search timed out")), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Detect which PDF source (mushaba vs nucleus) the query is about.
 * Returns a focused search prefix to improve RAG accuracy.
 */
function detectQueryFocus(text) {
  const lower = text.toLowerCase();
  const stripped = lower.replace(/\s+/g, "");

  if (/mushaba|moshaba|mashaba/.test(lower) || /mushaba/.test(stripped)) {
    return "mushaba";
  }
  if (/iotfiy\s*solutions|solutions\s*document|iotfiy\s*document|about\s*iotfiy/i.test(lower) ||
    /iotfiysolutions|solutionsdocument|iotfiydocument|aboutiotfiy/.test(stripped)) {
    return "iotfiy_solutions";
  }
  if (/nucleus|vivanco|distribution|cable|vericom|data\s*center/i.test(lower) ||
    /nucleus|distribution/.test(stripped)) {
    return "nucleus";
  }
  return null;
}

function debounceRag(sessionId, fn, delayMs = 700) {
  const prev = pendingBySession.get(sessionId);
  if (prev) clearTimeout(prev);

  if (delayMs <= 0) {
    pendingBySession.delete(sessionId);
    fn();
    return;
  }

  const timer = setTimeout(() => {
    pendingBySession.delete(sessionId);
    fn();
  }, delayMs);

  pendingBySession.set(sessionId, timer);
}

/**
 * Run RAG for a user utterance; returns related images and optional context snippet.
 *
 * Unlike previous versions, this uses only the LATEST user query text
 * (replaced, not accumulated) so images match the current topic.
 */
const GREETING_OR_GENERIC = /^(hello|hi|hey|salam|assalam|ok|okay|yes|no|thanks|thank you)\b/i;
export function enrichQueryForLive(
  sessionId,
  query,
  { onImages }
) {
  if (!query || query.trim().length < 2) return;

  const trimmed = query.trim();

  if (GREETING_OR_GENERIC.test(trimmed) && trimmed.length < 20) {
    console.log(`⏭️  Skipping image search for greeting/generic: "${trimmed}"`);
    return;
  }

  const instantImages = localImagesForQuery(trimmed, 8);
  if (instantImages.length) {
    console.log(`Images [LOCAL] Found ${instantImages.length} immediate image(s) for: "${trimmed.slice(0, 80)}"`);
    onImages?.(instantImages);
    return;
  }

  const focus = detectQueryFocus(trimmed);

  // If the user switched topics, reset the accumulated text
  const prevFocus = lastQueryBySession.get(sessionId);
  if (focus && prevFocus && focus !== prevFocus) {
    // Topic changed — start fresh with just the new query
    utteranceBySession.set(sessionId, { text: trimmed });
  } else {
    // Same topic or no clear topic — append within a short window
    const prev = utteranceBySession.get(sessionId) || { text: "" };
    const combined = `${prev.text || ""} ${trimmed}`.replace(/\s+/g, " ").trim();
    // Keep only the last ~200 chars to prevent stale context
    const capped = combined.length > 200 ? combined.slice(-200).trim() : combined;
    utteranceBySession.set(sessionId, { text: capped });
  }

  if (focus) {
    lastQueryBySession.set(sessionId, focus);
  }
  
  debounceRag(sessionId, async () => {
    const utterance = utteranceBySession.get(sessionId);
    if (!utterance?.text) return;

    try {
      console.log(`🖼️  [RAG] Searching images for: "${utterance.text.slice(0, 80)}"`);

      const result = await withTimeout(
        retrieveContextAndImages(utterance.text),
        8000
        // LIVE_RAG_TIMEOUT_MS
      );

      // FIXED: Proper destructuring with default values
      const { context = "", imageUrls = [], relatedImages = [] } = result || {};

      const payload = relatedImages?.length ? relatedImages : imageUrls;

      if (payload?.length) {
        console.log(`🖼️  [RAG] Found ${payload.length} images`);
        onImages?.(payload);
      } else {
        console.log(`🖼️  [RAG] No images found for topic.`);
      }
    } catch (err) {
      console.error("Live RAG error:", err.message);
    } finally {
      utteranceBySession.delete(sessionId);
    }
  }, LIVE_RAG_SILENCE_MS);
}

export function clearLiveRagSession(sessionId) {
  const prev = pendingBySession.get(sessionId);
  if (prev) clearTimeout(prev);
  pendingBySession.delete(sessionId);
  utteranceBySession.delete(sessionId);
  lastQueryBySession.delete(sessionId);
}
