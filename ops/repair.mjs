#!/usr/bin/env node
/**
 * Server-side ledger repair for What's My Share?.
 *
 * Default mode is dry-run. It never deletes documents.
 *
 *   node ops/repair.mjs --project fairshare-app-ba160
 *   node ops/repair.mjs --project fairshare-app-ba160 --apply
 *   node ops/repair.mjs --project fairshare-app-ba160 --group <groupId> --apply
 *
 * Authentication: GOOGLE_APPLICATION_CREDENTIALS, or
 *   gcloud auth application-default login
 */

import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { normalizeLegacyGroup, validateNormalizedGroup } from "../js/groupschema.js";

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
const groupId = arg("group", "");
const apply = hasFlag("apply");
const outputPath = arg("out", "");

const app = initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore(app);

function canonicalEmail(email) {
  let value = String(email || "").toLowerCase().trim();
  if (value.endsWith("@gmail.com")) {
    value = value.slice(0, -"@gmail.com".length).replace(/\./g, "") + "@gmail.com";
  }
  return value;
}

function issue(report, level, code, detail) {
  report.issues.push({ level, code, detail });
}

function inspectNormalized(memberDocs, expenseDocs, settlementDocs, report) {
  const members = new Map();
  memberDocs.forEach(doc => {
    const data = doc.data();
    if (!data || data.status === "removed" || data.status === "left") return;
    members.set(doc.id, data);
  });
  expenseDocs.forEach(doc => {
    const data = doc.data() || {};
    const amount = Number(data.amountPaise);
    if (!Number.isInteger(amount) || amount <= 0) {
      issue(report, "error", "expense-amount", `${doc.id} amountPaise=${data.amountPaise}`);
      return;
    }
    if (!members.has(data.payerMemberId)) {
      issue(report, "error", "expense-payer", `${doc.id} payer ${data.payerMemberId}`);
    }
    let sum = 0;
    for (const [memberId, value] of Object.entries(data.shares || {})) {
      if (!members.has(memberId)) issue(report, "error", "expense-share-member", `${doc.id} ${memberId}`);
      if (!Number.isInteger(Number(value))) issue(report, "error", "expense-share-unit", `${doc.id} ${memberId}=${value}`);
      sum += Number(value) || 0;
    }
    if (Math.abs(sum - amount) > 1) {
      issue(report, "error", "expense-shares-sum", `${doc.id} amount=${amount} shares=${sum}`);
    }
  });
  settlementDocs.forEach(doc => {
    const data = doc.data() || {};
    if (!members.has(data.fromMemberId)) issue(report, "error", "settlement-from", `${doc.id} ${data.fromMemberId}`);
    if (!members.has(data.toMemberId)) issue(report, "error", "settlement-to", `${doc.id} ${data.toMemberId}`);
    if (!Number.isInteger(Number(data.amountPaise)) || Number(data.amountPaise) <= 0) {
      issue(report, "error", "settlement-amount", `${doc.id} ${data.amountPaise}`);
    }
  });
  return members;
}

function desiredMemberEmails(memberDocs, fallback = []) {
  const emails = new Set();
  memberDocs.forEach(doc => {
    const data = doc.data() || {};
    const email = canonicalEmail(data.emailCanonical || "");
    if (email) emails.add(email);
  });
  (fallback || []).forEach(email => {
    const value = canonicalEmail(email);
    if (value) emails.add(value);
  });
  return [...emails];
}

async function repairGroup(docSnap) {
  const group = docSnap.data() || {};
  const report = {
    id: docSnap.id,
    name: group.name || "",
    legacyTransactions: Array.isArray(group.transactions) ? group.transactions.length : 0,
    normalizedVersion: group.normalizedVersion || 0,
    applied: false,
    issues: []
  };
  if (group.deletedAt) {
    report.skipped = "deleted";
    return report;
  }

  const groupRef = docSnap.ref;
  const [memberSnap, expenseSnap, settlementSnap] = await Promise.all([
    groupRef.collection("members").get(),
    groupRef.collection("expenses").get(),
    groupRef.collection("settlements").get()
  ]);
  report.members = memberSnap.size;
  report.expenses = expenseSnap.size;
  report.settlements = settlementSnap.size;

  const legacy = { id: docSnap.id, ...group };
  const plan = normalizeLegacyGroup(legacy, {
    ownerUid: group.ownerUid || "",
    ownerEmail: group.ownerEmail || ""
  });
  const planErrors = validateNormalizedGroup(plan);
  if (!plan.ok || planErrors.length) {
    issue(report, "warn", "legacy-normalization", [...plan.errors, ...planErrors].slice(0, 8).join("; "));
  }

  inspectNormalized(memberSnap.docs, expenseSnap.docs, settlementSnap.docs, report);
  if (!memberSnap.size && !expenseSnap.size && !settlementSnap.size && plan.ok) {
    issue(report, "warn", "empty-normalized", "legacy group has no normalized documents");
  }
  if (memberSnap.size && plan.members.length && memberSnap.size !== plan.members.length) {
    issue(report, "warn", "member-count", `normalized=${memberSnap.size} legacy=${plan.members.length}`);
  }
  if (expenseSnap.size && plan.expenses.length && expenseSnap.size < plan.expenses.length) {
    issue(report, "warn", "expense-count", `normalized=${expenseSnap.size} legacy=${plan.expenses.length}`);
  }

  const emails = desiredMemberEmails(memberSnap.docs, plan.members.map(m => m.emailCanonical));
  const currentEmails = Array.isArray(group.memberEmails) ? group.memberEmails.map(canonicalEmail) : [];
  const emailsChanged = JSON.stringify([...new Set(currentEmails)].sort()) !== JSON.stringify([...new Set(emails)].sort());
  if (emailsChanged) issue(report, "warn", "member-emails", "memberEmails does not match member documents");

  if (!apply) return report;

  const writes = [];
  if (!memberSnap.size && plan.ok) {
    plan.members.forEach(member => writes.push([groupRef.collection("members").doc(member.id), member]));
    plan.expenses.forEach(expense => writes.push([groupRef.collection("expenses").doc(expense.id), expense]));
    plan.settlements.forEach(settlement => writes.push([groupRef.collection("settlements").doc(settlement.id), settlement]));
  } else {
    const existingMembers = new Set(memberSnap.docs.map(doc => doc.id));
    plan.members.forEach(member => {
      if (!existingMembers.has(member.id)) writes.push([groupRef.collection("members").doc(member.id), member]);
    });
  }
  const metadata = {
    updatedAt: new Date(),
    updatedBy: "repair-job"
  };
  if (emailsChanged) metadata.memberEmails = emails;
  if (plan.ok && !group.normalizedVersion && (memberSnap.size || writes.length)) metadata.normalizedVersion = 1;
  writes.push([groupRef, metadata]);

  for (let index = 0; index < writes.length; index += 450) {
    const batch = db.batch();
    writes.slice(index, index + 450).forEach(([ref, data]) => batch.set(ref, data, { merge: true }));
    await batch.commit();
  }
  report.applied = true;
  return report;
}

async function main() {
  const reports = [];
  if (groupId) {
    const snap = await db.collection("groups").doc(groupId).get();
    if (!snap.exists) {
      console.error(`Group not found: ${groupId}`);
      process.exit(1);
    }
    reports.push(await repairGroup(snap));
  } else {
    const snapshot = await db.collection("groups").get();
    for (const docSnap of snapshot.docs) {
      reports.push(await repairGroup(docSnap));
    }
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    projectId,
    groups: reports.length,
    groupsWithIssues: reports.filter(report => report.issues.length).length,
    applied: reports.filter(report => report.applied).length,
    reports
  };
  const text = JSON.stringify(summary, null, 2);
  if (outputPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outputPath, text);
    console.log(`Report written to ${outputPath}`);
  } else {
    console.log(text);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
