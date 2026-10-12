/* MMM-GrafanaTrends
 * Embeds one Grafana dashboard (kiosk or public/shared dashboard URL) in a glass card.
 * One iframe = one Grafana app instance, which keeps the Pi's memory/CPU use low compared
 * with embedding panels individually.
 */

// Retry delays below this are refused (see _clampRetryConfig()); a value this low provides
// no real backoff and, at 0, turns a Grafana outage into a tight reload+probe loop.
const MIN_RETRY_DELAY_MS = 5000;
// Same idea for reloadInterval: a tiny value (or 0 meaning "never" is fine, but anything
// smaller than this) would reload+probe on a near-continuous cycle.
const MIN_RELOAD_INTERVAL_MS = 60 * 1000;
// Plant alert option floors (see _clampPlantAlertConfig()).
const MIN_PLANT_POLL_MS = 10 * 1000;
const MIN_PLANT_TIMEOUT_MS = 2 * 1000;
const MIN_PLANT_STALE_MS = 60 * 1000;
const MIN_PLANT_POPUP_MS = 5 * 1000;
const MIN_PLANT_REPEAT_MS = 60 * 1000;
const PLANT_ENTITY_PATTERN = /^sensor\.[a-z0-9_]+$/;

Module.register("MMM-GrafanaTrends", {
  defaults: {
    // Grafana dashboard URL. Either a shared/public dashboard link
    // (http://<ha-host>:3000/public-dashboards/<token>) or a normal one with kiosk mode
    // (http://<ha-host>:3000/d/mirror-trends/mirror-trends?kiosk).
    url: "",
    header: "",
    width: "100%",
    // px; the generated dashboard is 44 grid rows (30px row + 8px margin each) plus
    // kiosk padding, which works out to ~1664px. VERIFY against the real render on
    // the device - Grafana panel chrome/margins can vary by version.
    height: 1664,
    // Switch Grafana between light and dark with the mirror's body.mm-day / body.mm-night
    // classes, following MMM-GlassClock's PAGE_THEME_CHANGED notification.
    followMirrorTheme: true,
    defaultTheme: "dark",
    // Periodically reload the iframe so a long-running Grafana page can't accumulate memory
    reloadInterval: 6 * 60 * 60 * 1000,
    // Blank the iframe while the page is hidden (saves CPU, costs a reload when shown)
    unloadWhenHidden: false,
    // Fallback timer for a fully hung connection: how long to wait for the iframe to fire
    // `load` at all before treating the load as failed. The node_helper probe (see
    // probe-rules.js) is what actually detects Grafana being down, redirecting to a login
    // page, or refusing to embed - `load` fires for those cases too, so it can't tell them
    // apart on its own. This timer only matters when the probe itself can't get an answer.
    loadTimeoutMs: 20 * 1000,
    // Retry backoff after a failed/timed-out load: retryDelayMs, doubling up to
    // maxRetryDelayMs, instead of waiting for the full reloadInterval. Both are clamped to
    // at least 5s in start() so a misconfiguration (e.g. 0) can't hammer Grafana/the Pi with
    // a tight reload+probe loop.
    retryDelayMs: 60 * 1000,
    maxRetryDelayMs: 10 * 60 * 1000,
    // iframe title attribute (accessibility); set it per instance when running two.
    iframeTitle: "Grafana trends",
    // Plant alerts: enable on ONE instance only (the node_helper rejects a second owner). The
    // Home Assistant URL and token are read by the node_helper from ha-alerts.secret.json, never
    // from this config (config.js is served to the browser).
    plantAlertsEnabled: false,
    plantAlertEntity: "sensor.mirror_plant_alerts",
    plantAlertPollMs: 30 * 1000,
    plantAlertTimeoutMs: 10 * 1000,
    plantAlertStaleMs: 10 * 60 * 1000,
    // How long each popup stays up (0 = until the alerts clear) and how often it is re-shown
    // while alerts stay active (0 = never re-show).
    plantAlertPopupMs: 2 * 60 * 1000,
    plantAlertRepeatMs: 30 * 60 * 1000,
    plantAlertRecoveryNotice: true
  },

  getStyles() {
    return ["MMM-GrafanaTrends.css"];
  },

  getScripts() {
    return [this.file("plant-alert-popup.js")];
  },

  start() {
    this.wrapper = null;
    this.iframe = null;
    this.messageEl = null;
    this.theme = this._mirrorTheme();
    this.hidden = false;
    this.pendingReload = false;
    this.loadTimer = null;
    this.retryTimer = null;
    this.retryCount = 0;
    this.requestId = 0;

    this._clampRetryConfig();

    if (this.config.reloadInterval > 0) {
      this.reloadTimer = setInterval(() => this._load(), this.config.reloadInterval);
    }

    this.plantAlerts = null;
    this.plantNoticeEl = null;
    this.plantNoticeText = "";
    this.plantLastSeq = 0;
    this.plantWatchdog = null;
    this.plantGrace = null;
    this.plantResync = false;
    this.plantLocalMonitor = false;
    this.plantModel = { alerts: [], monitor: null };
    if (this.config.plantAlertsEnabled === true) this._startPlantAlerts();
  },

  // Coerce the plant alert options in place (design.md section 4.1). Only called when plant
  // alerts are enabled. The node_helper re-applies the timing clamps; it never trusts these.
  _clampPlantAlertConfig() {
    const c = this.config;
    const d = this.defaults;

    c.plantAlertEntity = typeof c.plantAlertEntity === "string" && PLANT_ENTITY_PATTERN.test(c.plantAlertEntity)
      ? c.plantAlertEntity
      : d.plantAlertEntity;

    // null, undefined, "" and non-numeric values fall back to the default (never to 0). Only an
    // explicit number 0 keeps its special meaning where one exists (popup/repeat).
    const num = (value, fallback, min, allowZero) => {
      if (allowZero && value === 0) return 0;
      const blank = value === null || value === undefined || (typeof value === "string" && value.trim() === "");
      return this._coerceDelayMs(blank ? fallback : value, fallback, min);
    };
    c.plantAlertPollMs = num(c.plantAlertPollMs, d.plantAlertPollMs, MIN_PLANT_POLL_MS, false);
    c.plantAlertTimeoutMs = Math.min(
      num(c.plantAlertTimeoutMs, d.plantAlertTimeoutMs, MIN_PLANT_TIMEOUT_MS, false),
      c.plantAlertPollMs - 1000
    );
    c.plantAlertStaleMs = num(
      c.plantAlertStaleMs,
      d.plantAlertStaleMs,
      Math.max(MIN_PLANT_STALE_MS, 2 * c.plantAlertPollMs),
      false
    );
    c.plantAlertPopupMs = num(c.plantAlertPopupMs, d.plantAlertPopupMs, MIN_PLANT_POPUP_MS, true);
    c.plantAlertRepeatMs = num(c.plantAlertRepeatMs, d.plantAlertRepeatMs, MIN_PLANT_REPEAT_MS, true);
    c.plantAlertRecoveryNotice = c.plantAlertRecoveryNotice !== false;
  },

  // Liveness watchdog. The helper only emits STATE on change, so silence alone is normal. If none
  // arrives for plantAlertStaleMs, re-send START (the helper treats a repeat START from the owner
  // as a replay request, and recreates the poller if the helper process restarted). If that
  // produces no reply within one poll period, show a local "not monitored" line. The watchdog
  // re-arms at plantAlertStaleMs, so there is no tight loop.
  _armPlantWatchdog() {
    clearTimeout(this.plantWatchdog);
    this.plantWatchdog = setTimeout(() => this._plantWatchdogFired(), this.config.plantAlertStaleMs);
  },

  _plantWatchdogFired() {
    try {
      if (!this.plantAlerts) return;
      this.plantResync = true;
      this._sendPlantStart();
      clearTimeout(this.plantGrace);
      this.plantGrace = setTimeout(() => this._plantGraceExpired(), this.config.plantAlertPollMs);
      this._armPlantWatchdog();
    } catch (err) {
      Log.error(`[${this.name}] plant alert watchdog failed (${err && err.name})`);
    }
  },

  _plantGraceExpired() {
    try {
      this.plantGrace = null;
      if (!this.plantAlerts) return;
      this.plantLocalMonitor = true;
      this.plantAlerts.update({
        alerts: this.plantModel.alerts,
        monitor: { glyph: "!", reason: "helper not responding" }
      });
    } catch (err) {
      Log.error(`[${this.name}] plant alert watchdog failed (${err && err.name})`);
    }
  },

  _sendPlantStart() {
    this.sendSocketNotification("GRAFANA_TRENDS_PLANT_ALERTS_START", {
      identifier: this.identifier,
      entity: this.config.plantAlertEntity,
      pollMs: this.config.plantAlertPollMs,
      timeoutMs: this.config.plantAlertTimeoutMs,
      staleMs: this.config.plantAlertStaleMs
    });
  },

  _startPlantAlerts() {
    this._clampPlantAlertConfig();

    if (this.config.haUrl || this.config.haTokenFile) {
      // Values are deliberately not logged.
      Log.warn(`[${this.name}] haUrl/haTokenFile are ignored; the Home Assistant URL and token are read from ha-alerts.secret.json`);
    }

    if (typeof GrafanaTrendsPlantAlertPopup === "undefined") {
      Log.error(`[${this.name}] plant-alert-popup.js did not load; plant alerts are disabled`);
      return;
    }

    this.plantAlerts = GrafanaTrendsPlantAlertPopup.createPopupController({
      send: (notification, payload) => this._sendPlantPopup(notification, payload),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t),
      durationMs: this.config.plantAlertPopupMs,
      repeatMs: this.config.plantAlertRepeatMs,
      recoveryNotice: this.config.plantAlertRecoveryNotice
    });

    this._sendPlantStart();
    this._armPlantWatchdog();
  },

  // The only place plant popups reach the core alert module. If the core alert behaviour on the
  // device differs from the assumptions in plant-alert-popup.js, change this and
  // buildShowAlertPayload() only.
  _sendPlantPopup(notification, payload) {
    this.sendNotification(notification, payload);
  },

  // State pushed by the node_helper (design.md section 3.1). Never throws.
  _handlePlantAlertState(payload) {
    try {
      if (!this.plantAlerts || !payload || typeof payload !== "object") return;
      if (payload.identifier !== this.identifier) return;
      if (payload.status === "rejected") {
        Log.warn(`[${this.name}] another MMM-GrafanaTrends instance owns plant alerts; this instance will not raise popups`);
        this.plantAlerts.destroy();
        this.plantAlerts = null;
        clearTimeout(this.plantWatchdog);
        clearTimeout(this.plantGrace);
        this.plantWatchdog = null;
        this.plantGrace = null;
        return;
      }
      if (!Number.isFinite(payload.seq)) return;
      // seq is strictly increasing per helper process. A lower seq is accepted only when the
      // helper has evidently restarted: it says "starting", or it answers our watchdog re-START.
      const restarted = payload.seq <= this.plantLastSeq && (payload.status === "starting" || this.plantResync);
      if (payload.seq <= this.plantLastSeq && !restarted) return;
      this.plantLastSeq = payload.seq;
      this.plantResync = false;
      this.plantLocalMonitor = false;
      clearTimeout(this.plantGrace);
      this.plantGrace = null;
      this._armPlantWatchdog();

      if (payload.status === "not_configured") {
        this._setPlantNotice("Plant alerts disabled: create ha-alerts.secret.json (see README)");
      } else if (payload.status === "auth_failed") {
        this._setPlantNotice("Plant alerts stopped: Home Assistant rejected the token");
      } else {
        this._setPlantNotice("");
      }

      if (!Array.isArray(payload.alerts)) return;
      const str = (v) => (v === null || v === undefined ? null : String(v));
      const alerts = payload.alerts
        .filter((a) => a && typeof a === "object")
        .map((a) => ({
          key: String(a.key),
          zone: String(a.zone),
          zoneName: String(a.zoneName),
          glyph: String(a.glyph),
          kind: String(a.kind),
          device: str(a.device),
          since: str(a.since),
          detail: a.detail === null || a.detail === undefined ? "" : String(a.detail)
        }));
      const m = payload.monitor;
      const monitor = m && typeof m === "object"
        ? { glyph: String(m.glyph), reason: String(m.reason) }
        : null;
      this.plantModel = { alerts, monitor };
      this.plantAlerts.update({ alerts, monitor });
    } catch (err) {
      Log.error(`[${this.name}] could not handle plant alert state (${err && err.name})`);
    }
  },

  // textContent only, never innerHTML. The text is cached so a state that arrives before
  // getDom() builds the element is still shown.
  _setPlantNotice(text) {
    this.plantNoticeText = text;
    if (!this.plantNoticeEl) return;
    this.plantNoticeEl.textContent = text;
    this.plantNoticeEl.style.display = text ? "block" : "none";
  },

  // Floor retryDelayMs/maxRetryDelayMs/reloadInterval at a sane minimum so a config of 0
  // (or anything below it, or a non-numeric value) can't turn a Grafana outage into a tight
  // reload+probe loop. A non-numeric value (e.g. "60s" from a config typo) would otherwise
  // make Math.max(5000, NaN) === NaN, and setTimeout(fn, NaN) fires after about 1ms - the
  // exact loop the floor was meant to prevent - so it's coerced back to the default first.
  _clampRetryConfig() {
    this.config.retryDelayMs = this._coerceDelayMs(
      this.config.retryDelayMs,
      this.defaults.retryDelayMs,
      MIN_RETRY_DELAY_MS
    );
    this.config.maxRetryDelayMs = this._coerceDelayMs(
      this.config.maxRetryDelayMs,
      this.defaults.maxRetryDelayMs,
      MIN_RETRY_DELAY_MS
    );

    // reloadInterval uses 0 to mean "never reload"; only floor it when it's meant to be
    // active. A non-numeric value falls back to the default (which is > 0) and then gets
    // floored like any other positive value.
    const reloadNum = Number(this.config.reloadInterval);
    this.config.reloadInterval = Number.isFinite(reloadNum) && reloadNum === 0
      ? 0
      : this._coerceDelayMs(this.config.reloadInterval, this.defaults.reloadInterval, MIN_RELOAD_INTERVAL_MS);
  },

  // Coerce a config value to a number; fall back to `fallback` when it isn't a finite
  // number (NaN, a non-numeric string, null-that-somehow-became-NaN, etc.), then floor the
  // result at `min`.
  _coerceDelayMs(value, fallback, min) {
    const num = Number(value);
    const base = Number.isFinite(num) ? num : fallback;
    return Math.max(min, base);
  },

  notificationReceived(notification, payload) {
    if (notification !== "PAGE_THEME_CHANGED" || !this.config.followMirrorTheme) return;
    if (payload?.mode !== "day" && payload?.mode !== "night") return;

    const theme = payload.mode === "day" ? "light" : "dark";
    if (theme === this.theme) return;
    this.theme = theme;
    this._load();
  },

  // The node_helper probe is the authoritative reachability check: it can see HTTP-level
  // failures (blocked embedding, a redirect to login, a non-2xx status) that a same-origin
  // `load` event on the iframe cannot, because Chromium fires `load` for those pages too.
  socketNotificationReceived(notification, payload) {
    if (notification === "GRAFANA_TRENDS_PLANT_ALERTS_STATE") {
      this._handlePlantAlertState(payload);
      return;
    }
    if (notification !== "GRAFANA_TRENDS_PROBE_RESULT") return;
    if (!payload || payload.identifier !== this.identifier) return;
    // Ignore a reply for a _load() that's no longer the latest one (e.g. a slow probe
    // answering after a theme change already triggered a newer load+probe).
    if (payload.requestId !== this.requestId) return;

    if (payload.ok) {
      this._handleLoadSuccess();
    } else {
      this._handleLoadFailure(payload.reason || "probe reported a failure");
    }
  },

  // Build the DOM once and hand back the same node, so MagicMirror redraws never reload Grafana
  getDom() {
    if (this.wrapper) return this.wrapper;

    const wrapper = document.createElement("div");
    wrapper.className = "grafana-trends-wrapper";
    const card = document.createElement("div");
    card.className = "grafana-trends-card";
    wrapper.appendChild(card);

    if (this.config.header) {
      const h = document.createElement("div");
      h.className = "grafana-trends-header";
      h.textContent = this.config.header;
      card.appendChild(h);
    }

    if (this.config.plantAlertsEnabled === true) {
      const notice = document.createElement("div");
      notice.className = "grafana-trends-alert-notice";
      notice.style.display = "none";
      card.appendChild(notice);
      this.plantNoticeEl = notice;
      if (this.plantNoticeText) this._setPlantNotice(this.plantNoticeText);
    }

    if (!this.config.url) {
      const msg = document.createElement("div");
      msg.className = "grafana-trends-message";
      msg.textContent = "Set the Grafana dashboard url in the MMM-GrafanaTrends config.";
      card.appendChild(msg);
      this.wrapper = wrapper;
      return wrapper;
    }

    const iframe = document.createElement("iframe");
    iframe.className = "grafana-trends-frame";
    iframe.style.width = typeof this.config.width === "number" ? `${this.config.width}px` : this.config.width;
    iframe.style.height = typeof this.config.height === "number" ? `${this.config.height}px` : this.config.height;
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("title", String(this.config.iframeTitle || "").trim() || this.defaults.iframeTitle);
    // `load` fires for blocked/redirected frames too (see socketNotificationReceived's
    // comment), so it only clears the hung-connection fallback timer here; the
    // node_helper probe result is what actually clears the error overlay/backoff.
    iframe.addEventListener("load", () => clearTimeout(this.loadTimer));
    iframe.addEventListener("error", () => this._handleLoadFailure("iframe error event"));
    card.appendChild(iframe);

    const message = document.createElement("div");
    message.className = "grafana-trends-message grafana-trends-message-overlay";
    message.style.display = "none";
    card.appendChild(message);

    this.iframe = iframe;
    this.messageEl = message;
    this.wrapper = wrapper;
    this._load();
    return wrapper;
  },

  suspend() {
    this.hidden = true;
    if (this.config.unloadWhenHidden && this.iframe) {
      this._clearTimers();
      // Blanking the iframe means resume() always needs to reload it - not just when a
      // theme change or reloadInterval tick happened to land while hidden.
      this.pendingReload = true;
      this.iframe.src = "about:blank";
    }
  },

  resume() {
    this.hidden = false;
    if (this.config.unloadWhenHidden && this.pendingReload) {
      this.pendingReload = false;
      this._load();
    }
  },

  _mirrorTheme() {
    if (!this.config.followMirrorTheme) return this.config.defaultTheme;
    if (typeof document === "undefined" || !document.body) return this.config.defaultTheme;
    const cl = document.body.classList;
    if (cl.contains("mm-day")) return "light";
    if (cl.contains("mm-night")) return "dark";
    return this.config.defaultTheme;
  },

  _buildUrl() {
    const url = new URL(this.config.url, window.location.href);
    // VERIFY: the `theme` query param is honoured by kiosk-mode dashboard URLs on
    // every Grafana version, but public-dashboard share links may ignore it
    // depending on the Grafana version running on the HA add-on.
    url.searchParams.set("theme", this.theme);
    // Cache-buster so a reload fetches fresh data rather than a cached page
    url.searchParams.set("_mm", String(Date.now()));
    return url.toString();
  },

  _load() {
    if (!this.iframe || !this.config.url) return;

    if (this.hidden && this.config.unloadWhenHidden) {
      this.pendingReload = true;
      return;
    }

    this._clearTimers();
    const src = this._buildUrl();
    Log.info(`[${this.name}] loading dashboard (theme ${this.theme})`);
    this.iframe.src = src;

    this.loadTimer = setTimeout(() => {
      this._handleLoadFailure("timed out");
    }, this.config.loadTimeoutMs);

    this.requestId += 1;

    // Never logged: the URL can carry a public-dashboard share token. The node_helper
    // only logs the request's origin, not the path/query.
    this.sendSocketNotification("GRAFANA_TRENDS_PROBE", {
      url: this._resolveProbeUrl(),
      identifier: this.identifier,
      requestId: this.requestId,
      embedderOrigin: typeof window !== "undefined" ? window.location.origin : null
    });
  },

  // Resolve config.url against the page origin before handing it to the helper, the same
  // way `_buildUrl()` already resolves it for the iframe, so a path-only relative url (e.g.
  // behind a reverse proxy: "/grafana/d/x?kiosk") probes correctly instead of the helper's
  // `new URL()` throwing "invalid dashboard url" for a setup the iframe itself accepts fine.
  // This does NOT rescue a bare "host:port/path" with no leading "/" or scheme (e.g.
  // "homeassistant.local:3000/d/x") - `new URL()` treats the "host:" part as an opaque
  // scheme rather than a hostname, so it "resolves" to a bogus absolute url either way. The
  // node_helper's http:/https:-only check (see node_helper.js) is what catches that case and
  // reports it as an invalid dashboard url instead of throwing or hanging.
  _resolveProbeUrl() {
    try {
      return new URL(this.config.url, window.location.href).href;
    } catch (err) {
      Log.warn(`[${this.name}] Could not resolve the dashboard url for the probe: ${err.message}`);
      return this.config.url;
    }
  },

  _handleLoadSuccess() {
    clearTimeout(this.loadTimer);
    this.loadTimer = null;
    this.retryCount = 0;
    this._hideMessage();
  },

  _handleLoadFailure(reason) {
    clearTimeout(this.loadTimer);
    this.loadTimer = null;

    const delay = Math.min(
      this.config.retryDelayMs * Math.pow(2, this.retryCount),
      this.config.maxRetryDelayMs
    );
    this.retryCount += 1;

    Log.warn(`[${this.name}] Grafana did not load (${reason}); retrying in ${Math.round(delay / 1000)}s`);
    this._showMessage(`Grafana is unavailable - retrying in ${Math.round(delay / 1000)}s`);

    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._load(), delay);
  },

  _showMessage(text) {
    if (!this.messageEl) return;
    this.messageEl.textContent = text;
    // The overlay is a flex container (css: .grafana-trends-message-overlay) so its text
    // stays centered; "block" would pin it to the top-left of the 1664px-tall card.
    this.messageEl.style.display = "flex";
  },

  _hideMessage() {
    if (!this.messageEl) return;
    this.messageEl.style.display = "none";
  },

  _clearTimers() {
    clearTimeout(this.loadTimer);
    this.loadTimer = null;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
});
