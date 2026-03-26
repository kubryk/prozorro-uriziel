import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { ProzorroModule } from '../prozorro/prozorro.module';
import { TenderProcessor } from './tender.processor/tender.processor';
import { TENDER_QUEUE_NAME } from '../constants';

@Module({
  imports: [
    PrismaModule,
    ProzorroModule,
    BullModule.registerQueue({
      name: TENDER_QUEUE_NAME,
    }),
  ],
  providers: [TenderProcessor],
  exports: [TenderProcessor],
})
export class ProcessorModule {}
