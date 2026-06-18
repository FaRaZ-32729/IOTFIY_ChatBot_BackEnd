import mongoose from "mongoose";
import { getConfig } from "./keys.js";

export async function connectDB() {
  const { MONGODB_URI } = getConfig();

  mongoose.set("strictQuery", false);

  try {
    const conn = await mongoose.connect(MONGODB_URI, {
      dbName: "iotfiychatbot",
      serverSelectionTimeoutMS: 5000,
    });

    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    if (error.message.includes("ENOTFOUND")) {
      console.error("❌ MongoDB Error: Hostname not found. Please check if your MONGODB_URI in .env includes your unique cluster ID (e.g., cluster0.abcde.mongodb.net).");
    } else {
      console.error(`❌ MongoDB Connection Error: ${error.message}`);
    }
    throw error;
  }
}