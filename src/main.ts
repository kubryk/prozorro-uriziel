import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import './env';
import { AppModule } from './app.module';

const bootstrapLogger = new Logger('Bootstrap');
const UNRESOLVED_ENV_PATTERN = /\$\{[^}]+\}/;

process.on('uncaughtException', (error: Error) => {
  bootstrapLogger.error(`Uncaught exception: ${error.message}`, error.stack);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  bootstrapLogger.error(`Unhandled rejection: ${msg}`, stack);
});

function isWorkerRole(): boolean {
  return process.env.APP_ROLE === 'WORKER';
}

function validateEnv() {
  const required = ['DATABASE_URL', 'REDIS_HOST'];
  if (!isWorkerRole()) {
    required.push('API_KEY');
  }
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const unresolved = required.filter((key) =>
    UNRESOLVED_ENV_PATTERN.test(process.env[key] || ''),
  );
  if (unresolved.length > 0) {
    throw new Error(
      `Environment variables contain unresolved placeholders: ${unresolved.join(', ')}`,
    );
  }
}

async function bootstrap() {
  validateEnv();

  if (isWorkerRole()) {
    await NestFactory.createApplicationContext(AppModule);
    bootstrapLogger.log(
      'Started in WORKER mode. HTTP server, Swagger, Bull Board, and Telegram bot are disabled.',
    );
    return;
  }

  const app = await NestFactory.create(AppModule);

  // CORS: restrict to CORS_ORIGIN env var (comma-separated for multiple origins)
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
  app.enableCors({
    origin: corsOrigin.includes(',')
      ? corsOrigin.split(',').map((o) => o.trim())
      : corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Accept, X-API-KEY',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Prozorro Track System API')
      .setDescription('The Prozorro System Tracker API description')
      .setVersion('1.0')
      .addTag('search')
      .addApiKey({ type: 'apiKey', name: 'X-API-KEY', in: 'header' }, 'api-key')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);
  }

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
