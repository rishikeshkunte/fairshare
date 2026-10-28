import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(join(root, "index.html"), "utf8");

function loadRepair() {
  const start = html.indexOf("function repairGroupIdentity");
  const end = html.indexOf("function escapeHtml", start);
  assert.ok(start >= 0 && end > start, "identity repair block exists");
  const block = html.slice(start, end);
  return new Function("appState", "currentUser", "normalizeEmail", `${block}; return { repairGroupIdentity, repairGroupMoney, repairDirectMoney };`);
}

function canon(email) {
  const clean = String(email || "").toLowerCase().trim();
  if (!clean.endsWith("@gmail.com")) return clean;
  return clean.slice(0, -10).replace(/\./g, "") + "@gmail.com";
}

const friends = [
  { name: "Aryan Ahir", email: "aryanahir315@gmail.com", aliases: [] },
  { name: "Poorva Shintre", email: "spoorva95@gmail.com", aliases: [] },
  { name: "Kyron", email: "kunterishikesh@gmail.com", aliases: ["Zilconis"] },
  { name: "Aman Shrivas", email: "amanshrivas092@gmail.com", aliases: [] }
];

function testingGroup() {
  return {
    id: "g1",
    name: "Testing Group",
    currency: "₹",
    members: ["Zilconis", "Aryan Ahir", "Aman Shrivas"],
    memberLinks: {
      Zilconis: "rishikeshkunte@gmail.com",
      "Rishikesh Kunte": "kunterishikesh@gmail.com",
      "Aryan Ahir": "aryanahir315@gmail.com",
      You: "rishikeshkunte@gmail.com",
      "Aman Shrivas": "amanshrivas092@gmail.com"
    },
    simplifyDebts: true,
    transactions: [
      { id: "t1", type: "expense", amount: 200000, payer: "Rishikesh Kunte", shares: { "Rishikesh Kunte": 66667, "Aman Shrivas": 66666, "Aryan Ahir": 66667 }, timestamp: 1 },
      { id: "t2", type: "expense", amount: 380000, payer: "Aryan Ahir", shares: { "Aman Shrivas": 126666, "Rishikesh Kunte": 126667, "Aryan Ahir": 126667 }, timestamp: 2 },
      { id: "t3", type: "expense", amount: 700000, payer: "Aman Shrivas", shares: { "Rishikesh Kunte": 233334, "Aryan Ahir": 233333, "Aman Shrivas": 233333 }, timestamp: 3 }
    ],
    deletedTransactions: []
  };
}

test("rebuilds a group whose member names and links were swapped by renames", () => {
  const appState = { friends, groups: { g1: testingGroup() }, directTransactions: [], deletedTransactions: [] };
  const currentUser = { displayName: "Rishikesh Kunte", email: "rishikeshkunte@gmail.com" };
  const { repairGroupIdentity } = loadRepair()(appState, currentUser, canon);
  const group = appState.groups.g1;

  const changed = repairGroupIdentity(group);
  assert.equal(changed, true);
  assert.deepEqual(group.members, ["Zilconis", "Aryan Ahir", "Aman Shrivas", "Rishikesh Kunte"]);
  assert.equal(group.memberLinks["Zilconis"], "kunterishikesh@gmail.com");
  assert.equal(group.memberLinks["Rishikesh Kunte"], "rishikeshkunte@gmail.com");
  assert.equal(group.memberLinks.You, undefined);

  for (const tx of group.transactions) {
    assert.ok(group.members.includes(tx.payer), `payer ${tx.payer} is a member`);
    for (const key of Object.keys(tx.shares || {})) {
      assert.ok(group.members.includes(key), `share key ${key} is a member`);
    }
  }
  const balances = Object.fromEntries(group.members.map(m => [m, 0]));
  for (const tx of group.transactions) {
    if (tx.type === "expense") {
      balances[tx.payer] += tx.amount;
      for (const [name, share] of Object.entries(tx.shares)) balances[name] -= share;
    }
  }
  assert.equal(Object.values(balances).reduce((a, b) => a + b, 0), 0);
  assert.equal(balances["Rishikesh Kunte"], -226668);
});

test("removes a stale You link when the creator is already a named member", () => {
  const appState = {
    friends,
    groups: {
      g2: {
        id: "g2",
        members: ["Rishikesh Kunte", "Poorva Shintre"],
        memberLinks: {
          You: "rishikeshkunte@gmail.com",
          "Rishikesh Kunte": "rishikeshkunte@gmail.com",
          "Poorva Shintre": "spoorva95@gmail.com"
        },
        currency: "₹",
        transactions: [{ id: "t1", type: "expense", amount: 4257600, payer: "Rishikesh Kunte", shares: { "Poorva Shintre": 4257600 } }],
        deletedTransactions: []
      }
    },
    directTransactions: [],
    deletedTransactions: []
  };
  const currentUser = { displayName: "Rishikesh Kunte", email: "rishikeshkunte@gmail.com" };
  const { repairGroupIdentity } = loadRepair()(appState, currentUser, canon);
  const group = appState.groups.g2;
  repairGroupIdentity(group);
  assert.deepEqual(group.members, ["Rishikesh Kunte", "Poorva Shintre"]);
  assert.equal(group.memberLinks.You, undefined);
  assert.equal(group.memberLinks["Rishikesh Kunte"], "rishikeshkunte@gmail.com");
});

test("repairs rupee-vs-paise unit mismatches in a group ledger", () => {
  const appState = { friends: [], groups: {}, directTransactions: [], deletedTransactions: [] };
  const currentUser = { displayName: "Rishikesh Kunte", email: "rishikeshkunte@gmail.com" };
  const { repairGroupMoney } = loadRepair()(appState, currentUser, canon);
  const group = {
    transactions: [
      { id: "ratio", type: "expense", amount: 2611, payer: "A", shares: { A: 130550, B: 130550 }, timestamp: 1 },
      { id: "decimal", type: "expense", amount: 500, payer: "A", shares: { A: 250.5, B: 249.5 }, timestamp: 2 }
    ],
    deletedTransactions: []
  };
  assert.equal(repairGroupMoney(group), true);
  assert.equal(group.transactions[0].amount, 261100);
  assert.equal(group.transactions[0].shares.A, 130550);
  assert.equal(group.transactions[1].amount, 50000);
  assert.equal(group.transactions[1].shares.A, 25050);
  assert.equal(group.transactions[1].shares.B, 24950);
  assert.equal(group.schemaVersion, 9);
});
