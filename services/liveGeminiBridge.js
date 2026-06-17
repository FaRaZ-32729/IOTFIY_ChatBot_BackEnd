/**
 * Bridges one browser WebSocket client ↔ Gemini Multimodal Live API (@google/genai).
 */
import { GoogleGenAI, Modality } from "@google/genai";
import { getConfig } from "../config/keys.js";
import { saveLead } from "./leadService.js";
import {
  buildLiveSystemInstruction,
  SUBMIT_LEAD_TOOL,
} from "./liveSystemPrompt.js";
import { enrichQueryForLive, clearLiveRagSession } from "./liveRagService.js";

// Topic patterns — only applied to USER speech, never assistant responses.
// Patterns are relaxed because we only track user utterances.
// We test both the original text AND a space-stripped version to handle
// fragmented voice transcriptions (e.g. "musha ba" → "mushaba").
const TOPIC_PATTERNS = [
  {
    field: "mushaba_count",
    patterns: [/mushaba/i, /moshaba/i, /mashaba/i, /mush\s*aba/i, /mosha\s*ba/i],
  },
  {
    field: "nucleus_distribution_count",
    patterns: [/nucleus/i, /vivanco/i, /nucle\s*us/i, /distri\s*bution/i],
  },
];
const TOPIC_IMAGE_PATTERN =
  /mushaba|moshaba|mashaba|nucleus|nucle\s*us|iotfiy|iotfiy\s*solutions|solutions\s*document|distribution|distri\s*bution|vivanco|vericom|data\s*center|cable|infrastructure|turnkey/i;

function detectTopics(query) {
  if (!query || typeof query !== "string") return [];
  const matched = [];
  // Create a space-stripped version to catch words broken across transcription chunks
  const stripped = query.replace(/\s+/g, "");
  for (const { field, patterns } of TOPIC_PATTERNS) {
    if (patterns.some((p) => p.test(query) || p.test(stripped))) {
      matched.push(field);
    }
  }
  return matched;
}

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

  const email = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (email) details.email = email;

  const phone = source.match(/(?:\+?\d[\d\s().-]{6,}\d)/)?.[0];
  if (phone) details.phone = cleanLeadValue(phone);

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
    phone: "",
    email: "",
  };
  const next = {
    ...prev,
    ...Object.fromEntries(
      Object.entries(extracted).filter(([, value]) => Boolean(value))
    ),
  };

  leadDraftBySession.set(sessionId, next);

  const hasRequired = Boolean(next.name && next.phone && next.email);
  if ((forceShow || hasRequired) && !leadFormShownBySession.get(sessionId)) {
    leadFormShownBySession.set(sessionId, true);
    sendJson(clientWs, { type: "show_lead_form", data: next });
  }
}

function dispatchLiveImages(clientWs, sessionId, text) {
  enrichQueryForLive(sessionId, text, {
    onImages: (payload) => {
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

      sendJson(clientWs, {
        type: "images",
        images: images.length ? images : undefined,
        urls,
        replace: true,
      });
    },
  });
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
    }
  }

  throw lastError || new Error("No compatible Gemini Live model available");
}

export async function attachClientToGemini(clientWs, sessionId) {
  const { GOOGLE_API_KEY, GEMINI_LIVE_MODEL } = getConfig();
  const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

  // Initialize session stats
  if (!liveSessionStats.has(sessionId)) {
    liveSessionStats.set(sessionId, { mushaba_count: 0, nucleus_distribution_count: 0 });
  }

  let geminiSession = null;
  let setupDone = false;
  let assistantSpeaking = false;

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

        // Also run topic detection on EACH incoming fragment immediately
        // (catches cases where transcription delivers complete words)
        const immTopics = detectTopics(userText);
        if (immTopics.length > 0) {
          const stats = liveSessionStats.get(sessionId);
          if (stats) {
            for (const field of immTopics) {
              stats[field] = stats[field] || 0;
            }
            console.log(`📊 [TOPIC-IMM] Immediate detect on fragment:`, immTopics, JSON.stringify(stats));
          }
        }

        // Debounce topic detection on FULL accumulated utterance
        // to catch words split across fragments (e.g. "musha" + "ba")
        if (topicDebounceTimers.has(sessionId)) {
          clearTimeout(topicDebounceTimers.get(sessionId));
        }
        topicDebounceTimers.set(sessionId, setTimeout(async () => {
          const fullUtterance = (userUtteranceBuffer.get(sessionId) || "").trim();
          userUtteranceBuffer.set(sessionId, ""); // reset buffer

          if (fullUtterance) {
            console.log(`📊 [TOPIC] Analyzing full utterance: "${fullUtterance}"`);
            dispatchLiveImages(clientWs, sessionId, fullUtterance);
            try {
              const topics = detectTopics(fullUtterance);
              if (topics.length > 0) {
                console.log(`📊 [TOPIC] Detected topics:`, topics);
                const stats = liveSessionStats.get(sessionId);
                if (stats) {
                  for (const field of topics) {
                    stats[field] = (stats[field] || 0) + 1;
                  }
                  console.log(`📊 [TOPIC] Updated stats:`, JSON.stringify(stats));
                  
                  // Persist to DB immediately so we don't lose counts if session drops
                  await saveLead({
                    sessionId,
                    mushaba_count: stats.mushaba_count,
                    nucleus_distribution_count: stats.nucleus_distribution_count,
                  });
                }
              }
            } catch (err) {
              console.warn("Topic tracking error:", err.message);
            }
          }
        }, 1500)); // 1.5s pause = utterance finished

        // RAG image retrieval: use the latest user utterance so visuals follow the topic.
        dispatchLiveImages(clientWs, sessionId, userText);
      }

      if (sc.outputTranscription?.text) {
        assistantSpeaking = true;
        const text = sc.outputTranscription.text;
        if (TOPIC_IMAGE_PATTERN.test(text)) {
          dispatchLiveImages(clientWs, sessionId, text);
        }
        
        // Accumulate assistant text for robust marker detection
        const prev = assistantOutputBuffer.get(sessionId) || "";
        let newBuffer = prev + text;
        
        let imageId = null;
        
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
        sendJson(clientWs, { type: "turn_complete" });
        assistantOutputBuffer.set(sessionId, ""); // Clear buffer for next turn
      }
    },
    onerror: (err) => {
      const msg = err?.message || err?.error?.message || "Gemini Live API error";
      console.error("Gemini Live error:", msg);
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

  const { session, model } = await connectLiveSession(
    ai,
    GEMINI_LIVE_MODEL,
    liveConfig,
    callbacks
  );
  geminiSession = session;
  console.log(`✅ Gemini Live session active (${model})`);

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
        dispatchLiveImages(clientWs, sessionId, msg.text);
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
      const args = call.args || {};
      try {
        // Get question counts from in-memory stats
        const counts = liveSessionStats.get(sessionId) || { mushaba_count: 0, nucleus_distribution_count: 0 };
        console.log(`📊 [LEAD] Saving lead with counts:`, JSON.stringify(counts));

        const lead = await saveLead({
          name: args.name,
          company: args.company || "",
          designation: args.designation || "",
          phone: args.phone,
          email: args.email,
          sessionId,
          mushaba_count: counts.mushaba_count,
          nucleus_distribution_count: counts.nucleus_distribution_count,
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
            mushaba_count: lead.mushaba_count,
            nucleus_distribution_count: lead.nucleus_distribution_count,
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
