"""Generate grafana/mirror-trends.dashboard.json (import via Grafana > Dashboards > New > Import).

Data model (Home Assistant InfluxDB integration, `measurement_attr: entity_id`):
measurement = full entity_id, numeric state in field "value", string attributes as "<attr>_str".
Entity IDs come from grafana/entities.json (yours, gitignored; start from entities.example.json);
queries reference them as @role@ placeholders.
Layout targets a portrait 1080x1920 mirror: ~44 grid rows fill the area below the clock.
"""
import json
import re
import sys
from pathlib import Path

DS = {"type": "influxdb", "uid": "${DS_INFLUXDB}"}
TZ = " tz('America/New_York')"
panels = []
pid = 0


def q(query, ref="A"):
    return {"refId": ref, "datasource": DS, "query": query, "rawQuery": True, "resultFormat": "time_series"}


def add(kind, title, gridpos, targets, **extra):
    global pid
    pid += 1
    p = {"id": pid, "type": kind, "title": title, "gridPos": dict(zip("xywh", gridpos)), "datasource": DS,
         "targets": targets, "transparent": True}
    p.update(extra)
    panels.append(p)
    return p


def stat(title, gridpos, query, unit, steps, time_from=None, decimals=None, text_mode="value"):
    defaults = {"unit": unit, "thresholds": {"mode": "absolute", "steps": steps}, "color": {"mode": "thresholds"}}
    if decimals is not None:
        defaults["decimals"] = decimals
    extra = {"fieldConfig": {"defaults": defaults, "overrides": []},
             "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                         "colorMode": "value", "graphMode": "none", "justifyMode": "center",
                         "textMode": text_mode, "orientation": "auto", "wideLayout": True}}
    if time_from:
        extra["timeFrom"] = time_from
        extra["hideTimeOverride"] = True
    return add("stat", title, gridpos, [q(query)], **extra)


def series(title, gridpos, targets, unit, time_from, bars=False, thresholds=None, decimals=None, stack=False):
    custom = {"drawStyle": "bars" if bars else "line", "lineWidth": 2, "fillOpacity": 70 if bars else 12,
              "gradientMode": "opacity", "showPoints": "never", "spanNulls": False if bars else 3600000,
              "barAlignment": 0, "axisBorderShow": False, "axisSoftMin": 0 if bars else None}
    if stack:
        custom["stacking"] = {"mode": "normal", "group": "A"}
    defaults = {"unit": unit, "custom": custom, "color": {"mode": "palette-classic"}}
    if decimals is not None:
        defaults["decimals"] = decimals
    if thresholds:
        defaults["thresholds"] = {"mode": "absolute", "steps": thresholds}
        custom["thresholdsStyle"] = {"mode": "line+area"}
    return add("timeseries", title, gridpos, targets, timeFrom=time_from, hideTimeOverride=True,
               fieldConfig={"defaults": defaults, "overrides": []},
               options={"legend": {"displayMode": "list", "placement": "bottom", "showLegend": len(targets) > 1},
                        "tooltip": {"mode": "none"}})


G, Y, O, R = "green", "#EAB839", "orange", "red"
steps = lambda *pairs: [{"color": c, "value": v} for v, c in pairs]

# ── Row 1: headline numbers ──────────────────────────────────────────────────
stat("Offline devices", (0, 0, 4, 4), 'SELECT last("value") FROM "@devices_offline@" WHERE $timeFilter',
     "none", steps((None, G), (1, O), (3, R)), time_from="30d", decimals=0)
stat("Low batteries", (4, 0, 4, 4), 'SELECT last("value") FROM "@devices_low_battery@" WHERE $timeFilter',
     "none", steps((None, G), (1, O), (3, R)), time_from="30d", decimals=0)
stat("Water today", (8, 0, 4, 4),
     'SELECT last("value") FROM "@water_today@" WHERE $timeFilter',
     "suffix: gal", steps((None, "#5794F2"), (300, O), (500, R)), time_from="now/d", decimals=0)
stat("EV this month", (12, 0, 4, 4),
     'SELECT sum("m") FROM (SELECT max("value") AS "m" FROM "@ev_energy_today@" WHERE $timeFilter '
     'GROUP BY time(1d)' + TZ + ')', "kwatth", steps((None, "#73BF69")), time_from="now/M", decimals=0)
stat("EV cost this month", (16, 0, 4, 4),
     'SELECT sum("m") FROM (SELECT max("value") AS "m" FROM "@ev_cost_today@" WHERE $timeFilter '
     'GROUP BY time(1d)' + TZ + ')', "currencyUSD", steps((None, "#73BF69")), time_from="now/M", decimals=2)
stat("Radon", (20, 0, 4, 4), 'SELECT last("value") FROM "@radon@" WHERE $timeFilter',
     "suffix: pCi/L", steps((None, G), (2, Y), (4, R)), time_from="7d", decimals=1)

# ── Row 2: what needs attention (names) ──────────────────────────────────────
for i, (title, meas) in enumerate((("Offline", "@devices_offline@"), ("Low battery", "@devices_low_battery@"))):
    add("stat", title, (i * 12, 4, 12, 3), [q(f'SELECT last("devices_str") FROM "{meas}" WHERE $timeFilter')],
        timeFrom="30d", hideTimeOverride=True,
        fieldConfig={"defaults": {"color": {"mode": "fixed", "fixedColor": "text"}}, "overrides": []},
        options={"reduceOptions": {"calcs": ["lastNotNull"], "fields": "/.*/", "values": False},
                 "colorMode": "none", "graphMode": "none", "justifyMode": "center", "textMode": "value",
                 "text": {"valueSize": 15}, "wideLayout": True})

# ── Water ────────────────────────────────────────────────────────────────────
series("Water use per day (gal)", (0, 7, 12, 8),
       [q('SELECT max("value") AS "Gallons" FROM "@water_today@" '
          'WHERE $timeFilter GROUP BY time(1d) fill(none)' + TZ)], "none", "14d", bars=True, decimals=0)
series("Water pressure (psi) & flow", (12, 7, 12, 8),
       [q('SELECT mean("value") AS "Pressure psi" FROM "@water_pressure@" '
          'WHERE $timeFilter GROUP BY time(15m) fill(none)'),
        q('SELECT max("value") AS "Flow gal/min" FROM "@water_flow_rate@" '
          'WHERE $timeFilter GROUP BY time(15m) fill(none)', "B")], "none", "48h", decimals=1)

# ── Climate ──────────────────────────────────────────────────────────────────
series("Temperature: indoor vs outdoor", (0, 15, 12, 8),
       [q('SELECT mean("value") AS "Family Room" FROM "@zone1_temperature@" '
          'WHERE $timeFilter GROUP BY time(15m) fill(none)'),
        q('SELECT mean("value") AS "Master Bed" FROM "@zone2_temperature@" '
          'WHERE $timeFilter GROUP BY time(15m) fill(none)', "B"),
        q('SELECT mean("value") AS "Outdoor" FROM "@outdoor_temperature@" '
          'WHERE $timeFilter GROUP BY time(15m) fill(none)', "C")], "fahrenheit", "48h", decimals=0)
series("Indoor humidity", (12, 15, 12, 8),
       [q('SELECT mean("value") AS "Family Room" FROM "@zone1_humidity@" '
          'WHERE $timeFilter GROUP BY time(15m) fill(none)'),
        q('SELECT mean("value") AS "Master Bed" FROM "@zone2_humidity@" '
          'WHERE $timeFilter GROUP BY time(15m) fill(none)', "B")], "percent", "48h",
       thresholds=steps((None, "transparent"), (60, "rgba(255,152,48,0.15)")), decimals=0)

# ── Radon & HVAC runtime ─────────────────────────────────────────────────────
series("Radon, 30 days (action level 4)", (0, 23, 12, 7),
       [q('SELECT mean("value") AS "Radon pCi/L" FROM "@radon@" '
          'WHERE $timeFilter GROUP BY time(6h) fill(none)')], "none", "30d",
       thresholds=steps((None, "transparent"), (4, "rgba(242,73,92,0.18)")), decimals=1)
series("HVAC run hours per day", (12, 23, 12, 7),
       [q('SELECT max("value") AS "Family Room" FROM "@zone1_hvac_runtime_today@" '
          'WHERE $timeFilter GROUP BY time(1d) fill(none)' + TZ),
        q('SELECT max("value") AS "Master Bed" FROM "@zone2_hvac_runtime_today@" '
          'WHERE $timeFilter GROUP BY time(1d) fill(none)' + TZ, "B")], "h", "14d", bars=True, decimals=1)

# ── EV & fridge ──────────────────────────────────────────────────────────────
series("EV charging per day (kWh)", (0, 30, 12, 7),
       [q('SELECT max("value") AS "kWh" FROM "@ev_energy_today@" '
          'WHERE $timeFilter GROUP BY time(1d) fill(none)' + TZ)], "none", "30d", bars=True, decimals=1)
series("Fridge & freezer (°F)", (12, 30, 12, 7),
       [q('SELECT mean("value") AS "Fridge" FROM "@fridge_temperature@" '
          'WHERE $timeFilter GROUP BY time(15m) fill(none)'),
        q('SELECT mean("value") AS "Freezer" FROM "@freezer_temperature@" '
          'WHERE $timeFilter GROUP BY time(15m) fill(none)', "B")], "fahrenheit", "48h", decimals=0)

# ── Rain & network ───────────────────────────────────────────────────────────
series("Rain per day (in)", (0, 37, 8, 7),
       [q('SELECT max("value") AS "Rain in" FROM "@rain_today@" '
          'WHERE $timeFilter GROUP BY time(1d) fill(none)' + TZ)], "none", "30d", bars=True, decimals=2)
series("Ads blocked (%)", (8, 37, 8, 7),
       [q('SELECT mean("value") AS "Blocked %" FROM "@pihole_percent_blocked@" '
          'WHERE $timeFilter GROUP BY time(30m) fill(none)')], "percent", "24h", decimals=0)
series("Internet throughput (Mbps)", (16, 37, 8, 7),
       [q('SELECT mean("value") * 0.008192 AS "Down" FROM "@wan_download_kibps@" '
          'WHERE $timeFilter GROUP BY time(10m) fill(none)'),
        q('SELECT mean("value") * 0.008192 AS "Up" FROM "@wan_upload_kibps@" '
          'WHERE $timeFilter GROUP BY time(10m) fill(none)', "B")], "none", "24h", decimals=1)

dashboard = {
    "__inputs": [{"name": "DS_INFLUXDB", "label": "InfluxDB (homeassistant)", "type": "datasource",
                  "pluginId": "influxdb", "pluginName": "InfluxDB"}],
    "__requires": [{"type": "datasource", "id": "influxdb", "name": "InfluxDB", "version": "1.0.0"},
                   {"type": "panel", "id": "stat", "name": "Stat", "version": ""},
                   {"type": "panel", "id": "timeseries", "name": "Time series", "version": ""}],
    "uid": "mirror-trends",
    "title": "Mirror Trends",
    "description": "Home trends for the MagicMirror (water, climate, radon, EV, fridge, network, device health).",
    "tags": ["magicmirror", "home-assistant"],
    "timezone": "America/New_York",
    "time": {"from": "now-48h", "to": "now"},
    "refresh": "5m",
    "graphTooltip": 0,
    "editable": True,
    "schemaVersion": 39,
    "templating": {"list": []},
    "annotations": {"list": []},
    "panels": panels,
}
here = Path(__file__).parent
entities_file = here / "entities.json"
if not entities_file.exists():
    sys.exit("grafana/entities.json not found: copy entities.example.json and set your entity IDs")
text = json.dumps(dashboard, indent=2)
for role, entity_id in json.loads(entities_file.read_text(encoding="utf-8")).items():
    text = text.replace(f"@{role}@", entity_id)
missing = sorted(set(re.findall(r"@([a-z0-9_]+)@", text)))
if missing:
    sys.exit(f"entities.json is missing roles: {', '.join(missing)}")
out = here / "mirror-trends.dashboard.json"
out.write_text(text + "\n", encoding="utf-8")
print(f"wrote {out.name}: {len(panels)} panels, {max(p['gridPos']['y'] + p['gridPos']['h'] for p in panels)} grid rows")
