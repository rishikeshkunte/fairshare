import test from "node:test";
import assert from "node:assert/strict";
import { isActiveMembershipDoc, memberDocumentMatchesRemoval, missingGroupAction } from "../js/membership.js";

test("retired or email-less membership documents are not active", () => {
  assert.equal(isActiveMembershipDoc({ status: "active", emailCanonical: "a@b.com" }), true);
  assert.equal(isActiveMembershipDoc({ emailCanonical: "a@b.com" }), true);
  assert.equal(isActiveMembershipDoc({ status: "removed", emailCanonical: "a@b.com" }), false);
  assert.equal(isActiveMembershipDoc({ status: "active", emailCanonical: "" }), false);
  assert.equal(isActiveMembershipDoc(null), false);
});

test("removal matching follows UID, canonical Gmail, then name-only documents", () => {
  const doc = { status: "active", uid: "uid_b", emailCanonical: "bob@gmail.com", displayName: "Bob" };
  assert.equal(memberDocumentMatchesRemoval(doc, { uid: "uid_b" }), true);
  assert.equal(memberDocumentMatchesRemoval(doc, { email: "b.ob@gmail.com" }), true);
  assert.equal(memberDocumentMatchesRemoval(doc, { name: "someone else" }), false);
  assert.equal(memberDocumentMatchesRemoval(
    { status: "removed", emailCanonical: "bob@gmail.com" },
    { email: "bob@gmail.com" }
  ), false);
  assert.equal(memberDocumentMatchesRemoval(
    { status: "active", emailCanonical: "", displayName: "Bob" },
    { name: "Bob" }
  ), true);
  assert.equal(memberDocumentMatchesRemoval(
    { status: "active", emailCanonical: "other@gmail.com", displayName: "Bob" },
    { name: "Bob" }
  ), false, "a linked account with the same display name is not retired by name");
});

test("missing groups stay when local-only, offline, or still a member", () => {
  assert.equal(missingGroupAction({ error: "unavailable" }), "keep");
  assert.equal(missingGroupAction({ error: "deadline-exceeded" }), "keep");
  assert.equal(missingGroupAction({ exists: false }), "keep");
  assert.equal(missingGroupAction({ exists: true, data: { memberUids: ["uid_a"] }, uid: "uid_a" }), "keep");
});

test("missing groups are pruned on denial or a non-member document", () => {
  assert.equal(missingGroupAction({ error: "permission-denied" }), "prune");
  assert.equal(missingGroupAction({ exists: true, data: { memberUids: ["uid_a"] }, uid: "uid_b" }), "prune");
  assert.equal(missingGroupAction({ exists: true, data: {}, uid: "uid_a" }), "prune");
  assert.equal(missingGroupAction({ exists: true, data: { deletedAt: 123, memberUids: [] }, uid: "uid_b" }), "tombstone");
});
