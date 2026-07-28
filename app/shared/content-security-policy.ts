const reactRefreshPreambleHash =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";

const directives = (scriptSource: string, connectSource: string): string =>
  [
    "default-src 'self'",
    `script-src ${scriptSource}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSource}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");

export const PRODUCTION_CONTENT_SECURITY_POLICY = directives(
  "'self'",
  "'self'",
);

export const DEVELOPMENT_CONTENT_SECURITY_POLICY = directives(
  `'self' ${reactRefreshPreambleHash}`,
  "'self' ws://127.0.0.1:* ws://localhost:*",
);
