/* No emoji anywhere in the repo: no emoji-presentation characters, no U+FE0F / U+FE0E, and no
 * non-ASCII character that carries the Emoji property (some fonts render those in color).
 * JSON files are also parsed and every string value is checked, so a \uD83C... escape is caught.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ZONE_GLYPH_ALLOWLIST, MONITOR_GLYPH, UNKNOWN_ZONE_GLYPH } = require("../zones");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", "coverage", "__pycache__"]);
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".webp", ".gif", ".ico"]);
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".css", ".py", ".yaml", ".yml", ".njk", ".txt"]);
const LOCAL_ONLY = new Set(["grafana/entities.json", "grafana/mirror-trends.dashboard.json"]);

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listFiles(full, out);
      continue;
    }
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    const ext = path.extname(entry.name).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext) || LOCAL_ONLY.has(rel)) continue;
    if (/\.secret(\.json)?$/.test(entry.name) && !/\.example\./.test(entry.name)) continue;
    // extensionless dotfiles such as .gitignore
    const isDotfile = entry.name.startsWith(".") && ext === "";
    if (TEXT_EXTENSIONS.has(ext) || isDotfile) out.push({ full, rel });
  }
  return out;
}

const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

// Problems in one string, as { index, ch } (index into the string).
function emojiProblems(text) {
  const problems = [];
  let index = 0;
  for (const ch of text) {
    const bad =
      /\p{Emoji_Presentation}/u.test(ch) ||
      ch === "\uFE0F" ||
      ch === "\uFE0E" ||
      (ch.codePointAt(0) > 0x7f && /\p{Emoji}/u.test(ch));
    if (bad) problems.push({ index, ch });
    index += ch.length;
  }
  return problems;
}

function locate(text, index) {
  const before = text.slice(0, index).split(/\r?\n/);
  return `${before.length}:${before[before.length - 1].length + 1}`;
}

function jsonStrings(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((c) => jsonStrings(c, out));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      jsonStrings(value, out);
    }
  }
  return out;
}

test("no emoji or variation selectors in any text file", () => {
  const failures = [];
  const files = listFiles(ROOT);
  assert.ok(files.length > 0);

  for (const { full, rel } of files) {
    const text = fs.readFileSync(full, "utf8");
    for (const { index, ch } of emojiProblems(text)) failures.push(`${rel}:${locate(text, index)} ${hex(ch)}`);

    if (path.extname(full).toLowerCase() === ".json") {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        failures.push(`${rel}: invalid JSON (${err.name})`);
        continue;
      }
      for (const value of jsonStrings(parsed)) {
        for (const { ch } of emojiProblems(value)) failures.push(`${rel}: string value ${JSON.stringify(value).slice(0, 60)} contains ${hex(ch)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("the approved glyph set passes the rule instead of being exempted from it", () => {
  for (const glyph of [...ZONE_GLYPH_ALLOWLIST, MONITOR_GLYPH, UNKNOWN_ZONE_GLYPH]) {
    assert.ok(!/\p{Emoji}/u.test(glyph) || glyph.codePointAt(0) <= 0x7f, `${hex(glyph)} must not carry the Emoji property`);
    assert.deepEqual(emojiProblems(glyph), [], `${hex(glyph)} must pass the emoji rule`);
  }
});

test("the detector catches what it is meant to catch", () => {
  assert.ok(emojiProblems("a \u{1F331} b").length > 0);
  assert.ok(emojiProblems("\u2714").length > 0, "text-default emoji");
  assert.ok(emojiProblems("\u00A9").length > 0, "copyright sign");
  assert.ok(emojiProblems("\u25CF\uFE0F").length > 0, "variation selector 16");
  assert.ok(emojiProblems("\u25CF\uFE0E").length > 0, "variation selector 15");
  assert.deepEqual(emojiProblems("plain 123 !? \u25CF\u25B2\u25A0"), []);
});
