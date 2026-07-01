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
import { getConfig } from "../config/keys.js";

/* ───── State ───── */
let vectorStore = null;
let chatModel = null;
let pdfImageIndex = {};
let imageCatalog = [];
let imageBaseUrl = "";
let ragTopK = 2;
let allChunks = [];



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


function fallbackImagesForQuery(query, limit = 8, allowedPdfIds = null) {
  if (!imageCatalog.length || !query?.trim()) return [];

  const queryText = query.trim();
  const scored = [];

  for (const img of imageCatalog) {
    if (allowedPdfIds?.size && !allowedPdfIds.has(img.pdfId)) continue;

    const haystack = imageSearchText(img);
    let score = Math.round(tokenOverlapScore(haystack, queryText) * 80);
    // score += querySourceBoost(queryText, img);

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

    const pdfId = String(img.pdfId || "").toLowerCase();
    const queryLower = String(query || "").toLowerCase();

    // === STRONG PDF MATCHING ===
    if (pdfId.includes("iotfiy") && queryLower.includes("iotfiy")) score += 150;
    if (pdfId.includes("gateway") && queryLower.includes("gateway")) score += 180;
    if (pdfId.includes("mushaba") && queryLower.includes("mushaba")) score += 180;
    if (pdfId.includes("polekit") && queryLower.includes("polekit")) score += 180;
    if (pdfId.includes("sales") && queryLower.includes("sales")) score += 180;
    if (pdfId.includes("ac") && (queryLower.includes("ac kit") || queryLower.includes("ac-kit"))) score += 170;

    // Page + Topic score
    const pageSet = pagesByPdf[img.pdfId];
    const adjSet = adjacentByPdf[img.pdfId];

    if (pageSet && pageSet.has(img.pageNumber)) score += 100;
    if (adjSet && adjSet.has(img.pageNumber)) score += 60;

    const imageText = imageSearchText(img);
    const topicScore = tokenOverlapScore(imageText, combinedTopicText);
    if (topicScore > 0) score += Math.round(topicScore * 50);

    const queryScore = tokenOverlapScore(imageText, query || "");
    if (queryScore > 0) score += Math.round(queryScore * 30);

    // score += querySourceBoost(query, img);

    if (score > 30) scored.push({ img, score });
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

  console.log("retrieveContextAndImages is being called in gemini service .js")
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
  //comments start
  console.log(`🔍 DEBUG: Query = "${trimmed}"`);
  console.log(`🔍 DEBUG: Relevant Docs Count = ${imageDocs.length}`);
  console.log(`🔍 DEBUG: Found ${relatedImages.length} images:`);

  relatedImages.forEach((img, i) => {
    console.log(`   ${i + 1}. Page ${img.page_number} | Topic: ${img.topic} | Path: ${img.image_path}`);
  });
  //comments end
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

