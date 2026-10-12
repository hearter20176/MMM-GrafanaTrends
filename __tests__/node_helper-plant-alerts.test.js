/* Tests for the plant-alert branch of node_helper.js.
 *
 * Uses the same vm-wrapper loader as node_helper.test.js (copied, not shared, so that file
 * stays untouched), with a fake node:fs and fake http/https so no file or network is touched.
 * Timers are the real globals replaced with a recording stub for the duration of each test.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("module");
const { EventEmitter } = require("node:events");

const HELPER_PATH = path.join(__dirname, "..", "node_helper.js");
const SECRET_PATH = path.join(path.dirname(HELPER_PATH), "ha-alerts.secret.json");
const TOKEN = "SENTINEL-TOKEN-DO-NOT-LOG-0123456789";
const SECRET_TEXT = JSON.stringify({ url: "http://secret-ha.example:8123", token: TOKEN });

function loadDefinition({ httpImpl, httpsImpl, fsImpl, logImpl }) {
  const src = fs.readFileSync(HELPER_PATH, "utf8");
  const script = vm.runInThisContext(Module.wrap(src), { filename: HELPER_PATH });
  const fakeModule = { exports: {} };
  const fakeRequire = (request) => {
    const name = request.replace(/^node:/, "");
    if (name === "node_helper") return { create: (obj) => obj };
    if (name === "logger") return logImpl;
    if (name === "http") return httpImpl;
    if (name === "https") return httpsImpl;
    if (name === "fs") return fsImpl;
    if (request.startsWith("node:")) return require(request);
    return require(path.join(__dirname, "..", name));
  };
  script(fakeModule.exports, fakeRequire, fakeModule, HELPER_PATH, path.dirname(HELPER_PATH));
  return fakeModule.exports;
}

function makeHelper({ secret = SECRET_TEXT } = {}) {
  const notifications = [];
  const calls = { http: [], https: [] };
  const fsCalls = [];
  const logs = [];

  const client = (name) => ({
    get(target, opts, cb) {
      const req = new EventEmitter();
      req.destroy = () => {
        req.destroyed = true;
      };
      calls[name].push({ target, opts, cb, req });
      return req;
    }
  });
  const fsImpl = {
    statSync(p) {
      fsCalls.push(["stat", p]);
      if (secret === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs: 1, size: Buffer.byteLength(secret) };
    },
    readFileSync(p) {
      fsCalls.push(["read", p]);
      return secret;
    }
  };
  const logImpl = {
    info: (m) => logs.push(m),
    log() {},
    warn: (m) => logs.push(m),
    error() {}
  };

  const definition = loadDefinition({ httpImpl: client("http"), httpsImpl: client("https"), fsImpl, logImpl });
  const helper = Object.assign({}, definition, {
    name: "MMM-GrafanaTrends",
    sendSocketNotification(notification, payload) {
      notifications.push({ notification, payload });
    }
  });
  helper.start();
  const states = () => notifications.filter((n) => n.notification === "GRAFANA_TRENDS_PLANT_ALERTS_STATE").map((n) => n.payload);
  return { helper, notifications, calls, fsCalls, logs, states };
}

// Record timers scheduled through the global setTimeout/clearTimeout during a test.
function withFakeTimers(fn) {
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  const timers = [];
  global.setTimeout = (cb, ms) => {
    const t = { cb, ms };
    timers.push(t);
    return t;
  };
  global.clearTimeout = (t) => {
    const i = timers.indexOf(t);
    if (i !== -1) timers.splice(i, 1);
  };
  try {
    return fn(timers);
  } finally {
    global.setTimeout = realSet;
    global.clearTimeout = realClear;
  }
}

function answer(call, statusCode, text) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  call.cb(res);
  res.emit("data", Buffer.from(text));
  res.emit("end");
}

const OK_BODY = JSON.stringify({ state: "0", attributes: { schema: 1, alerts: [] } });

test("start() alone makes no file reads, no timers and no requests", () => {
  withFakeTimers((timers) => {
    const { fsCalls, calls } = makeHelper();
    assert.equal(fsCalls.length, 0);
    assert.equal(timers.length, 0);
    assert.equal(calls.http.length + calls.https.length, 0);
  });
});

test("START from A creates the poller and the emitted STATE carries identifier A", () => {
  withFakeTimers(() => {
    const { helper, calls, states } = makeHelper();
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", {
      identifier: "A",
      entity: "sensor.mirror_plant_alerts",
      pollMs: 30000,
      timeoutMs: 10000,
      staleMs: 600000
    });
    assert.equal(calls.http.length, 1);
    assert.equal(calls.http[0].target.href, "http://secret-ha.example:8123/api/states/sensor.mirror_plant_alerts");
    assert.ok(fs.existsSync(HELPER_PATH));

    answer(calls.http[0], 200, OK_BODY);
    const sent = states();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].identifier, "A");
    assert.equal(sent[0].status, "ok");
    assert.deepEqual(sent[0].alerts, []);
    assert.equal(sent[0].monitor, null);
    assert.equal(typeof sent[0].seq, "number");
    assert.ok(sent[0].seq > 0);
  });
});

test("the secret is read from ha-alerts.secret.json in the module directory", () => {
  withFakeTimers(() => {
    const { helper, fsCalls } = makeHelper();
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", { identifier: "A" });
    assert.ok(fsCalls.length > 0);
    assert.ok(fsCalls.every(([, p]) => p === SECRET_PATH));
  });
});

test("a missing secret gives a not_configured STATE with a monitor and no request", () => {
  withFakeTimers(() => {
    const { helper, calls, states } = makeHelper({ secret: null });
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", { identifier: "A" });
    assert.equal(calls.http.length, 0);
    assert.equal(states()[0].status, "not_configured");
    assert.deepEqual(states()[0].monitor, { glyph: "!", reason: "not configured" });
  });
});

test("a second START from the owner replays state with a higher seq and does not create a second poller", () => {
  withFakeTimers(() => {
    const { helper, calls, states } = makeHelper();
    const start = { identifier: "A" };
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", start);
    answer(calls.http[0], 200, OK_BODY);
    const firstSeq = states()[0].seq;

    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", start);
    assert.equal(calls.http.length, 1, "no second request");
    const sent = states();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].identifier, "A");
    assert.equal(sent[1].status, "ok");
    assert.ok(sent[1].seq > firstSeq);
  });
});

test("a START from a different identifier is rejected and never polled", () => {
  withFakeTimers(() => {
    const { helper, calls, states, logs } = makeHelper();
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", { identifier: "A" });
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", { identifier: "B" });
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", { identifier: "B" });

    assert.equal(calls.http.length, 1, "only A is polled");
    const rejected = states().filter((s) => s.identifier === "B");
    assert.equal(rejected.length, 2);
    assert.deepEqual(rejected[0], { identifier: "B", seq: 0, status: "rejected", alerts: [], monitor: null });
    assert.equal(logs.filter((m) => /rejected/.test(m)).length, 1, "warned once");
  });
});

test("url, token and tokenFile fields in the START payload are ignored", () => {
  withFakeTimers(() => {
    const { helper, calls, states } = makeHelper();
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", {
      identifier: "A",
      url: "http://evil.example",
      haUrl: "http://evil.example",
      token: "evil-token",
      tokenFile: "/etc/passwd"
    });
    assert.equal(calls.http.length, 1);
    assert.equal(calls.http[0].target.origin, "http://secret-ha.example:8123");
    assert.equal(calls.http[0].opts.headers.Authorization, `Bearer ${TOKEN}`);
    answer(calls.http[0], 200, OK_BODY);
    assert.ok(!JSON.stringify(states()).includes(TOKEN));
    assert.ok(!JSON.stringify(states()).includes("evil"));
  });
});

test("an invalid entity falls back to the default entity", () => {
  withFakeTimers(() => {
    const { helper, calls } = makeHelper();
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", { identifier: "A", entity: "switch.x/../../y" });
    assert.match(calls.http[0].target.pathname, /\/api\/states\/sensor\.mirror_plant_alerts$/);
  });
});

test("bogus timings in START are clamped to the floors", () => {
  withFakeTimers((timers) => {
    const { helper, calls } = makeHelper();
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", {
      identifier: "A",
      pollMs: 0,
      timeoutMs: 0,
      staleMs: 0
    });
    assert.equal(calls.http[0].opts.timeout, 2000);
    answer(calls.http[0], 200, OK_BODY);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 10000);
  });
});

test("a START with no usable identifier is ignored", () => {
  withFakeTimers(() => {
    const { helper, calls, notifications } = makeHelper();
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", null);
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", { identifier: 7 });
    assert.equal(calls.http.length, 0);
    assert.equal(notifications.length, 0);
  });
});

test("the probe still works alongside plant alerts", () => {
  withFakeTimers(() => {
    const { helper, calls, notifications } = makeHelper();
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", { identifier: "A" });
    helper.socketNotificationReceived("GRAFANA_TRENDS_PROBE", {
      url: "http://grafana.example:3000/d/x",
      identifier: "A",
      requestId: 1,
      embedderOrigin: "http://mirror.local:8080"
    });
    assert.equal(calls.http.length, 2);
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    calls.http[1].cb(res);
    const probe = notifications.find((n) => n.notification === "GRAFANA_TRENDS_PROBE_RESULT");
    assert.equal(probe.payload.ok, true);
    assert.equal(probe.payload.identifier, "A");
  });
});

test("an exception inside the plant branch emits a degraded STATE instead of throwing", () => {
  withFakeTimers(() => {
    // no secret: the poller emits not_configured synchronously during START, and that send throws
    const { helper, states } = makeHelper({ secret: null });
    helper.sendSocketNotification = (n, p) => {
      if (n === "GRAFANA_TRENDS_PLANT_ALERTS_STATE" && p.status !== "degraded") throw new Error("socket down");
      helper.sent = (helper.sent || []).concat([{ n, p }]);
    };
    assert.doesNotThrow(() => helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", { identifier: "A" }));
    assert.equal(helper.sent[0].p.status, "degraded");
    assert.equal(states().length, 0);
  });
});

test("stop() stops the poller and its timers", () => {
  withFakeTimers((timers) => {
    const { helper, calls } = makeHelper();
    helper.socketNotificationReceived("GRAFANA_TRENDS_PLANT_ALERTS_START", { identifier: "A" });
    answer(calls.http[0], 200, OK_BODY);
    assert.equal(timers.length, 1);
    helper.stop();
    assert.equal(timers.length, 0);
  });
});

test("stop() without any START does not throw", () => {
  const { helper } = makeHelper();
  assert.doesNotThrow(() => helper.stop());
});
