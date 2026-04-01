import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import './env';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { ProzorroModule } from './prozorro/prozorro.module';
import { SyncModule } from './sync/sync.module';
import { ProcessorModule } from './processor/processor.module';
import { SearchModule } from './search/search.module';
import { AuthModule } from './auth/auth.module';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { Request, Response, NextFunction } from 'express';
import { TENDER_QUEUE_NAME, PRICE_ANALYSIS_QUEUE_NAME } from './constants';
import { PriceAnalysisModule } from './price-analysis/price-analysis.module';
import { TelegramModule } from './telegram/telegram.module';
import { HttpThrottlerGuard } from './http-throttler.guard';

const isWorkerRole = process.env.APP_ROLE === 'WORKER';
const shouldStartTelegramBot =
  !isWorkerRole && Boolean(process.env.TELEGRAM_BOT_TOKEN);

function bullBoardAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];
  const validKey = process.env.API_KEY;
  if (validKey && apiKey === validKey) {
    return next();
  }
  // Deliberately omit the key value from logs to prevent secret exposure
  res.status(401).json({ message: 'Unauthorized' });
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
      },
    }),
    BullModule.registerQueue({
      name: TENDER_QUEUE_NAME,
    }),
    BullModule.registerQueue({
      name: PRICE_ANALYSIS_QUEUE_NAME,
    }),
    PrismaModule,
    ProzorroModule,
    SyncModule,
    ProcessorModule, // Import the processor module as well so the worker starts
    PriceAnalysisModule,
    ...(!isWorkerRole
      ? [
          ThrottlerModule.forRoot([{
            ttl: 60000,   // 60 seconds window
            limit: 100,   // max 100 requests per IP per minute
          }]),
          BullBoardModule.forRoot({
            route: '/queues',
            adapter: ExpressAdapter,
          }),
          BullBoardModule.forFeature({
            name: TENDER_QUEUE_NAME,
            adapter: BullMQAdapter,
          }),
          BullBoardModule.forFeature({
            name: PRICE_ANALYSIS_QUEUE_NAME,
            adapter: BullMQAdapter,
          }),
          SearchModule,
          AuthModule, // Global Auth guard
          ...(shouldStartTelegramBot ? [TelegramModule] : []),
        ]
      : []),
  ],
  controllers: isWorkerRole ? [] : [AppController],
  providers: [
    ...(isWorkerRole
      ? []
      : [
          AppService,
          { provide: APP_GUARD, useClass: HttpThrottlerGuard },
        ]),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    if (isWorkerRole) {
      return;
    }

    consumer
      .apply(bullBoardAuthMiddleware)
      .forRoutes('/queues', '/queues/*path');

  }
}
