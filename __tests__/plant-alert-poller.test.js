/* Tests for plant-alert-poller.js, driven entirely by fakes: http/https, fs, a manual
 * scheduler and a manual clock. No real waits, no real network, no real files.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PlantAlertPoller } = require("../plant-alert-poller");

const SECRET_PATH = "/fake/ha-alerts.secret.json";
const SENTINEL_TOKEN = "SENTINEL-TOKEN-DO-NOT-LOG-0123456789";
const SECRET_URL_PATH = "/SECRET-BASE-PATH";
const DETAIL_TEXT = "DETAIL-TEXT-SENTINEL";
const POLL_MS = 30000;
const STALE_MS = 600000;

function secretText(overrides) {
  return JSON.stringify(Object.assign({ url: `http://ha.example:8123${SECRET_URL_PATH}`, token: SENTINEL_TOKEN }, overrides));
}

function stateBody(alerts, overrides) {
  return JSON.stringify(
    Object.assign({ state: String(alerts.length), attributes: { schema: 1, alerts } }, overrides)
  );
}

function alertEntry(overrides) {
  return Object.assign(
    {
      zone: "dining_room",
      symbol: "\u25B2",
      kind: "connection_lost",
      device: "waterer",
      since: "2026-10-12T14:05:00-04:00",
      detail: DETAIL_TEXT
    },
    overrides
  );
}

function makeHarness({ secret = secretText(), timings } = {}) {
  let clock = 1000000;
  const timers = [];
  let nextId = 1;

  const scheduler = {
    setTimeout(fn, ms) {
      const timer = { id: nextId++, at: clock + ms, fn };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const i = timers.findIndex((t) => t.id === id);
      if (i !== -1) timers.splice(i, 1);
    }
  };

  function advance(ms) {
    const target = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      clock = Math.max(clock, next.at);
      next.fn();
    }
    clock = target;
  }

  const files = new Map();
  if (secret !== null) files.set(SECRET_PATH, { text: secret, mtimeMs: 1 });
  const fs = {
    statSync(p) {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs: f.mtimeMs, size: Buffer.byteLength(f.text) };
    },
    readFileSync(p) {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return f.text;
    }
  };

  function makeClient(name) {
    return {
      name,
      calls: [],
      get(target, opts, cb) {
        const req = new EventEmitter();
        req.destroy = () => {
          req.destroyed = true;
        };
        this.calls.push({ target, opts, cb, req, done: false });
        return req;
      }
    };
  }
  const http = makeClient("http");
  const https = makeClient("https");

  const logs = [];
  const states = [];
  const poller = new PlantAlertPoller({
    http,
    https,
    fs,
    now: () => clock,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    log: {
      info: (m) => logs.push({ level: "info", m }),
      warn: (m) => logs.push({ level: "warn", m })
    },
    secretPath: SECRET_PATH,
    entity: "sensor.mirror_plant_alerts",
    timings: timings || { pollMs: POLL_MS, timeoutMs: 10000, staleMs: STALE_MS },
    onState: (s) => states.push(s)
  });

  const h = {
    poller,
    http,
    https,
    logs,
    states,
    timers,
    advance,
    files,
    get last() {
      return states[states.length - 1];
    },
    inflight() {
      return [...http.calls, ...https.calls].filter((c) => !c.done && !c.req.destroyed).length;
    },
    setSecret(text) {
      const prev = files.get(SECRET_PATH);
      files.set(SECRET_PATH, { text, mtimeMs: (prev ? prev.mtimeMs : 0) + 1 });
    },
    // answer the nth call on a client with a status and body
    answer(call, statusCode, text) {
      call.done = true;
      const res = new EventEmitter();
      res.statusCode = statusCode;
      call.cb(res);
      res.emit("data", Buffer.from(text));
      res.emit("end");
    },
    answerLatest(statusCode, text) {
      h.answer(http.calls[http.calls.length - 1], statusCode, text);
    },
    failLatest(code = "ECONNREFUSED") {
      const call = http.calls[http.calls.length - 1];
      call.done = true;
      call.req.emit("error", Object.assign(new Error(code), { code }));
    }
  };
  return h;
}

// Nothing the poller logs or emits may expose the token, headers, the request path or HA text.
function assertRedacted(h) {
  const logText = h.logs.map((l) => l.m).join("\n");
  const stateText = JSON.stringify(h.states);
  for (const text of [logText, stateText]) {
    assert.ok(!text.includes(SENTINEL_TOKEN), "token leaked");
    assert.ok(!text.includes("Bearer"), "auth header leaked");
    assert.ok(!text.includes(SECRET_URL_PATH), "secret url path leaked");
    assert.ok(!text.includes("api/states"), "request path leaked");
  }
  assert.ok(!logText.includes(DETAIL_TEXT), "HA detail text leaked into logs");
  for (const l of h.logs) {
    assert.match(l.m, /^\[MMM-GrafanaTrends\] plant alerts: (http:\/\/ha\.example:8123|-|https:\/\/ha\.example) \w+ \(.+\)$/);
  }
}

test("missing secret file: not_configured with an immediate monitor and no request; creating it resumes polling", () => {
  const h = makeHarness({ secret: null });
  h.poller.start();

  assert.equal(h.http.calls.length, 0);
  assert.equal(h.last.status, "not_configured");
  assert.deepEqual(h.last.monitor, { glyph: "!", reason: "not configured" });

  h.advance(60000);
  assert.equal(h.http.calls.length, 0, "no file yet, still no request");

  h.setSecret(secretText());
  h.advance(59999);
  assert.equal(h.http.calls.length, 0, "stat check is every 60 s");
  h.advance(1);
  assert.equal(h.http.calls.length, 1);

  h.answerLatest(200, stateBody([]));
  assert.equal(h.last.status, "ok");
  assert.equal(h.last.monitor, null);
  assertRedacted(h);
});

test("invalid secret file (placeholder token) behaves like a missing one", () => {
  const h = makeHarness({ secret: secretText({ token: "REPLACE_WITH_LONG_LIVED_TOKEN_FROM_A_DEDICATED_NON_ADMIN_HA_USER" }) });
  h.poller.start();
  assert.equal(h.http.calls.length, 0);
  assert.equal(h.last.status, "not_configured");
  assert.deepEqual(h.last.monitor, { glyph: "!", reason: "not configured" });
  assert.match(h.logs[0].m, /not_configured \(secret file invalid\)/);

  const garbage = makeHarness({ secret: "{ not json" });
  garbage.poller.start();
  assert.equal(garbage.http.calls.length, 0);
  assert.equal(garbage.last.status, "not_configured");
  assertRedacted(h);
  assertRedacted(garbage);
});

test("200 ok: sends the bearer token, next poll is exactly pollMs after it settles, one request in flight", () => {
  const h = makeHarness();
  h.poller.start();

  assert.equal(h.http.calls.length, 1);
  assert.equal(h.inflight(), 1);
  const call = h.http.calls[0];
  assert.equal(call.opts.headers.Authorization, `Bearer ${SENTINEL_TOKEN}`);
  assert.equal(call.opts.headers.Accept, "application/json");
  assert.equal(call.opts.timeout, 10000);
  assert.equal(call.target.pathname, `${SECRET_URL_PATH}/api/states/sensor.mirror_plant_alerts`);

  // a slow response: the poll period is measured from when it settles, not from when it began
  h.advance(5000);
  h.answerLatest(200, stateBody([alertEntry({})]));
  assert.equal(h.inflight(), 0);
  assert.equal(h.last.status, "ok");
  assert.equal(h.last.alerts.length, 1);
  assert.equal(h.last.alerts[0].glyph, "\u25B2");

  h.advance(POLL_MS - 1);
  assert.equal(h.http.calls.length, 1);
  h.advance(1);
  assert.equal(h.http.calls.length, 2);
  assert.equal(h.inflight(), 1);
  assertRedacted(h);
});

test("HA unreachable: degraded without a monitor before staleMs, stale with the monitor after, ok clears it", () => {
  const h = makeHarness();
  h.poller.start();
  h.failLatest();
  assert.equal(h.last.status, "degraded");
  assert.equal(h.last.monitor, null);

  let elapsed = 0;
  while (elapsed + POLL_MS < STALE_MS) {
    h.advance(POLL_MS);
    elapsed += POLL_MS;
    h.failLatest();
    assert.equal(h.last.status, "degraded", `still inside the window at ${elapsed} ms`);
    assert.equal(h.last.monitor, null);
  }

  h.advance(POLL_MS);
  elapsed += POLL_MS;
  h.failLatest();
  assert.equal(elapsed, STALE_MS);
  assert.equal(h.last.status, "stale");
  assert.deepEqual(h.last.monitor, { glyph: "!", reason: "Home Assistant unreachable" });

  h.advance(POLL_MS);
  h.answerLatest(200, stateBody([]));
  assert.equal(h.last.status, "ok");
  assert.equal(h.last.monitor, null);
  assertRedacted(h);
});

test("timeout: the request is destroyed and the poll is degraded", () => {
  const h = makeHarness();
  h.poller.start();
  const call = h.http.calls[0];
  call.req.emit("timeout");
  assert.equal(call.req.destroyed, true);
  assert.equal(h.last.status, "degraded");
  // the follow-up error from destroy() must not double-handle
  call.req.emit("error", new Error("socket hang up"));
  assert.equal(h.timers.length, 1);
  assert.match(h.logs[h.logs.length - 1].m, /degraded \(request timed out\)/);
  assertRedacted(h);
});

test("synchronous throw from client.get is degraded and polling continues", () => {
  const h = makeHarness();
  h.http.get = () => {
    throw new Error("boom");
  };
  h.poller.start();
  assert.equal(h.last.status, "degraded");
  assert.equal(h.timers.length, 1);
});

test("401: immediate auth_failed with monitor, polling stops, one warn; a secret change retries exactly once", () => {
  const h = makeHarness();
  h.poller.start();
  h.answerLatest(401, "");

  assert.equal(h.last.status, "auth_failed");
  assert.deepEqual(h.last.monitor, { glyph: "!", reason: "token rejected (HTTP 401)" });

  h.advance(POLL_MS * 10);
  assert.equal(h.http.calls.length, 1, "no further requests while terminal");
  assert.equal(h.logs.filter((l) => l.level === "warn").length, 1);

  h.setSecret(secretText({ token: `${SENTINEL_TOKEN}-rotated` }));
  h.advance(60000);
  assert.equal(h.http.calls.length, 2, "exactly one retry after the secret changed");
  h.answerLatest(401, "");
  assert.equal(h.last.status, "auth_failed");

  h.advance(POLL_MS * 10);
  assert.equal(h.http.calls.length, 2, "second 401 is terminal again");
  assertRedacted(h);
});

test("403 behaves like 401", () => {
  const h = makeHarness();
  h.poller.start();
  h.answerLatest(403, "");
  assert.equal(h.last.status, "auth_failed");
  assert.deepEqual(h.last.monitor, { glyph: "!", reason: "token rejected (HTTP 403)" });
  h.advance(POLL_MS * 10);
  assert.equal(h.http.calls.length, 1);
  assert.equal(h.logs.filter((l) => l.level === "warn").length, 1);
});

test("auth_failed then a fixed secret that polls ok recovers", () => {
  const h = makeHarness();
  h.poller.start();
  h.answerLatest(401, "");
  h.setSecret(secretText({ token: `${SENTINEL_TOKEN}-rotated` }));
  h.advance(60000);
  h.answerLatest(200, stateBody([]));
  assert.equal(h.last.status, "ok");
  assert.equal(h.last.monitor, null);
  h.advance(POLL_MS);
  assert.equal(h.http.calls.length, 3, "normal polling resumed");
});

test("malformed attributes keep the last good alerts; the monitor appears after staleMs", () => {
  const h = makeHarness();
  h.poller.start();
  h.answerLatest(200, stateBody([alertEntry({})]));
  assert.equal(h.last.alerts.length, 1);

  const bad = JSON.stringify({ state: "1", attributes: { schema: 1, alerts: "nope" } });
  let elapsed = 0;
  while (elapsed < STALE_MS) {
    h.advance(POLL_MS);
    elapsed += POLL_MS;
    h.answerLatest(200, bad);
    assert.equal(h.last.alerts.length, 1, "last good alerts stay on screen");
  }
  assert.equal(h.last.status, "stale");
  assert.deepEqual(h.last.monitor, { glyph: "!", reason: "malformed contract" });
  assertRedacted(h);
});

test("persistent count mismatch: alerts applied, then the monitor appears alongside them", () => {
  const h = makeHarness();
  h.poller.start();
  const mismatch = stateBody([alertEntry({})], { state: "2" });
  h.answerLatest(200, mismatch);
  assert.equal(h.last.status, "degraded");
  assert.equal(h.last.alerts.length, 1);
  assert.equal(h.last.monitor, null);

  let elapsed = 0;
  while (elapsed < STALE_MS) {
    h.advance(POLL_MS);
    elapsed += POLL_MS;
    h.answerLatest(200, mismatch);
  }
  assert.equal(h.last.status, "stale");
  assert.equal(h.last.alerts.length, 1);
  assert.deepEqual(h.last.monitor, { glyph: "!", reason: "alert count mismatch" });
});

test("response body over 64 KiB: the request is destroyed and the poll is degraded", () => {
  const h = makeHarness();
  h.poller.start();
  const call = h.http.calls[0];
  const res = new EventEmitter();
  res.statusCode = 200;
  call.cb(res);
  res.emit("data", Buffer.alloc(40 * 1024, "a"));
  assert.equal(call.req.destroyed, undefined);
  res.emit("data", Buffer.alloc(40 * 1024, "a"));
  assert.equal(call.req.destroyed, true);
  assert.equal(h.last.status, "degraded");
  assert.match(h.logs[h.logs.length - 1].m, /response too large/);
  res.emit("end");
  assert.equal(h.states.length, 1, "the late end event is ignored");
});

test("onState fires only on change: three identical 200s emit once", () => {
  const h = makeHarness();
  h.poller.start();
  for (let i = 0; i < 3; i += 1) {
    h.answerLatest(200, stateBody([alertEntry({})]));
    h.advance(POLL_MS);
  }
  assert.equal(h.states.length, 1);
  assert.equal(h.logs.length, 1, "one transition log, not one per poll");
  assert.match(h.logs[0].m, /^\[MMM-GrafanaTrends\] plant alerts: http:\/\/ha\.example:8123 ok \(HTTP 200\)$/);

  // the loop left a 4th request in flight; a changed alert list emits again
  h.answerLatest(200, stateBody([]));
  assert.equal(h.states.length, 2);
  assert.equal(h.last.alerts.length, 0);
});

test("getState returns the last emitted payload, or a starting payload before any", () => {
  const h = makeHarness();
  assert.equal(h.poller.getState().status, "starting");
  h.poller.start();
  h.answerLatest(200, stateBody([]));
  assert.equal(h.poller.getState().status, "ok");
  assert.equal(h.poller.getState(), h.last);
});

test("an https secret url uses the https module", () => {
  const h = makeHarness({ secret: secretText({ url: "https://ha.example" }) });
  h.poller.start();
  assert.equal(h.http.calls.length, 0);
  assert.equal(h.https.calls.length, 1);
  assert.equal(h.https.calls[0].target.protocol, "https:");
});

test("timings are clamped to the floors even if the caller passes bogus values", () => {
  const h = makeHarness({ timings: { pollMs: 0, timeoutMs: 0, staleMs: 0 } });
  h.poller.start();
  assert.equal(h.http.calls[0].opts.timeout, 2000);
  h.answerLatest(200, stateBody([]));
  h.advance(9999);
  assert.equal(h.http.calls.length, 1);
  h.advance(1);
  assert.equal(h.http.calls.length, 2);
});

test("stop() clears every timer and destroys the in-flight request", () => {
  const h = makeHarness();
  h.poller.start();
  h.answerLatest(200, stateBody([]));
  h.advance(POLL_MS);
  const call = h.http.calls[1];
  h.poller.stop();
  assert.equal(h.timers.length, 0);
  assert.equal(call.req.destroyed, true);
  h.advance(POLL_MS * 5);
  assert.equal(h.http.calls.length, 2);

  const watching = makeHarness({ secret: null });
  watching.poller.start();
  assert.equal(watching.timers.length, 1);
  watching.poller.stop();
  assert.equal(watching.timers.length, 0);
});
