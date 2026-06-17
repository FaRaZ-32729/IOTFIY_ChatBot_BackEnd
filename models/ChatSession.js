import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    /* Original transcription when the message came from voice */
    transcription: { type: String, default: null },
    /* Whether TTS audio was generated for this message */
    hasAudio: { type: Boolean, default: false },
    /* Detected input language */
    language: { type: String, default: "en" },
  },
  { timestamps: true }
);

const chatSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    messages: [messageSchema],
    metadata: {
      userAgent: String,
      lastActive: { type: Date, default: Date.now },
    },
  },
  { timestamps: true }
);

/* Update lastActive on every save */
chatSessionSchema.pre("save", function (next) {
  this.metadata.lastActive = new Date();
  next();
});

const ChatSession = mongoose.model("ChatSession", chatSessionSchema);
export default ChatSession;
