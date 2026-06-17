import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { connectDB } from "./config/db.js";
import { initializePdfContext } from "./services/pdfService.js";
import chatRoutes from "./routes/chatRoutes.js";
import cardScanRoutes from "./routes/cardScanRoutes.js";
import leadRoutes from "./routes/leadRoutes.js";
import { createLiveWebSocketServer } from "./ws/liveWebSocketServer.js";
import { sendAngle } from "./mqtt/mqttPublisher.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5055;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ───────── Middleware ───────── */
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(morgan("dev"));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

/* Serve extracted PDF images */
app.use(
  "/pdf-images",
  express.static(path.join(__dirname, "data", "pdf-images"))
);
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"))
);

/* ───────── Routes ───────── */
app.use("/api/chat", chatRoutes);
app.use("/api/card-scan", cardScanRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/images", (await import("./routes/imageRoutes.js")).default);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post('/send-angle', (req, res) => {
  const { angle } = req.body;
  console.log("📥 Backend received angle:", angle);
  if (typeof angle === 'number') {
    sendAngle(angle);
    console.log("sending data to mqtt")
    return res.json({ success: true, angle });
  } else {
    return res.status(400).json({ error: "Angle number mein hona chahiye" });
  }
});

/* ───────── Global Error Handler ───────── */
app.use((err, _req, res, _next) => {
  console.error("Unhandled Error:", err);
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message,
  });
});

/* ───────── Start Server ───────── */
async function startServer() {
  try {
    await connectDB();
    console.log("✅ MongoDB connected");

    await initializePdfContext();
    console.log("✅ PDF context loaded & vectorized");

    const httpServer = http.createServer(app);
    createLiveWebSocketServer(httpServer);

    httpServer.listen(PORT, () => {
      console.log(`🚀  IoTFIY Chatbot API running → http://localhost:${PORT}`);
      console.log(`🔊  Gemini Live WebSocket → ws://localhost:${PORT}/live`);
    });
  } catch (error) {
    console.error("❌ Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
