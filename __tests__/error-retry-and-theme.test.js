const test = require("node:test");
const assert = require("node:assert/strict");

global.Module = { register: (_name, def) => { global.__mod = def; } };
global.Log = { info: () => {}, warn: () => {}, error: () => {} };
global.window = { location: { href: "http://localhost/" } };

const makeClassList = (classes) => ({
  contains: (name) => classes.has(name)
});

global.document = { body: { classList: makeClassList(new Set()) } };

require("../MMM-GrafanaTrends.js");
const mod = global.__mod;

const makeCtx = (overrides = {}) =>
  Object.assign(
    {
      name: "MMM-GrafanaTrends",
      defaults: mod.defaults,
      config: Object.assign({}, mod.defaults, { url: "http://grafana.local/d/x?kiosk" }),
      iframe: { src: "" },
      messageEl: { textContent: "", style: { display: "none" } },
      theme: "dark",
      hidden: false,
      pendingReload: false,
      loadTimer: null,
      retryTimer: null,
      retryCount: 0,
      _mirrorTheme: mod._mirrorTheme,
      _buildUrl: mod._buildUrl,
      _load: mod._load,
      _handleLoadSuccess: mod._handleLoadSuccess,
      _handleLoadFailure: mod._handleLoadFailure,
      _showMessage: mod._showMessage,
      _hideMessage: mod._hideMessage,
      _clearTimers: mod._clearTimers,
      suspend: mod.suspend,
      resume: mod.resume,
      socketNotificationReceived: mod.socketNotificationReceived,
      start: mod.start,
      _clampRetryConfig: mod._clampRetryConfig,
      _coerceDelayMs: mod._coerceDelayMs,
      _resolveProbeUrl: mod._resolveProbeUrl,
      identifier: "module_1",
      requestId: 0
    },
    overrides
  );

test("defaults: height fits the 44-row dashboard (~1664px)", () => {
  assert.equal(mod.defaults.height, 1664);
});

test("_buildUrl: sets the theme query param from this.theme", () => {
  const ctx = makeCtx({ theme: "light" });
  const url = new URL(ctx._buildUrl.call(ctx));
  assert.equal(url.searchParams.get("theme"), "light");
});

test("notificationReceived: PAGE_THEME_CHANGED day maps to light and triggers a reload", () => {
  let loadedWithTheme = null;
  const ctx = makeCtx({
    theme: "dark",
    _load() {
      loadedWithTheme = this.theme;
    }
  });

  mod.notificationReceived.call(ctx, "PAGE_THEME_CHANGED", { mode: "day" });

  assert.equal(ctx.theme, "light");
  assert.equal(loadedWithTheme, "light");
});

test("notificationReceived: PAGE_THEME_CHANGED night maps to dark", () => {
  const ctx = makeCtx({ theme: "light", _load() {} });
  mod.notificationReceived.call(ctx, "PAGE_THEME_CHANGED", { mode: "night" });
  assert.equal(ctx.theme, "dark");
});

test("notificationReceived: ignored when followMirrorTheme is false", () => {
  let loadCalls = 0;
  const ctx = makeCtx({
    theme: "dark",
    config: Object.assign({}, mod.defaults, { followMirrorTheme: false }),
    _load() {
      loadCalls += 1;
    }
  });
  mod.notificationReceived.call(ctx, "PAGE_THEME_CHANGED", { mode: "day" });
  assert.equal(ctx.theme, "dark");
  assert.equal(loadCalls, 0);
});

test("_load: skips loading and defers when hidden and unloadWhenHidden is set", () => {
  const ctx = makeCtx({
    hidden: true,
    config: Object.assign({}, mod.defaults, { url: "http://grafana.local/d/x?kiosk", unloadWhenHidden: true })
  });
  ctx._load();
  assert.equal(ctx.pendingReload, true);
  assert.equal(ctx.iframe.src, "");
});

test("_handleLoadFailure: shows an error message and schedules a retry sooner than reloadInterval", () => {
  const ctx = makeCtx({ retryCount: 0 });
  let scheduledDelay = null;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (_fn, delay) => {
    scheduledDelay = delay;
    return 0;
  };

  ctx._handleLoadFailure("timed out");

  assert.equal(ctx.messageEl.style.display, "flex");
  assert.match(ctx.messageEl.textContent, /unavailable/i);
  assert.equal(ctx.retryCount, 1);
  assert.equal(scheduledDelay, mod.defaults.retryDelayMs);
  assert.ok(scheduledDelay < mod.defaults.reloadInterval);

  global.setTimeout = originalSetTimeout;
});

test("_handleLoadFailure: backoff doubles on consecutive failures up to the cap", () => {
  const ctx = makeCtx({ retryCount: 3 });
  let scheduledDelay = null;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (_fn, delay) => {
    scheduledDelay = delay;
    return 0;
  };

  ctx._handleLoadFailure("timed out");

  const expected = Math.min(mod.defaults.retryDelayMs * Math.pow(2, 3), mod.defaults.maxRetryDelayMs);
  assert.equal(scheduledDelay, expected);

  global.setTimeout = originalSetTimeout;
});

test("_handleLoadSuccess: clears the message and resets the retry backoff", () => {
  const ctx = makeCtx({
    retryCount: 4,
    messageEl: { textContent: "Grafana is unavailable", style: { display: "block" } }
  });
  ctx._handleLoadSuccess();
  assert.equal(ctx.retryCount, 0);
  assert.equal(ctx.messageEl.style.display, "none");
});

// ---------------------------------------------------------------------------
// suspend()/resume(): a page hidden while unloadWhenHidden is set must reload
// when it's shown again, not just when a theme/interval tick happened to land
// while it was hidden (r1 regression: resume() only reloaded pendingReload).
// ---------------------------------------------------------------------------

test("suspend() then resume(): reloads even when nothing else set pendingReload while hidden", () => {
  let loadCalls = 0;
  const ctx = makeCtx({
    config: Object.assign({}, mod.defaults, { url: "http://grafana.local/d/x?kiosk", unloadWhenHidden: true }),
    iframe: { src: "http://grafana.local/d/x?kiosk&theme=dark" },
    _load() {
      loadCalls += 1;
    },
    _clearTimers() {}
  });

  ctx.suspend();
  assert.equal(ctx.iframe.src, "about:blank");

  ctx.resume();

  assert.equal(loadCalls, 1);
});

test("suspend(): does nothing when unloadWhenHidden is off (iframe keeps running)", () => {
  let loadCalls = 0;
  const ctx = makeCtx({
    config: Object.assign({}, mod.defaults, { url: "http://grafana.local/d/x?kiosk", unloadWhenHidden: false }),
    iframe: { src: "http://grafana.local/d/x?kiosk&theme=dark" },
    _load() {
      loadCalls += 1;
    }
  });

  ctx.suspend();
  assert.notEqual(ctx.iframe.src, "about:blank");

  ctx.resume();
  assert.equal(loadCalls, 0);
});

// ---------------------------------------------------------------------------
// _showMessage: must not fight the card's flex centring with an inline
// display: block (r2 regression - the overlay text pinned to the top).
// ---------------------------------------------------------------------------

test("_showMessage: sets display to flex, not block, so the overlay stays centered", () => {
  const ctx = makeCtx({ messageEl: { textContent: "", style: { display: "none" } } });
  ctx._showMessage("Grafana is unavailable - retrying in 60s");
  assert.equal(ctx.messageEl.style.display, "flex");
});

// ---------------------------------------------------------------------------
// Probe wiring: the node_helper reports real HTTP-level failures (blocked
// embedding, redirect to login, non-2xx) that a same-origin `load` event on
// the iframe can't detect.
// ---------------------------------------------------------------------------

test("socketNotificationReceived: GRAFANA_TRENDS_PROBE_RESULT ok:false triggers the error overlay + backoff", () => {
  let failureReason = null;
  const ctx = makeCtx({
    identifier: "module_1",
    _handleLoadFailure(reason) {
      failureReason = reason;
    },
    _handleLoadSuccess() {
      throw new Error("should not be called");
    }
  });

  ctx.socketNotificationReceived("GRAFANA_TRENDS_PROBE_RESULT", {
    identifier: "module_1",
    requestId: 0,
    ok: false,
    reason: "embedding blocked (X-Frame-Options)"
  });

  assert.equal(failureReason, "embedding blocked (X-Frame-Options)");
});

test("socketNotificationReceived: GRAFANA_TRENDS_PROBE_RESULT ok:true clears the overlay", () => {
  let successCalls = 0;
  const ctx = makeCtx({
    identifier: "module_1",
    _handleLoadSuccess() {
      successCalls += 1;
    },
    _handleLoadFailure() {
      throw new Error("should not be called");
    }
  });

  ctx.socketNotificationReceived("GRAFANA_TRENDS_PROBE_RESULT", { identifier: "module_1", requestId: 0, ok: true });

  assert.equal(successCalls, 1);
});

test("socketNotificationReceived: results for a different module identifier are ignored", () => {
  let calls = 0;
  const ctx = makeCtx({
    identifier: "module_1",
    _handleLoadFailure() {
      calls += 1;
    },
    _handleLoadSuccess() {
      calls += 1;
    }
  });

  ctx.socketNotificationReceived("GRAFANA_TRENDS_PROBE_RESULT", { identifier: "module_2", ok: false });

  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Request id: a probe result for a _load() that's no longer the latest one
// (e.g. a slow reply arriving after a newer theme-change reload) must not be
// allowed to flip the overlay/backoff state for the wrong request.
// ---------------------------------------------------------------------------

test("socketNotificationReceived: a stale requestId is ignored", () => {
  let calls = 0;
  const ctx = makeCtx({
    identifier: "module_1",
    requestId: 2, // the module has since moved on to its 2nd load
    _handleLoadFailure() {
      calls += 1;
    },
    _handleLoadSuccess() {
      calls += 1;
    }
  });

  // A reply for the 1st load, arriving late.
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PROBE_RESULT", {
    identifier: "module_1",
    requestId: 1,
    ok: false,
    reason: "network error"
  });

  assert.equal(calls, 0);
});

test("socketNotificationReceived: a reply matching the current requestId is applied", () => {
  let successCalls = 0;
  const ctx = makeCtx({
    identifier: "module_1",
    requestId: 2,
    _handleLoadSuccess() {
      successCalls += 1;
    },
    _handleLoadFailure() {
      throw new Error("should not be called");
    }
  });

  ctx.socketNotificationReceived("GRAFANA_TRENDS_PROBE_RESULT", { identifier: "module_1", requestId: 2, ok: true });

  assert.equal(successCalls, 1);
});

test("_load: tags each probe with an incrementing requestId", () => {
  const sent = [];
  // _load() schedules a real loadTimer (config.loadTimeoutMs); stub setTimeout so the
  // test doesn't leave a live 20s timer (and its _handleLoadFailure->retry chain)
  // running after the assertions, the way an earlier round's test once did.
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = () => 0;

  const ctx = makeCtx({
    requestId: 0,
    sendSocketNotification(notification, payload) {
      sent.push(payload);
    }
  });

  ctx._load();
  ctx._load();

  assert.equal(sent.length, 2);
  assert.equal(sent[0].requestId, 1);
  assert.equal(sent[1].requestId, 2);

  global.setTimeout = originalSetTimeout;
});

// ---------------------------------------------------------------------------
// Retry delay floor: a config of 0 (or anything unreasonably low) must not be
// able to turn a Grafana outage into a tight reload+probe loop.
// ---------------------------------------------------------------------------

test("_clampRetryConfig: floors retryDelayMs and maxRetryDelayMs at 5000ms", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { retryDelayMs: 0, maxRetryDelayMs: 0 }) });
  ctx._clampRetryConfig();
  assert.equal(ctx.config.retryDelayMs, 5000);
  assert.equal(ctx.config.maxRetryDelayMs, 5000);
});

test("_clampRetryConfig: leaves values at or above the floor untouched", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { retryDelayMs: 60000, maxRetryDelayMs: 600000 }) });
  ctx._clampRetryConfig();
  assert.equal(ctx.config.retryDelayMs, 60000);
  assert.equal(ctx.config.maxRetryDelayMs, 600000);
});

test("start(): calls _clampRetryConfig so a misconfigured 0 delay can't hammer Grafana", () => {
  const ctx = makeCtx({
    config: Object.assign({}, mod.defaults, { url: "http://grafana.local/d/x?kiosk", retryDelayMs: 0, reloadInterval: 0 })
  });
  ctx.start();
  assert.equal(ctx.config.retryDelayMs, 5000);
});

// ---------------------------------------------------------------------------
// _clampRetryConfig: a non-numeric config value (typo, e.g. "60s") must not
// produce NaN. Math.max(5000, NaN) is NaN, and setTimeout(fn, NaN) fires after
// about 1ms - the exact tight reload+probe loop the floor exists to prevent.
// ---------------------------------------------------------------------------

test("_clampRetryConfig: a non-numeric string (\"60s\") falls back to the default, then the floor", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { retryDelayMs: "60s", maxRetryDelayMs: "60s" }) });
  ctx._clampRetryConfig();
  assert.equal(ctx.config.retryDelayMs, mod.defaults.retryDelayMs);
  assert.equal(ctx.config.maxRetryDelayMs, mod.defaults.maxRetryDelayMs);
  assert.ok(Number.isFinite(ctx.config.retryDelayMs));
  assert.ok(Number.isFinite(ctx.config.maxRetryDelayMs));
});

test("_clampRetryConfig: null coerces to 0 (finite) and is floored, not treated as invalid", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { retryDelayMs: null, maxRetryDelayMs: null }) });
  ctx._clampRetryConfig();
  assert.equal(ctx.config.retryDelayMs, 5000);
  assert.equal(ctx.config.maxRetryDelayMs, 5000);
});

test("_clampRetryConfig: a literal NaN falls back to the default, then the floor", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { retryDelayMs: NaN, maxRetryDelayMs: NaN }) });
  ctx._clampRetryConfig();
  assert.equal(ctx.config.retryDelayMs, mod.defaults.retryDelayMs);
  assert.equal(ctx.config.maxRetryDelayMs, mod.defaults.maxRetryDelayMs);
  assert.ok(Number.isFinite(ctx.config.retryDelayMs));
  assert.ok(Number.isFinite(ctx.config.maxRetryDelayMs));
});

test("_clampRetryConfig: never produces a NaN delay regardless of input shape", () => {
  for (const bad of ["60s", null, NaN, undefined, "", "abc", {}, []]) {
    const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { retryDelayMs: bad, maxRetryDelayMs: bad }) });
    ctx._clampRetryConfig();
    assert.ok(Number.isFinite(ctx.config.retryDelayMs), `retryDelayMs was not finite for input ${String(bad)}`);
    assert.ok(Number.isFinite(ctx.config.maxRetryDelayMs), `maxRetryDelayMs was not finite for input ${String(bad)}`);
    assert.ok(ctx.config.retryDelayMs >= 5000);
    assert.ok(ctx.config.maxRetryDelayMs >= 5000);
  }
});

// ---------------------------------------------------------------------------
// reloadInterval: the same floor applies, except 0 is a deliberate "never
// reload" and must be left alone.
// ---------------------------------------------------------------------------

test("_clampRetryConfig: floors a too-small positive reloadInterval at 60s", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { reloadInterval: 1000 }) });
  ctx._clampRetryConfig();
  assert.equal(ctx.config.reloadInterval, 60000);
});

test("_clampRetryConfig: leaves reloadInterval: 0 (disabled) untouched", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { reloadInterval: 0 }) });
  ctx._clampRetryConfig();
  assert.equal(ctx.config.reloadInterval, 0);
});

test("_clampRetryConfig: a non-numeric reloadInterval falls back to the default, then the floor", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { reloadInterval: "6h" }) });
  ctx._clampRetryConfig();
  assert.equal(ctx.config.reloadInterval, mod.defaults.reloadInterval);
});

test("_clampRetryConfig: leaves a reloadInterval already above the floor untouched", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { reloadInterval: mod.defaults.reloadInterval }) });
  ctx._clampRetryConfig();
  assert.equal(ctx.config.reloadInterval, mod.defaults.reloadInterval);
});

// ---------------------------------------------------------------------------
// _resolveProbeUrl: a relative/reverse-proxy config.url must resolve against
// the page origin the same way _buildUrl() already resolves it for the
// iframe, instead of the helper's `new URL()` throwing "invalid dashboard url"
// for a setup the iframe itself accepts fine.
// ---------------------------------------------------------------------------

test("_resolveProbeUrl: resolves a relative config.url against window.location.href", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { url: "/grafana/d/x?kiosk" }) });
  const resolved = ctx._resolveProbeUrl();
  assert.equal(resolved, "http://localhost/grafana/d/x?kiosk");
});

test("_resolveProbeUrl: leaves an already-absolute config.url as an absolute url", () => {
  const ctx = makeCtx({ config: Object.assign({}, mod.defaults, { url: "http://grafana.local/d/x?kiosk" }) });
  const resolved = ctx._resolveProbeUrl();
  assert.equal(resolved, "http://grafana.local/d/x?kiosk");
});
