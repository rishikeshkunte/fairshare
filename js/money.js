/** Integer money. 100 paise = 1.00 of the group's currency. */

export function newId() {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function rupeesToPaise(input) {
  if (input == null) return null;
  const text = String(input).trim().replace(/,/g, "");
  if (!text) return null;
  const neg = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  if (!/^\d+(\.\d+)?$/.test(unsigned)) return null;
  const [whole, frac = ""] = unsigned.split(".");
  const frac2 = (frac + "00").slice(0, 2);
  const roundUp = Number(frac[2] || "0") >= 5;
  let paise = Number(whole) * 100 + Number(frac2);
  if (roundUp) paise += 1;
  return neg ? -paise : paise;
}

export function paiseToInput(paise) {
  const n = Math.round(Number(paise) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(paise, currency = "₹") {
  const n = Math.round(Number(paise) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${currency}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatSignedMoney(paise, currency = "₹") {
  const n = Math.round(Number(paise) || 0);
  if (Math.abs(n) < 1) return `${currency}0.00`;
  return (n > 0 ? "+" : "-") + formatMoney(Math.abs(n), currency);
}

export function allocateEqual(totalPaise, ids) {
  if (!ids.length || totalPaise == null) return null;
  const base = Math.floor(totalPaise / ids.length);
  let rem = totalPaise - base * ids.length;
  const shares = {};
  ids.forEach((id) => {
    shares[id] = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem -= 1;
  });
  return shares;
}

export function allocateWeighted(totalPaise, weights) {
  const usable = weights.filter((item) => item.weight > 0);
  const sum = usable.reduce((total, item) => total + item.weight, 0);
  if (!usable.length || sum <= 0 || totalPaise == null) return null;
  const shares = {};
  weights.forEach((item) => { shares[item.id] = 0; });
  let assigned = 0;
  usable.forEach((item, index) => {
    if (index === usable.length - 1) shares[item.id] = totalPaise - assigned;
    else {
      const part = Math.floor((totalPaise * item.weight) / sum);
      shares[item.id] = part;
      assigned += part;
    }
  });
  return shares;
}

function scaleMoney(value) {
  if (value == null || value === "") return 0;
  return rupeesToPaise(value) || 0;
}

function convertTx(tx) {
  if (!tx || typeof tx !== "object") return tx;
  if (tx.amountPaise != null && tx._money === "paise") return tx;
  const next = { ...tx, _money: "paise" };
  if (tx.amount != null) next.amount = scaleMoney(tx.amount);
  if (tx.shares) {
    next.shares = {};
    for (const [key, value] of Object.entries(tx.shares)) next.shares[key] = scaleMoney(value);
  }
  return next;
}

/** One-way conversion of rupee floats into integer paise. Safe to run twice. */
export function migrateMoney(state) {
  if (!state || state.schemaVersion === 9) return state;
  const next = { ...state, schemaVersion: 9 };
  next.directTransactions = (state.directTransactions || []).map(convertTx);
  next.deletedTransactions = (state.deletedTransactions || []).map((item) => (
    item?.transaction ? { ...item, transaction: convertTx(item.transaction) } : item
  ));
  next.groups = {};
  for (const [id, group] of Object.entries(state.groups || {})) {
    next.groups[id] = {
      ...group,
      transactions: (group.transactions || []).map(convertTx),
      deletedTransactions: (group.deletedTransactions || []).map((item) => (
        item?.transaction ? { ...item, transaction: convertTx(item.transaction) } : item
      ))
    };
  }
  return next;
}

export function mergeById(localList, remoteList) {
  const map = new Map();
  const consider = (tx) => {
    if (!tx || tx.id == null) return;
    const key = String(tx.id);
    const prev = map.get(key);
    const stamp = tx.updatedAt || tx.timestamp || 0;
    const prevStamp = prev ? (prev.updatedAt || prev.timestamp || 0) : -1;
    if (!prev || stamp >= prevStamp) map.set(key, tx);
  };
  (remoteList || []).forEach(consider);
  (localList || []).forEach(consider);
  return [...map.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export function stripReceiptBytes(transactions) {
  return (transactions || []).map((tx) => {
    const copy = { ...tx };
    if (typeof copy.receipt === "string" && copy.receipt.startsWith("data:")) delete copy.receipt;
    return copy;
  });
}
