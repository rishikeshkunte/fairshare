/**
 * Phase 1 of the normalized group schema.
 *
 * Legacy groups store member names and the whole transaction array in one
 * document. This module converts one legacy group into the target documents:
 *
 *   groups/{groupId}
 *   groups/{groupId}/members/{memberId}
 *   groups/{groupId}/expenses/{expenseId}
 *   groups/{groupId}/settlements/{settlementId}
 *
 * It is intentionally pure: no Firestore calls, no app state. The migration
 * driver can validate the result before writing it.
 */

function canonicalEmail(email) {
  if (!email) return "";
  let value = String(email).toLowerCase().trim();
  if (value.endsWith("@gmail.com")) {
    value = value.slice(0, -"@gmail.com".length).replace(/\./g, "") + "@gmail.com";
  }
  return value;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

export function memberIdFor({ uid = "", email = "", name = "" } = {}) {
  if (uid) return `uid_${uid}`;
  const canonical = canonicalEmail(email);
  if (canonical) return `email_${slug(canonical)}`;
  return `name_${slug(name)}`;
}

function memberMapFor(group, { ownerUid = "", ownerEmail = "" } = {}) {
  const members = Array.isArray(group?.members) ? group.members : [];
  const links = group?.memberLinks && typeof group.memberLinks === "object" ? group.memberLinks : {};
  const map = new Map();
  const docs = [];
  members.forEach((name, index) => {
    const email = canonicalEmail(links[name] || "");
    const isOwner = Boolean(ownerEmail) && email === canonicalEmail(ownerEmail);
    const uid = isOwner && ownerUid ? ownerUid : "";
    const id = uid ? `uid_${uid}` : (email ? `email_${slug(email)}` : `name_${slug(name)}_${index}`);
    map.set(name, id);
    docs.push({
      id,
      displayName: String(name),
      emailCanonical: email,
      uid: uid || null,
      role: isOwner ? "owner" : "member",
      status: "active"
    });
  });
  return { map, docs };
}

function expenseDoc(tx, memberIds) {
  const shares = {};
  for (const [name, amount] of Object.entries(tx.shares || {})) {
    const id = memberIds.get(name);
    if (!id) continue;
    shares[id] = (shares[id] || 0) + Math.round(Number(amount) || 0);
  }
  return {
    id: `expense_${tx.id}`,
    type: "expense",
    amountPaise: Math.round(Number(tx.amount) || 0),
    payerMemberId: memberIds.get(tx.payer) || null,
    shares,
    category: tx.category || "Other",
    description: tx.desc || "",
    notes: tx.notes || "",
    dateISO: tx.dateISO || "",
    splitMode: tx.splitMode || "equal",
    createdAt: tx.timestamp || tx.updatedAt || 0,
    updatedAt: tx.updatedAt || tx.timestamp || 0,
    createdBy: tx.ownerEmail || "",
    importKey: tx.importKey || null,
    deletedAt: null
  };
}

function settlementDoc(tx, memberIds) {
  return {
    id: `settlement_${tx.id}`,
    type: "settlement",
    amountPaise: Math.round(Number(tx.amount) || 0),
    fromMemberId: memberIds.get(tx.payer) || null,
    toMemberId: memberIds.get(tx.receiver) || null,
    description: tx.desc || "",
    dateISO: tx.dateISO || "",
    createdAt: tx.timestamp || tx.updatedAt || 0,
    updatedAt: tx.updatedAt || tx.timestamp || 0,
    createdBy: tx.ownerEmail || "",
    deletedAt: null
  };
}

/**
 * Returns a validation report plus the target documents. No writes happen here.
 */
export function normalizeLegacyGroup(group, owner = {}) {
  if (!group || typeof group !== "object" || !Array.isArray(group.members)) {
    return { ok: false, errors: ["group has no members"], group: null, members: [], expenses: [], settlements: [] };
  }
  const errors = [];
  const memberMap = memberMapFor(group, owner);
  const memberIds = memberMap.map;
  const expenses = [];
  const settlements = [];
  const tombstones = [];

  for (const tx of group.transactions || []) {
    if (!tx || typeof tx !== "object") {
      errors.push("transaction is not an object");
      continue;
    }
    if (tx.type === "expense") {
      const doc = expenseDoc(tx, memberIds);
      if (!doc.payerMemberId) errors.push(`unknown payer in ${tx.id}`);
      if (!Object.keys(doc.shares).length) errors.push(`no known shares in ${tx.id}`);
      const shareSum = Object.values(doc.shares).reduce((sum, value) => sum + value, 0);
      if (Math.abs(shareSum - doc.amountPaise) > 1) errors.push(`shares do not add up in ${tx.id}`);
      expenses.push(doc);
    } else if (tx.type === "settlement") {
      const doc = settlementDoc(tx, memberIds);
      if (!doc.fromMemberId) errors.push(`unknown sender in ${tx.id}`);
      if (!doc.toMemberId) errors.push(`unknown receiver in ${tx.id}`);
      settlements.push(doc);
    }
  }

  for (const item of group.deletedTransactions || []) {
    const tx = item?.transaction;
    if (!tx) continue;
    tombstones.push({
      transactionId: tx.id,
      type: tx.type,
      deletedAt: Number(item.deletedAt) || 0
    });
  }

  const ownerDoc = memberMap.docs.find(doc => doc.role === "owner") || null;
  return {
    ok: errors.length === 0,
    errors,
    group: {
      id: group.id,
      name: group.name || "Group",
      currency: group.currency || "₹",
      ownerUid: owner.ownerUid || null,
      ownerEmail: canonicalEmail(owner.ownerEmail || "") || null,
      simplifyDebts: group.simplifyDebts !== false,
      createdAt: group.createdAt || 0,
      updatedAt: group.updatedAt || 0,
      deletedAt: null
    },
    ownerMemberId: ownerDoc?.id || null,
    members: memberMap.docs,
    expenses,
    settlements,
    tombstones
  };
}

export function validateNormalizedGroup(plan, { requireOwner = false } = {}) {
  const errors = [];
  if (!plan || !plan.group) return ["missing group"];
  if (requireOwner && !plan.ownerMemberId) errors.push("missing owner member");
  const memberIds = new Set(plan.members.map(member => member.id));
  if (memberIds.size !== plan.members.length) errors.push("duplicate member ids");
  const active = plan.members.filter(member => member.status === "active");
  if (!active.length) errors.push("no active members");
  for (const expense of plan.expenses) {
    if (!memberIds.has(expense.payerMemberId)) errors.push(`expense ${expense.id} payer is not a member`);
    for (const id of Object.keys(expense.shares)) {
      if (!memberIds.has(id)) errors.push(`expense ${expense.id} share references ${id}`);
    }
  }
  for (const settlement of plan.settlements) {
    if (!memberIds.has(settlement.fromMemberId)) errors.push(`settlement ${settlement.id} sender is not a member`);
    if (!memberIds.has(settlement.toMemberId)) errors.push(`settlement ${settlement.id} receiver is not a member`);
  }
  return errors;
}
