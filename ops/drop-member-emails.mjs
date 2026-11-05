#!/usr/bin/env node
/**
 * Drop the retired `memberEmails` field from active group documents.
 *
 * Safety check: an account email is only dropped when its resolved UID is
 * already present in `memberUids`. Groups with an unresolved account email are
 * skipped and reported. The job never deletes documents.
 *
 *   node ops/drop-member-emails.mjs --project fairshare-app-ba160
 *   node ops/drop-member-emails.mjs --project fairshare-app-ba160 --apply
 */

import { applicationDefault, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const projectId = arg("project", process.env.GCLOUD_PROJECT || "");
if (!projectId) {
  console.error("Missing --project <firebase-project-id>");
  process.exit(2);
}
const apply = hasFlag("apply");

const app = initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore(app);
const auth = getAuth(app);

function canonicalEmail(email) {
  let value = String(email || "").toLowerCase().trim();
  if (value.endsWith("@gmail.com")) {
    value = value.slice(0, -"@gmail.com".length).replace(/\./g, "") + "@gmail.com";
  }
  return value;
}

const uidCache = new Map();
async function uidForEmail(email) {
  const raw = String(email || "").toLowerCase().trim();
  const canonical = canonicalEmail(raw);
  const candidates = [...new Set([raw, canonical].filter(Boolean))];
  for (const candidate of candidates) {
    if (uidCache.has(candidate)) return uidCache.get(candidate);
  }
  for (const candidate of candidates) {
    try {
      const user = await auth.getUserByEmail(candidate);
      uidCache.set(candidate, user.uid);
      return user.uid;
    } catch (error) {
      if (error?.code !== "auth/user-not-found") {
        console.warn(`Auth lookup failed (${error?.code || "error"}); skipping this group.`);
        return undefined;
      }
    }
  }
  candidates.forEach((candidate) => uidCache.set(candidate, null));
  return null;
}

const snap = await db.collection("groups").get();
const rows = [];
for (const docSnap of snap.docs) {
  const group = docSnap.data() || {};
  if (group.deletedAt) continue;
  const emails = Array.isArray(group.memberEmails) ? group.memberEmails : [];
  const uids = new Set((Array.isArray(group.memberUids) ? group.memberUids : []).map(String));
  const missing = [];
  let lookupFailed = false;
  for (const email of emails) {
    const uid = await uidForEmail(email);
    if (uid === undefined) { lookupFailed = true; break; }
    if (uid && !uids.has(String(uid))) missing.push(canonicalEmail(email));
  }
  const row = {
    id: docSnap.id,
    name: group.name || "",
    emails: emails.length,
    hasField: Array.isArray(group.memberEmails) || "memberEmails" in group,
    skipped: Boolean(lookupFailed || missing.length),
    missingUids: missing.length,
    applied: false
  };
  if (!row.skipped && row.hasField && apply) {
    await docSnap.ref.update({ memberEmails: FieldValue.delete() });
    row.applied = true;
  }
  rows.push(row);
}

const summary = {
  mode: apply ? "apply" : "dry-run",
  projectId,
  groups: snap.size,
  rows,
  totals: rows.reduce((acc, row) => {
    acc.withField += row.hasField ? 1 : 0;
    acc.skipped += row.skipped ? 1 : 0;
    acc.applied += row.applied ? 1 : 0;
    return acc;
  }, { withField: 0, skipped: 0, applied: 0 })
};
console.log(JSON.stringify(summary, null, 2));
