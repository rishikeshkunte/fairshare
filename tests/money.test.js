import test from "node:test";
import assert from "node:assert/strict";
import {
  rupeesToPaise,
  paiseToInput,
  formatMoney,
  allocateEqual,
  allocateWeighted,
  migrateMoney,
  mergeById,
  stripReceiptBytes
} from "../js/money.js";

test("money parsing rounds to paise and rejects invalid values", () => {
  assert.equal(rupeesToPaise("12.34"), 1234);
  assert.equal(rupeesToPaise("1.235"), 124);
  assert.equal(rupeesToPaise(""), null);
  assert.equal(rupeesToPaise("abc"), null);
  assert.equal(rupeesToPaise("-2.50"), -250);
});

test("money formatting preserves sign and two decimal places", () => {
  assert.equal(paiseToInput(1234), "12.34");
  assert.equal(formatMoney(-5, "₹"), "-₹0.05");
});

test("equal split allocates every paise without losing remainders", () => {
  const shares = allocateEqual(100, ["A", "B", "C"]);
  assert.deepEqual(shares, { A: 34, B: 33, C: 33 });
  assert.equal(Object.values(shares).reduce((sum, value) => sum + value, 0), 100);
  assert.equal(allocateEqual(10, []), null);
});

test("weighted split sums exactly to the requested total", () => {
  const shares = allocateWeighted(1000, [
    { id: "A", weight: 1 },
    { id: "B", weight: 2 },
    { id: "C", weight: 1 }
  ]);
  assert.equal(Object.values(shares).reduce((sum, value) => sum + value, 0), 1000);
  assert.deepEqual(shares, { A: 250, B: 500, C: 250 });
});

test("legacy money migration converts amounts once and preserves group data", () => {
  const original = {
    schemaVersion: 8,
    groups: {
      g1: {
        id: "g1",
        name: "Trip",
        currency: "₹",
        members: ["You", "Friend"],
        transactions: [{ id: "t1", type: "expense", amount: 12.34, shares: { You: 6.17, Friend: 6.17 } }]
      }
    },
    directTransactions: [{ id: "d1", type: "expense", amount: 3.5, shares: { You: 3.5 } }]
  };
  const migrated = migrateMoney(original);
  assert.equal(migrated.groups.g1.transactions[0].amount, 1234);
  assert.deepEqual(migrated.groups.g1.transactions[0].shares, { You: 617, Friend: 617 });
  assert.equal(migrated.directTransactions[0].amount, 350);
  assert.equal(migrateMoney(migrated), migrated);
  assert.deepEqual(migrated.groups.g1.members, ["You", "Friend"]);
});

test("transaction merge prefers the newest version and does not duplicate IDs", () => {
  const merged = mergeById(
    [{ id: "same", desc: "local older", updatedAt: 10, timestamp: 10 }, { id: "local", updatedAt: 20, timestamp: 20 }],
    [{ id: "same", desc: "cloud newer", updatedAt: 11, timestamp: 11 }, { id: "remote", updatedAt: 15, timestamp: 15 }]
  );
  assert.equal(merged.length, 3);
  assert.equal(merged.find(tx => tx.id === "same").desc, "cloud newer");
  assert.deepEqual(merged.map(tx => tx.id), ["local", "remote", "same"]);
});

test("receipt data URLs are stripped from cloud payloads without mutating local records", () => {
  const original = [{ id: "t1", receipt: "data:image/jpeg;base64,AAAA", receiptUrl: "https://example.test/receipt.jpg" }];
  const stripped = stripReceiptBytes(original);
  assert.equal(stripped[0].receipt, undefined);
  assert.equal(stripped[0].receiptUrl, "https://example.test/receipt.jpg");
  assert.ok(original[0].receipt.startsWith("data:"));
});
