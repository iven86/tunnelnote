import { session } from 'electron';

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'";

// The Vite dev server needs an inline React-refresh preamble and an HMR websocket.
export function buildContentSecurityPolicy(devServerUrl?: string): string {
  if (!devServerUrl) {
    return CONTENT_SECURITY_POLICY;
  }
  const { host } = new URL(devServerUrl);
  return `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://${host}`;
}

export function installContentSecurityPolicy(): void {
  const policy = buildContentSecurityPolicy(process.env.ELECTRON_RENDERER_URL);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}
