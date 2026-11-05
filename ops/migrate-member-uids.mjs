#!/usr/bin/env node
/**
 * Backfill `memberUids` on group documents (Stage 1 of the membership bridge
 * removal). Every legacy email that belongs to a real account is resolved to
 * its Firebase Auth UID and added to the group's `memberUids` list. The
 * existing `memberEmails` list is left untouched, so old and new clients keep
 * working.
 *
 * Default mode is dry-run. It only adds `memberUids`; it never removes fields.
 *
 *   node ops/migrate-member-uids.mjs --project fairshare-app-ba160
 *   node ops/migrate-member-uids.mjs --project fairshare-app-ba160 --apply
 *
 * Authentication: GOOGLE_APPLICATION_CREDENTIALS, or
 *   gcloud auth application-default login
 */

import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
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
        console.warn(`Auth lookup failed for one address (${error?.code || "error"}); skipping it.`);
        break;
      }
    }
  }
  candidates.forEach((candidate) => uidCache.set(candidate, null));
  return null;
}

const groupsSnap = await db.collection("groups").get();
const report = { projectId, apply, groups: groupsSnap.size, rows: [] };

for (const docSnap of groupsSnap.docs) {
  const group = docSnap.data() || {};
  if (group.deletedAt) continue;

  const emails = new Set();
  (Array.isArray(group.memberEmails) ? group.memberEmails : []).forEach((email) => emails.add(email));
  if (group.ownerEmail) emails.add(group.ownerEmail);

  const memberSnap = await docSnap.ref.collection("members").get();
  memberSnap.forEach((memberDoc) => {
    const member = memberDoc.data() || {};
    if (member.emailCanonical) emails.add(member.emailCanonical);
  });

  const resolved = new Set();
  if (group.ownerUid) resolved.add(String(group.ownerUid));
  (Array.isArray(group.memberUids) ? group.memberUids : []).forEach((uid) => resolved.add(String(uid)));
  memberSnap.forEach((memberDoc) => {
    const member = memberDoc.data() || {};
    if (member.uid) resolved.add(String(member.uid));
  });

  let unresolved = 0;
  for (const email of emails) {
    const uid = await uidForEmail(email);
    if (uid) resolved.add(uid);
    else unresolved += 1;
  }

  const existing = new Set((Array.isArray(group.memberUids) ? group.memberUids : []).map(String));
  const additions = [...resolved].filter((uid) => !existing.has(uid));
  const row = {
    id: docSnap.id,
    name: group.name || "",
    existingMemberUids: existing.size,
    resolvedMemberUids: resolved.size,
    additions: additions.length,
    unresolvedEmails: unresolved,
    applied: false
  };
  if (additions.length && apply) {
    await docSnap.ref.set({ memberUids: [...existing, ...additions] }, { merge: true });
    row.applied = true;
  }
  report.rows.push(row);
}

report.totals = report.rows.reduce((acc, row) => {
  acc.groupsToUpdate += row.additions ? 1 : 0;
  acc.addedUids += row.additions;
  acc.unresolvedEmails += row.unresolvedEmails;
  acc.applied += row.applied ? 1 : 0;
  return acc;
}, { groupsToUpdate: 0, addedUids: 0, unresolvedEmails: 0, applied: 0 });

console.log(JSON.stringify(report, null, 2));
