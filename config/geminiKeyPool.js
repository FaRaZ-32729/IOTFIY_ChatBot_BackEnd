/**
 * Rotates across multiple Gemini API keys when quota / rate-limit is hit.
 *
 * Configure in .env:
 *   GOOGLE_API_KEY=primary_key
 *   GOOGLE_API_KEYS=key1,key2,key3,key4
 * (GOOGLE_API_KEY is always included if not already in the list)
 */

let apiKeys = [];
let currentIndex = 0;
const exhaustedKeys = new Set();
let initialized = false;

function normalizeKey(value) {
  return String(value || "").trim();
}

export function maskGeminiApiKey(key) {
  const k = normalizeKey(key);
  if (k.length <= 10) return "***";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

export function parseGeminiApiKeysFromEnv(env = process.env) {
  const keys = [];
  const add = (value) => {
    const key = normalizeKey(value);
    if (key && !keys.includes(key)) keys.push(key);
  };

  add(env.GOOGLE_API_KEY);

  const listValue = env.GOOGLE_API_KEYS || env.GEMINI_API_KEYS || "";
  if (listValue) {
    listValue.split(/[,;\n]+/).forEach(add);
  }

  for (const [name, value] of Object.entries(env)) {
    if (/^GEMINI_API_KEY(_\d+)?$/i.test(name)) add(value);
  }

  return keys;
}

export function initGeminiKeyPool(env = process.env) {
  apiKeys = parseGeminiApiKeysFromEnv(env);
  currentIndex = 0;
  exhaustedKeys.clear();
  initialized = true;

  if (apiKeys.length) {
    console.log(
      `🔑 Gemini key pool ready: ${apiKeys.length} key(s), active=${maskGeminiApiKey(apiKeys[0])}`
    );
  }

  return apiKeys.length;
}

function ensurePool() {
  if (!initialized) initGeminiKeyPool();
}

export function getGeminiKeyCount() {
  ensurePool();
  return apiKeys.length;
}

export function getGeminiApiKey() {
  ensurePool();
  if (!apiKeys.length) return "";
  return apiKeys[currentIndex] || apiKeys[0];
}

export function getGeminiKeyPoolInfo() {
  ensurePool();
  return {
    total: apiKeys.length,
    activeIndex: currentIndex,
    activeKey: maskGeminiApiKey(getGeminiApiKey()),
    exhausted: exhaustedKeys.size,
    available: apiKeys.length - exhaustedKeys.size,
  };
}

/** Detect quota / rate-limit errors from Gemini SDK or HTTP responses. */
export function isGeminiQuotaError(error) {
  const parts = [
    error?.message,
    error?.statusText,
    error?.code,
    error?.status,
    error?.reason,
    error?.details,
    error?.error?.message,
    error?.error?.status,
    error?.error?.code,
  ]
    .filter((v) => v !== undefined && v !== null)
    .map(String)
    .join(" ")
    .toLowerCase();

  if (!parts) return false;

  return (
    /quota|rate limit|rate_limit|resource_exhausted|resource exhausted|too many requests|429|exceeded|billing|limit: 0|permission denied.*quota/.test(
      parts
    ) ||
    parts.includes("429") ||
    parts.includes("resource_exhausted")
  );
}

/**
 * Mark a key as exhausted and advance to the next available key.
 * @returns {string|null} next key, or null if all keys are exhausted
 */
export function rotateGeminiApiKey(failedKey = null) {
  ensurePool();
  if (!apiKeys.length) return null;

  const failed = normalizeKey(failedKey || apiKeys[currentIndex]);
  if (failed) exhaustedKeys.add(failed);

  for (let step = 1; step <= apiKeys.length; step += 1) {
    const nextIndex = (currentIndex + step) % apiKeys.length;
    const candidate = apiKeys[nextIndex];
    if (!exhaustedKeys.has(candidate)) {
      currentIndex = nextIndex;
      console.warn(
        `🔑 Gemini key rotated → ${maskGeminiApiKey(candidate)} (${getGeminiKeyPoolInfo().available}/${apiKeys.length} available)`
      );
      return candidate;
    }
  }

  console.error("❌ All Gemini API keys exhausted (quota reached on every key).");
  return null;
}

/** Reset exhausted flags — useful after daily quota reset (optional manual call). */
export function resetGeminiKeyPool() {
  ensurePool();
  exhaustedKeys.clear();
  currentIndex = 0;
  console.log("🔑 Gemini key pool reset — all keys available again.");
}
