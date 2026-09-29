/* Tests for probe-rules.js: the pure HTTP-response -> {ok, reason} logic used
 * by node_helper.js's server-side probe. Kept dependency-free (no http/https,
 * no node_helper/logger) so it's easy to test directly and easy to reason
 * about independently of the request plumbing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateProbeResponse } = require("../probe-rules");

test("evaluateProbeResponse: a plain 200 with no blocking headers is ok", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: {} },
    "http://mirror.local"
  );
  assert.equal(result.ok, true);
});

test("evaluateProbeResponse: X-Frame-Options DENY is a block", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "x-frame-options": "DENY" } },
    "http://mirror.local"
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /x-frame-options/i);
});

test("evaluateProbeResponse: X-Frame-Options SAMEORIGIN is a block (cross-origin embed)", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "X-Frame-Options": "SAMEORIGIN" } },
    "http://mirror.local"
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /x-frame-options/i);
});

test("evaluateProbeResponse: CSP frame-ancestors excluding the mirror's origin is a block", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors 'self' https://other.example" } },
    "http://mirror.local"
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /frame-ancestors/i);
});

test("evaluateProbeResponse: CSP frame-ancestors * allows any embedder", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors *" } },
    "http://mirror.local"
  );
  assert.equal(result.ok, true);
});

test("evaluateProbeResponse: CSP frame-ancestors naming the mirror's exact origin allows it", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors http://mirror.local" } },
    "http://mirror.local"
  );
  assert.equal(result.ok, true);
});

test("evaluateProbeResponse: a redirect to a login page is a block", () => {
  const result = evaluateProbeResponse(
    { statusCode: 302, headers: { location: "/login?redirect=/d/x" } },
    "http://mirror.local"
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /login/i);
});

test("evaluateProbeResponse: a redirect that is not to login passes through as ok", () => {
  const result = evaluateProbeResponse(
    { statusCode: 302, headers: { location: "/d/x?orgId=1" } },
    "http://mirror.local"
  );
  assert.equal(result.ok, true);
});

test("evaluateProbeResponse: a non-2xx/3xx status is a block", () => {
  const result = evaluateProbeResponse({ statusCode: 500, headers: {} }, "http://mirror.local");
  assert.equal(result.ok, false);
  assert.match(result.reason, /500/);
});

test("evaluateProbeResponse: a 404 is a block", () => {
  const result = evaluateProbeResponse({ statusCode: 404, headers: {} }, "http://mirror.local");
  assert.equal(result.ok, false);
  assert.match(result.reason, /404/);
});

// ---------------------------------------------------------------------------
// CSP frame-ancestors: real source-expression shapes, not substring matching.
// A pure substring match would (wrongly) block a bare scheme/host-port source
// and (wrongly) allow any host just because it contains "*" somewhere in a
// wildcard token - r3 asked for tests against these exact shapes.
// ---------------------------------------------------------------------------

test("evaluateProbeResponse: CSP frame-ancestors with a host:port source allows the matching host+port", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors localhost:8080" } },
    "http://localhost:8080"
  );
  assert.equal(result.ok, true);
});

test("evaluateProbeResponse: CSP frame-ancestors with a host:port source blocks a different port", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors localhost:8080" } },
    "http://localhost:9090"
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /frame-ancestors/i);
});

test("evaluateProbeResponse: CSP frame-ancestors with a scheme-only source (\"http:\") allows any host on that scheme", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors http:" } },
    "http://mirror.local"
  );
  assert.equal(result.ok, true);
});

test("evaluateProbeResponse: CSP frame-ancestors with a scheme-only source (\"http:\") blocks a different scheme", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors http:" } },
    "https://mirror.local"
  );
  assert.equal(result.ok, false);
});

test("evaluateProbeResponse: CSP frame-ancestors with a \"*.\" wildcard host allows a matching subdomain", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors https://*.example.com" } },
    "https://mirror.example.com"
  );
  assert.equal(result.ok, true);
});

test("evaluateProbeResponse: CSP frame-ancestors with a \"*.\" wildcard host does not allow the bare parent domain", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors https://*.example.com" } },
    "https://example.com"
  );
  assert.equal(result.ok, false);
});

test("evaluateProbeResponse: CSP frame-ancestors with a \"*.\" wildcard host blocks an unrelated domain", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors https://*.example.com" } },
    "https://mirror.local"
  );
  assert.equal(result.ok, false);
});

test("evaluateProbeResponse: CSP frame-ancestors 'none' always blocks", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors 'none'" } },
    "http://mirror.local"
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /frame-ancestors/i);
});

test("evaluateProbeResponse: CSP frame-ancestors 'none' blocks even with no known embedder origin", () => {
  const result = evaluateProbeResponse(
    { statusCode: 200, headers: { "content-security-policy": "frame-ancestors 'none'" } },
    null
  );
  assert.equal(result.ok, false);
});
