/* PlantAlertPoller: polls one Home Assistant entity (GET /api/states/<entity>) and reports
 * normalized plant-alert state through onState(). All I/O and time come in through the
 * constructor so tests can drive it with fakes; node_helper.js wires in the real modules.
 *
 * The secret file (HA url + token) is read here and nowhere else. The token and the request
 * path are never logged or emitted: log lines carry only the HA origin and a fixed status/reason.
 * A 401/403 is terminal (polling stops, to avoid an HA ip_ban) until the secret file changes.
 */

const { validateSecret, parseStateResponse, decideMonitor, fingerprint, clampPlantAlertTimings, sanitizeEntity, SECRET_MAX_BYTES } = require("./plant-alert-rules");

const MAX_BODY_BYTES = 64 * 1024;
const SECRET_WATCH_MS = 60 * 1000;

class PlantAlertPoller {
  constructor({ http, https, fs, now, setTimeout, clearTimeout, log, secretPath, entity, timings, onState }) {
    this.http = http;
    this.https = https;
    this.fs = fs;
    this.now = now;
    this.setTimer = setTimeout;
    this.clearTimer = clearTimeout;
    this.log = log;
    this.secretPath = secretPath;
    this.entity = sanitizeEntity(entity);
    this.timings = clampPlantAlertTimings(timings);
    this.onState = onState;

    this.secret = null;
    this.secretSig = null;
    this.origin = "-";
    this.stopped = false;
    this.pollTimer = null;
    this.watchTimer = null;
    this.inflight = null;

    this.status = "starting";
    this.alerts = [];
    this.monitor = null;
    this.checkedAt = null;
    this.lastGoodAt = null;
    // Staleness is measured from here: the start time (boot grace), then the last good poll.
    this.staleBase = null;
    this.lastFingerprint = null;
    this.lastEmitted = null;
    this.loggedStatus = null;
  }

  /** Read the secret and begin polling immediately (or report not_configured). */
  start() {
    this.stopped = false;
    this.staleBase = this.now();
    this.loadSecret();
    if (this.secret) {
      this.poll();
    } else {
      this.enterNotConfigured();
    }
  }

  /** Clear every timer and abandon any in-flight request. */
  stop() {
    this.stopped = true;
    if (this.pollTimer !== null) this.clearTimer(this.pollTimer);
    if (this.watchTimer !== null) this.clearTimer(this.watchTimer);
    this.pollTimer = null;
    this.watchTimer = null;
    if (this.inflight) this.inflight.destroy();
    this.inflight = null;
  }

  /** The last emitted payload (for replay on a repeat START), or the initial one. */
  getState() {
    return this.lastEmitted || this.buildPayload();
  }

  buildPayload() {
    return {
      status: this.status,
      alerts: this.alerts,
      monitor: this.monitor,
      checkedAt: this.checkedAt,
      lastGoodAt: this.lastGoodAt
    };
  }

  /** Emit to onState only when status, alerts or monitor changed (always on the first call). */
  emit() {
    const payload = this.buildPayload();
    const fp = fingerprint(payload);
    if (fp === this.lastFingerprint) return;
    this.lastFingerprint = fp;
    this.lastEmitted = payload;
    this.onState(payload);
  }

  /** Log status transitions only, never once per poll. */
  logTransition(code) {
    if (this.status === this.loggedStatus) return;
    this.loggedStatus = this.status;
    const message = `[MMM-GrafanaTrends] plant alerts: ${this.origin} ${this.status} (${code})`;
    if (this.status === "ok") this.log.info(message);
    else this.log.warn(message);
  }

  secretSignature() {
    try {
      const stat = this.fs.statSync(this.secretPath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  loadSecret() {
    this.secret = null;
    this.secretReason = "secret file missing";
    this.secretSig = this.secretSignature();
    if (this.secretSig === "missing") return;

    this.secretReason = "secret file unreadable";
    let text;
    try {
      if (this.fs.statSync(this.secretPath).size > SECRET_MAX_BYTES) {
        this.secretReason = "secret file invalid";
        return;
      }
      text = this.fs.readFileSync(this.secretPath, "utf8");
    } catch {
      return;
    }

    const result = validateSecret(text);
    if (!result.ok) {
      this.secretReason = result.reason;
      return;
    }
    this.secret = { url: result.url, token: result.token };
    this.origin = new URL(result.url).origin;
  }

  enterNotConfigured() {
    this.status = "not_configured";
    this.monitor = decideMonitor({ outcome: "not_configured" });
    this.origin = "-";
    this.logTransition(this.secretReason);
    this.emit();
    this.scheduleWatch();
  }

  scheduleWatch() {
    if (this.stopped) return;
    if (this.watchTimer !== null) this.clearTimer(this.watchTimer);
    this.watchTimer = this.setTimer(() => this.watchTick(), SECRET_WATCH_MS);
  }

  /** While not_configured / auth_failed: a stat (no HA traffic) to notice a fixed secret file. */
  watchTick() {
    this.watchTimer = null;
    if (this.stopped) return;
    if (this.secretSignature() !== this.secretSig) {
      this.loadSecret();
      if (this.secret) {
        this.staleBase = this.now();
        this.poll();
        return;
      }
      this.enterNotConfigured();
      return;
    }
    this.scheduleWatch();
  }

  scheduleNextPoll() {
    if (this.stopped) return;
    if (this.pollTimer !== null) this.clearTimer(this.pollTimer);
    this.pollTimer = this.setTimer(() => this.poll(), this.timings.pollMs);
  }

  poll() {
    this.pollTimer = null;
    if (this.stopped || !this.secret) return;

    let settled = false;
    const finish = (result) => {
      if (settled || this.stopped) return;
      settled = true;
      this.inflight = null;
      try {
        this.handleResult(result);
      } catch (err) {
        this.log.warn(`[MMM-GrafanaTrends] plant alerts: ${this.origin} internal error (${err && err.name})`);
        this.scheduleNextPoll();
      }
    };
    const failed = (reason) => finish({ outcome: "degraded", alerts: null, reason });

    try {
      const target = new URL(`${this.secret.url}/api/states/${encodeURIComponent(this.entity)}`);
      const client = target.protocol === "https:" ? this.https : this.http;
      const req = client.get(
        target,
        {
          headers: { Authorization: `Bearer ${this.secret.token}`, Accept: "application/json" },
          timeout: this.timings.timeoutMs
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            size += buf.length;
            if (size > MAX_BODY_BYTES) {
              req.destroy();
              failed("response too large");
              return;
            }
            chunks.push(buf);
          });
          res.on("end", () => {
            finish(parseStateResponse({ statusCode: res.statusCode, bodyText: Buffer.concat(chunks).toString("utf8") }, {}));
          });
          res.on("error", () => failed("Home Assistant unreachable"));
        }
      );
      this.inflight = req;

      req.on("timeout", () => {
        req.destroy();
        failed("request timed out");
      });
      req.on("error", () => failed("Home Assistant unreachable"));
    } catch {
      failed("Home Assistant unreachable");
    }
  }

  handleResult(result) {
    const now = this.now();
    this.checkedAt = now;

    if (result.outcome === "auth_failed") {
      this.status = "auth_failed";
      this.monitor = decideMonitor(result);
      this.logTransition(`HTTP ${result.statusCode}`);
      this.emit();
      this.scheduleWatch();
      return;
    }

    if (result.alerts) this.alerts = result.alerts;

    if (result.outcome === "ok") {
      this.lastGoodAt = now;
      this.staleBase = now;
      this.status = "ok";
      this.monitor = null;
      this.logTransition(`HTTP ${result.statusCode}`);
    } else {
      this.monitor = decideMonitor({
        outcome: "degraded",
        reason: result.reason,
        lastGoodAt: this.staleBase,
        now,
        staleMs: this.timings.staleMs
      });
      this.status = this.monitor ? "stale" : "degraded";
      this.logTransition(result.reason);
    }

    this.emit();
    this.scheduleNextPoll();
  }
}

module.exports = { PlantAlertPoller };
