const VALID_ROLES = new Set(["viewer", "operator", "administrator"]);

export function normalizeRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return VALID_ROLES.has(normalized) ? normalized : "viewer";
}

export function hasSystemControlAccess(role) {
  const normalized = normalizeRole(role);
  return normalized === "operator" || normalized === "administrator";
}

export function canManageUsers(role) {
  return normalizeRole(role) === "administrator";
}

export function canDeleteAllHistory(role) {
  return normalizeRole(role) === "administrator";
}
