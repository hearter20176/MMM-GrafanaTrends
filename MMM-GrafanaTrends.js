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
    maxRetryDelayMs: 10 * 60 * 1000
  },

  getStyles() {
    return ["MMM-GrafanaTrends.css"];
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
    iframe.setAttribute("title", "Grafana trends");
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
