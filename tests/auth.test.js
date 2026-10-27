import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "fairshare.css"), "utf8");
const sw = readFileSync(join(root, "sw.js"), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} exists`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${endMarker} follows ${startMarker}`);
  return source.slice(start, end);
}

test("auth listener is registered first and startup never waits on redirect state", () => {
  const ensure = between(html, "async function ensureCloud()", "\n    function updateAuthUI");
  const watch = ensure.indexOf("watchAuth(fx, applyAuthState)");
  const manual = ensure.indexOf("fx.auth.currentUser");
  assert.ok(watch >= 0, "auth listener is registered");
  assert.ok(watch < manual, "listener registration precedes currentUser restore");
  assert.doesNotMatch(ensure, /getRedirectResult\s*\(/);
  assert.doesNotMatch(ensure, /finishRedirectSignIn\s*\(/);
  assert.doesNotMatch(html, /await\s+finishRedirectSignIn/);
});

test("a restored user always leaves the privacy gate", () => {
  const apply = between(html, "function applyAuthState(user)", "\n    async function ensureCloud");
  assert.match(apply, /updateAuthUI\(user\);/);
  assert.match(apply, /catch \(err\)[\s\S]*?console\.error\("Local state restore note:"/);
  assert.ok(apply.indexOf("updateAuthUI(user);") > apply.indexOf("Local state restore note"));
  assert.ok(apply.indexOf("syncUserCloud(user);") > apply.indexOf("updateAuthUI(user);"));
});

test("login click recovers when a session exists behind the gate", () => {
  const click = between(html, "window.handleAuthClick = async function()", "\n    function syncUserCloud");
  assert.match(click, /if \(currentUser && gate && !gate\.hidden\)/);
  assert.match(click, /applyAuthState\(currentUser\)/);
  assert.match(click, /fairshare\/sign-in-timeout/);
  assert.match(click, /authErrorMessage\(error\)/);
});

test("known popup and storage failures get actionable messages", () => {
  const map = between(html, "function authErrorMessage(error)", "window.handleAuthClick");
  const codes = [
    "auth/unauthorized-domain",
    "auth/popup-blocked",
    "auth/popup-closed-by-user",
    "auth/cancelled-popup-request",
    "auth/operation-not-supported-in-this-environment",
    "auth/web-storage-unsupported",
    "auth/network-request-failed",
    "fairshare/sign-in-timeout"
  ];
  codes.forEach((code) => assert.ok(map.includes(code), `${code} is mapped`));
});

test("cloud listeners start after every auth restore so mobile matches desktop", () => {
  const apply = between(html, "function applyAuthState(user)", "\n    async function ensureCloud");
  assert.match(apply, /cloudSyncUid !== user\.uid/);
  assert.match(apply, /syncUserCloud\(user\);\s*\n\s*cloudSyncUid = user\.uid;/);
  const signedOut = between(html, "function enterSignedOutState", "let ensureCloudPromise");
  assert.match(signedOut, /cloudSyncUid = null/);
});

test("malformed local state is sanitized before restore", () => {
  assert.match(html, /function sanitizeState\(\)/);
  const saved = between(html, "function applySavedState(saved", "function loadUserState");
  assert.match(saved, /sanitizeState\(\)/);
  assert.match(html, /members: members\.length \? members : \["You"\]/);
  assert.match(html, /Array\.isArray\(group\.transactions\)/);
});

test("dialogs render above the privacy gate", () => {
  const gate = Number((css.match(/\.auth-gate\s*\{[\s\S]*?z-index:\s*(\d+)/) || [])[1]);
  const dialog = Number((css.match(/#app-dialog\s*\{\s*z-index:\s*(\d+)/) || [])[1]);
  assert.ok(gate > 0, "auth gate z-index exists");
  assert.ok(dialog > gate, "dialog must be above the gate");
});

test("group membership emails are preserved instead of replaced", () => {
  const save = between(html, "function saveState()", "\n    function syncUserCloud");
  assert.match(save, /cloudData\.memberEmails/);
  assert.match(save, /memberEmails\.add/);
  assert.match(save, /finalMemberEmails/);
  assert.match(html, /memberEmails: Array\.isArray\(cloudData\.memberEmails\)/);
});

test("local-only groups are uploaded on sign-in", () => {
  const push = between(html, "async function pushLocalGroupsToCloud(user)", "\n    function listenToCloudGroup");
  assert.match(push, /if \(snapshot\.exists\(\)\) return false/);
  assert.match(push, /memberEmails: finalEmails/);
  assert.match(html, /pushLocalGroupsToCloud\(user\)/);
});

test("cloud sync status is visible without exposing account data", () => {
  assert.match(html, /id="cloud-sync-status"/);
  const listener = between(html, "unsubscribeUserGroupsListener = watchQuery", "// 4. Listen to the active group");
  assert.match(listener, /setCloudSyncStatus/);
  assert.match(listener, /snapshot\.size/);
});

test("group deletions sync across devices of the same account", () => {
  const save = between(html, "function saveDeletedGroupsToCloud()", "function listenToFriendsRoster");
  assert.match(save, /user_profiles", currentUser\.uid/);
  assert.match(save, /cloudData\.deletedGroups/);
  assert.match(save, /deletedGroups: merged/);

  const listener = between(html, "function listenToFriendsRoster(user)", "\n    // --- DOM Elements");
  assert.match(listener, /cloudData\.deletedGroups/);
  assert.match(listener, /delete appState\.groups\[groupId\]/);
  assert.match(listener, /saveDeletedGroupsToCloud\(\)/);

  const del = between(html, "btnDeleteGroup.addEventListener", "// Modal Create Group");
  assert.match(del, /saveDeletedGroupsToCloud\(\)/);
});

test("an old invite cannot resurrect a group deleted on another device", () => {
  const invite = between(html, "window.acceptGroupInvite = function()", "window.declineGroupInvite");
  assert.match(invite, /deletedGroups \|\| \[\]\)\.includes/);
  assert.match(invite, /stays hidden on all your devices/);
  assert.doesNotMatch(invite, /deletedGroups = \(appState\.deletedGroups/);
});

test("phone contact entry is removed and sign-in copy says Gmail", () => {
  assert.doesNotMatch(html, /addFriendByMobile|input-mobile-number|input-mobile-name/i);
  assert.doesNotMatch(html, /Add friend by mobile number/i);
  assert.match(html, /Sign in with Gmail/);
  assert.doesNotMatch(html, />Sign in with Google</);
});

test("service worker cache is bumped for the auth fix", () => {
  assert.match(sw, /const CACHE = "fairshare-v44"/);
  assert.match(sw, /url\.pathname\.startsWith\("\/__\/auth\/"\)/);
});
