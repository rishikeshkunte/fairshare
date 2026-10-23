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

export function ledgerSignature(transactions, deleted) {
  const tx = (transactions || []).map((item) => `${item.id}:${txStamp(item)}`).sort().join("|");
  const removed = [...tombstoneIds(deleted)].sort().join("|");
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

function relabel(transactions, friendName) {
  return (transactions || []).map((tx) => ({ ...tx, friend: friendName, scope: tx.scope || "direct" }));
}

function relabelDeleted(deleted, friendName) {
  return (deleted || []).map((item) => ({
    ...item,
    location: "direct",
    transaction: item.transaction ? { ...item.transaction, friend: friendName, scope: item.transaction.scope || "direct" } : item.transaction
  }));
}

export function applyRemotePair(state, { friendName, friendEmail, remoteTransactions, remoteDeleted }) {
  const localTx = transactionsForFriend(state.directTransactions, friendName);
  const otherTx = (state.directTransactions || []).filter((tx) => !tx || tx.friend !== friendName);
  const localDeleted = deletedForFriend(state.deletedTransactions, friendName, friendEmail);
  const otherDeleted = (state.deletedTransactions || []).filter((item) => !localDeleted.includes(item));
  const merged = mergePairLedger({
    localTransactions: localTx,
    remoteTransactions: relabel(remoteTransactions, friendName),
    localDeleted,
    remoteDeleted: relabelDeleted(remoteDeleted, friendName)
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

export function pairWritePayload({ pairId, myEmail, friendEmail, transactions, deletedTransactions }) {
  const mine = String(myEmail || "").toLowerCase().trim();
  const theirs = String(friendEmail || "").toLowerCase().trim();
  const participantKeys = [canonEmail(mine), canonEmail(theirs)].filter(Boolean).sort();
  // Exactly two addresses: the sign-in email and the friend's email.
  // The published rules reject a pair document whose participant list is any other size.
  const participants = [...new Set([mine, theirs].filter(Boolean))];
  return {
    pairId,
    schemaVersion: 9,
    participantKeys,
    participants,
    transactions: stripReceiptBytes(transactions || []),
    deletedTransactions: stripPairDeleted(deletedTransactions || []),
    updatedBy: mine
  };
}
