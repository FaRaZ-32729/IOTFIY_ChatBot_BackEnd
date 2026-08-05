// mqtt/mqttPublisher.js
import mqtt from "mqtt";
import dotenv from "dotenv";

dotenv.config();

const MQTT_CONFIG = {
    brokerUrl: process.env.MQTT_BROKER_URL || "mqtt://localhost:1883",
    topic: process.env.MQTT_TOPIC || "home/speaker/angle",

    options: {
        clientId: "backend-speaker-client-" + Math.random().toString(16).substr(2, 8),
        reconnectPeriod: 5000,
        keepalive: 60,
        username: process.env.MQTT_USERNAME || "",
        password: process.env.MQTT_PASSWORD || "",
    }
};

let client = null;
let isConnected = false;
let lastPublishedAngle = null;
let lastPublishedAt = 0;

const MIN_PUBLISH_INTERVAL_MS = 3000;
const MIN_ANGLE_DELTA = 6;

function connectMQTT() {
    console.log("🔄 Connecting to MQTT Broker:", MQTT_CONFIG.brokerUrl);
    console.log("🔑 Using Username:", MQTT_CONFIG.options.username ? "Yes" : "No (Anonymous)");

    client = mqtt.connect(MQTT_CONFIG.brokerUrl, MQTT_CONFIG.options);

    client.on("connect", () => {
        isConnected = true;
        console.log("✅ Backend MQTT Connected Successfully!");
        console.log(`📡 Topic: ${MQTT_CONFIG.topic}`);
    });

    client.on("error", (err) => {
        console.error("❌ MQTT Error:", err.message);
        isConnected = false;
    });

    client.on("reconnect", () => {
        console.log("🔄 MQTT Reconnecting...");
    });

    client.on("offline", () => {
        isConnected = false;
        console.warn("⚠️ MQTT Client Offline");
    });
}

export function sendAngle(angle) {
    if (!client || !isConnected) {
        console.warn("⚠️ MQTT not connected, angle skipped:", angle);
        return false;
    }

    const numericAngle = parseFloat(Number(angle).toFixed(1));
    const now = Date.now();

    if (lastPublishedAngle !== null) {
        if (now - lastPublishedAt < MIN_PUBLISH_INTERVAL_MS) {
            console.log(`⏸️  Angle publish skipped (rate limit): ${numericAngle}°`);
            return false;
        }
        if (Math.abs(numericAngle - lastPublishedAngle) < MIN_ANGLE_DELTA) {
            console.log(`⏸️  Angle publish skipped (too small): ${numericAngle}°`);
            return false;
        }
    }

    const payload = {
        angle: numericAngle,
        timestamp: now,
        source: "webcam-speaker-angle"
    };

    lastPublishedAngle = numericAngle;
    lastPublishedAt = now;

    client.publish(MQTT_CONFIG.topic, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (!err) {
            console.log(`📤 [Backend] Angle Sent: ${numericAngle}° → ${MQTT_CONFIG.topic}`);
        } else {
            console.error("❌ Publish failed:", err);
        }
    });

    return true;
}

connectMQTT();

export default { sendAngle };
