import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PathInput, Client, product } from "mindee";

const router = express.Router();

/**
 * Disk-backed upload to avoid large in-memory buffers and SDK byteLength issues.
 */
const uploadDir = path.join(os.tmpdir(), "mindee-card-scan");
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file?.originalname || "") || ".jpg";
      cb(null, `card_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

/**
 * Recursively extract a human-readable string from any Mindee field shape.
 */
function normalizeFieldValue(field) {
  if (field == null) return "";
  if (typeof field === "string") return field.trim();
  if (typeof field === "number" || typeof field === "boolean") return String(field);

  if (Array.isArray(field)) {
    return field.map((item) => normalizeFieldValue(item)).filter(Boolean).join(", ");
  }

  if (typeof field === "object") {
    if (typeof field.stringValue === "string" && field.stringValue.trim()) return field.stringValue.trim();
    if (field.value !== undefined && field.value !== null) return normalizeFieldValue(field.value);
    if (typeof field.content === "string" && field.content.trim()) return field.content.trim();
    if (typeof field.raw_value === "string" && field.raw_value.trim()) return field.raw_value.trim();
    if (typeof field.toString === "function") {
      const text = field.toString();
      if (text && text !== "[object Object]") return text.trim();
    }
  }
  return "";
}

function labelFromKey(key) {
  return key.replace(/_/g, " ").replace(/([A-Z])/g, " $1").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

/**
 * Extract all non-empty fields from a prediction/result object.
 */
function extractAllFields(obj) {
  if (!obj || typeof obj !== "object") return [];
  const result = [];

  const entries = obj instanceof Map ? [...obj.entries()] : Object.entries(obj);
  for (const [key, val] of entries) {
    if (key.startsWith("_") || key === "extras" || key === "raw_value") continue;
    const value = normalizeFieldValue(val);
    if (value) {
      result.push({ key, label: labelFromKey(key), value });
    }
  }
  return result;
}

/**
 * Map extracted fields to known card data schema.
 */
function mapToCardData(fields) {
  const f = {};
  for (const { key, value } of fields) f[key.toLowerCase()] = value;

  const pick = (...keys) => {
    for (const k of keys) if (f[k]) return f[k];
    return "";
  };

  return {
    firstName: pick("first_name", "firstname", "given_name", "first name"),
    lastName: pick("last_name", "lastname", "surname", "family_name", "last name"),
    fullName: pick("name", "full_name", "fullname", "contact_name"),
    company: pick("company", "company_name", "organization", "organisation", "employer"),
    designation: pick("designation", "job_title", "jobtitle", "job_position", "position", "title", "role"),
    jobTitle: pick("job_title", "jobtitle", "job_position", "position", "title", "role", "designation"),
    email: pick("email", "email_address", "e_mail", "mail"),
    phone: pick("phone_number", "phone", "mobile", "tel", "telephone", "contact_number", "cell"),
    website: pick("website", "url", "web", "linkedin"),
    address: pick("address", "location", "city", "country"),
  };
}

function parseCardTextFallback(text) {
  const source = String(text || "").replace(/\r/g, "\n");
  const lines = source
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const email = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const phone = source.match(/(?:\+?\d[\d\s().-]{6,}\d)/)?.[0]?.trim() || "";
  const website = source.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?\b/i)?.[0] || "";

  const ignored = /(email|mail|phone|mobile|tel|cell|www\.|http|address|street|road|linkedin|facebook|instagram)/i;
  const likelyName = lines.find((line) => {
    if (ignored.test(line)) return false;
    if (email && line.includes(email)) return false;
    if (phone && line.includes(phone)) return false;
    const words = line.split(/\s+/);
    return words.length >= 2 && words.length <= 4 && words.every((word) => /^[A-Za-z][A-Za-z.'-]*$/.test(word));
  }) || "";

  const company = lines.find((line) => {
    if (line === likelyName || ignored.test(line)) return false;
    return /(pvt|ltd|llc|inc|company|solutions|technologies|systems|group|enterprises|distribution)/i.test(line);
  }) || "";

  const address = lines.find((line) => {
    if (line === likelyName || line === company) return false;
    return /(karachi|lahore|islamabad|rawalpindi|pakistan|road|street|sector|floor|office|suite|block|city)/i.test(line);
  }) || "";

  const [firstName = "", ...restName] = likelyName.split(/\s+/);

  return {
    firstName,
    lastName: restName.join(" "),
    fullName: likelyName,
    company,
    designation: "",
    jobTitle: "",
    email,
    phone,
    website,
    address,
  };
}

function mergeCardData(primary, fallback) {
  const merged = { ...primary };
  for (const [key, value] of Object.entries(fallback || {})) {
    if (!merged[key] && value) merged[key] = value;
  }
  return merged;
}

async function runMindeeExtractionWithSdk({ mindeeClient, modelId, inputPath }) {
  const inputSource = new PathInput({ inputPath });

  return mindeeClient.enqueueAndGetResult(
    product.extraction.Extraction,
    inputSource,
    { modelId: String(modelId).trim() },
    { initialDelaySec: 2, delaySec: 1.5, maxRetries: 40 }
  );
}

function toPredictionObject(response) {
  return response?.inference?.result?.fields || response?.inference?.prediction || {};
}

async function enqueueViaHttp({ apiKey, modelId, filePath, mimeType, filename }) {
  const bytes = await fs.readFile(filePath);
  const form = new FormData();
  form.set("model_id", modelId);
  form.set("file", new Blob([bytes], { type: mimeType || "application/octet-stream" }), filename || "card.png");

  const res = await fetch("https://api-v2.mindee.net/v2/products/extraction/enqueue", {
    method: "POST",
    headers: { Authorization: apiKey },
    body: form,
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = payload?.detail || payload?.title || `HTTP ${res.status}`;
    throw new Error(`Mindee enqueue failed: ${detail}`);
  }

  const jobId = payload?.job?.id;
  if (!jobId) {
    throw new Error("Mindee enqueue succeeded but no job ID was returned.");
  }

  return jobId;
}

async function pollJobAndFetchResult({ apiKey, jobId, mindeeClient, maxRetries = 45, delayMs = 1500 }) {
  let lastPollError = null;
  for (let i = 0; i < maxRetries; i += 1) {
    let jobPayload;
    try {
      const jobResponse = await mindeeClient.getJob(jobId);
      jobPayload = { job: jobResponse?.job };
    } catch (pollErr) {
      lastPollError = pollErr?.message || "Unknown polling error";
      if (i % 10 === 0) {
        console.warn(`Mindee poll retry ${i + 1}/${maxRetries}: ${lastPollError}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    const status = jobPayload?.job?.status;
    const resultUrl = jobPayload?.job?.result_url || jobPayload?.job?.resultUrl;
    const remoteError = jobPayload?.job?.error;

    if (remoteError) {
      throw new Error(remoteError?.detail || remoteError?.message || "Mindee job failed.");
    }

    if (i % 10 === 0) {
      console.log(`Mindee poll ${i + 1}/${maxRetries}: status=${status || "unknown"}`);
    }

    if ((status === "Processed" || status === "Completed") && resultUrl) {
      const resultRes = await fetch(resultUrl, {
        headers: { Authorization: apiKey },
      });
      const resultPayload = await resultRes.json().catch(() => null);
      if (!resultRes.ok) {
        const detail = resultPayload?.detail || resultPayload?.title || `HTTP ${resultRes.status}`;
        throw new Error(`Mindee result fetch failed: ${detail}`);
      }
      return resultPayload;
    }

    if (status === "Failed") {
      throw new Error("Mindee job status is Failed.");
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(
    `Mindee polling timed out before result was available.${lastPollError ? ` Last poll error: ${lastPollError}` : ""}`
  );
}

/**
 * POST /api/card-scan
 *
 * Uses Mindee SDK with PathInput for visiting-card OCR.
 */
router.post("/", async (req, res) => {
  console.log("\n========== Card Scan Request (SDK PathInput) ==========");

  await fs.mkdir(uploadDir, { recursive: true });
  let tempFilePath = null;

  try {
    // 1. Process Multipart upload
    await new Promise((resolve, reject) => {
      upload.single("image")(req, res, (err) => (err ? reject(err) : resolve()));
    });

    const file = req.file;
    if (!file?.path) {
      return res.status(400).json({ success: false, error: "No image file provided." });
    }

    if (!file.size || file.size <= 0) {
      return res.status(400).json({ success: false, error: "Uploaded image is empty." });
    }

    tempFilePath = file.path;

    const apiKey = String(process.env.MINDEE_API_KEY || "").trim();
    const modelId = String(process.env.MINDEE_MODEL_ID || "").trim();
    const mindeeClient = new Client({ apiKey });

    if (!apiKey || !modelId) {
      throw new Error("MINDEE_API_KEY or MINDEE_MODEL_ID missing from .env");
    }

    console.log(`Uploaded file path: ${tempFilePath} (size=${file.size} bytes, mime=${file.mimetype || "unknown"})`);

    // 2. Send to Mindee SDK for extraction
    console.log("Sending to Mindee SDK for processing...");
    let response;
    try {
      response = await runMindeeExtractionWithSdk({ mindeeClient, modelId, inputPath: tempFilePath });
    } catch (sdkErr) {
      const sdkMsg = sdkErr?.message || "Unknown SDK error";
      console.warn("SDK extraction failed, switching to direct HTTP enqueue+poll:", sdkMsg);

      const jobId = await enqueueViaHttp({
        apiKey,
        modelId,
        filePath: tempFilePath,
        mimeType: file.mimetype,
        filename: file.originalname || path.basename(tempFilePath),
      });
      response = await pollJobAndFetchResult({ apiKey, jobId, mindeeClient });
    }

    // 3. Extract data from response
    const prediction = toPredictionObject(response);
    
    const allFields = extractAllFields(prediction);
    console.log(`Extracted ${allFields.length} field(s) via SDK`);

    const rawDisplayText = typeof response?.inference?.toString === "function"
      ? response.inference.toString()
      : "";
    let cardData = mapToCardData(allFields);

    if (!cardData.firstName && !cardData.lastName && cardData.fullName) {
      const parts = cardData.fullName.trim().split(/\s+/);
      cardData.firstName = parts[0] || "";
      cardData.lastName = parts.slice(1).join(" ") || "";
    }

    let fieldList = allFields.length > 0 
      ? allFields 
      : Object.entries(cardData)
          .filter(([, v]) => v)
          .map(([key, value]) => ({ key, label: labelFromKey(key), value }));

    let summaryText = fieldList.map((f) => `${f.label}: ${f.value}`).join("\n");
    const fallbackData = parseCardTextFallback(`${summaryText}\n${rawDisplayText}`);
    cardData = mergeCardData(cardData, fallbackData);

    const fallbackFields = Object.entries(cardData)
      .filter(([, value]) => value)
      .map(([key, value]) => ({ key, label: labelFromKey(key), value }));

    if (fallbackFields.length > fieldList.length) {
      fieldList = fallbackFields;
      summaryText = fieldList.map((f) => `${f.label}: ${f.value}`).join("\n");
    }

    if (!summaryText.trim()) {
      return res.json({
        success: true,
        data: {
          ...cardData,
          text: "",
          displayText: "No data could be extracted. Try a clearer photo.",
          fields: [],
        },
      });
    }

    console.log("✅ SDK Extraction successful!");
    
    res.json({
      success: true,
      data: {
        ...cardData,
        text: summaryText,
        displayText: summaryText,
        fields: fieldList,
      },
    });

  } catch (error) {
    console.error("❌ Card scan error:", error?.message || error);
    if (error?.stack) {
      console.error(error.stack);
    }
    res.status(500).json({
      success: false,
      error: `Mindee OCR failed: ${error.message || "Unknown error"}`,
    });
  } finally {
    // 4. Cleanup temp file
    if (tempFilePath) {
      try {
        await fs.unlink(tempFilePath);
        console.log(`Cleaned up temp file: ${tempFilePath}`);
      } catch (cleanupErr) {
        console.warn(`Failed to cleanup temp file ${tempFilePath}:`, cleanupErr.message);
      }
    }
  }
});

export default router;
