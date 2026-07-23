import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getDatabase, ref, onValue, set, remove } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-database.js";

// ===============================
// LOGIN ACCOUNTS
// ===============================
// Admin account: full control
// Viewer account: view data only, cannot control pumps or mode
const USERS = [
  { username: "admin", password: "129306", role: "admin", label: "Admin" },
  { username: "viewer", password: "1234", role: "viewer", label: "Viewer" }
];

const firebaseConfig = {
  apiKey: "AIzaSyCbw3uRsDJroD8Z96aXXpduyIufZrwRhM0",
  authDomain: "iot-smart-irrigtion-system.firebaseapp.com",
  databaseURL: "https://iot-smart-irrigtion-system-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "iot-smart-irrigtion-system",
  storageBucket: "iot-smart-irrigtion-system.firebasestorage.app",
  messagingSenderId: "502244731514",
  appId: "1:502244731514:web:a59f541885fbdeee2629c3",
  measurementId: "G-338YFR1VFV"
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

const latestRef = ref(database, "sensor/latest");
const historyRef = ref(database, "history");

const modeRef = ref(database, "control/mode");
const pump1Ref = ref(database, "control/pump1");
const pump2Ref = ref(database, "control/pump2");

let currentMode = "AUTO";
let latestSensorTimestamp = 0;
let allHistoryData = [];
let historyData = [];
let historyChart = null;
let currentGraphField = null;

let historyStartIndex = 0;
const historyWindowSize = 40;

const graphInfo = {
  temperature: { title: "Temperature Data History", label: "Temperature °C" },
  humidity: { title: "Humidity Data History", label: "Humidity %" },
  moisturePercent: { title: "Soil Moisture Data History", label: "Soil Moisture %" },
  rainState: { title: "Rain Sensor Data History", label: "Rain Status" },

  borewellLevel: { title: "Borewell Water Level Data History", label: "Borewell Level %" },
  spareTankLevel: { title: "Spare Tank Water Level Data History", label: "Spare Tank Level %" },
  borewellPercent: { title: "Borewell Water Level Data History", label: "Borewell Level %" },
  spareTankPercent: { title: "Spare Tank Water Level Data History", label: "Spare Tank Level %" },

  batteryVoltage: { title: "Battery Voltage Data History", label: "Battery Voltage V" },
  chargingCurrent: { title: "Charging Current Data History", label: "Charging Current A" },
  chargingPower: { title: "Solar Power Data History", label: "Solar Power W" },
  solarChargingStatus: { title: "Solar Charging Status Data History", label: "Solar Status" }
};

function getCurrentRole() {
  return sessionStorage.getItem("smartIrrigationRole") || "";
}

function isAdmin() {
  return getCurrentRole() === "admin";
}

function isViewer() {
  return getCurrentRole() === "viewer";
}

function requireAdminControl() {
  if (!isAdmin()) {
    alert("This is a VIEW-ONLY account. You can monitor data but cannot control the system.");
    return false;
  }

  return true;
}

function applyRolePermissions() {
  const role = getCurrentRole();
  const modeButtons = document.querySelectorAll(".mode-btn");
  const manualButtons = document.querySelectorAll(".manual-control");
  const modeNote = document.getElementById("modeNote");
  const controlNote = document.getElementById("controlNote");

  if (role === "viewer") {
    modeButtons.forEach(button => {
      button.disabled = true;
      button.title = "Viewer account can only monitor data.";
    });

    manualButtons.forEach(button => {
      button.disabled = true;
      button.title = "Viewer account can only monitor data.";
    });

    if (modeNote) {
      modeNote.innerHTML = "VIEW-ONLY account active. Live data and history graphs are available.";
    }

    if (controlNote) {
      controlNote.innerHTML = "VIEW-ONLY MODE: You can monitor data, but you cannot control pumps or system mode.";
    }
  } else if (role === "admin") {
    modeButtons.forEach(button => {
      button.disabled = false;
      button.title = "";
    });

    manualButtons.forEach(button => {
      button.title = currentMode === "MANUAL"
        ? ""
        : "Manual controls unlock only when system mode is MANUAL.";
    });
  }
}

function checkLoginStatus() {
  const isLoggedIn = sessionStorage.getItem("smartIrrigationLogin");
  const role = getCurrentRole();
  const validSession = isLoggedIn === "true" && (role === "admin" || role === "viewer");

  document.body.classList.toggle("logged-in", validSession);

  if (validSession) {
    applyRolePermissions();
  } else {
    sessionStorage.removeItem("smartIrrigationLogin");
    sessionStorage.removeItem("smartIrrigationRole");
    sessionStorage.removeItem("smartIrrigationUser");
  }
}

window.login = function() {
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value.trim();
  const errorBox = document.getElementById("loginError");

  const user = USERS.find(account =>
    account.username === username && account.password === password
  );

  if (user) {
    sessionStorage.setItem("smartIrrigationLogin", "true");
    sessionStorage.setItem("smartIrrigationRole", user.role);
    sessionStorage.setItem("smartIrrigationUser", user.username);

    document.body.classList.add("logged-in");
    errorBox.innerHTML = "";

    applyRolePermissions();
  } else {
    errorBox.innerHTML = "Wrong username or password";
  }
};

window.logout = function() {
  sessionStorage.removeItem("smartIrrigationLogin");
  sessionStorage.removeItem("smartIrrigationRole");
  sessionStorage.removeItem("smartIrrigationUser");
  document.body.classList.remove("logged-in");
  document.getElementById("loginUsername").value = "";
  document.getElementById("loginPassword").value = "";
  document.getElementById("loginError").innerHTML = "";
  closeSettingsMenu();
};


window.deleteAllHistory = async function() {
  if (!isAdmin()) {
    alert("Only admin can delete history data.");
    return;
  }

  const confirmDelete = confirm("Are you sure you want to delete all historical data? This action cannot be undone.");

  if (!confirmDelete) return;

  try {
    await remove(historyRef);
    allHistoryData = [];
    historyData = [];
    updateHistoryWindow();
    alert("All history data has been deleted successfully.");
  } catch (error) {
    console.error(error);
    alert("Failed to delete history data.");
  }
};

function closeSettingsMenu() {
  const menu = document.getElementById("settingsMenu");
  const button = document.getElementById("settingsButton");

  if (menu) menu.classList.remove("show");
  if (button) button.setAttribute("aria-expanded", "false");
}

window.toggleSettingsMenu = function(event) {
  if (event) event.stopPropagation();

  const menu = document.getElementById("settingsMenu");
  const button = document.getElementById("settingsButton");
  if (!menu || !button) return;

  const isOpen = menu.classList.toggle("show");
  button.setAttribute("aria-expanded", isOpen ? "true" : "false");
};

document.addEventListener("click", function(event) {
  const wrap = document.getElementById("settingsWrap");
  if (wrap && !wrap.contains(event.target)) closeSettingsMenu();
});

window.addEventListener("keydown", function(event) {
  if (event.key === "Escape") closeSettingsMenu();
});

window.addEventListener("keydown", function(event) {
  if (event.key === "Enter" && !document.body.classList.contains("logged-in")) {
    login();
  }
});

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setAnimatedText(id, value) {
  const element = document.getElementById(id);
  const nextValue = value ?? "--";

  if (element.innerHTML !== String(nextValue)) {
    element.innerHTML = nextValue;
    element.classList.remove("value-pop");
    void element.offsetWidth;
    element.classList.add("value-pop");
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("iotTheme", theme);

  const button = document.getElementById("themeButton");
  button.innerHTML = theme === "night"
    ? "🌙 <span id='themeLabel'>NIGHT</span>"
    : "☀️ <span id='themeLabel'>DAY</span>";

  if (currentGraphField) renderGraph(currentGraphField);
}

window.toggleTheme = function() {
  const currentTheme = document.documentElement.getAttribute("data-theme");
  setTheme(currentTheme === "night" ? "day" : "night");
};

function updateRealtimeStatus() {
  const statusBox = document.getElementById("status");
  const lastUpdateBox = document.getElementById("lastUpdate");

  statusBox.classList.remove("online", "stale", "offline");

  if (!latestSensorTimestamp) {
    statusBox.innerHTML = "Waiting";
    statusBox.classList.add("offline");
    lastUpdateBox.innerHTML = "Update: --";
    return;
  }

  const diff = Date.now() - latestSensorTimestamp;
  const date = new Date(latestSensorTimestamp);

  lastUpdateBox.innerHTML = "Update: " + date.toLocaleTimeString("en-MY", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  if (diff <= 8000) {
    statusBox.innerHTML = "Live";
    statusBox.classList.add("online");
  } else if (diff <= 20000) {
    statusBox.innerHTML = "Slow update";
    statusBox.classList.add("stale");
  } else {
    statusBox.innerHTML = "Offline";
    statusBox.classList.add("offline");
  }
}

setInterval(updateRealtimeStatus, 1000);

function updatePumpBadge(id, status) {
  const badge = document.getElementById(id);
  const nextStatus = status ?? "--";

  if (badge.innerHTML !== String(nextStatus)) {
    badge.innerHTML = nextStatus;
    badge.classList.remove("badge-pop");
    void badge.offsetWidth;
    badge.classList.add("badge-pop");
  }

  badge.classList.remove("on", "off", "waiting");

  if (status === "ON") {
    badge.classList.add("on");
  } else if (status === "OFF") {
    badge.classList.add("off");
  } else {
    badge.classList.add("waiting");
  }
}

function updateModeUI(mode) {
  currentMode = mode || "AUTO";

  const modeBadge = document.getElementById("modeBadge");
  const autoBtn = document.getElementById("autoBtn");
  const manualBtn = document.getElementById("manualBtn");
  const modeNote = document.getElementById("modeNote");
  const controlNote = document.getElementById("controlNote");
  const manualButtons = document.querySelectorAll(".manual-control");

  if (modeBadge.innerHTML !== String(currentMode)) {
    modeBadge.innerHTML = currentMode;
    modeBadge.classList.remove("badge-pop");
    void modeBadge.offsetWidth;
    modeBadge.classList.add("badge-pop");
  }

  modeBadge.classList.remove("auto", "manual");
  autoBtn.classList.remove("active-auto");
  manualBtn.classList.remove("active-manual");

  if (currentMode === "MANUAL") {
    modeBadge.classList.add("manual");
    manualBtn.classList.add("active-manual");
    modeNote.innerHTML = "Manual mode active. Web button sends command to control.";
    controlNote.innerHTML = "Display follows live data. Commands are written to Firebase control.";
    manualButtons.forEach(button => button.disabled = false);
  } else {
    modeBadge.classList.add("auto");
    autoBtn.classList.add("active-auto");
    modeNote.innerHTML = "";
    controlNote.innerHTML = "Manual controls are locked until mode becomes MANUAL.";
    manualButtons.forEach(button => button.disabled = true);
  }

  applyRolePermissions();
}

function parsePercentValue(value) {
  if (value === null || value === undefined) return null;

  const text = String(value).trim().toUpperCase();
  if (!text || text === "--" || text === "ERROR") return null;

  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) return null;

  const number = Number(match[0]);
  if (isNaN(number)) return null;

  return Math.max(0, Math.min(100, number));
}

function formatTankDisplay(level, percentValue) {
  const percent = parsePercentValue(percentValue);
  if (percent !== null) return Math.round(percent) + "%";

  const levelPercent = parsePercentValue(level);
  if (levelPercent !== null) return Math.round(levelPercent) + "%";

  return String(level || "--").toUpperCase();
}

function convertValue(field, value) {
  if (field === "rainState") return value == "0" ? 1 : 0;

  if (field === "borewellLevel" || field === "spareTankLevel" ||
      field === "borewellPercent" || field === "spareTankPercent") {
    const percent = parsePercentValue(value);
    if (percent !== null) return percent;

    //Fallback untuk data history lama yang masih guna HIGH/MIDDLE/LOW
    const normalized = String(value || "").toUpperCase();
    if (normalized === "LOW") return 18;
    if (normalized === "MIDDLE") return 52;
    if (normalized === "HIGH") return 82;
    return 0;
  }

  if (field === "solarChargingStatus") {
    if (value === "CHARGING") return 1;
    if (value === "NOT CHARGING") return 0;
    return 0;
  }

  return Number(value);
}

function formatHistoryDateTime(timestamp) {
  if (!timestamp) return "--";

  const date = new Date(Number(timestamp));

  if (isNaN(date.getTime())) return "--";

  return date.toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }) + " " + date.toLocaleTimeString("en-MY", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function makeTimeLabel(item, index) {
  if (item.timestamp) {
    const date = new Date(Number(item.timestamp));

    if (!isNaN(date.getTime())) {
      const dateLabel = date.toLocaleDateString("en-MY", {
        day: "2-digit",
        month: "short"
      });

      const timeLabel = date.toLocaleTimeString("en-MY", {
        hour: "2-digit",
        minute: "2-digit"
      });

      // Chart.js supports array labels as multi-line labels.
      return [dateLabel, timeLabel];
    }
  }

  return "Data " + (index + 1);
}

function updateHistoryWindow() {
  if (!allHistoryData.length) {
    historyData = [];
    const slider = document.getElementById("historySlider");
    const info = document.getElementById("historyInfo");

    if (slider) {
      slider.max = 0;
      slider.value = 0;
    }

    if (info) {
      info.innerHTML = "No history data available";
    }

    return;
  }

  const maxStart = Math.max(0, allHistoryData.length - historyWindowSize);

  if (historyStartIndex < 0) {
    historyStartIndex = 0;
  }

  if (historyStartIndex > maxStart) {
    historyStartIndex = maxStart;
  }

  historyData = allHistoryData.slice(
    historyStartIndex,
    historyStartIndex + historyWindowSize
  );

  const slider = document.getElementById("historySlider");
  const info = document.getElementById("historyInfo");

  if (slider) {
    slider.max = maxStart;
    slider.value = historyStartIndex;
  }

  if (info) {
    const start = historyStartIndex + 1;
    const end = Math.min(historyStartIndex + historyWindowSize, allHistoryData.length);
    const firstItem = historyData[0];
    const lastItem = historyData[historyData.length - 1];
    const firstDate = firstItem ? formatHistoryDateTime(firstItem.timestamp) : "--";
    const lastDate = lastItem ? formatHistoryDateTime(lastItem.timestamp) : "--";

    info.innerHTML =
      `Showing data ${start} - ${end} of ${allHistoryData.length}<br>${firstDate} → ${lastDate}`;
  }
}

window.slideHistory = function(value) {
  historyStartIndex = Number(value);
  updateHistoryWindow();

  if (currentGraphField) {
    renderGraph(currentGraphField);
  }
};

window.moveHistory = function(direction) {
  historyStartIndex += direction * historyWindowSize;
  updateHistoryWindow();

  if (currentGraphField) {
    renderGraph(currentGraphField);
  }
};

function renderGraph(field) {
  if (typeof Chart === "undefined") {
    alert("Chart.js tidak berjaya load. Pastikan internet ada.");
    return;
  }

  currentGraphField = field;
  const info = graphInfo[field];
  document.getElementById("graphTitle").innerHTML = info.title;

  const labels = historyData.map((item, index) => makeTimeLabel(item, index));
  const values = historyData.map(item => convertValue(field, item[field]));
  const ctx = document.getElementById("historyChart").getContext("2d");

  if (historyChart) historyChart.destroy();

  historyChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [{
        label: info.label,
        data: values,
        borderColor: cssVar("--chart-line"),
        backgroundColor: cssVar("--chart-fill"),
        pointBackgroundColor: cssVar("--chart-line"),
        pointBorderColor: cssVar("--chart-bg"),
        borderWidth: 3,
        tension: 0.36,
        pointRadius: 4,
        pointHoverRadius: 6,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 420 },
      plugins: {
        legend: {
          labels: {
            color: cssVar("--chart-text"),
            font: { weight: "bold" }
          }
        },
        tooltip: {
          padding: 12,
          displayColors: false,
          titleFont: { weight: "bold" },
          bodyFont: { weight: "bold" }
        }
      },
      scales: {
        x: {
          ticks: {
            color: cssVar("--chart-text"),
            maxRotation: 45,
            minRotation: 0
          },
          grid: { color: cssVar("--chart-grid") }
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: cssVar("--chart-text"),
            stepSize: 1,
            callback: function(value) {
              if (field === "borewellLevel" || field === "spareTankLevel" ||
                  field === "borewellPercent" || field === "spareTankPercent") {
                return value + "%";
              }

              if (field === "rainState") {
                if (value === 0) return "CLEAR";
                if (value === 1) return "RAIN";
                return "";
              }

              if (field === "solarChargingStatus") {
                if (value === 0) return "NOT CHARGING";
                if (value === 1) return "CHARGING";
                return "";
              }

              return value;
            }
          },
          grid: { color: cssVar("--chart-grid") }
        }
      }
    }
  });
}

function getTankFillPercent(level, percentValue) {
  const percent = parsePercentValue(percentValue);
  if (percent !== null) return percent;

  const levelPercent = parsePercentValue(level);
  if (levelPercent !== null) return levelPercent;

  //Fallback untuk data lama yang masih guna HIGH/MIDDLE/LOW
  const normalized = String(level || "").toUpperCase();
  if (normalized === "HIGH") return 82;
  if (normalized === "MIDDLE") return 52;
  if (normalized === "LOW") return 18;
  return 6;
}

function updateTankVisual(fillId, noteId, level, percentValue) {
  const fillEl = document.getElementById(fillId);
  const noteEl = document.getElementById(noteId);
  if (!fillEl || !noteEl) return;

  const normalized = String(level || "--").toUpperCase();
  const pct = getTankFillPercent(level, percentValue);
  const displayText = formatTankDisplay(level, percentValue);

  fillEl.style.height = pct + "%";
  fillEl.classList.remove("high", "middle", "low", "error");

  if (normalized === "ERROR" || displayText === "ERROR") {
    fillEl.classList.add("error");
  } else if (pct >= 70) {
    fillEl.classList.add("high");
  } else if (pct >= 35) {
    fillEl.classList.add("middle");
  } else {
    fillEl.classList.add("low");
  }

  noteEl.textContent = displayText || "--";
}

onValue(latestRef, (snapshot) => {
  const data = snapshot.val();

  if (!data) {
    document.getElementById("status").innerHTML = "No data";
    updateTankVisual("borewellTankFill", "borewellTankNote", "--");
    updateTankVisual("spareTankFill", "spareTankNote", "--");
    latestSensorTimestamp = 0;
    updateRealtimeStatus();
    return;
  }

  setAnimatedText("temp", data.temperature ?? "--");
  setAnimatedText("hum", data.humidity ?? "--");
  setAnimatedText("moisture", data.moisturePercent ?? "--");

  if (data.rainStatus === "RAIN") {
    setAnimatedText("rain", "RAIN");
  } else if (data.rainStatus === "NO_RAIN") {
    setAnimatedText("rain", "CLEAR");
  } else if (data.rainState == "0") {
    setAnimatedText("rain", "RAIN");
  } else if (data.rainState == "1") {
    setAnimatedText("rain", "CLEAR");
  } else {
    setAnimatedText("rain", "--");
  }

  setAnimatedText("borewell", formatTankDisplay(data.borewellLevel, data.borewellPercent));
  setAnimatedText("spareTank", formatTankDisplay(data.spareTankLevel, data.spareTankPercent));

  updateTankVisual(
    "borewellTankFill",
    "borewellTankNote",
    data.borewellLevel ?? "--",
    data.borewellPercent
  );

  updateTankVisual(
    "spareTankFill",
    "spareTankNote",
    data.spareTankLevel ?? "--",
    data.spareTankPercent
  );

  setAnimatedText("batteryVoltage", data.batteryVoltage ?? "--");
  setAnimatedText("chargingCurrent", data.chargingCurrent ?? "--");
  setAnimatedText("chargingPower", data.chargingPower ?? "--");
  setAnimatedText("solarStatus", data.solarChargingStatus ?? "--");

  updatePumpBadge("pump1Badge", data.pump1 ?? "--");
  updatePumpBadge("pump2Badge", data.pump2 ?? "--");

  if (data.mode === "AUTO" || data.mode === "MANUAL") {
    updateModeUI(data.mode);
  }

  latestSensorTimestamp = data.timestamp ? Number(data.timestamp) : Date.now();
  updateRealtimeStatus();
});

onValue(historyRef, (snapshot) => {
  const data = snapshot.val();

  if (data) {
    allHistoryData = Object.values(data);
    allHistoryData.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // If graph is not open, keep slider at latest data.
    // If graph is open, maintain the user's current slider position.
    if (!currentGraphField) {
      historyStartIndex = Math.max(0, allHistoryData.length - historyWindowSize);
    }

    updateHistoryWindow();

    if (currentGraphField) {
      renderGraph(currentGraphField);
    }
  } else {
    allHistoryData = [];
    historyData = [];
    updateHistoryWindow();
  }
});

window.setMode = function(mode) {
  if (!requireAdminControl()) return;

  set(modeRef, mode);

  if (mode === "AUTO") {
    set(pump1Ref, "OFF");
    set(pump2Ref, "OFF");
  }

  document.getElementById("controlNote").innerHTML =
    "Mode command sent to control. Waiting system to update...";
};

window.setPump1 = function(status) {
  if (!requireAdminControl()) return;

  if (currentMode === "MANUAL") {
    set(pump1Ref, status);
    document.getElementById("controlNote").innerHTML =
      "Borewell pump command sent to control. Waiting system to update...";
  } else {
    alert("Pump control hanya boleh digunakan bila sistem mode = MANUAL.");
  }
};

window.setPump2 = function(status) {
  if (!requireAdminControl()) return;

  if (currentMode === "MANUAL") {
    set(pump2Ref, status);
    document.getElementById("controlNote").innerHTML =
      "Spare tank pump command sent to control. Waiting system to update...";
  } else {
    alert("Pump control hanya boleh digunakan bila sistem mode = MANUAL.");
  }
};

window.openGraph = function(field) {
  const modal = document.getElementById("graphModal");
  modal.style.display = "flex";
  requestAnimationFrame(() => modal.classList.add("show"));

  // Start from latest data whenever a graph is opened
  historyStartIndex = Math.max(0, allHistoryData.length - historyWindowSize);
  updateHistoryWindow();

  renderGraph(field);
};

window.closeGraph = function() {
  const modal = document.getElementById("graphModal");
  modal.classList.remove("show");

  setTimeout(() => {
    modal.style.display = "none";
    currentGraphField = null;
  }, 180);
};

const savedTheme = localStorage.getItem("iotTheme") || "night";

checkLoginStatus();
setTheme(savedTheme);
updateModeUI("AUTO");
updateRealtimeStatus();
