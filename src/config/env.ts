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

  const isProduction = process.env.NODE_ENV === 'production';
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

  return { jwtSecret, databaseUrl, corsOrigins, cloudinary: readCloudinaryConfiguration() };
}

const validatedConfig = validateConfiguration();

export const env = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: validatedConfig.jwtSecret,
  databaseUrl: validatedConfig.databaseUrl,
  corsOrigins: validatedConfig.corsOrigins,
  cloudinary: validatedConfig.cloudinary,
};
