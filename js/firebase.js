const VERSION = "10.12.5";
const base = `https://www.gstatic.com/firebasejs/${VERSION}`;

let loaded = null;

export function cloudIntent() {
  try { return localStorage.getItem("fairshare_cloud") === "1"; } catch { return false; }
}

export function setCloudIntent(on) {
  try { localStorage.setItem("fairshare_cloud", on ? "1" : "0"); } catch { /* ignore */ }
}

export function loadFirebase(config) {
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
    return { app, auth, db, authMod, storeMod, storageMod, storage };
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
