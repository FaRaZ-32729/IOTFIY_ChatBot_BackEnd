/**
 * Gemini Service — RAG pipeline
 * ─────────────────────────────────────────────
 * • Vectorises PDF chunks with Google embeddings
 * • Retrieves top-K relevant chunks per query
 * • Matches PDF images by topic + page proximity
 */
import {
  ChatGoogleGenerativeAI,
  GoogleGenerativeAIEmbeddings,
} from "@langchain/google-genai";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
} from "@langchain/core/messages";
import { getConfig } from "../config/keys.js";

/* ───── State ───── */
let vectorStore = null;
let chatModel = null;
let pdfImageIndex = {};
let imageCatalog = [];
let imageBaseUrl = "";
let ragTopK = 2;
let allChunks = [];

const IOTFIY_SOLUTIONS_PDF_ID = "iotfiy_solutions_document";
const IOTFIY_PRODUCT_CATALOG = [
  "IOTFIY Gateway",
  "IOTFIY Dashboard and widgets",
  "IOTFIY Sales Hub",
  "Mall washroom IoT monitoring",
  "Gas detection and suppression automation",
  "IOTFIY AC-Kit",
  "Mushaba pilgrim/group navigation",
  "Enterprise Private Social Network (EPSN)",
  "EASY Solar",
  "PackTrack AI logistics automation",
  "Learning Management System / smart learning platform",
  "PoleKit electrical pole leakage detection",
  "3D AI chatbot and immersive customer experience",
  "Enterprise event/social platform for Getz Pharma",
  "GameNest arcade and vending machine monitoring",
  "Weather monitoring station",
  "Face recognition / AI receptionist style system",
  "Smart ventilator splitter/control system",
  "WallHub Power2GO solar energy system",
  "Cold storage and freezer monitoring",
  "Hardware and PCB design",
  "AI-powered support chatbot",
  "AI computer vision systems",
];

/* ───── System Prompt (exact spec from requirements) ───── */
const SYSTEM_PROMPT = `You are the official AI Assistant for IoTFIY / Nucleus Chatbot. You are polite, professional, and knowledgeable.

RULE 1: Answer questions ONLY using the provided company profile context (Nucleus Distribution profile, Mushaba Rag, and Nucleus Vericom). Do not invent information. If the answer is not in the context, say so honestly.

RULE 2: If the user speaks in English, reply in English. If the user speaks in Urdu (even if transcribed in Arabic script), YOU MUST REPLY IN BOTH ACTUAL URDU (Nastaliq script) AND ROMAN URDU. Provide the Nastaliq text first, followed by a paragraph break, and then the Roman Urdu translation.

RULE 3: Relevant images from the PDF are provided to you. You SHOULD include them in your response if they help illustrate the topic or answer the user's question. If the user is just greeting or asking an unrelated question, you can omit them. IF the user EXPLICITLY asks you to generate a NEW AI image (not from the PDF), append the exact text "[GENERATE_IMAGE]" at the very end of your response.

RULE 4: Keep answers concise, well-structured with markdown headings and bullet points where appropriate.
RULE 4A: At the start of a new conversation or when the user asks what you can explain, first mention the product areas you can cover from the documents: ${IOTFIY_PRODUCT_CATALOG.join(", ")}.
RULE 5: USER INFORMATION (Name, Phone, Email):
- DO NOT invent or provide "fake" user information. If it's not in the chat history, you don't know it.
- If the user's email is missing from history, you must say: "I do not find your email. Tell me your email verbally." 
- Before asking for the email, repeat the user's Name and Phone Number if you found them in the history.
- Example: "I have your name as [Name] and phone number as [Phone], but I do not find your email. Tell me your email verbally." (Omit missing fields).`;

const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt/";

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePollinationsUrl(rawUrl) {
  if (!rawUrl || !rawUrl.includes(POLLINATIONS_BASE)) return rawUrl;

  const baseIndex = rawUrl.indexOf(POLLINATIONS_BASE);
  const prefix = rawUrl.slice(0, baseIndex + POLLINATIONS_BASE.length);
  const rest = rawUrl.slice(baseIndex + POLLINATIONS_BASE.length);

  const [rawPrompt, rawQuery] = rest.split("?");
  const decodedPrompt = safeDecodeURIComponent(rawPrompt || "").trim();
  const hyphenatedPrompt = decodedPrompt.replace(/\s+/g, "-");
  const encodedPrompt = encodeURIComponent(hyphenatedPrompt);

  const query = rawQuery && rawQuery.length > 0
    ? rawQuery
    : "width=800&height=400";

  return `${prefix}${encodedPrompt}?${query}`;
}

function normalizePollinationsMarkdown(markdown) {
  if (typeof markdown !== "string") return markdown;
  if (!markdown.includes("image.pollinations.ai/prompt/")) return markdown;

  return markdown.replace(
    /!\[([^\]]*)\]\((https?:\/\/image\.pollinations\.ai\/prompt\/[^)]+)\)/g,
    (match, alt, url) => {
      const normalized = normalizePollinationsUrl(url);
      return normalized ? `![${alt}](${normalized})` : match;
    }
  );
}

function hasMarkdownImage(markdown) {
  if (typeof markdown !== "string") return false;
  return /!\[[^\]]*\]\([^)]*\)/.test(markdown);
}

function userAskedForImage(text) {
  if (typeof text !== "string") return false;
  return /(image|images|picture|photo|diagram|chart|logo|brochure|profile|catalog|visual|graph|show|view|see|display|look|tell|about)/i.test(text);
}

function slugifyPrompt(value) {
  return (value || "iotfiy-visual")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim() || "iotfiy-chatbot-visual";
}

function buildPollinationsUrl(prompt) {
  const slug = slugifyPrompt(prompt || "iotfiy-chatbot-visual");
  const encoded = encodeURIComponent(slug);
  return `${POLLINATIONS_BASE}${encoded}?width=800&height=400`;
}

function joinUrl(baseUrl, relativePath) {
  if (!relativePath) return null;
  const base = (baseUrl || "").replace(/\/+$/g, "");
  const rel = relativePath.replace(/^\/+/, "");
  if (!base) return `/${rel}`;
  return `${base}/${rel}`;
}

/**
 * Always return a root-relative URL (/uploads/extracted_images/...) so the Vite dev
 * proxy (and any reverse-proxy in production) handles the request.
 * Never embed the host — that causes cross-origin failures when the
 * frontend is on a different port.
 */
function toFrontendImageUrl(relativePath) {
  if (!relativePath) return null;
  const rel = relativePath.replace(/^\/+/, "");
  return `/${rel}`;
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function tokenOverlapScore(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;

  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap += 1;
  }
  return overlap / Math.min(setA.size, setB.size);
}

function isIotfiyWholeDocumentQuery(query) {
  return false;
}

function buildIotfiyProductCatalogContext() {
  const topicIndex = buildIotfiyFullTopicIndex();

  return [
    "[IOTFIY SOLUTIONS DOCUMENT]",
    "Topic: Complete document product catalog, full topic index, and overview",
    "The IOTFIY Solutions Document covers these product and solution areas. When answering broad questions about the complete document, start by listing these products/solutions, then cover all topics from the full topic index below:",
    ...IOTFIY_PRODUCT_CATALOG.map((name) => `- ${name}`),
    "",
    "FULL TOPIC INDEX FROM ALL INGESTED IOTFIY SOLUTIONS DOCUMENT PAGES:",
    topicIndex || "(No page topic index available.)",
  ].join("\n");
}

function cleanTopicForIndex(value) {
  return String(value || "")
    .replace(/[•●🔹📋⏱🌐]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[-:.\s]+|[-:.\s]+$/g, "")
    .trim();
}

function buildIotfiyFullTopicIndex() {
  const pages = new Map();

  for (const chunk of allChunks || []) {
    if (chunk.metadata?.pdfId !== IOTFIY_SOLUTIONS_PDF_ID) continue;
    const pageNumber = Number(chunk.metadata?.pageNumber);
    if (!Number.isFinite(pageNumber)) continue;

    const existing = pages.get(pageNumber) || {
      pageNumber,
      topic: "",
      snippets: [],
    };

    const topic = cleanTopicForIndex(chunk.metadata?.topic);
    if (topic && (!existing.topic || topic.length > existing.topic.length)) {
      existing.topic = topic;
    }

    const snippet = cleanTopicForIndex(
      String(chunk.text || "")
        .split(/[.!?]\s+/)
        .find((part) => cleanTopicForIndex(part).length >= 18) || ""
    );
    if (snippet && !existing.snippets.includes(snippet)) {
      existing.snippets.push(snippet.slice(0, 180));
    }

    pages.set(pageNumber, existing);
  }

  return [...pages.values()]
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((page) => {
      const topic = page.topic || page.snippets[0] || "Untitled topic";
      const supporting = page.snippets
        .filter((snippet) => snippet !== topic)
        .slice(0, 1)[0];
      return supporting
        ? `Page ${page.pageNumber}: ${topic} - ${supporting}`
        : `Page ${page.pageNumber}: ${topic}`;
    })
    .join("\n");
}

function imageSearchText(img) {
  return [
    img.topic,
    img.relativePath,
    img.image_path,
    img.alt,
    img.pdfId,
    img.pdfName,
    img.displayName,
  ]
    .filter(Boolean)
    .join(" ");
}

function querySourceBoost(query, img) {
  const q = String(query || "").toLowerCase().replace(/\s+/g, "");
  const hay = imageSearchText(img).toLowerCase().replace(/\s+/g, "");

  let score = 0;
  if (/mushaba|moshaba|mashaba/.test(q) && hay.includes("mushaba")) score += 90;
  if (/iotfiysolutions|solutionsdocument|iotfiydocument|iotfiycompany|aboutiotfiy/.test(q) &&
      /iotfiy_solutions_document|iotfiysolutionsdocument/.test(hay)) {
    score += 100;
  }
  if (/iotfiy/.test(q) && /iotfiy_solutions_document|iotfiysolutionsdocument/.test(hay)) score += 45;
  if (/nucleus|distribution/.test(q) && hay.includes("nucleus")) score += 70;
  if (/vivanco|vericom|cable|datacenter|infrastructure|turnkey/.test(q) &&
      /nucleus|vivanco|vericom|cable|datacenter|infrastructure|turnkey/.test(hay)) {
    score += 60;
  }
  return score;
}

function fallbackImagesForQuery(query, limit = 8, allowedPdfIds = null) {
  if (!imageCatalog.length || !query?.trim()) return [];

  const queryText = query.trim();
  const scored = [];

  for (const img of imageCatalog) {
    if (allowedPdfIds?.size && !allowedPdfIds.has(img.pdfId)) continue;

    const haystack = imageSearchText(img);
    let score = Math.round(tokenOverlapScore(haystack, queryText) * 100);
    score += querySourceBoost(queryText, img);

    if (score > 0) scored.push({ img, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const unique = [];
  const seen = new Set();
  for (const { img } of scored) {
    const key = img.relativePath || img.image_path || img.url || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(img);
    if (unique.length >= limit) break;
  }

  return unique;
}

function buildImageCatalog(index) {
  const catalog = [];
  for (const [pdfId, info] of Object.entries(index || {})) {
    const displayName = info.displayName || pdfId;
    const pdfName = info.pdfName || pdfId;
    const pages = info.pages || {};

    for (const [pageKey, pageInfo] of Object.entries(pages)) {
      const pageNumber = Number(pageKey);
      const topic = pageInfo?.topic || "";
      const images = Array.isArray(pageInfo?.images)
        ? pageInfo.images
        : Array.isArray(pageInfo)
          ? pageInfo
          : [];

      for (const img of images) {
        const relativePath =
          img.relativePath || img.image_path || img.path || img.url || "";
        if (!relativePath) continue;
        catalog.push({
          ...img,
          relativePath,
          topic: img.topic || topic,
          pageNumber: Number.isFinite(img.pageNumber) ? img.pageNumber : pageNumber,
          pdfId,
          pdfName,
          displayName,
        });
      }
    }
  }
  return catalog;
}

function collectImagesForDocs(relevantDocs, query, limit = 8) {
  if (!imageCatalog.length) {
    return [];
  }
  if (!Array.isArray(relevantDocs) || !relevantDocs.length) {
    return fallbackImagesForQuery(query, limit);
  }

  const docPdfIds = new Set();
  const pagesByPdf = {};
  const adjacentByPdf = {};
  const docTopics = [];

  for (const doc of relevantDocs) {
    const pdfId = doc.metadata?.pdfId;
    const pageNumber = Number.isFinite(doc.metadata?.pageNumber)
      ? doc.metadata.pageNumber
      : Number.isFinite(doc.metadata?.pageIndex)
        ? doc.metadata.pageIndex + 1
        : null;

    if (pdfId) docPdfIds.add(pdfId);
    if (pageNumber && pdfId) {
      if (!pagesByPdf[pdfId]) pagesByPdf[pdfId] = new Set();
      pagesByPdf[pdfId].add(pageNumber);
      if (!adjacentByPdf[pdfId]) adjacentByPdf[pdfId] = new Set();
      adjacentByPdf[pdfId].add(pageNumber - 1);
      adjacentByPdf[pdfId].add(pageNumber + 1);
    }
    if (doc.metadata?.topic) docTopics.push(doc.metadata.topic);
  }

  const combinedTopicText = `${docTopics.join(" ")} ${query || ""}`.trim();
  const scored = [];

  for (const img of imageCatalog) {
    let score = 0;
    if (docPdfIds.size && docPdfIds.has(img.pdfId)) score += 30;
    if (docPdfIds.size && !docPdfIds.has(img.pdfId)) score -= 15;

    const pageSet = pagesByPdf[img.pdfId];
    const adjSet = adjacentByPdf[img.pdfId];
    if (pageSet && pageSet.has(img.pageNumber)) score += 90;
    if (!pageSet && docPdfIds.size === 0) score += 10;
    if (adjSet && adjSet.has(img.pageNumber)) score += 40;

    const imageText = imageSearchText(img);
    const topicScore = tokenOverlapScore(imageText, combinedTopicText);
    if (topicScore > 0) score += Math.round(topicScore * 60);

    const queryScore = tokenOverlapScore(imageText, query || "");
    if (queryScore > 0) score += Math.round(queryScore * 20);
    score += querySourceBoost(query, img);

    if (score > 0) scored.push({ img, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const unique = [];
  const seen = new Set();

  for (const { img, score } of scored) {
    if (score < 25) continue;
    const key = img.relativePath || img.url || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(img);
    if (unique.length >= limit) break;
  }

  if (unique.length) return unique;
  return fallbackImagesForQuery(query, limit, docPdfIds);
}

function formatRelatedImage(img) {
  const relativePath = String(img.relativePath || img.image_path || "").replace(
    /^\/+/, ""
  );
  const url = toFrontendImageUrl(relativePath);
  return {
    topic: img.topic || "",
    image_path: relativePath,
    url,
    page_number: Number.isFinite(img.pageNumber) ? img.pageNumber : null,
    pdf_name: img.pdfName || img.pdfId || "",
    pdfId: img.pdfId || "",
    displayName: img.displayName || "",
    alt: img.alt || "",
  };
}

function keywordSearchChunks(query, prefs = [], limit = 6) {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length > 2);

  const scored = allChunks
    .map((chunk) => {
      const text = (chunk.text || "").toLowerCase();
      const src = `${chunk.metadata?.pdfName || ""} ${chunk.metadata?.pdfId || ""}`.toLowerCase();
      let score = 0;

      for (const word of words) {
        if (text.includes(word)) score += 1;
      }
      if (prefs.includes("mushaba") && src.includes("mushaba")) score += 12;
      if (prefs.includes("nucleus") && src.includes("nucleus")) score += 12;
      if (prefs.includes("iotfiy_solutions") && src.includes("iotfiy solutions document")) score += 12;
      if (prefs.includes("iotfiy_solutions") && src.includes("iotfiy_solutions_document")) score += 12;

      return { chunk, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(
    (row) =>
      new Document({
        pageContent: row.chunk.text,
        metadata: row.chunk.metadata || {},
      })
  );
}

function mergeUniqueDocs(primary, secondary, limit) {
  const seen = new Set();
  const merged = [];
  for (const doc of [...primary, ...secondary]) {
    const key = `${doc.metadata?.pdfId}:${doc.metadata?.chunkIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(doc);
    if (merged.length >= limit) break;
  }
  return merged;
}

/**
 * RAG retrieval for Live voice sessions — context + slideshow image URLs.
 */


export async function retrieveContextAndImages(query) {
  if (!vectorStore || !query?.trim()) {
    return { context: "", imageUrls: [], relatedImages: [], sources: [] };
  }

  const trimmed = query.trim();
  const k = Math.max(ragTopK * 2, 8);

  let relevantDocs = [];
  let strictDocs = [];
  try {
    relevantDocs = await vectorStore.similaritySearch(trimmed, k);
    strictDocs = [...relevantDocs];
  } catch (err) {
    console.warn("Vector RAG fallback to keyword search:", err.message);
  }

  const keywordDocs = keywordSearchChunks(trimmed, [], k);
  relevantDocs = mergeUniqueDocs(keywordDocs, relevantDocs, k);
  strictDocs = mergeUniqueDocs(keywordDocs, strictDocs, k);


  const context = relevantDocs
    .map((d) => {
      const source = d.metadata?.pdfName || d.metadata?.pdfId || "Document";
      const topic = d.metadata?.topic ? `Topic: ${d.metadata.topic}\n` : "";
      return `[${source}]\n${topic}${d.pageContent}`;
    })
    .join("\n\n---\n\n");

  const imageDocs = strictDocs.slice(0, 4);
  const relatedImages = collectImagesForDocs(imageDocs, trimmed, 8).map(formatRelatedImage);
  const imageUrls = relatedImages.map((img) => img.url).filter(Boolean);

  const sources = [
    ...new Set(relevantDocs.map((d) => d.metadata?.pdfName).filter(Boolean)),
  ];

  console.log(`🖼️  RAG → ${imageUrls.length} image URL(s) for query: "${trimmed.slice(0, 60)}"`);
  if (imageUrls.length) console.log("   URLs:", imageUrls);

  return { context, imageUrls, relatedImages, sources };
}

/**
 * Initialise Gemini chat model, embeddings, and vector store.
 * Called once at server startup after PDF chunks are ready.
 */
export async function initializeGemini(pdfChunks, imageIndex = {}) {
  const {
    GOOGLE_API_KEY,
    PUBLIC_BASE_URL,
    GEMINI_CHAT_MODEL,
    GEMINI_CHAT_API_VERSION,
    GEMINI_API_BASE_URL,
    GEMINI_MAX_OUTPUT_TOKENS,
    GEMINI_RAG_TOP_K,
  } = getConfig();

  pdfImageIndex = imageIndex || {};
  imageCatalog = buildImageCatalog(pdfImageIndex);
  imageBaseUrl = PUBLIC_BASE_URL || "";
  allChunks = Array.isArray(pdfChunks) ? pdfChunks : [];

  const chatModelOptions = {
    model: GEMINI_CHAT_MODEL || "gemini-1.5-flash",
    apiKey: GOOGLE_API_KEY,
    temperature: 0.35,
    maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
    convertSystemMessageToHumanContent: true,
    apiVersion: GEMINI_CHAT_API_VERSION || "v1beta",
    ...(GEMINI_API_BASE_URL ? { baseUrl: GEMINI_API_BASE_URL } : {}),
  };

  console.log("🛠️  Initializing Gemini Chat Model with options:", {
    ...chatModelOptions,
    apiKey: "MASKED",
  });

  ragTopK = Number.isFinite(GEMINI_RAG_TOP_K) && GEMINI_RAG_TOP_K > 0
    ? GEMINI_RAG_TOP_K
    : 2;

  chatModel = new ChatGoogleGenerativeAI(chatModelOptions);

  const embeddings = new GoogleGenerativeAIEmbeddings({
    model: "gemini-embedding-001",
    apiKey: GOOGLE_API_KEY,
  });

  /* Wrap each chunk as a LangChain Document */
  const docs = pdfChunks.map((chunk, idx) =>
    new Document({
      pageContent: chunk.text,
      metadata: {
        ...(chunk.metadata || {}),
        chunkIndex: chunk.metadata?.chunkIndex ?? idx,
      },
    })
  );

  vectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);
  console.log(`   Vector store ready with ${docs.length} embedded chunks`);
}

/**
 * Return available extracted PDF images as full URLs for the frontend.
 * @returns {Array<{pdfId:string, displayName:string, images:Array<{url:string, alt:string, relativePath:string, topic:string, pageNumber:number}>}>}
 */
export function getAvailablePdfImages() {
  const result = [];
  for (const [pdfId, info] of Object.entries(pdfImageIndex || {})) {
    const displayName = info.displayName || pdfId;
    const pages = info.pages || {};
    const images = [];

    for (const pageInfo of Object.values(pages)) {
      const pageImages = Array.isArray(pageInfo?.images) ? pageInfo.images : [];
      for (const img of pageImages) {
        const rel = img.relativePath || img.image_path;
        const url = rel ? `/${String(rel).replace(/^\/+/, "")}` : null;
        if (!url) continue;
        images.push({
          url,
          alt: img.alt || "",
          relativePath: rel,
          topic: img.topic || pageInfo?.topic || "",
          pageNumber: img.pageNumber || null,
          pdfName: info.pdfName || pdfId,
        });
      }
    }
    if (images.length) result.push({ pdfId, displayName, images });
  }
  return result;
}

/**
 * Retrieve related images for a query without generating an answer.
 */
export async function retrieveRelatedImages(query, limit = 8) {
  if (!vectorStore || !query?.trim()) return [];
  const docs = await vectorStore.similaritySearch(query.trim(), Math.max(ragTopK * 2, 6));
  return collectImagesForDocs(docs, query, limit).map(formatRelatedImage);
}

/**
 * Generate a response from Gemini given a user message and chat history.
 *
 * @param {string}   userMessage  — the user's text (or Whisper transcription)
 * @param {Array}    chatHistory  — array of { role: 'user'|'assistant', content }
 * @returns {string} Gemini's markdown response
 */
export async function generateResponse(userMessage, chatHistory = []) {
  if (!vectorStore || !chatModel) {
    throw new Error("Gemini service not initialised. Call initializeGemini() first.");
  }

  const wantsIotfiyWholeDocument = isIotfiyWholeDocumentQuery(userMessage);

  /* 1. Retrieve the most relevant PDF chunks and images */
  let context = "";
  let relatedImages = [];
  try {
    const focused = await retrieveContextAndImages(userMessage);
    context = focused.context || "";
    relatedImages = (focused.relatedImages || []).map((img) => ({
      ...img,
      relativePath: img.image_path || img.relativePath,
      alt: img.alt || img.topic || "Related image",
    }));
  } catch (err) {
    console.warn("Focused RAG failed, falling back to basic similarity:", err.message);
  }

  if (!context) {
    const relevantDocs = await vectorStore.similaritySearch(userMessage, ragTopK);
    context = relevantDocs.map((d) => d.pageContent).join("\n\n---\n\n");
    relatedImages = collectImagesForDocs(relevantDocs, userMessage, 6);
  }

  let availableImagesText = "";
  if (relatedImages.length > 0) {
    availableImagesText = "Available images for the retrieved context (use these markdown links in your response ONLY if highly relevant):\n" +
      relatedImages.map(img => {
        const url = joinUrl(imageBaseUrl, img.relativePath);
        return `![${img.alt || "Related image"}](${url})`;
      }).join("\n");
  }

  /* 2. Build LangChain message array */
  const broadDocumentInstruction = wantsIotfiyWholeDocument
    ? "\n\nIMPORTANT FOR THIS USER REQUEST: The user is asking about the whole IOTFIY Solutions Document or all products/topics. Start the answer with a section named \"Products I can explain\" and include every product/solution from the product catalog context. Then add a section named \"All topics covered in the document\" and cover the complete topic index without skipping sections. Group related pages if needed, but do not omit topic categories. After that, summarize the document as a whole and ask which product they want details or images for."
    : "";

  const messages = [
    new SystemMessage(
      `${SYSTEM_PROMPT}${broadDocumentInstruction}\n\nHere is the relevant context from the IoTFIY knowledge base (Nucleus Distribution profile 2025 + Mushaba Rag + nucleus vericom):\n\n${context}\n\n${availableImagesText}`
    ),
  ];

  /* Add the last N messages from history (keep context window lean) */
  const recentHistory = chatHistory.slice(-20);
  for (const msg of recentHistory) {
    if (msg.role === "user") {
      messages.push(new HumanMessage(msg.content));
    } else if (msg.role === "assistant") {
      messages.push(new AIMessage(msg.content));
    }
  }

  /* Current user query */
  messages.push(new HumanMessage(userMessage));

  /* 3. Invoke Gemini */
  const response = await chatModel.invoke(messages);
  const rawContent = typeof response.content === "string"
    ? response.content
    : JSON.stringify(response.content);

  const cleaned = normalizePollinationsMarkdown(rawContent);

  const needsGeneratedImage = cleaned.includes("[GENERATE_IMAGE]");
  const finalCleaned = cleaned.replace("[GENERATE_IMAGE]", "").trim();

  if (needsGeneratedImage) {
    const fallbackUrl = normalizePollinationsUrl(buildPollinationsUrl(userMessage));
    return `${finalCleaned}\n\n![Generated visual](${fallbackUrl})`;
  }

  if (!hasMarkdownImage(finalCleaned) && relatedImages.length > 0 && userAskedForImage(userMessage)) {
    const appendedImages = relatedImages
      .slice(0, 3)
      .map((img) => `![${img.alt || "Related image"}](${joinUrl(imageBaseUrl, img.relativePath)})`)
      .join("\n\n");
    return `${finalCleaned}\n\n### Related Images\n${appendedImages}`;
  }

  return finalCleaned;
}

