/**
 * Profile schema for `user_profiles/{uid}`.
 *
 * Friends and deleted-group tombstones live in nested maps, not arrays, so two
 * devices can add or update different records without replacing each other's
 * list. Map keys are deterministic and contain no "." or "/" so they are safe
 * as Firestore field names.
 *
 * The legacy `friends[]` and `deletedGroups[]` arrays are still read during the
 * transition window; they are never written once the maps are in use.
 */

import { stableStringify } from "./normalizedsync.js";

export function canonicalEmail(email) {
  let value = String(email || "").toLowerCase().trim();
  if (value.endsWith("@gmail.com")) {
    value = value.slice(0, -"@gmail.com".length).replace(/\./g, "") + "@gmail.com";
  }
  return value;
}

function hexOf(value) {
  const bytes = new TextEncoder().encode(String(value));
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hash32(value) {
  let hash = 5381;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Stable identity for one contact. An existing `profileKey` always wins, so a
 * contact that later gains an email address keeps its original key instead of
 * becoming a duplicate.
 */
export function friendProfileKey(friend) {
  if (!friend) return "";
  if (friend.profileKey) return String(friend.profileKey);
  if (friend.uid) return `u_${String(friend.uid).replace(/[^A-Za-z0-9_-]/g, "")}`;
  const email = canonicalEmail(friend.email || "");
  if (email) return `e_${hexOf(email)}`;
  const phone = String(friend.phone || "").replace(/[^0-9]/g, "");
  if (phone) return `p_${phone}`;
  return `n_${hash32(String(friend.name || "").trim().toLowerCase())}`;
}

export function friendProfileRecord(friend) {
  const key = friendProfileKey(friend);
  return {
    key,
    name: String(friend.name || "").trim(),
    email: friend.email ? canonicalEmail(friend.email) : null,
    phone: friend.phone ? String(friend.phone) : null,
    approved: Boolean(friend.approved),
    hidden: Boolean(friend.hidden),
    type: friend.type || (friend.email ? "google" : "custom")
  };
}

export function buildFriendsMap(friends = []) {
  const map = {};
  (friends || []).forEach(friend => {
    if (!friend || !friend.name) return;
    const record = friendProfileRecord(friend);
    if (!record.key) return;
    map[record.key] = record;
  });
  return map;
}

export function isTombstone(record) {
  return Boolean(record && Number(record.deletedAt));
}

/**
 * One batched object of map entries for a save: changed/added records plus
 * tombstones for keys the cloud still has but the local roster no longer does.
 * Returns `{}` when nothing changed, so the caller can skip the write.
 */
export function diffFriendsMap(friends = [], cloudMap = {}, now = Date.now()) {
  const entries = {};
  const localMap = buildFriendsMap(friends);
  Object.entries(localMap).forEach(([key, record]) => {
    const previous = cloudMap[key];
    if (!previous || stableStringify(previous) !== stableStringify(record)) {
      entries[key] = record;
    }
  });
  Object.entries(cloudMap || {}).forEach(([key, record]) => {
    if (!record || isTombstone(record)) return;
    if (!localMap[key]) entries[key] = { deletedAt: now };
  });
  return entries;
}

/** Cloud map unioned with the legacy array; the map wins on key collision. */
export function friendsFromCloud(cloudMap = {}, legacyArray = []) {
  const merged = new Map();
  (legacyArray || []).forEach(friend => {
    if (!friend || !friend.name) return;
    const key = friendProfileKey(friend);
    merged.set(key, { ...friend, profileKey: key });
  });
  Object.entries(cloudMap || {}).forEach(([key, record]) => {
    if (!record) return;
    if (isTombstone(record)) {
      merged.delete(key);
      return;
    }
    merged.set(key, {
      id: record.key || key,
      profileKey: key,
      name: record.name || "",
      email: record.email || "",
      phone: record.phone || "",
      approved: Boolean(record.approved),
      hidden: Boolean(record.hidden),
      type: record.type || (record.email ? "google" : "custom")
    });
  });
  return Array.from(merged.values()).filter(friend => friend && friend.name);
}

export function deletedGroupsFromCloud(cloudMap = {}, legacyArray = []) {
  const ids = new Set();
  (legacyArray || []).forEach(id => { if (id) ids.add(String(id)); });
  Object.entries(cloudMap || {}).forEach(([key, value]) => {
    if (value) ids.add(String(key));
  });
  return Array.from(ids);
}

export function diffDeletedGroupsMap(ids = [], cloudMap = {}) {
  const entries = {};
  (ids || []).forEach(id => {
    const key = String(id || "");
    if (!key) return;
    if (!(key in (cloudMap || {}))) entries[key] = true;
  });
  return entries;
}
