import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";

const root = fileURLToPath(new URL("../..", import.meta.url));
const APP_URL = "http://127.0.0.1:4173/app/";
const FIREBASE_VERSION = "10.12.5";
const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
const CHROME_PATH = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const adminApp = initializeApp({ projectId: "demo-fairshare" });
const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function startStaticServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      let path = decodeURIComponent(url.pathname);
      if (path === "/" || path === "/app" || path === "/app/") path = "/index.html";
      else if (path.startsWith("/app/")) path = path.slice("/app".length);
      else {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const filePath = normalize(join(root, path));
      if (!filePath.startsWith(root.endsWith(sep) ? root : root + sep)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      let body = await readFile(filePath);
      if (path === "/index.html") {
        body = Buffer.from(body.toString("utf8").replace(
          'projectId: "fairshare-app-ba160"',
          'projectId: "demo-fairshare"'
        ));
      }
      res.writeHead(200, {
        "content-type": types[extname(filePath)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(4173, "127.0.0.1", () => resolve(server)));
}

function routeableFirebaseModule() {
  return async (route) => {
    const file = join(root, "js", "firebase.js");
    const source = await readFile(file, "utf8");
    const marker = "const db = storeMod.getFirestore(app);";
    if (!source.includes(marker)) throw new Error("firebase.js emulator hook marker missing");
    const body = source.replace(marker, `${marker}
    authMod.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    storeMod.connectFirestoreEmulator(db, "127.0.0.1", 8080);`);
    await route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body });
  };
}

async function openAccount(browser, label, url = APP_URL) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block"
  });
  await context.route("**/js/firebase.js", routeableFirebaseModule());
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      console.log(`[${label}]`, message.type(), message.text());
    }
  });
  page.on("pageerror", (error) => console.log(`[${label}] pageerror`, error.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.FAIRSHARE_BUILD), null, { timeout: 20000 });
  await page.waitForFunction(async () => {
    try {
      const appMod = await import(`${FIREBASE_BASE}/firebase-app.js`);
      appMod.getApp();
      return true;
    } catch {
      return false;
    }
  }, null, { timeout: 30000 });
  return { context, page };
}

async function waitForFirebaseApp(page) {
  await page.waitForFunction(async (base) => {
    try {
      const appMod = await import(`${base}/firebase-app.js`);
      appMod.getApp();
      return true;
    } catch {
      return false;
    }
  }, FIREBASE_BASE, { timeout: 30000 });
}

async function signIn(page, email, password) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForFirebaseApp(page);
    try {
      await page.evaluate(async ({ email, password, base }) => {
        const appMod = await import(`${base}/firebase-app.js`);
        const authMod = await import(`${base}/firebase-auth.js`);
        await authMod.signInWithEmailAndPassword(authMod.getAuth(appMod.getApp()), email, password);
      }, { email, password, base: FIREBASE_BASE });
      await page.waitForFunction(() => {
        const shell = document.getElementById("app-shell");
        return shell && !shell.hidden;
      }, null, { timeout: 20000 });
      return;
    } catch (error) {
      if (attempt === 1 || !String(error?.message || "").includes("app/no-app")) throw error;
      await page.waitForTimeout(500);
    }
  }
}

async function showGroups(page) {
  await page.evaluate(() => window.navigateTo("groups"));
}

async function waitForGroupChip(page, name, visible, timeout = 20000) {
  await page.waitForFunction(({ name, visible }) => {
    const chips = Array.from(document.querySelectorAll(".group-chip"));
    const found = chips.some((chip) => chip.textContent.includes(name));
    return visible ? found : !found;
  }, { name, visible }, { timeout });
}

async function cachedGroupIds(page, uid) {
  return page.evaluate((uid) => {
    let state = {};
    try { state = JSON.parse(localStorage.getItem(`fairshare_state_v9:${uid}`) || "{}"); } catch { /* ignore */ }
    return Object.keys(state.groups || {});
  }, uid);
}

async function serverReadDenied(page, groupId) {
  return page.evaluate(async ({ groupId, base }) => {
    const appMod = await import(`${base}/firebase-app.js`);
    const storeMod = await import(`${base}/firebase-firestore.js`);
    try {
      await storeMod.getDocFromServer(storeMod.doc(storeMod.getFirestore(appMod.getApp()), "groups", groupId));
      return false;
    } catch (error) {
      return String(error?.code || error?.message || "").includes("permission-denied");
    }
  }, { groupId, base: FIREBASE_BASE });
}

function memberIdForEmail(email) {
  const slug = String(email).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `email_${slug}`;
}

async function seedGroup({ groupId, name, alice, bob, includeBobUid, includeBobMemberDoc, includeExpense }) {
  const bobMemberId = memberIdForEmail(bob.email);
  await adminDb.doc(`groups/${groupId}`).set({
    id: groupId,
    name,
    currency: "INR",
    ownerUid: alice.uid,
    ownerEmail: alice.email,
    members: includeBobUid ? ["Alice E2E", "Bob E2E"] : ["Alice E2E", "Bob E2E"],
    memberLinks: { "Alice E2E": alice.email, "Bob E2E": bob.email },
    memberUids: includeBobUid ? [alice.uid, bob.uid] : [alice.uid],
    normalizedVersion: 1,
    simplifyDebts: true,
    transactions: [],
    deletedTransactions: [],
    createdAt: Date.now()
  });
  await adminDb.doc(`groups/${groupId}/members/uid_${alice.uid}`).set({
    displayName: "Alice E2E",
    emailCanonical: alice.email.toLowerCase(),
    uid: alice.uid,
    role: "owner",
    status: "active"
  });
  if (includeBobMemberDoc) {
    await adminDb.doc(`groups/${groupId}/members/${bobMemberId}`).set({
      displayName: "Bob E2E",
      emailCanonical: bob.email.toLowerCase(),
      uid: includeBobUid ? bob.uid : null,
      role: "member",
      status: "active"
    });
  }
  if (includeExpense) {
    await adminDb.doc(`groups/${groupId}/expenses/expense_seed`).set({
      amountPaise: 1000,
      payerMemberId: `uid_${alice.uid}`,
      shares: { [`uid_${alice.uid}`]: 500, [bobMemberId]: 500 },
      category: "Other",
      description: "Seed expense",
      dateISO: "2026-11-13",
      createdBy: alice.email
    });
  }
  return { bobMemberId };
}

async function run() {
  const runId = Date.now().toString(36);
  const password = "E2ePassw0rd!";
  const aliceEmail = `alice.${runId}@example.com`;
  const bobEmail = `bob.${runId}@example.com`;
  const alice = await adminAuth.createUser({ email: aliceEmail, password, emailVerified: true, displayName: "Alice E2E" });
  const bob = await adminAuth.createUser({ email: bobEmail, password, emailVerified: true, displayName: "Bob E2E" });

  const groupId = `e2e_group_${runId}`;
  const groupName = `E2E Group ${runId}`;
  const { bobMemberId } = await seedGroup({
    groupId,
    name: groupName,
    alice,
    bob,
    includeBobUid: true,
    includeBobMemberDoc: true,
    includeExpense: true
  });

  const server = await startStaticServer();
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const aliceSession = await openAccount(browser, "alice");
    const bobSession = await openAccount(browser, "bob");
    await signIn(aliceSession.page, aliceEmail, password);
    await signIn(bobSession.page, bobEmail, password);
    await showGroups(aliceSession.page);
    await showGroups(bobSession.page);
    await waitForGroupChip(aliceSession.page, groupName, true);
    await waitForGroupChip(bobSession.page, groupName, true);
    console.log("PASS discovery: both accounts see the shared group");

    await adminDb.doc(`groups/${groupId}/members/${bobMemberId}`).set({
      status: "removed",
      emailCanonical: "",
      removedAt: Date.now()
    }, { merge: true });
    await adminDb.doc(`groups/${groupId}`).update({
      members: ["Alice E2E"],
      memberUids: [alice.uid],
      updatedAt: Date.now(),
      updatedBy: aliceEmail
    });

    await waitForGroupChip(bobSession.page, groupName, false);
    const afterRemoval = await cachedGroupIds(bobSession.page, bob.uid);
    if (afterRemoval.includes(groupId)) throw new Error("revoked group still in Bob's local cache");
    console.log("PASS removal: Bob's group disappeared and the cache was pruned");

    if (!(await serverReadDenied(bobSession.page, groupId))) {
      throw new Error("Bob could still read the revoked group from the server");
    }
    console.log("PASS authorization: Bob's server read is denied");

    await bobSession.page.reload({ waitUntil: "domcontentloaded" });
    await bobSession.page.waitForFunction(() => {
      const shell = document.getElementById("app-shell");
      return shell && !shell.hidden;
    }, null, { timeout: 20000 });
    await showGroups(bobSession.page);
    await bobSession.page.waitForTimeout(1000);
    const afterReload = await cachedGroupIds(bobSession.page, bob.uid);
    if (afterReload.includes(groupId)) throw new Error("revoked group returned after reload");
    await waitForGroupChip(bobSession.page, groupName, false);
    console.log("PASS reload: the pruned group stayed gone");

    await adminDb.doc(`groups/${groupId}`).update({
      members: ["Alice E2E", "Bob E2E"],
      memberUids: [alice.uid, bob.uid],
      updatedAt: Date.now(),
      updatedBy: aliceEmail
    });
    await waitForGroupChip(bobSession.page, groupName, true);
    console.log("PASS re-invite: Bob rediscovered the group without a tombstone");

    const claimGroupId = `e2e_claim_${runId}`;
    const claimGroupName = `E2E Claim ${runId}`;
    await seedGroup({
      groupId: claimGroupId,
      name: claimGroupName,
      alice,
      bob,
      includeBobUid: false,
      includeBobMemberDoc: true,
      includeExpense: true
    });
    await waitForGroupChip(bobSession.page, claimGroupName, true);
    const claimed = await adminDb.doc(`groups/${claimGroupId}`).get();
    if (!Array.isArray(claimed.data().memberUids) || !claimed.data().memberUids.includes(bob.uid)) {
      throw new Error("add-by-email claim did not add Bob's UID");
    }
    console.log("PASS claim: add-by-email membership was claimed and the group appeared");

    const carolEmail = `carol.${runId}@example.com`;
    const carol = await adminAuth.createUser({ email: carolEmail, password, emailVerified: true, displayName: "Carol E2E" });
    const carolSession = await openAccount(browser, "carol", `${APP_URL}?intent=split&amount=1200&people=4`);
    await signIn(carolSession.page, carolEmail, password);
    await carolSession.page.waitForFunction(() => window.location.hash === "#add-expense", null, { timeout: 20000 });
    await carolSession.page.waitForFunction(
      () => document.getElementById("amount")?.value === "1200.00",
      null,
      { timeout: 10000 }
    );
    const carolState = await carolSession.page.evaluate((uid) => {
      try { return JSON.parse(localStorage.getItem(`fairshare_state_v9:${uid}`) || "{}"); } catch { return {}; }
    }, carol.uid);
    const starterGroups = Object.values(carolState.groups || {});
    if (!starterGroups.some((group) => group.name === "My first split")) {
      throw new Error("split intent did not create the starter group");
    }
    console.log("PASS intent: demo values became a starter group and a prefilled expense");
    await carolSession.context.close();

    await aliceSession.context.close();
    await bobSession.context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await deleteApp(adminApp);
  }
}

run().catch((error) => {
  console.error("E2E FAILED:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
