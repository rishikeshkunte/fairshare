import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLegacyGroup } from "../js/groupschema.js";
import { projectGroupTransactions, projectGroupMembers, memberLinksFromDocs } from "../js/normalizedsync.js";

const legacy = {
  id: "g1",
  name: "Testing Group",
  currency: "₹",
  members: ["Rishikesh Kunte", "Aryan Ahir", "Aman Shrivas"],
  memberLinks: {
    "Rishikesh Kunte": "rishikeshkunte@gmail.com",
    "Aryan Ahir": "aryanahir315@gmail.com",
    "Aman Shrivas": "amanshrivas092@gmail.com"
  },
  transactions: [
    { id: "t1", type: "expense", amount: 200000, payer: "Rishikesh Kunte", shares: { "Rishikesh Kunte": 66667, "Aman Shrivas": 66666, "Aryan Ahir": 66667 }, category: "Transport", desc: "Uber", dateISO: "2026-10-28", timestamp: 1, updatedAt: 1 },
    { id: "t2", type: "settlement", amount: 50000, payer: "Aman Shrivas", receiver: "Rishikesh Kunte", desc: "Aman paid Rishikesh", dateISO: "2026-10-28", timestamp: 2, updatedAt: 2 }
  ],
  deletedTransactions: []
};

test("projects normalized expense and settlement docs into the UI transaction shape", () => {
  const plan = normalizeLegacyGroup(legacy, { ownerUid: "uid_rishi", ownerEmail: "rishikeshkunte@gmail.com" });
  const transactions = projectGroupTransactions({
    memberDocs: plan.members,
    expenseDocs: plan.expenses,
    settlementDocs: plan.settlements
  });
  assert.equal(transactions.length, 2);
  const expense = transactions.find(tx => tx.type === "expense");
  assert.equal(expense.amount, 200000);
  assert.equal(expense.payer, "Rishikesh Kunte");
  assert.deepEqual(expense.shares, { "Rishikesh Kunte": 66667, "Aman Shrivas": 66666, "Aryan Ahir": 66667 });
  const settlement = transactions.find(tx => tx.type === "settlement");
  assert.equal(settlement.payer, "Aman Shrivas");
  assert.equal(settlement.receiver, "Rishikesh Kunte");
});

test("projects member docs and email links", () => {
  const plan = normalizeLegacyGroup(legacy, { ownerUid: "uid_rishi", ownerEmail: "rishikeshkunte@gmail.com" });
  const members = projectGroupMembers(plan.members);
  assert.equal(members.length, 3);
  assert.equal(members.find(m => m.name === "Rishikesh Kunte").role, "owner");
  assert.equal(memberLinksFromDocs(plan.members)["Aman Shrivas"], "amanshrivas092@gmail.com");
});

test("excludes soft-deleted normalized records", () => {
  const plan = normalizeLegacyGroup(legacy, { ownerUid: "uid_rishi", ownerEmail: "rishikeshkunte@gmail.com" });
  plan.expenses[0].deletedAt = 1;
  const transactions = projectGroupTransactions({
    memberDocs: plan.members,
    expenseDocs: plan.expenses,
    settlementDocs: plan.settlements
  });
  assert.equal(transactions.filter(tx => tx.type === "expense").length, 0);
  assert.equal(transactions.length, 1);
});
