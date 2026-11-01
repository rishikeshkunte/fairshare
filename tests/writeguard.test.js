import test from "node:test";
import assert from "node:assert/strict";
import { createWriteGuard } from "../js/writeguard.js";

test("writes from inside a snapshot hydration callback are refused", () => {
  const guard = createWriteGuard();
  assert.equal(guard.allow({ label: "user" }), true);
  const allowed = guard.withHydration(() => guard.allow({ label: "listener" }));
  assert.equal(allowed, false);
  const stats = guard.stats();
  assert.equal(stats.blockedFromSnapshot, 1);
  assert.equal(stats.hydrating, false);
  assert.equal(guard.allow({ label: "user" }), true);
});

test("hydration is restored even when the callback throws", () => {
  const guard = createWriteGuard();
  assert.throws(() => guard.withHydration(() => { throw new Error("boom"); }), /boom/);
  assert.equal(guard.isHydrating(), false);
  assert.equal(guard.allow(), true);
});

test("budget counts calls and documents and latches a pause", () => {
  const guard = createWriteGuard({ maxCalls: 3, maxDocs: 100, pauseMs: 1000 });
  assert.equal(guard.allow({ label: "a", now: 0 }), true);
  assert.equal(guard.allow({ label: "b", now: 1 }), true);
  assert.equal(guard.allow({ label: "c", now: 2 }), true);
  assert.equal(guard.allow({ label: "d", now: 3 }), false);
  assert.equal(guard.stats(4).paused, true);
  assert.equal(guard.allow({ label: "e", now: 500 }), false, "stays paused for the full cooldown");
  assert.equal(guard.allow({ label: "f", now: 2000 }), true, "resumes once the cooldown passes");
});

test("a single batch counts its documents against the document budget", () => {
  const guard = createWriteGuard({ maxCalls: 100, maxDocs: 50, pauseMs: 1000 });
  assert.equal(guard.allow({ label: "batch", docs: 40, now: 0 }), true);
  assert.equal(guard.allow({ label: "batch", docs: 40, now: 10 }), false);
  assert.equal(guard.stats(11).paused, true);
});

test("the pause handler fires once per pause with the current stats", () => {
  const guard = createWriteGuard({ maxCalls: 1, maxDocs: 100, pauseMs: 500 });
  const seen = [];
  guard.setPauseHandler(stats => seen.push(stats));
  assert.equal(guard.allow({ label: "one", now: 0 }), true);
  guard.allow({ label: "two", now: 1 });
  guard.allow({ label: "three", now: 2 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].lastLabel, "two");
});

test("resume clears the pause and the rolling window", () => {
  const guard = createWriteGuard({ maxCalls: 1, maxDocs: 10, pauseMs: 10000 });
  guard.allow({ now: 0 });
  guard.allow({ now: 1 });
  assert.equal(guard.stats(2).paused, true);
  guard.resume(3);
  assert.equal(guard.stats(3).paused, false);
  assert.equal(guard.allow({ now: 4 }), true);
});

test("blocked snapshot writes are counted by label", () => {
  const guard = createWriteGuard();
  guard.withHydration(() => {
    guard.allow({ label: "direct-pair-tx" });
    guard.allow({ label: "direct-pair-tx" });
    guard.allow({ label: "roster" });
  });
  const stats = guard.stats();
  assert.equal(stats.blockedFromSnapshot, 3);
  assert.equal(stats.blockedByLabel["direct-pair-tx"], 2);
  assert.equal(stats.blockedByLabel.roster, 1);
});
