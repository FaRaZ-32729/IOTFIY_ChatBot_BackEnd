/**
 * PDF Service
 * ─────────────────────────────────────────────
 * Loads PDFs, extracts text + images during ingestion,
 * labels images by topic, and caches metadata for fast lookup.
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { initializeGemini } from "./geminiService.js";
import { getConfig } from "../config/keys.js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const IMAGE_ROOT = path.resolve("uploads", "extracted_images");
const METADATA_PATH = path.join(IMAGE_ROOT, "image_metadata.json");
const MIN_IMAGE_DIM = 50;
const TOPIC_MAX_LEN = 120;

let rawText = "";
/** Full text per PDF display name — used for balanced Live API context */
const sourceTexts = {};
const sourcePageTopics = {};
let cachedMetadata = null;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function slugify(value, separator = "-") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${separator}+`, "g"), separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "")
    .trim();
  return normalized || "pdf";
}

function slugifyTopic(value) {
  return slugify(value, "_");
}

function displayNameFromPath(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function folderNameFromPdf(displayName) {
  const name = (displayName || "").toLowerCase();
  if (name.includes("mushaba") && name.includes("distribution")) {
    return "mushaba_distribution";
  }
  if (name.includes("nucleus") && name.includes("distribution")) {
    return "nucleus_distribution";
  }
  return slugify(displayName, "_");
}

function buildRelativeImagePath(pdfFolder, fileName) {
  return path.posix.join("uploads", "extracted_images", pdfFolder, fileName);
}

function toTitleCase(value) {
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function normalizeTopicLabel(raw) {
  const trimmed = String(raw || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  let label = trimmed.length > TOPIC_MAX_LEN
    ? trimmed.slice(0, TOPIC_MAX_LEN).trim()
    : trimmed;

  if (label === label.toUpperCase() && /[A-Z]/.test(label)) {
    label = toTitleCase(label);
  }
  return label;
}

function buildPageText(textContent) {
  const items = textContent?.items || [];
  return items
    .map((item) => item.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTextLines(textContent) {
  const items = textContent?.items || [];
  const lines = new Map();

  for (const item of items) {
    const text = String(item.str || "").trim();
    if (!text) continue;

    const transform = item.transform || [];
    const x = Number.isFinite(transform[4]) ? transform[4] : 0;
    const y = Number.isFinite(transform[5]) ? transform[5] : 0;
    const bucket = Math.round(y / 6) * 6;

    if (!lines.has(bucket)) lines.set(bucket, []);
    lines.get(bucket).push({ x, text });
  }

  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, entries]) => {
      const line = entries
        .sort((a, b) => a.x - b.x)
        .map((entry) => entry.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return { y, line };
    })
    .filter((entry) => entry.line.length > 0);
}

// function scoreTopicCandidate(text) {
//   const cleaned = String(text || "").replace(/\s+/g, " ").trim();
//   if (!cleaned || cleaned.length < 4 || cleaned.length > TOPIC_MAX_LEN) return 0;
//   if (/^(page|chapter|section)?\s*\d+\b/i.test(cleaned)) return 0;
//   if (/table of contents|contents|index/i.test(cleaned)) return 0;

//   const words = cleaned.split(" ");
//   let score = words.length;
//   if (words.length >= 3 && words.length <= 12) score += 8;
//   if (/^[A-Z]/.test(cleaned)) score += 2;
//   if (/[A-Za-z]{3,}/.test(cleaned)) score += 2;
//   return score;
// }

function scoreTopicCandidate(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length < 5 || cleaned.length > TOPIC_MAX_LEN) return 0;
  if (/^(page|chapter|section|figure|table)?\s*\d+\b/i.test(cleaned)) return 0;
  if (/table of contents|contents|index|footer|header/i.test(cleaned)) return 0;

  const words = cleaned.split(" ").filter(w => w.length > 1);
  let score = words.length * 2;

  if (words.length >= 2 && words.length <= 12) score += 15;
  if (/^[A-Z]/.test(cleaned)) score += 10;
  if (cleaned.includes("IoT") || cleaned.includes("IOT") || /Mushaba|Nucleus|Distribution/i.test(cleaned)) score += 25;

  return score;
}


// function extractTopicFromPage(textContent, pageText, fallbackTopic, pageNumber) {
//   const lines = buildTextLines(textContent).slice(0, 6);
//   let best = "";
//   let bestScore = 0;

//   for (const { line } of lines) {
//     const score = scoreTopicCandidate(line);
//     if (score > bestScore) {
//       bestScore = score;
//       best = line;
//     }
//   }

//   if (!best && pageText) {
//     const sentence = pageText.split(/[\.!?]/)[0] || "";
//     const fallback = sentence || pageText;
//     best = fallback.split(" ").slice(0, 14).join(" ");
//   }

//   const normalized = normalizeTopicLabel(best);
//   if (normalized) return normalized;
//   return (
//     normalizeTopicLabel(fallbackTopic || "") ||
//     `Page ${Number.isFinite(pageNumber) ? pageNumber : ""}`.trim()
//   );
// }

function extractTopicFromPage(textContent, pageText, fallbackTopic, pageNumber) {
  const lines = buildTextLines(textContent).slice(0, 10); // 6 se badhakar 10 kiya
  let best = "";
  let bestScore = 0;

  for (const { line } of lines) {
    const cleaned = line.replace(/\s+/g, " ").trim();
    const score = scoreTopicCandidate(cleaned);

    // Extra priority to short, meaningful lines (likely headings)
    let finalScore = score;
    if (cleaned.length < 60 && cleaned.length > 8) finalScore += 15;
    if (/^[A-Z]/.test(cleaned) && cleaned.length < 80) finalScore += 12;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      best = cleaned;
    }
  }

  // Fallback improvements
  if (!best && pageText) {
    const sentences = pageText.split(/[.!?]/).map(s => s.trim()).filter(s => s.length > 10);
    if (sentences.length > 0) {
      best = sentences[0].slice(0, 100);
    }
  }

  let normalized = normalizeTopicLabel(best);

  // Extra cleaning for broken text
  normalized = normalized.replace(/(\w)\s+(\w)/g, '$1$2'); // Remove extra spaces in words
  normalized = normalized.replace(/\s+/g, " ").trim();

  if (normalized && normalized.length > 8) return normalized;

  return normalizeTopicLabel(fallbackTopic || "") ||
    `Page ${Number.isFinite(pageNumber) ? pageNumber : ""}`.trim();
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn("⚠️  Failed to parse image metadata, re-generating:", err.message);
    return null;
  }
}

function loadImageMetadata() {
  if (cachedMetadata) return cachedMetadata;
  const parsed = safeReadJson(METADATA_PATH);
  if (Array.isArray(parsed)) {
    cachedMetadata = parsed;
  } else if (parsed && Array.isArray(parsed.images)) {
    cachedMetadata = parsed.images;
  } else {
    cachedMetadata = [];
  }
  return cachedMetadata;
}

export function getImageMetadata() {
  return loadImageMetadata();
}

function writeImageMetadata(entries) {
  ensureDir(IMAGE_ROOT);
  fs.writeFileSync(METADATA_PATH, JSON.stringify(entries, null, 2));
}

function buildMetadataIndex(entries) {
  const index = {};
  for (const entry of entries || []) {
    const pdfName = entry.pdf_name || entry.pdfName;
    const pageNumber = Number(entry.page_number || entry.pageNumber);
    if (!pdfName || !Number.isFinite(pageNumber)) continue;
    if (!index[pdfName]) index[pdfName] = {};
    if (!index[pdfName][pageNumber]) index[pdfName][pageNumber] = [];
    index[pdfName][pageNumber].push(entry);
  }
  return index;
}

function resolveImagePath(imagePath) {
  if (!imagePath) return null;
  const normalized = String(imagePath).replace(/^[/\\]+/, "");
  return path.resolve(normalized);
}

function buildImageEntry({
  relativePath,
  pdfId,
  displayName,
  topic,
  pageNumber,
}) {
  return {
    relativePath,
    alt: `${displayName} - ${topic} (page ${pageNumber})`,
    topic,
    pageNumber,
    pdfId,
    pdfName: pdfId,
    displayName,
  };
}

function getCachedPageImages(metadataState, pdfId, pageNumber) {
  return metadataState.index?.[pdfId]?.[pageNumber] || [];
}

function updateMetadataIndex(metadataState, pdfId, pageNumber, entries) {
  if (!metadataState.index[pdfId]) metadataState.index[pdfId] = {};
  metadataState.index[pdfId][pageNumber] = entries;
}

function toRgbaBuffer(imgData) {
  const { ImageKind } = pdfjsLib;
  const { width, height, data, kind } = imgData;
  if (!width || !height || !data) return null;

  if (kind === ImageKind.RGBA_32BPP) {
    return Buffer.from(data);
  }

  const rgba = Buffer.alloc(width * height * 4);

  if (kind === ImageKind.RGB_24BPP) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      rgba[j] = data[i];
      rgba[j + 1] = data[i + 1];
      rgba[j + 2] = data[i + 2];
      rgba[j + 3] = 255;
    }
    return rgba;
  }

  if (ImageKind.GRAYSCALE_8BPP && kind === ImageKind.GRAYSCALE_8BPP) {
    for (let i = 0, j = 0; i < data.length; i += 1, j += 4) {
      const value = data[i];
      rgba[j] = value;
      rgba[j + 1] = value;
      rgba[j + 2] = value;
      rgba[j + 3] = 255;
    }
    return rgba;
  }

  if (kind === ImageKind.GRAYSCALE_1BPP) {
    const rowSize = Math.ceil(width / 8);
    let outIndex = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const byte = data[y * rowSize + (x >> 3)];
        const bit = (byte >> (7 - (x & 7))) & 1;
        const value = bit ? 255 : 0;
        rgba[outIndex] = value;
        rgba[outIndex + 1] = value;
        rgba[outIndex + 2] = value;
        rgba[outIndex + 3] = 255;
        outIndex += 4;
      }
    }
    return rgba;
  }

  return null;
}

async function getImageData(page, objName) {
  return new Promise((resolve) => {
    let isResolved = false;
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        resolve(null);
      }
    }, 250);

    try {
      page.objs.get(objName, (data) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          resolve(data || null);
        }
      });
    } catch (err) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        resolve(null);
      }
    }
  });
}

async function extractImagesFromPage({
  page,
  pdfId,
  displayName,
  pageNumber,
  topicLabel,
  metadataState,
}) {
  const opList = await page.getOperatorList();
  const { OPS } = pdfjsLib;
  const imageNames = new Set();

  for (let i = 0; i < opList.fnArray.length; i += 1) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintImageXObjectRepeat ||
      fn === OPS.paintJpegXObject
    ) {
      if (args && args[0]) imageNames.add(args[0]);
    }
  }

  const images = [];
  const pdfDir = path.join(IMAGE_ROOT, pdfId);
  ensureDir(pdfDir);

  let imageIndex = 0;
  for (const name of imageNames) {
    const imgData = await getImageData(page, name);
    if (!imgData || !imgData.width || !imgData.height || !imgData.data) {
      continue;
    }

    if (imgData.width < MIN_IMAGE_DIM || imgData.height < MIN_IMAGE_DIM) {
      continue;
    }

    const rgba = toRgbaBuffer(imgData);
    if (!rgba) continue;

    const topicSlug = slugifyTopic(topicLabel || "page");
    const baseName = `${topicSlug}_page_${pageNumber}`;
    let fileName = imageIndex > 0
      ? `${baseName}_img_${imageIndex + 1}.png`
      : `${baseName}.png`;

    const filePath = path.join(pdfDir, fileName);
    if (!fs.existsSync(filePath)) {
      const png = new PNG({ width: imgData.width, height: imgData.height });
      png.data = rgba;
      const buffer = PNG.sync.write(png);
      fs.writeFileSync(filePath, buffer);
    }

    const relativePath = buildRelativeImagePath(pdfId, fileName);
    const entry = buildImageEntry({
      relativePath,
      pdfId,
      displayName,
      topic: topicLabel,
      pageNumber,
    });
    images.push(entry);

    metadataState.entries.push({
      image_path: relativePath,
      pdf_name: pdfId,
      page_number: pageNumber,
      topic: topicLabel,
    });

    imageIndex += 1;
  }

  if (images.length) {
    updateMetadataIndex(metadataState, pdfId, pageNumber, images.map((img) => ({
      image_path: img.relativePath,
      pdf_name: pdfId,
      page_number: pageNumber,
      topic: img.topic,
    })));
    metadataState.changed = true;
  }

  return images;
}

async function extractPdfData(pdfPath, metadataState, lastTopicRef) {
  const absolutePath = path.resolve(pdfPath);
  const displayName = displayNameFromPath(absolutePath);
  const pdfId = folderNameFromPdf(displayName);

  console.log(`📄 Loading PDF: ${absolutePath}`);
  const dataBuffer = fs.readFileSync(absolutePath);
  const dataUint8Array = new Uint8Array(dataBuffer);
  const standardFontDataUrl =
    path.join(require.resolve("pdfjs-dist/package.json"), "..", "standard_fonts") +
    path.sep;
  const loadingTask = pdfjsLib.getDocument({
    data: dataUint8Array,
    disableWorker: true,
    standardFontDataUrl,
  });
  const pdf = await loadingTask.promise;

  const pages = [];
  const imagesByPage = {};

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = buildPageText(textContent);
    const fallbackTopic = lastTopicRef.value || "";
    const topicLabel = extractTopicFromPage(
      textContent,
      pageText,
      fallbackTopic,
      pageNumber
    );
    lastTopicRef.value = topicLabel || lastTopicRef.value;

    const cachedEntries = getCachedPageImages(metadataState, pdfId, pageNumber);
    const cachedValid = cachedEntries.length > 0 && cachedEntries.every((entry) => {
      const filePath = resolveImagePath(entry.image_path || entry.relativePath);
      return filePath && fs.existsSync(filePath);
    });

    let images = [];
    if (cachedValid) {
      let needsTopicUpdate = false;
      images = cachedEntries.map((entry) => {
        if (topicLabel && entry.topic !== topicLabel) {
          entry.topic = topicLabel;
          needsTopicUpdate = true;
        }
        const relativePath = String(entry.image_path || entry.relativePath || "")
          .replace(/^[/\\]+/, "");
        return buildImageEntry({
          relativePath,
          pdfId,
          displayName,
          topic: entry.topic || topicLabel,
          pageNumber,
        });
      });
      if (needsTopicUpdate) metadataState.changed = true;
    } else {
      if (cachedEntries.length) {
        metadataState.entries = metadataState.entries.filter((entry) => {
          return !(
            entry.pdf_name === pdfId &&
            Number(entry.page_number) === pageNumber
          );
        });
        metadataState.changed = true;
      }
      images = await extractImagesFromPage({
        page,
        pdfId,
        displayName,
        pageNumber,
        topicLabel,
        metadataState,
      });
      if (!images.length) {
        updateMetadataIndex(metadataState, pdfId, pageNumber, []);
      }
    }

    if (images.length) {
      imagesByPage[pageNumber] = {
        topic: topicLabel,
        images,
      };
    }

    pages.push({
      pageIndex: pageNumber - 1,
      pageNumber,
      topic: topicLabel,
      text: pageText,
    });
  }

  console.log(`   Extracted ${pages.length} pages (${pdf.numPages} pages total)`);

  return {
    pdfId,
    displayName,
    pages,
    imagesByPage,
  };
}

/**
 * Read the PDFs, split their text into overlapping chunks,
 * and initialise the Gemini vector store.
 */
export async function initializePdfContext() {
  const { PDF_PATHS } = getConfig();
  const pdfPaths = Array.isArray(PDF_PATHS) ? PDF_PATHS : [];

  if (!pdfPaths.length) {
    throw new Error(
      "No PDF paths configured. Set PDF_PATHS in .env to include your PDFs."
    );
  }

  const existingPaths = pdfPaths
    .map((entry) => path.resolve(entry))
    .filter((entry) => fs.existsSync(entry));

  if (!existingPaths.length) {
    throw new Error(
      "No PDFs found on disk. Ensure your PDFs are in backend/data/ and update PDF_PATHS in .env."
    );
  }

  const missingPaths = pdfPaths
    .map((entry) => path.resolve(entry))
    .filter((entry) => !fs.existsSync(entry));

  if (missingPaths.length) {
    console.warn(
      "⚠️  Missing PDFs (skipping):",
      missingPaths.map((entry) => path.basename(entry)).join(", ")
    );
  }

  ensureDir(IMAGE_ROOT);
  const metadataEntries = loadImageMetadata();
  const metadataState = {
    entries: metadataEntries,
    index: buildMetadataIndex(metadataEntries),
    changed: false,
  };

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1200,
    chunkOverlap: 200,
    separators: ["\n\n", "\n", ". ", " ", ""],
  });

  rawText = "";
  for (const key of Object.keys(sourceTexts)) delete sourceTexts[key];
  for (const key of Object.keys(sourcePageTopics)) delete sourcePageTopics[key];
  const chunks = [];
  const imageIndex = {};
  let chunkIndex = 0;

  for (const pdfPath of existingPaths) {
    const lastTopicRef = { value: "" };
    const { pdfId, displayName, pages, imagesByPage } = await extractPdfData(
      pdfPath,
      metadataState,
      lastTopicRef
    );

    imageIndex[pdfId] = {
      displayName,
      pdfName: pdfId,
      pages: imagesByPage,
    };

    if (!sourceTexts[displayName]) {
      sourceTexts[displayName] = "";
    }
    if (!sourcePageTopics[displayName]) {
      sourcePageTopics[displayName] = [];
    }

    for (const page of pages) {
      if (!page.text) continue;

      rawText += `${page.text}\n\n`;
      sourceTexts[displayName] += `${page.text}\n\n`;
      sourcePageTopics[displayName].push({
        pageNumber: page.pageNumber,
        topic: page.topic,
        snippet: page.text.slice(0, 220).replace(/\s+/g, " ").trim(),
      });
      const pageChunks = await splitter.splitText(page.text);

      for (const chunkText of pageChunks) {
        chunks.push({
          text: chunkText,
          metadata: {
            source: pdfId,
            pdfId,
            pdfName: displayName,
            pageIndex: page.pageIndex,
            pageNumber: page.pageNumber,
            topic: page.topic,
            chunkIndex,
          },
        });
        chunkIndex += 1;
      }
    }
  }

  console.log(
    `   Created ${chunks.length} text chunks from ${existingPaths.length} PDFs`
  );

  cachedMetadata = metadataState.entries;
  if (metadataState.changed) {
    writeImageMetadata(metadataState.entries);
    console.log("🧾 Image metadata cached at uploads/extracted_images/image_metadata.json");
  }


  /* Boot the Gemini RAG pipeline with these chunks */
  await initializeGemini(chunks, imageIndex);
}

/** Return the full raw text (useful for debugging). */
export function getRawText() {
  return rawText;
}

/**
 * Build Live API system context with equal space per PDF source
 * so Mushaba Rag is not truncated when Nucleus profile is large.
 */
export function getBalancedLiveContext(maxPerSource = 8000) {
  const entries = Object.entries(sourceTexts);
  if (!entries.length) return getRawText().slice(0, maxPerSource * 2);

  // Dynamically cap so we don't blow up the system instruction token limit (max ~80k chars total)
  const safeMax = Math.min(maxPerSource, Math.floor(60000 / entries.length));

  return entries
    .map(([name, text]) => {
      const excerpt = (text || "").trim().slice(0, safeMax);
      return `## Document: ${name}\n${excerpt || "(empty)"}`;
    })
    .join("\n\n---\n\n");
}

export function getSourceNames() {
  return Object.keys(sourceTexts);
}

export function getSourceTopicIndexes(maxLinesPerSource = 260) {
  const entries = Object.entries(sourcePageTopics);
  // Dynamically cap lines so the index doesn't explode
  const safeMaxLines = Math.min(maxLinesPerSource, Math.floor(150 / Math.max(1, entries.length)));

  return entries
    .map(([name, pages]) => {
      const lines = (pages || [])
        .slice(0, safeMaxLines)
        .map((page) => {
          const topic = String(page.topic || "").replace(/\s+/g, " ").trim();
          const snippet = String(page.snippet || "").replace(/\s+/g, " ").trim();
          const detail = topic && snippet && !snippet.includes(topic)
            ? `${topic} - ${snippet}`
            : topic || snippet || "Untitled topic";
          return `Page ${page.pageNumber}: ${detail}`;
        });
      return `## Topic Index: ${name}\n${lines.join("\n")}`;
    })
    .join("\n\n---\n\n");
}

// pdfService.js mein add karo
export function getPdfSourceCatalog() {
  const entries = getImageMetadata();
  const map = new Map();

  for (const e of entries) {
    const key = e.pdf_name;
    if (!key || map.has(key)) continue;
    map.set(key, true);
  }

  // Human-readable display names — har naye pdf_name ke liye yahan map add karte raho
  const DISPLAY_NAME_MAP = {
    nucleus_distribution: "Nucleus Distribution (company profile)",
    ac: "IOTFIY AC-Kit",
    easy_solar: "EASY Solar",
    ecosystem: "IOTFIY Ecosystem Overview",
    epsn: "Enterprise Private Social Network (EPSN)",
    iotfiy_gateway: "IOTFIY Gateway (dashboard & widgets product)",
    iotfiy: "IOTFIY General / AI Computer Vision & Company Overview",
    mushaba_rag: "Mushaba Rag (Hajj/Umrah pilgrim navigation)",
    nucleus_vericom: "Nucleus Vericom (cables & networking infrastructure)",
    packtrack: "PackTrack AI logistics automation",
    polekit: "PoleKit electrical pole leakage detection",
    sales_hub: "IOTFIY Sales Hub",
    services: "IOTFIY Services (general solutions: gas detection, weather, GameNest, theft detection, etc.)",
    social_app: "Enterprise event/social platform",
    studio: "3D AI Chatbot & Immersive Customer Experience (Studio)",
    tour: "Mushaba/Pilgrim Navigation Tour features",
  };

  return [...map.keys()].map((key) => ({
    pdfId: key,
    displayName: DISPLAY_NAME_MAP[key] || key,
  }));
}
