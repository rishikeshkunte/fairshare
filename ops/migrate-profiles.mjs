#!/usr/bin/env node
/**
 * One-time migration of legacy profile arrays into the map fields.
 *
 * `user_profiles/{uid}` used to store `friends[]` and `deletedGroups[]`.
 * Since v94 the app reads `friendsMap` / `deletedGroupsMap` first and only
 * unions the legacy arrays as a fallback. This job copies any legacy record
 * whose key is not already present in the map, so the fallback can be removed
 * without losing contacts.
 *
 * Default mode is dry-run. It only ever adds fields; it never deletes data.
 *
 *   node ops/migrate-profiles.mjs --project fairshare-app-ba160
 *   node ops/migrate-profiles.mjs --project fairshare-app-ba160 --apply
 *
 * Authentication: GOOGLE_APPLICATION_CREDENTIALS, or
 *   gcloud auth application-default login
 */

import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { friendProfileKey, friendProfileRecord } from "../js/profileschema.js";

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
const outputPath = arg("out", "");

const app = initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore(app);

function planProfile(data = {}) {
  const cloudMap = data.friendsMap && typeof data.friendsMap === "object" ? data.friendsMap : {};
  const deletedMap = data.deletedGroupsMap && typeof data.deletedGroupsMap === "object" ? data.deletedGroupsMap : {};
  const friendAdditions = {};
  (Array.isArray(data.friends) ? data.friends : []).forEach((friend) => {
    if (!friend || !friend.name) return;
    const key = friendProfileKey(friend);
    // A key present in the map is authoritative: it is either the current
    // record or a tombstone. Only keys with no map entry are migrated.
    if (!key || key in cloudMap) return;
    friendAdditions[key] = friendProfileRecord(friend);
  });
  const deletedAdditions = {};
  (Array.isArray(data.deletedGroups) ? data.deletedGroups : []).forEach((id) => {
    const key = String(id || "");
    if (!key || key in deletedMap) return;
    deletedAdditions[key] = true;
  });
  return { friendAdditions, deletedAdditions };
}

const snap = await db.collection("user_profiles").get();
const report = {
  projectId,
  apply,
  profiles: snap.size,
  // UIDs are redacted: only a short suffix is printed so runs can be compared.
  rows: []
};

for (const docSnap of snap.docs) {
  const data = docSnap.data() || {};
  const { friendAdditions, deletedAdditions } = planProfile(data);
  const friendCount = Object.keys(friendAdditions).length;
  const deletedCount = Object.keys(deletedAdditions).length;
  const row = {
    uid: `…${docSnap.id.slice(-6)}`,
    addFriends: friendCount,
    addDeletedGroups: deletedCount,
    applied: false
  };
  if (friendCount || deletedCount) {
    if (apply) {
      const payload = {};
      if (friendCount) payload.friendsMap = friendAdditions;
      if (deletedCount) payload.deletedGroupsMap = deletedAdditions;
      await docSnap.ref.set(payload, { merge: true });
      row.applied = true;
    }
  }
  report.rows.push(row);
}

report.totals = report.rows.reduce((acc, row) => {
  acc.profilesToMigrate += row.addFriends || row.addDeletedGroups ? 1 : 0;
  acc.friendRecords += row.addFriends;
  acc.deletedGroupRecords += row.addDeletedGroups;
  acc.applied += row.applied ? 1 : 0;
  return acc;
}, { profilesToMigrate: 0, friendRecords: 0, deletedGroupRecords: 0, applied: 0 });

const text = JSON.stringify(report, null, 2);
if (outputPath) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outputPath, text);
}
console.log(text);
