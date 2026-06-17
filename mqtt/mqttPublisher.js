// mqtt/mqttPublisher.js
import mqtt from "mqtt";

const MQTT_CONFIG = {
    brokerUrl: "mqtt://localhost:1883",   // Direct TCP connection
    topic: "home/speaker/angle",
    options: {
        clientId: "backend-speaker-client-" + Math.random().toString(16).substr(2, 8),
        reconnectPeriod: 5000,
        keepalive: 60,
    }
};

let client = null;
let isConnected = false;

// MQTT Client Initialize
function connectMQTT() {
    console.log("🔄 Connecting to MQTT Broker:", MQTT_CONFIG.brokerUrl);

    client = mqtt.connect(MQTT_CONFIG.brokerUrl, MQTT_CONFIG.options);

    client.on("connect", () => {
        isConnected = true;
        console.log("✅ Backend MQTT Connected to Broker Successfully!");
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

// **Main Function jo angle bhejega**
export function sendAngle(angle) {
    if (!client || !isConnected) {
        console.warn("⚠️ MQTT not connected, angle skipped:", angle);
        return false;
    }

    const payload = {
        angle: parseFloat(angle.toFixed(1)),
        timestamp: Date.now(),
        source: "webcam-speaker-angle"
    };

    client.publish(MQTT_CONFIG.topic, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (!err) {
            console.log(`📤 [Backend] Angle Sent: ${angle}° → ${MQTT_CONFIG.topic}`);
        } else {
            console.error("❌ Publish failed:", err);
        }
    });

    return true;
}

// Auto connect jab file load ho
connectMQTT();

export default { sendAngle };