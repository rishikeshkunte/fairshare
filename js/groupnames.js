/**
 * Groups created before v56 stored the creator as a literal "You" member.
 * v56 migrated the creator's device, but a stale cloud member list can later
 * overwrite that local rename while transactions keep real names (or the
 * reverse). Balances silently drop any payer/share key that is not in
 * `group.members`, so those groups lose expense amounts and shares.
 *
 * repairGroupNames() reconciles the placeholder with the real name in one
 * direction or the other. It is idempotent and safe to call on every load.
 */

function canonicalEmail(email) {
  if (!email) return "";
  let clean = String(email).toLowerCase().trim();
  if (clean.endsWith("@gmail.com")) {
    clean = clean.slice(0, -"@gmail.com".length).replace(/\./g, "") + "@gmail.com";
  }
  return clean;
}

function unknownParticipants(group) {
  const members = new Set(group.members || []);
  const unknown = new Map();
  const add = (name) => {
    if (!name || name === "You" || members.has(name)) return;
    unknown.set(name, (unknown.get(name) || 0) + 1);
  };
  for (const tx of group.transactions || []) {
    add(tx?.payer);
    add(tx?.receiver);
    Object.keys(tx?.shares || {}).forEach(add);
  }
  return unknown;
}

export function resolveYouName(group, { myEmail = "", myName = "", friends = [] } = {}) {
  if (!group || !Array.isArray(group.members) || !group.members.includes("You")) return "";
  const linkedEmail = group.memberLinks?.You;

  if (linkedEmail && myEmail && canonicalEmail(linkedEmail) === canonicalEmail(myEmail)) {
    if (myName && myName !== "You") return myName;
  }

  if (linkedEmail) {
    const linkedFriend = (friends || []).find(
      (friend) => friend?.email && canonicalEmail(friend.email) === canonicalEmail(linkedEmail)
    );
    if (linkedFriend?.name && linkedFriend.name !== "You") return linkedFriend.name;
  }

  const unknown = unknownParticipants(group);
  if (unknown.size === 1) return [...unknown.keys()][0];

  if (myName && myName !== "You" && !group.members.includes(myName)) return myName;

  return "";
}

function txUses(group, name) {
  const uses = (tx) =>
    tx &&
    (tx.payer === name ||
      tx.receiver === name ||
      Object.prototype.hasOwnProperty.call(tx.shares || {}, name));
  return (
    (group.transactions || []).some(uses) ||
    (group.deletedTransactions || []).some((item) => uses(item?.transaction))
  );
}

function renameTransactions(group, from, to, now) {
  let changed = false;
  const apply = (tx) => {
    if (!tx || typeof tx !== "object") return;
    let txChanged = false;
    if (tx.payer === from) {
      tx.payer = to;
      txChanged = true;
    }
    if (tx.receiver === from) {
      tx.receiver = to;
      txChanged = true;
    }
    if (tx.shares && Object.prototype.hasOwnProperty.call(tx.shares, from)) {
      const share = Number(tx.shares[from]) || 0;
      delete tx.shares[from];
      tx.shares[to] = (Number(tx.shares[to]) || 0) + share;
      txChanged = true;
    }
    if (txChanged) {
      tx.updatedAt = now;
      if (!tx.timestamp) tx.timestamp = now;
      changed = true;
    }
  };
  (group.transactions || []).forEach(apply);
  (group.deletedTransactions || []).forEach((item) => apply(item?.transaction));
  return changed;
}

/**
 * Returns true when the group was modified. Renames "You" to the resolved real
 * name (or a stray real-name key back to "You" only when that name is already a
 * member and the transactions still use the placeholder).
 */
export function repairGroupNames(group, { myEmail = "", myName = "", friends = [], now = Date.now() } = {}) {
  if (!group || !Array.isArray(group.members) || group.members.length === 0) return false;

  let from = "";
  let to = "";

  if (group.members.includes("You")) {
    const resolved = resolveYouName(group, { myEmail, myName, friends });
    if (resolved && resolved !== "You") {
      from = "You";
      to = resolved;
    }
  } else if (myName && myName !== "You" && group.members.includes(myName) && txUses(group, "You")) {
    from = "You";
    to = myName;
  }

  if (!from || !to) return false;

  let changed = false;

  const renamedMembers = [];
  group.members.forEach((name) => {
    const next = name === from ? to : name;
    if (!renamedMembers.includes(next)) renamedMembers.push(next);
  });
  if (JSON.stringify(renamedMembers) !== JSON.stringify(group.members)) {
    group.members = renamedMembers;
    changed = true;
  }

  if (group.memberLinks && Object.prototype.hasOwnProperty.call(group.memberLinks, from)) {
    const email = group.memberLinks[from];
    delete group.memberLinks[from];
    if (!group.memberLinks[to]) group.memberLinks[to] = email;
    changed = true;
  }

  if (renameTransactions(group, from, to, now)) changed = true;

  return changed;
}
