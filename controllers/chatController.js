/**
 * Chat Controller
 * ─────────────────────────────────────────────
 * Handles three endpoints:
 *   POST /text   — text-based chat
 *   POST /voice  — voice-based chat (audio → Whisper → Gemini → TTS)
 *   GET  /history — fetch chat history for a session
 */
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { transcribeAudio } from "../services/whisperService.js";
import { generateResponse } from "../services/geminiService.js";
import { generateSpeech } from "../services/ttsService.js";
import ChatSession from "../models/ChatSession.js";
import { getConfig } from "../config/keys.js";

/* ─────── helpers ─────── */

async function getOrCreateSession(sessionId) {
  let session = await ChatSession.findOne({ sessionId });
  if (!session) {
    session = new ChatSession({ sessionId, messages: [] });
  }
  return session;
}

function chatHistoryFromSession(session) {
  return session.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

function withTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/* ─────── POST /api/chat/text ─────── */

export async function handleTextMessage(req, res, next) {
  try {
    const { message, sessionId: clientSessionId } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ success: false, error: "Message is required." });
    }

    const sessionId = clientSessionId || uuidv4();
    const session = await getOrCreateSession(sessionId);
    const chatHistory = chatHistoryFromSession(session);
    const { ENABLE_TTS, TTS_TIMEOUT_MS } = getConfig();

    /* 1. Generate Gemini response */
    const textResponse = await generateResponse(message.trim(), chatHistory);

    /* 2. Generate TTS audio */
    let audioBase64 = null;
    if (ENABLE_TTS) {
      try {
        audioBase64 = await withTimeout(
          generateSpeech(textResponse),
          TTS_TIMEOUT_MS
        );
      } catch (ttsErr) {
        console.warn("⚠️  TTS generation failed (non-fatal):", ttsErr.message);
      }
    }

    /* 3. Persist to MongoDB */
    session.messages.push(
      { role: "user", content: message.trim(), language: "en" },
      {
        role: "assistant",
        content: textResponse,
        hasAudio: !!audioBase64,
      }
    );
    await session.save();

    return res.json({
      success: true,
      data: {
        sessionId,
        textResponse,
        audioBase64,
        transcription: null,
      },
    });
  } catch (err) {
    next(err);
  }
}

/* ─────── POST /api/chat/voice ─────── */

export async function handleVoiceMessage(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Audio file is required." });
    }

    const sessionId = req.body.sessionId || uuidv4();
    const session = await getOrCreateSession(sessionId);
    const chatHistory = chatHistoryFromSession(session);
    const { ENABLE_TTS, TTS_TIMEOUT_MS } = getConfig();

    /* 1. Transcribe with Whisper */
    const { text: transcription, language } = await transcribeAudio(
      req.file.path,
      req.file.mimetype
    );

    if (!transcription || !transcription.trim()) {
      return res.status(400).json({
        success: false,
        error: "Could not transcribe audio. Please try again.",
      });
    }

    /* 2. Generate Gemini response */
    const textResponse = await generateResponse(transcription.trim(), chatHistory);

    /* 3. Generate TTS audio */
    let audioBase64 = null;
    if (ENABLE_TTS) {
      try {
        audioBase64 = await withTimeout(
          generateSpeech(textResponse),
          TTS_TIMEOUT_MS
        );
      } catch (ttsErr) {
        console.warn("⚠️  TTS generation failed (non-fatal):", ttsErr.message);
      }
    }

    /* 4. Persist to MongoDB */
    session.messages.push(
      {
        role: "user",
        content: transcription.trim(),
        transcription: transcription.trim(),
        language,
      },
      {
        role: "assistant",
        content: textResponse,
        hasAudio: !!audioBase64,
      }
    );
    await session.save();

    /* 5. Cleanup uploaded file */
    fs.unlink(req.file.path, () => {});

    return res.json({
      success: true,
      data: {
        sessionId,
        textResponse,
        audioBase64,
        transcription: transcription.trim(),
        detectedLanguage: language,
      },
    });
  } catch (err) {
    /* Cleanup on error too */
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    next(err);
  }
}

/* ─────── GET /api/chat/history/:sessionId ─────── */

export async function getChatHistory(req, res, next) {
  try {
    const { sessionId } = req.params;

    const session = await ChatSession.findOne({ sessionId });
    if (!session) {
      return res.json({ success: true, data: { sessionId, messages: [] } });
    }

    return res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        messages: session.messages,
        createdAt: session.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
}
