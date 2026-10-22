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

test("friend management and group member picker require sign-in", () => {
  assert.match(html, /window\.addNewFriendToRoster = function\(\)[\s\S]*?if \(!currentUser\)[\s\S]*?Sign in to manage your saved friends/);
  assert.match(html, /window\.addFriendByMobile = function\(\)[\s\S]*?if \(!currentUser\)[\s\S]*?Sign in to manage your saved friends/);
  assert.match(html, /function renderFriendPickerDropdown\(\)[\s\S]*?if \(!currentUser\)[\s\S]*?Sign in to see saved friends[\s\S]*?btnAddFriendToGroup\) btnAddFriendToGroup\.disabled = true/);
  assert.match(html, /window\.renameFriendPrompt = async function\(friendId\)[\s\S]*?if \(!currentUser\)[\s\S]*?Sign in to manage your saved friends/);
  assert.match(html, /window\.deleteFriendFromRoster = async function\(id\)[\s\S]*?if \(!currentUser\)[\s\S]*?Sign in to manage your saved friends/);
  assert.match(html, /window\.quickStartDirectExpense = function\(friendIdOrName\)[\s\S]*?if \(!currentUser\)[\s\S]*?Sign in to access your saved friends/);
  assert.match(html, /window\.quickStartDirectSettle = async function\(friendIdOrName, currentBal\)[\s\S]*?if \(!currentUser\)[\s\S]*?Sign in to view or settle 1-on-1 balances/);
});

test("signed-out summaries, details, trash, and exports exclude cached 1-on-1 data", () => {
  assert.match(html, /function renderHomeAllDebts\(\)[\s\S]*?currentUser \? \(appState\.directTransactions \|\| \[\]\) : \[\]/);
  assert.match(html, /function renderCategoryChart\(\)[\s\S]*?currentUser \? \(appState\.directTransactions \|\| \[\]\) : \[\]/);
  assert.match(html, /function renderDeletedTransactions\(\)[\s\S]*?filter\(item => currentUser \|\| item\.location !== "direct"\)/);
  assert.match(html, /window\.openDetailModal = function\(id\)[\s\S]*?found\.where === "direct" && !currentUser[\s\S]*?Sign in to view 1-on-1 transaction details/);
  assert.match(html, /if \(btnExportCsv\)[\s\S]*?currentUser \? \(appState\.directTransactions \|\| \[\]\) : \[\]/);
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


test("empty activity and analytics states do not show a nonfunctional demo-data action", () => {
  assert.doesNotMatch(html, /Load sample demo data|loadSampleDemoData/);
  assert.match(html, /<div id="empty-msg" class="empty-state">\s*<p class="empty-state-title">Nothing here yet<\/p>\s*<p class="empty-state-description">Your expenses and settlements will appear here as you add them\.<\/p>\s*<\/div>/);
  assert.match(html, /<div id="chart-empty" class="empty-state">\s*<p>No category spending yet\.<\/p>\s*<\/div>/);
});


test("activity empty state is helpful and hides irrelevant controls when there are no transactions", () => {
  assert.match(html, /class="empty-state-title">Nothing here yet<\/p>/);
  assert.match(html, /empty-state-description">Your expenses and settlements will appear here as you add them\.<\/p>/);
  assert.match(html, /historyPage\.classList\.toggle\("is-empty", allTx\.length === 0\)/);
  assert.match(css, /#page-history\.is-empty #filter-all[\s\S]*?#page-history\.is-empty #btn-clear-all/);
});

test("design system includes visible keyboard focus and reduced-motion support", () => {
  assert.match(css, /button:focus-visible, input:focus-visible, select:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});


test("responsive design has explicit compact-laptop and wide-desktop layouts", () => {
  assert.match(css, /@media \(min-width: 1200px\)[\s\S]*?\.workspace \{ padding: 30px 32px 96px/);
  assert.match(css, /@media \(min-width: 861px\) and \(max-width: 1100px\)[\s\S]*?\.app-shell \{ grid-template-columns: 216px minmax\(0, 1fr\)/);
  assert.match(css, /@media \(min-width: 861px\) and \(max-width: 980px\)[\s\S]*?\.chart-wrapper \{ grid-template-columns: minmax\(160px, \.8fr\) minmax\(0, 1fr\)/);
});


test("home and add-expense layouts have explicit desktop and mobile refinements", () => {
  assert.match(css, /@media \(min-width: 861px\)[\s\S]*?#page-add-expense > \.card \{[\s\S]*?max-width: 760px !important/);
  assert.match(css, /@media \(min-width: 1101px\)[\s\S]*?\.home-members-card \{ grid-column: span 4; \}[\s\S]*?\.home-recent-card \{ grid-column: span 8; \}/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?#page-add-expense > \.card \{[\s\S]*?max-width: none !important/);
});


test("add-expense form has a clear amount focus, accessible scope choices, and responsive split controls", () => {
  assert.match(css, /#page-add-expense \.amount-stage[\s\S]*?border-radius: 16px/);
  assert.match(css, /#page-add-expense #amount[\s\S]*?font-size: clamp\(1\.8rem, 4vw, 2\.3rem\)/);
  assert.match(css, /#page-add-expense \.scope-toggle[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?#page-add-expense \.tab-group \.tab-btn[\s\S]*?flex: 1 1 42%/);
  assert.match(html, /id="btn-submit-expense"/);
});
