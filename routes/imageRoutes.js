import express from "express";
import { getAvailablePdfImages, retrieveRelatedImages } from "../services/geminiService.js";
import { getImageMetadata } from "../services/pdfService.js";

const router = express.Router();

router.get("/", (_req, res) => {
  try {
    const images = getAvailablePdfImages();
    res.json({ success: true, data: images });
  } catch (err) {
    console.error("Failed to get available images:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/metadata", (_req, res) => {
  try {
    const metadata = getImageMetadata();
    res.json({ success: true, data: metadata || [] });
  } catch (err) {
    console.error("Failed to get image metadata:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/search", async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();
    if (!query) {
      return res.status(400).json({ success: false, error: "Query is required." });
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 12) : 8;
    const images = await retrieveRelatedImages(query, limit);
    res.json({ success: true, data: images });
  } catch (err) {
    console.error("Failed to search images:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
