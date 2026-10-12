# Home Assistant side of the plant alerts

Files in this folder:

- `mirror_plants.yaml`: the HA package (flags, Refilled buttons, maintenance switch, connection-lost detection, `sensor.mirror_plant_alerts`, email alerts, iPhone pushes).
- `plant-watering-stop-branch.md`: the paste-in that makes your existing "no moisture increase" stop branch raise the reservoir flag.

## Minimum Home Assistant version

2024.10 or newer. The package uses the plural `triggers:` / `conditions:` / `actions:` syntax and `triggers:` on trigger-based template entities (2024.10), `action:` instead of `service:` (2024.8), and `last_reported` for staleness (2024.3; older cores fall back to `last_updated`). It also relies on the trigger-based sensor restoring its previous `alerts` attribute across a restart for the startup hold below; after the first restart, confirm that with the check in the next section. Check configuration will flag anything your version does not accept.

## Install

1. Make sure packages are enabled in `configuration.yaml`:
   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```
2. Copy `mirror_plants.yaml` to `<config>/packages/mirror_plants.yaml`.
3. Set the email notifier. The default `notify.email` is a placeholder. Change `- email` under every `notifiers:` in the `alert:` block and the `notify_email` variable in `mirror_plants_reservoir_email` to your real notify service name (your existing automations use `notify.send_message`; if that is your email path, reuse it). A wrong name fails silently apart from log errors, so do the end-to-end test below.
4. Verify the Kitchen waterer entity id (`switch.kitchen_plant_waterer`) in Developer Tools > States, and fix it in the package if it differs. It is inferred, not confirmed.
5. The Kitchen soil sensor is already unavailable in your device dump. Either fix it first, or turn on `input_boolean.mirror_plant_alerts_maintenance` right after install to mute email and push while you work on it (the mirror popup still shows the alert).
6. Developer Tools > YAML > Check configuration, then restart Home Assistant (prefer a restart over reloading templates, see limitations).
7. Paste the stop-branch steps from `plant-watering-stop-branch.md` into the watering automations, immediately before `- stop:`.
8. Add the InfluxDB settings from the end of `mirror_plants.yaml` to your `influxdb:` block (include the three flags and `sensor.mirror_plant_alerts`; `ignore_attributes: [alerts, schema]`), then restart again.
9. Create a dedicated non-admin HA user for the mirror, create a long-lived token under that user, and put the URL and token in the mirror's `ha-alerts.secret.json` (never in `config.js`). HA tokens are not scoped per entity: a non-admin user can still read all states over REST, so the real protection is file permissions on the Pi.
10. VERIFY the mirror user can read the contract entity:
    ```
    curl -H "Authorization: Bearer <token>" http://<ha-host>:8123/api/states/sensor.mirror_plant_alerts
    ```
    Expect `"state": "0"` (or the active count) and `"schema": 1` with an `alerts` list.

## End-to-end test (do this once after install)

Turn the maintenance switch OFF first, then for one zone:

1. In Developer Tools > States, set `input_boolean.dining_room_plant_reservoir_empty` to on (use the Actions tab: `input_boolean.turn_on`).
2. Confirm all three arrive: the email (one), the time-sensitive iPhone push, and the mirror popup (within one poll, 30 s by default). Confirm `sensor.mirror_plant_alerts` shows state `1` and one `reservoir_empty` alert.
3. Press `input_button.dining_room_plant_reservoir_refilled`. Confirm the flag turns off, the resolved email arrives, the tagged push disappears and a recovery push arrives, and the popup clears.
4. For a connection alert, you can switch off a soil sensor or waterer for 15 minutes or more, or temporarily lower `mirror_plant_raise_delay_min` to 1. Confirm email, push and popup, then restore it and confirm the cleared messages after the 10 minute clear delay.

## Startup hold (no false all-clear after a restart)

After an HA restart, the connection-lost sensors restart their 15 minute raise debounce, so an ongoing alert would briefly drop out of `sensor.mirror_plant_alerts` and the mirror would show "Plant alerts cleared" and later re-raise it. To prevent that, `mirror_plants_startup_grace` turns on `input_boolean.mirror_plant_startup_grace` at HA start for the raise delay plus 2 minutes (a watchdog turns it off after 30 minutes at most). While it is on, the contract sensor keeps the alerts from its previous value, merged with whatever is currently active, with their original `since`. The schema is unchanged. During the hold, a device that really recovered stays listed until the hold ends.

Check after the first restart with an alert open (a real one, or set a reservoir flag by hand): in Developer Tools > States, `sensor.mirror_plant_alerts` should keep the alert, with its original `since`, until the grace flag turns off. If the alerts attribute comes back empty after a restart on your HA version, trigger-based attribute restore is not working there; tell the mirror owner so the mirror's `plantAlertStaleMs` can be tuned instead.

If HA is down, the mirror already treats the failed polls as degraded and keeps the last alerts on screen.

## Settings

Thresholds (15 min raise, 10 min clear, 180 min soil stale, waterer stale off, 3-point clear delta) are `input_number` helpers at the top of the package. Their `initial:` values are re-applied at every restart; edit the file to change them permanently. The three `*_plant_reservoir_flag_moisture` helpers deliberately have no `initial:` so the stored baseline survives restarts.

Waterers are checked for availability only by default. Many switches only report when they change, and the Family Room waterer runs at most once a day, so a staleness limit would alarm constantly. To turn it on, watch each waterer's `last_reported` for a day first, then set `mirror_plant_waterer_stale_min` well above what you saw (maximum 2880 minutes). 0 means off. The soil sensor stale limit works the same way (0 = off).

`input_boolean.mirror_plant_alerts_maintenance` mutes email and iPhone push for all plant alerts. The mirror popup and `sensor.mirror_plant_alerts` still show them. Email alerts can also be acknowledged (`alert.toggle` on the alert entity) to stop their 6 h repeat for one device.

## Check: do the flags reach InfluxDB as 1/0

The Grafana dashboard reads `family_room_plant_reservoir_empty`, `dining_room_plant_reservoir_empty`, and `kitchen_plant_reservoir_empty` from the Influx measurement `state`. After the Influx step above, with each flag toggled on and off once, run in the Influx query UI or CLI:

```
SELECT "value" FROM "state" WHERE "entity_id" = 'family_room_plant_reservoir_empty' AND time > now() - 1h
```

You should see `1` while on and `0` while off, as for the waterer switches. Repeat for the other two zones. If nothing comes back, the flag is missing from the influxdb `include:` list, or your `default_measurement` is not `state`. If it comes back as strings instead of numbers, compare with how a waterer switch is stored in the same query and report it, since the dashboard panels expect numeric 1/0.

## iOS limitation (honest version)

iOS cannot make a notification un-dismissable. There is no sticky or persistent flag on iPhone like Android has. What this package does instead: sends a time-sensitive push (`interruption-level: time-sensitive`, which can break through Focus modes) with a per-alert tag. It is sent when the alert turns on, at HA start, and at 00:00, 06:00, 12:00 and 18:00 for every alert still active, each replacing the earlier one with the same tag. On recovery it sends `clear_notification` for that tag and a normal recovery push. If you swipe a notification away, the next one arrives at the next 6 h tick. The always-on reminder is the mirror popup and the 6-hourly email. `clear_notification` on iOS is delivered as a silent push and can be delayed or missed if the app has been terminated.

The push has no wait loop, so a restart or an automation reload does not stop the re-sends. The cadence is clock-aligned, not 6 h from the raise; the email cadence (the `alert:` entities) is 360 minutes from the raise.

## Known limitations

- A template reload (as opposed to a restart) makes the connection sensors go unavailable briefly. The `alert:` integration then sends a spurious "restored" email and a new raise email about 15 minutes later. Restart instead of reloading templates.
- A shared outage (coordinator, Wi-Fi, cloud) takes all six devices down together and you get one email and one push per device, then repeats every 6 h and one set of recovery messages. A combined "N devices offline" alert is not built, by decision.
- Turning maintenance mode on while an email alert is open sends that alert's "restored" email once; turning it off sends a new raise email.
- A frozen soil sensor (reporting the same value, never unavailable) looks like an empty reservoir to the stop branch and raises a reservoir alert. See the stop-branch doc.
- If Home Assistant itself is down, nothing alerts. Only an external watchdog can cover that.
- Notification failures (wrong `notify.*` name) only show in the HA log. Run the end-to-end test.

## Attribute exclusion note

HA's recorder cannot drop single attributes from a template entity in YAML. The package documents the InfluxDB side (`ignore_attributes`) and an optional recorder exclusion for the whole `sensor.mirror_plant_alerts`, at the end of `mirror_plants.yaml`. The sensor is rewritten when an active alert's attributes change (for a stale-sensor alert the detail text changes about hourly), which is a handful of rows a day.
