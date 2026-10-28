import test from "node:test";
import assert from "node:assert/strict";
import { repairGroupNames, resolveYouName } from "../js/groupnames.js";

function netBalances(group) {
  const balances = Object.fromEntries((group.members || []).map((m) => [m, 0]));
  for (const tx of group.transactions || []) {
    if (tx.type === "expense") {
      if (balances[tx.payer] !== undefined) balances[tx.payer] += tx.amount;
      for (const [name, share] of Object.entries(tx.shares || {})) {
        if (balances[name] !== undefined) balances[name] -= share;
      }
    } else if (tx.type === "settlement") {
      if (balances[tx.payer] !== undefined) balances[tx.payer] += tx.amount;
      if (balances[tx.receiver] !== undefined) balances[tx.receiver] -= tx.amount;
    }
  }
  return balances;
}

test("repairs a creator-side group whose members still say You but transactions use the real name", () => {
  const group = {
    members: ["You", "Poorva Shintre"],
    memberLinks: { You: "rishikesh@example.com", "Poorva Shintre": "poorva@example.com" },
    transactions: [
      {
        id: "t1",
        type: "expense",
        amount: 4257600,
        payer: "Rishikesh Kunte",
        shares: { "Poorva Shintre": 4257600 },
        timestamp: 1
      }
    ]
  };

  const changed = repairGroupNames(group, {
    myEmail: "rishikesh@example.com",
    myName: "Rishikesh Kunte",
    friends: []
  });

  assert.equal(changed, true);
  assert.deepEqual(group.members, ["Rishikesh Kunte", "Poorva Shintre"]);
  assert.equal(group.memberLinks.You, undefined);
  assert.equal(group.memberLinks["Rishikesh Kunte"], "rishikesh@example.com");
  assert.deepEqual(netBalances(group), { "Rishikesh Kunte": 4257600, "Poorva Shintre": -4257600 });
});

test("repairs another member's view using the invited friend's roster name", () => {
  const group = {
    members: ["You", "Aman Shrivas"],
    memberLinks: { You: "rishikesh@example.com", "Aman Shrivas": "aman@example.com" },
    transactions: [
      { id: "t1", type: "expense", amount: 200000, payer: "Rishikesh Kunte", shares: { "Rishikesh Kunte": 100000, "Aman Shrivas": 100000 }, timestamp: 1 }
    ]
  };

  repairGroupNames(group, {
    myEmail: "aman@example.com",
    myName: "Aman Shrivas",
    friends: [{ name: "Rishikesh Kunte", email: "rishikesh@example.com" }]
  });

  assert.deepEqual(group.members, ["Rishikesh Kunte", "Aman Shrivas"]);
  assert.deepEqual(netBalances(group), { "Rishikesh Kunte": 100000, "Aman Shrivas": -100000 });
});

test("infers the placeholder name when no roster link is available", () => {
  const group = {
    members: ["You", "Aryan Ahir", "Aman Shrivas"],
    memberLinks: {},
    transactions: [
      { id: "t1", type: "expense", amount: 200000, payer: "Rishikesh Kunte", shares: { "Rishikesh Kunte": 66667, "Aman Shrivas": 66666, "Aryan Ahir": 66667 }, timestamp: 1 }
    ]
  };

  const changed = repairGroupNames(group, { myEmail: "aman@example.com", myName: "Aman Shrivas" });

  assert.equal(changed, true);
  assert.deepEqual(group.members, ["Rishikesh Kunte", "Aryan Ahir", "Aman Shrivas"]);
  assert.equal(group.transactions[0].shares["Rishikesh Kunte"], 66667);
});

test("rewrites stray You keys when members already use the real name", () => {
  const group = {
    members: ["Rishikesh Kunte", "Aman Shrivas"],
    memberLinks: {},
    transactions: [
      { id: "t1", type: "settlement", amount: 50000, payer: "Aman Shrivas", receiver: "You", timestamp: 1 }
    ]
  };

  const changed = repairGroupNames(group, { myEmail: "rishikesh@example.com", myName: "Rishikesh Kunte" });

  assert.equal(changed, true);
  assert.equal(group.transactions[0].receiver, "Rishikesh Kunte");
  assert.deepEqual(netBalances(group), { "Rishikesh Kunte": -50000, "Aman Shrivas": 50000 });
});

test("is a no-op for already consistent groups", () => {
  const group = {
    members: ["Rishikesh Kunte", "Aman Shrivas"],
    memberLinks: { "Rishikesh Kunte": "rishikesh@example.com" },
    transactions: [
      { id: "t1", type: "expense", amount: 100000, payer: "Rishikesh Kunte", shares: { "Rishikesh Kunte": 50000, "Aman Shrivas": 50000 }, updatedAt: 123 }
    ]
  };
  const before = JSON.stringify(group);
  const changed = repairGroupNames(group, { myEmail: "rishikesh@example.com", myName: "Rishikesh Kunte" });
  assert.equal(changed, false);
  assert.equal(JSON.stringify(group), before);
});

test("merges shares instead of double counting when the target already has a share", () => {
  const group = {
    members: ["You", "Rishikesh Kunte", "Aman Shrivas"],
    memberLinks: { You: "rishikesh@example.com" },
    transactions: [
      { id: "t1", type: "expense", amount: 100000, payer: "Rishikesh Kunte", shares: { You: 25000, "Rishikesh Kunte": 25000, "Aman Shrivas": 50000 }, timestamp: 1 }
    ]
  };
  repairGroupNames(group, { myEmail: "rishikesh@example.com", myName: "Rishikesh Kunte" });
  assert.deepEqual(group.members, ["Rishikesh Kunte", "Aman Shrivas"]);
  assert.equal(group.transactions[0].shares["Rishikesh Kunte"], 50000);
  assert.equal(group.transactions[0].shares.You, undefined);
});

test("does not rewrite a placeholder that belongs to someone else", () => {
  const group = {
    members: ["You", "Aman Shrivas"],
    memberLinks: { You: "rishikesh@example.com" },
    transactions: [
      { id: "t1", type: "expense", amount: 100000, payer: "Rishikesh Kunte", shares: { "Rishikesh Kunte": 50000, "Aman Shrivas": 50000 }, timestamp: 1 }
    ]
  };
  repairGroupNames(group, {
    myEmail: "aman@example.com",
    myName: "Aman Shrivas",
    friends: [{ name: "Rishikesh Kunte", email: "rishikesh@example.com" }]
  });
  assert.deepEqual(group.members, ["Rishikesh Kunte", "Aman Shrivas"]);
  assert.equal(resolveYouName(group, { myEmail: "aman@example.com", myName: "Aman Shrivas" }), "");
});
