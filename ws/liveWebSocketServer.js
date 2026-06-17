import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { attachClientToGemini } from "../services/liveGeminiBridge.js";

export function createLiveWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/live" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId") || randomUUID();

    console.log(`🔊 Live WS client connected (${sessionId})`);
    let closed = false;

    ws.on("close", () => {
      closed = true;
      console.log(`🔇 Live WS client closed BEFORE setup (${sessionId})`);
    });

    attachClientToGemini(ws, sessionId)
      .then(() => {
        if (closed) {
          console.log(`⚠️  Client was already closed when Gemini setup completed (${sessionId})`);
        } else {
          console.log(`✅ Gemini attached successfully to still-open WebSocket (${sessionId})`);
        }
      })
      .catch((err) => {
        console.error(`❌ Failed to attach Gemini Live session (${sessionId}):`, err.message);
        if (!closed && ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: err.message || "Failed to start live session",
            })
          );
          ws.close();
        }
      });
  });

  return wss;
}
