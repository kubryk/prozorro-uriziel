import { Update, Start, Help, Command, Ctx, On, Action } from 'nestjs-telegraf';
import { Logger } from '@nestjs/common';
import { Context, Markup } from 'telegraf';
import { SearchService } from '../search/search.service';
import { PriceAnalysisService } from '../price-analysis/price-analysis.service';
import { TelegramService } from './telegram.service';

const RESULTS_PER_PAGE = 5;

// In-memory session store for multi-step search flows
// Key: chatId, Value: current search state
interface SearchSession {
  step: 'edrpou' | 'role' | 'year' | 'minPrice';
  edrpou?: string;
  role?: 'customer' | 'supplier' | 'both';
  year?: number | null;
  minPrice?: number;
}

// Cache for search results (for pagination and bulk analysis)
// Key: searchKey, Value: tender IDs
interface SearchCache {
  tenderIds: string[];
  chatId: string;
  createdAt: number;
}

const searchSessions = new Map<number, SearchSession>();
const searchResultsCache = new Map<string, SearchCache>();

// Clean up old cache entries every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [key, value] of searchResultsCache) {
    if (value.createdAt < cutoff) searchResultsCache.delete(key);
  }
}, 30 * 60 * 1000);

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    private readonly searchService: SearchService,
    private readonly priceAnalysisService: PriceAnalysisService,
    private readonly telegramService: TelegramService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context) {
    await ctx.reply(
      '👋 Вітаю! Я бот для аналізу закупівель Prozorro.\n\n' +
        'Команди:\n' +
        '<code>/search</code> — Пошук тендерів за ЄДРПОУ\n' +
        '<code>/tender &lt;номер&gt;</code> — Інформація про конкретний тендер\n' +
        '<code>/help</code> — Допомога',
      { parse_mode: 'HTML' },
    );
  }

  @Help()
  async onHelp(@Ctx() ctx: Context) {
    await ctx.reply(
      '<b>Як користуватися ботом:</b>\n\n' +
        '<b>/search</b> — Крок за кроком:\n' +
        '1. Введіть ЄДРПОУ компанії\n' +
        '2. Оберіть роль (замовник/підрядник)\n' +
        '3. Оберіть рік (2025/2026)\n' +
        '4. Введіть мінімальну суму\n' +
        '→ Результати з кнопками для аналізу\n\n' +
        '<b>/tender UA-2025-...</b> — Інфо про тендер\n' +
        '→ Кнопка для детального аналізу цін\n\n' +
        '🔍 <b>Аналіз</b> витягує ціни з PDF договорів\n' +
        'і порівнює з ринковими цінами.',
      { parse_mode: 'HTML' },
    );
  }

  @Command('search')
  async onSearch(@Ctx() ctx: Context) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    searchSessions.set(chatId, { step: 'edrpou' });
    await ctx.reply('🔍 Введіть ЄДРПОУ компанії (8 або 10 цифр):');
  }

  @Command('tender')
  async onTender(@Ctx() ctx: Context) {
    const message = ctx.message;
    if (!message || !('text' in message)) return;

    const parts = message.text.split(/\s+/);
    const tenderNumber = parts[1];

    if (!tenderNumber) {
      await ctx.reply('Використання: /tender <номер тендеру>\nНаприклад: /tender UA-2025-03-15-000456-a');
      return;
    }

    await ctx.reply('🔍 Шукаю тендер...');

    const tender = await this.searchService.findTenderByTenderId(tenderNumber);

    if (!tender) {
      await ctx.reply(`❌ Тендер ${tenderNumber} не знайдено в базі даних.`);
      return;
    }

    const text = this.telegramService.formatTenderDetails(tender);
    const keyboard = this.telegramService.buildTenderDetailKeyboard(tender.id);

    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }

  @On('text')
  async onText(@Ctx() ctx: Context) {
    const chatId = ctx.chat?.id;
    const message = ctx.message;
    if (!chatId || !message || !('text' in message)) return;

    const text = message.text.trim();

    // Ignore commands (they're handled by decorators)
    if (text.startsWith('/')) return;

    const session = searchSessions.get(chatId);
    if (!session) return; // No active search session

    switch (session.step) {
      case 'edrpou': {
        if (!/^\d{8}(\d{2})?$/.test(text)) {
          await ctx.reply('❌ ЄДРПОУ має бути 8 або 10 цифр. Спробуйте ще раз:');
          return;
        }
        session.edrpou = text;
        session.step = 'role';
        await ctx.reply(
          'Оберіть роль компанії:',
          Markup.inlineKeyboard([
            [
              Markup.button.callback('🏢 Замовник', 'role:customer'),
              Markup.button.callback('🔧 Підрядник', 'role:supplier'),
            ],
            [Markup.button.callback('📋 Обидва', 'role:both')],
          ]),
        );
        break;
      }

      case 'minPrice': {
        const price = parseFloat(text);
        if (isNaN(price) || price < 0) {
          await ctx.reply('❌ Введіть число >= 0. Спробуйте ще раз:');
          return;
        }
        session.minPrice = price;
        searchSessions.delete(chatId);
        await this.executeSearch(ctx, session as Required<Pick<SearchSession, 'edrpou' | 'role' | 'year' | 'minPrice'>> & SearchSession);
        break;
      }
    }
  }

  @Action(/^role:(.+)$/)
  async onRoleSelected(@Ctx() ctx: Context) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = searchSessions.get(chatId);
    if (!session || session.step !== 'role') return;

    const match = (ctx as any).match;
    const role = match?.[1] as 'customer' | 'supplier' | 'both';
    session.role = role;
    session.step = 'year';

    await ctx.answerCbQuery();
    await ctx.reply(
      'Оберіть рік:',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('2025', 'year:2025'),
          Markup.button.callback('2026', 'year:2026'),
        ],
        [Markup.button.callback('Обидва роки', 'year:both')],
      ]),
    );
  }

  @Action(/^year:(.+)$/)
  async onYearSelected(@Ctx() ctx: Context) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = searchSessions.get(chatId);
    if (!session || session.step !== 'year') return;

    const match = (ctx as any).match;
    const yearStr = match?.[1] as string;
    session.year = yearStr === 'both' ? null : parseInt(yearStr, 10);
    session.step = 'minPrice';

    await ctx.answerCbQuery();
    await ctx.reply('💰 Введіть мінімальну суму контракту (0 = без обмежень):');
  }

  @Action(/^page:(.+):(\d+)$/)
  async onPageNavigation(@Ctx() ctx: Context) {
    const match = (ctx as any).match;
    const searchKey = match?.[1] as string;
    const page = parseInt(match?.[2], 10);

    const cached = searchResultsCache.get(searchKey);
    if (!cached) {
      await ctx.answerCbQuery('Результати пошуку застаріли. Виконайте /search знову.');
      return;
    }

    await ctx.answerCbQuery();
    await this.showSearchPage(ctx, cached.tenderIds, page, searchKey);
  }

  @Action(/^analyze:(.+)$/)
  async onAnalyzeTender(@Ctx() ctx: Context) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const match = (ctx as any).match;
    const tenderId = match?.[1] as string;

    await ctx.answerCbQuery('Запускаю аналіз...');

    const statusMsg = await ctx.reply('⏳ Запускаю аналіз контрактів тендеру...');

    const result = await this.priceAnalysisService.triggerTenderAnalysis(
      tenderId,
      String(chatId),
      statusMsg.message_id,
    );

    if (result.count === 0) {
      await ctx.telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        undefined,
        '❌ Тендер не має контрактів для аналізу.',
      );
      return;
    }

    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      undefined,
      `⏳ Аналіз запущено: ${result.count} контракт(ів) у черзі.\nРезультати будуть надіслані коли аналіз завершиться.`,
    );

    // Start polling for completion
    this.pollForCompletion(ctx, tenderId, chatId, result.analysisIds);
  }

  @Action(/^analyze_all:(.+)$/)
  async onBulkAnalyze(@Ctx() ctx: Context) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const match = (ctx as any).match;
    const searchKey = match?.[1] as string;

    const cached = searchResultsCache.get(searchKey);
    if (!cached) {
      await ctx.answerCbQuery('Результати пошуку застаріли. Виконайте /search знову.');
      return;
    }

    await ctx.answerCbQuery('Запускаю масовий аналіз...');

    const result = await this.priceAnalysisService.triggerBulkAnalysis(
      cached.tenderIds,
      String(chatId),
    );

    await ctx.reply(
      `⏳ Масовий аналіз запущено:\n` +
        `📋 Тендерів: ${cached.tenderIds.length}\n` +
        `📄 Контрактів для аналізу: ${result.totalCount}\n\n` +
        `Результати будуть надіслані по мірі завершення.`,
    );

    // Poll for each tender
    for (const tenderId of cached.tenderIds) {
      this.pollForCompletion(ctx, tenderId, chatId, result.analysisIds);
    }
  }

  private async executeSearch(
    ctx: Context,
    params: { edrpou: string; role: 'customer' | 'supplier' | 'both'; year: number | null; minPrice: number },
  ) {
    await ctx.reply('🔍 Шукаю тендери...');

    const roles: Array<'customer' | 'supplier'> =
      params.role === 'both'
        ? ['customer', 'supplier']
        : [params.role];

    try {
      const result = await this.searchService.searchTenders({
        edrpou: params.edrpou,
        role: roles,
        year: params.year ?? undefined,
        priceFrom: params.minPrice > 0 ? params.minPrice : undefined,
        skip: 0,
        take: 100, // Fetch up to 100 tenders
      });

      if (result.total === 0) {
        await ctx.reply('Тендерів за заданими фільтрами не знайдено.');
        return;
      }

      // Cache results for pagination and bulk analysis
      const searchKey = `s_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const tenderIds = result.data.map((t: any) => t.id);
      searchResultsCache.set(searchKey, {
        tenderIds,
        chatId: String(ctx.chat!.id),
        createdAt: Date.now(),
      });

      const roleLabel =
        params.role === 'customer' ? 'замовник' :
        params.role === 'supplier' ? 'підрядник' : 'замовник+підрядник';

      await ctx.reply(
        `Знайдено <b>${result.total}</b> тендерів (${roleLabel}, ` +
          `${params.year || 'всі роки'}, від ${this.telegramService.formatAmount(params.minPrice)}):`,
        { parse_mode: 'HTML' },
      );

      await this.showSearchPage(ctx, tenderIds, 0, searchKey);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Search failed: ${err.message}`, err.stack);
      await ctx.reply('❌ Помилка при пошуку. Спробуйте пізніше.');
    }
  }

  private async showSearchPage(
    ctx: Context,
    tenderIds: string[],
    page: number,
    searchKey: string,
  ) {
    const totalPages = Math.ceil(tenderIds.length / RESULTS_PER_PAGE);
    const start = page * RESULTS_PER_PAGE;
    const pageIds = tenderIds.slice(start, start + RESULTS_PER_PAGE);

    // Fetch tender details for this page
    const tenders = await Promise.all(
      pageIds.map((id) =>
        this.searchService.findTenderByTenderId(id).then((t) => {
          if (t) return t;
          // Fallback: tender might not have tenderID, search by internal id
          return (this.searchService as any).prisma.tender.findUnique({
            where: { id },
            include: {
              contracts: {
                select: {
                  id: true,
                  contractID: true,
                  status: true,
                  amount: true,
                  supplierName: true,
                  supplierEdrpou: true,
                },
              },
            },
          });
        }),
      ),
    );

    const lines = tenders
      .filter(Boolean)
      .map((t: any, i: number) =>
        this.telegramService.formatTenderCard(t, start + i),
      );

    const text =
      lines.join('\n\n') +
      `\n\nСторінка ${page + 1}/${totalPages} (${tenderIds.length} тендерів)`;

    const keyboard = this.telegramService.buildSearchResultsKeyboard(
      tenders.filter(Boolean) as any[],
      page,
      totalPages,
      searchKey,
    );

    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }

  private pollForCompletion(
    ctx: Context,
    tenderId: string,
    chatId: number,
    analysisIds: string[],
  ) {
    const checkInterval = 15_000; // Check every 15 seconds
    const maxWait = 15 * 60 * 1000; // 15 minutes max
    const startTime = Date.now();

    const timer = setInterval(async () => {
      try {
        if (Date.now() - startTime > maxWait) {
          clearInterval(timer);
          await ctx.telegram.sendMessage(
            chatId,
            `⏰ Час очікування аналізу тендеру вичерпано. Перевірте результати пізніше.`,
          );
          return;
        }

        const allDone =
          await this.priceAnalysisService.getTenderAnalysisIfComplete(
            tenderId,
          );

        if (allDone) {
          clearInterval(timer);

          // Get tender info for the header
          const tender = await (this.searchService as any).prisma.tender.findUnique({
            where: { id: tenderId },
            select: { tenderID: true },
          });

          const tenderLabel = this.telegramService.escapeHtml(tender?.tenderID || tenderId);
          const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
          const viewUrl = `${appUrl}/price-analysis/view/${tenderId}`;

          const completed = allDone.filter((a) => a.status === 'COMPLETE');
          const failed = allDone.filter((a) => a.status === 'FAILED');
          const avgRisk = completed.length > 0
            ? completed.reduce((s, a) => s + (a.riskScore ?? 0), 0) / completed.length
            : null;
          const riskEmoji = avgRisk == null ? '⚪' : avgRisk >= 0.5 ? '🔴' : avgRisk >= 0.2 ? '⚠️' : '🟢';
          const totalAbove = completed.reduce((s, a) => s + (a.itemsAboveMarket ?? 0), 0);
          const totalItems = completed.reduce((s, a) => s + (a.totalItems ?? 0), 0);

          const lines = [
            `✅ <b>Аналіз завершено: ${tenderLabel}</b>`,
            '',
            `${riskEmoji} Ризик: <b>${avgRisk != null ? avgRisk.toFixed(2) : 'н/д'}</b>`,
            `📊 Позицій вище ринку >20%: <b>${totalAbove} з ${totalItems}</b>`,
            `📄 Контрактів проаналізовано: <b>${completed.length}</b>`,
            failed.length > 0 ? `❌ Не вдалося: <b>${failed.length}</b>` : null,
            '',
            `🔗 Детальний звіт:`,
            `<code>${viewUrl}</code>`,
          ].filter(Boolean).join('\n');

          await ctx.telegram.sendMessage(chatId, lines, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          });
        }
      } catch (error: unknown) {
        // Silently continue polling on errors
        this.logger.warn(`Poll error for tender ${tenderId}: ${error}`);
      }
    }, checkInterval);
  }
}
