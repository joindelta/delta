/**
 * HTML template rendering for profile pages.
 */

import type { ResolvedRecord } from './pkarr';

interface RenderOptions {
  appUrl: string;
  appStoreUrl?: string;
  playStoreUrl?: string;
}

/**
 * Render a profile page HTML for a resolved pkarr record.
 */
export function renderProfilePage(record: ResolvedRecord, options: RenderOptions): string {
  const { appUrl, appStoreUrl, playStoreUrl } = options;
  
  const isOrg = record.recordType === 'org';
  const title = isOrg ? (record.name || 'Organization') : (record.username || 'User');
  const description = isOrg ? record.description : record.bio;
  
  const avatarUrl = record.avatarBlobId 
    ? `https://blobs.deltachat.io/${record.avatarBlobId}` 
    : null;
  
  const coverUrl = record.coverBlobId
    ? `https://blobs.deltachat.io/${record.coverBlobId}`
    : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${escapeHtml(title)} on Delta">
  <meta property="og:description" content="${escapeHtml(description || 'Join me on Delta - secure decentralized messaging')}">
  ${avatarUrl ? `<meta property="og:image" content="${escapeHtml(avatarUrl)}">` : ''}
  <meta name="twitter:card" content="summary">
  <title>${escapeHtml(title)} - Delta</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #fff;
      min-height: 100vh;
    }
    .cover {
      width: 100%;
      height: 200px;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      background-size: cover;
      background-position: center;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      padding: 0 20px 40px;
    }
    .avatar-section {
      display: flex;
      align-items: flex-end;
      margin-top: -60px;
      margin-bottom: 20px;
    }
    .avatar {
      width: 120px;
      height: 120px;
      border-radius: 50%;
      background: #1a1a1a;
      border: 4px solid #0a0a0a;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 48px;
    }
    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .info {
      flex: 1;
      padding-left: 20px;
      padding-bottom: 10px;
    }
    .name {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .handle {
      color: #888;
      font-size: 14px;
    }
    .type-badge {
      display: inline-block;
      background: #3b82f6;
      color: #fff;
      font-size: 12px;
      padding: 4px 12px;
      border-radius: 12px;
      margin-top: 8px;
      text-transform: uppercase;
      font-weight: 600;
    }
    .description {
      color: #ccc;
      line-height: 1.6;
      margin: 20px 0;
      font-size: 16px;
    }
    .key-box {
      background: #1a1a1a;
      border-radius: 12px;
      padding: 16px;
      margin: 20px 0;
    }
    .key-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .key-value {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 13px;
      color: #aaa;
      word-break: break-all;
    }
    .actions {
      display: flex;
      gap: 12px;
      margin-top: 24px;
      flex-wrap: wrap;
    }
    .btn {
      flex: 1;
      min-width: 140px;
      padding: 14px 24px;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      text-align: center;
      cursor: pointer;
      border: none;
      transition: opacity 0.2s;
    }
    .btn:hover {
      opacity: 0.9;
    }
    .btn-primary {
      background: #3b82f6;
      color: #fff;
    }
    .btn-secondary {
      background: #1a1a1a;
      color: #fff;
    }
    .stores {
      margin-top: 32px;
      text-align: center;
    }
    .stores-title {
      color: #666;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .store-links {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .store-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
      background: #1a1a1a;
      border-radius: 8px;
      color: #fff;
      text-decoration: none;
      font-size: 14px;
      transition: background 0.2s;
    }
    .store-link:hover {
      background: #2a2a2a;
    }
    footer {
      margin-top: 40px;
      text-align: center;
      color: #666;
      font-size: 14px;
    }
    footer a {
      color: #3b82f6;
      text-decoration: none;
    }
  </style>
</head>
<body>
  ${coverUrl ? `<div class="cover" style="background-image: url('${escapeHtml(coverUrl)}')"></div>` : '<div class="cover"></div>'}
  
  <div class="container">
    <div class="avatar-section">
      <div class="avatar">
        ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="">` : (isOrg ? '🏢' : '👤')}
      </div>
      <div class="info">
        <div class="name">${escapeHtml(title)}</div>
        <div class="handle">pk:${escapeHtml(record.publicKey)}</div>
        <span class="type-badge">${isOrg ? 'Organization' : 'User'}</span>
      </div>
    </div>
    
    ${description ? `<p class="description">${escapeHtml(description)}</p>` : ''}
    
    <div class="key-box">
      <div class="key-label">Public Key</div>
      <div class="key-value">${escapeHtml(record.publicKey)}</div>
    </div>
    
    <div class="actions">
      <a href="${escapeHtml(appUrl)}" class="btn btn-primary">Open in Delta</a>
      <button class="btn btn-secondary" onclick="navigator.clipboard.writeText('${escapeHtml(record.publicKey)}'); this.textContent='Copied!'; setTimeout(() => this.textContent='Copy Key', 2000)">Copy Key</button>
    </div>
    
    <div class="stores">
      <div class="stores-title">Don't have Delta yet?</div>
      <div class="store-links">
        ${appStoreUrl ? `<a href="${escapeHtml(appStoreUrl)}" class="store-link">🍎 App Store</a>` : ''}
        ${playStoreUrl ? `<a href="${escapeHtml(playStoreUrl)}" class="store-link">🤖 Play Store</a>` : ''}
      </div>
    </div>
    
    <footer>
      <p>Powered by <a href="https://delta.app">Delta</a> • Decentralized Messaging</p>
    </footer>
  </div>
</body>
</html>`;
}

/**
 * Render an organization page with org-specific styling and features.
 */
export function renderOrgPage(record: ResolvedRecord, options: RenderOptions): string {
  const { appUrl, appStoreUrl, playStoreUrl } = options;
  
  const orgName = record.name || 'Organization';
  const description = record.description;
  
  const avatarUrl = record.avatarBlobId 
    ? `https://blobs.deltachat.io/${record.avatarBlobId}` 
    : null;
  
  const coverUrl = record.coverBlobId
    ? `https://blobs.deltachat.io/${record.coverBlobId}`
    : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${escapeHtml(orgName)} on Delta">
  <meta property="og:description" content="${escapeHtml(description || 'Join our organization on Delta - secure decentralized messaging')}">
  ${avatarUrl ? `<meta property="og:image" content="${escapeHtml(avatarUrl)}">` : ''}
  <meta name="twitter:card" content="summary">
  <title>${escapeHtml(orgName)} - Delta Organization</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #fff;
      min-height: 100vh;
    }
    .cover {
      width: 100%;
      height: 240px;
      background: linear-gradient(135deg, #1e3a5f 0%, #0d2137 50%, #1a1a2e 100%);
      background-size: cover;
      background-position: center;
      position: relative;
    }
    .cover::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 100px;
      background: linear-gradient(transparent, #0a0a0a);
    }
    .container {
      max-width: 680px;
      margin: 0 auto;
      padding: 0 20px 40px;
    }
    .org-header {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      margin-top: -80px;
      position: relative;
      z-index: 1;
    }
    .avatar {
      width: 140px;
      height: 140px;
      border-radius: 24px;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      border: 6px solid #0a0a0a;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 56px;
      box-shadow: 0 8px 32px rgba(59, 130, 246, 0.3);
    }
    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .org-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: #fff;
      font-size: 12px;
      padding: 6px 16px;
      border-radius: 20px;
      margin-top: 16px;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .org-name {
      font-size: 32px;
      font-weight: 800;
      margin-top: 16px;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #fff 0%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .org-handle {
      color: #64748b;
      font-size: 15px;
      font-family: 'SF Mono', Monaco, monospace;
    }
    .description {
      color: #cbd5e1;
      line-height: 1.7;
      margin: 28px 0;
      font-size: 17px;
      text-align: center;
      max-width: 500px;
      margin-left: auto;
      margin-right: auto;
    }
    .key-box {
      background: linear-gradient(135deg, #1a1a2e 0%, #0f172a 100%);
      border: 1px solid #1e293b;
      border-radius: 16px;
      padding: 20px;
      margin: 24px 0;
    }
    .key-label {
      font-size: 11px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
    }
    .key-value {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 13px;
      color: #94a3b8;
      word-break: break-all;
    }
    .actions {
      display: flex;
      gap: 12px;
      margin-top: 28px;
      flex-direction: column;
    }
    .btn {
      padding: 16px 28px;
      border-radius: 14px;
      font-size: 17px;
      font-weight: 700;
      text-decoration: none;
      text-align: center;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
    }
    .btn-primary {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: #fff;
      box-shadow: 0 4px 20px rgba(59, 130, 246, 0.4);
    }
    .btn-primary:hover {
      box-shadow: 0 6px 28px rgba(59, 130, 246, 0.5);
    }
    .btn-secondary {
      background: #1e293b;
      color: #e2e8f0;
    }
    .btn-secondary:hover {
      background: #334155;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 16px;
      margin: 32px 0;
    }
    .feature {
      background: #1a1a1a;
      border-radius: 12px;
      padding: 20px;
      text-align: center;
    }
    .feature-icon {
      font-size: 28px;
      margin-bottom: 8px;
    }
    .feature-text {
      font-size: 13px;
      color: #94a3b8;
    }
    .stores {
      margin-top: 40px;
      text-align: center;
      padding-top: 32px;
      border-top: 1px solid #1e293b;
    }
    .stores-title {
      color: #64748b;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .store-links {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .store-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
      background: #1e293b;
      border-radius: 10px;
      color: #fff;
      text-decoration: none;
      font-size: 14px;
      transition: all 0.2s;
    }
    .store-link:hover {
      background: #334155;
    }
    footer {
      margin-top: 48px;
      text-align: center;
      color: #64748b;
      font-size: 14px;
    }
    footer a {
      color: #3b82f6;
      text-decoration: none;
    }
  </style>
</head>
<body>
  ${coverUrl ? `<div class="cover" style="background-image: url('${escapeHtml(coverUrl)}')"></div>` : '<div class="cover"></div>'}
  
  <div class="container">
    <div class="org-header">
      <div class="avatar">
        ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="">` : '🏢'}
      </div>
      <span class="org-badge">🏢 Verified Organization</span>
      <h1 class="org-name">${escapeHtml(orgName)}</h1>
      <div class="org-handle">pk:${escapeHtml(record.publicKey)}</div>
    </div>
    
    ${description ? `<p class="description">${escapeHtml(description)}</p>` : ''}
    
    <div class="features">
      <div class="feature">
        <div class="feature-icon">🔒</div>
        <div class="feature-text">End-to-End Encrypted</div>
      </div>
      <div class="feature">
        <div class="feature-icon">🌐</div>
        <div class="feature-text">Decentralized</div>
      </div>
      <div class="feature">
        <div class="feature-icon">👥</div>
        <div class="feature-text">Team Channels</div>
      </div>
    </div>
    
    <div class="key-box">
      <div class="key-label">Organization Public Key</div>
      <div class="key-value">${escapeHtml(record.publicKey)}</div>
    </div>
    
    <div class="actions">
      <a href="${escapeHtml(appUrl)}" class="btn btn-primary">Join Organization in Delta</a>
      <button class="btn btn-secondary" onclick="navigator.clipboard.writeText('${escapeHtml(record.publicKey)}'); this.textContent='✓ Copied!'; setTimeout(() => this.textContent='Copy Organization Key', 2000)">Copy Organization Key</button>
    </div>
    
    <div class="stores">
      <div class="stores-title">Don't have Delta yet?</div>
      <div class="store-links">
        ${appStoreUrl ? `<a href="${escapeHtml(appStoreUrl)}" class="store-link">🍎 App Store</a>` : ''}
        ${playStoreUrl ? `<a href="${escapeHtml(playStoreUrl)}" class="store-link">🤖 Play Store</a>` : ''}
      </div>
    </div>
    
    <footer>
      <p>Powered by <a href="https://delta.app">Delta</a> • Secure Team Communication</p>
    </footer>
  </div>
</body>
</html>`;
}

/**
 * Render a relay server page with relay-specific information.
 */
export function renderRelayPage(record: ResolvedRecord, options: RenderOptions): string {
  const { appUrl, appStoreUrl, playStoreUrl } = options;
  
  const relayUrl = record.relayUrl || 'Unknown Relay';
  const relayName = record.name || 'Delta Relay';
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${escapeHtml(relayName)}">
  <meta property="og:description" content="Delta relay server for secure message routing">
  <meta name="twitter:card" content="summary">
  <title>${escapeHtml(relayName)} - Delta Relay</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #fff;
      min-height: 100vh;
    }
    .hero {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      padding: 60px 20px;
      text-align: center;
      border-bottom: 1px solid #1e293b;
    }
    .relay-icon {
      width: 100px;
      height: 100px;
      background: linear-gradient(135deg, #10b981, #059669);
      border-radius: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 48px;
      margin: 0 auto 24px;
      box-shadow: 0 8px 32px rgba(16, 185, 129, 0.3);
    }
    .relay-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(16, 185, 129, 0.2);
      color: #10b981;
      font-size: 12px;
      padding: 6px 16px;
      border-radius: 20px;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.5px;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .relay-name {
      font-size: 32px;
      font-weight: 800;
      margin-top: 16px;
      margin-bottom: 8px;
    }
    .relay-url {
      color: #64748b;
      font-size: 16px;
      font-family: 'SF Mono', Monaco, monospace;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    .info-card {
      background: #1a1a1a;
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
    }
    .info-label {
      font-size: 11px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }
    .info-value {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 14px;
      color: #e2e8f0;
      word-break: break-all;
    }
    .description {
      color: #94a3b8;
      line-height: 1.7;
      margin: 24px 0;
      font-size: 16px;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 16px;
      margin: 32px 0;
    }
    .feature {
      background: linear-gradient(135deg, #1a1a2e 0%, #0f172a 100%);
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 20px;
      text-align: center;
    }
    .feature-icon {
      font-size: 28px;
      margin-bottom: 8px;
    }
    .feature-text {
      font-size: 13px;
      color: #94a3b8;
    }
    .actions {
      display: flex;
      gap: 12px;
      margin-top: 32px;
      flex-direction: column;
    }
    .btn {
      padding: 16px 28px;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 700;
      text-decoration: none;
      text-align: center;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
    }
    .btn-primary {
      background: linear-gradient(135deg, #10b981, #059669);
      color: #fff;
      box-shadow: 0 4px 20px rgba(16, 185, 129, 0.3);
    }
    .btn-primary:hover {
      box-shadow: 0 6px 28px rgba(16, 185, 129, 0.4);
    }
    .btn-secondary {
      background: #1e293b;
      color: #e2e8f0;
    }
    .btn-secondary:hover {
      background: #334155;
    }
    .stores {
      margin-top: 40px;
      text-align: center;
      padding-top: 32px;
      border-top: 1px solid #1e293b;
    }
    .stores-title {
      color: #64748b;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .store-links {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .store-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
      background: #1e293b;
      border-radius: 10px;
      color: #fff;
      text-decoration: none;
      font-size: 14px;
      transition: all 0.2s;
    }
    .store-link:hover {
      background: #334155;
    }
    footer {
      margin-top: 48px;
      text-align: center;
      color: #64748b;
      font-size: 14px;
    }
    footer a {
      color: #3b82f6;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="hero">
    <div class="relay-icon">📡</div>
    <span class="relay-badge">🟢 Relay Server</span>
    <h1 class="relay-name">${escapeHtml(relayName)}</h1>
    <div class="relay-url">${escapeHtml(relayUrl)}</div>
  </div>
  
  <div class="container">
    <p class="description">
      This is a Delta relay server that helps route messages securely between users.
      Relay servers are part of Delta's decentralized network infrastructure.
    </p>
    
    <div class="features">
      <div class="feature">
        <div class="feature-icon">🔒</div>
        <div class="feature-text">Encrypted Routing</div>
      </div>
      <div class="feature">
        <div class="feature-icon">⚡</div>
        <div class="feature-text">Low Latency</div>
      </div>
      <div class="feature">
        <div class="feature-icon">🌐</div>
        <div class="feature-text">Decentralized</div>
      </div>
    </div>
    
    <div class="info-card">
      <div class="info-label">Relay URL</div>
      <div class="info-value">${escapeHtml(relayUrl)}</div>
    </div>
    
    <div class="info-card">
      <div class="info-label">Public Key</div>
      <div class="info-value">${escapeHtml(record.publicKey)}</div>
    </div>
    
    <div class="actions">
      <a href="${escapeHtml(appUrl)}" class="btn btn-primary">Use This Relay in Delta</a>
      <button class="btn btn-secondary" onclick="navigator.clipboard.writeText('${escapeHtml(record.publicKey)}'); this.textContent='✓ Copied!'; setTimeout(() => this.textContent='Copy Relay Key', 2000)">Copy Relay Key</button>
    </div>
    
    <div class="stores">
      <div class="stores-title">Don't have Delta yet?</div>
      <div class="store-links">
        ${appStoreUrl ? `<a href="${escapeHtml(appStoreUrl)}" class="store-link">🍎 App Store</a>` : ''}
        ${playStoreUrl ? `<a href="${escapeHtml(playStoreUrl)}" class="store-link">🤖 Play Store</a>` : ''}
      </div>
    </div>
    
    <footer>
      <p>Powered by <a href="https://delta.app">Delta</a> • Decentralized Messaging</p>
    </footer>
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
