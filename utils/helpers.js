'use strict';

/**
 * Small helpers used across the voice server.
 */

/**
 * Build a public wss:// URL for the Twilio <Stream> based on either an
 * explicit PUBLIC_HOSTNAME env var or the incoming request Host header.
 * Twilio requires the URL to be publicly reachable over TLS.
 */
function buildStreamUrl(req, publicHostname, path = '/media-stream') {
  // Priority: explicit PUBLIC_HOSTNAME env > X-Forwarded-Host (set by
  // reverse proxies / ingress like Cloudflare, Railway, Emergent) > Host
  // header. Behind an ingress the raw Host header often points to the
  // internal cluster hostname which is not reachable from Twilio.
  const forwarded = req.headers['x-forwarded-host'];
  const host =
    (publicHostname && publicHostname.trim()) ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    req.headers.host;
  // Twilio Media Streams *must* be wss (secure). We assume the host runs
  // behind a TLS-terminating proxy (Railway, Render, Cloudflare, etc.).
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `wss://${host}${cleanPath}`;
}

/**
 * Escape XML entities so we can safely embed user-supplied strings in TwiML.
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Create a short, human-friendly connection id used for correlating logs
 * across Twilio <-> OpenAI bridging.
 */
function generateConnectionId() {
  return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  buildStreamUrl,
  escapeXml,
  generateConnectionId,
};
