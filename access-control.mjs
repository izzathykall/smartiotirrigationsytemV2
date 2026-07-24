const VALID_ROLES = new Set(["viewer", "operator", "administrator"]);
const ROLE_ALIASES = new Map([["admin", "administrator"]]);

export function normalizeRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  const canonicalRole = ROLE_ALIASES.get(normalized) || normalized;
  return VALID_ROLES.has(canonicalRole) ? canonicalRole : "viewer";
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
