/* The front end and the back end are written against the same notification names. Reading the
 * sources as text catches a rename on one side only.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

const START = "GRAFANA_TRENDS_PLANT_ALERTS_START";
const STATE = "GRAFANA_TRENDS_PLANT_ALERTS_STATE";

test("front end sends START and handles STATE", () => {
  const frontEnd = read("MMM-GrafanaTrends.js");
  assert.ok(frontEnd.includes(`sendSocketNotification("${START}"`), "front end must send START");
  assert.ok(frontEnd.includes(`"${STATE}"`), "front end must handle STATE");
});

test("node helper handles START and sends STATE", () => {
  const helper = read("node_helper.js");
  assert.ok(helper.includes(`"${START}"`), "helper must handle START");
  assert.ok(helper.includes(`sendSocketNotification("${STATE}"`), "helper must send STATE");
});

test("the poller itself does not send socket notifications", () => {
  const poller = read("plant-alert-poller.js");
  assert.ok(!poller.includes("sendSocketNotification"));
  assert.ok(!poller.includes("GRAFANA_TRENDS_"));
});

test("the helper reads no url, token or path from the START payload", () => {
  const helper = read("node_helper.js");
  assert.ok(!/payload\.(url|haUrl|token|tokenFile|secretPath)/.test(helper));
});
