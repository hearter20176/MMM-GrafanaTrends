const test = require("node:test");
const assert = require("node:assert/strict");

const popup = require("../plant-alert-popup.js");

const CIRCLE = "●";
const TRIANGLE = "▲";
const SQUARE = "■";

const NOW = new Date(2026, 9, 12, 16, 0, 0).getTime();
const localIso = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0).toISOString();

const kitchenLost = {
  key: "connection_lost:kitchen:soil_sensor",
  zone: "kitchen",
  zoneName: "Kitchen",
  glyph: SQUARE,
  kind: "connection_lost",
  device: "soil_sensor",
  since: localIso(2026, 9, 12, 14, 5),
  detail: ""
};
const diningEmpty = {
  key: "reservoir_empty:dining_room:-",
  zone: "dining_room",
  zoneName: "Dining Room",
  glyph: TRIANGLE,
  kind: "reservoir_empty",
  device: null,
  since: localIso(2026, 9, 12, 9, 40),
  detail: ""
};
const familyLost = {
  key: "connection_lost:family_room:waterer",
  zone: "family_room",
  zoneName: "Family Room",
  glyph: CIRCLE,
  kind: "connection_lost",
  device: "waterer",
  since: null,
  detail: ""
};
const monitor = { glyph: "!", reason: "Home Assistant unreachable" };

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

test("escapeHtml: neutralizes tags, entities, and quotes", () => {
  assert.equal(popup.escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(popup.escapeHtml("&amp;"), "&amp;amp;");
  assert.equal(popup.escapeHtml("\"a\" 'b'"), "&quot;a&quot; &#39;b&#39;");
});

test("escapeHtml: null and undefined give an empty string, numbers are stringified", () => {
  assert.equal(popup.escapeHtml(null), "");
  assert.equal(popup.escapeHtml(undefined), "");
  assert.equal(popup.escapeHtml(42), "42");
});

// ---------------------------------------------------------------------------
// formatSince / formatLine
// ---------------------------------------------------------------------------

test("formatSince: same local day gives HH:MM", () => {
  assert.match(popup.formatSince(localIso(2026, 9, 12, 9, 40), NOW), /^\d{2}:\d{2}$/);
  assert.equal(popup.formatSince(localIso(2026, 9, 12, 9, 5), NOW), "09:05");
});

test("formatSince: another day gives Mon D HH:MM", () => {
  assert.equal(popup.formatSince(localIso(2026, 9, 11, 23, 30), NOW), "Oct 11 23:30");
  assert.match(popup.formatSince(localIso(2026, 0, 3, 8, 0), NOW), /^Jan 3 08:00$/);
});

test("formatSince: invalid input gives an empty string", () => {
  assert.equal(popup.formatSince("not a date", NOW), "");
  assert.equal(popup.formatSince(null, NOW), "");
  assert.equal(popup.formatSince("", NOW), "");
  assert.equal(popup.formatSince(12345, NOW), "");
});

test("formatLine: device and reservoir wording", () => {
  assert.equal(popup.formatLine(kitchenLost, NOW), "Kitchen - soil sensor offline since 14:05");
  assert.equal(popup.formatLine(diningEmpty, NOW), "Dining Room - reservoir may be empty since 09:40");
  assert.equal(popup.formatLine(familyLost, NOW), "Family Room - waterer offline");
  assert.equal(
    popup.formatLine(Object.assign({}, kitchenLost, { device: null, since: null }), NOW),
    "Kitchen - device offline"
  );
});

test("formatLine: a non-empty detail is appended in parentheses", () => {
  const line = popup.formatLine(Object.assign({}, kitchenLost, { detail: "no report for 3 h" }), NOW);
  assert.equal(line, "Kitchen - soil sensor offline since 14:05 (no report for 3 h)");
});

// ---------------------------------------------------------------------------
// buildLines / buildShowAlertPayload
// ---------------------------------------------------------------------------

test("buildLines: monitor first, then alerts in received order", () => {
  const lines = popup.buildLines({ alerts: [kitchenLost, diningEmpty], monitor }, NOW);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].isMonitor, true);
  assert.equal(lines[0].glyph, "!");
  assert.equal(lines[0].text, "Plant alerts not monitored - Home Assistant unreachable");
  assert.equal(lines[1].key, kitchenLost.key);
  assert.equal(lines[2].key, diningEmpty.key);
});

test("buildShowAlertPayload: type alert, no timer, no imageFA", () => {
  const payload = popup.buildShowAlertPayload(popup.buildLines({ alerts: [kitchenLost], monitor: null }, NOW));
  assert.equal(payload.type, "alert");
  assert.equal(payload.title, "Plant alert");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "timer"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "imageFA"), false);
});

test("buildShowAlertPayload: HA-provided strings are escaped", () => {
  const evil = Object.assign({}, kitchenLost, {
    zoneName: "<img src=x onerror=alert(1)>",
    detail: "<script>alert(1)</script> & more",
    glyph: "<b>"
  });
  const payload = popup.buildShowAlertPayload(popup.buildLines({ alerts: [evil], monitor: null }, NOW));
  assert.ok(!payload.message.includes("<script>"));
  assert.ok(!payload.message.includes("<img"));
  assert.ok(!payload.message.includes("<b>"));
  assert.ok(payload.message.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more"));
});

test("buildShowAlertPayload: one line per alert, monitor line first, glyph span leads the line", () => {
  const payload = popup.buildShowAlertPayload(
    popup.buildLines({ alerts: [diningEmpty, kitchenLost], monitor }, NOW)
  );
  const lines = payload.message.match(/<div class="grafana-trends-popup-line[^"]*">/g);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("grafana-trends-popup-monitor"));
  assert.ok(!lines[1].includes("grafana-trends-popup-monitor"));
  assert.ok(payload.message.includes(`<span class="grafana-trends-glyph">${TRIANGLE}</span> Dining Room`));
  assert.ok(payload.message.includes(`<span class="grafana-trends-glyph">${SQUARE}</span> Kitchen`));
  assert.ok(payload.message.indexOf("not monitored") < payload.message.indexOf("Dining Room"));
});

test("buildRecoveryPayload: titles and timer", () => {
  assert.deepEqual(popup.buildRecoveryPayload(true), {
    type: "notification",
    title: "Plant alerts cleared",
    message: "",
    timer: 10000
  });
  assert.equal(popup.buildRecoveryPayload(false).title, "Plant alert monitoring restored");
});

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const makeHarness = (extra = {}) => {
  let clock = 0;
  let nextId = 1;
  const timers = new Map();
  const sent = [];
  const opts = Object.assign(
    {
      send: (n, p) => sent.push({ n, p }),
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { fn, at: clock + ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
      now: () => NOW,
      durationMs: 1000,
      repeatMs: 5000,
      recoveryNotice: true
    },
    extra
  );
  const controller = popup.createPopupController(opts);
  const advance = (ms) => {
    const target = clock + ms;
    for (;;) {
      let nextId2 = null;
      let nextAt = Infinity;
      timers.forEach((t, id) => {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId2 = id;
        }
      });
      if (nextId2 === null) break;
      const t = timers.get(nextId2);
      timers.delete(nextId2);
      clock = t.at;
      t.fn();
    }
    clock = target;
  };
  const names = () => sent.map((s) => s.n);
  return { controller, sent, timers, advance, names };
};

const lineCount = (payload) => (payload.message.match(/grafana-trends-popup-line/g) || []).length;

test("controller: gaining an alert shows exactly one SHOW_ALERT", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  assert.deepEqual(h.names(), ["SHOW_ALERT"]);
  assert.equal(h.sent[0].p.type, "alert");
});

test("controller: hides after durationMs and shows again after repeatMs", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  h.advance(999);
  assert.deepEqual(h.names(), ["SHOW_ALERT"]);
  h.advance(1);
  assert.deepEqual(h.names(), ["SHOW_ALERT", "HIDE_ALERT"]);
  h.advance(4000);
  assert.deepEqual(h.names(), ["SHOW_ALERT", "HIDE_ALERT", "SHOW_ALERT"]);
  // and the cycle continues
  h.advance(1000);
  h.advance(4000);
  assert.deepEqual(h.names().slice(-2), ["HIDE_ALERT", "SHOW_ALERT"]);
});

test("controller: an empty set gives an immediate HIDE plus a recovery notification", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  h.controller.update({ alerts: [], monitor: null });
  assert.deepEqual(h.names(), ["SHOW_ALERT", "HIDE_ALERT", "SHOW_ALERT"]);
  assert.equal(h.sent[2].p.type, "notification");
  assert.equal(h.sent[2].p.title, "Plant alerts cleared");
  assert.equal(h.timers.size, 0);
});

test("controller: no recovery notification when disabled", () => {
  const h = makeHarness({ recoveryNotice: false });
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  h.controller.update({ alerts: [], monitor: null });
  assert.deepEqual(h.names(), ["SHOW_ALERT", "HIDE_ALERT"]);
});

test("controller: clearing a monitor-only state gives the monitoring-restored title", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [], monitor });
  h.controller.update({ alerts: [], monitor: null });
  assert.equal(h.sent[h.sent.length - 1].p.title, "Plant alert monitoring restored");
});

test("controller: an empty set that was already empty sends nothing", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [], monitor: null });
  assert.equal(h.sent.length, 0);
});

test("controller: two alerts in one update give one SHOW with 2 lines", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost, diningEmpty], monitor: null });
  assert.deepEqual(h.names(), ["SHOW_ALERT"]);
  assert.equal(lineCount(h.sent[0].p), 2);
});

test("controller: a second alert gained while visible gives HIDE then SHOW with 2 lines and restarts timers", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  h.advance(600);
  h.controller.update({ alerts: [kitchenLost, diningEmpty], monitor: null });
  assert.deepEqual(h.names(), ["SHOW_ALERT", "HIDE_ALERT", "SHOW_ALERT"]);
  assert.equal(lineCount(h.sent[2].p), 2);
  // hide timer restarted: 600 ms after the second show is not yet a hide
  h.advance(600);
  assert.equal(h.names().length, 3);
  h.advance(400);
  assert.equal(h.names()[3], "HIDE_ALERT");
});

test("controller: a loss while visible re-renders without restarting the timers", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost, diningEmpty], monitor: null });
  h.advance(600);
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  assert.deepEqual(h.names(), ["SHOW_ALERT", "HIDE_ALERT", "SHOW_ALERT"]);
  assert.equal(lineCount(h.sent[2].p), 1);
  // original hide timer still fires 400 ms later
  h.advance(400);
  assert.equal(h.names()[3], "HIDE_ALERT");
});

test("controller: a loss while hidden sends nothing", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost, diningEmpty], monitor: null });
  h.advance(1000);
  const before = h.sent.length;
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  assert.equal(h.sent.length, before);
});

test("controller: the repeat shows the current set, not the one from the last gain", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost, diningEmpty], monitor: null });
  h.advance(1000);
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  h.advance(4000);
  const last = h.sent[h.sent.length - 1];
  assert.equal(last.n, "SHOW_ALERT");
  assert.equal(lineCount(last.p), 1);
});

test("controller: durationMs 0 never hides until cleared", () => {
  const h = makeHarness({ durationMs: 0, repeatMs: 0 });
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  h.advance(10 * 60 * 1000);
  assert.deepEqual(h.names(), ["SHOW_ALERT"]);
  assert.equal(h.timers.size, 0);
  h.controller.update({ alerts: [], monitor: null });
  assert.equal(h.names()[1], "HIDE_ALERT");
});

test("controller: repeatMs 0 never repeats", () => {
  const h = makeHarness({ repeatMs: 0 });
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  h.advance(60 * 60 * 1000);
  assert.deepEqual(h.names(), ["SHOW_ALERT", "HIDE_ALERT"]);
});

test("controller: an identical update sends nothing", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  h.controller.update({ alerts: [Object.assign({}, kitchenLost)], monitor: null });
  assert.deepEqual(h.names(), ["SHOW_ALERT"]);
});

test("controller: destroy() clears the timers and hides a visible popup", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost], monitor: null });
  h.controller.destroy();
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.names(), ["SHOW_ALERT", "HIDE_ALERT"]);
});

test("controller: destroy() when nothing is visible sends nothing", () => {
  const h = makeHarness();
  h.controller.destroy();
  assert.equal(h.sent.length, 0);
});

test("no emitted payload contains U+FE0F or U+FE0E", () => {
  const h = makeHarness();
  h.controller.update({ alerts: [kitchenLost, diningEmpty, familyLost], monitor });
  h.controller.update({ alerts: [], monitor: null });
  for (const s of h.sent) {
    const text = JSON.stringify(s.p);
    assert.ok(!text.includes("\uFE0F"));
    assert.ok(!text.includes("\uFE0E"));
  }
});

test("buildShowAlertPayload: severity modifier classes come from an allowlist of kinds", () => {
  const hostile = Object.assign({}, kitchenLost, { key: "x", kind: "\"><script>alert(1)</script>" });
  const proto = Object.assign({}, kitchenLost, { key: "y", kind: "__proto__" });
  const payload = popup.buildShowAlertPayload(
    popup.buildLines({ alerts: [kitchenLost, diningEmpty, hostile, proto], monitor }, NOW)
  );
  const lineClasses = payload.message.match(/<div class="grafana-trends-popup-line[^"]*">/g);
  assert.equal(lineClasses[0], '<div class="grafana-trends-popup-line grafana-trends-popup-monitor">');
  assert.equal(lineClasses[1], '<div class="grafana-trends-popup-line grafana-trends-popup-connection_lost">');
  assert.equal(lineClasses[2], '<div class="grafana-trends-popup-line grafana-trends-popup-reservoir_empty">');
  assert.equal(lineClasses[3], '<div class="grafana-trends-popup-line">');
  assert.equal(lineClasses[4], '<div class="grafana-trends-popup-line">');
  assert.ok(!payload.message.includes("<script>"));
});
