import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLegacyGroup, validateNormalizedGroup, memberIdFor } from "../js/groupschema.js";

function legacyGroup() {
  return {
    id: "group_test",
    name: "Testing Group",
    currency: "₹",
    members: ["Rishikesh Kunte", "Aryan Ahir", "Aman Shrivas"],
    memberLinks: {
      "Rishikesh Kunte": "rishikeshkunte@gmail.com",
      "Aryan Ahir": "aryanahir315@gmail.com",
      "Aman Shrivas": "amanshrivas092@gmail.com"
    },
    simplifyDebts: true,
    transactions: [
      { id: "t1", type: "expense", amount: 200000, payer: "Rishikesh Kunte", shares: { "Rishikesh Kunte": 66667, "Aman Shrivas": 66666, "Aryan Ahir": 66667 }, category: "Transport", desc: "Uber", dateISO: "2026-10-28", timestamp: 1, updatedAt: 1 },
      { id: "t2", type: "settlement", amount: 50000, payer: "Aman Shrivas", receiver: "Rishikesh Kunte", desc: "Aman paid Rishikesh", dateISO: "2026-10-28", timestamp: 2, updatedAt: 2 }
    ],
    deletedTransactions: []
  };
}

test("normalizes a legacy group into member, expense, and settlement documents", () => {
  const plan = normalizeLegacyGroup(legacyGroup(), { ownerUid: "uid_rishi", ownerEmail: "rishikeshkunte@gmail.com" });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.group.name, "Testing Group");
  assert.equal(plan.group.ownerUid, "uid_rishi");
  assert.equal(plan.members.length, 3);
  assert.equal(plan.members.find(m => m.displayName === "Rishikesh Kunte").role, "owner");
  assert.equal(plan.expenses.length, 1);
  assert.equal(plan.settlements.length, 1);

  const rishiId = plan.members.find(m => m.displayName === "Rishikesh Kunte").id;
  const amanId = plan.members.find(m => m.displayName === "Aman Shrivas").id;
  assert.equal(plan.expenses[0].payerMemberId, rishiId);
  assert.equal(plan.expenses[0].amountPaise, 200000);
  assert.equal(plan.expenses[0].shares[amanId], 66666);
  assert.equal(plan.settlements[0].fromMemberId, amanId);
  assert.equal(plan.settlements[0].toMemberId, rishiId);
  assert.deepEqual(validateNormalizedGroup(plan), []);
});

test("flags an expense whose payer is not a known member", () => {
  const group = legacyGroup();
  group.transactions[0].payer = "Ghost";
  const plan = normalizeLegacyGroup(group, { ownerUid: "uid_rishi", ownerEmail: "rishikeshkunte@gmail.com" });
  assert.equal(plan.ok, false);
  assert.ok(plan.errors.some(error => error.includes("unknown payer")));
});

test("creates stable ids from uid, canonical email, or name", () => {
  assert.equal(memberIdFor({ uid: "abc" }), "uid_abc");
  assert.equal(memberIdFor({ email: "Rishi.Kunte@gmail.com" }), "email_rishikunte_gmail_com");
  assert.equal(memberIdFor({ name: "Local Friend" }), "name_local_friend");
});
