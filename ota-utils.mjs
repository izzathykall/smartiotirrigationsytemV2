export const ESP32_IMAGE_MAGIC = 0xe9;

export function decodeHeaderValue(value) {
  const text = String(value || "");
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text;
  }
}

export function sanitizeFirmwareName(value) {
  const decoded = decodeHeaderValue(value).normalize("NFKC");
  const leafName = decoded.split(/[\\/]/).pop() || "";
  const cleaned = leafName
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  if (!cleaned.toLowerCase().endsWith(".bin")) return null;
  return cleaned;
}

export function normalizeFirmwareVersion(value) {
  return decodeHeaderValue(value)
    .trim()
    .replace(/[^a-zA-Z0-9._+-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function isEsp32ApplicationImage(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 1 && buffer[0] === ESP32_IMAGE_MAGIC;
}

export function buildEsp32StatusUrl(updateUrl, explicitStatusUrl = "") {
  if (explicitStatusUrl) return new URL(explicitStatusUrl).toString();

  const url = new URL(updateUrl);
  if (/\/ota\/update\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/ota\/update\/?$/, "/ota/status");
  } else {
    url.pathname = "/ota/status";
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
