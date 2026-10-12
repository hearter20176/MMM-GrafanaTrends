/* MMM-GrafanaTrends: plant alert popup helpers.
 * Pure, dependency-free. Loaded in the browser by MMM-GrafanaTrends.getScripts() (global
 * GrafanaTrendsPlantAlertPopup) and required directly by the tests under Node.
 *
 * ASSUMPTION (design.md section 3.4): the core `alert` module renders `title`/`message` as HTML,
 * keys popups by the sender module name, and keeps a `type: "alert"` popup up until HIDE_ALERT
 * when no `timer` is passed. All dependence on that behaviour is confined to
 * buildShowAlertPayload()/buildRecoveryPayload() here and _sendPlantPopup() in the module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GrafanaTrendsPlantAlertPopup = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MONITOR_KEY = "__monitor__";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DEVICE_LABELS = { soil_sensor: "soil sensor", waterer: "waterer" };
  const RECOVERY_TIMER_MS = 10000;
  // Only these kinds become a CSS modifier class; the raw HA kind string is never put in a class.
  const KIND_CLASSES = { connection_lost: "grafana-trends-popup-connection_lost", reservoir_empty: "grafana-trends-popup-reservoir_empty" };

  const escapeHtml = (value) => {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

  // Same local calendar day as `now` -> "HH:MM"; otherwise "Mon D HH:MM". Invalid -> "".
  const formatSince = (iso, now) => {
    if (typeof iso !== "string" || iso === "") return "";
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const d = new Date(ms);
    const ref = new Date(Number.isFinite(now) ? now : Date.now());
    const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const sameDay = d.getFullYear() === ref.getFullYear()
      && d.getMonth() === ref.getMonth()
      && d.getDate() === ref.getDate();
    return sameDay ? hhmm : `${MONTHS[d.getMonth()]} ${d.getDate()} ${hhmm}`;
  };

  // Plain text, not escaped; buildShowAlertPayload() escapes at the HTML boundary.
  const formatLine = (alert, now) => {
    const a = alert || {};
    const zoneName = a.zoneName ? String(a.zoneName) : "Unknown zone";
    const since = formatSince(a.since, now);
    let text;
    if (a.kind === "reservoir_empty") {
      text = `${zoneName} - reservoir may be empty`;
    } else {
      const device = DEVICE_LABELS[a.device] || "device";
      text = `${zoneName} - ${device} offline`;
    }
    if (since) text += ` since ${since}`;
    if (typeof a.detail === "string" && a.detail !== "") text += ` (${a.detail})`;
    return text;
  };

  // Monitor line first, then alerts in the order received (the helper already sorted them).
  const buildLines = (model, now) => {
    const m = model || {};
    const lines = [];
    if (m.monitor) {
      lines.push({
        key: MONITOR_KEY,
        glyph: m.monitor.glyph ? String(m.monitor.glyph) : "!",
        text: `Plant alerts not monitored - ${m.monitor.reason ? String(m.monitor.reason) : "unknown"}`,
        isMonitor: true
      });
    }
    const alerts = Array.isArray(m.alerts) ? m.alerts : [];
    alerts.forEach((alert, i) => {
      if (!alert || typeof alert !== "object") return;
      lines.push({
        key: alert.key ? String(alert.key) : `${alert.kind}:${alert.zone}:${alert.device || "-"}:${i}`,
        glyph: alert.glyph ? String(alert.glyph) : "?",
        text: formatLine(alert, now),
        kind: alert.kind,
        isMonitor: false
      });
    });
    return lines;
  };

  const buildShowAlertPayload = (lines) => {
    const html = (Array.isArray(lines) ? lines : []).map((line) => {
      let cls = "grafana-trends-popup-line";
      if (line.isMonitor) {
        cls += " grafana-trends-popup-monitor";
      } else if (typeof line.kind === "string" && Object.prototype.hasOwnProperty.call(KIND_CLASSES, line.kind)) {
        cls += ` ${KIND_CLASSES[line.kind]}`;
      }
      return `<div class="${cls}"><span class="grafana-trends-glyph">${escapeHtml(line.glyph)}</span> ${escapeHtml(line.text)}</div>`;
    }).join("");
    // No `timer` and no `imageFA`: the controller owns the duration (design.md section 3.4, A3).
    return {
      type: "alert",
      title: "Plant alert",
      message: `<div class="grafana-trends-popup">${html}</div>`
    };
  };

  const buildRecoveryPayload = (hadRealAlerts) => ({
    type: "notification",
    title: hadRealAlerts ? "Plant alerts cleared" : "Plant alert monitoring restored",
    message: "",
    timer: RECOVERY_TIMER_MS
  });

  // opts: { send(notification, payload), setTimer(fn, ms), clearTimer(handle), durationMs, repeatMs,
  //         recoveryNotice, now() }
  const createPopupController = (opts) => {
    const o = opts || {};
    const send = typeof o.send === "function" ? o.send : () => {};
    const setTimer = typeof o.setTimer === "function" ? o.setTimer : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof o.clearTimer === "function" ? o.clearTimer : (t) => clearTimeout(t);
    const nowFn = typeof o.now === "function" ? o.now : () => Date.now();
    const durationMs = Number(o.durationMs) > 0 ? Number(o.durationMs) : 0;
    const repeatMs = Number(o.repeatMs) > 0 ? Number(o.repeatMs) : 0;

    let prevKeys = new Set();
    let visible = false;
    let lastMessage = null;
    let hideTimer = null;
    let repeatTimer = null;
    let currentModel = { alerts: [], monitor: null };

    const clearTimers = () => {
      if (hideTimer !== null) clearTimer(hideTimer);
      if (repeatTimer !== null) clearTimer(repeatTimer);
      hideTimer = null;
      repeatTimer = null;
    };

    const show = (lines) => {
      if (visible) send("HIDE_ALERT", {});
      const payload = buildShowAlertPayload(lines);
      lastMessage = payload.message;
      send("SHOW_ALERT", payload);
      visible = true;
    };

    const startTimers = () => {
      clearTimers();
      if (durationMs > 0) {
        hideTimer = setTimer(() => {
          hideTimer = null;
          send("HIDE_ALERT", {});
          visible = false;
        }, durationMs);
      }
      if (repeatMs > 0) {
        repeatTimer = setTimer(() => {
          repeatTimer = null;
          const lines = buildLines(currentModel, nowFn());
          if (lines.length > 0) {
            show(lines);
            startTimers();
          }
        }, repeatMs);
      }
    };

    const update = (model) => {
      currentModel = { alerts: (model && model.alerts) || [], monitor: (model && model.monitor) || null };
      const lines = buildLines(currentModel, nowFn());
      const keys = new Set(lines.map((l) => l.key));

      if (keys.size === 0) {
        if (prevKeys.size > 0) {
          send("HIDE_ALERT", {});
          clearTimers();
          visible = false;
          if (o.recoveryNotice) {
            const hadReal = Array.from(prevKeys).some((k) => k !== MONITOR_KEY);
            send("SHOW_ALERT", buildRecoveryPayload(hadReal));
          }
        }
        prevKeys = keys;
        return;
      }

      let gained = false;
      keys.forEach((k) => {
        if (!prevKeys.has(k)) gained = true;
      });

      if (gained) {
        show(lines);
        startTimers();
      } else if (visible) {
        const message = buildShowAlertPayload(lines).message;
        if (message !== lastMessage) show(lines);
      }
      prevKeys = keys;
    };

    const destroy = () => {
      clearTimers();
      if (visible) send("HIDE_ALERT", {});
      visible = false;
    };

    return { update, destroy };
  };

  return {
    escapeHtml,
    formatSince,
    formatLine,
    buildLines,
    buildShowAlertPayload,
    buildRecoveryPayload,
    createPopupController
  };
});
