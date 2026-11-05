#!/usr/bin/env node
/**
 * Soft-delete explicitly listed groups ("delete for everyone").
 *
 * Default mode is dry-run. It only sets `deletedAt`/`deletedBy`; it never
 * hard-deletes documents, subcollections, or Storage objects.
 *
 *   node ops/cleanup-groups.mjs --project fairshare-app-ba160 --ids id1,id2
 *   node ops/cleanup-groups.mjs --project fairshare-app-ba160 --ids id1,id2 --apply
 *
 * Authentication: GOOGLE_APPLICATION_CREDENTIALS, or
 *   gcloud auth application-default login
 */

import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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
const ids = arg("ids", "").split(",").map((id) => id.trim()).filter(Boolean);
if (!ids.length) {
  console.error("Missing --ids <comma-separated group ids>");
  process.exit(2);
}
const apply = hasFlag("apply");

const app = initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore(app);

const rows = [];
for (const id of ids) {
  const ref = db.collection("groups").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    rows.push({ id, missing: true, applied: false });
    continue;
  }
  const group = snap.data() || {};
  const row = {
    id,
    name: group.name || "",
    normalizedVersion: group.normalizedVersion || 0,
    legacyTransactions: Array.isArray(group.transactions) ? group.transactions.length : 0,
    alreadyDeleted: Boolean(group.deletedAt),
    applied: false
  };
  if (!group.deletedAt && apply) {
    await ref.set({
      deletedAt: Date.now(),
      deletedBy: "ops-cleanup"
    }, { merge: true });
    row.applied = true;
  }
  rows.push(row);
}

const summary = {
  mode: apply ? "apply" : "dry-run",
  projectId,
  requested: ids.length,
  applied: rows.filter((row) => row.applied).length,
  rows
};
console.log(JSON.stringify(summary, null, 2));
