/* MMM-GrafanaTrends
 * Embeds one Grafana dashboard (kiosk or public/shared dashboard URL) in a glass card.
 * One iframe = one Grafana app instance, which keeps the Pi's memory/CPU use low compared
 * with embedding panels individually.
 */

/* global Module, Log */

Module.register("MMM-GrafanaTrends", {
  defaults: {
    // Grafana dashboard URL. Either a shared/public dashboard link
    // (http://<ha-host>:3000/public-dashboards/<token>) or a normal one with kiosk mode
    // (http://<ha-host>:3000/d/mirror-trends/mirror-trends?kiosk).
    url: "",
    header: "",
    width: "100%",
    height: 1480, // px; the dashboard is ~44 grid rows
    // Switch Grafana between light and dark with the mirror's body.mm-day / body.mm-night classes
    followMirrorTheme: true,
    defaultTheme: "dark",
    // Periodically reload the iframe so a long-running Grafana page can't accumulate memory
    reloadInterval: 6 * 60 * 60 * 1000,
    // Blank the iframe while the page is hidden (saves CPU, costs a reload when shown)
    unloadWhenHidden: false
  },

  getStyles() {
    return ["MMM-GrafanaTrends.css"];
  },

  start() {
    this.wrapper = null;
    this.iframe = null;
    this.theme = this._mirrorTheme();
    if (this.config.followMirrorTheme) {
      this.observer = new MutationObserver(() => {
        const theme = this._mirrorTheme();
        if (theme !== this.theme) {
          this.theme = theme;
          this._load();
        }
      });
      this.observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    }
    if (this.config.reloadInterval > 0) {
      setInterval(() => this._load(), this.config.reloadInterval);
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
    card.appendChild(iframe);

    this.iframe = iframe;
    this.wrapper = wrapper;
    this._load();
    return wrapper;
  },

  suspend() {
    if (this.config.unloadWhenHidden && this.iframe) this.iframe.src = "about:blank";
  },

  resume() {
    if (this.config.unloadWhenHidden) this._load();
  },

  _mirrorTheme() {
    if (!this.config.followMirrorTheme) return this.config.defaultTheme;
    const cl = document.body.classList;
    if (cl.contains("mm-day")) return "light";
    if (cl.contains("mm-night")) return "dark";
    return this.config.defaultTheme;
  },

  _buildUrl() {
    const url = new URL(this.config.url, window.location.href);
    url.searchParams.set("theme", this.theme);
    // Cache-buster so a reload fetches fresh data rather than a cached page
    url.searchParams.set("_mm", String(Date.now()));
    return url.toString();
  },

  _load() {
    if (!this.iframe || !this.config.url) return;
    const src = this._buildUrl();
    Log.info(`[${this.name}] loading dashboard (theme ${this.theme})`);
    this.iframe.src = src;
  }
});
