/**
 * User Session Service — manages per-user interest tracking,
 * conversation history, and user details persistence.
 */
import UserSession from "../models/UserSession.js";

/* ── Topic detection keywords ─────────────────────────────────── */
const TOPIC_PATTERNS = [
  {
    field: "mushaba_count",
    patterns: [/mushaba/i, /moshaba/i, /mashaba/i, /mush\s*aba/i, /mosha\s*ba/i],
  },
  {
    field: "nucleus_distribution_count",
    patterns: [/nucleus/i, /distribution/i, /nucleus\s*distribution/i, /iotfi/i, /iotfiy/i, /nucle\s*us/i, /distri\s*bution/i],
  },
];

/**
 * Detect which topics a user query matches and return field names to increment.
 */
export function detectTopics(query) {
  if (!query || typeof query !== "string") return [];
  const matched = [];
  // Also test space-stripped version for fragmented voice transcription
  const stripped = query.replace(/\s+/g, "");
  for (const { field, patterns } of TOPIC_PATTERNS) {
    if (patterns.some((p) => p.test(query) || p.test(stripped))) {
      matched.push(field);
    }
  }
  return matched;
}

/**
 * Get or create a user session by userId.
 */
export async function getOrCreateSession(userId) {
  let session = await UserSession.findOne({ user_id: userId });
  if (!session) {
    session = await UserSession.create({
      user_id: userId,
      session_active: true,
    });
  }
  return session;
}

/**
 * Track a user interaction: add to conversation history, detect topics,
 * increment counters, and add timestamp.
 */
export async function trackInteraction(userId, role, content) {
  const session = await getOrCreateSession(userId);

  // Add to conversation history
  session.conversation_history.push({
    role,
    content,
    timestamp: new Date(),
  });

  // Track timestamp
  session.timestamps.push(new Date());

  session.session_active = true;
  await session.save();

  return {
    session,
  };
}

/**
 * Save user details collected at end of chat.
 */
export async function saveUserDetails(userId, details) {
  const session = await getOrCreateSession(userId);

  session.user_details = {
    name: details.name || details.full_name || "",
    company: details.company || details.company_name || "",
    designation: details.designation || details.jobTitle || details.job_title || "",
    phone: details.phone || "",
    email: details.email || "",
    city: details.city || "",
  };

  session.session_active = false;
  await session.save();
  return session;
}

/**
 * (Interest stats are now tracked in memory and saved to Lead instead)
 */
export async function getInterestStats(userId) {
  return {
    mushaba_count: 0,
    nucleus_distribution_count: 0,
  };
}

/**
 * End a user session — mark as inactive.
 */
export async function endSession(userId) {
  const session = await UserSession.findOne({ user_id: userId });
  if (session) {
    session.session_active = false;
    await session.save();
  }
  return session;
}
