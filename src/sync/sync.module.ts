import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProzorroModule } from '../prozorro/prozorro.module';
import { BullModule } from '@nestjs/bullmq';
import { TENDER_QUEUE_NAME } from '../constants';

@Module({
  imports: [
    PrismaModule,
    ProzorroModule,
    BullModule.registerQueue({
      name: TENDER_QUEUE_NAME,
    }),
  ],
  providers: [SyncService],
})
export class SyncModule { }
