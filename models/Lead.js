// import mongoose from "mongoose";

// const leadSchema = new mongoose.Schema(
//   {
//     name: { type: String, default: "", trim: true },
//     company: { type: String, default: "", trim: true },
//     designation: { type: String, default: "", trim: true },
//     phone: { type: String, default: "", trim: true },
//     email: { type: String, default: "", trim: true, lowercase: true },
//     sessionId: { type: String, index: true },
//     source: { type: String, default: "voice-live" },
//     mushaba_count: { type: Number, default: 0 },
//     nucleus_distribution_count: { type: Number, default: 0 },
//   },
//   { timestamps: true }
// );

// const Lead = mongoose.model("Lead", leadSchema);
// export default Lead;


import mongoose from "mongoose";

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true },
    company: { type: String, default: "", trim: true },
    designation: { type: String, default: "", trim: true },
    phone: { type: [String], default: [] },
    email: {
      type: [String],
      default: [],
      set: (arr) => (Array.isArray(arr) ? arr.map((e) => String(e).trim().toLowerCase()) : arr),
    },
    sessionId: { type: String, index: true },
    source: { type: String, default: "voice-live" },

    topic_counts: {
      type: Map,
      of: Number,
      default: {},
    },
  },
  { timestamps: true }
);

const Lead = mongoose.model("Lead", leadSchema);
export default Lead;