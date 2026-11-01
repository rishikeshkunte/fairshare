/**
 * Client-side write guard for Firestore.
 *
 * Layer 1: a snapshot listener is never allowed to cause a remote write. The
 *   guard tracks whether a listener callback is running ("hydration") and
 *   refuses writes from inside that call stack.
 * Layer 2: a per-minute budget on write calls and documents submitted, so a
 *   loop that survives the hydration guard cannot drain the daily quota before
 *   the user notices.
 *
 * Pure module: no DOM, no Firebase, no timers. Time is injectable so tests can
 * drive it deterministically.
 */

const DEFAULTS = {
  windowMs: 60 * 1000,
  maxCalls: 120,
  maxDocs: 1500,
  pauseMs: 5 * 60 * 1000
};

export function createWriteGuard(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const state = {
    windowStart: 0,
    calls: 0,
    docs: 0,
    blockedUntil: 0,
    hydrationDepth: 0,
    blockedFromSnapshot: 0,
    blockedByLabel: {},
    pauses: 0,
    lastLabel: ""
  };
  let onPause = null;

  function roll(now) {
    if (now - state.windowStart > config.windowMs) {
      state.windowStart = now;
      state.calls = 0;
      state.docs = 0;
    }
  }

  function snapshot(now) {
    roll(now);
    return {
      calls: state.calls,
      docs: state.docs,
      paused: now < state.blockedUntil,
      pausedUntil: state.blockedUntil,
      pauses: state.pauses,
      blockedFromSnapshot: state.blockedFromSnapshot,
      blockedByLabel: { ...state.blockedByLabel },
      lastLabel: state.lastLabel,
      hydrating: state.hydrationDepth > 0
    };
  }

  const guard = {
    withHydration(fn) {
      state.hydrationDepth += 1;
      try {
        return fn();
      } finally {
        state.hydrationDepth -= 1;
      }
    },
    isHydrating() {
      return state.hydrationDepth > 0;
    },
    allow({ label = "write", docs = 1, now = Date.now() } = {}) {
      if (state.hydrationDepth > 0) {
        state.blockedFromSnapshot += 1;
        state.blockedByLabel[label] = (state.blockedByLabel[label] || 0) + 1;
        state.lastLabel = label;
        return false;
      }
      if (state.blockedUntil) {
        if (now < state.blockedUntil) return false;
        // Cooldown finished: start a fresh budget window.
        state.blockedUntil = 0;
        state.windowStart = now;
        state.calls = 0;
        state.docs = 0;
      }
      roll(now);
      state.calls += 1;
      state.docs += Math.max(1, docs);
      state.lastLabel = label;
      if (state.calls > config.maxCalls || state.docs > config.maxDocs) {
        state.blockedUntil = now + config.pauseMs;
        state.pauses += 1;
        if (onPause) {
          try { onPause(snapshot(now)); } catch { /* ignore listener errors */ }
        }
        return false;
      }
      return true;
    },
    resume(now = Date.now()) {
      state.blockedUntil = 0;
      state.windowStart = now;
      state.calls = 0;
      state.docs = 0;
    },
    setPauseHandler(fn) {
      onPause = typeof fn === "function" ? fn : null;
    },
    stats(now = Date.now()) {
      return snapshot(now);
    },
    config: { ...config }
  };

  return guard;
}
