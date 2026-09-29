# MMM-GrafanaTrends

Shows a Grafana dashboard of home trends on a MagicMirror² page, inside a glass card that matches the other Glass modules. The dashboard switches between Grafana's light and dark themes to follow the mirror's day/night theme (`body.mm-day` / `body.mm-night`, set by MMM-GlassClock).

The module embeds the whole dashboard in one iframe rather than one iframe per panel. Each iframe runs its own copy of the Grafana app, so a single frame is much lighter on a Raspberry Pi.

## Dashboard

`grafana/build_dashboard.py` generates `grafana/mirror-trends.dashboard.json` from your entity IDs in `grafana/entities.json` (copy `grafana/entities.example.json` and edit it; both the entity map and the generated JSON are gitignored). It reads the Home Assistant InfluxDB integration (InfluxDB 1.x, InfluxQL) with its default schema: the measurement is the entity's unit of measurement (or the configured `default_measurement` when it has none), the `entity_id` tag holds the object id, and the numeric state is in field `value`. Each entry in `entities.json` gives the entity ID and its measurement.

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

## Install

No npm dependencies for the module itself (`grafana/build_dashboard.py` only needs Python 3's
standard library). Clone into your MagicMirror `modules/` folder:

```
cd ~/MagicMirror/modules
git clone <repo-url> MMM-GrafanaTrends
```

## Grafana requirements

- Grafana must be reachable from the mirror, for example the Home Assistant Grafana add-on with its web port mapped (host port 3000). The add-on serves Grafana under its ingress path even on that port (`http://<ha-host>:3000/api/hassio_ingress/<id>/...`); requesting `/` redirects there, so use the full path in `url`.
- Embedding must be allowed: `GF_SECURITY_ALLOW_EMBEDDING=true`.
- The mirror must be able to view the dashboard without logging in. The narrowest option is to share only this dashboard externally (Share > Share externally) and use that link. Anonymous viewer access also works but exposes every dashboard in the org.

## Config

The `classes: "page3"` example below assumes MMM-pages is installed and `page3` is one of
its configured `modules` classes; add it there too, or this module just renders on every
page.

```js
{
  module: "MMM-GrafanaTrends",
  position: "middle_center",
  classes: "page3",
  config: {
    url: "http://<ha-host>:3000/public-dashboards/<access-token>",
    height: 1664
  }
}
```

| Option | Default | Description |
|---|---|---|
| `url` | `""` | Dashboard URL (a shared/public link, or `/d/<uid>/<slug>?kiosk`) |
| `header` | `""` | Optional title above the dashboard |
| `width` | `"100%"` | iframe width (number = px) |
| `height` | `1664` | iframe height (number = px). Sized for the generated 44-row dashboard (44 rows x 30px + 43 x 8px margin ~= 1664px, plus kiosk padding). VERIFY against the actual render on the device; trim rows in `build_dashboard.py`, add `autofitpanels` to the URL, or adjust this value if the bottom row clips. |
| `followMirrorTheme` | `true` | Use Grafana's light theme in mirror day mode and dark at night, driven by MMM-GlassClock's `PAGE_THEME_CHANGED` notification (`body.mm-day` / `body.mm-night` set the initial theme before the first notification arrives) |
| `defaultTheme` | `"dark"` | Theme when not following the mirror, or before a day/night class is set |
| `reloadInterval` | `21600000` | Reload the iframe every 6 h so the page can't gradually use up memory (`0` = never) |
| `unloadWhenHidden` | `false` | Blank the iframe while its page is hidden; saves CPU but reloads Grafana every time the page is shown. Any reload requested while hidden (theme change, `reloadInterval`) is deferred until the page is shown again. |
| `loadTimeoutMs` | `20000` | How long to wait for the iframe to fire `load` at all before falling back to a failure. This does *not* detect Grafana being down, redirected to a login page, or refusing to embed - `load` fires for those too. See "Error handling" below; the node_helper probe is what actually detects them. |
| `retryDelayMs` | `60000` | First retry delay after a failed/timed-out load. Doubles on each consecutive failure, up to `maxRetryDelayMs`, instead of waiting for the full `reloadInterval`. Clamped to at least 5s in `start()` so a config of `0` can't turn an outage into a tight reload+probe loop. |
| `maxRetryDelayMs` | `600000` | Cap on the retry backoff delay. Also clamped to at least 5s. |

The DOM is built once and reused, so MagicMirror redraws never reload Grafana. It reloads on
a theme change, on `reloadInterval`, or after a failed load's retry backoff.

## Error handling

Detecting "Grafana is unreachable/blocked" can't rely on the iframe alone: in Chromium, the
`load` event fires for a blocked frame (`X-Frame-Options`/CSP `frame-ancestors`), a redirect to
Grafana's login page, and a normal successful load alike - there's no way to tell them apart
from the front end. `error` only fires for a small subset of network-level failures and never
for an embedding refusal.

The module's `node_helper.js` therefore probes the dashboard URL server-side on every `_load()`
(`GRAFANA_TRENDS_PROBE` / `GRAFANA_TRENDS_PROBE_RESULT`): it makes a plain HTTP(S) request and
treats it as a failure on a network error, a non-2xx/timeout status, a 3xx redirect to a login
page, an `X-Frame-Options: DENY|SAMEORIGIN` header, or a CSP `frame-ancestors` that excludes the
mirror's own origin. The probe result is authoritative for showing/hiding the error overlay.

The 20s `loadTimeoutMs` iframe-side timer is a secondary fallback for a fully hung connection
(nothing responds at all, so even the probe's own request would eventually time out). Both the
iframe's `load` event and either probe outcome (ok or not) clear it; since the probe normally
answers within its 10s socket timeout - well before the 20s mark - this timer only ends up
mattering when the node_helper itself isn't running or can't be reached.

On any failure (probe or iframe timeout), the module shows an overlay message ("Grafana is
unavailable - retrying in Ns") and retries with exponential backoff (`retryDelayMs`, doubling,
capped at `maxRetryDelayMs`) instead of waiting for `reloadInterval`. The probe never logs the
dashboard URL or its public-dashboard share token - only the request's origin is logged, and
only on failure.

Each probe request carries a `requestId`; a reply for a request that's no longer the latest one
(e.g. a slow reply arriving after a newer theme-change reload already started) is ignored, so it
can't flip the overlay/backoff state for the wrong load. `config.url` is resolved against the
page's own origin before it's sent to the helper (the same way it's resolved for the iframe), so
a relative or reverse-proxy URL (e.g. `/grafana/d/x?kiosk`) works instead of the helper reporting
"invalid dashboard url" for a setup the iframe itself accepts fine.

## Theme param

`_buildUrl()` appends `?theme=light|dark` to the dashboard URL. This is honoured by normal
kiosk-mode dashboard URLs. VERIFY whether the public/shared-dashboard link's `theme` param is
honoured on the Grafana version running on the Home Assistant add-on - support for it on public
dashboards varies by version.
