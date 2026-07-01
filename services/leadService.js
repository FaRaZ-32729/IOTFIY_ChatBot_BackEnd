import Lead from "../models/Lead.js";

function normalizeToArray(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
  }
  // Single string — agar comma/semicolon/"and" se separate kiye gaye hon to split karo
  const parts = String(value)
    .split(/[,;]|(?:\s+and\s+)/i)
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

export async function saveLead({
  name,
  company,
  designation,
  phone,
  email,
  sessionId,
  topic_counts,
}) {
  const payload = {
    source: "voice-live",
  };

  if (name !== undefined) payload.name = String(name || "").trim();
  if (company !== undefined) payload.company = String(company || "").trim();
  if (designation !== undefined) payload.designation = String(designation || "").trim();
  if (phone !== undefined) payload.phone = normalizeToArray(phone);
  if (email !== undefined) payload.email = normalizeToArray(email).map((e) => e.toLowerCase());
  if (sessionId !== undefined) payload.sessionId = sessionId || null;

  const hasLeadDetails = Boolean(payload.name && payload.phone?.length && payload.email?.length);
  if (!hasLeadDetails) {
    throw new Error("Cannot create a lead without name, phone, and email.");
  }

  if (topic_counts) {
    if (!payload.topic_counts) payload.topic_counts = new Map();
    for (const [key, val] of Object.entries(topic_counts)) {
      payload.topic_counts.set(key, val);
    }
  }

  const lead = await Lead.create(payload);
  return lead;
}
