import { canonEmail } from "./sync.js";

/**
 * Membership documents are the only email-to-UID bridge left. A retired
 * document must never be treated as a live membership: the group document
 * prunes the UID, and the member document is marked removed so a later sign-in
 * cannot claim the group again.
 */
export function isActiveMembershipDoc(doc) {
  if (!doc) return false;
  const status = doc.status || "active";
  return status === "active" && Boolean(doc.emailCanonical);
}

export function memberDocumentMatchesRemoval(doc, { name = "", email = "", uid = "" } = {}) {
  if (!doc || (doc.status || "active") !== "active") return false;
  const targetUid = String(uid || "");
  if (targetUid && doc.uid && String(doc.uid) === targetUid) return true;
  const targetEmail = canonEmail(email);
  const docEmail = canonEmail(doc.emailCanonical || "");
  if (targetEmail && docEmail) return targetEmail === docEmail;
  const targetName = String(name || "").trim().toLowerCase();
  const docName = String(doc.displayName || "").trim().toLowerCase();
  if (!targetName || !docName || targetName !== docName) return false;
  // Name-only documents may be matched by name. Never retire a different
  // account that happens to share the display name.
  return !docEmail;
}

/**
 * Decides what to do when a group is missing from a server discovery snapshot.
 * "keep" covers local-only groups whose upload has not landed yet. Only an
 * explicit permission denial, or a successful read showing this UID is no
 * longer a member, prunes the local copy.
 */
export function missingGroupAction({ error = "", exists = false, data = null, uid = "" } = {}) {
  const code = String(error || "");
  if (code) return code.includes("permission-denied") ? "prune" : "keep";
  if (!exists) return "keep";
  const doc = data || {};
  if (doc.deletedAt) return "tombstone";
  const uids = Array.isArray(doc.memberUids) ? doc.memberUids.map(String) : [];
  if (uid && uids.includes(String(uid))) return "keep";
  return "prune";
}
