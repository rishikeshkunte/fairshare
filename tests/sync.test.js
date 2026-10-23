import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRemotePair,
  canonEmail,
  linkFriend,
  mergeFriends,
  mergePairLedger,
  pairIdFor,
  pairWritePayload,
  remotePairNeedsPush
} from "../js/sync.js";

test("gmail dots and letter case are one pair id", () => {
  assert.equal(canonEmail("Rishi.Kesh@gmail.com"), "rishikesh@gmail.com");
  assert.equal(canonEmail("rishikesh@gmail.com"), canonEmail("Rishi.Kesh@gmail.com"));
  assert.equal(pairIdFor("Rishi.Kesh@gmail.com", "Aryan.K@gmail.com"), pairIdFor("rishikesh@gmail.com", "aryank@gmail.com"));
  assert.equal(canonEmail("ada.lovelace@outlook.com"), "ada.lovelace@outlook.com");
  assert.equal(pairIdFor("a@gmail.com", "a@gmail.com"), "");
});

test("a name-only contact is enriched with the gmail address instead of blocking the link", () => {
  const friends = [{ id: "f1", name: "Aryan", type: "custom" }];
  const linked = linkFriend(friends, "Aryan.K@gmail.com", "Aryan", () => "new");
  assert.equal(linked.changed, true);
  assert.equal(linked.friends.length, 1);
  assert.equal(linked.friend.id, "f1");
  assert.equal(linked.friend.email, "aryan.k@gmail.com");

  const again = linkFriend(linked.friends, "aryank@gmail.com", "Aryan", () => "other");
  assert.equal(again.changed, false);
  assert.equal(again.friends.length, 1);
  assert.equal(again.friend.id, "f1");
});

test("cloud friends fill an empty phone without dropping a local-only contact", () => {
  const local = [{ id: "local", name: "Priya", type: "custom" }];
  const remote = [{ id: "cloud", name: "Aryan", email: "aryan@gmail.com" }];
  const merged = mergeFriends(local, remote, () => "generated");
  assert.equal(merged.changed, true);
  assert.equal(merged.friends.length, 2);
  assert.equal(merged.friends[0].name, "Priya");
  assert.equal(merged.friends[1].email, "aryan@gmail.com");
});

test("a tombstone removes the expense from both copies and a later stale copy cannot restore it", () => {
  const expense = { id: "tx1", friend: "Aryan", amount: 5000, timestamp: 10, updatedAt: 10 };
  const tombstone = { id: "del1", location: "direct", deletedAt: 20, transaction: { ...expense } };
  const first = mergePairLedger({
    localTransactions: [],
    remoteTransactions: [expense],
    localDeleted: [],
    remoteDeleted: []
  });
  assert.deepEqual(first.transactions.map((tx) => tx.id), ["tx1"]);

  const deleted = mergePairLedger({
    localTransactions: [expense],
    remoteTransactions: [],
    localDeleted: [],
    remoteDeleted: [tombstone]
  });
  assert.equal(deleted.transactions.length, 0);
  assert.equal(deleted.deletedTransactions.length, 1);

  const staleWrite = mergePairLedger({
    localTransactions: [expense],
    remoteTransactions: [],
    localDeleted: [],
    remoteDeleted: deleted.deletedTransactions
  });
  assert.equal(staleWrite.transactions.length, 0);

  const restored = { ...expense, updatedAt: 30, desc: "restored" };
  const broughtBack = mergePairLedger({
    localTransactions: [restored],
    remoteTransactions: [],
    localDeleted: [],
    remoteDeleted: [tombstone]
  });
  assert.equal(broughtBack.transactions.length, 1);
  assert.equal(broughtBack.transactions[0].desc, "restored");
  assert.equal(broughtBack.deletedTransactions.length, 0);
});

test("a local-only expense survives a cloud snapshot that has not seen it yet", () => {
  const localOnly = { id: "local", friend: "Aryan", timestamp: 30, updatedAt: 30 };
  const cloud = { id: "cloud", friend: "Aryan", timestamp: 10, updatedAt: 10 };
  const merged = mergePairLedger({
    localTransactions: [localOnly],
    remoteTransactions: [cloud],
    localDeleted: [],
    remoteDeleted: []
  });
  assert.deepEqual(merged.transactions.map((tx) => tx.id).sort(), ["cloud", "local"]);
});

test("the newer edit wins and an equal timestamp keeps the cloud copy", () => {
  const older = { id: "tx", desc: "old", timestamp: 5, updatedAt: 5 };
  const newer = { id: "tx", desc: "new", timestamp: 5, updatedAt: 9 };
  const merged = mergePairLedger({
    localTransactions: [newer],
    remoteTransactions: [older],
    localDeleted: [],
    remoteDeleted: []
  });
  assert.equal(merged.transactions[0].desc, "new");

  const tie = mergePairLedger({
    localTransactions: [{ id: "tx", desc: "local", timestamp: 5, updatedAt: 5 }],
    remoteTransactions: [{ id: "tx", desc: "cloud", timestamp: 5, updatedAt: 5 }],
    localDeleted: [],
    remoteDeleted: []
  });
  assert.equal(tie.transactions[0].desc, "cloud");
});

test("the other account applies a remote expense under its own friend name and drops a deletion", () => {
  const state = {
    directTransactions: [
      { id: "old", friend: "Rishi", desc: "test", timestamp: 1, updatedAt: 1 },
      { id: "keep", friend: "Priya", timestamp: 2, updatedAt: 2 }
    ],
    deletedTransactions: []
  };
  const next = applyRemotePair(state, {
    friendName: "Rishi",
    friendEmail: "rishi.kesh@gmail.com",
    remoteTransactions: [{ id: "dinner", friend: "Aryan", desc: "dinner", timestamp: 8, updatedAt: 8 }],
    remoteDeleted: [{ id: "d1", location: "direct", deletedAt: 9, transaction: { id: "old", friend: "Aryan", timestamp: 1 } }]
  });
  const rishi = next.directTransactions.filter((tx) => tx.friend === "Rishi");
  assert.deepEqual(rishi.map((tx) => tx.id), ["dinner"]);
  assert.equal(next.directTransactions.some((tx) => tx.id === "keep"), true);
  assert.equal(next.directTransactions.some((tx) => tx.id === "old"), false);
  assert.equal(next.deletedTransactions[0].transaction.friend, "Rishi");
});

test("a snapshot is pushed only when this device still has something the cloud ledger lacks", () => {
  const local = [{ id: "local", timestamp: 4, updatedAt: 4 }];
  const remoteMissing = { transactions: [], deletedTransactions: [] };
  assert.equal(remotePairNeedsPush(remoteMissing, local, []), true);

  const remoteCaughtUp = { transactions: local, deletedTransactions: [] };
  assert.equal(remotePairNeedsPush(remoteCaughtUp, local, []), false);

  const tombstone = { id: "d", deletedAt: 5, transaction: { id: "local" } };
  assert.equal(remotePairNeedsPush({ transactions: local, deletedTransactions: [tombstone] }, local, []), true);
});

test("the pair document carries the real sign-in email and the dot-stripped key", () => {
  const payload = pairWritePayload({
    pairId: "pair",
    myEmail: "Rishi.Kesh@gmail.com",
    friendEmail: "aryan@gmail.com",
    transactions: [{ id: "tx", receipt: "data:image/jpeg;base64,abc", amount: 100 }],
    deletedTransactions: []
  });
  assert.deepEqual(payload.participantKeys, ["aryan@gmail.com", "rishikesh@gmail.com"]);
  assert.deepEqual([...payload.participants].sort(), ["aryan@gmail.com", "rishi.kesh@gmail.com"]);
  assert.equal(payload.participants.length, 2);
  assert.equal(payload.transactions[0].receipt, undefined);
});
