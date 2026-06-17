// // mqtt/mqttPublisher.js
// import mqtt from "mqtt";

// const MQTT_CONFIG = {
//     brokerUrl: "mqtt://localhost:1883",   // Direct TCP connection
//     topic: "home/speaker/angle",
//     options: {
//         clientId: "backend-speaker-client-" + Math.random().toString(16).substr(2, 8),
//         reconnectPeriod: 5000,
//         keepalive: 60,
//     }
// };

// let client = null;
// let isConnected = false;

// // MQTT Client Initialize
// function connectMQTT() {
//     console.log("🔄 Connecting to MQTT Broker:", MQTT_CONFIG.brokerUrl);

//     client = mqtt.connect(MQTT_CONFIG.brokerUrl, MQTT_CONFIG.options);

//     client.on("connect", () => {
//         isConnected = true;
//         console.log("✅ Backend MQTT Connected to Broker Successfully!");
//     });

//     client.on("error", (err) => {
//         console.error("❌ MQTT Error:", err.message);
//         isConnected = false;
//     });

//     client.on("reconnect", () => {
//         console.log("🔄 MQTT Reconnecting...");
//     });

//     client.on("offline", () => {
//         isConnected = false;
//         console.warn("⚠️ MQTT Client Offline");
//     });
// }

// // **Main Function jo angle bhejega**
// export function sendAngle(angle) {
//     if (!client || !isConnected) {
//         console.warn("⚠️ MQTT not connected, angle skipped:", angle);
//         return false;
//     }

//     const payload = {
//         angle: parseFloat(angle.toFixed(1)),
//         timestamp: Date.now(),
//         source: "webcam-speaker-angle"
//     };

//     client.publish(MQTT_CONFIG.topic, JSON.stringify(payload), { qos: 1 }, (err) => {
//         if (!err) {
//             console.log(`📤 [Backend] Angle Sent: ${angle}° → ${MQTT_CONFIG.topic}`);
//         } else {
//             console.error("❌ Publish failed:", err);
//         }
//     });

//     return true;
// }

// // Auto connect jab file load ho
// connectMQTT();

// export default { sendAngle };


// mqtt/mqttPublisher.js
import mqtt from "mqtt";
import dotenv from "dotenv";

dotenv.config();   // .env file se credentials load karega

const MQTT_CONFIG = {
    brokerUrl: process.env.MQTT_BROKER_URL || "mqtt://localhost:1883",
    topic: process.env.MQTT_TOPIC || "home/speaker/angle",
    
    options: {
        clientId: "backend-speaker-client-" + Math.random().toString(16).substr(2, 8),
        reconnectPeriod: 5000,
        keepalive: 60,
        
        // Username & Password (Production ke liye secure)
        username: process.env.MQTT_USERNAME || "",
        password: process.env.MQTT_PASSWORD || "",
    }
};

let client = null;
let isConnected = false;

// MQTT Client Initialize
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

// **Main Function**
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

// Auto connect
connectMQTT();

export default { sendAngle };