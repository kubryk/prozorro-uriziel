import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { ProzorroModule } from '../prozorro/prozorro.module';
import { PRICE_ANALYSIS_QUEUE_NAME } from '../constants';
import { GeminiService } from './gemini.service';
import { PdfExtractorService } from './pdf-extractor.service';
import { PriceAnalysisService } from './price-analysis.service';
import { PriceAnalysisProcessor } from './price-analysis.processor';
import { PriceAnalysisController } from './price-analysis.controller';
import { MistralOcrService } from './mistral-ocr.service';

@Module({
  imports: [
    PrismaModule,
    ProzorroModule,
    HttpModule,
    BullModule.registerQueue({
      name: PRICE_ANALYSIS_QUEUE_NAME,
    }),
  ],
  controllers: [PriceAnalysisController],
  providers: [
    GeminiService,
    PdfExtractorService,
    MistralOcrService,
    PriceAnalysisService,
    PriceAnalysisProcessor,
  ],
  exports: [PriceAnalysisService],
})
export class PriceAnalysisModule {}
