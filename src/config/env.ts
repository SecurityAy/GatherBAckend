import dotenv from 'dotenv';

dotenv.config();

type CloudinaryConfiguration = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
};

function readCloudinaryConfiguration(): CloudinaryConfiguration | undefined {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

  if (!cloudName || !apiKey || !apiSecret) {
    return undefined;
  }

  if (/\s/.test(cloudName) || /\s/.test(apiKey) || /\s/.test(apiSecret)) {
    return undefined;
  }

  return { cloudName, apiKey, apiSecret };
}

export function readResendConfiguration(apiKey?: string, fromEmail?: string) {
  const normalizedApiKey = apiKey?.trim();
  if (!normalizedApiKey) return undefined;
  const normalizedFrom = fromEmail?.trim() || 'onboarding@resend.dev';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedFrom)) return undefined;
  return { apiKey: normalizedApiKey, fromEmail: normalizedFrom };
}

function readPasswordResetConfiguration() {
  const rawUrl = process.env.PASSWORD_RESET_URL?.trim();
  let passwordResetUrl: string | undefined;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      passwordResetUrl = rawUrl.replace(/\/$/, '');
    } catch {
      throw new Error('Invalid application configuration: PASSWORD_RESET_URL must be an HTTP(S) URL.');
    }
  }

  const rawTtl = process.env.PASSWORD_RESET_TTL_MINUTES?.trim();
  const passwordResetTtlMinutes = rawTtl === undefined || rawTtl === '' ? 60 : Number(rawTtl);
  if (!Number.isInteger(passwordResetTtlMinutes) || passwordResetTtlMinutes < 5 || passwordResetTtlMinutes > 1440) {
    throw new Error('Invalid application configuration: PASSWORD_RESET_TTL_MINUTES must be an integer between 5 and 1440.');
  }

  return { passwordResetUrl, passwordResetTtlMinutes };
}

function validateConfiguration() {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('Invalid application configuration: JWT_SECRET is required.');
  }
  if (jwtSecret.length < 32) {
    throw new Error('Invalid application configuration: JWT_SECRET must be at least 32 characters long.');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Invalid application configuration: DATABASE_URL is required.');
  }

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error('Invalid application configuration: DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (
    !['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol) ||
    !parsedDatabaseUrl.hostname ||
    parsedDatabaseUrl.pathname === '/'
  ) {
    throw new Error('Invalid application configuration: DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  const nodeEnv = process.env.NODE_ENV?.trim() || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('Invalid application configuration: NODE_ENV must be development, test, or production.');
  }
  const isProduction = nodeEnv === 'production';

  const rawPort = process.env.PORT?.trim();
  const port = rawPort === undefined || rawPort === '' ? 4000 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid application configuration: PORT must be an integer between 1 and 65535.');
  }

  const directUrl = process.env.DIRECT_URL?.trim();
  if (!directUrl) {
    throw new Error('Invalid application configuration: DIRECT_URL is required.');
  }
  let parsedDirectUrl: URL;
  try {
    parsedDirectUrl = new URL(directUrl);
  } catch {
    throw new Error('Invalid application configuration: DIRECT_URL must be a valid PostgreSQL connection URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsedDirectUrl.protocol) ||
    !parsedDirectUrl.hostname ||
    parsedDirectUrl.pathname === '/'
  ) {
    throw new Error('Invalid application configuration: DIRECT_URL must be a valid PostgreSQL connection URL.');
  }

  const cloudinaryValues = [
    process.env.CLOUDINARY_CLOUD_NAME,
    process.env.CLOUDINARY_API_KEY,
    process.env.CLOUDINARY_API_SECRET,
  ].map((value) => value?.trim() ?? '');
  if (cloudinaryValues.some(Boolean) && cloudinaryValues.some((value) => !value)) {
    throw new Error('Invalid application configuration: set all CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET values, or none.');
  }

  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const resendFromEmail = process.env.RESEND_FROM_EMAIL?.trim();
  if (!resendApiKey && resendFromEmail) {
    throw new Error('Invalid application configuration: RESEND_API_KEY is required when RESEND_FROM_EMAIL is set.');
  }
  if (resendApiKey && resendFromEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resendFromEmail)) {
    throw new Error('Invalid application configuration: RESEND_FROM_EMAIL must be a valid email address.');
  }

  const configuredOrigins = process.env.CORS_ORIGINS;
  if (isProduction && !configuredOrigins?.trim()) {
    throw new Error('Invalid application configuration: CORS_ORIGINS is required in production.');
  }

  const corsOrigins = (configuredOrigins?.trim()
    ? configuredOrigins.split(',')
    : isProduction
      ? []
      : ['http://localhost:5173', 'http://127.0.0.1:5173'])
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        const parsedOrigin = new URL(origin);
        if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
          throw new Error();
        }
        return parsedOrigin.origin;
      } catch {
        throw new Error('Invalid application configuration: CORS_ORIGINS must contain comma-separated HTTP origins.');
      }
    });

  const rawWorkerFlag = process.env.EMAIL_WORKER_IN_WEB?.trim().toLowerCase() ?? 'true';
  if (!['true', 'false'].includes(rawWorkerFlag)) {
    throw new Error('Invalid application configuration: EMAIL_WORKER_IN_WEB must be true or false.');
  }

  const resend = readResendConfiguration(process.env.RESEND_API_KEY, process.env.RESEND_FROM_EMAIL);
  const passwordReset = readPasswordResetConfiguration();
  return {
    jwtSecret, databaseUrl, port, nodeEnv, corsOrigins, cloudinary: readCloudinaryConfiguration(),
    resend,
    emailWorkerInWeb: rawWorkerFlag === 'true',
    frontendUrl: process.env.FRONTEND_URL?.trim(),
    ...passwordReset,
  };
}

const validatedConfig = validateConfiguration();

export const env = {
  port: validatedConfig.port,
  nodeEnv: validatedConfig.nodeEnv,
  jwtSecret: validatedConfig.jwtSecret,
  databaseUrl: validatedConfig.databaseUrl,
  corsOrigins: validatedConfig.corsOrigins,
  cloudinary: validatedConfig.cloudinary,
  resend: validatedConfig.resend,
  emailWorkerInWeb: validatedConfig.emailWorkerInWeb,
  frontendUrl: validatedConfig.frontendUrl,
  passwordResetUrl: validatedConfig.passwordResetUrl,
  passwordResetTtlMinutes: validatedConfig.passwordResetTtlMinutes,
};
