const VALID_USER_STATUSES = new Set(["pending", "approved", "rejected"]);
const USER_STATUS_ORDER = { pending: 0, approved: 1, rejected: 2 };

export function normalizeUserStatus(profile = {}) {
  const status = String(profile?.status || "").trim().toLowerCase();
  return VALID_USER_STATUSES.has(status) ? status : "approved";
}

function initialsFromText(value = "") {
  const words = String(value)
    .trim()
    .split(/[\s._-]+/)
    .map(word => word.replace(/[^a-z0-9]/gi, ""))
    .filter(Boolean);

  if (!words.length) return "";
  if (words.length === 1) return words[0][0].toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

export function getUserInitials(profile = {}, uid = "") {
  const nameInitials = initialsFromText(profile?.name);
  if (nameInitials) return nameInitials;

  const emailLocalPart = String(profile?.email || "").split("@")[0];
  const emailInitials = initialsFromText(emailLocalPart);
  if (emailInitials) return emailInitials;

  const compactUid = String(uid).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  return compactUid || "?";
}

export function sortUserEntries(entries = []) {
  return [...entries].sort(([, a = {}], [, b = {}]) => {
    const statusDifference = USER_STATUS_ORDER[normalizeUserStatus(a)] - USER_STATUS_ORDER[normalizeUserStatus(b)];
    if (statusDifference !== 0) return statusDifference;

    const aLabel = String(a.name || a.email || "");
    const bLabel = String(b.name || b.email || "");
    return aLabel.localeCompare(bLabel, undefined, { sensitivity: "base" });
  });
}

export function getUserSummary(entries = []) {
  return entries.reduce((summary, [, profile = {}]) => {
    const status = normalizeUserStatus(profile);
    summary.total += 1;
    summary[status] += 1;
    return summary;
  }, { total: 0, pending: 0, approved: 0, rejected: 0 });
}

export function filterUserEntries(entries = [], searchTerm = "", statusFilter = "all") {
  const normalizedSearch = String(searchTerm).trim().toLowerCase();
  const normalizedFilter = String(statusFilter).trim().toLowerCase();

  return entries.filter(([, profile = {}]) => {
    const statusMatches = normalizedFilter === "all" || normalizeUserStatus(profile) === normalizedFilter;
    if (!statusMatches) return false;

    if (!normalizedSearch) return true;
    const searchableText = `${profile.name || ""} ${profile.email || ""}`.toLowerCase();
    return searchableText.includes(normalizedSearch);
  });
}
