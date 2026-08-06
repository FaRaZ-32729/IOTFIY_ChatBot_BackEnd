/**
 * Per-query RAG for Live voice: relevant context + images for the slideshow.
 *
 * Design:
 * - Gemini [[TOPIC: pdfId]] scopes which PDF's images to show (reliable).
 * - User question / assistant speech re-ranks pages INSIDE that PDF.
 * - When a specific page matches (e.g. "Hamza Aslam"), show only that page.
 * - Never mix images from other PDFs when a TOPIC filter is present.
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

/** Split CamelCase / snake_case so "MuhammadAmmadMalik" → ammad, malik (not substring of muhammad). */
function richTokenize(value) {
  return tokenize(
    String(value || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/[_\-/]+/g, " ")
  );
}


function normalizeKey(str) {
  return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Exact PDF-id match only (no substring bleed: iotfiy ≠ iotfiy_gateway).
 */
function matchesPdfFilter(entry, pdfFilter) {
  if (!pdfFilter) return true;
  const filterKey = normalizeKey(pdfFilter);
  const pdfKey = normalizeKey(entry.pdf_name);
  return Boolean(filterKey && pdfKey && pdfKey === filterKey);
}

function toImagePayload(entry) {
  const imagePath = String(entry.image_path || "").replace(/^[/\\]+/, "");
  if (!imagePath) return null;
  return {
    topic: entry.topic || "",
    image_path: imagePath,
    url: `/${imagePath}`,
    page_number: entry.page_number || null,
    pdf_name: entry.pdf_name || "",
    alt: entry.topic || "Related image",
  };
}

/**
 * All images belonging to one PDF, earliest pages first.
 */
function imagesForPdf(pdfFilter, limit = 8) {
  const entries = getImageMetadata();
  if (!Array.isArray(entries) || !entries.length || !pdfFilter) return [];

  const matched = entries
    .filter((entry) => matchesPdfFilter(entry, pdfFilter))
    .map((entry) => ({
      page: Number(entry.page_number) || 999,
      image: toImagePayload(entry),
    }))
    .filter((row) => row.image)
    .sort((a, b) => a.page - b.page);

  const unique = [];
  const seen = new Set();
  for (const { image } of matched) {
    if (seen.has(image.image_path)) continue;
    seen.add(image.image_path);
    unique.push(image);
    if (unique.length >= limit) break;
  }
  return unique;
}

/** Shared / weak tokens that alone must not pick multiple people (e.g. Malik). */
const WEAK_MATCH_TOKENS = new Set([
  "malik", "muhammad", "mohammad", "ahmed", "khan", "ali", "hassan", "hussain",
  "chief", "officer", "executive", "operating", "technology", "company",
  "team", "iotfiy", "solutions", "about", "with", "from", "our", "the",
  "app", "hai", "ke", "liye", "aur", "theek", "acha", "sawal", "batao",
]);

/** Urdu/English buffer phrases Gemini uses — strip before image token match. */
const SPEECH_FILLER_PATTERN =
  /\b(acha sawal hai|bilkul sahi|great question|sure thing|give me (?:a )?moment|happy to help|absolutely|of course|ek second|ji bilkul|theek hai|suniye|batata hoon|batati hoon|zaroor|good one|let me think|pull that up)\b/gi;

/** When Gemini picks the wrong [[TOPIC: ...]], remap using query content. */
const TOPIC_REMAP_RULES = [
  {
    from: "tour",
    when: /mushaba|moshaba|mashaba|hajj|umrah|pilgrim|haram|kaaba|makkah|madinah|pilgrimage/i,
    to: "mushaba",
  },
  {
    from: "mushaba_rag",
    when: /^(?!.*\brag\b).*mushaba|hajj|umrah|pilgrim/i,
    to: "mushaba",
  },
  {
    from: "iotfiy_gateway",
    when: /^(?!.*gateway).*iotfiy|about iotfiy|what does iotfiy|iotfiy products/i,
    to: "iotfiy",
  },
];

/** Gemini [[TOPIC: X]] values that must not be overridden by speech text heuristics. */
const PROTECTED_IMAGE_TOPICS = new Set([
  "iotfiyclients",
  "iotfiy_teams",
  "nucleus_teams",
  "vivanco_teams",
  "ai_knowledge_assistant",
  "iotfiy_gateway",
  "mushaba",
  "mushaba_rag",
  "nucleus_distribution",
  "nucleus_vericom",
  "polekit",
  "packtrack",
  "ac",
  "easy_solar",
  "epsn",
  "sales_hub",
  "services",
  "social_app",
  "studio",
  "ecosystem",
  "iotfiy",
]);

function stripSpeechFillers(text) {
  return String(text || "")
    .replace(SPEECH_FILLER_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** ASR / nickname variants → metadata tokens */
const TOKEN_ALIASES = {
  amjad: ["ammad"],
  ammad: ["amjad"],
  jawad: ["jawwad"],
  jawwad: ["jawad"],
  hamza: ["hamzah"],
  getz: ["getzpharma"],
  getzpharma: ["getz"],
  gamenest: ["arcade", "vending"],
  power2go: ["power"],
  kelectric: ["electric", "polekit"],
  pso: ["fume", "hood"],
  clients: ["client"],
  client: ["clients"],
};

function tokenVariants(token) {
  const t = String(token || "").toLowerCase();
  return [t, ...(TOKEN_ALIASES[t] || [])];
}

/**
 * Rank images inside a PDF by overlap with AI response text.
 * Distinctive name tokens (Ammad, Hamza, Jawwad) outweigh shared surnames (Malik).
 * Keeps only the best-scoring page set so one person ≠ whole team loop.
 */
function rankImagesInPdf(query, pdfFilter, limit = 8) {
  const entries = getImageMetadata();
  if (!Array.isArray(entries) || !entries.length || !query?.trim()) return [];

  const cleanedQuery = stripSpeechFillers(query);
  const qTokens = tokenize(cleanedQuery);
  if (qTokens.length < 1) return [];

  const filterKey = normalizeKey(pdfFilter);
  const scored = [];

  for (const entry of entries) {
    if (pdfFilter && !matchesPdfFilter(entry, pdfFilter)) continue;

    const topicKey = normalizeKey(entry.topic);
    const pathKey = normalizeKey(entry.image_path);
    const pdfKey = normalizeKey(entry.pdf_name);
    const hayTokens = new Set([
      ...richTokenize(entry.topic || ""),
      ...richTokenize(entry.pdf_name || ""),
      ...tokenize(String(entry.image_path || "").replace(/[_\-./\\]+/g, " ")),
    ]);

    let strongHits = 0;
    let weakHits = 0;

    for (const raw of qTokens) {
      const isPdfNameToken = raw === pdfKey || raw === filterKey;

      let matched = false;
      for (const t of tokenVariants(raw)) {
        if (hayTokens.has(t)) {
          matched = true;
          break;
        }
        if (t.length >= 4) {
          const cleanedPath = pathKey.replace(/muhammad/g, "").replace(/mohammad/g, "");
          const cleanedTopic = topicKey.replace(/muhammad/g, "").replace(/mohammad/g, "");
          if (cleanedPath.includes(t) || cleanedTopic.includes(t)) {
            matched = true;
            break;
          }
        }
      }
      if (!matched) continue;

      if (isPdfNameToken) {
        strongHits += 2;
      } else if (WEAK_MATCH_TOKENS.has(raw)) {
        weakHits += 1;
      } else {
        strongHits += 1;
      }
    }

    if (strongHits <= 0 && weakHits < 3) continue;

    const score = strongHits * 10 + weakHits;
    const image = toImagePayload(entry);
    if (!image) continue;
    scored.push({
      score,
      page: Number(entry.page_number) || 999,
      image,
    });
  }

  if (!scored.length) return [];

  scored.sort((a, b) => b.score - a.score || a.page - b.page);

  const bestScore = scored[0].score;
  const bestPage = scored[0].page;
  const focused = scored.filter((row) => row.score === bestScore && row.page === bestPage);

  const unique = [];
  const seen = new Set();
  for (const { image } of focused) {
    if (seen.has(image.image_path)) continue;
    seen.add(image.image_path);
    unique.push(image);
    if (unique.length >= limit) break;
  }
  return unique;
}

/** Fix wrong Gemini [[TOPIC: ...]] using user question + assistant speech. */
export function resolveImagePdfTopic(pdfFilter, query = "") {
  const topic = String(pdfFilter || "").trim().toLowerCase();
  const q = stripSpeechFillers(query);
  if (!topic || topic === "general") return pdfFilter;

  if (PROTECTED_IMAGE_TOPICS.has(topic)) {
    return pdfFilter;
  }

  for (const rule of TOPIC_REMAP_RULES) {
    if (topic === rule.from && rule.when.test(q)) {
      console.log(`🔀 [TOPIC-REMAP] "${topic}" → "${rule.to}" (query signals product)`);
      return rule.to;
    }
  }

  return pdfFilter;
}

/**
 * Pick images for a Live turn.
 * @param {string} query - user question and/or assistant speech
 * @param {string|null} pdfFilter - TOPIC pdf id
 * @param {{ allowPdfBaseline?: boolean, limit?: number }} options
 */
export function pickImagesForLive(query, pdfFilter = null, options = {}) {
  const limit = options.limit ?? 8;
  const allowPdfBaseline = options.allowPdfBaseline !== false;
  const resolvedFilter = pdfFilter ? resolveImagePdfTopic(pdfFilter, query) : pdfFilter;

  if (resolvedFilter) {
    let ranked = rankImagesInPdf(query, resolvedFilter, limit);

    if (!ranked.length && resolvedFilter !== pdfFilter) {
      ranked = rankImagesInPdf(query, pdfFilter, limit);
    }

    if (!ranked.length) {
      const focus = detectQueryFocus(stripSpeechFillers(query));
      if (focus && normalizeKey(focus) !== normalizeKey(resolvedFilter)) {
        ranked = rankImagesInPdf(query, focus, limit);
        if (ranked.length) {
          console.log(
            `🔍 LOCAL SEARCH: Query = "${String(query).slice(0, 80)}" | pdfFilter = "${pdfFilter}" → "${focus}" | ranked ${ranked.length} images`
          );
          return ranked;
        }
      }
    }

    if (ranked.length) {
      console.log(
        `🔍 LOCAL SEARCH: Query = "${String(query).slice(0, 80)}" | pdfFilter = "${pdfFilter}"${resolvedFilter !== pdfFilter ? ` → "${resolvedFilter}"` : ""} | ranked ${ranked.length} page-matched images`
      );
      return ranked;
    }

    if (!allowPdfBaseline) {
      return [];
    }

    const fallback = imagesForPdf(resolvedFilter, limit);
    console.log(
      `🔍 LOCAL SEARCH: Query = "${String(query).slice(0, 80)}" | pdfFilter = "${resolvedFilter}" | PDF baseline ${fallback.length} images`
    );
    return fallback;
  }

  const ranked = rankImagesInPdf(query, null, limit);
  console.log(
    `🔍 LOCAL SEARCH: Query = "${String(query).slice(0, 80)}" | pdfFilter = "" | Found ${ranked.length} images`
  );
  return ranked;
}

function localImagesForQuery(query, limit = 8, pdfFilter = null) {
  return pickImagesForLive(query, pdfFilter, { allowPdfBaseline: true, limit });
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

function detectQueryFocus(text) {
  const lower = stripSpeechFillers(text).toLowerCase();
  const stripped = lower.replace(/\s+/g, "");

  if (/client|clients|case stud|getzpharma|power2go|gamenest|game nest|kelectric|electric pole|polekit client|fume hood|it park|collaboration|क्लाइंट|क्लाइंट्स/i.test(lower)) {
    return "iotfiyclients";
  }
  if (/mushaba|moshaba|mashaba|hajj|umrah|pilgrim|haram|kaaba/.test(lower) || /mushaba|hajj|umrah/.test(stripped)) {
    return "mushaba";
  }
  if (/mushaba\s*rag|rag\s*mushaba/.test(lower)) {
    return "mushaba_rag";
  }
  if (/iotfiy\s*solutions|solutions\s*document|iotfiy\s*document|about\s*iotfiy/i.test(lower) ||
    /iotfiysolutions|solutionsdocument|iotfiydocument|aboutiotfiy/.test(stripped)) {
    return "iotfiy";
  }
  if (/nucleus|vivanco|distribution|cable|vericom|data\s*center/i.test(lower) ||
    /nucleus|distribution/.test(stripped)) {
    return "nucleus_distribution";
  }
  return null;
}

export function inferTopicFromAssistantSpeech(text) {
  return detectQueryFocus(text);
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

/** Keep only images from the TOPIC PDF. Never fall back to other PDFs. */
function filterPayloadByPdf(payload, pdfFilter) {
  if (!pdfFilter || !Array.isArray(payload) || !payload.length) return payload;
  const filterKey = normalizeKey(pdfFilter);
  return payload.filter((img) => {
    if (typeof img === "string") {
      return normalizeKey(img).includes(filterKey);
    }
    const key = normalizeKey(img.pdf_name || img.pdfId || img.pdfName || "");
    return key === filterKey;
  });
}

const GREETING_OR_GENERIC = /^(hello|hi|hey|salam|assalam|ok|okay|yes|no|thanks|thank you)\b/i;
export function enrichQueryForLive(
  sessionId,
  query,
  { onImages, pdfFilter = null }
) {
  if (!query || query.trim().length < 2) return;

  const trimmed = query.trim();

  if (GREETING_OR_GENERIC.test(trimmed) && trimmed.length < 20) {
    console.log(`⏭️  Skipping image search for greeting/generic: "${trimmed}"`);
    return;
  }

  // With a TOPIC: try page match first; if none, do NOT dump whole PDF here —
  // the bridge will refine from assistant speech, then fall back if needed.
  const instantImages = pickImagesForLive(trimmed, pdfFilter, {
    allowPdfBaseline: !pdfFilter,
    limit: 8,
  });
  if (instantImages.length) {
    console.log(`Images [LOCAL] Found ${instantImages.length} immediate image(s) for: "${trimmed.slice(0, 80)}"`);
    onImages?.(instantImages);
    return;
  }

  if (pdfFilter) {
    // Wait for assistant-speech refine in the bridge (no cross-PDF RAG).
    console.log(`🖼️  [LOCAL] No page match yet for "${pdfFilter}" — waiting for assistant speech refine`);
    return;
  }

  const focus = detectQueryFocus(trimmed);

  const prevFocus = lastQueryBySession.get(sessionId);
  if (focus && prevFocus && focus !== prevFocus) {
    utteranceBySession.set(sessionId, { text: trimmed });
  } else {
    const prev = utteranceBySession.get(sessionId) || { text: "" };
    const combined = `${prev.text || ""} ${trimmed}`.replace(/\s+/g, " ").trim();
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
      );

      const { imageUrls = [], relatedImages = [] } = result || {};

      let payload = relatedImages?.length ? relatedImages : imageUrls;
      payload = filterPayloadByPdf(payload, pdfFilter);

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
