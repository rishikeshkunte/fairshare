import { createWriteGuard } from "./writeguard.js";

const VERSION = "10.12.5";
const base = `https://www.gstatic.com/firebasejs/${VERSION}`;

let loaded = null;

export function cloudIntent() {
  try { return localStorage.getItem("fairshare_cloud") === "1"; } catch { return false; }
}

export function setCloudIntent(on) {
  try { localStorage.setItem("fairshare_cloud", on ? "1" : "0"); } catch { /* ignore */ }
}

/**
 * Every remote write goes through the guard, and every snapshot callback runs
 * inside it. A listener therefore cannot write, no matter which module it is
 * in: the write is refused and counted as blockedFromSnapshot.
 */
export function createGuardedStore(raw, writeGuard, options = {}) {
  const guarded = { ...raw };
  const clientBuild = Number(options.clientBuild) || 0;

  // Every write is stamped with this build and a fresh per-write id. Firestore
  // rules require the id to change on updates, which an old cached client
  // cannot produce, so its writes are rejected server-side.
  function stamp(data) {
    if (!clientBuild || !data || typeof data !== "object" || Array.isArray(data)) return data;
    return {
      ...data,
      clientBuild,
      clientWriteId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    };
  }

  function guardTransaction(tx) {
    return new Proxy(tx, {
      get(target, prop) {
        if (prop === "set") return (ref, data, opts) => target.set(ref, stamp(data), opts);
        if (prop === "update") return (ref, data) => target.update(ref, stamp(data));
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }

  function watchDenied(promise) {
    if (options.onWriteDenied && promise && typeof promise.catch === "function") {
      return promise.catch((err) => {
        if (err && err.code === "permission-denied") {
          try { options.onWriteDenied(err); } catch { /* ignore */ }
        }
        throw err;
      });
    }
    return promise;
  }

  guarded.setDoc = (ref, data, opts, meta) => {
    if (!writeGuard.allow({ label: (meta && meta.label) || "setDoc", docs: 1 })) return Promise.resolve();
    return watchDenied(raw.setDoc(ref, stamp(data), opts));
  };
  guarded.updateDoc = (ref, data, meta) => {
    if (!writeGuard.allow({ label: (meta && meta.label) || "updateDoc", docs: 1 })) return Promise.resolve();
    return watchDenied(raw.updateDoc(ref, stamp(data)));
  };
  guarded.deleteDoc = (ref, meta) => {
    if (!writeGuard.allow({ label: (meta && meta.label) || "deleteDoc", docs: 1 })) return Promise.resolve();
    return raw.deleteDoc(ref);
  };
  guarded.runTransaction = (db, updateFunction, meta) => {
    if (!writeGuard.allow({ label: (meta && meta.label) || "transaction", docs: 1 })) return Promise.resolve(null);
    return watchDenied(raw.runTransaction(db, (tx) => updateFunction(guardTransaction(tx))));
  };
  guarded.writeBatch = (db, meta) => {
    const label = (meta && meta.label) || "batch";
    const batch = raw.writeBatch(db);
    let docs = 0;
    return {
      set(ref, data, opts) { docs += 1; return batch.set(ref, stamp(data), opts); },
      update(ref, data) { docs += 1; return batch.update(ref, stamp(data)); },
      delete(ref) { docs += 1; return batch.delete(ref); },
      commit() {
        if (!writeGuard.allow({ label, docs: Math.max(1, docs) })) return Promise.resolve();
        return watchDenied(batch.commit());
      }
    };
  };
  // Request metadata changes so the acknowledgement of a local write is still
  // delivered after we skip its optimistic echo. Without this, a remote change
  // batched into the optimistic snapshot could be missed.
  guarded.onSnapshot = (target, onNext, onError) => raw.onSnapshot(target, { includeMetadataChanges: true }, (snap) => {
    if (snap && snap.metadata && snap.metadata.hasPendingWrites) return;
    writeGuard.withHydration(() => onNext(snap));
  }, onError);

  return guarded;
}

export function loadFirebase(config, options = {}) {
  if (loaded) return loaded;
  loaded = (async () => {
    const [{ initializeApp }, authMod, storeMod, storageMod] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-firestore.js`),
      import(`${base}/firebase-storage.js`)
    ]);
    const app = initializeApp(config);
    const auth = authMod.getAuth(app);
    const db = storeMod.getFirestore(app);
    const storage = storageMod.getStorage(app);
    const writeGuard = createWriteGuard();
    return { app, auth, db, authMod, storeMod: createGuardedStore(storeMod, writeGuard, options), storageMod, storage, writeGuard };
  })().catch((err) => {
    loaded = null;
    throw err;
  });
  return loaded;
}

export function watchAuth(fx, callback) {
  return fx.authMod.onAuthStateChanged(fx.auth, callback);
}

export function signInGoogle(fx) {
  const provider = new fx.authMod.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  // Popup auth avoids redirect cookie/state persisting across deployments and
  // works with Firebase's stable registered auth handler on mobile as well.
  return fx.authMod.signInWithPopup(fx.auth, provider);
}

export function finishRedirectSignIn(fx) {
  if (!fx?.authMod?.getRedirectResult) return Promise.resolve(null);
  return fx.authMod.getRedirectResult(fx.auth);
}

export function signOutGoogle(fx) {
  return fx.authMod.signOut(fx.auth);
}

export function serverTimestamp(fx) {
  return fx.storeMod.serverTimestamp();
}

export function watchQuery(fx, path, field, op, value, onNext, onError) {
  const q = fx.storeMod.query(fx.storeMod.collection(fx.db, path), fx.storeMod.where(field, op, value));
  return fx.storeMod.onSnapshot(q, onNext, onError);
}

export function watchDoc(fx, path, id, onNext, onError) {
  return fx.storeMod.onSnapshot(fx.storeMod.doc(fx.db, path, id), onNext, onError);
}

export function setMerge(fx, path, id, data) {
  return fx.storeMod.setDoc(fx.storeMod.doc(fx.db, path, id), data, { merge: true });
}

export function runTransaction(fx, updateFunction) {
  return fx.storeMod.runTransaction(fx.db, updateFunction);
}

export async function uploadReceipt(fx, path, dataUrl) {
  const ref = fx.storageMod.ref(fx.storage, path);
  await fx.storageMod.uploadString(ref, dataUrl, "data_url");
  const url = await fx.storageMod.getDownloadURL(ref);
  return { url, path };
}
