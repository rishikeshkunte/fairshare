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
const sync = readFileSync(join(root, "js", "sync.js"), "utf8");

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
  assert.match(html, /const visibleFriends = appState\.friends \|\| \[\]/);
  assert.doesNotMatch(html.slice(html.indexOf("function renderFriendsRoster()"), html.indexOf("function renderFriendRequestsUI")), /Sign in to see your saved friends/);
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
  assert.match(rules, /allow list:\s*if signedIn\(\) && email\(\) in resource\.data\.memberEmails;/);
  assert.match(rules, /function isMember\(data\)[\s\S]*?email\(\) in data\.memberEmails/);
  assert.match(rules, /allow get:\s*if signedIn\(\)[\s\S]*?groups\/\$\(groupId\)[\s\S]*?isMember\(resource\.data\)/);
  assert.match(rules, /direct_pairs[\s\S]*?allow get:\s*if signedIn\(\)[\s\S]*?direct_pairs\/\$\(pairId\)[\s\S]*?pairMember\(resource\.data\)/);
});

test("shared expense sync uses transactional merges and stable participant identities", () => {
  assert.match(html, /runTransaction\(fx\.db, async transaction/);
  assert.match(html, /mergePairLedger\(/);
  assert.match(html, /buildPairWritePayload\(/);
  assert.match(html, /participantKeys/);
  assert.match(sync, /export function canonicalizePairTransaction/);
  assert.match(sync, /payerEmail/);
  assert.match(sync, /sharesByEmail/);
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


test("groups page shows its own expense totals and balances", () => {
  assert.match(html, /id="group-expenses-card"/);
  assert.match(html, /id="group-expenses-total"/);
  assert.match(html, /id="group-expenses-share"/);
  assert.match(html, /id="group-expenses-balance"/);
  assert.match(html, /data-call="openGroupExpenseForm"/);
  assert.match(html, /data-call="openGroupExpensesHistory"/);
  const render = html.slice(html.indexOf("function renderGroupExpenseSummary()"), html.indexOf("window.openGroupExpenseForm"));
  assert.match(render, /totalExpense/);
  assert.match(render, /netBalances\(g\)/);
  assert.match(render, /simplifiedDebts/);
  assert.match(render, /group-expenses-recent/);
  assert.match(html, /renderGroupExpenseSummary\(\);/);
});

test("balances and settlement layout adapts across desktop, tablet, and mobile", () => {
  assert.match(css, /\.home-balance-details \.balances-layout[\s\S]*?align-items: start/);
  assert.match(css, /@media \(min-width: 1200px\)[\s\S]*?\.home-balance-details \.balances-layout[\s\S]*?grid-template-columns/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.home-balance-details \.balances-layout[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.home-balance-details #settlement-list \.settlement-card[\s\S]*?flex-wrap: wrap/);
});

test("friend roster re-renders immediately when authentication changes", () => {
  assert.match(html, /watchAuth\(fx, applyAuthState\)/);
  const start = html.indexOf("function applyAuthState(user)");
  const end = html.indexOf("\n    async function ensureCloud", start);
  const apply = html.slice(start, end);
  assert.ok(start >= 0 && end > start, "applyAuthState exists");
  assert.ok(apply.indexOf("updateAuthUI(user);") >= 0, "signed-in UI is applied");
  assert.ok(apply.indexOf("updateAuthUI(user);") < apply.indexOf("syncUserCloud(user);"));
  assert.ok(apply.indexOf("renderAll();") < apply.indexOf("syncUserCloud(user);"));
  assert.match(html, /function renderFriendsRoster\(\)[\s\S]*?const visibleFriends = appState\.friends \|\| \[\]/);
});


test("saved friends roster syncs to the signed-in account independently of groups", () => {
  assert.match(html, /function saveFriendsRosterToCloud\(\)/);
  assert.match(html, /function listenToFriendsRoster\(user\)/);
  assert.match(html, /watchDoc\(fx, "user_profiles", user\.uid/);
  assert.match(html, /if \(fx && currentUser\) saveFriendsRosterToCloud\(\)/);
  assert.match(html, /listenToFriendsRoster\(user\)/);
  assert.match(rules, /match \/user_profiles\/\{userId\}[\s\S]*?request\.auth\.uid == userId/);
});


test("Firebase auth session is restored on every startup", () => {
  assert.match(html, /Always restore Firebase's persisted auth session on startup/);
  assert.match(html, /ensureCloud\(\)\.catch\(\(\) => \{/);
  assert.doesNotMatch(html, /if \(cloudIntent\(\)\) ensureCloud\(\)/);
});


test("friends roster displays existing contacts independently of auth rendering", () => {
  const start = html.indexOf("function renderFriendsRoster()");
  const end = html.indexOf("\n    function ", start + 10);
  const roster = html.slice(start, end);
  assert.match(roster, /const visibleFriends = appState\.friends \|\| \[\]/);
  assert.doesNotMatch(roster, /if \(!currentUser\)[\s\S]*?Sign in to see your saved friends/);
  assert.match(roster, /No saved friends yet/);
});

test("simplify debts toggle persists its selected mode and re-renders settlements", () => {
  assert.match(html, /toggleSimplify\.onchange = \(\) => \{[\s\S]*?g\.simplifyDebts = toggleSimplify\.checked;[\s\S]*?saveState\(\);[\s\S]*?renderAll\(\);/);
  assert.match(html, /const simplified = g\.simplifyDebts !== false/);
  assert.match(html, /if \(!simplified\)[\s\S]*?const edges = pairwiseDebts\(g\)/);
  assert.match(html, /const debtors = \[\];[\s\S]*?const creditors = \[\];[\s\S]*?const debts = \[\]/);
});


test("direct-pair listener merges snapshots through the shared tombstone-aware module", () => {
  const start = html.indexOf("function refreshDirectListeners()");
  const end = html.indexOf("\n    function ", start + 20);
  const listener = html.slice(start, end);
  assert.match(listener, /const pairId = pairIdFor\(myEmail, friend\.email\)/);
  assert.match(listener, /applyRemotePair\(appState/);
  assert.match(listener, /remotePairNeedsPush\(remote, localTx, localDel\)/);
  assert.match(listener, /syncDirectPairExpense\(friendName, \{ quiet: true \}\)/);
  assert.doesNotMatch(listener, /filter\(tx => tx\.friend !== friendName\)\.concat/);
});


test("direct-pair writes and listeners use the same canonical pair id", () => {
  const writerStart = html.indexOf("function syncDirectPairExpense(friendName");
  const writerEnd = html.indexOf("\n    async function ", writerStart + 20);
  const writer = html.slice(writerStart, writerEnd);
  const listenerStart = html.indexOf("function refreshDirectListeners()");
  const listenerEnd = html.indexOf("\n    function ", listenerStart + 20);
  const listener = html.slice(listenerStart, listenerEnd);
  assert.match(writer, /const pairId = pairIdFor\(myEmail, friendEmail\)/);
  assert.match(listener, /const pairId = pairIdFor\(myEmail, friend\.email\)/);
});


test("direct expense deletion persists its tombstone before syncing the shared ledger", () => {
  const start = html.indexOf("window.deleteTransaction = async function(id)");
  const end = html.indexOf("\n    window.", start + 20);
  const deletion = html.slice(start, end);
  assert.ok(deletion.indexOf('localStorage.setItem("fairshare_state_v9", JSON.stringify(appState))') < deletion.indexOf("saveState();"));
  assert.ok(deletion.indexOf("saveState();") < deletion.indexOf("syncDirectPairExpense(found.tx.friend)"));
});

test("shared ledgers use the timestamp-aware merge from the sync module", () => {
  assert.match(html, /mergePairLedger\(/);
  assert.doesNotMatch(html, /function mergeTransactionsWithDeletes/);
  assert.match(sync, /export function mergePairLedger/);
  assert.match(sync, /Number\(tomb\.deletedAt \|\| 0\) >= txStamp\(tx\)/);
});

test("Gmail linking upgrades a same-name local friend without an email", () => {
  const start = html.indexOf("function addApprovedFriend(email, name)");
  const end = html.indexOf("function renderFriendRequestsUI()", start);
  const fn = html.slice(start, end);
  assert.ok(fn.includes("existing.email = em"));
  assert.ok(fn.includes('!normalizeEmail(friend.email || "")'));
  assert.ok(fn.includes("renderDirectFriendDropdown()"));
  assert.ok(fn.includes('normalizeEmail(friend.email || "") === em'));
});

test("application wires the shared direct-pair sync module instead of inline merge logic", () => {
  assert.match(html, /import\s*\{[^}]*\bapplyRemotePair\b[^}]*\}\s*from\s*"\.\/js\/sync\.js"/);
  assert.match(html, /import\s*\{[^}]*\bbuildPairWritePayload\b[^}]*\}\s*from\s*"\.\/js\/sync\.js"/);
  assert.match(html, /import\s*\{[^}]*\bmergePairLedger\b[^}]*\}\s*from\s*"\.\/js\/sync\.js"/);
  assert.match(html, /function refreshDirectListeners\(\)[\s\S]*?applyRemotePair\(/);
  assert.match(html, /remotePairNeedsPush\(/);
  assert.match(html, /buildPairWritePayload\(/);
  assert.doesNotMatch(html, /function mergeTransactionsWithDeletes\(/);
});

test("restoring a deleted record advances updatedAt past the tombstone", () => {
  const start = html.indexOf("window.restoreDeletedTransaction = function(deletedId, location, groupId)");
  const end = html.indexOf("// Settle Form", start);
  const restore = html.slice(start, end);
  assert.match(restore, /const restoredAt = Math\.max\(\s*Date\.now\(\),\s*Number\(record\.deletedAt \|\| 0\) \+ 1,\s*Number\(record\.transaction\.updatedAt \|\| 0\) \+ 1\s*\);/);
  assert.match(restore, /record\.transaction\.updatedAt = restoredAt;/);
});

test("direct-pair rules derive canonical membership from the auth token and stable keys", () => {
  assert.match(rules, /function canonical\(e\)[\s\S]*?gmail\[\.\]com/);
  assert.match(rules, /function mine\(\)[\s\S]*?canonical\(email\(\)\)/);
  assert.match(rules, /function pairMember\(data\)[\s\S]*?mine\(\) in data\.participantKeys[\s\S]*?data\.participants/);
  assert.match(rules, /allow list:\s*if signedIn\(\) && mine\(\) in resource\.data\.participantKeys;/);
  assert.match(rules, /function validPair\(data\)[\s\S]*?mine\(\) in data\.participantKeys[\s\S]*?mine\(\) in data\.participants/);
  assert.match(rules, /data\.participantKeys\.hasAll\(data\.participants\)[\s\S]*?data\.participants\.hasAll\(data\.participantKeys\)/);
  assert.match(rules, /function legacyPairKeys\(\)[\s\S]*?canonical\(resource\.data\.participants\[0\]\)[\s\S]*?canonical\(resource\.data\.participants\[1\]\)/);
  assert.match(rules, /function stableMembership\(\)[\s\S]*?resource\.data\.participants is list[\s\S]*?\('participantKeys' in resource\.data\)[\s\S]*?hasAll\(request\.resource\.data\.participantKeys\)[\s\S]*?request\.resource\.data\.participantKeys\.hasAll\(resource\.data\.participantKeys\)/);
  assert.match(rules, /request\.resource\.data\.participantKeys\.hasAll\(legacyPairKeys\(\)\)[\s\S]*?legacyPairKeys\(\)\.hasAll\(request\.resource\.data\.participantKeys\)/);
  assert.match(rules, /allow create:\s*if signedIn\(\) && validPair\(request\.resource\.data\);/);
  assert.match(rules, /allow update:\s*if pairMember\(resource\.data\) && validPair\(request\.resource\.data\) && stableMembership\(\);/);
  assert.match(rules, /allow get:\s*if signedIn\(\)[\s\S]*?!exists\([\s\S]*?pairMember\(resource\.data\)/);
});

test("scan bill is removed without breaking manual receipt attachment", () => {
  assert.doesNotMatch(html, /GOOGLE_VISION_API_KEY|vision\.googleapis\.com|scanReceiptImage|parseReceiptText|receipt-scan-status|detected-amounts-wrapper|Scan bill receipt/i);
  assert.doesNotMatch(html, /receipt-auth-pill|receipt-auth-note/);
  assert.match(html, /<label for="receipt-file">Receipt photo \(optional\)<\/label>/);
  assert.match(html, /<input type="file" id="receipt-file" accept="image\/\*">/);
  assert.match(html, /receiptFileInput\.addEventListener\("change"/);
  assert.match(html, /activeReceiptBase64 = await compressImage\(evt\.target\.result\)/);
  assert.match(html, /if \(receiptThumb\) receiptThumb\.src = activeReceiptBase64;/);
  assert.match(html, /btnClearReceipt\.addEventListener\("click"/);
  assert.match(html, /safeImageSrc\(tx\.receiptUrl \|\| tx\.receipt\)/);
});

test("receipt reconciliation preserves local receipt fields", () => {
  assert.match(html, /import\s*\{[^}]*\bpreserveLocalReceipts\b[^}]*\}\s*from "\.\/js\/sync\.js"/);
  assert.match(sync, /export function preserveLocalReceipts/);
  assert.match(html, /preserveLocalReceipts\(reconciled\.transactions, localGroupTransactions\)/);
  assert.match(html, /preserveLocalReceipts\(merged\.transactions, localGroupTransactions\)/);
  assert.match(html, /preserveLocalReceipts\(next\.directTransactions, localDirectTransactions\)/);
});

test("group reconciliation keeps merged tombstones instead of cloud-only tombstones", () => {
  assert.match(html, /localGroup\.deletedTransactions = merged\.deletedTransactions;/);
  assert.doesNotMatch(html, /\bdeletedTransactions\s*=\s*cloudData\.deletedTransactions\b/);
});
