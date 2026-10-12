/* MMM-GrafanaTrends: Node Helper
 * Probes the configured Grafana dashboard URL server-side (HTTP status, a redirect to a
 * login page, X-Frame-Options / CSP frame-ancestors embedding refusal) so the front end
 * can show its error overlay for failures a same-origin iframe `load` event can't see
 * (Chromium fires `load` for blocked/redirected frames just as it does for a real page).
 *
 * The dashboard URL may contain a public-dashboard share token; it is never logged here,
 * only the request's origin (protocol + host) is.
 */

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const Log = require("logger");
const NodeHelper = require("node_helper");
const { evaluateProbeResponse } = require("./probe-rules");
const { PlantAlertPoller } = require("./plant-alert-poller");
const { DEFAULT_ENTITY, sanitizeEntity, clampPlantAlertTimings } = require("./plant-alert-rules");

const PROBE_TIMEOUT_MS = 10 * 1000;

module.exports = NodeHelper.create({
  start() {
    Log.info(`[${this.name}] Node helper started.`);
    this.plantOwner = null;
    this.plantPoller = null;
    this.plantSeq = 0;
    this.plantRejectWarned = false;
  },

  stop() {
    this.plantPoller?.stop();
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "GRAFANA_TRENDS_PROBE") {
      this.probe(payload);
    } else if (notification === "GRAFANA_TRENDS_PLANT_ALERTS_START") {
      this.startPlantAlerts(payload);
    }
  },

  // The HA url and token are read from ha-alerts.secret.json by the poller, never from this
  // payload, so nothing that arrives over the socket can redirect the token. The first
  // identifier to START owns the poller; any other identifier is rejected.
  startPlantAlerts(payload) {
    const identifier = payload && typeof payload.identifier === "string" ? payload.identifier : "";
    if (!identifier) return;

    try {
      if (this.plantOwner && this.plantOwner !== identifier) {
        if (!this.plantRejectWarned) {
          this.plantRejectWarned = true;
          Log.warn(`[${this.name}] plant alerts: START from a second instance rejected`);
        }
        this.sendSocketNotification("GRAFANA_TRENDS_PLANT_ALERTS_STATE", {
          identifier,
          seq: 0,
          status: "rejected",
          alerts: [],
          monitor: null
        });
        return;
      }

      if (this.plantOwner) {
        // Same owner again (browser reload, second browser): replay, don't restart.
        this.emitPlantState(identifier, this.plantPoller.getState());
        return;
      }

      if (payload.entity !== undefined && sanitizeEntity(payload.entity) !== payload.entity) {
        Log.warn(`[${this.name}] plant alerts: invalid entity id, using ${DEFAULT_ENTITY}`);
      }
      this.plantOwner = identifier;
      this.plantPoller = new PlantAlertPoller({
        http,
        https,
        fs,
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (timer) => clearTimeout(timer),
        log: { info: (msg) => Log.info(msg), warn: (msg) => Log.warn(msg) },
        secretPath: path.join(__dirname, "ha-alerts.secret.json"),
        entity: sanitizeEntity(payload.entity),
        timings: clampPlantAlertTimings(payload),
        onState: (state) => this.emitPlantState(identifier, state)
      });
      this.plantPoller.start();
    } catch (err) {
      Log.warn(`[${this.name}] plant alerts: internal error (${err && err.name})`);
      if (!this.plantPoller) this.plantOwner = null;
      this.emitPlantState(identifier, { status: "degraded", alerts: [], monitor: null, checkedAt: null, lastGoodAt: null });
    }
  },

  emitPlantState(identifier, state) {
    this.plantSeq += 1;
    this.sendSocketNotification("GRAFANA_TRENDS_PLANT_ALERTS_STATE", {
      identifier,
      seq: this.plantSeq,
      status: state.status,
      alerts: state.alerts,
      monitor: state.monitor,
      checkedAt: state.checkedAt,
      lastGoodAt: state.lastGoodAt
    });
  },

  probe(payload) {
    const { url, identifier, requestId, embedderOrigin } = payload || {};
    if (!url || !identifier) return;

    let target;
    try {
      target = new URL(url);
    } catch {
      this.sendSocketNotification("GRAFANA_TRENDS_PROBE_RESULT", {
        identifier,
        requestId,
        ok: false,
        reason: "invalid dashboard url"
      });
      return;
    }

    // A url with no scheme (e.g. "homeassistant.local:3000/d/x?kiosk") parses as a URL
    // whose "protocol" is the bit before the first colon - here "homeassistant.local:" -
    // not http/https. http.get() on that throws ERR_INVALID_PROTOCOL synchronously, which
    // (without the try/catch below) would be an uncaught exception with no probe reply ever
    // sent. Reject it up front as an invalid url instead of letting either module guess it.
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      this.sendSocketNotification("GRAFANA_TRENDS_PROBE_RESULT", {
        identifier,
        requestId,
        ok: false,
        reason: "invalid dashboard url"
      });
      return;
    }

    const client = target.protocol === "https:" ? https : http;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      this.sendSocketNotification("GRAFANA_TRENDS_PROBE_RESULT", Object.assign({ identifier, requestId }, result));
    };

    try {
      const req = client.get(
        target,
        { timeout: PROBE_TIMEOUT_MS },
        (res) => {
          // Drain the response body without holding onto it; only headers/status matter.
          res.on("data", () => {});
          res.on("end", () => {});
          finish(evaluateProbeResponse(res, embedderOrigin));
        }
      );

      req.on("timeout", () => {
        req.destroy();
        Log.warn(`[${this.name}] Probe to ${target.origin} timed out`);
        finish({ ok: false, reason: "probe timed out" });
      });

      req.on("error", (err) => {
        Log.warn(`[${this.name}] Probe to ${target.origin} failed: ${err.code || err.message}`);
        finish({ ok: false, reason: "network error" });
      });
    } catch (err) {
      // client.get() can throw synchronously (e.g. an unexpected malformed url that slips
      // past the checks above); catch it so the module still gets a reply instead of the
      // probe silently vanishing into an uncaught exception.
      Log.warn(`[${this.name}] Probe to ${target.origin} failed to start: ${err.code || err.message}`);
      finish({ ok: false, reason: "invalid dashboard url" });
    }
  }
});
