import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRemotePair,
  buildPairWritePayload,
  canonEmail,
  linkFriend,
  mergeFriends,
  mergePairLedger,
  pairIdFor,
  pairWritePayload,
  preserveLocalReceipts,
  remotePairNeedsPush
} from "../js/sync.js";
import { stripReceiptBytes } from "../js/money.js";

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

test("remote pair transactions are rekeyed into the receiving account's view", () => {
  const next = applyRemotePair({ directTransactions: [], deletedTransactions: [] }, {
    friendName: "Aryan",
    friendEmail: "aryan@gmail.com",
    myEmail: "rishi@gmail.com",
    remoteTransactions: [{
      id: "tx",
      friend: "Rishi",
      payer: "You",
      payerEmail: "aryan@gmail.com",
      sharesByEmail: { "aryan@gmail.com": 500, "rishi@gmail.com": 500 },
      shares: { You: 500, Rishi: 500 },
      timestamp: 1,
      updatedAt: 1
    }],
    remoteDeleted: [{
      id: "del",
      location: "direct",
      deletedAt: 2,
      transaction: {
        id: "old",
        friend: "Rishi",
        payer: "Rishi",
        payerEmail: "rishi@gmail.com",
        sharesByEmail: { "aryan@gmail.com": 100, "rishi@gmail.com": 100 }
      }
    }]
  });
  const tx = next.directTransactions.find(item => item.id === "tx");
  assert.equal(tx.friend, "Aryan");
  assert.equal(tx.payer, "Aryan");
  assert.deepEqual(tx.shares, { You: 500, Aryan: 500 });
  const deleted = next.deletedTransactions.find(item => item.id === "del");
  assert.equal(deleted.transaction.friend, "Aryan");
  assert.equal(deleted.transaction.payer, "You");
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

test("the pair document carries a stable canonical participant identity", () => {
  const payload = pairWritePayload({
    pairId: "pair",
    myEmail: "Rishi.Kesh@gmail.com",
    friendEmail: "aryan@gmail.com",
    transactions: [{ id: "tx", receipt: "data:image/jpeg;base64,abc", amount: 100 }],
    deletedTransactions: []
  });
  assert.deepEqual(payload.participantKeys, ["aryan@gmail.com", "rishikesh@gmail.com"]);
  assert.deepEqual(payload.participants, payload.participantKeys);
  assert.equal(payload.participants.length, 2);
  assert.equal(payload.updatedBy, "rishi.kesh@gmail.com");
  assert.equal(payload.transactions[0].receipt, undefined);
});

test("alternating writes by both users keep one stable participant identity", () => {
  const rishi = pairWritePayload({
    pairId: "pair",
    myEmail: "rishi.kesh@gmail.com",
    friendEmail: "aryank@gmail.com",
    transactions: [],
    deletedTransactions: []
  });
  const aryan = pairWritePayload({
    pairId: "pair",
    myEmail: "aryan.k@gmail.com",
    friendEmail: "rishikesh@gmail.com",
    transactions: [],
    deletedTransactions: []
  });
  assert.deepEqual(rishi.participantKeys, aryan.participantKeys);
  assert.deepEqual(rishi.participants, aryan.participants);
  assert.deepEqual(rishi.participants, ["aryank@gmail.com", "rishikesh@gmail.com"]);
  assert.equal(canonEmail("ada.lovelace@outlook.com"), "ada.lovelace@outlook.com");
});

test("alternating ledger writes by both users preserve both transactions", () => {
  const rishiTx = {
    id: "rishi-tx",
    friend: "Aryan",
    ownerEmail: "rishi.kesh@gmail.com",
    payer: "You",
    shares: { You: 500, Aryan: 500 },
    timestamp: 10,
    updatedAt: 10
  };
  const aryanTx = {
    id: "aryan-tx",
    friend: "Rishi",
    ownerEmail: "aryan.k@gmail.com",
    payer: "You",
    shares: { You: 700, Rishi: 700 },
    timestamp: 11,
    updatedAt: 11
  };
  const base = {
    pairId: pairIdFor("rishi.kesh@gmail.com", "aryank@gmail.com"),
    myEmail: "rishi.kesh@gmail.com",
    friendEmail: "aryank@gmail.com",
    friendName: "Aryan",
    deletedTransactions: []
  };
  const rishiWrite = buildPairWritePayload({
    ...base,
    transactions: [rishiTx],
    remoteTransactions: [],
    remoteDeleted: []
  });
  const aryanWrite = buildPairWritePayload({
    pairId: base.pairId,
    myEmail: "aryan.k@gmail.com",
    friendEmail: "rishikesh@gmail.com",
    friendName: "Rishi",
    transactions: [aryanTx],
    deletedTransactions: [],
    remoteTransactions: rishiWrite.transactions,
    remoteDeleted: rishiWrite.deletedTransactions
  });
  assert.deepEqual(aryanWrite.participants, rishiWrite.participants);
  assert.deepEqual(aryanWrite.transactions.map((tx) => tx.id).sort(), ["aryan-tx", "rishi-tx"]);

  const rishiAfter = buildPairWritePayload({
    ...base,
    transactions: [rishiTx],
    remoteTransactions: aryanWrite.transactions,
    remoteDeleted: aryanWrite.deletedTransactions
  });
  assert.deepEqual(rishiAfter.transactions.map((tx) => tx.id).sort(), ["aryan-tx", "rishi-tx"]);
  assert.equal(rishiAfter.transactions.find((tx) => tx.id === "rishi-tx").payerEmail, "rishikesh@gmail.com");
});

test("a newer local tombstone triggers a push even when the transaction id matches", () => {
  const remote = {
    transactions: [],
    deletedTransactions: [{ id: "remote-del", location: "direct", deletedAt: 5, transaction: { id: "tx", updatedAt: 1 } }]
  };
  const localDeleted = [{ id: "local-del", location: "direct", deletedAt: 9, transaction: { id: "tx", updatedAt: 1 } }];
  assert.equal(remotePairNeedsPush(remote, [], localDeleted), true);
});

test("a stale cloud snapshot cannot resurrect a deleted transaction or erase a newer local tombstone", () => {
  const transaction = { id: "tx1", friend: "Aryan", amount: 5000, timestamp: 10, updatedAt: 10 };
  const tombstone = { id: "del1", location: "direct", deletedAt: 20, transaction: { ...transaction } };
  const state = { directTransactions: [], deletedTransactions: [tombstone] };
  const next = applyRemotePair(state, {
    friendName: "Aryan",
    friendEmail: "aryank@gmail.com",
    remoteTransactions: [transaction],
    remoteDeleted: []
  });
  assert.equal(next.directTransactions.length, 0);
  assert.equal(next.deletedTransactions.length, 1);
  assert.equal(next.deletedTransactions[0].id, "del1");
});

test("a deletion from one account survives the other account applying a later stale snapshot", () => {
  const transaction = { id: "tx1", friend: "Rishi", amount: 5000, timestamp: 10, updatedAt: 10 };
  const tombstone = { id: "del1", location: "direct", deletedAt: 20, transaction: { ...transaction } };
  const rishi = { directTransactions: [], deletedTransactions: [tombstone] };

  const aryanAfterDelete = applyRemotePair(
    { directTransactions: [transaction], deletedTransactions: [] },
    {
      friendName: "Rishi",
      friendEmail: "rishi.kesh@gmail.com",
      remoteTransactions: rishi.directTransactions,
      remoteDeleted: rishi.deletedTransactions
    }
  );
  assert.equal(aryanAfterDelete.directTransactions.length, 0);
  assert.equal(aryanAfterDelete.deletedTransactions.length, 1);

  const afterStaleSnapshot = applyRemotePair(aryanAfterDelete, {
    friendName: "Rishi",
    friendEmail: "rishi.kesh@gmail.com",
    remoteTransactions: [transaction],
    remoteDeleted: []
  });
  assert.equal(afterStaleSnapshot.directTransactions.length, 0);
  assert.equal(afterStaleSnapshot.deletedTransactions.length, 1);
});

test("a deliberate restore newer than the old tombstone is retained", () => {
  const expense = { id: "tx1", friend: "Aryan", amount: 5000, timestamp: 10, updatedAt: 10 };
  const tombstone = { id: "del1", location: "direct", deletedAt: 20, transaction: { ...expense } };
  const restored = { ...expense, updatedAt: 30 };
  const merged = mergePairLedger({
    localTransactions: [restored],
    remoteTransactions: [],
    localDeleted: [],
    remoteDeleted: [tombstone]
  });
  assert.deepEqual(merged.transactions.map((tx) => tx.id), ["tx1"]);
  assert.equal(merged.deletedTransactions.length, 0);
});

test("equal-timestamp cloud merges keep the local receipt fields", () => {
  const local = {
    id: "tx1",
    timestamp: 10,
    updatedAt: 10,
    receipt: "data:image/jpeg;base64,AAAA",
    receiptUrl: "https://example.test/receipt.jpg",
    receiptPath: "receipts/g/tx1.jpg"
  };
  const cloud = { id: "tx1", timestamp: 10, updatedAt: 10 };
  const [merged] = preserveLocalReceipts([cloud], [local]);
  assert.equal(merged.receipt, local.receipt);
  assert.equal(merged.receiptUrl, local.receiptUrl);
  assert.equal(merged.receiptPath, local.receiptPath);
});

test("local receipt fields are not copied onto a newer transaction", () => {
  const local = { id: "tx1", timestamp: 5, updatedAt: 5, receipt: "data:image/jpeg;base64,OLD" };
  const newer = { id: "tx1", timestamp: 10, updatedAt: 11, desc: "newer cloud edit" };
  const [merged] = preserveLocalReceipts([newer], [local]);
  assert.equal(merged.receipt, undefined);
  assert.equal(merged.desc, "newer cloud edit");
});

test("transactions without receipts and locally deleted transactions are unchanged", () => {
  const noReceipt = { id: "plain", timestamp: 10, updatedAt: 10, amount: 100 };
  const [same] = preserveLocalReceipts([noReceipt], [{ ...noReceipt, updatedAt: 10 }]);
  assert.deepEqual(same, noReceipt);

  const localWithReceipt = { id: "deleted", timestamp: 10, updatedAt: 10, receipt: "data:image/jpeg;base64,AAAA" };
  assert.deepEqual(preserveLocalReceipts([], [localWithReceipt]), []);
});

test("a stale group snapshot cannot erase a newer local tombstone", () => {
  const transaction = { id: "g-tx", amount: 5000, timestamp: 10, updatedAt: 10 };
  const tombstone = { id: "g-del", location: "group", deletedAt: 20, transaction: { ...transaction } };
  const staleCloud = { transactions: [transaction], deletedTransactions: [] };
  const merged = mergePairLedger({
    localTransactions: [],
    remoteTransactions: staleCloud.transactions,
    localDeleted: [tombstone],
    remoteDeleted: staleCloud.deletedTransactions
  });
  assert.equal(merged.transactions.length, 0);
  assert.deepEqual(merged.deletedTransactions.map((item) => item.id), ["g-del"]);
  assert.equal(remotePairNeedsPush(staleCloud, [], [tombstone]), true);
});

test("group reconciliation restores a local receipt after a stripped cloud merge", () => {
  const local = { id: "g1", timestamp: 10, updatedAt: 10, receipt: "data:image/jpeg;base64,AAAA" };
  const cloud = { id: "g1", timestamp: 10, updatedAt: 10, receiptUrl: "https://example.test/r.jpg" };
  const writeMerge = mergePairLedger({
    localTransactions: stripReceiptBytes([local]),
    remoteTransactions: [cloud],
    localDeleted: [],
    remoteDeleted: []
  });
  const reconciled = mergePairLedger({
    localTransactions: [local],
    remoteTransactions: writeMerge.transactions,
    localDeleted: [],
    remoteDeleted: []
  });
  const [preserved] = preserveLocalReceipts(reconciled.transactions, [local]);
  assert.equal(preserved.receipt, local.receipt);
  assert.equal(preserved.receiptUrl, cloud.receiptUrl);
});

test("direct-pair reconciliation restores a local receipt after a stripped snapshot", () => {
  const local = { id: "d1", friend: "Aryan", timestamp: 10, updatedAt: 10, receipt: "data:image/jpeg;base64,AAAA" };
  const cloud = { id: "d1", friend: "Aryan", timestamp: 10, updatedAt: 10 };
  const next = applyRemotePair(
    { directTransactions: [local], deletedTransactions: [] },
    {
      friendName: "Aryan",
      friendEmail: "aryank@gmail.com",
      remoteTransactions: [cloud],
      remoteDeleted: []
    }
  );
  const [preserved] = preserveLocalReceipts(next.directTransactions, [local]);
  assert.equal(preserved.receipt, local.receipt);
});
