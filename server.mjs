import "dotenv/config";

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import express from "express";
import helmet from "helmet";
import { applicationDefault, initializeApp as initializeAdminApp } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getDatabase as getAdminDatabase } from "firebase-admin/database";

import {
  buildEsp32StatusUrl,
  isEsp32ApplicationImage,
  normalizeFirmwareVersion,
  parsePositiveInteger,
  sanitizeFirmwareName
} from "./ota-utils.mjs";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = parsePositiveInteger(process.env.PORT, 3000);
const MAX_FIRMWARE_MB = parsePositiveInteger(process.env.MAX_FIRMWARE_MB, 16);
const MAX_FIRMWARE_BYTES = MAX_FIRMWARE_MB * 1024 * 1024;
const OTA_FORWARD_TIMEOUT_MS = parsePositiveInteger(process.env.OTA_FORWARD_TIMEOUT_MS, 180000);
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL ||
  "https://iot-smart-irrigtion-system-default-rtdb.asia-southeast1.firebasedatabase.app";
const ESP32_OTA_URL = process.env.ESP32_OTA_URL || "";
const ESP32_OTA_TOKEN = process.env.ESP32_OTA_TOKEN || "";
const FIRMWARE_DIR = path.resolve(process.env.FIRMWARE_DIR || path.join(PROJECT_ROOT, "firmware-store"));
const UPDATE_STATE_FILE = path.join(FIRMWARE_DIR, "last-update.json");
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

if (!ESP32_OTA_URL) {
  throw new Error("ESP32_OTA_URL is required. Copy .env.example to .env and set the ESP32-S3 address.");
}
if (
  ESP32_OTA_TOKEN.length < 32 ||
  ESP32_OTA_TOKEN === "replace-with-at-least-32-random-characters"
) {
  throw new Error("ESP32_OTA_TOKEN must be replaced with a unique value of at least 32 characters.");
}

const ESP32_STATUS_URL = buildEsp32StatusUrl(ESP32_OTA_URL, process.env.ESP32_STATUS_URL || "");

const firebaseAdminApp = initializeAdminApp({
  credential: applicationDefault(),
  databaseURL: FIREBASE_DATABASE_URL
});
const adminAuth = getAdminAuth(firebaseAdminApp);
const adminDatabase = getAdminDatabase(firebaseAdminApp);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

let otaBusy = false;
const updateAttempts = new Map();

function requestOriginIsAllowed(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;

  try {
    return new URL(origin).host === req.get("host");
  } catch (_) {
    return false;
  }
}

app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || requestOriginIsAllowed(req)) {
    next();
    return;
  }
  res.status(403).json({ ok: false, message: "Request origin is not allowed." });
});

async function requireAdministrator(req, res, next) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ ok: false, message: "Firebase login token is required." });
    return;
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(match[1], true);
    const snapshot = await adminDatabase.ref(`users/${decodedToken.uid}`).once("value");
    const profile = snapshot.val() || {};
    const role = String(profile.role || "").trim().toLowerCase();
    const status = String(profile.status || "approved").trim().toLowerCase();

    if (status !== "approved" || role !== "administrator") {
      res.status(403).json({ ok: false, message: "Administrator access is required for firmware updates." });
      return;
    }

    req.otaUser = {
      uid: decodedToken.uid,
      email: decodedToken.email || profile.email || "administrator"
    };
    next();
  } catch (error) {
    console.warn("OTA authentication failed:", error?.message || error);
    res.status(401).json({ ok: false, message: "Your login session is invalid or expired." });
  }
}

function limitFirmwareUpdates(req, res, next) {
  const uid = req.otaUser.uid;
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000;
  const recentAttempts = (updateAttempts.get(uid) || []).filter(timestamp => timestamp > windowStart);

  if (recentAttempts.length >= 5) {
    res.status(429).json({ ok: false, message: "Too many update attempts. Wait 15 minutes and try again." });
    return;
  }

  recentAttempts.push(now);
  updateAttempts.set(uid, recentAttempts);
  next();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readLastUpdate() {
  try {
    return JSON.parse(await readFile(UPDATE_STATE_FILE, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Unable to read OTA state:", error?.message || error);
    return null;
  }
}

async function writeLastUpdate(state) {
  await mkdir(FIRMWARE_DIR, { recursive: true, mode: 0o750 });
  const temporaryFile = `${UPDATE_STATE_FILE}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o640 });
  await rename(temporaryFile, UPDATE_STATE_FILE);
}

function esp32Headers(extra = {}) {
  return {
    "X-OTA-Token": ESP32_OTA_TOKEN,
    ...extra
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "smart-irrigation-orange-pi" });
});

app.get("/api/ota/status", requireAdministrator, async (_req, res) => {
  try {
    const response = await fetchWithTimeout(
      ESP32_STATUS_URL,
      { headers: esp32Headers(), cache: "no-store" },
      7000
    );
    const device = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(device.message || `ESP32-S3 returned HTTP ${response.status}.`);
    }

    res.json({
      ok: true,
      orangePi: { online: true },
      device,
      lastUpdate: await readLastUpdate()
    });
  } catch (error) {
    console.warn("ESP32-S3 status check failed:", error?.message || error);
    res.status(503).json({
      ok: false,
      message: "Orange Pi is online, but the ESP32-S3 OTA endpoint is unavailable.",
      lastUpdate: await readLastUpdate()
    });
  }
});

app.post(
  "/api/ota",
  requireAdministrator,
  limitFirmwareUpdates,
  express.raw({ type: ["application/octet-stream", "application/x-binary"], limit: MAX_FIRMWARE_BYTES }),
  async (req, res) => {
    if (otaBusy) {
      res.status(409).json({ ok: false, message: "Another firmware update is already in progress." });
      return;
    }

    const firmwareName = sanitizeFirmwareName(req.get("x-firmware-name"));
    const firmwareVersion = normalizeFirmwareVersion(req.get("x-firmware-version"));

    if (!firmwareName) {
      res.status(400).json({ ok: false, message: "A valid .bin firmware filename is required." });
      return;
    }
    if (!isEsp32ApplicationImage(req.body)) {
      res.status(400).json({ ok: false, message: "The upload is not a valid ESP32 application image." });
      return;
    }

    otaBusy = true;
    const updateId = crypto.randomUUID();
    const sha256 = crypto.createHash("sha256").update(req.body).digest("hex");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveName = `${timestamp}-${firmwareName}`;
    const archivePath = path.join(FIRMWARE_DIR, archiveName);
    let updateState = {
      id: updateId,
      status: "received",
      firmwareName,
      version: firmwareVersion || null,
      bytes: req.body.length,
      sha256,
      requestedBy: req.otaUser.email,
      receivedAt: new Date().toISOString()
    };

    try {
      await mkdir(FIRMWARE_DIR, { recursive: true, mode: 0o750 });
      await writeFile(archivePath, req.body, { flag: "wx", mode: 0o640 });
      updateState = { ...updateState, status: "forwarding", archivedAs: archiveName };
      await writeLastUpdate(updateState);

      const form = new FormData();
      form.append("firmware", new Blob([req.body], { type: "application/octet-stream" }), firmwareName);

      const response = await fetchWithTimeout(
        ESP32_OTA_URL,
        {
          method: "POST",
          headers: esp32Headers({
            "X-Firmware-SHA256": sha256,
            "X-Firmware-Version": firmwareVersion
          }),
          body: form
        },
        OTA_FORWARD_TIMEOUT_MS
      );

      const responseText = await response.text();
      let deviceResponse = {};
      try { deviceResponse = JSON.parse(responseText); } catch (_) { deviceResponse = { message: responseText.slice(0, 300) }; }

      if (!response.ok || deviceResponse.ok === false) {
        throw new Error(deviceResponse.message || `ESP32-S3 returned HTTP ${response.status}.`);
      }

      updateState = {
        ...updateState,
        status: "success",
        completedAt: new Date().toISOString(),
        deviceResponse
      };
      await writeLastUpdate(updateState);

      res.json({
        ok: true,
        message: "Firmware accepted by the ESP32-S3. The device is restarting.",
        updateId,
        firmwareName,
        version: firmwareVersion || null,
        bytes: req.body.length,
        sha256,
        device: deviceResponse
      });
    } catch (error) {
      console.error("OTA deployment failed:", error?.message || error);
      updateState = {
        ...updateState,
        status: "failed",
        failedAt: new Date().toISOString(),
        error: String(error?.message || error).slice(0, 300)
      };
      await writeLastUpdate(updateState).catch(stateError => {
        console.error("Unable to record OTA failure:", stateError?.message || stateError);
      });

      if (!res.headersSent) {
        res.status(502).json({
          ok: false,
          message: "Orange Pi saved the firmware, but installation on the ESP32-S3 failed. Check its power, network and OTA token."
        });
      }
    } finally {
      otaBusy = false;
    }
  }
);

const PUBLIC_ROUTES = [
  "/index.html",
  "/style.css",
  "/script.js",
  "/access-control.mjs",
  "/user-management-utils.mjs",
  "/firebase-messaging-sw.js",
  "/manifest.json",
  "/icon.png"
];

app.get("/", (_req, res) => res.sendFile(path.join(PROJECT_ROOT, "index.html")));
app.get(PUBLIC_ROUTES, (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, path.basename(req.path)));
});

app.use((error, _req, res, next) => {
  if (error?.type === "entity.too.large") {
    res.status(413).json({ ok: false, message: `Firmware exceeds the ${MAX_FIRMWARE_MB} MB upload limit.` });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ ok: false, message: "The request body is invalid." });
    return;
  }
  next(error);
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ ok: false, message: "API endpoint not found." });
    return;
  }
  res.status(404).send("Not found");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Smart Irrigation Orange Pi server listening on port ${PORT}`);
});
