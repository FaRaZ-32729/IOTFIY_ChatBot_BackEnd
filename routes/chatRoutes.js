import { Router } from "express";
import { uploadAudio } from "../middleware/upload.js";
import {
  handleTextMessage,
  handleVoiceMessage,
  getChatHistory,
} from "../controllers/chatController.js";

const router = Router();

/* Text-based chat */
router.post("/text", handleTextMessage);

/* Voice-based chat (multipart audio upload) */
router.post("/voice", (req, res, next) => {
  uploadAudio(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    handleVoiceMessage(req, res, next);
  });
});

/* Fetch session history */
router.get("/history/:sessionId", getChatHistory);

export default router;
