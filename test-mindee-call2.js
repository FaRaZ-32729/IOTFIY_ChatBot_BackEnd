import { BufferInput, Base64Input, Client, product } from 'mindee';

function formatFieldLabel(fieldName) {
  return fieldName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeFieldValue(field) {
  if (field == null) return "";

  if (Array.isArray(field)) {
    return field.map((item) => normalizeFieldValue(item)).filter(Boolean).join(", ");
  }

  if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") {
    return String(field);
  }

  if (typeof field === "object") {
    if (typeof field.stringValue === "string" && field.stringValue.trim()) {
      return field.stringValue;
    }

    if (field.value !== undefined && field.value !== null) {
      return normalizeFieldValue(field.value);
    }

    if (typeof field.content === "string" && field.content.trim()) {
      return field.content;
    }

    if (typeof field.toString === "function") {
      const text = field.toString();
      if (text && text !== "[object Object]") {
        return text;
      }
    }
  }

  return "";
}

function extractFieldList(fields) {
  if (!fields) return [];

  const entries = fields instanceof Map ? [...fields.entries()] : Object.entries(fields);

  return entries
    .map(([fieldName, field]) => {
      const value = normalizeFieldValue(field).trim();
      if (!value) return null;

      return {
        key: fieldName,
        label: formatFieldLabel(fieldName),
        value,
      };
    })
    .filter(Boolean);
}

async function test() {
  const client = new Client({ apiKey: 'md_5nhFrKQwTnyOx6ecbO1bnVSDtaIN5348B77nhIXs8Cs' });
  const modelId = 'c7f1a486-8f56-43f3-af62-b631535d60b3'; // the UUID from env
  
  // Create a 1x1 png base64 string
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const fileBuffer = Buffer.from(pngBase64, 'base64');
  
  const inputSource = new BufferInput({
    buffer: fileBuffer,
    filename: 'test.png',
  });

  try {
    const response = await client.enqueueAndGetResult(
      product.extraction.Extraction,
      inputSource,
      { modelId },
      { initialDelaySec: 2, delaySec: 1.5, maxRetries: 2 }
    );
    
    const inference = response?.inference;
    let displayText = "N/A";
    try {
      displayText = typeof inference?.toString === "function" ? inference.toString() : "No toString";
    } catch (e) {
      console.error("toString error:", e);
    }
    
    let fieldList = [];
    try {
      fieldList = extractFieldList(inference?.result?.fields);
    } catch (e) {
      console.error("extractFieldList error:", e);
    }

    console.log("Success! Display Text:", displayText.substring(0, 50));
    console.log("Fields:", fieldList);
  } catch (error) {
    console.error("Error from enqueueAndGetResult:", error.message || error);
  }
}

test();
