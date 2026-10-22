import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "fairshare.css"), "utf8");
const rules = readFileSync(join(root, "firestore.rules"), "utf8");

test("inline application module parses as valid JavaScript", () => {
  const match = html.match(/<script\s+type="module">([\s\S]*?)<\/script>/i);
  assert.ok(match, "the main module script exists");
  const path = join(tmpdir(), `fairshare-inline-${process.pid}.mjs`);
  try {
    writeFileSync(path, match[1], "utf8");
    const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout || "JavaScript syntax check failed");
  } finally {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

test("home screen has separate review and settle actions and no invite-link button", () => {
  const homeStart = html.indexOf('<section id="page-home"');
  const pageTwo = html.indexOf("PAGE 2: ADD / EDIT EXPENSE", homeStart);
  assert.ok(homeStart >= 0 && pageTwo > homeStart, "home section can be located");
  const home = html.slice(homeStart, pageTwo);
  assert.match(home, />Review balances<\/button>/);
  assert.match(home, /data-call="openSettleUp">Settle up<\/button>/);
  assert.doesNotMatch(html, />Invite link<\/button>/i);
});

test("floating expense action is anchored to the bottom-left on desktop and mobile", () => {
  assert.match(css, /\.expense-fab-wrap\s*\{[^}]*left:\s*28px;\s*right:\s*auto;/);
  assert.match(css, /\.expense-fab-wrap\s*\{[^}]*left:\s*16px;\s*right:\s*auto;/);
});

test("empty state prompts group creation and blocks group payments without a group", () => {
  assert.match(html, /id="home-no-groups-prompt"[^>]*hidden/);
  assert.match(html, /data-call="openNewGroupPrompt">Create your first group<\/button>/);
  assert.match(html, /scope === "group" && Object\.keys\(appState\.groups\)\.length === 0/);
  assert.match(html, /window\.openSettleUp = function\(\)[\s\S]*?Object\.keys\(appState\.groups\)\.length === 0/);
  assert.match(html, /isEmptyTemplate[\s\S]*?delete appState\.groups\["group_default"\]/);
  assert.match(html, /if \(noGroupsPrompt\) noGroupsPrompt\.hidden = groups\.length > 0/);
});

test("signed-out state hides cached friends and direct activity", () => {
  assert.match(html, /const visibleFriends = currentUser \? appState\.friends : \[\]/);
  assert.match(html, /if \(!currentUser\)[\s\S]*?Sign in to see your saved friends/);
  assert.match(html, /scope === "friend" && !currentUser[\s\S]*?Sign in to access your saved friends/);
  assert.match(html, /if \(!currentUser\)[\s\S]*?Sign in to see saved friends/);
  assert.match(html, /currentUser \? \(appState\.directTransactions \|\| \[\]\)\.map/);
  assert.match(html, /Sign in to view 1-on-1 balances/);
  assert.match(html, /if \(!currentUser\)[\s\S]*?Sign in to add a 1-on-1 expense/);
});

test("create-group modal never renders cached friends while signed out", () => {
  assert.match(html, /const friendsForGroup = currentUser \? appState\.friends : \[\]/);
  assert.match(html, /if \(!currentUser\)[\s\S]*?Sign in to see your saved friends[\s\S]*?friendsForGroup\.forEach/);
});

test("group discovery rules restrict reads to signed-in group members", () => {
  assert.match(rules, /allow list:\s*if isMember\(resource\.data\);/);
  assert.match(rules, /function isMember\(data\)[\s\S]*?email\(\) in data\.memberEmails/);
  assert.match(rules, /allow get:\s*if signedIn\(\)[\s\S]*?groups\/\$\(groupId\)[\s\S]*?isMember\(resource\.data\)/);
  assert.match(rules, /direct_pairs[\s\S]*?allow get:\s*if signedIn\(\)[\s\S]*?direct_pairs\/\$\(pairId\)[\s\S]*?inPair\(resource\.data\)/);
});

test("shared expense sync uses transactional merges and stable participant identities", () => {
  assert.match(html, /runTransaction\(fx\.db, async transaction/);
  assert.match(html, /mergeTransactionsWithDeletes\(/);
  assert.match(html, /payerEmail/);
  assert.match(html, /sharesByEmail/);
  assert.match(html, /watchQuery\(fx, "groups", "memberEmails", "array-contains", myEmail/);
});
