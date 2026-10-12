/* Pure rules for the plant-alert poller: secret-file validation, Home Assistant state
 * parsing/normalization, the "not monitored" decision, and the change fingerprint.
 * No I/O. Only dependency is ./zones, so node_helper, the poller and tests can all require it.
 *
 * Every reason string returned here comes from a fixed set (never from Home Assistant text),
 * so it is safe to log and to show on the mirror.
 */

const { ZONES, MONITOR_GLYPH, UNKNOWN_ZONE_GLYPH } = require("./zones");

const DEFAULT_ENTITY = "sensor.mirror_plant_alerts";
const ENTITY_PATTERN = /^sensor\.[a-z0-9_]+$/;

const SECRET_MAX_BYTES = 8 * 1024;
const TOKEN_MIN_LENGTH = 20;
const PLACEHOLDER_TOKEN = "REPLACE_WITH_LONG_LIVED_TOKEN_FROM_A_DEDICATED_NON_ADMIN_HA_USER";

const MAX_ALERTS = 20;
const MAX_DETAIL_LENGTH = 200;
const MAX_ZONE_NAME_LENGTH = 40;
const MAX_SINCE_LENGTH = 40;

const KINDS = ["connection_lost", "reservoir_empty"];
const DEVICES = ["soil_sensor", "waterer"];

const DEFAULT_TIMINGS = { pollMs: 30000, timeoutMs: 10000, staleMs: 600000 };
const MAX_POLL_MS = 60 * 60 * 1000;
const MAX_STALE_MS = 24 * 60 * 60 * 1000;

// C0 and C1 control characters (includes newline/tab and DEL).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** The entity id if it is a sensor.* id, else the default. */
function sanitizeEntity(entity) {
  return typeof entity === "string" && ENTITY_PATTERN.test(entity) ? entity : DEFAULT_ENTITY;
}

/** Validate the text of ha-alerts.secret.json. The reason never echoes file content. */
function validateSecret(text) {
  const invalid = { ok: false, reason: "secret file invalid" };
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > SECRET_MAX_BYTES) return invalid;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return invalid;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return invalid;

  if (typeof data.url !== "string" || typeof data.token !== "string") return invalid;

  let parsed;
  try {
    parsed = new URL(data.url.trim());
  } catch {
    return invalid;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return invalid;
  if (parsed.search || parsed.hash || /[?#]/.test(data.url)) return invalid;
  const url = parsed.href.replace(/\/+$/, "");

  const token = data.token.trim();
  if (token.length < TOKEN_MIN_LENGTH || /\s/.test(token) || token === PLACEHOLDER_TOKEN) return invalid;

  return { ok: true, url, token };
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value.replace(CONTROL_CHARS, "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function zoneOrder(zones, id) {
  const index = zones.findIndex((zone) => zone.id === id);
  return index === -1 ? zones.length : index;
}

/**
 * Normalize the raw `attributes.alerts` array. rawState is the entity's state string, used for
 * the count-mismatch check. Returns { alerts, degradedReason } where degradedReason is the first
 * problem found (or null). A real alert is never dropped for a naming problem: unknown zones are
 * kept with the "?" glyph.
 */
function normalizeAlerts(rawAlerts, rawState, zones = ZONES) {
  const alerts = [];
  const seen = new Set();
  let degradedReason = null;
  const degrade = (reason) => {
    if (!degradedReason) degradedReason = reason;
  };

  for (const raw of rawAlerts) {
    if (!raw || typeof raw !== "object" || typeof raw.zone !== "string" || !KINDS.includes(raw.kind)) {
      degrade("malformed alert entry");
      continue;
    }

    const known = zones.find((zone) => zone.id === raw.zone);
    let zone;
    let zoneName;
    let glyph;
    if (known) {
      zone = known.id;
      zoneName = known.name;
      glyph = known.glyph;
      if (raw.symbol !== undefined && raw.symbol !== null && raw.symbol !== glyph) degrade("symbol mismatch");
    } else {
      zone = cleanText(raw.zone, MAX_ZONE_NAME_LENGTH);
      zoneName = zone;
      glyph = UNKNOWN_ZONE_GLYPH;
      degrade("unknown zone");
    }

    let device = null;
    if (raw.kind === "connection_lost") {
      if (DEVICES.includes(raw.device)) {
        device = raw.device;
      } else {
        degrade("malformed alert entry");
      }
    }

    const key = `${raw.kind}:${zone}:${device || "-"}`;
    if (seen.has(key)) {
      degrade("malformed alert entry");
      continue;
    }
    if (alerts.length >= MAX_ALERTS) {
      degrade("malformed contract");
      continue;
    }
    seen.add(key);

    const since = typeof raw.since === "string" && raw.since.length <= MAX_SINCE_LENGTH && Number.isFinite(Date.parse(raw.since)) ? raw.since : null;

    alerts.push({ key, zone, zoneName, glyph, kind: raw.kind, device, since, detail: cleanText(raw.detail, MAX_DETAIL_LENGTH) });
  }

  if (!degradedReason && Number(rawState) !== rawAlerts.length) degrade("alert count mismatch");

  const deviceOrder = (device) => (device === null ? DEVICES.length : DEVICES.indexOf(device));
  alerts.sort(
    (a, b) =>
      zoneOrder(zones, a.zone) - zoneOrder(zones, b.zone) ||
      KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
      deviceOrder(a.device) - deviceOrder(b.device)
  );

  return { alerts, degradedReason };
}

/**
 * Classify one HTTP response from Home Assistant.
 * outcome: "ok" | "degraded" | "auth_failed". alerts is null when there is no usable list
 * (the caller keeps the last good set).
 */
function parseStateResponse({ statusCode, bodyText }, { zones = ZONES } = {}) {
  const degraded = (reason) => ({ outcome: "degraded", alerts: null, reason, statusCode });

  if (statusCode === 401 || statusCode === 403) {
    return { outcome: "auth_failed", alerts: null, reason: `token rejected (HTTP ${statusCode})`, statusCode };
  }
  if (statusCode === 404) return degraded("entity not found");
  if (statusCode !== 200) return degraded(`HTTP ${statusCode}`);

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return degraded("malformed contract");
  }
  if (!body || typeof body !== "object") return degraded("malformed contract");

  const state = body.state;
  if (state === "unavailable" || state === "unknown") return degraded("entity unavailable");
  if (typeof state !== "string" || !/^\d+$/.test(state)) return degraded("malformed contract");

  const attributes = body.attributes;
  if (!attributes || typeof attributes !== "object") return degraded("malformed contract");
  if (typeof attributes.schema !== "number") return degraded("malformed contract");
  if (attributes.schema !== 1) return degraded("unsupported schema");
  if (!Array.isArray(attributes.alerts)) return degraded("malformed contract");

  const { alerts, degradedReason } = normalizeAlerts(attributes.alerts, state, zones);
  return { outcome: degradedReason ? "degraded" : "ok", alerts, reason: degradedReason, statusCode };
}

/**
 * The "not monitored" pseudo-alert, or null. auth_failed and not_configured are immediate; a
 * degraded poll raises it only once it has been failing for staleMs since lastGoodAt.
 */
function decideMonitor({ outcome, reason, lastGoodAt, now, staleMs }) {
  if (outcome === "auth_failed") return { glyph: MONITOR_GLYPH, reason: reason || "token rejected (HTTP 401)" };
  if (outcome === "not_configured") return { glyph: MONITOR_GLYPH, reason: "not configured" };
  if (outcome === "degraded" && now - lastGoodAt >= staleMs) {
    return { glyph: MONITOR_GLYPH, reason: reason || "Home Assistant unreachable" };
  }
  return null;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Stable string of the parts of a state payload that matter for "did anything change". */
function fingerprint(payload) {
  return stableStringify({ status: payload.status, alerts: payload.alerts, monitor: payload.monitor });
}

function coerceMs(value, fallback) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** Re-apply the front end's timing floors and caps; the helper never trusts the browser. */
function clampPlantAlertTimings({ pollMs, timeoutMs, staleMs } = {}) {
  const poll = Math.min(MAX_POLL_MS, Math.max(10000, coerceMs(pollMs, DEFAULT_TIMINGS.pollMs)));
  const timeout = Math.min(poll - 1000, Math.max(2000, coerceMs(timeoutMs, DEFAULT_TIMINGS.timeoutMs)));
  const stale = Math.max(Math.max(60000, 2 * poll), Math.min(MAX_STALE_MS, coerceMs(staleMs, DEFAULT_TIMINGS.staleMs)));
  return { pollMs: poll, timeoutMs: timeout, staleMs: stale };
}

module.exports = {
  DEFAULT_ENTITY,
  SECRET_MAX_BYTES,
  sanitizeEntity,
  validateSecret,
  normalizeAlerts,
  parseStateResponse,
  decideMonitor,
  fingerprint,
  clampPlantAlertTimings
};
