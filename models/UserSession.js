import mongoose from "mongoose";

const userDetailsSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    company: { type: String, default: "" },
    designation: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    city: { type: String, default: "" },
  },
  { _id: false }
);

const conversationEntrySchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSessionSchema = new mongoose.Schema(
  {
    user_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    username: { type: String, default: "" },

    /* Conversation history */
    conversation_history: [conversationEntrySchema],

    /* Timestamps of each interaction */
    timestamps: [{ type: Date }],

    /* User details (filled at end of chat) */
    user_details: { type: userDetailsSchema, default: () => ({}) },

    /* Session metadata */
    session_active: { type: Boolean, default: false },
    last_active: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

userSessionSchema.pre("save", function (next) {
  this.last_active = new Date();
  next();
});

const UserSession = mongoose.model("UserSession", userSessionSchema);
export default UserSession;
