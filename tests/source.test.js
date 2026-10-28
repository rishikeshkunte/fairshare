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
  assert.match(home, /Review balances/);
  assert.match(home, /Settle up/);
  assert.doesNotMatch(home, />Invite link<\/button>/i);
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
  assert.match(html, /const visibleFriends = getVisibleFriends\(\)/);
  assert.doesNotMatch(html.slice(html.indexOf("function renderFriendsRoster()"), html.indexOf("function renderFriendRequestsUI")), /Sign in to see your saved friends/);
  assert.match(html, /scope === "friend" && !currentUser[\s\S]*?Sign in to access your saved friends/);
  assert.match(html, /if \(!currentUser\)[\s\S]*?Sign in to see saved friends/);
  assert.match(html, /currentUser \? \(appState\.directTransactions \|\| \[\]\)\.map/);
  assert.match(html, /if \(!currentUser\)[\s\S]*?Sign in to add a 1-on-1 expense/);
});

test("create-group modal never renders cached friends while signed out", () => {
  assert.match(html, /const friendsForGroup = currentUser \? getVisibleFriends\(\) : \[\]/);
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

test("signed-out summaries, details, and trash exclude cached 1-on-1 data", () => {
  assert.match(html, /function renderHomeAllDebts\(\)[\s\S]*?currentUser \? \(appState\.directTransactions \|\| \[\]\) : \[\]/);
  assert.match(html, /function analyticsExpenses\(\)[\s\S]*?currentUser \? \(appState\.directTransactions \|\| \[\]\) : \[\]/);
  assert.match(html, /function renderDeletedTransactions\(\)[\s\S]*?filter\(item => currentUser \|\| item\.location !== "direct"\)/);
  assert.match(html, /window\.openDetailModal = function\(id\)[\s\S]*?found\.where === "direct" && !currentUser[\s\S]*?Sign in to view 1-on-1 transaction details/);
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


test("home does not duplicate a direct-only friend balances card", () => {
  assert.doesNotMatch(html, /direct-balances-card|direct-balances-list|renderDirectBalances/);
  assert.doesNotMatch(html, /Direct 1-on-1 friend balances/);
  assert.match(html, /across groups & 1-on-1/);
});

test("friends page shows a selected friend's 1-on-1 ledger", () => {
  assert.match(html, /id="friend-detail-card"/);
  assert.match(html, /id="friend-detail-total"/);
  assert.match(html, /id="friend-detail-share"/);
  assert.match(html, /id="friend-detail-balance"/);
  assert.match(html, /id="friend-detail-records"/);
  assert.match(html, /data-call="openFriendDetail"/);
  assert.match(html, /data-call="friendDetailAddExpense"/);
  assert.match(html, /data-call="friendDetailSettle"/);
  const detail = html.slice(html.indexOf("function renderFriendDetail()"), html.indexOf("window.openFriendDetail"));
  assert.match(detail, /directBalanceForFriend\(friend\.name\)/);
  assert.match(detail, /getFriendGroupBalances\(friend\)/);
  assert.match(detail, /tx\.shares\?\.You/);
  assert.match(detail, /friend-detail-records/);
  assert.match(detail, /data-arg2="\$\{escapeHtml\(item\.name\)\}"/);
  assert.match(html, /window\.openFriendGroup = function\(groupId, groupName\)/);
  assert.match(html, /navigateTo\("groups"\);\s*try \{\s*switchActiveGroup\(id\)/);
  assert.match(html, /renderFriendDetail\(\);/);
});

test("friends roster includes group balances alongside 1-on-1 balances", () => {
  assert.match(html, /function findGroupMemberForFriend\(group, friend\)/);
  const helper = html.slice(html.indexOf("function getFriendGroupBalances(friend)"), html.indexOf("function renderFriendsRoster()"));
  assert.match(helper, /pairwiseDebts\(group\)/);
  assert.match(helper, /byCurrency/);
  const roster = html.slice(html.indexOf("function renderFriendsRoster()"), html.indexOf("function renderFriendPickerDropdown"));
  assert.match(roster, /getFriendGroupBalances\(f\)/);
  assert.match(roster, /friend-group-badge/);
  assert.match(roster, /friendBal/);
  assert.match(css, /\.friend-group-badge\.positive/);
  assert.match(css, /\.friend-group-badge\.negative/);
});

test("secure invite links can be created, copied, accepted, and revoked", () => {
  assert.match(html, /data-call="createFriendInvite"/);
  assert.match(html, /data-call="createGroupInvite"/);
  assert.match(html, /id="invite-link-note"/);
  assert.match(html, /id="invites-list"/);
  assert.match(html, /function newInviteToken\(\)/);
  assert.match(html, /async function createInvite\(type, group\)/);
  assert.match(html, /window\.createFriendInvite = async function\(\)/);
  assert.match(html, /window\.createGroupInvite = async function\(\)/);
  assert.match(html, /window\.revokeInvite = async function\(token\)/);
  assert.match(html, /window\.acceptInvite = async function\(\)/);
  assert.match(html, /window\.declineInvite = function\(\)/);
  assert.match(html, /48 \* 60 \* 60 \* 1000/);
  assert.match(html, /Old invite links are no longer supported/);
});

test("CSV export is removed", () => {
  assert.doesNotMatch(html, /btn-export-csv|Export CSV/);
});

test("analytics provides category, people, and trend views with scopes", () => {
  assert.match(html, /data-analytics-view="category"/);
  assert.match(html, /data-analytics-view="people"/);
  assert.match(html, /data-analytics-view="trend"/);
  assert.match(html, /data-analytics-scope="active"/);
  assert.match(html, /data-analytics-scope="all"/);
  assert.match(html, /data-analytics-scope="direct"/);
  assert.match(html, /function renderAnalytics\(\)/);
  assert.match(html, /function renderPeopleChart\(rows, cur\)/);
  assert.match(html, /function renderTrendChart\(rows, cur\)/);
  assert.match(html, /function analyticsExpenses\(\)/);
  assert.match(html, /function lastSixMonths\(\)/);
  assert.match(html, /function expenseMonthKey\(tx\)/);
  assert.match(html, /analyticsScope === "direct"/);
  assert.match(html, /analyticsScope === "all"/);
  assert.match(html, /id="analytics-scope-note"/);
  assert.match(html, /people-bar/);
  assert.match(html, /trend-summary/);
  assert.match(html, /renderAnalytics\(\);/);
});

test("group membership never creates friends and self names are display-mapped", () => {
  const roster = html.slice(html.indexOf("function addGroupMembersToRoster"), html.indexOf("function renderFriendRequestsUI"));
  assert.doesNotMatch(roster, /addApprovedFriend/);
  assert.match(roster, /if \(existing && !normalizeEmail/);
  assert.match(html, /function migrateGroupSelfName\(group\)/);
  assert.match(html, /const members = \[myGroupSelfName\(\), \.\.\.selectedFriends\]/);
  assert.match(html, /displayGroupMember\(group, debt\.from\)/);
  assert.match(html, /displayGroupMember\(group, member\)/);
  assert.match(html, /transactionDisplayName\(tx, tx\.payer\)/);
});

test("group members can repair cloud sync with a linked Gmail or new invite", () => {
  assert.match(html, /window\.linkMemberEmail = async function\(name\)/);
  assert.match(html, /Members without a linked Gmail can't see cloud changes/);
  assert.match(html, /local-only/);
  assert.match(html, /Only treat this as already-joined when the local copy has confirmed/);
  assert.match(html, /Cloud group sync was denied/);
});

test("group sync can be repaired from cloud and pushes local edits", () => {
  assert.match(html, /data-call="reloadGroupFromCloud"/);
  assert.match(html, /window\.reloadGroupFromCloud = async function\(\)/);
  assert.match(html, /Reconcile both directions/);
  assert.match(html, /cloudTransactions/);
  assert.match(html, /Local-only changes in this group will be lost/);
});

test("account offers sync repair and app refresh without clearing login", () => {
  assert.match(html, /data-call="syncNow"/);
  assert.match(html, /data-call="refreshAppData"/);
  assert.match(html, /window\.syncNow = function\(\)/);
  assert.match(html, /window\.refreshAppData = async function\(\)/);
  assert.match(html, /serviceWorker\.getRegistrations/);
  assert.match(html, /caches\.delete/);
  assert.match(html, /syncUserCloud\(currentUser\)/);
  assert.match(html, /sync-build-label/);
  assert.match(html, /addEventListener\("online"/);
});

test("settlement scope distinguishes the active group from overall standing", () => {
  assert.match(html, /id="settlement-scope-note"/);
  assert.match(html, /group is settled\. Your overall balance still includes other groups or 1-on-1 expenses/);
  assert.match(html, /Active group: \$\{g\.name\}/);
  assert.match(html, /balances-group-scope/);
  assert.match(html, /settlementHeaderLabel\.textContent = .*data\.label/);
});

test("friends page lists friends first and selects a friend for details", () => {
  const start = html.indexOf("function organizeNavigationPages()");
  const end = html.indexOf("// The floating button", start);
  const organize = html.slice(start, end);
  assert.match(organize, /friendsStack\.prepend\(rosterCard\)/);
  assert.match(organize, /rosterCard\.after\(friendDetailCard\)/);
  assert.match(organize, /addFriendsCard\.appendChild\(quickAddBlock\)/);
  assert.match(html, /id="friend-detail-select"/);
  assert.match(html, /friendDetailSelect\.addEventListener\("change"/);
});

test("1-on-1 ledgers can be reloaded from cloud", () => {
  assert.match(html, /data-call="reloadSelectedFriendFromCloud"/);
  assert.match(html, /window\.reloadFriendFromCloud = async function\(friendId\)/);
  assert.match(html, /Replace this device's 1-on-1 ledger/);
  assert.match(html, /applyRemotePair\(/);
});

test("local friends can be linked to Gmail for direct sync", () => {
  assert.match(html, /window\.linkFriendEmail = async function\(friendId\)/);
  assert.match(html, /data-call="linkFriendEmail"/);
  assert.match(html, /Direct sync is now available/);
});

test("self-invites and duplicate connections are rejected", () => {
  assert.match(html, /You can't connect with yourself/);
  assert.match(html, /You're already connected with this person/);
  assert.match(html, /You're already in this group/);
});

test("invite rules validate tokens, expiry, revocation, and use", () => {
  assert.match(rules, /match \/invites\/\{token\}/);
  assert.match(rules, /validGroupInvite/);
  assert.match(rules, /validFriendInvite/);
  assert.match(rules, /expiresAt > request\.time/);
  assert.match(rules, /revoked == false/);
  assert.match(rules, /uses == resource\.data\.uses \+ 1/);
  assert.match(rules, /lastJoinToken/);
  assert.match(rules, /inviteToken/);
});

test("group management requires an explicit group selection", () => {
  assert.match(html, /id="manage-group-select"/);
  assert.match(html, /<option value="">Choose a group\.\.\.<\/option>/);
  assert.match(html, /id="group-management-body" hidden/);
  assert.match(html, /id="group-management-hint"/);
  assert.match(html, /function renderManageGroupSelector\(\)/);
  assert.match(html, /renderManageGroupSelector\(\);/);
  assert.match(html, /groupManagementBody\.hidden = !hasManaged/);
  assert.match(html, /switchActiveGroup\(id, \{ keepManaged: true \}\)/);
});

test("groups page shows its own expense totals and balances", () => {
  assert.match(html, /id="group-expenses-card"/);
  assert.match(html, /id="group-expenses-total"/);
  assert.match(html, /id="group-expenses-share"/);
  assert.match(html, /id="group-expenses-balance"/);
  assert.match(html, /data-call="openGroupExpenseForm"/);
  assert.match(html, /data-call="openGroupExpensesHistory"/);
  assert.match(html, /data-call="openGroupSettleUp"/);
  assert.match(html, /window\.openGroupSettleUp = function\(\)/);
  assert.match(html, /window\.openSettleUp = function\(\)[\s\S]*?navigateTo\("balances"\)/);
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
  assert.match(html, /function renderFriendsRoster\(\)[\s\S]*?const visibleFriends = getVisibleFriends\(\)/);
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
  assert.match(roster, /const visibleFriends = getVisibleFriends\(\)/);
  assert.doesNotMatch(roster, /if \(!currentUser\)[\s\S]*?Sign in to see your saved friends/);
  assert.match(roster, /No saved friends yet/);
});

test("simplify debts toggle persists its selected mode and re-renders settlements", () => {
  assert.match(html, /toggleSimplify\.onchange = \(\) => \{[\s\S]*?scopeGroup\.simplifyDebts = toggleSimplify\.checked;[\s\S]*?saveState\(\);[\s\S]*?renderAll\(\);/);
  assert.match(html, /toggleSimplify\.checked = scopeGroup\.simplifyDebts !== false/);
  assert.match(html, /function allOpenSettlementItems\(data = balancesScopeData\(\)\)/);
  assert.match(html, /group\.simplifyDebts !== false[\s\S]*?simplifiedDebts\(netBalances\(group\)\)[\s\S]*?: pairwiseDebts\(group\)/);
  assert.match(html, /directBalancesByFriend\(\)/);
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

test("balances can scope to one group, all groups, or 1-on-1 and include people balances", () => {
  assert.match(html, /id="balances-scope-select"/);
  assert.match(html, /function balancesScopeData\(\)/);
  assert.match(html, /balancesScope === "direct"/);
  assert.match(html, /data\.includeDirect/);
  assert.match(html, /function buildScopedPeople\(data\)/);
  assert.match(html, /const balancesScopeLabel = document\.getElementById\("balances-group-scope"\)/);
});

test("renaming a contact propagates to direct ledgers and group display names", () => {
  assert.match(html, /friend\.aliases = Array\.from\(new Set/);
  assert.match(html, /if \(tx\.friend === oldName\)/);
  assert.match(html, /if \(tx\.payer === oldName\)/);
  assert.match(html, /const linkedEmail = group\?\.memberLinks\?\.\[name\]/);
  assert.match(html, /friend\.email && normalizeEmail\(friend\.email\) === normalizeEmail\(linkedEmail\)/);
  assert.match(html, /friend\.aliases\.includes\(name\)/);
});

test("suggested settlements and direct balances use the renamed contact, not an alias", () => {
  assert.match(html, /function canonicalFriendName\(name\)/);
  assert.match(html, /Array\.isArray\(item\.aliases\) && item\.aliases\.includes\(name\)/);
  assert.match(html, /const friend = canonicalFriendName\(tx\.friend\)/);
  assert.match(html, /canonicalFriendName\(name\) === target/);
});

test("old 1-on-1 names resolve through group links and reconcile direct keys", () => {
  assert.match(html, /function reconcileDirectFriendNames\(\)/);
  assert.match(html, /for \(const group of Object\.values\(appState\.groups \|\| \{\}\)\)/);
  assert.match(html, /if \(reconcileDirectFriendNames\(\)\) persistLocalState\(\)/);
  assert.match(html, /const linkedEmail = group\?\.memberLinks\?\.\[name\]/);
});

test("suggested settlements default to the signed-in person's own debts", () => {
  assert.match(html, /id="settlement-visibility"/);
  assert.match(html, /let settlementVisibility = "mine"/);
  assert.match(html, /item\.kind === "direct" \|\| item\.fromLabel === "You" \|\| item\.toLabel === "You"/);
  assert.match(html, /settlementVisibility === "all" \? allItems : allItems\.filter\(isMine\)/);
});

test("Splitwise CSV import creates groups, members, expenses, and settlements", () => {
  assert.match(html, /id="btn-import-csv"/);
  assert.match(html, /id="csv-import-modal"/);
  assert.match(html, /function prepareCsvImport\(file\)/);
  assert.match(html, /function csvSplit\(text\)/);
  assert.match(html, /kind: "settlement", payer: positive\[0\], receiver: negative\[0\]/);
  assert.match(html, /shares\[name\] = index === payerIndex \? amount - nets\[index\] : -nets\[index\]/);
  assert.match(html, /window\.importCsvFile = function\(\)/);
  assert.match(html, /importKey: key/);
  assert.match(html, /saveState\(target\)/);
});

test("ledger identity and money repairs run automatically on load, snapshots, and sync", () => {
  assert.match(html, /function repairGroupIdentity\(group\)/);
  assert.match(html, /function repairGroupMoney\(group\)/);
  assert.match(html, /function repairDirectMoney\(\)/);
  assert.match(html, /if \(repairGroupIdentity\(group\)\) migratedSelfName = true/);
  assert.match(html, /if \(repairGroupMoney\(group\)\) repairedNames = true/);
  assert.match(html, /if \(repairDirectMoney\(\)\) \{ persistLocalState\(\); pushAllDirectPairs\(\); \}/);
  assert.match(html, /setInterval\(\(\) => \{[\s\S]*?syncUserCloud\(currentUser\)/);
});

test("group creation and CSV import confirm success and open group-scoped activity", () => {
  assert.match(html, /window\.viewGroupActivity = function\(groupId\)/);
  assert.match(html, /historyGroupSelect\.value = id/);
  assert.match(html, /created successfully/);
  assert.match(html, /actionLabel: "View activity"/);
  assert.match(html, /data-call="openGroupExpensesHistory">View activity/);
});

test("group-only contacts are hidden from Friends unless explicitly connected", () => {
  assert.match(html, /function cleanupGroupOnlyFriends\(\)/);
  assert.match(html, /incomingRequestsLoaded = true/);
  assert.match(html, /outgoingRequestsLoaded = true/);
  assert.match(html, /friend\.hidden = true/);
  assert.match(html, /function getVisibleFriends\(\)/);
  assert.match(html, /const visibleFriends = getVisibleFriends\(\)/);
  assert.match(html, /cleanupGroupOnlyFriends\(\);/);
});
