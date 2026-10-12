/* Tests for plant-alert-rules.js (pure functions, no I/O). */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeEntity,
  validateSecret,
  parseStateResponse,
  decideMonitor,
  fingerprint,
  clampPlantAlertTimings
} = require("../plant-alert-rules");

const TOKEN = "a-valid-long-lived-token-0123456789";

function alertEntry(overrides) {
  return Object.assign(
    {
      zone: "kitchen",
      symbol: "\u25A0",
      kind: "connection_lost",
      device: "soil_sensor",
      since: "2026-10-12T14:05:00-04:00",
      detail: "no report for 3 h"
    },
    overrides
  );
}

function body(alerts, overrides) {
  return JSON.stringify(
    Object.assign(
      {
        entity_id: "sensor.mirror_plant_alerts",
        state: String(alerts.length),
        attributes: { schema: 1, alerts }
      },
      overrides
    )
  );
}

function parse(alerts, overrides) {
  return parseStateResponse({ statusCode: 200, bodyText: body(alerts, overrides) }, {});
}

test("sanitizeEntity accepts sensor ids and falls back to the default otherwise", () => {
  assert.equal(sanitizeEntity("sensor.my_alerts_2"), "sensor.my_alerts_2");
  assert.equal(sanitizeEntity("switch.thing"), "sensor.mirror_plant_alerts");
  assert.equal(sanitizeEntity("sensor.Bad"), "sensor.mirror_plant_alerts");
  assert.equal(sanitizeEntity(undefined), "sensor.mirror_plant_alerts");
});

test("validateSecret: a valid file returns url (trailing slash stripped) and trimmed token", () => {
  const result = validateSecret(JSON.stringify({ url: "http://ha.local:8123/", token: `  ${TOKEN}  ` }));
  assert.deepEqual(result, { ok: true, url: "http://ha.local:8123", token: TOKEN });
});

test("validateSecret: a base path is allowed for a reverse proxy", () => {
  const result = validateSecret(JSON.stringify({ url: "https://example.org/ha/", token: TOKEN }));
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://example.org/ha");
});

test("validateSecret: missing url or token is invalid", () => {
  assert.equal(validateSecret(JSON.stringify({ token: TOKEN })).ok, false);
  assert.equal(validateSecret(JSON.stringify({ url: "http://ha.local:8123" })).ok, false);
  assert.equal(validateSecret("[]").ok, false);
  assert.equal(validateSecret("null").ok, false);
});

test("validateSecret: short or whitespace-containing tokens are invalid", () => {
  assert.equal(validateSecret(JSON.stringify({ url: "http://ha.local:8123", token: "short" })).ok, false);
  assert.equal(validateSecret(JSON.stringify({ url: "http://ha.local:8123", token: `${TOKEN} extra` })).ok, false);
});

test("validateSecret: the example placeholder token is rejected", () => {
  const placeholder = "REPLACE_WITH_LONG_LIVED_TOKEN_FROM_A_DEDICATED_NON_ADMIN_HA_USER";
  assert.equal(validateSecret(JSON.stringify({ url: "http://ha.local:8123", token: placeholder })).ok, false);
});

test("validateSecret: non-http(s) url and url with query or hash are invalid", () => {
  assert.equal(validateSecret(JSON.stringify({ url: "ftp://ha.local", token: TOKEN })).ok, false);
  assert.equal(validateSecret(JSON.stringify({ url: "http://ha.local:8123/?x=1", token: TOKEN })).ok, false);
  assert.equal(validateSecret(JSON.stringify({ url: "http://ha.local:8123/#frag", token: TOKEN })).ok, false);
  assert.equal(validateSecret(JSON.stringify({ url: "not a url", token: TOKEN })).ok, false);
});

test("validateSecret: garbage JSON gives a generic reason that contains no file text", () => {
  const result = validateSecret("{ this is SECRET-FILE-TEXT not json");
  assert.deepEqual(result, { ok: false, reason: "secret file invalid" });
});

test("validateSecret: a file over 8 KiB is invalid", () => {
  const big = JSON.stringify({ url: "http://ha.local:8123", token: TOKEN, pad: "x".repeat(9000) });
  assert.equal(validateSecret(big).ok, false);
});

test("parseStateResponse: ok with 0 alerts", () => {
  const result = parse([]);
  assert.equal(result.outcome, "ok");
  assert.deepEqual(result.alerts, []);
  assert.equal(result.reason, null);
});

test("parseStateResponse: ok with 1 alert, glyph and zone name from the zone table", () => {
  const result = parse([alertEntry({})]);
  assert.equal(result.outcome, "ok");
  assert.deepEqual(result.alerts, [
    {
      key: "connection_lost:kitchen:soil_sensor",
      zone: "kitchen",
      zoneName: "Kitchen",
      glyph: "\u25A0",
      kind: "connection_lost",
      device: "soil_sensor",
      since: "2026-10-12T14:05:00-04:00",
      detail: "no report for 3 h"
    }
  ]);
});

test("parseStateResponse: 3 alerts are sorted by zone, kind, then device", () => {
  const result = parse([
    alertEntry({ zone: "kitchen", symbol: "\u25A0", kind: "reservoir_empty", device: null }),
    alertEntry({ zone: "family_room", symbol: "\u25CF", device: "waterer" }),
    alertEntry({ zone: "family_room", symbol: "\u25CF", device: "soil_sensor" })
  ]);
  assert.equal(result.outcome, "ok");
  assert.deepEqual(
    result.alerts.map((a) => a.key),
    [
      "connection_lost:family_room:soil_sensor",
      "connection_lost:family_room:waterer",
      "reservoir_empty:kitchen:-"
    ]
  );
});

test("parseStateResponse: unavailable and unknown states are degraded with no alert list", () => {
  for (const state of ["unavailable", "unknown"]) {
    const result = parse([], { state });
    assert.equal(result.outcome, "degraded");
    assert.equal(result.reason, "entity unavailable");
    assert.equal(result.alerts, null);
  }
});

test("parseStateResponse: non-numeric state is a malformed contract", () => {
  assert.equal(parse([], { state: "lots" }).reason, "malformed contract");
});

test("parseStateResponse: missing or unsupported schema", () => {
  assert.equal(parse([], { attributes: { alerts: [] } }).reason, "malformed contract");
  const v2 = parse([], { attributes: { schema: 2, alerts: [] } });
  assert.equal(v2.outcome, "degraded");
  assert.equal(v2.reason, "unsupported schema");
  assert.equal(v2.alerts, null);
});

test("parseStateResponse: alerts missing or not an array is a malformed contract", () => {
  assert.equal(parse([], { attributes: { schema: 1 } }).reason, "malformed contract");
  assert.equal(parse([], { attributes: { schema: 1, alerts: "x" } }).reason, "malformed contract");
  assert.equal(parse([], { attributes: { schema: 1, alerts: "x" } }).alerts, null);
});

test("parseStateResponse: a non-JSON body is a malformed contract", () => {
  const result = parseStateResponse({ statusCode: 200, bodyText: "<html>nope</html>" }, {});
  assert.equal(result.outcome, "degraded");
  assert.equal(result.reason, "malformed contract");
});

test("parseStateResponse: 401 and 403 are auth_failed", () => {
  const r401 = parseStateResponse({ statusCode: 401, bodyText: "" }, {});
  assert.equal(r401.outcome, "auth_failed");
  assert.equal(r401.reason, "token rejected (HTTP 401)");
  assert.equal(parseStateResponse({ statusCode: 403, bodyText: "" }, {}).reason, "token rejected (HTTP 403)");
});

test("parseStateResponse: 404 and 500 are degraded", () => {
  assert.equal(parseStateResponse({ statusCode: 404, bodyText: "" }, {}).reason, "entity not found");
  const r500 = parseStateResponse({ statusCode: 500, bodyText: "" }, {});
  assert.equal(r500.outcome, "degraded");
  assert.equal(r500.reason, "HTTP 500");
});

test("parseStateResponse: count mismatch applies the alerts and degrades the poll", () => {
  const result = parse([alertEntry({})], { state: "2" });
  assert.equal(result.outcome, "degraded");
  assert.equal(result.reason, "alert count mismatch");
  assert.equal(result.alerts.length, 1);
});

test("parseStateResponse: an unknown zone is kept with the ? glyph and the raw zone as its name", () => {
  const result = parse([alertEntry({ zone: "garage", symbol: undefined })]);
  assert.equal(result.outcome, "degraded");
  assert.equal(result.reason, "unknown zone");
  assert.equal(result.alerts[0].glyph, "?");
  assert.equal(result.alerts[0].zoneName, "garage");
});

test("parseStateResponse: a very long unknown zone name is truncated to 40 chars", () => {
  const result = parse([alertEntry({ zone: "z".repeat(100), symbol: undefined })]);
  assert.equal(result.alerts[0].zoneName.length, 40);
});

test("parseStateResponse: a symbol that differs from the zone table degrades but the table glyph is shown", () => {
  const result = parse([alertEntry({ symbol: "\u25CF" })]);
  assert.equal(result.reason, "symbol mismatch");
  assert.equal(result.alerts[0].glyph, "\u25A0");
});

test("parseStateResponse: an unknown kind is dropped and degrades the poll", () => {
  const result = parse([alertEntry({ kind: "on_fire" }), alertEntry({ device: "waterer" })], { state: "2" });
  assert.equal(result.outcome, "degraded");
  assert.equal(result.reason, "malformed alert entry");
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].device, "waterer");
});

test("parseStateResponse: an invalid device becomes null and degrades; reservoir_empty ignores device", () => {
  const bad = parse([alertEntry({ device: "toaster" })]);
  assert.equal(bad.reason, "malformed alert entry");
  assert.equal(bad.alerts[0].device, null);

  const reservoir = parse([alertEntry({ kind: "reservoir_empty", device: "waterer" })]);
  assert.equal(reservoir.outcome, "ok");
  assert.equal(reservoir.alerts[0].device, null);
  assert.equal(reservoir.alerts[0].key, "reservoir_empty:kitchen:-");
});

test("parseStateResponse: a duplicate key keeps the first entry and degrades", () => {
  const result = parse([alertEntry({ detail: "first" }), alertEntry({ detail: "second" })], { state: "2" });
  assert.equal(result.reason, "malformed alert entry");
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].detail, "first");
});

test("parseStateResponse: 25 entries are truncated to 20 and degrade", () => {
  const entries = [];
  for (let i = 0; i < 25; i += 1) entries.push(alertEntry({ zone: `zone_${i}`, symbol: undefined }));
  const result = parse(entries);
  assert.equal(result.alerts.length, 20);
  assert.equal(result.outcome, "degraded");
});

test("parseStateResponse: detail is stored raw (escaping is the front end's job), stripped of control chars, truncated", () => {
  const raw = parse([alertEntry({ detail: "  <script>a&b</script>\u0000\u0007\n  " })]);
  assert.equal(raw.alerts[0].detail, "<script>a&b</script>");

  const long = parse([alertEntry({ detail: "x".repeat(500) })]);
  assert.ok(long.alerts[0].detail.length <= 200);
  assert.ok(long.alerts[0].detail.endsWith("..."));

  assert.equal(parse([alertEntry({ detail: 42 })]).alerts[0].detail, "");
});

test("parseStateResponse: an invalid since becomes null without degrading the poll", () => {
  const result = parse([alertEntry({ since: "yesterday-ish" })]);
  assert.equal(result.outcome, "ok");
  assert.equal(result.alerts[0].since, null);
});

test("decideMonitor: degraded inside the stale window has no monitor, outside it does", () => {
  const base = { outcome: "degraded", reason: "request timed out", lastGoodAt: 1000, staleMs: 600000 };
  assert.equal(decideMonitor({ ...base, now: 1000 + 599999 }), null);
  assert.deepEqual(decideMonitor({ ...base, now: 1000 + 600000 }), { glyph: "!", reason: "request timed out" });
});

test("decideMonitor: auth_failed and not_configured are immediate; ok clears it", () => {
  assert.deepEqual(
    decideMonitor({ outcome: "auth_failed", reason: "token rejected (HTTP 403)", lastGoodAt: 0, now: 0, staleMs: 600000 }),
    { glyph: "!", reason: "token rejected (HTTP 403)" }
  );
  assert.deepEqual(decideMonitor({ outcome: "not_configured" }), { glyph: "!", reason: "not configured" });
  assert.equal(decideMonitor({ outcome: "ok", lastGoodAt: 0, now: 99999999, staleMs: 600000 }), null);
});

test("fingerprint: ignores key order and timestamps, changes with status, alerts or monitor", () => {
  const a = { status: "ok", alerts: [{ key: "k", zone: "z" }], monitor: null, checkedAt: 1, lastGoodAt: 1 };
  const b = { monitor: null, alerts: [{ zone: "z", key: "k" }], status: "ok", checkedAt: 2, lastGoodAt: 2 };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, status: "stale" }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, alerts: [] }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, monitor: { glyph: "!", reason: "x" } }));
});

test("clampPlantAlertTimings: defaults for non-finite values, floors for small ones", () => {
  assert.deepEqual(clampPlantAlertTimings({}), { pollMs: 30000, timeoutMs: 10000, staleMs: 600000 });
  assert.deepEqual(clampPlantAlertTimings({ pollMs: "30s", timeoutMs: NaN, staleMs: null }), {
    pollMs: 30000,
    timeoutMs: 10000,
    staleMs: 600000
  });
  const zeros = clampPlantAlertTimings({ pollMs: 0, timeoutMs: 0, staleMs: 0 });
  assert.equal(zeros.pollMs, 10000);
  assert.equal(zeros.timeoutMs, 2000);
  assert.equal(zeros.staleMs, 60000);
});

test("clampPlantAlertTimings: timeout is capped below the poll period, stale has a 2x poll floor", () => {
  const t = clampPlantAlertTimings({ pollMs: 15000, timeoutMs: 60000, staleMs: 1000 });
  assert.equal(t.timeoutMs, 14000);
  assert.equal(t.staleMs, 60000);
  assert.equal(clampPlantAlertTimings({ pollMs: 120000, staleMs: 1000 }).staleMs, 240000);
});

test("clampPlantAlertTimings: huge values are capped to timer-safe maxima", () => {
  const t = clampPlantAlertTimings({ pollMs: 1e12, timeoutMs: 1e12, staleMs: 1e12 });
  assert.ok(t.pollMs <= 3600000);
  assert.ok(t.timeoutMs < t.pollMs);
  assert.ok(t.staleMs <= 2 ** 31 - 1);
});
