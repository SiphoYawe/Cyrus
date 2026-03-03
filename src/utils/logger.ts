import pino from 'pino';

const SECRET_PATTERNS = [
  /0x[a-fA-F0-9]{64}/g,    // private keys
  /sk-[a-zA-Z0-9-_]{20,}/g, // API keys
];

function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

const isDev = process.env.NODE_ENV !== 'production';

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

const rootLogger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport,
  serializers: {
    ...pino.stdSerializers,
    config: (value: unknown) => {
      if (typeof value === 'string') {
        return redactSecrets(value);
      }
      return value;
    },
  },
  redact: {
    paths: [
      'privateKey',
      'lifiApiKey',
      'anthropicApiKey',
      'config.privateKey',
      'config.lifiApiKey',
      'config.anthropicApiKey',
    ],
    censor: '[REDACTED]',
  },
});

export function createLogger(component: string): pino.Logger {
  return rootLogger.child({ component });
}

export { rootLogger };
