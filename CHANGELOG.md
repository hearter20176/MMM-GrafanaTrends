# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Plant alerts (off by default, enable with `plantAlertsEnabled: true` on one instance): the node_helper polls the Home Assistant contract sensor `sensor.mirror_plant_alerts` and the front end raises one combined popup through the core `alert` module, re-shows it while alerts stay active, hides it on recovery, and shows a "Plant alerts not monitored" line when Home Assistant cannot be read or the token is rejected.
- Options `plantAlertsEnabled`, `plantAlertEntity`, `plantAlertPollMs`, `plantAlertTimeoutMs`, `plantAlertStaleMs`, `plantAlertPopupMs`, `plantAlertRepeatMs` and `plantAlertRecoveryNotice`, and `iframeTitle` for the iframe title when running two instances.
- Zone symbols (circle Family Room U+25CF, triangle Dining Room U+25B2, square Kitchen U+25A0) from a single table in `zones.js`, used in popups and in the plants dashboard titles.
- `grafana/indoor-plants.dashboard.json`, the hand-maintained Indoor Plants dashboard export, with `grafana/README-plants.md` for export, clean-up and re-import.
- `docs/homeassistant/`: the Home Assistant package, stop-branch snippet and install notes for the connection-lost and reservoir alerts, email every 6 h and iPhone push.
- `ha-alerts.secret.example.json` and `*.secret.json` / `*.secret` entries in `.gitignore`.
- Tests for the alert rules, poller, node_helper, popup, front end, socket contract, zone consistency and an emoji check.
- README: plants page setup with MMM-pages (why the 1664 px and 714 px dashboards cannot share a page), secret file setup, symbol map, popup behavior, HA contract, limitations and the on-device checks.
- `package.json`: repository, homepage, bugs, license and keywords fields.
- README: Update section and trailing commas in the config examples.
- Node built-ins are imported with the `node:` scheme (for example `node:https`).
- ESLint (flat config) with an `npm run lint` script.
- Added CHANGELOG, CODE_OF_CONDUCT and a Dependabot configuration.

### Changed

- README: Dashboard section now covers both dashboards; the plants dashboard is a hand-maintained export, not generated.
- ESLint 10, with `defineConfig` in `eslint.config.mjs`; `npm run lint` runs `eslint` without the trailing `.`.
- `package.json`: lowercase package name and `"type": "commonjs"`.
- ESLint reports unused catch bindings and arguments, and lints `package.json`, as modules.magicmirror.builders does.

### Security

- The Home Assistant URL and token are read only by the node_helper from `ha-alerts.secret.json` (fixed path, not in `config.js`). Nothing received over the socket can redirect the token; `haUrl` and `haTokenFile` are not options and are ignored with a warning if set.
- The token, request path and Home Assistant text are never logged. Alert text is HTML-escaped before it reaches the popup.
- A 401 or 403 from Home Assistant stops polling until the secret file changes, so a bad token cannot trigger an `ip_ban`.

## [1.0.0]

Released before this changelog was started. Commit history, newest first:

### 2026-10-03

- Add MIT license
- README: current screenshot and documentation review

### 2026-09-29

- Detect Grafana down or blocked with a server-side probe, retry with backoff, follow page theme

### 2026-09-26

- Dashboard: plain series names in legends; hide timestamp in device-name tiles
- Use the Home Assistant InfluxDB default schema (measurement = unit, entity_id tag)
- MMM-GrafanaTrends: Grafana home-trends dashboard for MagicMirror
