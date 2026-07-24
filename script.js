import { normalizeRole, hasSystemControlAccess, canManageUsers, canDeleteAllHistory } from "./access-control.mjs";
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
import { getDatabase, ref, onValue, get, set, update, remove } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-database.js";

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

const latestRef = ref(database, "sensor/latest");
const historyRef = ref(database, "history");
const controlRef = ref(database, "control");

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
let unsubscribeControl = null;
let userManagementEntries = [];
let userManagementLoading = false;
let userManagementError = "";

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
      // Keep the message generic to avoid exposing whether an account exists.
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
    await signOut(auth);
  } catch (error) {
    console.error("Logout failed", error);
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
  const topActions = document.querySelector(".top-actions");
  if (!menu) return;

  menu.classList.remove("viewport-positioned");
  wrap?.classList.remove("settings-overlay-active");
  topActions?.classList.remove("settings-overlay-active");
  menu.style.removeProperty("--settings-menu-left");
  menu.style.removeProperty("--settings-menu-top");
}

function updateSettingsMenuPosition() {
  const menu = document.getElementById("settingsMenu");
  const button = document.getElementById("settingsButton");
  const header = document.querySelector(".header");
  const title = header?.querySelector("h1");
  const statusGroup = document.querySelector(".live-update-group");

  if (!menu || !button || !header) return;

  // Desktop keeps the normal dropdown. Phone and tablet anchor the menu
  // directly to the header so orientation changes cannot shift or clip it.
  if (!window.matchMedia("(max-width: 1180px)").matches) {
    resetSettingsMenuPosition();
    return;
  }

  menu.classList.add("viewport-positioned");
  document.getElementById("settingsWrap")?.classList.add("settings-overlay-active");
  document.querySelector(".top-actions")?.classList.add("settings-overlay-active");

  const headerRect = header.getBoundingClientRect();
  const titleRect = title?.getBoundingClientRect() || headerRect;
  const settingsRect = document.getElementById("settingsButton")?.getBoundingClientRect() || headerRect;
  const statusRect = statusGroup?.getBoundingClientRect();
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  const viewportWidth = window.visualViewport?.width || window.innerWidth;
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const edgeGap = 10;

  // Align the panel with the settings button in all orientations.
  const desiredLeft = settingsRect.right - menuWidth;
  const minimumLeft = Math.max(edgeGap, headerRect.left + edgeGap);
  const maximumLeft = Math.min(
    viewportWidth - menuWidth - edgeGap,
    headerRect.right - menuWidth - edgeGap
  );
  const left = Math.max(minimumLeft, Math.min(desiredLeft, maximumLeft));

  // Only reserve space above the status row when the two boxes overlap
  // horizontally. On iPad landscape the status controls sit in a separate
  // right column, so the menu can remain aligned with the title.
  const overlapsStatusHorizontally = statusRect &&
    left < statusRect.right &&
    left + menuWidth > statusRect.left;
  // Put dropdown directly below the gear button instead of the title area.
  const desiredTop = settingsRect.bottom + 8;
  const minimumTop = Math.max(edgeGap, headerRect.top + edgeGap);
  const maximumTopFromStatus = overlapsStatusHorizontally
    ? statusRect.top - menuHeight - 8
    : headerRect.bottom - menuHeight - edgeGap;
  const maximumTop = Math.min(
    viewportHeight - menuHeight - edgeGap,
    maximumTopFromStatus
  );
  const top = Math.max(minimumTop, Math.min(desiredTop, maximumTop));

  // The menu is absolutely positioned against the header on mobile/tablet.
  // Convert viewport coordinates to header-local coordinates.
  menu.style.setProperty("--settings-menu-left", `${Math.round(left - headerRect.left)}px`);
  menu.style.setProperty(
    "--settings-menu-top",
    `${Math.max(0, Math.floor(top - headerRect.top - 1))}px`
  );
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
  if (wrap && !wrap.contains(event.target)) closeSettingsMenu();
});

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
  if (event.key === "Escape") closeUserManagement();
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


    latestSensorTimestamp = data.timestamp ? Number(data.timestamp) : Date.now();
    updateRealtimeStatus();
  });

  unsubscribeHistory = onValue(historyRef, (snapshot) => {
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

  // Listen to the same Firebase path used by the web control buttons. This
  // unlocks manual pump controls immediately after MANUAL mode is written and
  // does not depend on the ESP32 mirroring commands back into sensor/latest.
  unsubscribeControl = onValue(controlRef, (snapshot) => {
    const data = snapshot.val() || {};

    if (data.mode === "AUTO" || data.mode === "MANUAL") {
      updateModeUI(data.mode);
    }

    if (data.pump1 === "ON" || data.pump1 === "OFF") {
      updatePumpBadge("pump1Badge", data.pump1);
    }

    if (data.pump2 === "ON" || data.pump2 === "OFF") {
      updatePumpBadge("pump2Badge", data.pump2);
    }
  }, (error) => {
    console.error("Unable to read Firebase control state.", error);
  });
}

function stopFirebaseListeners() {
  if (unsubscribeLatest) unsubscribeLatest();
  if (unsubscribeHistory) unsubscribeHistory();
  if (unsubscribeControl) unsubscribeControl();
  unsubscribeLatest = null;
  unsubscribeHistory = null;
  unsubscribeControl = null;
}


function setControlFeedback(message, isError = false) {
  const note = document.getElementById("controlNote");
  if (!note) return;

  note.textContent = message;
  note.classList.toggle("control-error", isError);
}

function getControlCommandErrorMessage(error) {
  const code = String(error?.code || "").toLowerCase();

  if (code.includes("permission-denied") || code.includes("permission_denied")) {
    return "Control command denied by Firebase. Publish the included database rules and ensure your user role is operator, admin, or administrator.";
  }

  if (code.includes("network")) {
    return "Unable to send control command. Check the internet connection on this device.";
  }

  return "Unable to send control command. Check Firebase connection and database rules.";
}

window.setMode = async function(mode) {
  if (!requireAdminControl()) return;

  const nextMode = mode === "MANUAL" ? "MANUAL" : "AUTO";
  setControlFeedback("Sending mode command...");

  try {
    await set(modeRef, nextMode);

    if (nextMode === "AUTO") {
      await Promise.all([
        set(pump1Ref, "OFF"),
        set(pump2Ref, "OFF")
      ]);
    }

    updateModeUI(nextMode);
    setControlFeedback(`Mode changed to ${nextMode}. Command saved in Firebase control.`);
  } catch (error) {
    console.error("Unable to send control command.", error);
    setControlFeedback(getControlCommandErrorMessage(error), true);
  }
};

window.setPump1 = async function(status) {
  if (!requireAdminControl()) return;

  if (currentMode !== "MANUAL") {
    alert("Pump control hanya boleh digunakan bila sistem mode = MANUAL.");
    return;
  }

  const nextStatus = status === "ON" ? "ON" : "OFF";
  setControlFeedback("Sending borewell pump command...");

  try {
    await set(pump1Ref, nextStatus);
    updatePumpBadge("pump1Badge", nextStatus);
    setControlFeedback(`Borewell pump command ${nextStatus} saved in Firebase control.`);
  } catch (error) {
    console.error("Unable to send control command.", error);
    setControlFeedback(getControlCommandErrorMessage(error), true);
  }
};

window.setPump2 = async function(status) {
  if (!requireAdminControl()) return;

  if (currentMode !== "MANUAL") {
    alert("Pump control hanya boleh digunakan bila sistem mode = MANUAL.");
    return;
  }

  const nextStatus = status === "ON" ? "ON" : "OFF";
  setControlFeedback("Sending spare tank pump command...");

  try {
    await set(pump2Ref, nextStatus);
    updatePumpBadge("pump2Badge", nextStatus);
    setControlFeedback(`Spare tank pump command ${nextStatus} saved in Firebase control.`);
  } catch (error) {
    console.error("Unable to send control command.", error);
    setControlFeedback(getControlCommandErrorMessage(error), true);
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

  // createUserWithEmailAndPassword signs in automatically. Registration handles
  // its own profile creation and logout, so do not open the app during that step.
  if (registrationInProgress) return;

  const profile = await resolveUserProfile(user);

  // Ignore stale results if the account logged out while the profile was loading.
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
});

setTheme(savedTheme);
updateModeUI("AUTO");
updateRealtimeStatus();
