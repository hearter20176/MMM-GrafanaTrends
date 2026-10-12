# Indoor Plants dashboard

`indoor-plants.dashboard.json` is the Grafana dashboard (v2 schema, apiVersion `dashboard.grafana.app/v2`,
uid `14b931b4-952c-4f36-bbf8-d022b2e76665`) that the plants MagicMirror card renders. It has 10 panels on a 24 x 19
grid, which is why the card height is 19 * 38 - 8 = 714 px. Do not add or remove rows without updating that height.

## Hand-maintained

This file is not generated. `build_dashboard.py` does not touch it. Edit the dashboard in Grafana, export it
(Share > Export > Export as JSON, v2 resource), then re-apply the clean-up below before committing:

- Remove `metadata.resourceVersion`, `generation`, `creationTimestamp`, `labels` and `annotations`
  (these carry service-account ids and break clean re-imports).
- Keep `metadata.name` and `metadata.uid` so a re-import updates the same dashboard instead of creating a copy.
- Keep the zone glyphs described below.
- Save as UTF-8 with real glyph characters (for example `json.dumps(..., ensure_ascii=False)`).

## Re-importing in Grafana

Dashboards > New > Import, upload `indoor-plants.dashboard.json`. Because the uid is unchanged, importing over an
existing copy replaces it. The datasource reference (`dfuomzkjcprlse`, the InfluxDB source) must exist in the target
Grafana.

## Glyph map

Each zone has one symbol. Panel titles repeat across zones ("Last watered", "Reservoir"), so the symbol is what
tells them apart. Only these three characters are used (no emoji, no U+FE0E/U+FE0F).

| Zone        | Glyph | Code point | Panels                         |
|-------------|-------|------------|--------------------------------|
| Family Room | `●`   | U+25CF     | panel-1, panel-4, panel-7      |
| Dining Room | `▲`   | U+25B2     | panel-2, panel-5, panel-8      |
| Kitchen     | `■`   | U+25A0     | panel-3, panel-6, panel-9      |

The glyph also prefixes the three series aliases in panel-10 (the `AS "<glyph> <zone>"` in each query, plus the
matching `byName` colour overrides, which must stay in sync with the alias) and the three "watered" annotation names.

## Verifying the symbols

Load the JSON and check that every title, alias, override and annotation name that mentions a single zone starts with
that zone's glyph, and that no other non-ASCII character appears in the file:

    python -c "import json;d=json.load(open('indoor-plants.dashboard.json',encoding='utf-8'));\
    print([(k,e['spec']['title']) for k,e in sorted(d['spec']['elements'].items())])"

Then open the imported dashboard in Grafana and confirm the legend and the colour overrides (green, blue, orange)
still apply to the glyph-prefixed series.
