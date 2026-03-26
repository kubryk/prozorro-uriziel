import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from './prisma/prisma.service';
import { TENDER_QUEUE_NAME } from './constants';

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(TENDER_QUEUE_NAME) private readonly tenderQueue: Queue,
  ) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getHealth() {
    const checks: Record<string, string> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    try {
      const client = await this.tenderQueue.client;
      const pong = await client.ping();
      checks.redis = pong === 'PONG' ? 'ok' : 'error';
    } catch {
      checks.redis = 'error';
    }

    const allOk = Object.values(checks).every(v => v === 'ok');

    return {
      status: allOk ? 'ok' : 'degraded',
      checks,
      uptime: process.uptime(),
    };
  }
}
