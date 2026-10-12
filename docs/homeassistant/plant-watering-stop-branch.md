# Reservoir flag: paste-in for the watering automations

Your existing watering automations already define "reservoir likely empty": the `no_change_count >= no_change_pulses_limit` stop branch ("Plant watering stopped (no moisture increase)"). This snippet makes that branch also raise the zone's reservoir flag, which `mirror_plants.yaml` turns into the email, the iPhone push, and the mirror popup.

Nothing in your `automations.yaml` was edited. You paste these steps in yourself, once per zone.

Not alert B: the "reached max pulses" branch. Moisture was still rising there, so do not flag it.

## Where to paste

Inside the stop branch, in the `choose` option whose condition is `no_change_count >= no_change_pulses_limit`. Paste it immediately before the `- stop: 'Stopping: no moisture change.'` step, AFTER the three existing notify actions (mobile push, `persistent_notification.create`, `notify_send_message`). That way, if a snippet step ever fails (for example the package is not loaded), only the new flag is lost and your existing "watering stopped" notifications still go out. The waterer is already turned off earlier in the branch.

The easiest safe way is the automation's "Edit in YAML" view in the HA UI. If you edit `automations.yaml` as a file, the steps are items of the branch's `sequence:` list, which sits at 10 spaces of indentation in your current file, so the `- if:` below must start at column 10.

The snippet uses none of your automation variables: it reads the soil sensor directly, so it works even if a variable is named differently.

What it does: only if the soil sensor currently has a real numeric reading above 0, it stores that reading as the baseline (only when the flag is not already on) and turns the flag on. If the sensor is unavailable at that moment, nothing is flagged, which avoids a baseline of 0 that would clear the flag the moment the sensor returned.

## Family Room (automation id 1771691934977)

```yaml
          # --- reservoir flag (mirror_plants.yaml) ---
          - if:
              - condition: template
                value_template: >-
                  {% set m = states('sensor.soil_moisture_sensor_1_family_room_soil_moisture') %}
                  {{ is_number(m) and (m | float) > 0 }}
            then:
              - if:
                  - condition: state
                    entity_id: input_boolean.family_room_plant_reservoir_empty
                    state: "off"
                then:
                  - action: input_number.set_value
                    target:
                      entity_id: input_number.family_room_plant_reservoir_flag_moisture
                    data:
                      value: "{{ states('sensor.soil_moisture_sensor_1_family_room_soil_moisture') | float(0) | round(1) }}"
              - action: input_boolean.turn_on
                target:
                  entity_id: input_boolean.family_room_plant_reservoir_empty
          # --- end reservoir flag ---
```

## Dining Room (automation id 1771884119208)

```yaml
          # --- reservoir flag (mirror_plants.yaml) ---
          - if:
              - condition: template
                value_template: >-
                  {% set m = states('sensor.soil_moisture_sensor_2_dining_room_soil_moisture') %}
                  {{ is_number(m) and (m | float) > 0 }}
            then:
              - if:
                  - condition: state
                    entity_id: input_boolean.dining_room_plant_reservoir_empty
                    state: "off"
                then:
                  - action: input_number.set_value
                    target:
                      entity_id: input_number.dining_room_plant_reservoir_flag_moisture
                    data:
                      value: "{{ states('sensor.soil_moisture_sensor_2_dining_room_soil_moisture') | float(0) | round(1) }}"
              - action: input_boolean.turn_on
                target:
                  entity_id: input_boolean.dining_room_plant_reservoir_empty
          # --- end reservoir flag ---
```

The inner `if` guard matters for Dining Room: it also triggers every 5 minutes (`time_pattern`), so after a flagged stop it can run again. The guard keeps the stored baseline at the moisture value from the first flagging instead of creeping upward on every retry.

## Kitchen (automation not in the local copy: confirm placement yourself)

The Kitchen watering automation is not in the local `automations.yaml`, so this assumes it has the same kind of stop branch. Open it and find the branch before pasting.

The Kitchen waterer switch (`switch.kitchen_plant_waterer`) and duration number (`number.kitchen_plant_waterer_water_duration`) are inferred names, not verified. Confirm them in Developer Tools > States. The snippet below uses neither one; it uses the Kitchen soil sensor, `sensor.soil_moisture_sensor_3_kitchen_soil_moisture`, which appears in your dashboard queries. That sensor is currently unavailable, so no flag can be raised for Kitchen until it reports again.

```yaml
          # --- reservoir flag (mirror_plants.yaml) ---
          - if:
              - condition: template
                value_template: >-
                  {% set m = states('sensor.soil_moisture_sensor_3_kitchen_soil_moisture') %}
                  {{ is_number(m) and (m | float) > 0 }}
            then:
              - if:
                  - condition: state
                    entity_id: input_boolean.kitchen_plant_reservoir_empty
                    state: "off"
                then:
                  - action: input_number.set_value
                    target:
                      entity_id: input_number.kitchen_plant_reservoir_flag_moisture
                    data:
                      value: "{{ states('sensor.soil_moisture_sensor_3_kitchen_soil_moisture') | float(0) | round(1) }}"
              - action: input_boolean.turn_on
                target:
                  entity_id: input_boolean.kitchen_plant_reservoir_empty
          # --- end reservoir flag ---
```

## How the flag clears

The package automation `mirror_plants_reservoir_flag_clear` turns the flag off when any of these happens:

1. Soil moisture is at least `mirror_plant_reservoir_clear_delta` points (default 3) above the value stored in `input_number.<zone>_plant_reservoir_flag_moisture` when the flag was set. This is checked on every moisture change, at HA start, and every 5 minutes.
2. You press that zone's `input_button.<zone>_plant_reservoir_refilled` button (pressable from the HA app).

Clearing the flag removes the alert from `sensor.mirror_plant_alerts`, so the mirror popup goes away, the tagged iPhone notification is cleared, and a resolved email and recovery push are sent.

Known limit: the stop branch fires on "moisture did not increase", which is also what a frozen soil sensor (reporting an unchanging value, not unavailable) looks like. That raises a reservoir alert even though the reservoir may be fine. Press Refilled to clear it.

## Optional, NOT included: stop dry-running the pump while flagged

Once the flag is on, your automations will still try to water again at the next trigger (Dining Room re-triggers every 5 minutes with a 30 s lockout, so it can run about 5 pulses roughly every 30 minutes while moisture is under 20 and the reservoir is empty). That is existing behavior, not introduced by this package. A gate is a legitimate mitigation, but it changes your watering logic, so it is left for you to decide.

Add the block for THAT zone only, to that automation's `conditions:` list. Do not copy the Dining Room block into Family Room.

Family Room:

```yaml
  - condition: not
    conditions:
      - condition: state
        entity_id: input_boolean.family_room_plant_reservoir_empty
        state: "on"
```

Dining Room:

```yaml
  - condition: not
    conditions:
      - condition: state
        entity_id: input_boolean.dining_room_plant_reservoir_empty
        state: "on"
```

Kitchen:

```yaml
  - condition: not
    conditions:
      - condition: state
        entity_id: input_boolean.kitchen_plant_reservoir_empty
        state: "on"
```

The `not ... "on"` form is deliberate: if the helper is missing or unavailable (package removed or broken), the condition passes and watering behaves exactly as it does today. A plain `state: "off"` condition would stop watering permanently in that case.

Risk to accept before you add it: with the gate, a false or stuck flag blocks watering for that zone until the flag clears. A frozen soil sensor can raise a false flag (see above), and if the sensor stays frozen the moisture-rise clear never happens, so the zone stays dry until you press Refilled. Check the Refilled button and the flag after any sensor problem.
