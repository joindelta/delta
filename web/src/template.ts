/**
 * HTML template rendering for profile pages.
 * Matrix-inspired design - clean, centered card layout
 */

import type { ResolvedRecord } from './pkarr';

interface RenderOptions {
  appUrl: string;
  appStoreUrl?: string;
  playStoreUrl?: string;
}

/**
 * SVG wave background pattern for the light theme
 */
const waveBackgroundSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 800" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="waveGrad1" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#e5e7eb;stop-opacity:0.5" />
      <stop offset="50%" style="stop-color:#d1d5db;stop-opacity:0.3" />
      <stop offset="100%" style="stop-color:#e5e7eb;stop-opacity:0.5" />
    </linearGradient>
    <linearGradient id="waveGrad2" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#d1d5db;stop-opacity:0.3" />
      <stop offset="50%" style="stop-color:#9ca3af;stop-opacity:0.2" />
      <stop offset="100%" style="stop-color:#d1d5db;stop-opacity:0.3" />
    </linearGradient>
  </defs>
  <path fill="url(#waveGrad1)" d="M0,160 C320,300 420,100 720,160 C1020,220 1120,20 1440,160 L1440,800 L0,800 Z" opacity="0.4"/>
  <path fill="url(#waveGrad2)" d="M0,200 C360,340 460,140 720,200 C980,260 1080,60 1440,200 L1440,800 L0,800 Z" opacity="0.3"/>
  <path fill="url(#waveGrad1)" d="M0,240 C400,380 500,180 720,240 C940,300 1040,100 1440,240 L1440,800 L0,800 Z" opacity="0.2"/>
</svg>
`;

/**
 * Delta logo SVG
 */
const deltaLogoSvg = `
<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="48" height="48" rx="12" fill="url(#deltaGrad)"/>
  <path d="M14 24C14 18.4772 18.4772 14 24 14V14C29.5228 14 34 18.4772 34 24V28C34 32.4183 30.4183 36 26 36H22C17.5817 36 14 32.4183 14 28V24Z" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="24" cy="24" r="4" fill="white"/>
  <defs>
    <linearGradient id="deltaGrad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
      <stop stop-color="#3B82F6"/>
      <stop offset="1" stop-color="#8B5CF6"/>
    </linearGradient>
  </defs>
</svg>
`;

/**
 * Common CSS styles shared across all page types
 */
const commonStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: linear-gradient(180deg, #f3f4f6 0%, #e5e7eb 100%);
    color: #1f2937;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 16px;
    position: relative;
  }
  .bg-waves {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-image: url('data:image/svg+xml,${encodeURIComponent(waveBackgroundSvg)}');
    background-size: cover;
    background-position: center;
    pointer-events: none;
    z-index: 0;
  }
  .main-card {
    background: #ffffff;
    border-radius: 20px;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1), 0 10px 40px -10px rgba(0, 0, 0, 0.1);
    max-width: 440px;
    width: 100%;
    padding: 28px;
    position: relative;
    z-index: 1;
    animation: fadeInUp 0.5s ease-out;
  }
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .logo {
    display: flex;
    justify-content: center;
    margin-bottom: 16px;
  }
  .logo svg {
    width: 40px;
    height: 40px;
  }
  .header {
    text-align: center;
    margin-bottom: 12px;
  }
  .title {
    font-size: 24px;
    font-weight: 700;
    color: #111827;
    margin-bottom: 6px;
    letter-spacing: -0.025em;
  }
  .handle {
    font-family: 'SF Mono', Monaco, Consolas, monospace;
    font-size: 12px;
    color: #6b7280;
    word-break: break-all;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #f3f4f6;
    color: #4b5563;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 16px;
    margin-top: 8px;
    font-weight: 500;
  }
  .badge-icon {
    width: 14px;
    height: 14px;
  }
  .avatar {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    object-fit: cover;
    margin: 0 auto 12px;
    display: block;
    border: 3px solid #fff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }
  .avatar-placeholder {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    margin: 0 auto 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #3B82F6, #8B5CF6);
    color: #fff;
    font-size: 32px;
    font-weight: 600;
    border: 3px solid #fff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }
  .description {
    text-align: center;
    color: #4b5563;
    font-size: 14px;
    line-height: 1.5;
    margin: 16px 0;
  }
  .app-card {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 16px;
    margin-top: 16px;
  }
  .app-header {
    margin-bottom: 12px;
  }
  .app-name {
    font-size: 15px;
    font-weight: 600;
    color: #111827;
    margin-bottom: 2px;
  }
  .app-description {
    font-size: 13px;
    color: #6b7283;
    line-height: 1.4;
  }
  .learn-more {
    color: #3B82F6;
    text-decoration: none;
    font-weight: 500;
  }
  .learn-more:hover {
    text-decoration: underline;
  }
  .platforms {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #6b7280;
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid #e5e7eb;
  }
  .platform-icon {
    font-size: 14px;
  }
  .instructions {
    font-size: 13px;
    color: #374151;
    line-height: 1.5;
    margin-bottom: 10px;
  }
  .copy-box {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 12px;
    font-family: 'SF Mono', Monaco, Consolas, monospace;
    font-size: 11px;
    color: #6b7280;
    word-break: break-all;
  }
  .copy-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px;
    border-radius: 6px;
    color: #3B82F6;
    transition: background 0.2s;
    flex-shrink: 0;
  }
  .copy-btn:hover {
    background: #eff6ff;
  }
  .copy-btn.copied {
    color: #10b981;
  }
  .btn-primary {
    display: block;
    width: 100%;
    padding: 12px 20px;
    background: linear-gradient(135deg, #3B82F6, #2563eb);
    color: #ffffff;
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
    text-align: center;
    border-radius: 10px;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
    box-shadow: 0 2px 4px -1px rgba(59, 130, 246, 0.3);
  }
  .btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 8px -2px rgba(59, 130, 246, 0.4);
  }
  .alternative {
    text-align: center;
    margin-top: 12px;
    font-size: 12px;
    color: #6b7280;
  }
  .alternative a {
    color: #3B82F6;
    text-decoration: none;
    font-weight: 500;
  }
  .alternative a:hover {
    text-decoration: underline;
  }
  .footer {
    text-align: center;
    margin-top: 16px;
    font-size: 12px;
    color: #9ca3af;
  }
  .footer a {
    color: #3B82F6;
    text-decoration: none;
  }
  .footer a:hover {
    text-decoration: underline;
  }
  .brand-footer {
    margin-top: 20px;
    text-align: center;
    position: relative;
    z-index: 1;
  }
  .brand-logo {
    font-size: 16px;
    font-weight: 700;
    color: #6b7280;
    letter-spacing: -0.02em;
  }
  @media (max-width: 520px) {
    .main-card {
      padding: 20px 16px;
      border-radius: 16px;
    }
    .title {
      font-size: 22px;
    }
  }
`;

/**
 * Render a profile page HTML for a resolved pkarr record.
 */
export function renderProfilePage(record: ResolvedRecord, options: RenderOptions): string {
  const { appUrl, appStoreUrl, playStoreUrl } = options;
  
  const title = record.username || 'User';
  const description = record.bio;
  const displayHandle = `pk:${record.publicKey.slice(0, 16)}...${record.publicKey.slice(-8)}`;
  
  const avatarUrl = record.avatarBlobId 
    ? `https://blobs.deltachat.io/${record.avatarBlobId}` 
    : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${escapeHtml(title)} on Delta">
  <meta property="og:description" content="${escapeHtml(description || 'Connect with me on Delta - secure decentralized messaging')}">
  ${avatarUrl ? `<meta property="og:image" content="${escapeHtml(avatarUrl)}">` : ''}
  <meta name="twitter:card" content="summary">
  <title>${escapeHtml(title)} - Delta</title>
  <style>${commonStyles}</style>
</head>
<body>
  <div class="bg-waves"></div>
  
  <div class="main-card">
    ${avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(title)}" class="avatar">`
      : `<div class="avatar-placeholder">${escapeHtml(title.charAt(0).toUpperCase())}</div>`
    }
    
    <div class="header">
      <h1 class="title">${escapeHtml(title)}</h1>
      <div class="handle">${escapeHtml(displayHandle)}</div>
      <span class="badge">
        <span class="badge-icon">👤</span>
        Public Profile
      </span>
    </div>
    
    ${description ? `<p class="description">${escapeHtml(description)}</p>` : ''}
    
    <div class="app-card">
      <div class="app-header">
        <div class="app-name">Delta Messenger</div>
        <div class="app-description">
          Connect securely on the Delta network.
          <a href="https://delta.app" class="learn-more" target="_blank">Learn more</a>
        </div>
      </div>
      
      <div class="platforms">
        <span class="platform-icon">📱</span>
        <span>Web, iOS & Android</span>
      </div>
      
      <p class="instructions">
        Open the app on your device, tap "Add Contact" and paste this identifier:
      </p>
      
      <div class="copy-box">
        <span style="flex: 1;">${escapeHtml(record.publicKey)}</span>
        <button class="copy-btn" onclick="copyToClipboard(this, '${escapeHtml(record.publicKey)}')" title="Copy">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>
      
      <a href="${escapeHtml(appUrl)}" class="btn-primary">Open in Delta App</a>
      
      <div class="alternative">
        Don't have Delta? <a href="https://delta.app" target="_blank">Download now</a>
      </div>
    </div>
    
    <div class="footer">
      Public key verification powered by <a href="https://pkarr.org" target="_blank">Pkarr</a>
    </div>
  </div>
  
  <div class="brand-footer">
    <span class="brand-logo">delta Δ</span>
  </div>
  
  <script>
    function copyToClipboard(btn, text) {
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copied');
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

/**
 * Render an organization page with org-specific styling.
 */
export function renderOrgPage(record: ResolvedRecord, options: RenderOptions): string {
  const { appUrl, appStoreUrl, playStoreUrl } = options;
  
  const orgName = record.name || 'Organization';
  const description = record.description;
  const displayHandle = `pk:${record.publicKey.slice(0, 16)}...${record.publicKey.slice(-8)}`;
  
  const avatarUrl = record.avatarBlobId 
    ? `https://blobs.deltachat.io/${record.avatarBlobId}` 
    : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${escapeHtml(orgName)} on Delta">
  <meta property="og:description" content="${escapeHtml(description || 'Join our organization on Delta - secure team messaging')}">
  ${avatarUrl ? `<meta property="og:image" content="${escapeHtml(avatarUrl)}">` : ''}
  <meta name="twitter:card" content="summary">
  <title>${escapeHtml(orgName)} - Delta Organization</title>
  <style>${commonStyles}</style>
</head>
<body>
  <div class="bg-waves"></div>
  
  <div class="main-card">
    ${avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(orgName)}" class="avatar">`
      : `<div class="avatar-placeholder">${escapeHtml(orgName.charAt(0).toUpperCase())}</div>`
    }
    
    <div class="header">
      <h1 class="title">${escapeHtml(orgName)}</h1>
      <div class="handle">${escapeHtml(displayHandle)}</div>
      <span class="badge">
        <span class="badge-icon">🏢</span>
        Organization
      </span>
    </div>
    
    ${description ? `<p class="description">${escapeHtml(description)}</p>` : ''}
    
    <div class="app-card">
      <div class="app-header">
        <div class="app-name">Delta for Teams</div>
        <div class="app-description">
          Join this organization for secure, end-to-end encrypted team communication.
          <a href="https://delta.app" class="learn-more" target="_blank">Learn more</a>
        </div>
      </div>
      
      <div class="platforms">
        <span class="platform-icon">📱</span>
        <span>Web, Desktop, iOS & Android</span>
      </div>
      
      <p class="instructions">
        Open the Delta app, tap "Discover Organizations" and paste this identifier:
      </p>
      
      <div class="copy-box">
        <span style="flex: 1;">${escapeHtml(record.publicKey)}</span>
        <button class="copy-btn" onclick="copyToClipboard(this, '${escapeHtml(record.publicKey)}')" title="Copy">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>
      
      <a href="${escapeHtml(appUrl)}" class="btn-primary">Join Organization</a>
      
      <div class="alternative">
        Don't have Delta? <a href="https://delta.app" target="_blank">Download now</a>
      </div>
    </div>
    
    <div class="footer">
      Organization verified via <a href="https://pkarr.org" target="_blank">Pkarr</a>
    </div>
  </div>
  
  <div class="brand-footer">
    <span class="brand-logo">delta Δ</span>
  </div>
  
  <script>
    function copyToClipboard(btn, text) {
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copied');
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        }, 2000);
      });
    }
  </script>
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
  const displayHandle = `pk:${record.publicKey.slice(0, 16)}...${record.publicKey.slice(-8)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${escapeHtml(relayName)}">
  <meta property="og:description" content="Delta relay server for secure message routing">
  <meta name="twitter:card" content="summary">
  <title>${escapeHtml(relayName)} - Delta Relay</title>
  <style>${commonStyles}</style>
</head>
<body>
  <div class="bg-waves"></div>
  
  <div class="main-card">
    <div class="header">
      <h1 class="title">${escapeHtml(relayName)}</h1>
      <div class="handle">${escapeHtml(displayHandle)}</div>
      <span class="badge" style="background: #dcfce7; color: #166534;">
        <span class="badge-icon">🟢</span>
        Relay Server
      </span>
    </div>
    
    <p class="description">
      This relay server helps route messages securely through the Delta network.
      Relays enable offline message delivery and improved connectivity.
    </p>
    
    <div class="app-card">
      <div class="app-header">
        <div class="app-name">Delta Messenger</div>
        <div class="app-description">
          Use this relay for enhanced privacy and reliability.
          <a href="https://delta.app" class="learn-more" target="_blank">Learn more</a>
        </div>
      </div>
      
      <div class="platforms">
        <span class="platform-icon">📱</span>
        <span>Web, Desktop, iOS & Android</span>
      </div>
      
      <p class="instructions">
        Open the Delta app, go to Settings → Network → Relays and paste this identifier:
      </p>
      
      <div class="copy-box">
        <span style="flex: 1;">${escapeHtml(record.publicKey)}</span>
        <button class="copy-btn" onclick="copyToClipboard(this, '${escapeHtml(record.publicKey)}')" title="Copy">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>
      
      <a href="${escapeHtml(appUrl)}" class="btn-primary" style="background: linear-gradient(135deg, #10b981, #059669);">Use This Relay</a>
      
      <div class="alternative">
        Don't have Delta? <a href="https://delta.app" target="_blank">Download now</a>
      </div>
    </div>
    
    <div class="footer">
      Relay URL: <code style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 12px;">${escapeHtml(relayUrl)}</code>
    </div>
  </div>
  
  <div class="brand-footer">
    <span class="brand-logo">delta Δ</span>
  </div>
  
  <script>
    function copyToClipboard(btn, text) {
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copied');
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;');
}
