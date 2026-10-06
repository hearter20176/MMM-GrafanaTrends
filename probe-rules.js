/* Pure HTTP-response -> { ok, reason } rules for the Grafana reachability probe.
 * No dependencies, so it can be required directly by node_helper.js and by tests
 * without pulling in http/https or MagicMirror's node_helper/logger modules.
 */

/** Extract the `frame-ancestors` source list from a CSP header value, if present. */
function parseFrameAncestors(csp) {
  const match = /frame-ancestors\s+([^;]+)/i.exec(csp || "");
  return match ? match[1].trim() : null;
}

/** Parse an origin string into { scheme, host, port } (port defaulted for http/https). */
function parseOrigin(origin) {
  try {
    const u = new URL(origin);
    const scheme = u.protocol.toLowerCase();
    const port = u.port || (scheme === "https:" ? "443" : scheme === "http:" ? "80" : "");
    return { scheme, host: u.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
}

/** Whether a CSP host token (with an optional leading "*.") matches an embedder host. */
function hostMatches(tokenHost, embedderHost) {
  if (tokenHost.startsWith("*.")) {
    const suffix = tokenHost.slice(1); // ".example.com"
    return embedderHost.length > suffix.length && embedderHost.endsWith(suffix);
  }
  return tokenHost === embedderHost;
}

/**
 * Whether one CSP frame-ancestors source-list token allows the given embedder.
 * Handles the token shapes CSP actually uses: "*", "'none'", "'self'", a scheme-only
 * source ("http:"), and a host-source with an optional scheme and/or port and an
 * optional "*." wildcard host ("localhost:8080", "https://*.example.com").
 */
function tokenAllows(token, embedder) {
  if (token === "*") return true;
  if (token === "'none'") return false;
  // "'self'" can't be verified without knowing the probed target's own origin; only
  // treat it as an allow when we don't have a known embedder to check against anyway.
  if (token === "'self'") return !embedder;
  if (!embedder) return false;

  // Scheme-only source, e.g. "http:".
  if (/^[a-z][a-z0-9+.-]*:$/i.test(token)) {
    return token.toLowerCase() === embedder.scheme;
  }

  let rest = token;
  let scheme = null;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (schemeMatch) {
    scheme = `${schemeMatch[1].toLowerCase()}:`;
    rest = rest.slice(schemeMatch[0].length);
  }

  let host = rest;
  let port = null;
  const portIdx = rest.lastIndexOf(":");
  if (portIdx !== -1) {
    host = rest.slice(0, portIdx);
    port = rest.slice(portIdx + 1);
  }

  if (scheme && scheme !== embedder.scheme) return false;
  if (!hostMatches(host.toLowerCase(), embedder.host)) return false;
  if (port && port !== embedder.port) return false;

  return true;
}

/** Whether a `frame-ancestors` source list allows the given embedder origin. */
function frameAncestorsAllow(sources, embedderOrigin) {
  const tokens = (sources || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const embedder = embedderOrigin ? parseOrigin(embedderOrigin) : null;
  return tokens.some((token) => tokenAllows(token, embedder));
}

/** Return a copy of a headers object with every key lower-cased. */
function lowerCaseHeaders(headers) {
  const out = {};
  for (const key of Object.keys(headers || {})) {
    out[key.toLowerCase()] = headers[key];
  }
  return out;
}

/**
 * Decide whether an HTTP response to the dashboard-URL probe means Grafana is reachable
 * and embeddable. Returns `{ ok, reason }`; `reason` is null when `ok` is true.
 */
function evaluateProbeResponse(res, embedderOrigin) {
  const statusCode = res && res.statusCode;
  const headers = lowerCaseHeaders(res && res.headers);
  const xfo = String(headers["x-frame-options"] || "").toUpperCase();
  const csp = headers["content-security-policy"] || "";
  const location = headers.location || "";

  if (xfo === "DENY" || xfo === "SAMEORIGIN") {
    return { ok: false, reason: "embedding blocked (X-Frame-Options)" };
  }

  const frameAncestors = parseFrameAncestors(csp);
  if (frameAncestors !== null && !frameAncestorsAllow(frameAncestors, embedderOrigin)) {
    return { ok: false, reason: "embedding blocked (CSP frame-ancestors)" };
  }

  if (typeof statusCode === "number" && statusCode >= 300 && statusCode < 400) {
    if (/login/i.test(location)) {
      return { ok: false, reason: "redirected to login" };
    }
    return { ok: true, reason: null };
  }

  if (typeof statusCode !== "number" || statusCode < 200 || statusCode >= 400) {
    return { ok: false, reason: `http ${statusCode}` };
  }

  return { ok: true, reason: null };
}

module.exports = { evaluateProbeResponse };
