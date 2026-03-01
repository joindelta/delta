/**
 * Delta Web Gateway — Cloudflare Worker with Hono
 *
 * Serves public profile/org pages for pkarr keys.
 * URLs: /pk:<z32-key> → HTML page with profile info
 */

import { Hono, type Context } from 'hono';
import { resolvePkarr, resolveDomainToPkarr } from './pkarr';
import { renderProfilePage, renderOrgPage, renderRelayPage } from './template';

interface Env {
  APP_SCHEME: string;
  APP_STORE_URL?: string;
  PLAY_STORE_URL?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Resolve pkarr key and render profile page
app.get('/pk:z32Key', async (c) => {
  const z32Key = c.req.param('z32Key');
  
  if (!z32Key) {
    return c.json({ error: 'Missing pkarr key' }, 400);
  }

  return handleProfileRequest(c, z32Key);
});

// Also support the format without colon for easier sharing
app.get('/pk/:z32Key', async (c) => {
  const z32Key = c.req.param('z32Key');
  
  if (!z32Key) {
    return c.json({ error: 'Missing pkarr key' }, 400);
  }

  return handleProfileRequest(c, z32Key);
});

// Custom domain handler - checks for _delta.<domain> TXT record
app.get('/', async (c) => {
  const host = c.req.header('host');

  // If it's a custom domain (not the gateway's own domain), try to resolve it
  if (host && !isGatewayDomain(host)) {
    const z32Key = await resolveDomainToPkarr(host);

    if (z32Key) {
      return handleProfileRequest(c, z32Key, host);
    }

    // Domain has CNAME but no TXT record configured
    return c.html(renderDomainNotConfiguredPage(host), 404);
  }

  // Default: redirect to main site
  return c.redirect('https://delta.app', 302);
});

/**
 * Check if the host is the gateway's own domain (not a custom domain)
 */
function isGatewayDomain(host: string): boolean {
  // List of gateway's own domains
  const gatewayDomains = [
    'localhost',
    'localhost:8787',
    'pk.delta.app',
    'gateway.delta.app',
    'delta.pages.dev',
  ];

  // Check exact match or ends with .pages.dev (Cloudflare Pages)
  return gatewayDomains.includes(host) || host.endsWith('.pages.dev');
}

/**
 * Handle profile rendering with appropriate template based on record type
 */
async function handleProfileRequest(
  c: Context<{ Bindings: Env }>,
  z32Key: string,
  customDomain?: string
): Promise<Response> {
  const record = await resolvePkarr(z32Key);
  
  if (!record) {
    return c.html(renderNotFoundPage(z32Key), 404);
  }

  const appUrl = `${c.env.APP_SCHEME}://pk:${z32Key}`;
  const options = {
    appUrl,
    appStoreUrl: c.env.APP_STORE_URL,
    playStoreUrl: c.env.PLAY_STORE_URL,
  };

  // Use appropriate template based on record type
  let html: string;
  switch (record.recordType) {
    case 'org':
      html = renderOrgPage(record, options);
      break;
    case 'relay':
      html = renderRelayPage(record, options);
      break;
    case 'user':
    default:
      html = renderProfilePage(record, options);
      break;
  }

  return c.html(html);
}

function renderNotFoundPage(z32Key: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Not Found - Delta</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      text-align: center;
      max-width: 400px;
    }
    .icon { font-size: 64px; margin-bottom: 20px; }
    h1 { font-size: 24px; margin-bottom: 12px; }
    p { color: #888; line-height: 1.6; margin-bottom: 24px; }
    .key {
      font-family: monospace;
      background: #1a1a1a;
      padding: 12px;
      border-radius: 8px;
      font-size: 12px;
      word-break: break-all;
      margin-bottom: 24px;
    }
    a {
      color: #3b82f6;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🔍</div>
    <h1>Profile Not Found</h1>
    <p>We couldn't find a public profile or organization for this key.</p>
    <div class="key">pk:${escapeHtml(z32Key)}</div>
    <p>The profile may have been removed or the key may be incorrect.</p>
    <p><a href="https://delta.app">Download Delta App</a></p>
  </div>
</body>
</html>`;
}

function renderDomainNotConfiguredPage(domain: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Domain Not Configured - Delta</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      text-align: center;
      max-width: 500px;
    }
    .icon { font-size: 64px; margin-bottom: 20px; }
    h1 { font-size: 24px; margin-bottom: 12px; }
    p { color: #888; line-height: 1.6; margin-bottom: 16px; }
    .domain {
      font-family: monospace;
      background: #1a1a1a;
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 24px;
      color: #3b82f6;
    }
    .help {
      background: #1a1a2e;
      border-radius: 12px;
      padding: 20px;
      margin-top: 24px;
      text-align: left;
    }
    .help h3 { color: #fff; margin-bottom: 12px; font-size: 16px; }
    .help code {
      display: block;
      background: #0f172a;
      padding: 12px;
      border-radius: 8px;
      font-size: 12px;
      color: #94a3b8;
      margin: 8px 0;
      overflow-x: auto;
      font-family: 'SF Mono', Monaco, monospace;
    }
    .help .label {
      color: #64748b;
      font-size: 11px;
      text-transform: uppercase;
      margin-top: 12px;
    }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🌐</div>
    <h1>Domain Not Configured</h1>
    <p>This domain is not linked to a Delta profile.</p>
    <div class="domain">${escapeHtml(domain)}</div>

    <div class="help">
      <h3>To link this domain:</h3>
      <div class="label">1. Create a CNAME record:</div>
      <code>Host: @<br>Value: gateway.delta.app</code>
      <div class="label">2. Create a TXT record:</div>
      <code>Host: _delta<br>Value: pk:&lt;your-public-key&gt;</code>
      <div class="label">Example:</div>
      <code>Host: _delta<br>Value: pk:yj4bqhvahk8dge7r3s9q...</code>
    </div>

    <p style="margin-top: 24px;"><a href="https://delta.app">Download Delta App</a></p>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export default app;
