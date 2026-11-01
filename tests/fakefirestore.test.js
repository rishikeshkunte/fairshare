import test from "node:test";
import assert from "node:assert/strict";
import { createWriteGuard } from "../js/writeguard.js";
import { createGuardedStore } from "../js/firebase.js";

/**
 * Minimal Firestore stand-in for guard tests. It deliberately reproduces the
 * behaviours that made production loops possible:
 *  - listeners fire for optimistic writes (hasPendingWrites) and again on ack
 *  - snapshots return map keys in a different order than they were written
 *  - every write, including an identical one, counts as a document mutation
 */
function createFakeFirestore() {
  const docs = new Map();
  const listeners = new Map();
  const counters = { writes: 0, emits: 0, pendingEmits: 0 };

  function emit(path, pending) {
    counters.emits += 1;
    if (pending) counters.pendingEmits += 1;
    const doc = docs.get(path);
    const snap = {
      exists: () => Boolean(doc),
      data: () => {
        if (!doc) return {};
        const ordered = {};
        Object.keys(doc).sort().reverse().forEach(key => { ordered[key] = doc[key]; });
        return ordered;
      },
      metadata: { hasPendingWrites: pending, fromCache: false }
    };
    for (const entry of listeners.get(path) || []) {
      try { entry.onNext(snap); } catch { /* test callbacks must not break delivery */ }
    }
  }

  function write(ref, data, opts) {
    const previous = docs.get(ref.path) || {};
    docs.set(ref.path, opts && opts.merge ? { ...previous, ...data } : { ...data });
    counters.writes += 1;
    emit(ref.path, true);
    queueMicrotask(() => emit(ref.path, false));
  }

  const api = {
    counters,
    docs,
    doc(_db, path, id) { return { path: `${path}/${id}` }; },
    collection(_db, path) { return { path, id: null }; },
    query(target) { return target; },
    where() { return {}; },
    serverTimestamp() { return { __serverTimestamp: true }; },
    setDoc(ref, data, opts) { write(ref, data, opts); return Promise.resolve(); },
    updateDoc(ref, data) { write(ref, data, { merge: true }); return Promise.resolve(); },
    deleteDoc(ref) {
      docs.delete(ref.path);
      counters.writes += 1;
      queueMicrotask(() => emit(ref.path, false));
      return Promise.resolve();
    },
    getDoc(ref) {
      return Promise.resolve({ exists: () => docs.has(ref.path), data: () => docs.get(ref.path) || {} });
    },
    getDocs(target) {
      const prefix = `${target.path}/`;
      const found = [...docs.entries()].filter(([path]) => path.startsWith(prefix));
      return Promise.resolve({ size: found.length, docs: found.map(([path, data]) => ({ id: path.slice(prefix.length), data: () => data })) });
    },
    writeBatch() {
      const ops = [];
      return {
        set(ref, data, opts) { ops.push({ ref, data, opts }); return this; },
        update(ref, data) { ops.push({ ref, data, opts: { merge: true } }); return this; },
        delete(ref) { ops.push({ ref, data: null, opts: null }); return this; },
        commit() {
          ops.forEach(op => {
            if (op.data === null) {
              docs.delete(op.ref.path);
              counters.writes += 1;
              queueMicrotask(() => emit(op.ref.path, false));
              return;
            }
            write(op.ref, op.data, op.opts);
          });
          return Promise.resolve();
        }
      };
    },
    runTransaction(_db, updateFunction) {
      const transaction = {
        get(ref) {
          return Promise.resolve({ exists: () => docs.has(ref.path), data: () => docs.get(ref.path) || {} });
        },
        set(ref, data, opts) { write(ref, data, opts); return transaction; },
        update(ref, data) { write(ref, data, { merge: true }); return transaction; },
        delete(ref) { api.deleteDoc(ref); return transaction; }
      };
      return Promise.resolve(updateFunction(transaction)).then(() => undefined);
    },
    onSnapshot(target, options, onNext, onError) {
      const entry = { onNext, onError };
      if (!listeners.has(target.path)) listeners.set(target.path, new Set());
      listeners.get(target.path).add(entry);
      queueMicrotask(() => emit(target.path, false));
      return () => {
        listeners.get(target.path)?.delete(entry);
        return Promise.resolve();
      };
    }
  };

  return api;
}

const flush = async (ticks = 6) => {
  for (let index = 0; index < ticks; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

test("an idle pair of clients never writes, even when listeners try to write back", async () => {
  const backend = createFakeFirestore();
  const clientA = createGuardedStore(backend, createWriteGuard());
  const clientB = createGuardedStore(backend, createWriteGuard());
  const profile = backend.doc(null, "user_profiles", "uidA");
  backend.docs.set(profile.path, { friends: [{ email: "a@example.test", name: "A" }], deletedGroups: [] });

  clientA.setDoc(profile, { friends: [{ email: "a@example.test", name: "A" }], updatedAt: 1 }, { merge: true });
  await flush();
  const baseline = backend.counters.writes;

  let writeBacks = 0;
  const writeBack = (client) => (snap) => {
    const data = snap.data();
    writeBacks += 1;
    client.setDoc(profile, { friends: data.friends, updatedAt: Date.now() }, { merge: true });
  };
  clientA.onSnapshot(profile, writeBack(clientA), () => {});
  clientB.onSnapshot(profile, writeBack(clientB), () => {});
  await flush(10);

  assert.equal(backend.counters.writes, baseline, "listener callbacks must not produce writes");
  assert.ok(writeBacks > 0, "listeners did run");
});

test("optimistic echoes are skipped but the acknowledgement is delivered", async () => {
  const backend = createFakeFirestore();
  const guard = createWriteGuard();
  const client = createGuardedStore(backend, guard);
  const ref = backend.doc(null, "groups", "g1");
  const seen = [];
  client.onSnapshot(ref, snap => seen.push(snap.metadata.hasPendingWrites), () => {});
  await flush();
  assert.deepEqual(seen, [false], "initial snapshot only");

  client.setDoc(ref, { name: "G" }, { merge: true });
  await flush();
  assert.deepEqual(seen, [false, false], "pending echo dropped, ack delivered");
  assert.equal(guard.stats().blockedFromSnapshot, 0);
});

test("batches count documents against the document budget", async () => {
  const backend = createFakeFirestore();
  const guard = createWriteGuard({ maxCalls: 100, maxDocs: 10 });
  const client = createGuardedStore(backend, guard);
  const batch = client.writeBatch(null);
  for (let index = 0; index < 20; index += 1) {
    batch.set(backend.doc(null, "groups", `g${index}`), { name: `G${index}` }, { merge: true });
  }
  await batch.commit();
  await flush();
  assert.equal(backend.counters.writes, 0, "over-budget batch must not commit");
  assert.equal(guard.stats().paused, true);
});

test("call budget pauses then resumes after the cooldown", async () => {
  const backend = createFakeFirestore();
  const guard = createWriteGuard({ maxCalls: 2, maxDocs: 1000, pauseMs: 5000 });
  const client = createGuardedStore(backend, guard);
  client.setDoc(backend.doc(null, "groups", "a"), { n: 1 }, { merge: true });
  client.setDoc(backend.doc(null, "groups", "b"), { n: 2 }, { merge: true });
  client.setDoc(backend.doc(null, "groups", "c"), { n: 3 }, { merge: true });
  await flush();
  assert.equal(backend.counters.writes, 2, "third call is over budget");
  assert.equal(guard.stats().paused, true);

  guard.resume();
  client.setDoc(backend.doc(null, "groups", "c"), { n: 3 }, { merge: true });
  await flush();
  assert.equal(backend.counters.writes, 3, "resume allows writes again");
});
