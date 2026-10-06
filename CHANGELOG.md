# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `package.json`: repository, homepage, bugs, license and keywords fields.
- README: Update section and trailing commas in the config examples.
- Node built-ins are imported with the `node:` scheme (for example `node:https`).
- ESLint (flat config) with an `npm run lint` script.
- Added CHANGELOG, CODE_OF_CONDUCT and a Dependabot configuration.

### Changed

- ESLint 10, with `defineConfig` in `eslint.config.mjs`; `npm run lint` runs `eslint` without the trailing `.`.
- `package.json`: lowercase package name and `"type": "commonjs"`.
- ESLint reports unused catch bindings and arguments, and lints `package.json`, as modules.magicmirror.builders does.

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
