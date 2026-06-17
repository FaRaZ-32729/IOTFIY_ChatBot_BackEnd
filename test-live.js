import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

async function runTest() {
  console.log("Connecting...");
  const session = await ai.live.connect({
    model: "gemini-2.0-flash-live-preview",
    config: {
      responseModalities: ["AUDIO"],
      outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: "Introduce yourself shortly. Say '[SHOW_LEAD_FORM|John|1234|j@e.com|NY]' at the end." }] },
    },
    callbacks: {
      onmessage: (msg) => {
        const sc = msg.serverContent;
        if (sc?.outputTranscription?.text) {
          console.log("TRANSCRIPT:", JSON.stringify(sc.outputTranscription.text));
        }
        if (sc?.turnComplete) {
          console.log("TURN COMPLETE");
          session.close();
          process.exit(0);
        }
      },
      onerror: (err) => {
        console.error("ERROR:", err);
      }
    }
  });

  session.sendClientContent({
    turns: [{ role: "user", parts: [{ text: "Hello!" }] }],
    turnComplete: true
  });
}

runTest();
