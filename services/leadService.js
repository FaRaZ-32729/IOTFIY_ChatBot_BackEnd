import Lead from "../models/Lead.js";

function normalizeCount(value) {
  return Math.max(0, Number(value) || 0);
}

export async function saveLead({
  name,
  company,
  designation,
  phone,
  email,
  sessionId,
  mushaba_count,
  nucleus_distribution_count,
}) {
  const payload = {
    source: "voice-live",
  };

  if (name !== undefined) payload.name = String(name || "").trim();
  if (company !== undefined) payload.company = String(company || "").trim();
  if (designation !== undefined) payload.designation = String(designation || "").trim();
  if (phone !== undefined) payload.phone = String(phone || "").trim();
  if (email !== undefined) payload.email = String(email || "").trim().toLowerCase();
  if (sessionId !== undefined) payload.sessionId = sessionId || null;
  if (mushaba_count !== undefined) payload.mushaba_count = normalizeCount(mushaba_count);
  if (nucleus_distribution_count !== undefined) {
    payload.nucleus_distribution_count = normalizeCount(nucleus_distribution_count);
  }

  const hasLeadDetails = Boolean(payload.name && payload.phone && payload.email);
  if (!hasLeadDetails) {
    throw new Error("Cannot create a lead without name, phone, and email.");
  }

  const lead = await Lead.create(payload);
  console.log("[LEAD] Lead created:", lead._id, "counts:", {
    mushaba: lead.mushaba_count,
    nucleus: lead.nucleus_distribution_count,
  });
  return lead;
}
