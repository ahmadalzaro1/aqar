/** Subset of ioredis connection options that BullMQ accepts. */
export type RedisConnection = {
  readonly host: string;
  readonly port: number;
  readonly db?: number;
  readonly username?: string;
  readonly password?: string;
};

/**
 * Parses a `redis://[user[:pass]@]host[:port][/db]` URL into connection options.
 * BullMQ hands these straight to ioredis; passing the raw URL string is not a
 * documented option, so we normalize explicitly.
 */
export function parseRedisUrl(rawUrl: string): RedisConnection {
  const url = new URL(rawUrl);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis URL protocol: ${url.protocol}`);
  }
  const port = url.port === '' ? 6379 : Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid Redis port in URL: ${url.port}`);
  }
  const dbSegment = url.pathname.replace(/^\//u, '');
  const connection: {
    host: string;
    port: number;
    db?: number;
    username?: string;
    password?: string;
  } = {
    host: url.hostname === '' ? '127.0.0.1' : url.hostname,
    port,
  };
  if (dbSegment.length > 0) {
    const db = Number.parseInt(dbSegment, 10);
    if (!Number.isInteger(db) || db < 0) throw new Error(`Invalid Redis db in URL: ${dbSegment}`);
    connection.db = db;
  }
  if (url.username !== '') connection.username = decodeURIComponent(url.username);
  if (url.password !== '') connection.password = decodeURIComponent(url.password);
  return connection;
}

/** `smtp://user:pass@host:port` → nodemailer transport options. */
export type SmtpConnection = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth?: { readonly user: string; readonly pass: string };
  /** Mailpit in dev talks plain SMTP; STARTTLS is not advertised. */
  readonly ignoreTLS: boolean;
};

export function parseSmtpUrl(rawUrl: string): SmtpConnection {
  const withScheme = rawUrl.includes('://') ? rawUrl : `smtp://${rawUrl}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    throw new Error(`Unsupported SMTP URL protocol: ${url.protocol}`);
  }
  const secure = url.protocol === 'smtps:';
  const port = url.port === '' ? (secure ? 465 : 25) : Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid SMTP port in URL: ${url.port}`);
  }
  const auth =
    url.username === ''
      ? undefined
      : { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) };
  return {
    host: url.hostname === '' ? '127.0.0.1' : url.hostname,
    port,
    secure,
    ignoreTLS: !secure,
    ...(auth === undefined ? {} : { auth }),
  };
}
