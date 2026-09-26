# MMM-GrafanaTrends

Shows a Grafana dashboard of home trends on a MagicMirror² page, inside a glass card that matches the other Glass modules. The dashboard switches between Grafana's light and dark themes to follow the mirror's day/night theme (`body.mm-day` / `body.mm-night`, set by MMM-GlassClock).

The module embeds the whole dashboard in one iframe rather than one iframe per panel. Each iframe runs its own copy of the Grafana app, so a single frame is much lighter on a Raspberry Pi.

## Dashboard

`grafana/build_dashboard.py` generates `grafana/mirror-trends.dashboard.json` from your entity IDs in `grafana/entities.json` (copy `grafana/entities.example.json` and edit it; both the entity map and the generated JSON are gitignored). It reads the Home Assistant InfluxDB integration (InfluxDB 1.x, InfluxQL) configured with `measurement_attr: entity_id`, so each measurement is a full entity_id with the numeric state in field `value`.

| Panel | Range | Source |
|---|---|---|
| Offline devices / low batteries (counts and names) | latest | `sensor.devices_offline`, `sensor.devices_low_battery` (HA template sensors) |
| Water today, water per day, pressure and flow | today, 14 d, 48 h | Flo |
| EV energy and cost this month, EV kWh per day | month, 30 d | `sensor.ev_energy_today`, `sensor.ev_charging_cost_today` (HA utility meters) |
| Radon now and 30-day trend (action level 4 pCi/L) | 7 d, 30 d | EcoSense |
| Indoor vs outdoor temperature, indoor humidity | 48 h | Lennox / Nexia zones, Ambient Weather |
| HVAC run hours per day | 14 d | `sensor.hvac_*_runtime_today` (history_stats) |
| Fridge and freezer temperature | 48 h | Samsung fridge |
| Rain per day, Pi-hole blocked %, internet throughput | 30 d, 24 h | Ambient Weather, Pi-hole, UniFi |

The Home Assistant side (export filter, template sensors, utility meters) lives in the HA config repo as `packages/mirror_trends.yaml`.

Import: Grafana > Dashboards > New > Import > upload the JSON, and pick the InfluxDB data source when prompted. Generate it with `python3 grafana/build_dashboard.py` (again after any edit).

## Grafana requirements

- Grafana must be reachable from the mirror, for example the Home Assistant Grafana add-on with its web port mapped (host port 3000). The add-on serves Grafana under its ingress path even on that port (`http://<ha-host>:3000/api/hassio_ingress/<id>/...`); requesting `/` redirects there, so use the full path in `url`.
- Embedding must be allowed: `GF_SECURITY_ALLOW_EMBEDDING=true`.
- The mirror must be able to view the dashboard without logging in. The narrowest option is to share only this dashboard externally (Share > Share externally) and use that link. Anonymous viewer access also works but exposes every dashboard in the org.

## Config

```js
{
  module: "MMM-GrafanaTrends",
  position: "middle_center",
  classes: "page3",
  config: {
    url: "http://<ha-host>:3000/public-dashboards/<access-token>",
    height: 1480
  }
}
```

| Option | Default | Description |
|---|---|---|
| `url` | `""` | Dashboard URL (a shared/public link, or `/d/<uid>/<slug>?kiosk`) |
| `header` | `""` | Optional title above the dashboard |
| `width` | `"100%"` | iframe width (number = px) |
| `height` | `1480` | iframe height (number = px) |
| `followMirrorTheme` | `true` | Use Grafana's light theme in mirror day mode and dark at night |
| `defaultTheme` | `"dark"` | Theme when not following the mirror, or before a day/night class is set |
| `reloadInterval` | `21600000` | Reload the iframe every 6 h so the page can't gradually use up memory (`0` = never) |
| `unloadWhenHidden` | `false` | Blank the iframe while its page is hidden; saves CPU but reloads Grafana every time the page is shown |

The DOM is built once and reused, so MagicMirror redraws never reload Grafana. It only reloads on a theme change or on `reloadInterval`.
