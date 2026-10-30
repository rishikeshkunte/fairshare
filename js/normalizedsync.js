/**
 * Projects normalized group subcollection documents back into the legacy
 * transaction shape the existing UI understands. This is the bridge used while
 * Phase 3 switches reads from the legacy group document to the normalized
 * member/expense/settlement documents.
 */

function stripPrefix(id, prefix) {
  const value = String(id || "");
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * Signature serializer whose output does not depend on object key order.
 * Firestore returns map fields in its own order, so comparing plain
 * JSON.stringify output against a locally built document made every snapshot
 * look "changed" and rewrote the whole ledger on each save.
 */
export function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function displayDate(doc) {
  if (doc.date) return doc.date;
  if (!doc.dateISO) return "";
  const date = new Date(`${doc.dateISO}T00:00:00`);
  return isNaN(date.getTime()) ? doc.dateISO : date.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" });
}

function stamp(doc) {
  return Number(doc.updatedAt || doc.createdAt || 0) || 0;
}

export function projectGroupTransactions({ memberDocs = [], expenseDocs = [], settlementDocs = [] } = {}) {
  const nameById = new Map();
  (memberDocs || []).forEach(member => {
    if (!member || !member.id) return;
    if (member.status && member.status !== "active") return;
    nameById.set(member.id, member.displayName || member.id);
  });

  const transactions = [];
  (expenseDocs || []).forEach(doc => {
    if (!doc || doc.deletedAt) return;
    const shares = {};
    Object.entries(doc.shares || {}).forEach(([memberId, amount]) => {
      shares[nameById.get(memberId) || memberId] = Number(amount) || 0;
    });
    transactions.push({
      id: stripPrefix(doc.id, "expense_"),
      type: "expense",
      amount: Number(doc.amountPaise) || 0,
      payer: nameById.get(doc.payerMemberId) || doc.payerMemberId || "",
      shares,
      category: doc.category || "Other",
      desc: doc.description || "",
      notes: doc.notes || "",
      date: displayDate(doc),
      dateISO: doc.dateISO || "",
      splitMode: doc.splitMode || "equal",
      timestamp: stamp(doc),
      updatedAt: stamp(doc),
      importKey: doc.importKey || null,
      importSource: doc.importKey ? "splitwise" : null,
      _money: "paise"
    });
  });

  (settlementDocs || []).forEach(doc => {
    if (!doc || doc.deletedAt) return;
    transactions.push({
      id: stripPrefix(doc.id, "settlement_"),
      type: "settlement",
      amount: Number(doc.amountPaise) || 0,
      payer: nameById.get(doc.fromMemberId) || doc.fromMemberId || "",
      receiver: nameById.get(doc.toMemberId) || doc.toMemberId || "",
      category: "Settlement",
      desc: doc.description || "",
      date: displayDate(doc),
      dateISO: doc.dateISO || "",
      timestamp: stamp(doc),
      updatedAt: stamp(doc),
      _money: "paise"
    });
  });

  return transactions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export function projectGroupMembers(memberDocs = []) {
  return (memberDocs || [])
    .filter(member => member && (!member.status || member.status === "active"))
    .map(member => ({
      id: member.id,
      name: member.displayName || member.id,
      email: member.emailCanonical || "",
      role: member.role || "member",
      uid: member.uid || null
    }));
}

export function memberLinksFromDocs(memberDocs = []) {
  const links = {};
  (memberDocs || []).forEach(member => {
    if (!member || !member.displayName || !member.emailCanonical) return;
    links[member.displayName] = member.emailCanonical;
  });
  return links;
}
