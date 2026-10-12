const test = require("node:test");
const assert = require("node:assert/strict");

const logs = { info: [], warn: [], error: [] };
global.Module = { register: (_name, def) => { global.__mod = def; } };
global.Log = {
  info: (m) => logs.info.push(String(m)),
  warn: (m) => logs.warn.push(String(m)),
  error: (m) => logs.error.push(String(m))
};
global.window = { location: { href: "http://localhost/" } };
// The popup controller schedules real timers through global setTimeout; neutralize them so
// nothing keeps the test process alive (each test file runs in its own process).
// Timers are captured (never run by the clock) so tests can fire them by delay.
let timerQueue = [];
let timerId = 1;
global.setTimeout = (fn, ms) => {
  const id = timerId++;
  timerQueue.push({ id, fn, ms });
  return id;
};
global.clearTimeout = (id) => {
  timerQueue = timerQueue.filter((t) => t.id !== id);
};
const pending = (ms) => timerQueue.filter((t) => t.ms === ms);
const fire = (ms) => {
  const t = pending(ms)[0];
  assert.ok(t, `no pending timer with delay ${ms}`);
  timerQueue = timerQueue.filter((x) => x.id !== t.id);
  t.fn();
};
global.document = { body: { classList: { contains: () => false } } };

require("../MMM-GrafanaTrends.js");
const mod = global.__mod;
const popup = require("../plant-alert-popup.js");

const SENTINEL_URL = "http://secret-ha.example:8123";

const resetLogs = () => {
  logs.info.length = 0;
  logs.warn.length = 0;
  logs.error.length = 0;
};

const makeCtx = (configOverrides = {}, overrides = {}) => {
  const sockets = [];
  const notifications = [];
  const ctx = Object.assign(
    {
      name: "MMM-GrafanaTrends",
      defaults: mod.defaults,
      config: Object.assign({}, mod.defaults, { url: "http://grafana.local/d/x?kiosk" }, configOverrides),
      identifier: "module_7_MMM-GrafanaTrends",
      requestId: 0,
      _mirrorTheme: mod._mirrorTheme,
      _clampRetryConfig: mod._clampRetryConfig,
      _coerceDelayMs: mod._coerceDelayMs,
      _clampPlantAlertConfig: mod._clampPlantAlertConfig,
      _startPlantAlerts: mod._startPlantAlerts,
      _sendPlantPopup: mod._sendPlantPopup,
      _handlePlantAlertState: mod._handlePlantAlertState,
      _setPlantNotice: mod._setPlantNotice,
      _armPlantWatchdog: mod._armPlantWatchdog,
      _plantWatchdogFired: mod._plantWatchdogFired,
      _plantGraceExpired: mod._plantGraceExpired,
      _sendPlantStart: mod._sendPlantStart,
      _load() {},
      start: mod.start,
      getDom: mod.getDom,
      socketNotificationReceived: mod.socketNotificationReceived,
      sendSocketNotification: (n, p) => sockets.push({ n, p }),
      sendNotification: (n, p) => notifications.push({ n, p }),
      sockets,
      notifications
    },
    overrides
  );
  return ctx;
};

// start() with timers stubbed so no real interval/timeout survives the test.
const startCtx = (ctx) => {
  const realSetInterval = global.setInterval;
  global.setInterval = () => 0;
  try {
    ctx.start();
  } finally {
    global.setInterval = realSetInterval;
  }
  return ctx;
};

const withPopup = (fn) => {
  global.GrafanaTrendsPlantAlertPopup = popup;
  try {
    return fn();
  } finally {
    delete global.GrafanaTrendsPlantAlertPopup;
  }
};

const alertA = {
  key: "connection_lost:kitchen:soil_sensor",
  zone: "kitchen",
  zoneName: "Kitchen",
  glyph: "■",
  kind: "connection_lost",
  device: "soil_sensor",
  since: null,
  detail: ""
};

const state = (extra) =>
  Object.assign(
    { identifier: "module_7_MMM-GrafanaTrends", seq: 1, status: "ok", alerts: [], monitor: null },
    extra
  );

// ---------------------------------------------------------------------------
// Defaults and disabled behaviour
// ---------------------------------------------------------------------------

test("defaults: height is still 1664 and alerts are off by default", () => {
  assert.equal(mod.defaults.height, 1664);
  assert.equal(mod.defaults.plantAlertsEnabled, false);
  assert.equal(mod.defaults.iframeTitle, "Grafana trends");
});

test("getScripts: loads plant-alert-popup.js", () => {
  const files = mod.getScripts.call({ file: (f) => `/modules/MMM-GrafanaTrends/${f}` });
  assert.deepEqual(files, ["/modules/MMM-GrafanaTrends/plant-alert-popup.js"]);
});

test("disabled (default): start() sends nothing and a STATE never produces a notification", () => {
  const ctx = withPopup(() => startCtx(makeCtx()));
  assert.equal(ctx.sockets.length, 0);
  assert.equal(ctx.plantAlerts, null);
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ alerts: [alertA] }));
  assert.equal(ctx.notifications.length, 0);
  assert.equal(ctx.sockets.length, 0);
});

test("disabled: start() calls no plant method (context without them still works)", () => {
  const ctx = makeCtx({}, {
    _clampPlantAlertConfig: undefined,
    _startPlantAlerts: undefined,
    _handlePlantAlertState: undefined
  });
  assert.doesNotThrow(() => startCtx(ctx));
});

test("plantAlertsEnabled must be exactly true", () => {
  const ctx = withPopup(() => startCtx(makeCtx({ plantAlertsEnabled: "true" })));
  assert.equal(ctx.sockets.length, 0);
});

// ---------------------------------------------------------------------------
// START payload
// ---------------------------------------------------------------------------

test("enabled: START carries identifier/entity/pollMs/timeoutMs/staleMs and nothing else", () => {
  const ctx = withPopup(() => startCtx(makeCtx({ plantAlertsEnabled: true })));
  assert.equal(ctx.sockets.length, 1);
  assert.equal(ctx.sockets[0].n, "GRAFANA_TRENDS_PLANT_ALERTS_START");
  assert.deepEqual(ctx.sockets[0].p, {
    identifier: "module_7_MMM-GrafanaTrends",
    entity: "sensor.mirror_plant_alerts",
    pollMs: 30000,
    timeoutMs: 10000,
    staleMs: 600000
  });
});

test("enabled: haUrl/haTokenFile in config warn once and never reach START", () => {
  resetLogs();
  const ctx = withPopup(() =>
    startCtx(makeCtx({ plantAlertsEnabled: true, haUrl: SENTINEL_URL, haTokenFile: "/tmp/secret-token-path" }))
  );
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /ignored/);
  assert.ok(!logs.warn[0].includes(SENTINEL_URL));
  assert.ok(!logs.warn[0].includes("secret-token-path"));
  const text = JSON.stringify(ctx.sockets[0].p);
  assert.ok(!text.includes(SENTINEL_URL));
  assert.ok(!/url|token/i.test(Object.keys(ctx.sockets[0].p).join(",")));
});

test("enabled but the popup script is missing: logs an error once, does not throw, sends no START", () => {
  resetLogs();
  delete global.GrafanaTrendsPlantAlertPopup;
  const ctx = makeCtx({ plantAlertsEnabled: true });
  assert.doesNotThrow(() => startCtx(ctx));
  assert.equal(logs.error.length, 1);
  assert.equal(ctx.sockets.length, 0);
  assert.equal(ctx.plantAlerts, null);
  assert.doesNotThrow(() =>
    ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ alerts: [alertA] }))
  );
});

// ---------------------------------------------------------------------------
// _clampPlantAlertConfig
// ---------------------------------------------------------------------------

const clamp = (cfg) => {
  const ctx = makeCtx(cfg);
  ctx._clampPlantAlertConfig();
  return ctx.config;
};

test("_clampPlantAlertConfig: defaults pass through unchanged", () => {
  const c = clamp({});
  assert.equal(c.plantAlertEntity, "sensor.mirror_plant_alerts");
  assert.equal(c.plantAlertPollMs, 30000);
  assert.equal(c.plantAlertTimeoutMs, 10000);
  assert.equal(c.plantAlertStaleMs, 600000);
  assert.equal(c.plantAlertPopupMs, 120000);
  assert.equal(c.plantAlertRepeatMs, 1800000);
  assert.equal(c.plantAlertRecoveryNotice, true);
});

test("_clampPlantAlertConfig: entity must match sensor.[a-z0-9_]+", () => {
  assert.equal(clamp({ plantAlertEntity: "sensor.my_plants2" }).plantAlertEntity, "sensor.my_plants2");
  for (const bad of ["switch.x", "sensor.Bad", "sensor.a/b", "sensor.", "", null, 5, "sensor.x?y=1"]) {
    assert.equal(clamp({ plantAlertEntity: bad }).plantAlertEntity, "sensor.mirror_plant_alerts", String(bad));
  }
});

test("_clampPlantAlertConfig: poll floor and non-numeric fallback", () => {
  assert.equal(clamp({ plantAlertPollMs: 0 }).plantAlertPollMs, 10000);
  assert.equal(clamp({ plantAlertPollMs: 500 }).plantAlertPollMs, 10000);
  assert.equal(clamp({ plantAlertPollMs: "30s" }).plantAlertPollMs, 30000);
  assert.equal(clamp({ plantAlertPollMs: NaN }).plantAlertPollMs, 30000);
  assert.equal(clamp({ plantAlertPollMs: 45000 }).plantAlertPollMs, 45000);
});

test("_clampPlantAlertConfig: timeout floor 2000 and cap pollMs - 1000", () => {
  assert.equal(clamp({ plantAlertTimeoutMs: 0 }).plantAlertTimeoutMs, 2000);
  assert.equal(clamp({ plantAlertTimeoutMs: 999999 }).plantAlertTimeoutMs, 29000);
  assert.equal(clamp({ plantAlertPollMs: 10000, plantAlertTimeoutMs: 10000 }).plantAlertTimeoutMs, 9000);
  assert.equal(clamp({ plantAlertTimeoutMs: "x" }).plantAlertTimeoutMs, 10000);
});

test("_clampPlantAlertConfig: stale floor is max(60000, 2 * poll)", () => {
  assert.equal(clamp({ plantAlertStaleMs: 1 }).plantAlertStaleMs, 60000);
  assert.equal(clamp({ plantAlertPollMs: 60000, plantAlertStaleMs: 1 }).plantAlertStaleMs, 120000);
  assert.equal(clamp({ plantAlertStaleMs: "x" }).plantAlertStaleMs, 600000);
});

test("_clampPlantAlertConfig: popup and repeat keep 0, otherwise floor", () => {
  assert.equal(clamp({ plantAlertPopupMs: 0 }).plantAlertPopupMs, 0);
  assert.equal(clamp({ plantAlertPopupMs: 100 }).plantAlertPopupMs, 5000);
  assert.equal(clamp({ plantAlertPopupMs: "x" }).plantAlertPopupMs, 120000);
  assert.equal(clamp({ plantAlertRepeatMs: 0 }).plantAlertRepeatMs, 0);
  assert.equal(clamp({ plantAlertRepeatMs: 100 }).plantAlertRepeatMs, 60000);
  assert.equal(clamp({ plantAlertRepeatMs: NaN }).plantAlertRepeatMs, 1800000);
});

test("_clampPlantAlertConfig: recovery notice is on unless exactly false", () => {
  assert.equal(clamp({ plantAlertRecoveryNotice: false }).plantAlertRecoveryNotice, false);
  assert.equal(clamp({ plantAlertRecoveryNotice: 0 }).plantAlertRecoveryNotice, true);
  assert.equal(clamp({ plantAlertRecoveryNotice: undefined }).plantAlertRecoveryNotice, true);
});

// ---------------------------------------------------------------------------
// STATE handling
// ---------------------------------------------------------------------------

const enabledCtx = (extra) => withPopup(() => startCtx(makeCtx(Object.assign({ plantAlertsEnabled: true }, extra))));

test("STATE: an alert reaches the core alert module via sendNotification", () => {
  const ctx = enabledCtx();
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ alerts: [alertA] }));
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].n, "SHOW_ALERT");
  assert.equal(ctx.notifications[0].p.type, "alert");
  assert.ok(ctx.notifications[0].p.message.includes("Kitchen"));
});

test("STATE: another identifier is ignored", () => {
  const ctx = enabledCtx();
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ identifier: "module_9", alerts: [alertA] }));
  assert.equal(ctx.notifications.length, 0);
});

test("STATE: a stale or repeated seq is ignored", () => {
  const ctx = enabledCtx();
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 5, alerts: [alertA] }));
  assert.equal(ctx.notifications.length, 1);
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 5, alerts: [] }));
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 4, alerts: [] }));
  assert.equal(ctx.notifications.length, 1);
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 6, alerts: [] }));
  assert.equal(ctx.notifications[1].n, "HIDE_ALERT");
});

test("STATE: rejected destroys the controller, warns once, and later states are ignored", () => {
  resetLogs();
  const ctx = enabledCtx();
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 1, alerts: [alertA] }));
  assert.equal(ctx.notifications.length, 1);
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 0, status: "rejected" }));
  assert.equal(ctx.plantAlerts, null);
  assert.equal(logs.warn.filter((m) => /owns plant alerts/.test(m)).length, 1);
  const before = ctx.notifications.length;
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 9, alerts: [alertA] }));
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 10, status: "rejected" }));
  assert.equal(ctx.notifications.length, before);
  assert.equal(logs.warn.filter((m) => /owns plant alerts/.test(m)).length, 1);
});

test("STATE: monitor produces a monitor line", () => {
  const ctx = enabledCtx();
  ctx.socketNotificationReceived(
    "GRAFANA_TRENDS_PLANT_ALERTS_STATE",
    state({ status: "stale", monitor: { glyph: "!", reason: "Home Assistant unreachable" } })
  );
  assert.equal(ctx.notifications.length, 1);
  assert.ok(ctx.notifications[0].p.message.includes("Plant alerts not monitored - Home Assistant unreachable"));
});

test("STATE: malformed payloads never throw", () => {
  const ctx = enabledCtx();
  const bad = [
    null,
    undefined,
    "x",
    42,
    {},
    state({ alerts: "x" }),
    state({ seq: 2, alerts: [null, 5, "x", alertA], monitor: "nope" }),
    state({ seq: "3" }),
    state({ seq: 4, alerts: [{}] })
  ];
  for (const p of bad) {
    assert.doesNotThrow(() => ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", p));
  }
});

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

test("notice: not_configured and auth_failed set textContent and show it; ok hides it", () => {
  const ctx = enabledCtx();
  ctx.plantNoticeEl = { textContent: "", style: { display: "none" } };

  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 1, status: "not_configured" }));
  assert.match(ctx.plantNoticeEl.textContent, /ha-alerts\.secret\.json/);
  assert.equal(ctx.plantNoticeEl.style.display, "block");

  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 2, status: "auth_failed" }));
  assert.match(ctx.plantNoticeEl.textContent, /rejected the token/);
  assert.equal(ctx.plantNoticeEl.style.display, "block");

  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 3, status: "ok" }));
  assert.equal(ctx.plantNoticeEl.style.display, "none");
  assert.equal(ctx.plantNoticeEl.textContent, "");
});

test("notice: state that arrives before getDom is cached and applied when the element is built", () => {
  const ctx = enabledCtx();
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ status: "auth_failed" }));
  const dom = fakeDocument();
  global.document = dom;
  try {
    ctx.getDom();
  } finally {
    global.document = { body: { classList: { contains: () => false } } };
  }
  assert.match(ctx.plantNoticeEl.textContent, /rejected the token/);
  assert.equal(ctx.plantNoticeEl.style.display, "block");
});

// ---------------------------------------------------------------------------
// getDom
// ---------------------------------------------------------------------------

function fakeDocument() {
  const makeEl = (tag) => {
    const el = {
      tag,
      className: "",
      textContent: "",
      style: {},
      attrs: {},
      children: [],
      appendChild(child) {
        el.children.push(child);
        return child;
      },
      setAttribute(k, v) {
        el.attrs[k] = v;
      },
      addEventListener() {}
    };
    return el;
  };
  return { body: { classList: { contains: () => false } }, createElement: makeEl };
}

const buildDom = (config) => {
  const ctx = makeCtx(config, { _load() {} });
  global.document = fakeDocument();
  try {
    const wrapper = ctx.getDom();
    return { ctx, wrapper };
  } finally {
    global.document = { body: { classList: { contains: () => false } } };
  }
};

const findFrame = (wrapper) => wrapper.children[0].children.find((c) => c.tag === "iframe");

test("getDom: iframe title defaults to Grafana trends", () => {
  const { wrapper } = buildDom({});
  assert.equal(findFrame(wrapper).attrs.title, "Grafana trends");
});

test("getDom: a custom iframeTitle is applied; an empty one falls back", () => {
  assert.equal(findFrame(buildDom({ iframeTitle: "Grafana plants" }).wrapper).attrs.title, "Grafana plants");
  assert.equal(findFrame(buildDom({ iframeTitle: "  " }).wrapper).attrs.title, "Grafana trends");
});

test("getDom: the notice only exists when alerts are enabled, starts hidden, and exists without a url", () => {
  const off = buildDom({});
  assert.equal(off.ctx.plantNoticeEl || null, null);

  const on = buildDom({ plantAlertsEnabled: true });
  const card = on.wrapper.children[0];
  const notice = card.children.find((c) => c.className === "grafana-trends-alert-notice");
  assert.ok(notice);
  assert.equal(notice.style.display, "none");

  const noUrl = buildDom({ plantAlertsEnabled: true, url: "" });
  const noUrlCard = noUrl.wrapper.children[0];
  assert.ok(noUrlCard.children.some((c) => c.className === "grafana-trends-alert-notice"));
});

test("suspend/resume do not touch the plant controller", () => {
  const ctx = enabledCtx();
  const controller = ctx.plantAlerts;
  mod.suspend.call(ctx);
  mod.resume.call(ctx);
  assert.equal(ctx.plantAlerts, controller);
});

// ---------------------------------------------------------------------------
// Numeric options: blank values fall back to the default, never to 0
// ---------------------------------------------------------------------------

test("_clampPlantAlertConfig: null and empty string fall back to the default, not 0", () => {
  for (const blank of [null, undefined, "", "   "]) {
    const c = clamp({
      plantAlertPollMs: blank,
      plantAlertTimeoutMs: blank,
      plantAlertStaleMs: blank,
      plantAlertPopupMs: blank,
      plantAlertRepeatMs: blank
    });
    assert.equal(c.plantAlertPollMs, 30000, String(blank));
    assert.equal(c.plantAlertTimeoutMs, 10000, String(blank));
    assert.equal(c.plantAlertStaleMs, 600000, String(blank));
    assert.equal(c.plantAlertPopupMs, 120000, String(blank));
    assert.equal(c.plantAlertRepeatMs, 1800000, String(blank));
  }
});

test("_clampPlantAlertConfig: only the explicit number 0 keeps its meaning", () => {
  assert.equal(clamp({ plantAlertPopupMs: 0 }).plantAlertPopupMs, 0);
  assert.equal(clamp({ plantAlertRepeatMs: 0 }).plantAlertRepeatMs, 0);
  assert.equal(clamp({ plantAlertPopupMs: "0" }).plantAlertPopupMs, 5000);
  assert.equal(clamp({ plantAlertRepeatMs: "0" }).plantAlertRepeatMs, 60000);
  assert.equal(clamp({ plantAlertPollMs: 0 }).plantAlertPollMs, 10000);
});

// ---------------------------------------------------------------------------
// Liveness watchdog and helper restart
// ---------------------------------------------------------------------------

const STALE = 600000;
const POLL = 30000;
const startsOf = (ctx) => ctx.sockets.filter((x) => x.n === "GRAFANA_TRENDS_PLANT_ALERTS_START");

test("watchdog: armed at start, silence re-sends the same START (no URL/token), then a local monitor after one poll period", () => {
  timerQueue = [];
  const ctx = enabledCtx();
  assert.equal(pending(STALE).length, 1);
  assert.equal(startsOf(ctx).length, 1);

  fire(STALE);
  assert.equal(startsOf(ctx).length, 2);
  assert.deepEqual(startsOf(ctx)[1].p, startsOf(ctx)[0].p);
  assert.equal(pending(STALE).length, 1, "watchdog re-armed, not a tight loop");
  assert.equal(pending(POLL).length, 1);
  assert.equal(ctx.notifications.length, 0);

  fire(POLL);
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].n, "SHOW_ALERT");
  assert.ok(ctx.notifications[0].p.message.includes("Plant alerts not monitored - helper not responding"));
  assert.equal(ctx.plantLocalMonitor, true);

  // still silent: next cycle re-sends START again, once per stale period
  fire(STALE);
  assert.equal(startsOf(ctx).length, 3);
});

test("watchdog: a STATE reply to the re-START cancels the local monitor and re-arms", () => {
  timerQueue = [];
  const ctx = enabledCtx();
  fire(STALE);
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 1, alerts: [] }));
  assert.equal(pending(POLL).length, 0);
  assert.equal(ctx.plantLocalMonitor, false);
  assert.equal(ctx.notifications.length, 0);
  assert.equal(pending(STALE).length, 1);
});

test("watchdog: any STATE resets the silence timer; local monitor clears on the next state", () => {
  timerQueue = [];
  const ctx = enabledCtx();
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 1, alerts: [alertA] }));
  assert.equal(pending(STALE).length, 1);
  fire(STALE);
  fire(POLL);
  assert.ok(ctx.notifications[ctx.notifications.length - 1].p.message.includes("helper not responding"));
  assert.ok(ctx.notifications[ctx.notifications.length - 1].p.message.includes("Kitchen"), "keeps last alerts");
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 2, alerts: [alertA] }));
  const last = ctx.notifications[ctx.notifications.length - 1];
  assert.ok(!last.p.message || !last.p.message.includes("helper not responding"));
  assert.equal(ctx.plantLocalMonitor, false);
});

test("watchdog: rejected cancels the timers; disabled instances never arm it", () => {
  timerQueue = [];
  const ctx = enabledCtx();
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 0, status: "rejected" }));
  assert.equal(pending(STALE).length, 0);
  timerQueue = [];
  withPopup(() => startCtx(makeCtx()));
  assert.equal(timerQueue.length, 0);
});

test("seq: a backwards seq with status starting is accepted (helper restart)", () => {
  const ctx = enabledCtx();
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 50, alerts: [alertA] }));
  const n = ctx.notifications.length;
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 1, status: "starting", alerts: [] }));
  assert.equal(ctx.plantLastSeq, 1);
  assert.ok(ctx.notifications.length > n, "empty set after restart produced a HIDE");
  // normal ordering resumes from the new baseline
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 2, alerts: [alertA] }));
  assert.equal(ctx.plantLastSeq, 2);
});

test("seq: a backwards seq after a watchdog re-START is accepted once; otherwise it is still dropped", () => {
  timerQueue = [];
  const ctx = enabledCtx();
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 50, alerts: [] }));
  // no resync pending: stale seq dropped
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 3, alerts: [alertA] }));
  assert.equal(ctx.plantLastSeq, 50);
  assert.equal(ctx.notifications.length, 0);
  fire(STALE);
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 1, status: "ok", alerts: [alertA] }));
  assert.equal(ctx.plantLastSeq, 1);
  assert.equal(ctx.notifications.length, 1);
  // resync flag consumed
  ctx.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_STATE", state({ seq: 1, alerts: [] }));
  assert.equal(ctx.notifications.length, 1);
});
