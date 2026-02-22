// ═══════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════════
const firebaseConfig = {
    apiKey: "AIzaSyBYXS-NFjetRSr0FGY4OYBJlXXU7FRLHJ4",
    authDomain: "backmaper.firebaseapp.com",
    databaseURL: "https://backmaper-default-rtdb.asia-southeast1.firebasedatabase.app/",
    projectId: "backmaper",
    storageBucket: "backmaper.firebasestorage.app",
    messagingSenderId: "1035577635001",
    appId: "1:1035577635001:web:20cc3f8ec82d89f2ceab68"
};

// ─── Path in your Realtime Database where sensor data lives ───
// Change this to match your actual Firebase path, e.g. "/sensorData/live"
const DB_PATH = "/lidarData";

// ═══════════════════════════════════════════════════════════════
//  INIT FIREBASE
// ═══════════════════════════════════════════════════════════════
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ═══════════════════════════════════════════════════════════════
//  DOM ELEMENTS
// ═══════════════════════════════════════════════════════════════
const dateTimeEl = document.getElementById("dateTime");
const statusText = document.getElementById("statusText");
const onlineDot = document.getElementById("onlineDot");
const clickSound = document.getElementById("clickSound");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const measToggleBtn = document.getElementById("measToggleBtn");
const showAnglesBtn = document.getElementById("showAnglesBtn");
const reportBtn = document.getElementById("reportBtn");
const toggleLabelsBtn = document.getElementById("toggleLabelsBtn");
const darkModeBtn = document.getElementById("darkModeBtn");

// ═══════════════════════════════════════════════════════════════
//  DARK MODE
// ═══════════════════════════════════════════════════════════════
if (localStorage.getItem("darkMode") === "enabled") {
    document.body.classList.add("dark-mode");
    darkModeBtn.textContent = "☀️ Light Mode";
}

darkModeBtn.addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
    const isDark = document.body.classList.contains("dark-mode");
    localStorage.setItem("darkMode", isDark ? "enabled" : "disabled");
    darkModeBtn.textContent = isDark ? "☀️ Light Mode" : "🌙 Dark Mode";
    updatePlot();
});

// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════
let measurementsVisible = false;
let anglesVisible = false;
let labelsVisible = true;
let demoInterval = null;   // dummy-data timer
let firebaseUnsubscribe = null;   // Firebase listener handle
let lastDataTime = null;   // timestamp of last successful Firebase data
const TIMEOUT_MS = 30000;  // 30 s – wipe server data if no update arrives

const sensorLabels = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"];
let sensorData = Array(8).fill(0);
let anglesData = Array(8).fill(null);

// ── SERVER-SIDE WATCHDOG ─────────────────────────────────────────
// Every second, check if we haven't received data for > 30 s.
// If so, call db.ref(DB_PATH).remove() to delete the Firebase node.
// This resets ALL connected browsers via their onValue(null) callback.
// Requires Firebase rules: ".write": true
setInterval(() => {
    if (lastDataTime && (Date.now() - lastDataTime > TIMEOUT_MS)) {
        lastDataTime = null; // prevent repeated deletions
        console.warn("[Watchdog] 30 s timeout – deleting Firebase data.");
        db.ref(DB_PATH).remove()
            .then(() => console.log("[Watchdog] Firebase node cleared."))
            .catch(e => console.error("[Watchdog] Delete failed:", e.message));
    }
}, 1000);

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════
function playClick() {
    clickSound.currentTime = 0;
    clickSound.play().catch(() => { });
}

function updateDateTime() {
    dateTimeEl.textContent = new Date().toLocaleString();
}
setInterval(updateDateTime, 1000);
updateDateTime();

function setOnlineStatus(online, source = "") {
    onlineDot.className = "dot " + (online ? "online" : "offline");
    statusText.textContent = online
        ? `Online${source ? " · " + source : ""}`
        : "Offline";
}

// ═══════════════════════════════════════════════════════════════
//  PARSE INCOMING SENSOR DATA
//  Primary shape  : { sensor_1, sensor_2 ... sensor_8 }  ← your ESP32 / LiDAR
//  Fallback shapes: { sensors:[...] }  |  { s1..s8 }  |  raw array
//  NOTE: LiDAR returns 65535 when no surface is detected (out-of-range).
//        We clamp those to 0 so they don't distort the spine curve.
// ═══════════════════════════════════════════════════════════════
const LIDAR_MAX = 65535; // out-of-range sentinel value

function sanitize(v) {
    const n = Number(v);
    return (isNaN(n) || n === LIDAR_MAX) ? 0 : n;
}

function parseSensorPayload(val) {
    if (!val) return null;

    // Shape 1 – { sensor_1, sensor_2 ... sensor_8 }  ← your Firebase format
    if (val.sensor_1 !== undefined) {
        return ["sensor_1", "sensor_2", "sensor_3", "sensor_4",
            "sensor_5", "sensor_6", "sensor_7", "sensor_8"]
            .map(k => sanitize(val[k] ?? 0));
    }

    // Shape 2 – { sensors: [...] }
    if (val.sensors && Array.isArray(val.sensors) && val.sensors.length === 8) {
        return val.sensors.map(sanitize);
    }

    // Shape 3 – { s1, s2 ... s8 }
    if (val.s1 !== undefined) {
        return ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map(k => sanitize(val[k] ?? 0));
    }

    // Shape 4 – raw array at root
    if (Array.isArray(val) && val.length === 8) {
        return val.map(sanitize);
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════
//  ANGLE CALCULATION
// ═══════════════════════════════════════════════════════════════
function calculateAngles(data) {
    const angles = Array(8).fill(null);
    for (let i = 1; i < 7; i++) {
        const angleRad =
            Math.atan2(data[i + 1] - data[i], 1) -
            Math.atan2(data[i - 1] - data[i], -1);
        angles[i] = (angleRad * 180 / Math.PI).toFixed(1) + "°";
    }
    return angles;
}

// ═══════════════════════════════════════════════════════════════
//  PLOT
// ═══════════════════════════════════════════════════════════════
function updatePlot() {
    const isDark = document.body.classList.contains("dark-mode");
    const yAxis = labelsVisible ? sensorLabels : sensorLabels.map((_, i) => i + 1);

    // Dynamic x-axis: max sensor value + 5% padding (min 100 so empty chart isn't flat)
    const rawMax = Math.max(...sensorData);
    const xMax = rawMax > 0 ? Math.ceil(rawMax * 1.05) : 100;

    const mainTrace = {
        x: sensorData,
        y: yAxis,
        type: "scatter",
        mode: "lines+markers" + (measurementsVisible ? "+text" : ""),
        text: measurementsVisible ? sensorData.map(v => v.toFixed(1)) : [],
        textposition: "top right",
        line: { shape: "spline", smoothing: 1.3, color: "#4e9af1", width: 4 },
        marker: { size: 10, color: "#ff4d4d" },
        name: "Spine Curve"
    };

    const traces = [mainTrace];

    if (anglesVisible) {
        traces.push({
            x: sensorData.map(x => x + 1.5),
            y: yAxis,
            mode: "text",
            text: anglesData,
            textposition: "middle right",
            type: "scatter",
            name: "Angles"
        });
    }

    const layout = {
        title: {
            text: "Spinal Curve Mapping",
            font: { color: isDark ? "#eee" : "#222", size: 18 }
        },
        yaxis: {
            autorange: "reversed",
            tickfont: { color: isDark ? "#aaa" : "#555" },
            gridcolor: isDark ? "#444" : "#e0e0e0"
        },
        xaxis: {
            title: "Sensor Value (mm)",
            range: [0, xMax],
            tickfont: { color: isDark ? "#aaa" : "#555" },
            gridcolor: isDark ? "#444" : "#e0e0e0"
        },
        margin: { l: 60, r: 70, t: 60, b: 50 },
        paper_bgcolor: isDark ? "#2c2c2c" : "#ffffff",
        plot_bgcolor: isDark ? "#1e1e1e" : "#f4f4f4",
        font: { color: isDark ? "#ddd" : "#333" },
        showlegend: false
    };

    Plotly.react("plot", traces, layout, { responsive: true, transition: { duration: 0 }, frame: { duration: 0, redraw: false } });
}

// ═══════════════════════════════════════════════════════════════
//  DEMO MODE  (dummy data, used when no Firebase data arrives)
// ═══════════════════════════════════════════════════════════════
function generateDummyData() {
    const base = [0, 5, 9, 12, 10, 6, 2, 0];
    return base.map(v => v + (Math.random() - 0.5) * 1.5);
}

function startDemo() {
    if (demoInterval) return;
    demoInterval = setInterval(() => {
        sensorData = generateDummyData();
        anglesData = calculateAngles(sensorData);
        updatePlot();
    }, 500);
    setOnlineStatus(true, "Demo");
}

function stopDemo() {
    clearInterval(demoInterval);
    demoInterval = null;
    setOnlineStatus(false);
}

// ═══════════════════════════════════════════════════════════════
//  FIREBASE REALTIME DATABASE – live listener
// ═══════════════════════════════════════════════════════════════
function connectFirebase() {
    const ref = db.ref(DB_PATH);

    // onValue fires immediately with current data, then on every change
    firebaseUnsubscribe = ref.on(
        "value",
        (snapshot) => {
            const val = snapshot.val();
            console.log("[Firebase] Raw snapshot:", val);

            const parsed = parseSensorPayload(val);
            if (parsed) {
                // Stop demo if it was running
                if (demoInterval) stopDemo();

                lastDataTime = Date.now(); // reset watchdog on every good packet
                sensorData = parsed;
                anglesData = calculateAngles(sensorData);
                updatePlot();
                setOnlineStatus(true, "Firebase");
            } else {
                console.warn("[Firebase] Data at", DB_PATH, "is empty or unrecognised shape. Received:", val);
                setOnlineStatus(false);
            }
        },
        (error) => {
            console.error("[Firebase] Read error:", error.message);
            setOnlineStatus(false);
        }
    );
}

// ═══════════════════════════════════════════════════════════════
//  REPORT
// ═══════════════════════════════════════════════════════════════
function takeReport() {
    playClick();
    html2canvas(document.getElementById("plotWrap")).then(canvas => {
        const link = document.createElement("a");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        link.download = `BackMap_Report_${timestamp}.png`;
        link.href = canvas.toDataURL();
        link.click();
    });
}

// ═══════════════════════════════════════════════════════════════
//  AI ASSISTANT
// ═══════════════════════════════════════════════════════════════
const aiBtn = document.getElementById("aiBtn");
const aiModal = document.getElementById("aiModal");
const aiModalBody = document.getElementById("aiModalBody");
const aiModalClose = document.getElementById("aiModalClose");
const aiModalClose2 = document.getElementById("aiModalClose2");
const aiModalSave = document.getElementById("aiModalSave");

const RECORD_SEC = 10;   // seconds to record
const RECORD_HZ = 4;    // samples per second → 40 total samples
let aiRecording = false;
let aiSnapshots = [];   // collected sensor readings

// ── Recording phase ──────────────────────────────────────────
function startAiRecording() {
    if (aiRecording) return;

    // Ask for key once – stored in browser localStorage, never in code
    if (!getGroqKey()) {
        const key = prompt("🔑 Enter your Groq API key (free at console.groq.com).\nIt will be saved locally in your browser only:");
        if (!key || !key.startsWith("gsk_")) {
            alert("❌ Invalid Groq key. It must start with gsk_");
            return;
        }
        localStorage.setItem("groq_api_key", key.trim());
    }

    if (sensorData.every(v => v === 0)) {
        alert("⚠️ No live sensor data yet. Connect the device first.");
        return;
    }
    aiRecording = true;
    aiSnapshots = [];
    playClick();

    let elapsed = 0;
    const totalTicks = RECORD_SEC * RECORD_HZ;

    aiBtn.disabled = true;
    aiBtn.classList.add("btn-recording");

    const ticker = setInterval(() => {
        aiSnapshots.push([...sensorData]);   // snapshot current reading
        elapsed++;

        const secsLeft = Math.ceil((totalTicks - elapsed) / RECORD_HZ);
        aiBtn.textContent = `⏺ Recording… ${secsLeft}s`;

        if (elapsed >= totalTicks) {
            clearInterval(ticker);
            aiRecording = false;
            aiBtn.disabled = false;
            aiBtn.classList.remove("btn-recording");
            aiBtn.textContent = "🤖 AI Analysis";
            runAiAnalysis(aiSnapshots);
        }
    }, 1000 / RECORD_HZ);
}

// ── Groq API config (key stored in localStorage – never in code) ─
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
function getGroqKey() { return localStorage.getItem("groq_api_key") || ""; }

// ── Analysis engine (stats → Gemini) ──────────────────────────
async function runAiAnalysis(snapshots) {
    const n = snapshots.length;
    const numSensors = 8;

    // Local statistics (sent as context to Gemini)
    const avg = Array(numSensors).fill(0).map((_, i) =>
        snapshots.reduce((s, snap) => s + snap[i], 0) / n
    );
    const sd = avg.map((mean, i) =>
        Math.sqrt(snapshots.reduce((s, snap) => s + (snap[i] - mean) ** 2, 0) / n)
    );
    const range = Math.max(...avg) - Math.min(...avg);
    const upperMean = avg.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
    const lowerMean = avg.slice(4, 8).reduce((a, b) => a + b, 0) / 4;
    const asymmetry = Math.abs(upperMean - lowerMean);
    const cobbAngles = calculateAngles(avg);
    const cobbMax = Math.min(90, Math.max(...cobbAngles.filter(a => a !== null).map(a => Math.abs(parseFloat(a)))));
    const avgSD = sd.reduce((a, b) => a + b, 0) / numSensors;
    const stability = avgSD < 20 ? "Excellent" : avgSD < 60 ? "Good" : avgSD < 120 ? "Fair" : "Poor";

    // Show modal immediately with loading state
    const ts = new Date().toLocaleString();
    aiModalBody.innerHTML = `
      <p class="ai-timestamp">📅 Recorded: ${ts} &nbsp;|&nbsp; 📊 ${n} snapshots</p>

      <h3>📋 Sensor Averages (mm)</h3>
      <div class="ai-sensor-grid">
        ${avg.map((v, i) => `
          <div class="ai-sensor-chip">
            <span>${sensorLabels[i]}</span>
            <strong>${v.toFixed(0)}</strong>
            <small>±${sd[i].toFixed(0)}</small>
          </div>`).join("")}
      </div>

      <h3>📐 Key Metrics</h3>
      <table class="ai-table">
        <tr><td>Spinal Range</td>        <td><b>${range.toFixed(0)} mm</b></td></tr>
        <tr><td>Upper/Lower Offset</td>  <td><b>${asymmetry.toFixed(0)} mm</b></td></tr>
        <tr><td>Max Cobb-like Angle</td> <td><b>~${cobbMax.toFixed(1)}°</b></td></tr>
        <tr><td>Reading Stability</td>   <td><b>${stability}</b></td></tr>
      </table>

      <h3>🤖 Gemini AI Analysis</h3>
      <div id="geminiOutput" class="gemini-loading">
        <div class="ai-spinner"></div>
        <span>Asking Gemini AI…</span>
      </div>
    `;
    aiModal.style.display = "flex";

    // Build prompt
    const sensorSummary = avg.map((v, i) =>
        `${sensorLabels[i]} (${["Cervical top", "Cervical", "Upper Thoracic", "Mid Thoracic", "Lower Thoracic", "Upper Lumbar", "Lower Lumbar", "Sacral"][i]}): ${v.toFixed(0)} mm ±${sd[i].toFixed(0)}`
    ).join("\n");

    const prompt = `You are a clinical spinal analysis assistant helping a doctor interpret back mapping data from a LiDAR-based device.

The device has 8 sensors placed vertically along the spine from top to bottom. Each sensor measures the distance (in mm) from the sensor to the patient's back surface. A larger value means the surface is further away (more concave). 

Recorded data (averages over ${n} samples, ${RECORD_SEC} seconds):
${sensorSummary}

Computed metrics:
- Spinal lateral range (max-min): ${range.toFixed(0)} mm
- Upper vs Lower spine offset: ${asymmetry.toFixed(0)} mm
- Estimated maximum Cobb-like angle: ~${cobbMax.toFixed(1)}°
- Reading stability: ${stability} (based on sensor std deviation)

Please provide:
1. A brief clinical interpretation of the spinal curve pattern
2. Any concerns such as signs of scoliosis, kyphosis, or lordosis
3. A recommendation for the doctor (e.g. further imaging, monitoring, normal)

Write in clear, concise medical language suitable for a doctor's report. Keep it under 200 words.`;

    try {
        const res = await fetch(GROQ_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${getGroqKey()}`
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3,
                max_tokens: 400
            })
        });

        if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);

        const json = await res.json();
        const reply = json.choices?.[0]?.message?.content || "No response from Groq.";

        document.getElementById("geminiOutput").innerHTML =
            `<div class="gemini-reply">${reply.replace(/\n/g, "<br>")}</div>
             <p class="ai-disclaimer">⚠️ <em>This analysis is a clinical aid only and does not replace professional medical diagnosis.</em></p>`;

    } catch (err) {
        console.warn("[Gemini] Falling back to rule-based analysis:", err.message);

        // ── Rule-based fallback ──────────────────────────────────────
        const findings = [], alerts = [];

        if (range > 800) {
            findings.push("Significant curvature detected along spinal axis.");
            alerts.push("⚠️ High lateral deviation — consider further clinical assessment.");
        } else if (range > 400) {
            findings.push("Moderate curvature detected.");
            alerts.push("ℹ️ Moderate deviation — monitor regularly.");
        } else {
            findings.push("Spine curve within normal variation range.");
        }
        if (asymmetry > 300) {
            findings.push("Notable upper-to-lower spinal asymmetry.");
            alerts.push("⚠️ Upper/lower asymmetry detected — check for scoliosis signs.");
        }
        if (cobbMax > 25) {
            findings.push(`Estimated Cobb-like angle: ~${cobbMax.toFixed(1)}° (indicative only).`);
            alerts.push("🔴 Angle > 25° — clinical follow-up recommended.");
        } else if (cobbMax > 10) {
            findings.push(`Estimated Cobb-like angle: ~${cobbMax.toFixed(1)}°.`);
            alerts.push("ℹ️ Mild angulation detected.");
        }
        if (stability === "Poor" || stability === "Fair") {
            findings.push("Sensor readings showed notable variation — patient may have been moving.");
        }

        document.getElementById("geminiOutput").innerHTML = `
            <div class="gemini-fallback-notice">
              ⚠️ Gemini AI unavailable (<code>${err.message.slice(0, 60)}…</code>).<br>
              Showing rule-based analysis instead. 
              <a href="https://aistudio.google.com/app/apikey" target="_blank">Get a valid AI Studio key →</a>
            </div>
            <h4>🩺 Findings</h4>
            <ul class="ai-findings">${findings.map(f => `<li>${f}</li>`).join("")}</ul>
            ${alerts.length ? `<h4>🚨 Alerts</h4><ul class="ai-alerts">${alerts.map(a => `<li>${a}</li>`).join("")}</ul>` : ""}
            <p class="ai-disclaimer">⚠️ <em>Clinical aid only — not a substitute for professional medical diagnosis.</em></p>
        `;
    }
}

// ── Render modal ─────────────────────────────────────────────
function showAiReport(r) {
    const ts = new Date().toLocaleString();
    aiModalBody.innerHTML = `
      <p class="ai-timestamp">📅 Recorded: ${ts} &nbsp;|&nbsp; 📊 ${r.n} snapshots</p>

      <h3>📋 Sensor Averages (mm)</h3>
      <div class="ai-sensor-grid">
        ${r.avg.map((v, i) => `
          <div class="ai-sensor-chip">
            <span>${sensorLabels[i]}</span>
            <strong>${v.toFixed(0)}</strong>
            <small>±${r.sd[i].toFixed(0)}</small>
          </div>`).join("")}
      </div>

      <h3>📐 Key Metrics</h3>
      <table class="ai-table">
        <tr><td>Spinal Range</td>     <td><b>${r.range.toFixed(0)} mm</b></td></tr>
        <tr><td>Upper/Lower Offset</td><td><b>${r.asymmetry.toFixed(0)} mm</b></td></tr>
        <tr><td>Max Cobb-like Angle</td><td><b>~${r.cobbMax.toFixed(1)}°</b></td></tr>
        <tr><td>Reading Stability</td> <td><b>${r.stability}</b></td></tr>
      </table>

      <h3>🩺 Findings</h3>
      <ul class="ai-findings">
        ${r.findings.map(f => `<li>${f}</li>`).join("")}
      </ul>

      ${r.alerts.length ? `
      <h3>🚨 Alerts</h3>
      <ul class="ai-alerts">
        ${r.alerts.map(a => `<li>${a.level} ${a.text}</li>`).join("")}
      </ul>` : ""}

      <p class="ai-disclaimer">⚠️ <em>This analysis is a clinical aid only and does not replace professional medical diagnosis.</em></p>
    `;
    aiModal.style.display = "flex";
}

// ── Save report ───────────────────────────────────────────────
function saveAiReport() {
    const text = aiModalBody.innerText;
    const blob = new Blob([text], { type: "text/plain" });
    const link = document.createElement("a");
    link.download = `AI_Report_${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    link.href = URL.createObjectURL(blob);
    link.click();
}

// ── Modal controls ────────────────────────────────────────────
aiModalClose.addEventListener("click", () => { aiModal.style.display = "none"; });
aiModalClose2.addEventListener("click", () => { aiModal.style.display = "none"; });
aiModalSave.addEventListener("click", saveAiReport);
aiModal.addEventListener("click", e => { if (e.target === aiModal) aiModal.style.display = "none"; });

// ═══════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════
startBtn.addEventListener("click", () => { playClick(); startDemo(); });
stopBtn.addEventListener("click", () => { playClick(); stopDemo(); });
measToggleBtn.addEventListener("click", () => { playClick(); measurementsVisible = !measurementsVisible; updatePlot(); });
showAnglesBtn.addEventListener("click", () => { playClick(); anglesVisible = !anglesVisible; updatePlot(); });
toggleLabelsBtn.addEventListener("click", () => { playClick(); labelsVisible = !labelsVisible; updatePlot(); });
reportBtn.addEventListener("click", takeReport);
aiBtn.addEventListener("click", startAiRecording);

// ═══════════════════════════════════════════════════════════════
//  INITIALISE
// ═══════════════════════════════════════════════════════════════
updatePlot();      // render empty chart immediately
connectFirebase(); // start listening to Firebase live data
