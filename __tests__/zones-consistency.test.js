/* Checks that the zone table (zones.js), the Grafana export and the Home Assistant package
 * all use the same zone glyphs. Fails if either deliverable is missing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ZONES, ZONE_GLYPH_ALLOWLIST } = require("../zones");

const ROOT = path.join(__dirname, "..");
const DASHBOARD_PATH = path.join(ROOT, "grafana", "indoor-plants.dashboard.json");
const PACKAGE_PATH = path.join(ROOT, "docs", "homeassistant", "mirror_plants.yaml");

const hex = (glyph) => glyph.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");

test("zones.js: 3 zones, unique glyphs in allowlist order, no variation selectors", () => {
  assert.equal(ZONES.length, 3);
  const glyphs = ZONES.map((z) => z.glyph);
  assert.equal(new Set(glyphs).size, glyphs.length);
  assert.deepEqual(glyphs, ZONE_GLYPH_ALLOWLIST.slice(0, 3));
  for (const zone of ZONES) {
    assert.match(zone.id, /^[a-z_]+$/);
    assert.equal(Array.from(zone.glyph).length, 1, "a glyph is a single code point");
  }
  const source = fs.readFileSync(path.join(ROOT, "zones.js"), "utf8");
  assert.ok(!/\\u(FE0E|FE0F)/i.test(source));
  assert.ok(!/[\uFE0E\uFE0F]/.test(source));
});

function loadDashboard() {
  assert.ok(fs.existsSync(DASHBOARD_PATH), "grafana/indoor-plants.dashboard.json is missing");
  return JSON.parse(fs.readFileSync(DASHBOARD_PATH, "utf8"));
}

// Every string stored under a key named query/rawSql/expr, at any depth.
function collectQueryStrings(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => collectQueryStrings(child, out));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if ((key === "query" || key === "rawSql" || key === "expr") && typeof value === "string") out.push(value);
      collectQueryStrings(value, out);
    }
  }
  return out;
}

function collectStrings(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((child) => collectStrings(child, out));
  else if (node && typeof node === "object") Object.values(node).forEach((child) => collectStrings(child, out));
  return out;
}

function zonesReferenced(queryText) {
  return ZONES.filter((zone) => Object.values(zone.entities).some((id) => queryText.includes(`'${id}'`)));
}

test("Grafana export: single-zone panels are titled with their zone glyph", () => {
  const spec = loadDashboard().spec;
  let singleZonePanels = 0;

  for (const [name, element] of Object.entries(spec.elements)) {
    const referenced = new Set();
    collectQueryStrings(element).forEach((q) => zonesReferenced(q).forEach((z) => referenced.add(z)));

    if (referenced.size === 1) {
      const [zone] = referenced;
      assert.ok(element.spec.title.startsWith(`${zone.glyph} `), `${name} title "${element.spec.title}" must start with the ${zone.id} glyph`);
      singleZonePanels += 1;
    } else if (referenced.size >= 2) {
      for (const query of collectQueryStrings(element)) {
        const refs = zonesReferenced(query);
        const alias = /\bAS\s+"([^"]*)"/.exec(query);
        if (refs.length === 1 && alias) {
          assert.ok(alias[1].startsWith(`${refs[0].glyph} `), `${name} alias "${alias[1]}" must start with the ${refs[0].id} glyph`);
        }
      }
    }
  }
  assert.ok(singleZonePanels >= 9, `expected at least 9 single-zone panels, found ${singleZonePanels}`);
});

test("Grafana export: per-zone annotations are named with their zone glyph", () => {
  const spec = loadDashboard().spec;
  let checked = 0;
  for (const annotation of spec.annotations) {
    const refs = new Set();
    collectQueryStrings(annotation).forEach((q) => zonesReferenced(q).forEach((z) => refs.add(z)));
    if (refs.size === 1) {
      const [zone] = refs;
      assert.ok(annotation.spec.name.startsWith(`${zone.glyph} `), `annotation "${annotation.spec.name}" must start with the ${zone.id} glyph`);
      checked += 1;
    }
  }
  assert.ok(checked >= 3, "expected one watering annotation per zone");
});

test("Grafana export: only the zone glyphs appear, with no variation selectors", () => {
  const allowed = new Set(ZONES.map((z) => z.glyph));
  const extras = ZONE_GLYPH_ALLOWLIST.filter((g) => !allowed.has(g));
  for (const text of collectStrings(loadDashboard())) {
    for (const glyph of extras) assert.ok(!text.includes(glyph), `unused glyph U+${hex(glyph)} in "${text}"`);
    assert.ok(!/[\uFE0E\uFE0F]/.test(text), `variation selector in "${text}"`);
  }
});

test("Grafana export: metadata is clean", () => {
  const { metadata } = loadDashboard();
  const annotationKeys = Object.keys(metadata.annotations || {});
  assert.ok(!annotationKeys.some((k) => /createdBy|updatedBy/.test(k)), "createdBy/updatedBy annotations must be stripped");
  assert.ok(!("resourceVersion" in metadata));
  assert.ok(!("generation" in metadata));
});

test("HA package: zone-symbol markers match zones.js", () => {
  assert.ok(fs.existsSync(PACKAGE_PATH), "docs/homeassistant/mirror_plants.yaml is missing");
  const text = fs.readFileSync(PACKAGE_PATH, "utf8");

  const markers = text.split(/\r?\n/).map((line) => /^#@zone-symbol (\w+) U\+([0-9A-F]{4})$/.exec(line)).filter(Boolean);
  assert.equal(markers.length, ZONES.length, "exactly one marker per zone");
  assert.deepEqual(
    markers.map((m) => `${m[1]} ${m[2]}`).sort(),
    ZONES.map((z) => `${z.id} ${hex(z.glyph)}`).sort()
  );
});

test("HA package: glyphs only appear on lines naming their own zone", () => {
  const text = fs.readFileSync(PACKAGE_PATH, "utf8");
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    const present = ZONE_GLYPH_ALLOWLIST.filter(
      (g) => line.includes(g) || new RegExp(`\\\\u${hex(g)}`, "i").test(line) || line.includes(`U+${hex(g)}`)
    );
    if (present.length === 0) return;

    assert.equal(present.length, 1, `line ${i + 1} mixes glyphs`);
    const zone = ZONES.find((z) => z.glyph === present[0]);
    assert.ok(zone, `line ${i + 1} uses a glyph that is not a zone glyph`);
    assert.ok(line.includes(zone.id) || line.includes(zone.name), `line ${i + 1} has the ${zone.id} glyph without naming the zone`);
  });
});

test("HA package: provides the contract entity, schema and both alert kinds", () => {
  const text = fs.readFileSync(PACKAGE_PATH, "utf8");
  assert.ok(text.includes("mirror_plant_alerts"));
  assert.ok(text.includes("schema: 1"));
  assert.ok(text.includes("connection_lost"));
  assert.ok(text.includes("reservoir_empty"));
});
