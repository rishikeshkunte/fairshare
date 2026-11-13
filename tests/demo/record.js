import http from "node:http";
import { copyFile, readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";

const root = fileURLToPath(new URL("../..", import.meta.url));
const outDir = join(root, "assets");
const videoDir = join(root, "assets", ".recordings");
const APP_URL = "http://127.0.0.1:4180/app/";
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
  ".webm": "video/webm",
  ".svg": "image/svg+xml"
};

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const base = join(process.env.LOCALAPPDATA || "", "ms-playwright");
  try {
    const folder = readdirSync(base).find((name) => name.startsWith("ffmpeg-"));
    if (!folder) return "";
    return [join(base, folder, "ffmpeg-win64.exe"), join(base, folder, "ffmpeg.exe")]
      .find((candidate) => existsSync(candidate)) || "";
  } catch {
    return "";
  }
}

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
      if (!filePath.toLowerCase().startsWith((root.endsWith(sep) ? root : root + sep).toLowerCase())) {
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
  return new Promise((resolve) => server.listen(4180, "127.0.0.1", () => resolve(server)));
}

async function routeFirebase(route) {
  const source = await readFile(join(root, "js", "firebase.js"), "utf8");
  const marker = "const db = storeMod.getFirestore(app);";
  if (!source.includes(marker)) throw new Error("firebase.js emulator hook marker missing");
  const body = source.replace(marker, `${marker}
    authMod.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    storeMod.connectFirestoreEmulator(db, "127.0.0.1", 8080);`);
  await route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body });
}

async function signIn(page, email, password) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForFunction(async (base) => {
      try {
        const appMod = await import(`${base}/firebase-app.js`);
        appMod.getApp();
        return true;
      } catch {
        return false;
      }
    }, FIREBASE_BASE, { timeout: 30000 });
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
      if (attempt === 2 || !String(error?.message || "").includes("app/no-app")) throw error;
      await page.waitForTimeout(500);
    }
  }
}

async function seedDemo(user) {
  const groupId = "demo_goa";
  const groupName = "Goa Trip";
  const demoEmail = user.email.toLowerCase();
  const people = [
    { name: "Rhea", email: demoEmail, uid: user.uid },
    { name: "Aryan", email: "aryan@example.com", uid: "" },
    { name: "Poorva", email: "poorva@example.com", uid: "" },
    { name: "Shivam", email: "shivam@example.com", uid: "" }
  ];
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const memberId = (person) => person.uid ? `uid_${person.uid}` : `email_${slug(person.email)}`;
  const memberLinks = {};
  const members = [];
  people.forEach((person) => {
    members.push(person.name);
    memberLinks[person.name] = person.email;
  });

  await adminDb.doc(`groups/${groupId}`).set({
    id: groupId,
    name: groupName,
    currency: "â‚¹",
    ownerUid: user.uid,
    ownerEmail: demoEmail,
    members,
    memberLinks,
    memberUids: [user.uid],
    normalizedVersion: 1,
    simplifyDebts: true,
    transactions: [],
    deletedTransactions: [],
    createdAt: Date.now()
  });
  for (const person of people) {
    await adminDb.doc(`groups/${groupId}/members/${memberId(person)}`).set({
      displayName: person.name,
      emailCanonical: person.email.toLowerCase(),
      uid: person.uid || null,
      role: person.uid ? "owner" : "member",
      status: "active"
    });
  }
  const byName = Object.fromEntries(people.map((person) => [person.name, memberId(person)]));
  const expenses = [
    { id: "expense_dinner", payer: "Aryan", amount: 360000, desc: "Dinner at Thalassa", category: "Food", shares: { Rhea: 90000, Aryan: 90000, Poorva: 90000, Shivam: 90000 } },
    { id: "expense_cab", payer: "Rhea", amount: 120000, desc: "Airport cab", category: "Transport", shares: { Rhea: 30000, Aryan: 30000, Poorva: 30000, Shivam: 30000 } },
    { id: "expense_groceries", payer: "Rhea", amount: 80000, desc: "Villa groceries", category: "Groceries", shares: { Rhea: 20000, Aryan: 20000, Poorva: 20000, Shivam: 20000 } }
  ];
  for (const expense of expenses) {
    const shares = {};
    for (const [name, amount] of Object.entries(expense.shares)) shares[byName[name]] = amount;
    await adminDb.doc(`groups/${groupId}/expenses/${expense.id}`).set({
      amountPaise: expense.amount,
      payerMemberId: byName[expense.payer],
      shares,
      category: expense.category,
      description: expense.desc,
      dateISO: "2026-11-12",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null
    });
  }
  await adminDb.doc(`user_profiles/${user.uid}`).set({
    emojiChoices: {
      people: { rhea: "ðŸ˜Ž", aryan: "ðŸ¦Š", poorva: "ðŸ¼", shivam: "ðŸ¦" },
      groups: { [groupId]: "ðŸ–ï¸" }
    },
    updatedAt: Date.now()
  }, { merge: true });
  return { groupId, groupName };
}

async function run() {
  const email = `rhea.demo.${Date.now().toString(36)}@example.com`;
  const password = "DemoPassw0rd!";
  const user = await adminAuth.createUser({ email, password, emailVerified: true, displayName: "Rhea" });
  const { groupName } = await seedDemo(user);

  const server = await startStaticServer();
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const prepContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block"
    });
    await prepContext.route("**/js/firebase.js", routeFirebase);
    const prepPage = await prepContext.newPage();
    prepPage.on("pageerror", (error) => console.log("[prep] pageerror", error.message));
    await prepPage.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await signIn(prepPage, email, password);
    await prepPage.evaluate(() => window.navigateTo("groups"));
    await prepPage.waitForFunction((name) => {
      const chips = Array.from(document.querySelectorAll(".group-chip"));
      return chips.some((chip) => chip.textContent.includes(name));
    }, groupName, { timeout: 20000 });
    await prepPage.locator(".group-chip", { hasText: groupName }).first().click();
    await prepPage.waitForTimeout(2000);
    await prepPage.evaluate(() => window.navigateTo("home"));
    await prepPage.waitForTimeout(2000);
    await prepPage.screenshot({ path: join(outDir, "demo-poster.png") });
    const storageState = await prepContext.storageState({ indexedDB: true });
    await prepContext.close();

    const recordContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
      storageState,
      recordVideo: { dir: videoDir, size: { width: 390, height: 844 } }
    });
    await recordContext.route("**/js/firebase.js", routeFirebase);
    const page = await recordContext.newPage();
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const shell = document.getElementById("app-shell");
      return shell && !shell.hidden;
    }, null, { timeout: 25000 });
    await page.waitForTimeout(2200);

    await page.evaluate(() => window.navigateTo("groups"));
    await page.waitForTimeout(1800);
    await page.evaluate(() => window.navigateTo("balances"));
    await page.waitForTimeout(2200);
    await page.evaluate(() => window.quickSettlePrompt("Shivam", "Rhea", 60000));
    await page.waitForTimeout(1600);
    await page.click('#settle-form button[type="submit"]');
    await page.waitForTimeout(2200);
    await page.evaluate(() => window.navigateTo("history"));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.navigateTo("home"));
    await page.waitForTimeout(2400);

    const video = page.video();
    const videoPath = await video.path();
    await recordContext.close();
    const finalPath = join(outDir, "demo-goa.webm");
    const ffmpeg = findFfmpeg();
    const trimmed = ffmpeg && spawnSync(ffmpeg, [
      "-y", "-ss", "1.5", "-i", videoPath,
      "-c:v", "libvpx-vp9", "-crf", "28", "-b:v", "0", finalPath
    ], { stdio: "ignore" }).status === 0;
    if (!trimmed) await copyFile(videoPath, finalPath);
    console.log("video written", finalPath);
    console.log("poster written", join(outDir, "demo-poster.png"));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await deleteApp(adminApp);
  }
}

run().catch((error) => {
  console.error("DEMO RECORD FAILED:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
