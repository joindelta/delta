/**
 * Base layout component for all pages.
 */

import type { JSXNode } from 'hono/jsx';

interface LayoutProps {
  children: JSXNode;
  title: string;
  description: string;
  ogType?: string;
  appUrl?: string;
}

export function Layout({ children, title, description, ogType = 'website', appUrl }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title}</title>
        <meta name="description" content={description} />
        
        {/* Open Graph */}
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content={ogType} />
        
        {/* Twitter */}
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        
        {/* App Links */}
        {appUrl && (
          <>
            <meta property="al:ios:url" content={appUrl} />
            <meta property="al:android:url" content={appUrl} />
          </>
        )}
        
        <style>{`
          * { margin: 0; padding: 0; box-sizing: border-box; }
          
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: #0a0a0a;
            color: #fff;
            line-height: 1.6;
            min-height: 100vh;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
          }
          
          a { color: inherit; text-decoration: none; }
          
          .container {
            max-width: 480px;
            margin: 0 auto;
          }
          
          .footer {
            text-align: center;
            padding: 32px 24px;
            color: #555;
            font-size: 13px;
          }
          
          .footer a {
            color: #3b82f6;
          }
          
          .footer a:hover {
            text-decoration: underline;
          }
          
          @media (max-width: 480px) {
            body { font-size: 15px; }
          }
        `}</style>
      </head>
      <body>
        <div class="container">
          {children}
        </div>
        
        <footer class="footer">
          <p>Powered by <a href="https://delta.app">Delta</a> • Decentralized messaging</p>
        </footer>
      </body>
    </html>
  );
}
