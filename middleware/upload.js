/**
 * Multer upload middleware for audio files.
 */
import multer from "multer";
import path from "path";
import fs from "fs";

const uploadDir = path.resolve("uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `audio-${unique}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const mimetype = (file.mimetype || "").toLowerCase();
  const isAudio = mimetype.startsWith("audio/");
  const isWebmVideo = mimetype.startsWith("video/webm");

  if (isAudio || isWebmVideo || mimetype === "application/octet-stream") {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported audio format: ${file.mimetype}`), false);
  }
};

export const uploadAudio = multer({
  storage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB (Whisper limit)
}).single("audio");
