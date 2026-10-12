/* Plant zone table: the single source of truth for zone ids, display names and glyphs.
 * Back end only; the node helper puts the glyph and display name on every alert it forwards,
 * so the front end never needs this file. No dependencies.
 *
 * Glyphs are written as \u escapes so this source stays ASCII. None of them has an emoji
 * presentation, and no variation selector (U+FE0E / U+FE0F) is ever appended.
 */

const ZONES = Object.freeze([
  Object.freeze({
    id: "family_room",
    name: "Family Room",
    glyph: "\u25CF",
    entities: Object.freeze({
      moisture: "soil_moisture_sensor_1_family_room_soil_moisture",
      waterer: "family_room_plant_waterer",
      reservoirFlag: "family_room_plant_reservoir_empty"
    })
  }),
  Object.freeze({
    id: "dining_room",
    name: "Dining Room",
    glyph: "\u25B2",
    entities: Object.freeze({
      moisture: "soil_moisture_sensor_2_dining_room_soil_moisture",
      waterer: "plant_waterer_2",
      reservoirFlag: "dining_room_plant_reservoir_empty"
    })
  }),
  Object.freeze({
    id: "kitchen",
    name: "Kitchen",
    glyph: "\u25A0",
    entities: Object.freeze({
      moisture: "soil_moisture_sensor_3_kitchen_soil_moisture",
      waterer: "kitchen_plant_waterer",
      reservoirFlag: "kitchen_plant_reservoir_empty"
    })
  })
]);

const MONITOR_GLYPH = "!";
const UNKNOWN_ZONE_GLYPH = "?";

// Full approved set, in zone order; only the first ZONES.length are in use.
const ZONE_GLYPH_ALLOWLIST = Object.freeze(["\u25CF", "\u25B2", "\u25A0", "\u25C6", "\u2605", "\u271A"]);

/** The zone with this id, or undefined. */
function zoneById(id) {
  return ZONES.find((zone) => zone.id === id);
}

module.exports = { ZONES, MONITOR_GLYPH, UNKNOWN_ZONE_GLYPH, ZONE_GLYPH_ALLOWLIST, zoneById };
