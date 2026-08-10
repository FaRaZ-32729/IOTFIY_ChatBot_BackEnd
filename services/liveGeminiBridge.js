/**
 * Bridges one browser WebSocket client ↔ Gemini Multimodal Live API (@google/genai).
 */
import { GoogleGenAI, Modality } from "@google/genai";
import { getConfig } from "../config/keys.js";
import {
  getGeminiApiKey,
  rotateGeminiApiKey,
  isGeminiQuotaError,
  maskGeminiApiKey,
  getGeminiKeyCount,
} from "../config/geminiKeyPool.js";
import { saveLead } from "./leadService.js";
import {
  buildLiveSystemInstruction,
  SUBMIT_LEAD_TOOL,
} from "./liveSystemPrompt.js";
import {
  clearLiveRagSession,
  pickImagesForLive,
  resolveImagePdfTopic,
  inferTopicFromAssistantSpeech,
} from "./liveRagService.js";

const FALLBACK_LIVE_MODELS = [
  "gemini-3.1-flash-live-preview",
  "gemini-live-2.5-flash-preview",
  "gemini-2.0-flash-live-001",
];

// In-memory tracker for counts during a session
export const liveSessionStats = new Map();

// Buffer to accumulate fragmented user transcription chunks.
// Voice transcription arrives word-by-word; we accumulate until
// the utterance is marked "finished", then run topic detection
// on the full sentence.
const userUtteranceBuffer = new Map();
const topicDebounceTimers = new Map();

// Buffer to accumulate assistant output fragments per turn
const assistantOutputBuffer = new Map();
const leadDraftBySession = new Map();
const leadFormShownBySession = new Map();

//new
const topicDispatchedThisTurn = new Map();
const currentTurnTopic = new Map();
// True once we sent page-matched images for this turn (not whole-PDF dump)
const imagesFocusedThisTurn = new Map();

/** Strip hidden Gemini markers before using response text for image search. */
function stripAssistantMarkers(text) {
  return String(text || "")
    .replace(/\[\[TOPIC:\s*[^\]]+?\]\]/gi, " ")
    .replace(/\[\[SHOW_IMAGE:\d+\]\]/g, " ")
    .replace(/\[\[REF_ID:\s*[^\]]+?\]\]/gi, " ")
    .replace(/\[SHOW_LEAD_FORM.*?\]/gi, " ")
    .replace(/\[ACTIVATE_CAMERA\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Images come ONLY from Gemini's spoken/written response — not the user question.
 * Topic = [[TOPIC: X]] from response, or inferred from response content.
 */
function dispatchImagesFromGeminiResponse(clientWs, sessionId, assistantRawText, topicHint = null) {
  const speech = stripAssistantMarkers(assistantRawText);
  if (!speech || speech.length < 6) return false;

  let topic = topicHint || currentTurnTopic.get(sessionId) || null;
  if (!topic || topic.toLowerCase() === "general") {
    topic = inferTopicFromAssistantSpeech(speech);
  }
  if (!topic || topic.toLowerCase() === "general") return false;

  currentTurnTopic.set(sessionId, topic);
  const resolvedTopic = resolveImagePdfTopic(topic, speech);

  let images = pickImagesForLive(speech, resolvedTopic, {
    allowPdfBaseline: false,
    limit: 8,
  });
  if (!images.length) {
    images = pickImagesForLive(speech, resolvedTopic, {
      allowPdfBaseline: true,
      limit: 6,
    });
  }
  if (!images.length) return false;

  const key = images.map((img) => img.image_path || img.url).join("|");
  if (imagesFocusedThisTurn.get(sessionId) === key) return false;

  console.log(
    `🖼️  [GEMINI-RESPONSE] topic="${topic}" | speech="${speech.slice(0, 90)}" → ${images.length} image(s)`
  );
  if (sendImagePayload(clientWs, images)) {
    imagesFocusedThisTurn.set(sessionId, key);
    return true;
  }
  return false;
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function normalizeModelId(model) {
  return String(model || "").replace(/^models\//, "");
}

function cleanLeadValue(value) {
  return String(value || "")
    .replace(/^[\s:,-]+|[\s,.;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLeadDetails(text) {
  const source = String(text || "");
  const details = {};

  // const email = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  // if (email) details.email = email;

  // const phone = source.match(/(?:\+?\d[\d\s().-]{6,}\d)/)?.[0];
  // if (phone) details.phone = cleanLeadValue(phone);

  const emails = [...source.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0]);
  if (emails.length) details.email = emails;

  const phones = [...source.matchAll(/(?:\+?\d[\d\s().-]{6,}\d)/g)].map((m) => cleanLeadValue(m[0]));
  if (phones.length) details.phone = phones;

  const nameMatch = source.match(
    /\b(?:my\s+name\s+is|name\s+is|i\s+am|i'm|this\s+is)\s+([A-Za-z][A-Za-z .'-]{1,60})(?=\s+(?:and|phone|number|email|city|from|in)\b|[,.;]|$)/i
  );
  if (nameMatch) details.name = cleanLeadValue(nameMatch[1]);

  const companyMatch = source.match(
    /\b(?:company\s+(?:name\s+)?is|company\s+is|organization\s+is|organisation\s+is|i\s+work\s+(?:at|for))\s+([A-Za-z0-9][A-Za-z0-9 .&'()-]{1,80})(?=\s+(?:and|designation|job|title|role|phone|number|email|city|from|in)\b|[,.;]|$)/i
  );
  if (companyMatch) details.company = cleanLeadValue(companyMatch[1]);

  const designationMatch = source.match(
    /\b(?:designation\s+is|job\s+title\s+is|title\s+is|role\s+is|i\s+am\s+(?:a|an))\s+([A-Za-z][A-Za-z .&'/-]{1,60})(?=\s+(?:and|phone|number|email|from|at|in)\b|[,.;]|$)/i
  );
  if (designationMatch) details.designation = cleanLeadValue(designationMatch[1]);

  return details;
}


function mergeLeadDraft(sessionId, text, clientWs, forceShow = false) {
  const extracted = extractLeadDetails(text);
  if (!Object.keys(extracted).length) return;

  const prev = leadDraftBySession.get(sessionId) || {
    name: "",
    company: "",
    designation: "",
    phone: [],
    email: [],
  };

  const next = { ...prev };

  for (const [key, value] of Object.entries(extracted)) {
    if (key === "phone" || key === "email") {
      const existing = Array.isArray(prev[key]) ? prev[key] : [];
      const merged = [...new Set([...existing, ...value])];
      next[key] = merged;
    } else if (value) {
      next[key] = value;
    }
  }

  leadDraftBySession.set(sessionId, next);

  const hasRequired = Boolean(next.name && next.phone?.length && next.email?.length);
  if ((forceShow || hasRequired) && !leadFormShownBySession.get(sessionId)) {
    leadFormShownBySession.set(sessionId, true);
    sendJson(clientWs, { type: "show_lead_form", data: next });
  }
}

function sendImagePayload(clientWs, payload) {
  const images = Array.isArray(payload)
    ? payload.filter((item) => item && typeof item === "object")
    : [];
  const urls = images.length
    ? images
      .map((img) =>
        img.url || (img.image_path ? `/${String(img.image_path).replace(/^\/+/, "")}` : null)
      )
      .filter(Boolean)
    : Array.isArray(payload)
      ? payload.filter((item) => typeof item === "string")
      : [];

  if (!images.length && !urls.length) return false;

  sendJson(clientWs, {
    type: "images",
    images: images.length ? images : undefined,
    urls,
    replace: true,
  });
  return true;
}

async function connectLiveSession(ai, preferredModel, config, callbacks) {
  const tried = new Set();
  const candidates = [
    normalizeModelId(preferredModel),
    ...FALLBACK_LIVE_MODELS.map(normalizeModelId),
  ].filter((m) => m && !tried.has(m) && tried.add(m));

  let lastError = null;

  for (const model of candidates) {
    try {
      console.log(`🔊 Connecting Gemini Live → ${model}`);
      const session = await ai.live.connect({ model, config, callbacks });
      return { session, model };
    } catch (err) {
      lastError = err;
      console.warn(`   Live model failed (${model}):`, err.message);
      if (isGeminiQuotaError(err)) throw err;
    }
  }

  throw lastError || new Error("No compatible Gemini Live model available");
}

async function connectLiveWithKeyRotation(preferredModel, liveConfig, callbacks) {
  const maxAttempts = Math.max(getGeminiKeyCount(), 1);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const apiKey = getGeminiApiKey();
    const ai = new GoogleGenAI({ apiKey });
    try {
      const { session, model } = await connectLiveSession(
        ai,
        preferredModel,
        liveConfig,
        callbacks
      );
      console.log(
        `✅ Gemini Live session active (${model}) key=${maskGeminiApiKey(apiKey)}`
      );
      return { session, model, ai, apiKey };
    } catch (err) {
      lastError = err;
      if (isGeminiQuotaError(err) && rotateGeminiApiKey(apiKey)) {
        console.warn(
          `🔑 Live connect quota — trying next key (${maskGeminiApiKey(getGeminiApiKey())})`
        );
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("All Gemini API keys exhausted for Live session");
}

export async function attachClientToGemini(clientWs, sessionId) {
  const { GEMINI_LIVE_MODEL } = getConfig();

  // Initialize session stats
  if (!liveSessionStats.has(sessionId)) {
    liveSessionStats.set(sessionId, { topic_counts: {} });
  }

  let geminiSession = null;
  let activeApiKey = getGeminiApiKey();
  let setupDone = false;
  let assistantSpeaking = false;
  let reconnecting = false;

  const liveConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: {
        // prebuiltVoiceConfig: { voiceName: "Aoede" },
        prebuiltVoiceConfig: { voiceName: "Alnilam" },
      },
    },
    systemInstruction: {
      parts: [{ text: buildLiveSystemInstruction() }],
    },
    tools: [{ functionDeclarations: SUBMIT_LEAD_TOOL.functionDeclarations }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };

  const callbacks = {
    onopen: () => {
      sendJson(clientWs, { type: "status", status: "gemini_connected" });
    },
    onmessage: async (message) => {
      if (message.setupComplete) {
        setupDone = true;
        sendJson(clientWs, { type: "ready" });

        return;
      }

      if (message.toolCall) {
        await handleToolCall(
          message.toolCall,
          clientWs,
          sessionId,
          geminiSession
        );
      }

      const sc = message.serverContent;
      if (!sc) return;

      if (sc.interrupted) {
        sendJson(clientWs, { type: "interrupted" });
      }

      if (sc.inputTranscription?.text) {
        const userText = sc.inputTranscription.text;
        sendJson(clientWs, {
          type: "transcript",
          role: "user",
          text: userText,
        });
        mergeLeadDraft(sessionId, userText, clientWs);

        // Accumulate user utterance fragments for topic detection
        const prev = userUtteranceBuffer.get(sessionId) || "";
        userUtteranceBuffer.set(sessionId, prev + " " + userText);

      }

      //previous
      if (sc.outputTranscription?.text) {
        assistantSpeaking = true;
        const text = sc.outputTranscription.text;

        // Accumulate assistant text for robust marker detection
        const prev = assistantOutputBuffer.get(sessionId) || "";
        let newBuffer = prev + text;

        let imageId = null;

        // 0. Check for [[TOPIC: X]] — Gemini bata raha hai ke kis topic pe baat ho rahi hai.
        //    Isi se images dhoondo — sirf EK baar per turn.
        const topicMatch = newBuffer.match(/\[\[TOPIC:\s*([^\]]+?)\]\]/i);
        if (topicMatch) {
          const topic = topicMatch[1].trim();
          newBuffer = newBuffer.replace(topicMatch[0], "");
          currentTurnTopic.set(sessionId, topic);

          if (!topicDispatchedThisTurn.get(sessionId) && topic.toLowerCase() !== "general") {
            topicDispatchedThisTurn.set(sessionId, true);
            imagesFocusedThisTurn.delete(sessionId);
            userUtteranceBuffer.set(sessionId, "");

            console.log(`🎯 [TOPIC-FROM-RESPONSE] topic="${topic}"`);

            dispatchImagesFromGeminiResponse(clientWs, sessionId, newBuffer, topic);

            const normalizedTopic = topic.toLowerCase().trim();
            const stats = liveSessionStats.get(sessionId) || { topic_counts: {} };
            stats.topic_counts[normalizedTopic] = (stats.topic_counts[normalizedTopic] || 0) + 1;
            liveSessionStats.set(sessionId, stats);

            console.log(`📊 [TOPIC-COUNT] "${normalizedTopic}" → ${stats.topic_counts[normalizedTopic]}`, JSON.stringify(stats.topic_counts));

            saveLead({ sessionId, topic_counts: stats.topic_counts }).catch((err) =>
              console.warn("Topic count save error:", err.message)
            );

          } else if (topic.toLowerCase() === "general") {
            userUtteranceBuffer.set(sessionId, "");
          }
        }

        // Images: sirf Gemini ke response text se — user question se nahi
        dispatchImagesFromGeminiResponse(
          clientWs,
          sessionId,
          newBuffer,
          currentTurnTopic.get(sessionId)
        );

        // 1. Check for [[SHOW_IMAGE:X]]
        const imageMatch = newBuffer.match(/\[\[SHOW_IMAGE:(\d+)\]\]/);
        if (imageMatch) {
          imageId = parseInt(imageMatch[1], 10);
          newBuffer = newBuffer.replace(imageMatch[0], "");
          console.log(`🖼️  Image marker found: Image ${imageId}`);

          sendJson(clientWs, {
            type: "image_sync",
            imageId: imageId,
            timestamp: Date.now(),
          });
        }

        // 2. Check for [SHOW_LEAD_FORM...]
        const leadFormMatch = newBuffer.match(/\[SHOW_LEAD_FORM(.*?)\]/i);
        if (leadFormMatch) {
          const innerContent = leadFormMatch[1].trim();
          let leadData = null;

          if (innerContent && innerContent.startsWith("|")) {
            const args = innerContent.substring(1).split('|').map(s => s.trim());
            leadData = {
              name: args[0] && args[0].toUpperCase() !== "N/A" ? args[0].replace(/^Name:\s*/i, "") : "",
              company: args[1] && args[1].toUpperCase() !== "N/A" ? args[1].replace(/^Company( Name)?:\s*/i, "") : "",
              designation: args[2] && args[2].toUpperCase() !== "N/A" ? args[2].replace(/^Designation:\s*/i, "").replace(/^Job Title:\s*/i, "") : "",
              phone: args[3] && args[3].toUpperCase() !== "N/A" ? args[3].replace(/^Phone( Number)?:\s*/i, "") : "",
              email: args[4] && args[4].toUpperCase() !== "N/A" ? args[4].replace(/^Email:\s*/i, "") : "",
            };
            console.log("📋 Lead form marker found with data:", leadData);
          } else {
            console.log("📋 Lead form marker found (no data)");
          }

          if (leadData) {
            leadDraftBySession.set(sessionId, {
              ...(leadDraftBySession.get(sessionId) || {}),
              ...leadData,
            });
          }
          leadFormShownBySession.set(sessionId, true);
          newBuffer = newBuffer.replace(leadFormMatch[0], "");
          sendJson(clientWs, { type: "show_lead_form", data: leadData });
        }

        // 3. Check for [ACTIVATE_CAMERA]
        const cameraMatch = newBuffer.match(/\[ACTIVATE_CAMERA\]/i);
        if (cameraMatch) {
          newBuffer = newBuffer.replace(cameraMatch[0], "");
          // Send a fake full transcript just so the frontend `text.includes` triggers correctly
          sendJson(clientWs, {
            type: "transcript",
            role: "assistant",
            text: "[ACTIVATE_CAMERA]"
          });
        }

        assistantOutputBuffer.set(sessionId, newBuffer);

        // Remove known markers from the chunk sent to the client so they don't show up in UI
        let cleanedText = text
          .replace(/\[\[SHOW_IMAGE:\d+\]\]/g, "")
          .replace(/\[\[TOPIC:\s*[^\]]+?\]\]/gi, "")
          .replace(/\[SHOW_LEAD_FORM.*?\]/gi, "")
          .replace(/\[ACTIVATE_CAMERA\]/gi, "");

        // Send cleaned transcript chunk to client
        sendJson(clientWs, {
          type: "transcript",
          role: "assistant",
          text: cleanedText,
          imageId: imageId, // Include imageId if found
        });
      }
      const parts = sc.modelTurn?.parts || [];
      for (const part of parts) {
        const inline = part.inlineData;
        if (inline?.data && inline?.mimeType?.includes("audio")) {
          assistantSpeaking = true;
          sendJson(clientWs, {
            type: "audio",
            data: inline.data,
            mimeType: inline.mimeType,
          });
        }
      }

      if (sc.turnComplete) {
        assistantSpeaking = false;

        const finalResponse = assistantOutputBuffer.get(sessionId) || "";
        dispatchImagesFromGeminiResponse(
          clientWs,
          sessionId,
          finalResponse,
          currentTurnTopic.get(sessionId)
        );

        sendJson(clientWs, { type: "turn_complete" });
        assistantOutputBuffer.set(sessionId, "");
        topicDispatchedThisTurn.set(sessionId, false);
        currentTurnTopic.delete(sessionId);
        imagesFocusedThisTurn.delete(sessionId);
      }
    },
    onerror: async (err) => {
      const msg = err?.message || err?.error?.message || "Gemini Live API error";
      console.error("Gemini Live error:", msg);

      if (!reconnecting && isGeminiQuotaError(err) && rotateGeminiApiKey(activeApiKey)) {
        reconnecting = true;
        setupDone = false;
        try {
          try {
            geminiSession?.close();
          } catch {
            /* ignore */
          }
          const reconnected = await connectLiveWithKeyRotation(
            GEMINI_LIVE_MODEL,
            liveConfig,
            callbacks
          );
          geminiSession = reconnected.session;
          activeApiKey = reconnected.apiKey;
          sendJson(clientWs, { type: "status", status: "gemini_reconnected" });
          console.log("🔑 Live session reconnected with rotated Gemini key");
        } catch (reconnectErr) {
          sendJson(clientWs, {
            type: "error",
            message: reconnectErr?.message || "All Gemini API keys exhausted",
          });
        } finally {
          reconnecting = false;
        }
        return;
      }

      sendJson(clientWs, { type: "error", message: msg });
    },
    onclose: (evt) => {
      const reason = evt?.reason || evt?.message || "";
      if (reason && !setupDone) {
        sendJson(clientWs, {
          type: "error",
          message: reason,
        });
      }
      sendJson(clientWs, { type: "status", status: "gemini_closed" });
    },
  };

  const { session, apiKey } = await connectLiveWithKeyRotation(
    GEMINI_LIVE_MODEL,
    liveConfig,
    callbacks
  );
  geminiSession = session;
  activeApiKey = apiKey;

  clientWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "audio" && msg.data) {
        if (!setupDone || !geminiSession) return;
        geminiSession.sendRealtimeInput({
          audio: {
            data: msg.data,
            mimeType: msg.mimeType || "audio/pcm;rate=16000",
          },
        });
        return;
      }

      if (msg.type === "audio_stream_end") {
        geminiSession?.sendRealtimeInput({ audioStreamEnd: true });
        return;
      }

      if (msg.type === "text" && msg.text) {
        mergeLeadDraft(sessionId, msg.text, clientWs);
        geminiSession?.sendClientContent({
          turns: [{ role: "user", parts: [{ text: msg.text }] }],
          turnComplete: true,
        });
        return;
      }

      // Handle inactivity check from frontend
      if (msg.type === "inactivity_check") {
        console.log("⏰ Inactivity check received — prompting Gemini");
        geminiSession?.sendClientContent({
          turns: [{ role: "user", parts: [{ text: "[INACTIVITY_CHECK]" }] }],
          turnComplete: true,
        });
        return;
      }

      if (msg.type === "interrupt") {
        sendJson(clientWs, { type: "interrupted" });
      }
    } catch (err) {
      console.error("Client message parse error:", err);
    }
  });

  clientWs.on("close", () => {
    clearLiveRagSession(sessionId);
    userUtteranceBuffer.delete(sessionId);
    //new
    topicDispatchedThisTurn.delete(sessionId);
    currentTurnTopic.delete(sessionId);
    imagesFocusedThisTurn.delete(sessionId);
    leadDraftBySession.delete(sessionId);
    leadFormShownBySession.delete(sessionId);
    if (topicDebounceTimers.has(sessionId)) {
      clearTimeout(topicDebounceTimers.get(sessionId));
      topicDebounceTimers.delete(sessionId);
    }
    // Persist stats across temporary disconnections; do not delete on close
    try {
      geminiSession?.close();
    } catch {
      /* ignore */
    }
  });

  return geminiSession;
}

async function handleToolCall(toolCall, clientWs, sessionId, geminiSession) {
  const calls = toolCall?.functionCalls || [];
  const responses = [];

  let leadSaved = false;

  for (const call of calls) {
    if (call.name === "submitLead") {
      // const args = call.args || {};
      // try {
      //   // Get question counts from in-memory stats
      //   const counts = liveSessionStats.get(sessionId) || { mushaba_count: 0, nucleus_distribution_count: 0 };
      //   console.log(`📊 [LEAD] Saving lead with counts:`, JSON.stringify(counts));

      //   const lead = await saveLead({
      //     name: args.name,
      //     company: args.company || "",
      //     designation: args.designation || "",
      //     phone: args.phone,
      //     email: args.email,
      //     sessionId,
      //     mushaba_count: counts.mushaba_count,
      //     nucleus_distribution_count: counts.nucleus_distribution_count,
      //   });
      //   sendJson(clientWs, {
      //     type: "lead_saved",
      //     lead: {
      //       id: lead._id,
      //       name: lead.name,
      //       company: lead.company,
      //       designation: lead.designation,
      //       phone: lead.phone,
      //       email: lead.email,
      //       mushaba_count: lead.mushaba_count,
      //       nucleus_distribution_count: lead.nucleus_distribution_count,
      //     },
      //   });
      const args = call.args || {};
      try {
        const stats = liveSessionStats.get(sessionId) || { topic_counts: {} };
        console.log(`📊 [LEAD] Saving lead with topic counts:`, JSON.stringify(stats.topic_counts));

        const lead = await saveLead({
          name: args.name,
          company: args.company || "",
          designation: args.designation || "",
          phone: args.phone,
          email: args.email,
          sessionId,
          topic_counts: stats.topic_counts,
        });
        sendJson(clientWs, {
          type: "lead_saved",
          lead: {
            id: lead._id,
            name: lead.name,
            company: lead.company,
            designation: lead.designation,
            phone: lead.phone,
            email: lead.email,
            topic_counts: Object.fromEntries(lead.topic_counts || []),
          },
        });
        leadSaved = true;
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            result: "Lead saved successfully.",
            leadId: String(lead._id),
          },
        });
      } catch (err) {
        responses.push({
          id: call.id,
          name: call.name,
          response: { error: err.message },
        });
      }
    }
  }

  // After saving the lead, close the WS after a short delay so the
  // lead_saved message is delivered before the connection drops.
  if (leadSaved) {
    liveSessionStats.delete(sessionId);
    setTimeout(() => {
      try { geminiSession?.close(); } catch { /* ignore */ }
      try {
        if (clientWs.readyState === clientWs.OPEN) clientWs.close();
      } catch { /* ignore */ }
    }, 2500);
  }

  if (responses.length && geminiSession) {
    geminiSession.sendToolResponse({ functionResponses: responses });
  }
}
