import {
  normalizeRole,
  hasSystemControlAccess,
  canManageUsers,
  canDeleteAllHistory,
  canUpdateFirmware
} from "./access-control.mjs";
import {
  normalizeUserStatus,
  getUserInitials,
  sortUserEntries,
  getUserSummary,
  filterUserEntries
} from "./user-management-utils.mjs";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  deleteUser,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import { getDatabase, ref, push, onValue, get, set, update, remove } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-database.js";
// MODIFICATION: Import Firebase Messaging
import { getMessaging, getToken, deleteToken, onMessage, isSupported } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging.js";

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
const auth = getAuth(app);
auth.languageCode = "en";
const database = getDatabase(app);

// Firebase Cloud Messaging only works in a supported secure browser context.
// Keep the rest of the web app usable over the Orange Pi's local HTTP address.
let messaging = null;
const CURRENT_FCM_TOKEN_KEY = "smartIrrigationCurrentFcmToken";

async function initializeMessaging() {
  try {
    if (!window.isSecureContext || !(await isSupported())) return;

    messaging = getMessaging(app);
    onMessage(messaging, (payload) => {
      console.log("Foreground message received: ", payload);
      const notificationTitle = payload.data?.title || payload.notification?.title || "Smart Irrigation";
      const notificationBody = payload.data?.body || payload.notification?.body || "A new irrigation system alert is available.";

      alert(`${notificationTitle}\n${notificationBody}`);
    });
  } catch (error) {
    console.warn("Firebase Messaging tidak tersedia dalam pelayar ini.", error);
  }
}

initializeMessaging();

// MODIFICATION: Push Notification Setup Function
async function setupPushNotifications(userUid) {
  try {
    if (!messaging || !window.isSecureContext || !("Notification" in window)) return;

    const permission = await Notification.requestPermission();
    
    if (permission === "granted") {
      const swRegistration = await navigator.serviceWorker.register('./firebase-messaging-sw.js', {
        scope: './'
      });

      const token = await getToken(messaging, {
        vapidKey: "BEzQHNigs0JY_MWDDUcx93Oee8R3tYp2b3yVqAHpAwvKpM6DlY23PHXWy0c-qgVRJq5qjRLfBTHbmUc_ft3Ktrw",
        serviceWorkerRegistration: swRegistration
      });

      if (token) {
        console.log("FCM Token berjaya didapati:", token);
        // One account may be used on several phones. Each device keeps its own
        // token, while the Orange Pi cleanup tool removes obsolete tokens when needed.
        await set(ref(database, `users/${userUid}/fcmTokens/${token}`), true);
        localStorage.setItem(CURRENT_FCM_TOKEN_KEY, token);
      }
    }
  } catch (error) {
    console.error("Ralat mendapatkan token notifikasi:", error);
  }
}


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

let currentRole = "";
let registrationInProgress = false;
let unsubscribeLatest = null;
let unsubscribeHistory = null;
let userManagementEntries = [];
let userManagementLoading = false;
let userManagementError = "";
let selectedFirmwareFile = null;
let otaUploadInProgress = false;
let otaDeviceOnline = false;

const MAX_FIRMWARE_FILE_SIZE = 16 * 1024 * 1024;
const OTA_API_URL = "/api/ota";
const OTA_USE_FIREBASE_RELAY = window.location.hostname.toLowerCase().endsWith("github.io");
const OTA_RELAY_STATUS_MAX_AGE_MS = 60 * 1000;
const OTA_RELAY_TIMEOUT_MS = 5 * 60 * 1000;

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
  return currentRole;
}

function isAdmin() {
  return hasSystemControlAccess(getCurrentRole());
}

function isAdministrator() {
  return canManageUsers(getCurrentRole());
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
  const deleteHistoryButton = document.querySelector(".delete-history-btn");
  const manageUsersButton = document.getElementById("manageUsersButton");
  const firmwareUpdateButton = document.getElementById("firmwareUpdateButton");

  if (manageUsersButton) {
    const allowed = isAdministrator();
    manageUsersButton.style.display = "";
    manageUsersButton.disabled = !allowed;
    manageUsersButton.setAttribute("aria-disabled", String(!allowed));
    manageUsersButton.title = allowed
      ? ""
      : "Only an Administrator account can manage users.";
  }

  if (deleteHistoryButton) {
    const allowed = canDeleteAllHistory(role);
    deleteHistoryButton.disabled = !allowed;
    deleteHistoryButton.setAttribute("aria-disabled", String(!allowed));
    deleteHistoryButton.title = allowed
      ? ""
      : "Only an Administrator account can delete all history data.";
  }

  if (firmwareUpdateButton) {
    const allowed = canUpdateFirmware(role);
    firmwareUpdateButton.disabled = !allowed;
    firmwareUpdateButton.setAttribute("aria-disabled", String(!allowed));
    firmwareUpdateButton.title = allowed
      ? ""
      : "Only an Administrator account can install firmware updates.";
  }

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
  } else if (hasSystemControlAccess(role)) {
    modeButtons.forEach(button => {
      button.disabled = false;
      button.title = "";
    });

    manualButtons.forEach(button => {
      button.disabled = currentMode !== "MANUAL";
      button.title = currentMode === "MANUAL"
        ? ""
        : "Manual controls unlock only when system mode is MANUAL.";
    });
  }
}

function setLoginMessage(message = "", type = "error") {
  const errorBox = document.getElementById("loginError");
  if (!errorBox) return;

  errorBox.textContent = message;
  errorBox.classList.toggle("success", type === "success");
}

function setLoginLoading(isLoading) {
  const button = document.getElementById("loginButton");
  if (!button) return;

  button.disabled = isLoading;
  button.classList.toggle("is-loading", isLoading);
  button.textContent = isLoading ? "SIGNING IN..." : "LOGIN TO APP";
}

function getAuthErrorMessage(error) {
  const code = error?.code || "";

  if (code === "auth/invalid-email") return "Please enter a valid email address.";
  if (code === "auth/invalid-credential" || code === "auth/user-not-found" || code === "auth/wrong-password") {
    return "Incorrect email or password.";
  }
  if (code === "auth/too-many-requests") return "Too many attempts. Please try again later or reset your password.";
  if (code === "auth/network-request-failed") return "Network error. Check your internet connection.";
  if (code === "auth/user-disabled") return "This account has been disabled.";

  return "Unable to sign in. Please try again.";
}

async function resolveUserProfile(user) {
  try {
    const snapshot = await get(ref(database, `users/${user.uid}`));
    return snapshot.val() || {};
  } catch (error) {
    console.warn("Unable to read user profile.", error);
    return { status: "access-error" };
  }
}

function getProfileRole(profile = {}) {
  return normalizeRole(profile.role);
}

function getProfileStatus(profile = {}) {
  const status = String(profile.status || "").toLowerCase();
  return status || "approved";
}

window.showAuthView = function(view) {
  const isRegister = view === "register";
  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");
  const loginTab = document.getElementById("loginTab");
  const registerTab = document.getElementById("registerTab");

  if (!loginForm || !registerForm || !loginTab || !registerTab) return;

  loginForm.hidden = isRegister;
  registerForm.hidden = !isRegister;
  loginTab.classList.toggle("active", !isRegister);
  registerTab.classList.toggle("active", isRegister);
  loginTab.setAttribute("aria-selected", String(!isRegister));
  registerTab.setAttribute("aria-selected", String(isRegister));
  setLoginMessage("");

  requestAnimationFrame(() => {
    document.getElementById(isRegister ? "registerName" : "loginEmail")?.focus();
  });
};

function setRegisterLoading(isLoading) {
  const button = document.getElementById("registerButton");
  if (!button) return;

  button.disabled = isLoading;
  button.classList.toggle("is-loading", isLoading);
  button.textContent = isLoading ? "CREATING ACCOUNT..." : "CREATE ACCOUNT";
}

function getRegisterErrorMessage(error) {
  const code = error?.code || "";

  if (code === "auth/email-already-in-use") return "This email address is already registered.";
  if (code === "auth/invalid-email") return "Please enter a valid email address.";
  if (code === "auth/weak-password") return "Password must contain at least 6 characters.";
  if (code === "auth/operation-not-allowed") return "Email registration is not enabled in Firebase Authentication.";
  if (code === "auth/network-request-failed") return "Network error. Check your internet connection.";
  if (code === "PERMISSION_DENIED" || code === "permission-denied") {
    return "Account was created, but the user profile could not be saved. Check Firebase Database rules.";
  }

  return "Unable to create the account. Please try again.";
}

window.registerUser = async function() {
  const name = document.getElementById("registerName").value.trim();
  const email = document.getElementById("registerEmail").value.trim();
  const password = document.getElementById("registerPassword").value;
  const confirmPassword = document.getElementById("registerConfirmPassword").value;

  setLoginMessage("");

  if (!name || !email || !password || !confirmPassword) {
    setLoginMessage("Please complete all registration fields.");
    return;
  }

  if (password.length < 6) {
    setLoginMessage("Password must contain at least 6 characters.");
    return;
  }

  if (password !== confirmPassword) {
    setLoginMessage("Password confirmation does not match.");
    return;
  }

  setRegisterLoading(true);
  registrationInProgress = true;
  let createdUser = null;

  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    createdUser = credential.user;

    await set(ref(database, `users/${createdUser.uid}`), {
      name,
      email,
      role: "viewer",
      status: "pending",
      createdAt: Date.now()
    });

    await signOut(auth);

    document.getElementById("registerName").value = "";
    document.getElementById("registerEmail").value = "";
    document.getElementById("registerPassword").value = "";
    document.getElementById("registerConfirmPassword").value = "";
    document.getElementById("loginEmail").value = email;
    window.showAuthView("login");
    setLoginMessage("Account created successfully. Please wait for administrator approval before logging in.", "success");
  } catch (error) {
    console.error("Registration failed", error);

    if (createdUser && auth.currentUser?.uid === createdUser.uid) {
      try {
        await deleteUser(createdUser);
      } catch (cleanupError) {
        console.warn("Unable to remove incomplete registration account.", cleanupError);
        try { await signOut(auth); } catch (_) {}
      }
    }

    setLoginMessage(getRegisterErrorMessage(error));
  } finally {
    registrationInProgress = false;
    setRegisterLoading(false);
  }
};

window.login = async function() {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  setLoginMessage("");

  if (!email || !password) {
    setLoginMessage("Please enter your email and password.");
    return;
  }

  setLoginLoading(true);

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    console.error(error);
    setLoginMessage(getAuthErrorMessage(error));
  } finally {
    setLoginLoading(false);
  }
};

window.forgotPassword = async function() {
  const email = document.getElementById("loginEmail").value.trim();

  if (!email) {
    setLoginMessage("Enter your email address first, then press Forgot password.");
    document.getElementById("loginEmail").focus();
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);
    setLoginMessage("Password reset email sent. Check your inbox.", "success");
  } catch (error) {
    console.error(error);
    if (error?.code === "auth/invalid-email") {
      setLoginMessage("Please enter a valid email address.");
    } else if (error?.code === "auth/too-many-requests") {
      setLoginMessage("Too many requests. Please try again later.");
    } else if (error?.code === "auth/network-request-failed") {
      setLoginMessage("Network error. Check your internet connection.");
    } else {
      setLoginMessage("If the email is registered, a reset link will be sent.", "success");
    }
  }
};

function getUserManagementElements() {
  return {
    list: document.getElementById("userManagementList"),
    message: document.getElementById("userManagementMessage"),
    resultCount: document.getElementById("userManagementResultCount"),
    search: document.getElementById("userManagementSearch"),
    statusFilter: document.getElementById("userManagementStatusFilter"),
    metricTotal: document.getElementById("userMetricTotal"),
    metricPending: document.getElementById("userMetricPending"),
    metricApproved: document.getElementById("userMetricApproved"),
    metricRejected: document.getElementById("userMetricRejected")
  };
}

function setUserManagementMetrics(elements, summary = null) {
  const values = summary || { total: "—", pending: "—", approved: "—", rejected: "—" };
  if (elements.metricTotal) elements.metricTotal.textContent = String(values.total);
  if (elements.metricPending) elements.metricPending.textContent = String(values.pending);
  if (elements.metricApproved) elements.metricApproved.textContent = String(values.approved);
  if (elements.metricRejected) elements.metricRejected.textContent = String(values.rejected);
}

function createUserManagementEmptyState(title, description, variant = "") {
  const state = document.createElement("div");
  state.className = `user-management-empty${variant ? ` ${variant}` : ""}`;

  const icon = document.createElement("span");
  icon.className = "user-management-empty-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = variant === "error" ? "!" : "👥";

  const heading = document.createElement("strong");
  heading.textContent = title;

  const text = document.createElement("p");
  text.textContent = description;

  state.append(icon, heading, text);
  return state;
}

function createUserManagementSkeleton() {
  const skeleton = document.createElement("div");
  skeleton.className = "user-management-skeleton-card";
  skeleton.setAttribute("aria-hidden", "true");
  skeleton.innerHTML = `
    <span class="user-management-skeleton-avatar"></span>
    <span class="user-management-skeleton-line wide"></span>
    <span class="user-management-skeleton-line"></span>
    <span class="user-management-skeleton-control"></span>
  `;
  return skeleton;
}

function createUserManagementCard(uid, profile = {}) {
  const currentUser = auth.currentUser;
  const isCurrentAccount = currentUser?.uid === uid;
  const role = getProfileRole(profile);
  const status = normalizeUserStatus(profile);
  const displayName = String(profile.name || "").trim() || "Unnamed user";
  const displayEmail = String(profile.email || "").trim() || uid;

  const card = document.createElement("article");
  card.className = `user-management-card status-${status}${isCurrentAccount ? " is-current-account" : ""}`;
  card.dataset.userId = uid;
  card.setAttribute("role", "listitem");

  const cardHeader = document.createElement("div");
  cardHeader.className = "user-management-card-header";

  const avatar = document.createElement("span");
  avatar.className = "user-management-avatar";
  avatar.textContent = getUserInitials(profile, uid);
  avatar.setAttribute("aria-hidden", "true");

  const identity = document.createElement("div");
  identity.className = "user-management-identity";

  const name = document.createElement("h3");
  name.className = "user-management-name";
  name.textContent = displayName;

  const email = document.createElement("p");
  email.className = "user-management-email";
  email.textContent = displayEmail;

  identity.append(name, email);

  const badges = document.createElement("div");
  badges.className = "user-management-badges";

  const statusBadge = document.createElement("span");
  statusBadge.className = `user-status-badge ${status}`;
  statusBadge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  badges.append(statusBadge);

  if (isCurrentAccount) {
    const currentBadge = document.createElement("span");
    currentBadge.className = "user-current-badge";
    currentBadge.textContent = "Current account";
    badges.append(currentBadge);
  }

  cardHeader.append(avatar, identity, badges);

  const controls = document.createElement("div");
  controls.className = "user-management-controls";

  const roleField = document.createElement("div");
  roleField.className = "user-management-control-field";
  const roleLabel = document.createElement("label");
  roleLabel.htmlFor = `user-role-${uid}`;
  roleLabel.textContent = "Role";
  const roleSelect = document.createElement("select");
  roleSelect.id = `user-role-${uid}`;
  roleSelect.className = "user-access-select";
  roleSelect.setAttribute("aria-label", `Role for ${displayName}`);
  roleSelect.innerHTML = '<option value="viewer">Viewer</option><option value="operator">Operator</option><option value="administrator">Administrator</option>';
  roleSelect.value = role;
  roleField.append(roleLabel, roleSelect);

  const statusField = document.createElement("div");
  statusField.className = "user-management-control-field";
  const statusLabel = document.createElement("label");
  statusLabel.htmlFor = `user-status-${uid}`;
  statusLabel.textContent = "Account Status";
  const statusSelect = document.createElement("select");
  statusSelect.id = `user-status-${uid}`;
  statusSelect.className = "user-access-select";
  statusSelect.setAttribute("aria-label", `Account status for ${displayName}`);
  statusSelect.innerHTML = '<option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option>';
  statusSelect.value = status;
  statusField.append(statusLabel, statusSelect);

  controls.append(roleField, statusField);

  const actionArea = document.createElement("div");
  actionArea.className = "user-management-card-actions";

  const saveButton = document.createElement("button");
  saveButton.className = "user-access-save";
  saveButton.type = "button";
  saveButton.textContent = "Save Changes";
  saveButton.addEventListener("click", () => window.updateUserAccess(uid));

  const note = document.createElement("p");
  note.className = "user-management-current-note";
  note.textContent = "You cannot modify your own administrator access from this page.";
  note.hidden = !isCurrentAccount;

  const feedback = document.createElement("p");
  feedback.className = "user-management-card-feedback";
  feedback.setAttribute("aria-live", "polite");

  if (isCurrentAccount) {
    roleSelect.disabled = true;
    statusSelect.disabled = true;
    saveButton.disabled = true;
    saveButton.title = "Your current Administrator account is protected.";
  }

  actionArea.append(saveButton, note, feedback);
  card.append(cardHeader, controls, actionArea);
  return card;
}

function renderUserManagement() {
  const elements = getUserManagementElements();
  if (!elements.list || !elements.resultCount || !elements.search || !elements.statusFilter) return;

  elements.list.replaceChildren();
  elements.message?.classList.remove("error");
  if (elements.message) elements.message.textContent = "";

  if (userManagementLoading) {
    setUserManagementMetrics(elements);
    elements.search.disabled = true;
    elements.statusFilter.disabled = true;
    elements.resultCount.textContent = "Loading user accounts…";
    for (let index = 0; index < 4; index += 1) {
      elements.list.append(createUserManagementSkeleton());
    }
    return;
  }

  if (userManagementError) {
    setUserManagementMetrics(elements);
    elements.search.disabled = true;
    elements.statusFilter.disabled = true;
    elements.resultCount.textContent = "User accounts unavailable";
    if (elements.message) {
      elements.message.classList.add("error");
      elements.message.textContent = userManagementError;
    }
    elements.list.append(createUserManagementEmptyState(
      "Unable to load user accounts",
      "Check that this account is an Administrator and that Firebase Database rules allow access to /users.",
      "error"
    ));
    return;
  }

  elements.search.disabled = false;
  elements.statusFilter.disabled = false;

  const summary = getUserSummary(userManagementEntries);
  setUserManagementMetrics(elements, summary);

  const visibleEntries = filterUserEntries(
    userManagementEntries,
    elements.search.value,
    elements.statusFilter.value
  );

  elements.resultCount.textContent = `${visibleEntries.length} of ${summary.total} user${summary.total === 1 ? "" : "s"} shown`;

  if (!userManagementEntries.length) {
    elements.list.append(createUserManagementEmptyState(
      "No user records found",
      "New registrations will appear here after their profile is saved in Firebase."
    ));
    return;
  }

  if (!visibleEntries.length) {
    elements.list.append(createUserManagementEmptyState(
      "No matching users",
      "No users match your current search or status filter."
    ));
    return;
  }

  visibleEntries.forEach(([uid, profile]) => {
    elements.list.append(createUserManagementCard(uid, profile));
  });
}

async function loadUserManagement() {
  userManagementEntries = [];
  userManagementError = "";
  userManagementLoading = true;
  renderUserManagement();

  try {
    const snapshot = await get(ref(database, "users"));
    const users = snapshot.val() || {};
    userManagementEntries = sortUserEntries(
      Object.entries(users).map(([uid, profile]) => [uid, profile || {}])
    );
    userManagementLoading = false;
    renderUserManagement();
  } catch (error) {
    console.error("Unable to load users", error);
    userManagementLoading = false;
    userManagementError = "User data could not be loaded. Verify Administrator access and Firebase Database rules.";
    renderUserManagement();
  }
}

window.openUserManagement = function() {
  if (!isAdministrator()) {
    alert("Only an Administrator account can manage user accounts.");
    return;
  }

  closeSettingsMenu();
  const modal = document.getElementById("userManagementModal");
  if (!modal) return;

  const search = document.getElementById("userManagementSearch");
  const statusFilter = document.getElementById("userManagementStatusFilter");
  if (search) search.value = "";
  if (statusFilter) statusFilter.value = "all";

  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => modal.classList.add("show"));
  loadUserManagement();
};

window.closeUserManagement = function() {
  const modal = document.getElementById("userManagementModal");
  if (!modal) return;

  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");
  setTimeout(() => { modal.style.display = "none"; }, 180);
};

function getOtaElements() {
  return {
    modal: document.getElementById("firmwareUpdateModal"),
    fileInput: document.getElementById("firmwareFile"),
    fileCard: document.getElementById("otaFileCard"),
    fileName: document.getElementById("otaFileName"),
    fileSize: document.getElementById("otaFileSize"),
    version: document.getElementById("firmwareVersion"),
    confirm: document.getElementById("firmwareConfirm"),
    installButton: document.getElementById("otaInstallButton"),
    closeButton: document.getElementById("firmwareUpdateCloseButton"),
    cancelButton: document.getElementById("otaCancelButton"),
    removeButton: document.getElementById("otaRemoveFileButton"),
    dropZone: document.getElementById("otaDropZone"),
    progress: document.getElementById("otaProgress"),
    progressLabel: document.getElementById("otaProgressLabel"),
    progressPercent: document.getElementById("otaProgressPercent"),
    progressBar: document.getElementById("otaProgressBar"),
    progressFill: document.getElementById("otaProgressFill"),
    message: document.getElementById("otaMessage"),
    deviceState: document.getElementById("otaDeviceState"),
    deviceStatus: document.getElementById("otaDeviceStatus"),
    lastUpdate: document.getElementById("otaLastUpdate")
  };
}

function formatFirmwareSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 KB";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function setOtaMessage(message = "", type = "") {
  const element = getOtaElements().message;
  if (!element) return;
  element.textContent = message;
  element.className = `ota-message${type ? ` ${type}` : ""}`;
}

function setOtaDeviceState(state, message) {
  const { deviceState, deviceStatus } = getOtaElements();
  otaDeviceOnline = state === "online";
  if (deviceState) deviceState.className = `ota-device-state is-${state}`;
  if (deviceStatus) deviceStatus.textContent = message;
  updateOtaInstallButton();
}

function setOtaProgress(percent, label) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const { progress, progressLabel, progressPercent, progressBar, progressFill } = getOtaElements();
  if (progress) progress.hidden = false;
  if (progressLabel && label) progressLabel.textContent = label;
  if (progressPercent) progressPercent.textContent = `${value}%`;
  if (progressBar) progressBar.setAttribute("aria-valuenow", String(value));
  if (progressFill) progressFill.style.width = `${value}%`;
}

function updateOtaInstallButton() {
  const { installButton, confirm } = getOtaElements();
  if (!installButton) return;
  installButton.disabled = !selectedFirmwareFile || !confirm?.checked || !otaDeviceOnline || otaUploadInProgress;
}

function setOtaUploading(isUploading) {
  otaUploadInProgress = isUploading;
  const {
    fileInput,
    version,
    confirm,
    installButton,
    closeButton,
    cancelButton,
    removeButton,
    dropZone
  } = getOtaElements();

  if (fileInput) fileInput.disabled = isUploading;
  if (version) version.disabled = isUploading;
  if (confirm) confirm.disabled = isUploading;
  if (closeButton) closeButton.disabled = isUploading;
  if (cancelButton) cancelButton.disabled = isUploading;
  if (removeButton) removeButton.disabled = isUploading;
  dropZone?.classList.toggle("is-disabled", isUploading);

  if (installButton) {
    installButton.textContent = isUploading ? "Installing…" : "Upload & Install";
  }
  updateOtaInstallButton();
}

async function getOtaAuthToken() {
  const user = auth.currentUser;
  if (!user) throw new Error("Your login session has ended. Please log in again.");
  return user.getIdToken();
}

async function parseApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Orange Pi returned HTTP ${response.status}.`);
  }
  return data;
}

function renderOtaLastUpdate(lastUpdate) {
  const lastUpdateElement = getOtaElements().lastUpdate;
  if (!lastUpdateElement) return;

  if (lastUpdate?.completedAt) {
    const date = new Date(lastUpdate.completedAt);
    const version = lastUpdate.version ? ` · ${lastUpdate.version}` : "";
    lastUpdateElement.textContent = `Last deployment: ${date.toLocaleString("en-MY")}${version}`;
  } else {
    lastUpdateElement.textContent = "Last deployment: none recorded";
  }
}

async function refreshOtaStatusFromFirebase() {
  const [statusSnapshot, lastUpdateSnapshot] = await Promise.all([
    get(ref(database, "ota/deviceStatus")),
    get(ref(database, "ota/lastUpdate"))
  ]);

  const status = statusSnapshot.val() || {};
  const checkedAt = Number(status.checkedAt || 0);
  const isFresh = checkedAt > 0 && Date.now() - checkedAt <= OTA_RELAY_STATUS_MAX_AGE_MS;

  if (!status.online || !isFresh) {
    throw new Error(status.message || "Orange Pi or ESP32-S3 has not reported recently.");
  }

  const deviceName = status.device?.name || "ESP32-S3 online";
  setOtaDeviceState("online", deviceName);
  renderOtaLastUpdate(lastUpdateSnapshot.val());
}

async function refreshOtaStatusDirect() {
  const token = await getOtaAuthToken();
  const response = await fetch(`${OTA_API_URL}/status`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  const data = await parseApiResponse(response);
  const deviceName = data.device?.name || "ESP32-S3 online";
  setOtaDeviceState("online", deviceName);
  renderOtaLastUpdate(data.lastUpdate);
}

async function refreshOtaStatus() {
  setOtaDeviceState("checking", "Checking…");

  try {
    if (OTA_USE_FIREBASE_RELAY) {
      await refreshOtaStatusFromFirebase();
    } else {
      await refreshOtaStatusDirect();
    }
  } catch (error) {
    console.error("Unable to reach OTA target", error);
    setOtaDeviceState("offline", "ESP32-S3 unavailable");
    setOtaMessage(error.message || "The Orange Pi could not reach the ESP32-S3.", "error");
  }
}

window.openFirmwareUpdate = function() {
  if (!canUpdateFirmware(getCurrentRole())) {
    alert("Only an Administrator account can install firmware updates.");
    return;
  }

  closeSettingsMenu();
  window.clearFirmwareFile();
  const { modal, confirm, version, progress, lastUpdate } = getOtaElements();
  if (!modal) return;

  if (confirm) confirm.checked = false;
  if (version) version.value = "";
  if (progress) progress.hidden = true;
  if (lastUpdate) lastUpdate.textContent = "Last deployment: —";
  setOtaMessage("");
  setOtaUploading(false);
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => modal.classList.add("show"));
  refreshOtaStatus();
};

window.closeFirmwareUpdate = function() {
  if (otaUploadInProgress) return;
  const { modal } = getOtaElements();
  if (!modal) return;
  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");
  setTimeout(() => { modal.style.display = "none"; }, 180);
};

window.clearFirmwareFile = function() {
  selectedFirmwareFile = null;
  const { fileInput, fileCard, fileName, fileSize } = getOtaElements();
  if (fileInput) fileInput.value = "";
  if (fileCard) fileCard.hidden = true;
  if (fileName) fileName.textContent = "—";
  if (fileSize) fileSize.textContent = "—";
  updateOtaInstallButton();
};

window.selectFirmwareFile = async function(file) {
  window.clearFirmwareFile();
  setOtaMessage("");
  if (!file) return;

  if (!file.name.toLowerCase().endsWith(".bin")) {
    setOtaMessage("Choose a compiled ESP32 firmware file with the .bin extension.", "error");
    return;
  }
  if (file.size < 2 || file.size > MAX_FIRMWARE_FILE_SIZE) {
    setOtaMessage("The firmware file must be between 2 bytes and 16 MB.", "error");
    return;
  }

  try {
    const firstByte = new Uint8Array(await file.slice(0, 1).arrayBuffer())[0];
    if (firstByte !== 0xe9) {
      setOtaMessage("This file does not look like a valid ESP32 application image.", "error");
      return;
    }
  } catch (error) {
    setOtaMessage("The selected file could not be read.", "error");
    return;
  }

  selectedFirmwareFile = file;
  const { fileCard, fileName, fileSize } = getOtaElements();
  if (fileCard) fileCard.hidden = false;
  if (fileName) fileName.textContent = file.name;
  if (fileSize) fileSize.textContent = formatFirmwareSize(file.size);
  updateOtaInstallButton();
};

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function sha256Hex(buffer) {
  if (!window.crypto?.subtle) {
    throw new Error("This browser cannot verify firmware integrity. Use the HTTPS GitHub Pages address.");
  }

  const digest = await window.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

function waitForOtaRelayJob(jobRef) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("The Orange Pi did not finish the update within five minutes."));
    }, OTA_RELAY_TIMEOUT_MS);

    const finish = callback => value => {
      clearTimeout(timeout);
      unsubscribe();
      callback(value);
    };

    unsubscribe = onValue(jobRef, snapshot => {
      const job = snapshot.val();
      if (!job) return;

      if (job.status === "pending") {
        setOtaProgress(80, "Firmware queued securely in Firebase…");
      } else if (job.status === "processing") {
        setOtaProgress(88, "Orange Pi is validating firmware…");
      } else if (job.status === "forwarding") {
        setOtaProgress(96, "Orange Pi is installing firmware on ESP32-S3…");
      } else if (job.status === "success") {
        finish(resolve)(job);
      } else if (job.status === "failed") {
        finish(reject)(new Error(job.message || "Firmware installation failed."));
      }
    }, error => finish(reject)(error));
  });
}

async function uploadFirmwareThroughFirebase(file, version) {
  const user = auth.currentUser;
  if (!user) throw new Error("Your login session has ended. Please log in again.");

  setOtaProgress(5, "Reading firmware file…");
  const firmwareBuffer = await file.arrayBuffer();
  setOtaProgress(20, "Checking firmware integrity…");
  const sha256 = await sha256Hex(firmwareBuffer);
  setOtaProgress(35, "Preparing secure Firebase transfer…");
  const firmwareBase64 = arrayBufferToBase64(firmwareBuffer);

  const jobRef = push(ref(database, "ota/requests"));
  if (!jobRef.key) throw new Error("Unable to create an OTA request.");

  setOtaProgress(55, "Sending firmware to Firebase…");
  await set(jobRef, {
    status: "pending",
    firmwareName: file.name,
    version: version || "",
    bytes: file.size,
    sha256,
    firmwareBase64,
    requestedByUid: user.uid,
    requestedByEmail: user.email || "administrator",
    requestedAt: Date.now()
  });

  setOtaProgress(80, "Waiting for Orange Pi…");
  return waitForOtaRelayJob(jobRef);
}

function uploadFirmwareDirect(file, version) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getOtaAuthToken();
      const xhr = new XMLHttpRequest();
      xhr.open("POST", OTA_API_URL);
      xhr.responseType = "json";
      xhr.timeout = OTA_RELAY_TIMEOUT_MS;
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-Firmware-Name", encodeURIComponent(file.name));
      if (version) xhr.setRequestHeader("X-Firmware-Version", encodeURIComponent(version));

      xhr.upload.onprogress = uploadEvent => {
        if (!uploadEvent.lengthComputable) return;
        const percent = Math.min(95, (uploadEvent.loaded / uploadEvent.total) * 95);
        setOtaProgress(percent, "Uploading to Orange Pi…");
      };

      xhr.upload.onload = () => {
        setOtaProgress(96, "Orange Pi is installing firmware on ESP32-S3…");
      };

      xhr.onload = () => {
        const data = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
          resolve(data);
        } else {
          reject(new Error(data.message || `Installation failed (HTTP ${xhr.status}).`));
        }
      };

      xhr.onerror = () => reject(new Error("Network error while contacting the Orange Pi."));
      xhr.ontimeout = () => reject(new Error("The update timed out. Check the ESP32-S3 before trying again."));
      xhr.send(file);
    } catch (error) {
      reject(error);
    }
  });
}

window.uploadFirmware = async function(event) {
  event?.preventDefault();

  if (!canUpdateFirmware(getCurrentRole())) {
    setOtaMessage("Administrator access is required.", "error");
    return;
  }
  if (!selectedFirmwareFile) {
    setOtaMessage("Choose a firmware .bin file first.", "error");
    return;
  }
  if (!getOtaElements().confirm?.checked) {
    setOtaMessage("Confirm that you understand the device will restart.", "error");
    return;
  }
  if (!otaDeviceOnline) {
    setOtaMessage("The ESP32-S3 must be online before installation can start.", "error");
    return;
  }

  const file = selectedFirmwareFile;
  const version = getOtaElements().version?.value.trim() || "";
  const confirmed = window.confirm(`Install ${file.name} on the ESP32-S3 now? Do not switch off either device.`);
  if (!confirmed) return;

  try {
    setOtaUploading(true);
    setOtaMessage("");
    setOtaProgress(0, OTA_USE_FIREBASE_RELAY ? "Preparing Firebase transfer…" : "Uploading to Orange Pi…");

    const data = OTA_USE_FIREBASE_RELAY
      ? await uploadFirmwareThroughFirebase(file, version)
      : await uploadFirmwareDirect(file, version);

    setOtaProgress(100, "Installation accepted. ESP32-S3 is restarting…");
    setOtaMessage(`Firmware installed successfully${data.sha256 ? ` · SHA-256 ${data.sha256.slice(0, 12)}…` : ""}.`, "success");
    setOtaDeviceState("restarting", "Restarting…");
    setTimeout(refreshOtaStatus, 8000);
  } catch (error) {
    setOtaMessage(error.message || "Unable to start the firmware update.", "error");
    refreshOtaStatus();
  } finally {
    setOtaUploading(false);
  }
};

const otaDropZone = document.getElementById("otaDropZone");
otaDropZone?.addEventListener("dragover", event => {
  event.preventDefault();
  if (!otaUploadInProgress) otaDropZone.classList.add("is-dragging");
});
otaDropZone?.addEventListener("dragleave", () => otaDropZone.classList.remove("is-dragging"));
otaDropZone?.addEventListener("drop", event => {
  event.preventDefault();
  otaDropZone.classList.remove("is-dragging");
  if (!otaUploadInProgress) window.selectFirmwareFile(event.dataTransfer?.files?.[0]);
});
document.getElementById("firmwareConfirm")?.addEventListener("change", updateOtaInstallButton);

window.updateUserAccess = async function(uid) {
  if (!isAdministrator()) {
    alert("Only an Administrator account can manage user accounts.");
    return;
  }

  if (auth.currentUser?.uid === uid) {
    alert("Your own administrator access cannot be changed from this screen.");
    return;
  }

  const roleSelect = document.getElementById(`user-role-${uid}`);
  const statusSelect = document.getElementById(`user-status-${uid}`);
  const card = roleSelect?.closest(".user-management-card");
  const saveButton = card?.querySelector(".user-access-save");
  const feedback = card?.querySelector(".user-management-card-feedback");
  if (!roleSelect || !statusSelect || !saveButton) return;

  const role = normalizeRole(roleSelect.value);
  const status = ["pending", "approved", "rejected"].includes(statusSelect.value)
    ? statusSelect.value
    : "pending";

  roleSelect.disabled = true;
  statusSelect.disabled = true;
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  card?.classList.add("is-saving");
  if (feedback) {
    feedback.classList.remove("error");
    feedback.textContent = "";
  }

  try {
    const changes = {
      role,
      status,
      updatedAt: Date.now(),
      updatedBy: auth.currentUser?.email || auth.currentUser?.uid || "administrator"
    };

    if (status === "approved") {
      changes.approvedAt = Date.now();
      changes.approvedBy = auth.currentUser?.email || auth.currentUser?.uid || "administrator";
    } else {
      changes.approvedAt = null;
      changes.approvedBy = null;
    }

    await update(ref(database, `users/${uid}`), changes);
    await loadUserManagement();
  } catch (error) {
    console.error("Unable to update user access", error);
    roleSelect.disabled = false;
    statusSelect.disabled = false;
    saveButton.disabled = false;
    saveButton.textContent = "Save Changes";
    card?.classList.remove("is-saving");
    if (feedback) {
      feedback.classList.add("error");
      feedback.textContent = "Changes could not be saved. Check Firebase Database rules and try again.";
    }
    alert("Unable to update this user. Check Firebase Database rules.");
  }
};

document.getElementById("userManagementSearch")?.addEventListener("input", renderUserManagement);
document.getElementById("userManagementStatusFilter")?.addEventListener("change", renderUserManagement);

window.logout = async function() {
  closeSettingsMenu();

  try {
    const user = auth.currentUser;
    if (user && messaging) {
      let token = localStorage.getItem(CURRENT_FCM_TOKEN_KEY);
      const currentSwReg = await navigator.serviceWorker.getRegistration('./');

      if (!token && currentSwReg) {
        token = await getToken(messaging, {
          vapidKey: "BEzQHNigs0JY_MWDDUcx93Oee8R3tYp2b3yVqAHpAwvKpM6DlY23PHXWy0c-qgVRJq5qjRLfBTHbmUc_ft3Ktrw",
          serviceWorkerRegistration: currentSwReg
        });
      }

      if (token) {
        // Remove only this phone's token. Other phones using the same account remain registered.
        await remove(ref(database, `users/${user.uid}/fcmTokens/${token}`));
      }

      await deleteToken(messaging).catch(error => {
        console.warn("Unable to delete the local FCM token during logout.", error);
      });
      localStorage.removeItem(CURRENT_FCM_TOKEN_KEY);
    }

    await signOut(auth);
  } catch (error) {
    console.error("Logout failed", error);
    await signOut(auth).catch(() => {});
    alert("Unable to log out. Please try again.");
  }
};

window.deleteAllHistory = async function() {
  if (!canDeleteAllHistory(getCurrentRole())) {
    alert("Only an Administrator account can delete all history data.");
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

function resetSettingsMenuPosition() {
  const menu = document.getElementById("settingsMenu");
  const wrap = document.getElementById("settingsWrap");
  if (!menu) return;

  menu.classList.remove("viewport-positioned", "settings-menu-portal");
  document.body.classList.remove("settings-menu-open");
  document.getElementById("settingsMenuBackdrop")?.classList.remove("show");
  menu.style.removeProperty("--settings-menu-left");
  menu.style.removeProperty("--settings-menu-top");

  if (wrap && menu.parentElement !== wrap) wrap.appendChild(menu);
}

function updateSettingsMenuPosition() {
  const menu = document.getElementById("settingsMenu");
  const button = document.getElementById("settingsButton");
  if (!menu || !button) return;

  if (menu.parentElement !== document.body) document.body.appendChild(menu);
  menu.classList.add("viewport-positioned", "settings-menu-portal");
  document.body.classList.add("settings-menu-open");
  document.getElementById("settingsMenuBackdrop")?.classList.add("show");

  const settingsRect = button.getBoundingClientRect();
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  const visualViewport = window.visualViewport;
  const viewportLeft = visualViewport?.offsetLeft || 0;
  const viewportTop = visualViewport?.offsetTop || 0;
  const viewportWidth = visualViewport?.width || window.innerWidth;
  const viewportHeight = visualViewport?.height || window.innerHeight;
  const edgeGap = 12;

  const left = Math.max(
    viewportLeft + edgeGap,
    Math.min(settingsRect.right - menuWidth, viewportLeft + viewportWidth - menuWidth - edgeGap)
  );
  const belowTop = settingsRect.bottom + 8;
  const aboveTop = settingsRect.top - menuHeight - 8;
  const top = belowTop + menuHeight <= viewportTop + viewportHeight - edgeGap
    ? belowTop
    : Math.max(viewportTop + edgeGap, aboveTop);

  menu.style.setProperty("--settings-menu-left", `${Math.round(left)}px`);
  menu.style.setProperty("--settings-menu-top", `${Math.round(top)}px`);
}

function closeSettingsMenu() {
  const menu = document.getElementById("settingsMenu");
  const button = document.getElementById("settingsButton");

  if (menu) menu.classList.remove("show");
  if (button) button.setAttribute("aria-expanded", "false");
  resetSettingsMenuPosition();
}

window.toggleSettingsMenu = function(event) {
  if (event) event.stopPropagation();

  const menu = document.getElementById("settingsMenu");
  const button = document.getElementById("settingsButton");
  if (!menu || !button) return;

  const isOpen = menu.classList.toggle("show");
  button.setAttribute("aria-expanded", isOpen ? "true" : "false");

  if (isOpen) {
    updateSettingsMenuPosition();
  } else {
    resetSettingsMenuPosition();
  }
};

let settingsPositionFrame = 0;
function scheduleSettingsMenuPositionUpdate() {
  const menu = document.getElementById("settingsMenu");
  if (!menu?.classList.contains("show")) return;

  cancelAnimationFrame(settingsPositionFrame);
  settingsPositionFrame = requestAnimationFrame(() => {
    requestAnimationFrame(updateSettingsMenuPosition);
  });
}

window.addEventListener("resize", scheduleSettingsMenuPositionUpdate);
window.addEventListener("orientationchange", () => {
  scheduleSettingsMenuPositionUpdate();
  setTimeout(scheduleSettingsMenuPositionUpdate, 180);
});
window.addEventListener("scroll", scheduleSettingsMenuPositionUpdate, { passive: true });
window.visualViewport?.addEventListener("resize", scheduleSettingsMenuPositionUpdate);

document.addEventListener("click", function(event) {
  const wrap = document.getElementById("settingsWrap");
  const menu = document.getElementById("settingsMenu");
  if (wrap && !wrap.contains(event.target) && !menu?.contains(event.target)) closeSettingsMenu();
});

document.getElementById("settingsMenuBackdrop")?.addEventListener("click", closeSettingsMenu);

window.addEventListener("keydown", function(event) {
  if (event.key === "Escape") closeSettingsMenu();
});

window.addEventListener("keydown", function(event) {
  if (event.key !== "Enter" || document.body.classList.contains("logged-in")) return;

  const registerForm = document.getElementById("registerForm");
  if (registerForm && !registerForm.hidden) {
    registerUser();
  } else {
    login();
  }
});

window.addEventListener("keydown", function(event) {
  if (event.key === "Escape") {
    closeUserManagement();
    window.closeFirmwareUpdate();
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
    modeNote.innerHTML = "";
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

function startFirebaseListeners() {
  if (unsubscribeLatest || unsubscribeHistory) return;

  unsubscribeLatest = onValue(latestRef, (snapshot) => {
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

  unsubscribeHistory = onValue(historyRef, (snapshot) => {
    const data = snapshot.val();

    if (data) {
      allHistoryData = Object.values(data);
      allHistoryData.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

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
}

function stopFirebaseListeners() {
  if (unsubscribeLatest) unsubscribeLatest();
  if (unsubscribeHistory) unsubscribeHistory();
  unsubscribeLatest = null;
  unsubscribeHistory = null;
}


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

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentRole = "";
    stopFirebaseListeners();
    sessionStorage.removeItem("smartIrrigationRole");
    sessionStorage.removeItem("smartIrrigationUser");
    document.body.classList.remove("logged-in");
    document.getElementById("loginPassword").value = "";
    applyRolePermissions();
    return;
  }

  if (registrationInProgress) return;

  const profile = await resolveUserProfile(user);

  if (auth.currentUser?.uid !== user.uid) return;

  const status = getProfileStatus(profile);
  if (status !== "approved") {
    const messages = {
      pending: "Your account is waiting for administrator approval.",
      rejected: "Your registration was not approved. Please contact the administrator.",
      disabled: "This account has been disabled by the administrator."
    };

    setLoginMessage(messages[status] || "This account does not currently have access.");
    try { await signOut(auth); } catch (error) { console.error("Unable to close unapproved session", error); }
    return;
  }

  const role = getProfileRole(profile);
  currentRole = role;
  sessionStorage.setItem("smartIrrigationRole", role);
  sessionStorage.setItem("smartIrrigationUser", user.email || user.uid);
  document.body.classList.add("logged-in");
  setLoginMessage("");
  applyRolePermissions();
  startFirebaseListeners();
  
  // MODIFICATION: Trigger push notification setup when user logs in successfully
  setupPushNotifications(user.uid);
});

setTheme(savedTheme);
updateModeUI("AUTO");
updateRealtimeStatus();
