import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DEMO_PROJECT = "demo-fairshare";
const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const skipReason = emulator ? false : "Run with: npm run test:rules";
const [host, portText] = (emulator || "127.0.0.1:8080").split(":");

const ALICE_RAW = "a.l.i.c.e@gmail.com";
const ALICE_KEY = "alice@gmail.com";
const BOB_RAW = "bob.smith@outlook.com";
const BOB_KEY = BOB_RAW;
const CAROL_RAW = "carol@example.com";
const CAROL_KEY = CAROL_RAW;

function pairDoc(keys = [ALICE_KEY, BOB_KEY], participants = keys, extra = {}) {
  return {
    pairId: "pair1",
    schemaVersion: 9,
    participantKeys: [...keys].sort(),
    participants: [...participants].sort(),
    transactions: [],
    deletedTransactions: [],
    updatedBy: ALICE_RAW,
    clientBuild: 97,
    clientWriteId: nextWriteId(),
    ...extra
  };
}

let writeSeq = 0;
function nextWriteId() {
  writeSeq += 1;
  return `w${String(writeSeq).padStart(8, "0")}`;
}
function stamped(data = {}) {
  return { ...data, clientBuild: 97, clientWriteId: nextWriteId() };
}

test("Firestore emulator rules", { skip: skipReason }, async (t) => {
  const { initializeTestEnvironment, assertFails, assertSucceeds } = await import("@firebase/rules-unit-testing");
  const {
    Timestamp,
    collection,
    collectionGroup,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    query,
    setDoc,
    updateDoc,
    where
  } = await import("firebase/firestore");

  const env = await initializeTestEnvironment({
    projectId: DEMO_PROJECT,
    firestore: { rules, host, port: Number(portText) }
  });
  t.after(async () => { await env.cleanup(); });

  const aliceDb = env.authenticatedContext("alice", { email: ALICE_RAW }).firestore();
  const bobDb = env.authenticatedContext("bob", { email: BOB_RAW }).firestore();
  const carolDb = env.authenticatedContext("carol", { email: CAROL_RAW }).firestore();
  const anonDb = env.unauthenticatedContext().firestore();

  const pairPath = ["direct_pairs", "pair1"];
  const pairRef = (db) => doc(db, ...pairPath);

  async function seed(path, data) {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), ...path), data);
    });
  }

  await t.test("participants can create, read, update, and list their pair", async () => {
    await env.clearFirestore();
    await assertSucceeds(setDoc(pairRef(aliceDb), pairDoc()));
    await assertSucceeds(getDoc(pairRef(aliceDb)));
    await assertSucceeds(getDoc(pairRef(bobDb)));
    await assertSucceeds(setDoc(pairRef(bobDb), pairDoc(undefined, undefined, {
      transactions: [{ id: "tx1", amount: 1000, timestamp: 1, updatedAt: 1 }]
    })));
    const listed = await assertSucceeds(getDocs(query(
      collection(aliceDb, "direct_pairs"),
      where("participantKeys", "array-contains", ALICE_KEY)
    )));
    assert.equal(listed.size, 1);
    const bobListed = await assertSucceeds(getDocs(query(
      collection(bobDb, "direct_pairs"),
      where("participantKeys", "array-contains", BOB_KEY)
    )));
    assert.equal(bobListed.size, 1);
    await assertFails(deleteDoc(pairRef(aliceDb)));
  });

  await t.test("creation requires matching canonical participants and the caller", async () => {
    await env.clearFirestore();
    await assertFails(setDoc(doc(aliceDb, "direct_pairs", "mismatch"), pairDoc(
      [ALICE_KEY, BOB_KEY],
      [ALICE_KEY, CAROL_KEY]
    )));
    await assertFails(setDoc(doc(aliceDb, "direct_pairs", "not-member"), pairDoc(
      [BOB_KEY, CAROL_KEY]
    )));
    await assertFails(setDoc(doc(anonDb, "direct_pairs", "anon"), pairDoc()));
  });

  await t.test("non-members cannot read, list, update, or delete a pair", async () => {
    await env.clearFirestore();
    await seed(pairPath, pairDoc());
    await assertFails(getDoc(pairRef(carolDb)));
    await assertFails(getDoc(pairRef(anonDb)));
    await assertFails(updateDoc(pairRef(carolDb), { updatedBy: CAROL_RAW }));
    await assertFails(deleteDoc(pairRef(carolDb)));
    await assertFails(getDocs(collection(carolDb, "direct_pairs")));
  });

  await t.test("membership is immutable after a pair is created", async () => {
    await env.clearFirestore();
    await seed(pairPath, pairDoc());

    await assertFails(setDoc(pairRef(bobDb), pairDoc([BOB_KEY, CAROL_KEY])));
    await assertFails(setDoc(pairRef(bobDb), pairDoc([ALICE_KEY, BOB_KEY, CAROL_KEY])));
    await assertFails(setDoc(pairRef(bobDb), pairDoc([ALICE_KEY, CAROL_KEY])));

    await assertSucceeds(setDoc(pairRef(bobDb), {
      ...pairDoc(),
      participantKeys: [BOB_KEY, ALICE_KEY],
      participants: [ALICE_KEY, BOB_KEY],
      transactions: [{ id: "tx2", amount: 2000, timestamp: 2, updatedAt: 2 }]
    }));
  });

  await t.test("legacy pairs migrate only without changing membership", async () => {
    const legacy = {
      pairId: "pair1",
      schemaVersion: 8,
      participants: [ALICE_RAW, BOB_KEY],
      transactions: [],
      deletedTransactions: [],
      updatedBy: ALICE_RAW
    };

    await env.clearFirestore();
    await seed(pairPath, legacy);
    await assertSucceeds(setDoc(pairRef(aliceDb), pairDoc(undefined, undefined, {
      transactions: [{ id: "migrated", amount: 3000, timestamp: 3, updatedAt: 3 }]
    })));

    await env.clearFirestore();
    await seed(pairPath, legacy);
    await assertSucceeds(setDoc(pairRef(bobDb), pairDoc(undefined, undefined, {
      updatedBy: BOB_RAW
    })));

    await env.clearFirestore();
    await seed(pairPath, legacy);
    await assertFails(setDoc(pairRef(bobDb), pairDoc([BOB_KEY, CAROL_KEY])));
  });

  await t.test("Gmail dots are canonicalized while non-Gmail dots are preserved", async () => {
    await env.clearFirestore();
    await assertSucceeds(setDoc(pairRef(aliceDb), pairDoc()));
    await assertSucceeds(getDoc(pairRef(aliceDb)));

    await env.clearFirestore();
    const wrongOutlookKey = "bobsmith@outlook.com";
    await assertSucceeds(setDoc(doc(aliceDb, "direct_pairs", "outlook-wrong"), pairDoc(
      [ALICE_KEY, wrongOutlookKey]
    )));
    await assertFails(getDoc(doc(bobDb, "direct_pairs", "outlook-wrong")));
    assert.notEqual(wrongOutlookKey, BOB_KEY);
  });

  await t.test("group permissions remain member-only and unchanged", async () => {
    const group = {
      id: "g1",
      name: "Test group",
      currency: "INR",
      members: ["Alice", "Bob"],
      memberUids: ["alice"],
      transactions: [],
      deletedTransactions: []
    };

    await env.clearFirestore();
    await seed(["groups", "g1"], group);
    await assertSucceeds(getDoc(doc(aliceDb, "groups", "g1")));
    await assertFails(getDoc(doc(bobDb, "groups", "g1")));
    await assertFails(getDocs(collection(bobDb, "groups")));
    await assertSucceeds(updateDoc(doc(aliceDb, "groups", "g1"), stamped({ name: "Renamed" })));
    await assertFails(updateDoc(doc(bobDb, "groups", "g1"), { name: "Nope" }));
    await assertFails(deleteDoc(doc(bobDb, "groups", "g1")));

    const listed = await assertSucceeds(getDocs(query(
      collection(aliceDb, "groups"),
      where("memberUids", "array-contains", "alice")
    )));
    assert.equal(listed.size, 1);

    await assertSucceeds(setDoc(doc(aliceDb, "groups", "g2"), stamped({
      ...group,
      id: "g2",
      name: "New group"
    })));
    await assertFails(setDoc(doc(aliceDb, "groups", "g3"), {
      ...group,
      id: "g3",
      name: "Not allowed",
      memberUids: ["bob"]
    }));
    await assertFails(deleteDoc(doc(aliceDb, "groups", "g2")));
  });

  await t.test("normalized group subcollections are member-only", async () => {
    const group = {
      id: "g1",
      name: "Test group",
      currency: "INR",
      members: ["Alice"],
      memberUids: ["alice"],
      transactions: [],
      deletedTransactions: []
    };
    const expense = {
      amountPaise: 1000,
      currency: "INR",
      payerMemberId: "email_alice_gmail_com",
      shares: { email_alice_gmail_com: 1000 },
      category: "Other",
      description: "Test",
      dateISO: "2026-10-28",
      createdBy: ALICE_RAW
    };
    await env.clearFirestore();
    await seed(["groups", "g1"], group);
    await assertSucceeds(setDoc(doc(aliceDb, "groups", "g1", "expenses", "expense_t1"), stamped(expense)));
    await assertFails(setDoc(doc(bobDb, "groups", "g1", "expenses", "expense_t2"), expense));
    await assertSucceeds(getDocs(collection(aliceDb, "groups", "g1", "expenses")));
    await assertFails(getDocs(collection(bobDb, "groups", "g1", "expenses")));
    await assertSucceeds(setDoc(doc(aliceDb, "groups", "g1", "members", "email_alice_gmail_com"), stamped({
      displayName: "Alice",
      emailCanonical: ALICE_KEY,
      role: "owner",
      status: "active"
    })));
    await assertFails(setDoc(doc(bobDb, "groups", "g1", "members", "email_bob_outlook_com"), {
      displayName: "Bob",
      emailCanonical: BOB_KEY,
      role: "member",
      status: "active"
    }));
    const found = await assertSucceeds(getDocs(query(
      collectionGroup(aliceDb, "members"),
      where("emailCanonical", "==", ALICE_KEY)
    )));
    assert.equal(found.size, 1);
    await assertFails(getDoc(doc(bobDb, "groups", "g1", "members", "email_alice_gmail_com")));
  });

  await t.test("invite acceptance adds the recipient UID", async () => {
    const token = "invite-token-0123456789";
    await env.clearFirestore();
    await seed(["groups", "g1"], {
      id: "g1",
      name: "Test group",
      currency: "INR",
      members: ["Alice"],
      memberUids: ["alice"],
      transactions: [],
      deletedTransactions: []
    });
    await seed(["invites", token], {
      type: "group",
      groupId: "g1",
      revoked: false,
      expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000)
    });
    await assertSucceeds(updateDoc(doc(bobDb, "groups", "g1"), stamped({
      memberUids: ["alice", "bob"],
      members: ["Alice", "Bob"],
      lastJoinToken: token,
      lastJoinAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      updatedBy: BOB_RAW
    })));
  });

  await t.test("a member added by email can claim their own UID", async () => {
    const memberId = "email_bob_outlook_com";
    await env.clearFirestore();
    await seed(["groups", "gclaim"], {
      id: "gclaim",
      name: "Claim group",
      currency: "INR",
      members: ["Alice", "Bob"],
      memberUids: ["alice"],
      transactions: [],
      deletedTransactions: []
    });
    await seed(["groups", "gclaim", "members", memberId], {
      displayName: "Bob",
      emailCanonical: BOB_KEY,
      role: "member",
      status: "active"
    });
    await assertFails(updateDoc(doc(bobDb, "groups", "gclaim"), stamped({
      memberUids: ["alice", "bob"],
      lastClaimMemberId: "email_alice_gmail_com",
      updatedAt: Timestamp.now(),
      updatedBy: BOB_RAW
    })));
    await assertSucceeds(updateDoc(doc(bobDb, "groups", "gclaim"), stamped({
      memberUids: ["alice", "bob"],
      lastClaimMemberId: memberId,
      updatedAt: Timestamp.now(),
      updatedBy: BOB_RAW
    })));
    await assertSucceeds(getDoc(doc(bobDb, "groups", "gclaim")));
    await assertSucceeds(setDoc(doc(bobDb, "groups", "gclaim", "members", memberId), stamped({ uid: "bob" })));
  });

  await t.test("group access accepts memberUids when the email list is absent", async () => {
    await env.clearFirestore();
    await seed(["groups", "guid"], {
      id: "guid",
      name: "UID group",
      currency: "INR",
      members: ["Bob"],
      memberUids: ["bob"],
      transactions: [],
      deletedTransactions: []
    });
    await assertSucceeds(getDoc(doc(bobDb, "groups", "guid")));
    await assertFails(getDoc(doc(aliceDb, "groups", "guid")));
    const listed = await assertSucceeds(getDocs(query(
      collection(bobDb, "groups"),
      where("memberUids", "array-contains", "bob")
    )));
    assert.equal(listed.size, 1);
    await assertSucceeds(updateDoc(doc(bobDb, "groups", "guid"), stamped({ name: "Renamed by Bob" })));
    await assertFails(updateDoc(doc(aliceDb, "groups", "guid"), stamped({ name: "Nope" })));
    await assertSucceeds(setDoc(doc(bobDb, "groups", "guid", "expenses", "expense_u1"), stamped({
      amountPaise: 500,
      payerMemberId: "email_bob_outlook_com",
      shares: { email_bob_outlook_com: 500 },
      category: "Other",
      description: "UID access",
      dateISO: "2026-11-05",
      createdBy: BOB_RAW
    })));
    await assertFails(getDocs(collection(aliceDb, "groups", "guid", "expenses")));
  });

  await t.test("stale clients without a fresh write stamp are rejected", async () => {
    await env.clearFirestore();
    const unstamped = {
      pairId: "pair1",
      schemaVersion: 9,
      participantKeys: [ALICE_KEY, BOB_KEY],
      participants: [ALICE_KEY, BOB_KEY],
      transactions: [],
      deletedTransactions: [],
      updatedBy: ALICE_RAW
    };
    await assertFails(setDoc(pairRef(aliceDb), unstamped));
    await assertSucceeds(setDoc(pairRef(aliceDb), pairDoc()));
    const existing = await assertSucceeds(getDoc(pairRef(aliceDb)));
    await assertFails(setDoc(pairRef(aliceDb), {
      ...pairDoc(),
      clientWriteId: existing.data().clientWriteId
    }));
    await assertSucceeds(setDoc(pairRef(aliceDb), pairDoc()));
  });
});
