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
    ...extra
  };
}

test("Firestore emulator rules", { skip: skipReason }, async (t) => {
  const { initializeTestEnvironment, assertFails, assertSucceeds } = await import("@firebase/rules-unit-testing");
  const {
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
    await assertSucceeds(deleteDoc(pairRef(aliceDb)));
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
      memberEmails: [ALICE_RAW],
      transactions: [],
      deletedTransactions: []
    };

    await env.clearFirestore();
    await seed(["groups", "g1"], group);
    await assertSucceeds(getDoc(doc(aliceDb, "groups", "g1")));
    await assertFails(getDoc(doc(bobDb, "groups", "g1")));
    await assertFails(getDocs(collection(bobDb, "groups")));
    await assertSucceeds(updateDoc(doc(aliceDb, "groups", "g1"), { name: "Renamed" }));
    await assertFails(updateDoc(doc(bobDb, "groups", "g1"), { name: "Nope" }));
    await assertFails(deleteDoc(doc(bobDb, "groups", "g1")));

    const listed = await assertSucceeds(getDocs(query(
      collection(aliceDb, "groups"),
      where("memberEmails", "array-contains", ALICE_RAW)
    )));
    assert.equal(listed.size, 1);

    await assertSucceeds(setDoc(doc(aliceDb, "groups", "g2"), {
      ...group,
      id: "g2",
      name: "New group"
    }));
    await assertFails(setDoc(doc(aliceDb, "groups", "g3"), {
      ...group,
      id: "g3",
      name: "Not allowed",
      memberEmails: [BOB_RAW]
    }));
    await assertSucceeds(deleteDoc(doc(aliceDb, "groups", "g2")));
  });

  await t.test("normalized group subcollections are member-only", async () => {
    const group = {
      id: "g1",
      name: "Test group",
      currency: "INR",
      members: ["Alice"],
      memberEmails: [ALICE_RAW],
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
    await assertSucceeds(setDoc(doc(aliceDb, "groups", "g1", "expenses", "expense_t1"), expense));
    await assertFails(setDoc(doc(bobDb, "groups", "g1", "expenses", "expense_t2"), expense));
    await assertSucceeds(getDocs(collection(aliceDb, "groups", "g1", "expenses")));
    await assertFails(getDocs(collection(bobDb, "groups", "g1", "expenses")));
    await assertSucceeds(setDoc(doc(aliceDb, "groups", "g1", "members", "email_alice_gmail_com"), {
      displayName: "Alice",
      emailCanonical: ALICE_KEY,
      role: "owner",
      status: "active"
    }));
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
});
