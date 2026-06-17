import { Router } from "express";
import Lead from "../models/Lead.js";
import { saveLead } from "../services/leadService.js";
import { liveSessionStats } from "../services/liveGeminiBridge.js";

const router = Router();

/**
 * POST /api/leads — Save or update a lead
 */
router.post("/", async (req, res, next) => {
  try {
    const { name, company, designation, phone, email, sessionId } = req.body || {};
    if (!name?.trim() || !phone?.trim() || !email?.trim()) {
      return res.status(400).json({
        success: false,
        error: "name, phone, and email are required",
      });
    }

    // Include in-memory topic counts so they aren't lost when
    // the frontend submits the form directly
    const counts = sessionId ? (liveSessionStats.get(sessionId) || {}) : {};

    const lead = await saveLead({
      name, company, designation, phone, email, sessionId,
      mushaba_count: counts.mushaba_count || undefined,
      nucleus_distribution_count: counts.nucleus_distribution_count || undefined,
    });
    res.status(201).json({ success: true, lead });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/leads — List all leads (for analytics dashboard)
 */
router.get("/", async (_req, res, next) => {
  try {
    const leads = await Lead.find()
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, leads });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/leads/analytics — Aggregate analytics across all leads
 *
 * Returns:
 * - totalLeads: number of leads collected
 * - totalMushaba: sum of all mushaba_count values
 * - totalNucleusDistribution: sum of all nucleus_distribution_count values
 * - activeSessions: current in-memory topic stats for live sessions
 */
router.get("/analytics", async (_req, res, next) => {
  try {
    const [aggregation] = await Lead.aggregate([
      {
        $group: {
          _id: null,
          totalLeads: { $sum: 1 },
          totalMushaba: { $sum: "$mushaba_count" },
          totalNucleusDistribution: { $sum: "$nucleus_distribution_count" },
        },
      },
    ]);

    // Also include in-flight session stats (not yet persisted to Lead)
    const activeSessions = {};
    for (const [sessionId, stats] of liveSessionStats.entries()) {
      activeSessions[sessionId] = { ...stats };
    }

    res.json({
      success: true,
      analytics: {
        totalLeads: aggregation?.totalLeads || 0,
        totalMushaba: aggregation?.totalMushaba || 0,
        totalNucleusDistribution: aggregation?.totalNucleusDistribution || 0,
        activeSessionCount: liveSessionStats.size,
        activeSessions,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/leads/:sessionId — Get a specific lead by session ID
 */
router.get("/:sessionId", async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ sessionId: req.params.sessionId }).lean();
    if (!lead) {
      return res.status(404).json({ success: false, error: "Lead not found" });
    }
    res.json({ success: true, lead });
  } catch (err) {
    next(err);
  }
});

export default router;
