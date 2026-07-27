const directives = (connectSource: string): string =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSource}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");

export const PRODUCTION_CONTENT_SECURITY_POLICY = directives("'self'");

export const DEVELOPMENT_CONTENT_SECURITY_POLICY = directives(
  "'self' ws://127.0.0.1:* ws://localhost:*",
);
