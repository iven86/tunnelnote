const SECRET_ASSIGNMENT =
  /\b(password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;

export function redactSecrets(message: string): string {
  return message
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED PRIVATE KEY]')
    .replace(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(AWS_ACCESS_KEY, '[REDACTED AWS KEY]');
}

export const securityLogger = Object.freeze({
  info(message: string): void {
    console.info(redactSecrets(message));
  },
  warn(message: string): void {
    console.warn(redactSecrets(message));
  },
  error(message: string): void {
    console.error(redactSecrets(message));
  },
});
