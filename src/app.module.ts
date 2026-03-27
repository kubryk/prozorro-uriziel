import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
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
import { TENDER_QUEUE_NAME } from './constants';

function bullBoardAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === process.env.API_KEY) {
    return next();
  }
  res.status(401).json({ message: 'Unauthorized' });
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{
      ttl: 60000,   // 60 seconds window
      limit: 100,   // max 100 requests per IP per minute
    }]),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
      },
    }),
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
    }),
    BullModule.registerQueue({
      name: TENDER_QUEUE_NAME,
    }),
    BullBoardModule.forFeature({
      name: TENDER_QUEUE_NAME,
      adapter: BullMQAdapter,
    }),
    PrismaModule,
    ProzorroModule,
    SyncModule,
    SearchModule,
    ProcessorModule, // Import the processor module as well so the worker starts
    AuthModule, // Global Auth guard
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(bullBoardAuthMiddleware).forRoutes('/queues(.*)');

  }
}
