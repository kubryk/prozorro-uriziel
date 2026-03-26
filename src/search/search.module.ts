import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { TENDER_QUEUE_NAME } from '../constants';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: TENDER_QUEUE_NAME,
    }),
  ],
  providers: [SearchService],
  controllers: [SearchController]
})
export class SearchModule { }
