import test from "node:test";
import assert from "node:assert/strict";
import {
  friendProfileKey,
  friendProfileRecord,
  buildFriendsMap,
  diffFriendsMap,
  friendsFromCloud,
  diffDeletedGroupsMap,
  deletedGroupsFromCloud
} from "../js/profileschema.js";

test("profile keys are deterministic and safe as field names", () => {
  const a = friendProfileKey({ name: "Poorva", email: "Poorva95@Gmail.com" });
  const b = friendProfileKey({ name: "Poorva", email: "poorva95@gmail.com" });
  assert.equal(a, b);
  assert.match(a, /^e_[0-9a-f]+$/);
  assert.doesNotMatch(a, /[./]/);

  assert.equal(friendProfileKey({ name: "Z", uid: "abc123" }), "u_abc123");
  assert.equal(friendProfileKey({ name: "Z", phone: "+91 98765-43210" }), "p_919876543210");
  assert.match(friendProfileKey({ name: "Only Name" }), /^n_[0-9a-f]{8}$/);
});

test("an existing key survives a later email link", () => {
  const before = { name: "Local", profileKey: "n_deadbeef" };
  const after = { ...before, email: "local@example.com" };
  assert.equal(friendProfileKey(after), "n_deadbeef");
});

test("records write explicit nulls for cleared optional fields", () => {
  const record = friendProfileRecord({ name: "A", profileKey: "e_00", email: "" });
  assert.equal(record.email, null);
  assert.equal(record.phone, null);
  assert.equal(record.hidden, false);
});

test("diff writes only changed keys and tombstones removals", () => {
  const cloud = buildFriendsMap([
    { name: "A", email: "a@example.com" },
    { name: "B", email: "b@example.com" }
  ]);
  const unchanged = diffFriendsMap([
    { name: "A", email: "a@example.com" },
    { name: "B", email: "b@example.com" }
  ], cloud, 1000);
  assert.deepEqual(unchanged, {});

  const added = diffFriendsMap([
    { name: "A", email: "a@example.com" },
    { name: "B", email: "b@example.com" },
    { name: "C", email: "c@example.com" }
  ], cloud, 1000);
  assert.equal(Object.keys(added).length, 1);

  const removed = diffFriendsMap([{ name: "A", email: "a@example.com" }], cloud, 1000);
  const tombstoneKey = friendProfileKey({ name: "B", email: "b@example.com" });
  assert.equal(removed[tombstoneKey].deletedAt, 1000);
});

test("a bulk save batches every changed key into one object", () => {
  const friends = Array.from({ length: 12 }, (_, index) => ({
    name: `Friend ${index}`,
    email: `friend${index}@example.com`
  }));
  const entries = diffFriendsMap(friends, {}, 1);
  assert.equal(Object.keys(entries).length, 12);
});

test("cloud reads project the map and skip tombstones", () => {
  const key = friendProfileKey({ name: "A", email: "a@example.com" });
  const merged = friendsFromCloud({
    [key]: { key, name: "A renamed", email: "a@example.com", hidden: true },
    [friendProfileKey({ name: "Gone", email: "gone@example.com" })]: { deletedAt: 5 }
  });
  const names = merged.map(friend => friend.name).sort();
  assert.deepEqual(names, ["A renamed"]);
  assert.equal(merged.find(friend => friend.name === "A renamed").hidden, true);
});

test("deleted-group map writes only missing ids and reads map keys", () => {
  const cloud = { g1: true };
  assert.deepEqual(diffDeletedGroupsMap(["g1"], cloud), {});
  assert.deepEqual(diffDeletedGroupsMap(["g1", "g2"], cloud), { g2: true });
  assert.deepEqual(deletedGroupsFromCloud(cloud), ["g1"]);
});
