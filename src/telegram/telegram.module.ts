import { Module } from '@nestjs/common';
import '../env';
import { TelegrafModule } from 'nestjs-telegraf';
import { SearchModule } from '../search/search.module';
import { PriceAnalysisModule } from '../price-analysis/price-analysis.module';
import { TelegramUpdate } from './telegram.update';
import { TelegramService } from './telegram.service';
import { authMiddleware } from './telegram.guard';

@Module({
  imports: [
    TelegrafModule.forRoot({
      token: process.env.TELEGRAM_BOT_TOKEN || '',
      middlewares: [authMiddleware()],
    }),
    SearchModule,
    PriceAnalysisModule,
  ],
  providers: [TelegramUpdate, TelegramService],
})
export class TelegramModule {}
