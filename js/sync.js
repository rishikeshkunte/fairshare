import { stripReceiptBytes } from "./money.js";

/** Same Gmail identity Google will accept, with or without dots in the local part. */
export function canonEmail(email) {
  if (!email) return "";
  let clean = String(email).toLowerCase().trim();
  if (clean.endsWith("@gmail.com")) {
    const local = clean.slice(0, clean.length - "@gmail.com".length);
    clean = local.replace(/\./g, "") + "@gmail.com";
  }
  return clean;
}

export function pairIdFor(emailA, emailB) {
  const a = canonEmail(emailA);
  const b = canonEmail(emailB);
  if (!a || !b || a === b) return "";
  return [a, b].sort().join("_").replace(/[^a-z0-9_]/g, "_");
}

export function txStamp(tx) {
  const raw = tx?.updatedAt ?? tx?.timestamp ?? 0;
  if (raw && typeof raw === "object") {
    if (typeof raw.toMillis === "function") return raw.toMillis();
    if (typeof raw.seconds === "number") return raw.seconds * 1000;
  }
  const stamp = Number(raw);
  return Number.isFinite(stamp) ? stamp : 0;
}

export function tombstoneIds(deleted) {
  const ids = new Set();
  for (const item of deleted || []) {
    const id = item?.transaction?.id ?? item?.transactionId;
    if (id != null) ids.add(String(id));
  }
  return ids;
}

/**
 * Cloud and this device are reconciled by id.
 * A deletion tombstone wins until a newer edit or restore updates the expense.
 * On a tie the cloud copy wins, so a stale local copy cannot overwrite it.
 * A local-only expense with no tombstone is kept.
 */
export function mergePairLedger({ localTransactions, remoteTransactions, localDeleted, remoteDeleted }) {
  const tombMap = new Map();
  for (const item of [...(localDeleted || []), ...(remoteDeleted || [])]) {
    if (!item) continue;
    const id = item.transaction?.id ?? item.transactionId;
    if (id == null) continue;
    const key = String(id);
    const prev = tombMap.get(key);
    if (!prev || Number(item.deletedAt || 0) >= Number(prev.deletedAt || 0)) tombMap.set(key, item);
  }
  const map = new Map();
  const consider = (tx, tieWins) => {
    if (!tx || tx.id == null) return;
    const key = String(tx.id);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, tx);
      return;
    }
    const stamp = txStamp(tx);
    const prevStamp = txStamp(prev);
    if (stamp > prevStamp || (tieWins && stamp === prevStamp)) map.set(key, tx);
  };
  (localTransactions || []).forEach((tx) => consider(tx, false));
  (remoteTransactions || []).forEach((tx) => consider(tx, true));
  const deletedTransactions = [];
  for (const [key, tomb] of tombMap) {
    const tx = map.get(key);
    if (!tx || Number(tomb.deletedAt || 0) >= txStamp(tx)) {
      map.delete(key);
      deletedTransactions.push(tomb);
    }
  }
  deletedTransactions.sort((a, b) => Number(b.deletedAt || 0) - Number(a.deletedAt || 0));
  const transactions = [...map.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return { transactions, deletedTransactions };
}

export function preserveLocalReceipts(mergedTransactions, localTransactions) {
  const localById = new Map();
  for (const transaction of localTransactions || []) {
    if (!transaction || transaction.id == null) continue;
    localById.set(String(transaction.id), transaction);
  }
  return (mergedTransactions || []).map((transaction) => {
    if (!transaction || transaction.id == null) return transaction;
    const local = localById.get(String(transaction.id));
    if (!local || txStamp(local) !== txStamp(transaction)) return transaction;
    let copy = null;
    for (const field of ["receipt", "receiptUrl", "receiptPath"]) {
      if (transaction[field] == null && local[field] != null) {
        copy = copy || { ...transaction };
        copy[field] = local[field];
      }
    }
    return copy || transaction;
  });
}

export function ledgerSignature(transactions, deleted) {
  const tx = (transactions || []).map((item) => `${item.id}:${txStamp(item)}`).sort().join("|");
  const removed = (deleted || [])
    .map((item) => {
      const id = item?.transaction?.id ?? item?.transactionId;
      if (id == null) return "";
      return `${String(id)}:${Number(item.deletedAt || 0)}`;
    })
    .filter(Boolean)
    .sort()
    .join("|");
  return `${tx}#${removed}`;
}

export function remotePairNeedsPush(remote, localTransactions, localDeleted) {
  const merged = mergePairLedger({
    localTransactions,
    remoteTransactions: remote?.transactions || [],
    localDeleted,
    remoteDeleted: remote?.deletedTransactions || []
  });
  return ledgerSignature(remote?.transactions, remote?.deletedTransactions) !== ledgerSignature(merged.transactions, merged.deletedTransactions);
}

export function transactionsForFriend(transactions, friendName) {
  return (transactions || []).filter((tx) => tx && tx.friend === friendName);
}

export function deletedForFriend(deleted, friendName, friendEmail) {
  const wanted = canonEmail(friendEmail);
  return (deleted || []).filter((item) => {
    if (!item || item.location !== "direct") return false;
    if (wanted && item.friendEmail && canonEmail(item.friendEmail) === wanted) return true;
    return item.transaction?.friend === friendName || item.friend === friendName;
  });
}

function rekeyTransaction(tx, friendName, friendEmail, myEmail) {
  if (!tx) return tx;
  const friendKey = canonEmail(friendEmail);
  const myKey = canonEmail(myEmail);
  const originalFriend = tx.friend;
  const copy = { ...tx, friend: friendName, scope: tx.scope || "direct" };
  const sharesByEmail = tx.sharesByEmail || null;
  if (sharesByEmail && myKey && friendKey && (myKey in sharesByEmail || friendKey in sharesByEmail)) {
    copy.shares = {
      You: Number(sharesByEmail[myKey]) || 0,
      [friendName]: Number(sharesByEmail[friendKey]) || 0
    };
  } else if (tx.shares) {
    const mapped = {};
    Object.entries(tx.shares).forEach(([name, share]) => {
      if (name === "You") mapped[friendName] = share;
      else if (originalFriend && name === originalFriend) mapped["You"] = share;
      else mapped[name] = share;
    });
    copy.shares = mapped;
  }
  const mapParticipant = (email, name) => {
    if (email) {
      const key = canonEmail(email);
      if (key === friendKey) return friendName;
      if (key === myKey) return "You";
    }
    if (name === "You") return friendName;
    if (originalFriend && name === originalFriend) return "You";
    return name;
  };
  if (tx.payerEmail || tx.payer) copy.payer = mapParticipant(tx.payerEmail, tx.payer);
  if (tx.receiverEmail || tx.receiver) copy.receiver = mapParticipant(tx.receiverEmail, tx.receiver);
  return copy;
}

function relabelDeleted(deleted, friendName, friendEmail, myEmail) {
  return (deleted || []).map((item) => ({
    ...item,
    location: "direct",
    transaction: item.transaction ? rekeyTransaction(item.transaction, friendName, friendEmail, myEmail) : item.transaction
  }));
}

export function applyRemotePair(state, { friendName, friendEmail, myEmail, remoteTransactions, remoteDeleted }) {
  const localTx = transactionsForFriend(state.directTransactions, friendName);
  const otherTx = (state.directTransactions || []).filter((tx) => !tx || tx.friend !== friendName);
  const localDeleted = deletedForFriend(state.deletedTransactions, friendName, friendEmail);
  const otherDeleted = (state.deletedTransactions || []).filter((item) => !localDeleted.includes(item));
  const merged = mergePairLedger({
    localTransactions: localTx,
    remoteTransactions: (remoteTransactions || []).map((tx) => rekeyTransaction(tx, friendName, friendEmail, myEmail)),
    localDeleted,
    remoteDeleted: relabelDeleted(remoteDeleted, friendName, friendEmail, myEmail)
  });
  return {
    directTransactions: [...merged.transactions, ...otherTx].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)),
    deletedTransactions: [...merged.deletedTransactions, ...otherDeleted]
  };
}

export function friendsSignature(friends) {
  return (friends || []).map((friend) => {
    const email = friend.email || "";
    return `${canonEmail(email)}|${String(friend.name || "").toLowerCase()}|${email.toLowerCase()}`;
  }).sort().join("\n");
}

export function linkFriend(friends, email, name, createId) {
  const list = (friends || []).map((friend) => ({ ...friend }));
  const em = email ? String(email).toLowerCase().trim() : "";
  const nm = (name && String(name).trim()) || (em ? em.split("@")[0] : "");
  if (!em && !nm) return { friends: list, friend: null, changed: false };

  if (em) {
    const byEmail = list.find((friend) => friend.email && canonEmail(friend.email) === canonEmail(em));
    if (byEmail) {
      byEmail.approved = true;
      if (!byEmail.type) byEmail.type = "google";
      return { friends: list, friend: byEmail, changed: false };
    }
    const nameless = list.find((friend) => !friend.email && friend.name && friend.name.toLowerCase() === nm.toLowerCase());
    if (nameless) {
      nameless.email = em;
      nameless.approved = true;
      nameless.type = nameless.type || "google";
      return { friends: list, friend: nameless, changed: true };
    }
  }

  const byName = list.find((friend) => friend.name && nm && friend.name.toLowerCase() === nm.toLowerCase());
  if (byName) return { friends: list, friend: byName, changed: false };

  const friend = {
    id: typeof createId === "function" ? createId() : `f_${Date.now()}`,
    name: nm || "Friend",
    email: em,
    approved: Boolean(em),
    type: em ? "google" : "custom"
  };
  list.push(friend);
  return { friends: list, friend, changed: true };
}

export function mergeFriends(localFriends, remoteFriends, createId) {
  let friends = (localFriends || []).map((friend) => ({ ...friend }));
  let changed = false;
  for (const remote of remoteFriends || []) {
    const linked = linkFriend(friends, remote.email || "", remote.name || "", createId || (() => remote.id || `f_${Date.now()}`));
    friends = linked.friends;
    if (linked.changed) changed = true;
  }
  return { friends, changed };
}

export function stripPairDeleted(items) {
  return (items || []).map((item) => {
    if (!item?.transaction) return item;
    const [transaction] = stripReceiptBytes([item.transaction]);
    return { ...item, transaction };
  });
}

function emailForMember(member, { myEmail, friendEmail, friendName } = {}) {
  if (member === "You") return canonEmail(myEmail);
  if (member === friendName) return canonEmail(friendEmail);
  return "";
}

export function canonicalizePairTransaction(transaction, context) {
  if (!transaction || typeof transaction !== "object") return transaction;
  const mine = String(context?.myEmail || "").toLowerCase().trim();
  const copy = {
    ...transaction,
    ownerEmail: String(transaction.ownerEmail || mine).toLowerCase().trim(),
    scope: transaction.scope || "direct"
  };
  const payerEmail = transaction.payerEmail
    ? canonEmail(transaction.payerEmail)
    : emailForMember(transaction.payer, context);
  if (payerEmail) copy.payerEmail = payerEmail;
  else delete copy.payerEmail;

  const receiverEmail = transaction.receiverEmail
    ? canonEmail(transaction.receiverEmail)
    : emailForMember(transaction.receiver, context);
  if (receiverEmail) copy.receiverEmail = receiverEmail;
  else delete copy.receiverEmail;

  if (transaction.sharesByEmail) {
    copy.sharesByEmail = Object.fromEntries(
      Object.entries(transaction.sharesByEmail).map(([email, share]) => [canonEmail(email) || email, share])
    );
  } else if (transaction.shares) {
    copy.sharesByEmail = Object.fromEntries(
      Object.entries(transaction.shares).map(([member, share]) => [emailForMember(member, context) || member, share])
    );
  }
  return copy;
}

export function canonicalizePairDeleted(item, context) {
  if (!item?.transaction) return item;
  return { ...item, transaction: canonicalizePairTransaction(item.transaction, context) };
}

export function buildPairWritePayload({
  pairId,
  myEmail,
  friendEmail,
  friendName,
  transactions,
  deletedTransactions,
  remoteTransactions,
  remoteDeleted
}) {
  const context = { myEmail, friendEmail, friendName };
  const localTransactions = transactionsForFriend(transactions, friendName)
    .map((transaction) => canonicalizePairTransaction(transaction, context));
  const localDeleted = deletedForFriend(deletedTransactions, friendName, friendEmail)
    .map((item) => canonicalizePairDeleted(item, context));
  const merged = mergePairLedger({
    localTransactions,
    remoteTransactions: remoteTransactions || [],
    localDeleted,
    remoteDeleted: remoteDeleted || []
  });
  return pairWritePayload({
    pairId,
    myEmail,
    friendEmail,
    transactions: merged.transactions,
    deletedTransactions: merged.deletedTransactions
  });
}

export function pairWritePayload({ pairId, myEmail, friendEmail, transactions, deletedTransactions }) {
  const mine = String(myEmail || "").toLowerCase().trim();
  const theirs = String(friendEmail || "").toLowerCase().trim();
  // Canonical addresses are the stable pair identity. Raw auth identity stays in
  // updatedBy and in Firestore request.auth; it must not alternate between writers.
  const participantKeys = [...new Set([canonEmail(mine), canonEmail(theirs)].filter(Boolean))].sort();
  return {
    pairId,
    schemaVersion: 9,
    participantKeys,
    participants: [...participantKeys],
    transactions: stripReceiptBytes(transactions || []),
    deletedTransactions: stripPairDeleted(deletedTransactions || []),
    updatedBy: mine
  };
}
