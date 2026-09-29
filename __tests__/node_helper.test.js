/* Tests for node_helper.js
 *
 * node_helper.js requires "node_helper" and "logger" (MagicMirror core), neither of which
 * resolve outside a running MagicMirror install. Rather than depending on the whole
 * MagicMirror runtime, this loads node_helper.js's source through a hand-built CommonJS
 * wrapper with a fake `require` that substitutes those (plus http/https) with in-memory
 * test doubles, following the same approach as MMM-AmbientWeather/test/node_helper.test.js.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { EventEmitter } = require("events");

const HELPER_PATH = path.join(__dirname, "..", "node_helper.js");

function loadNodeHelperDefinition({ httpImpl, httpsImpl, logImpl }) {
  const src = fs.readFileSync(HELPER_PATH, "utf8");
  const wrapper = Module.wrap(src);
  const script = vm.runInThisContext(wrapper, { filename: HELPER_PATH });
  const fakeModule = { exports: {} };
  const fakeRequire = (name) => {
    if (name === "node_helper") return { create: (obj) => obj };
    if (name === "logger") return logImpl;
    if (name === "http") return httpImpl;
    if (name === "https") return httpsImpl;
    // Resolve real relative requires (./probe-rules) against the real file.
    return require(path.join(__dirname, "..", name));
  };
  script(fakeModule.exports, fakeRequire, fakeModule, HELPER_PATH, path.dirname(HELPER_PATH));
  return fakeModule.exports;
}

function makeFakeReq() {
  const req = new EventEmitter();
  req.destroy = () => {
    req.destroyed = true;
  };
  return req;
}

function makeHelper({ httpImpl, httpsImpl, warnLogs } = {}) {
  const notifications = [];
  const logImpl = {
    info() {},
    log() {},
    warn: (msg) => {
      if (warnLogs) warnLogs.push(msg);
    },
    error() {}
  };

  const definition = loadNodeHelperDefinition({
    httpImpl: httpImpl || { get: () => makeFakeReq() },
    httpsImpl: httpsImpl || { get: () => makeFakeReq() },
    logImpl
  });

  const helper = Object.assign({}, definition, {
    name: "MMM-GrafanaTrends",
    sendSocketNotification(notification, payload) {
      notifications.push({ notification, payload });
    }
  });
  helper.start();
  return { helper, notifications };
}

function makeFakeRes({ statusCode, headers }) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers || {};
  return res;
}

test("probe: a 200 response with no blocking headers reports ok:true", () => {
  let capturedReq = null;
  const httpImpl = {
    get: (_target, _opts, cb) => {
      const req = makeFakeReq();
      capturedReq = req;
      process.nextTick(() => cb(makeFakeRes({ statusCode: 200, headers: {} })));
      return req;
    }
  };
  const { helper, notifications } = makeHelper({ httpImpl });

  helper.probe({ url: "http://grafana.local/d/x?kiosk", identifier: "mod1", embedderOrigin: "http://mirror.local" });

  return new Promise((resolve) => {
    process.nextTick(() => {
      process.nextTick(() => {
        const result = notifications.find((n) => n.notification === "GRAFANA_TRENDS_PROBE_RESULT");
        assert.ok(result);
        assert.equal(result.payload.identifier, "mod1");
        assert.equal(result.payload.ok, true);
        assert.ok(capturedReq);
        resolve();
      });
    });
  });
});

test("probe: echoes the caller's requestId back on the result, so the front end can drop stale replies", () => {
  const httpImpl = {
    get: (_target, _opts, cb) => {
      const req = makeFakeReq();
      process.nextTick(() => cb(makeFakeRes({ statusCode: 200, headers: {} })));
      return req;
    }
  };
  const { helper, notifications } = makeHelper({ httpImpl });

  helper.probe({ url: "http://grafana.local/d/x?kiosk", identifier: "mod1", requestId: 7 });

  return new Promise((resolve) => {
    process.nextTick(() => {
      process.nextTick(() => {
        const result = notifications.find((n) => n.notification === "GRAFANA_TRENDS_PROBE_RESULT");
        assert.equal(result.payload.requestId, 7);
        resolve();
      });
    });
  });
});

test("probe: X-Frame-Options DENY reports ok:false with a reason", () => {
  const httpImpl = {
    get: (_target, _opts, cb) => {
      const req = makeFakeReq();
      process.nextTick(() => cb(makeFakeRes({ statusCode: 200, headers: { "x-frame-options": "DENY" } })));
      return req;
    }
  };
  const { helper, notifications } = makeHelper({ httpImpl });

  helper.probe({ url: "http://grafana.local/d/x?kiosk", identifier: "mod1" });

  return new Promise((resolve) => {
    process.nextTick(() => {
      process.nextTick(() => {
        const result = notifications.find((n) => n.notification === "GRAFANA_TRENDS_PROBE_RESULT");
        assert.equal(result.payload.ok, false);
        assert.match(result.payload.reason, /x-frame-options/i);
        resolve();
      });
    });
  });
});

test("probe: a request-level error reports ok:false without throwing", () => {
  const httpImpl = {
    get: () => {
      const req = makeFakeReq();
      process.nextTick(() => req.emit("error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })));
      return req;
    }
  };
  const { helper, notifications } = makeHelper({ httpImpl });

  helper.probe({ url: "http://grafana.local/d/x?kiosk", identifier: "mod1" });

  return new Promise((resolve) => {
    process.nextTick(() => {
      process.nextTick(() => {
        const result = notifications.find((n) => n.notification === "GRAFANA_TRENDS_PROBE_RESULT");
        assert.equal(result.payload.ok, false);
        resolve();
      });
    });
  });
});

test("probe: a timeout destroys the request and reports ok:false", () => {
  const httpImpl = {
    get: () => {
      const req = makeFakeReq();
      process.nextTick(() => req.emit("timeout"));
      return req;
    }
  };
  const { helper, notifications } = makeHelper({ httpImpl });

  helper.probe({ url: "http://grafana.local/d/x?kiosk", identifier: "mod1" });

  return new Promise((resolve) => {
    process.nextTick(() => {
      process.nextTick(() => {
        const result = notifications.find((n) => n.notification === "GRAFANA_TRENDS_PROBE_RESULT");
        assert.equal(result.payload.ok, false);
        assert.match(result.payload.reason, /timed out/i);
        resolve();
      });
    });
  });
});

test("probe: uses https for an https:// url", () => {
  let httpsCalled = false;
  let httpCalled = false;
  const httpsImpl = {
    get: (_target, _opts, cb) => {
      httpsCalled = true;
      const req = makeFakeReq();
      process.nextTick(() => cb(makeFakeRes({ statusCode: 200, headers: {} })));
      return req;
    }
  };
  const httpImpl = {
    get: () => {
      httpCalled = true;
      return makeFakeReq();
    }
  };
  const { helper } = makeHelper({ httpImpl, httpsImpl });

  helper.probe({ url: "https://grafana.local/public-dashboards/token123", identifier: "mod1" });

  return new Promise((resolve) => {
    process.nextTick(() => {
      process.nextTick(() => {
        assert.equal(httpsCalled, true);
        assert.equal(httpCalled, false);
        resolve();
      });
    });
  });
});

test("probe: never logs the dashboard URL or its token, even on failure", () => {
  const warnLogs = [];
  const httpImpl = {
    get: () => {
      const req = makeFakeReq();
      process.nextTick(() => req.emit("error", Object.assign(new Error("boom"), { code: "ECONNRESET" })));
      return req;
    }
  };
  const { helper } = makeHelper({ httpImpl, warnLogs });

  const secretUrl = "http://grafana.local/public-dashboards/super-secret-token-abc123";
  helper.probe({ url: secretUrl, identifier: "mod1" });

  return new Promise((resolve) => {
    process.nextTick(() => {
      process.nextTick(() => {
        assert.ok(warnLogs.length > 0, "expected a warning log for the failed probe");
        for (const line of warnLogs) {
          assert.ok(!line.includes("super-secret-token-abc123"), `log line leaked the token: ${line}`);
          assert.ok(!line.includes("public-dashboards"), `log line leaked the url path: ${line}`);
        }
        resolve();
      });
    });
  });
});

test("probe: a bare host:port url with no scheme (e.g. \"homeassistant.local:3000/d/x\") reports ok:false instead of throwing", () => {
  // new URL("homeassistant.local:3000/d/x") parses with protocol "homeassistant.local:"
  // (not http:/https:), which would make http.get() throw ERR_INVALID_PROTOCOL
  // synchronously if it were ever reached. No http/https client should be called at all;
  // the protocol check must reject it before client.get().
  let httpCalled = false;
  let httpsCalled = false;
  const httpImpl = {
    get: () => {
      httpCalled = true;
      return makeFakeReq();
    }
  };
  const httpsImpl = {
    get: () => {
      httpsCalled = true;
      return makeFakeReq();
    }
  };
  const { helper, notifications } = makeHelper({ httpImpl, httpsImpl });

  helper.probe({ url: "homeassistant.local:3000/d/x", identifier: "mod1", requestId: 3 });

  const result = notifications.find((n) => n.notification === "GRAFANA_TRENDS_PROBE_RESULT");
  assert.ok(result, "expected an immediate GRAFANA_TRENDS_PROBE_RESULT reply");
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.reason, "invalid dashboard url");
  assert.equal(result.payload.requestId, 3);
  assert.equal(httpCalled, false);
  assert.equal(httpsCalled, false);
});

test("probe: a synchronous throw from client.get() still reports a failed probe, never an uncaught exception", () => {
  const httpImpl = {
    get: () => {
      throw new Error("boom: synchronous client.get failure");
    }
  };
  const { helper, notifications } = makeHelper({ httpImpl });

  assert.doesNotThrow(() => {
    helper.probe({ url: "http://grafana.local/d/x?kiosk", identifier: "mod1", requestId: 5 });
  });

  const result = notifications.find((n) => n.notification === "GRAFANA_TRENDS_PROBE_RESULT");
  assert.ok(result, "expected a GRAFANA_TRENDS_PROBE_RESULT reply even after a synchronous throw");
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.requestId, 5);
});

test("probe: does nothing when url is missing", () => {
  const { helper, notifications } = makeHelper();
  helper.probe({ identifier: "mod1" });
  assert.equal(notifications.length, 0);
});

test("probe: does nothing when identifier is missing", () => {
  const { helper, notifications } = makeHelper();
  helper.probe({ url: "http://grafana.local/d/x" });
  assert.equal(notifications.length, 0);
});
