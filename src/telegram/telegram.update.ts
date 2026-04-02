import { Update, Start, Help, Command, Ctx, On, Action } from 'nestjs-telegraf';
import { Logger } from '@nestjs/common';
import { Context, Markup } from 'telegraf';
import { SearchService } from '../search/search.service';
import { PriceAnalysisService } from '../price-analysis/price-analysis.service';
import {
  SkippedAnalysisContract,
  StartedAnalysisContract,
} from '../price-analysis/price-analysis.types';
import { TelegramService } from './telegram.service';

const RESULTS_PER_PAGE = 5;
const SEARCH_BATCH_SIZE = 100;

// In-memory session store for multi-step search flows
// Key: chatId, Value: current search state
interface SearchSession {
  step: 'edrpou' | 'role' | 'year' | 'status' | 'minPrice';
  edrpou?: string;
  role?: 'customer' | 'supplier' | 'both';
  year?: number | null;
  status?: string | null;
  minPrice?: number;
  stepMessageIds: number[];
}

interface SearchRequestParams {
  edrpou: string;
  role: 'customer' | 'supplier' | 'both';
  year: number | null;
  status: string | null;
  minPrice: number;
}

// Cache for search results (for pagination and bulk analysis)
// Key: searchKey, Value: search parameters + total
interface SearchCache {
  params: SearchRequestParams;
  total: number;
  relatedContractTotal: number;
  chatId: string;
  createdAt: number;
}

const searchSessions = new Map<number, SearchSession>();
const searchResultsCache = new Map<string, SearchCache>();

// Clean up old cache entries every 30 minutes
setInterval(
  () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [key, value] of searchResultsCache) {
      if (value.createdAt < cutoff) searchResultsCache.delete(key);
    }
  },
  30 * 60 * 1000,
);

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    private readonly searchService: SearchService,
    private readonly priceAnalysisService: PriceAnalysisService,
    private readonly telegramService: TelegramService,
  ) {}

  private buildProzorroContractUrl(
    contractPublicId?: string | null,
  ): string | null {
    if (!contractPublicId) {
      return null;
    }

    return `https://prozorro.gov.ua/uk/contract/${encodeURIComponent(contractPublicId)}`;
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, maxLength - 1).trimEnd()}…`;
  }

  private formatTenderTitle(title?: string | null): string | null {
    const normalized = title?.trim();
    if (!normalized) {
      return null;
    }

    return this.telegramService.escapeHtml(this.truncateText(normalized, 100));
  }

  private joinMessageLines(lines: Array<string | null | undefined>): string {
    return lines
      .filter((line): line is string => line !== null && line !== undefined)
      .join('\n');
  }

  private formatSkippedContracts(
    skippedContracts: SkippedAnalysisContract[],
    options?: {
      includeTenderId?: boolean;
    },
  ): string {
    if (skippedContracts.length === 0) {
      return '';
    }

    const includeTenderId = options?.includeTenderId ?? false;

    const preview = skippedContracts.slice(0, 5).map((contract) => {
      const contractLabel =
        contract.contractID || contract.contractNumber || contract.contractId;
      const contractUrl = this.buildProzorroContractUrl(contract.contractID);
      const tenderPrefix =
        includeTenderId && contract.tenderId
          ? `${this.telegramService.escapeHtml(contract.tenderId)} / `
          : '';
      const safeLabel = this.telegramService.escapeHtml(contractLabel);
      const renderedLabel = contractUrl
        ? `<a href="${contractUrl}">${safeLabel}</a>`
        : safeLabel;

      return `• ${tenderPrefix}${renderedLabel}`;
    });

    if (skippedContracts.length > preview.length) {
      preview.push(
        `• Ще ${skippedContracts.length - preview.length} контракт(ів) пропущено`,
      );
    }

    return preview.join('\n');
  }

  private formatTenderAnalysisContracts(
    startedContracts: StartedAnalysisContract[],
    skippedContracts: SkippedAnalysisContract[],
  ): string {
    const previewLimit = 12;
    const entries = [
      ...startedContracts.map((contract) => ({
        kind: 'STARTED' as const,
        contractId: contract.contractId,
        contractID: contract.contractID,
        contractNumber: contract.contractNumber,
      })),
      ...skippedContracts.map((contract) => ({
        kind: 'SKIPPED' as const,
        contractId: contract.contractId,
        contractID: contract.contractID,
        contractNumber: contract.contractNumber,
      })),
    ];

    if (entries.length === 0) {
      return '';
    }

    const preview = entries.slice(0, previewLimit).map((entry) => {
      const contractLabel =
        entry.contractID || entry.contractNumber || entry.contractId;
      const contractUrl = this.buildProzorroContractUrl(entry.contractID);
      const safeLabel = this.telegramService.escapeHtml(contractLabel);
      const renderedLabel = contractUrl
        ? `<a href="${contractUrl}">${safeLabel}</a>`
        : safeLabel;
      const emoji = entry.kind === 'SKIPPED' ? '⏭️' : '⏳';

      return `${emoji} ${renderedLabel}`;
    });

    if (entries.length > preview.length) {
      preview.push(
        `• Ще ${entries.length - preview.length} контракт(ів) у списку`,
      );
    }

    return preview.join('\n');
  }

  private formatCompletedTenderAnalysisContracts(analyses: any[]): string {
    const previewLimit = 12;

    if (analyses.length === 0) {
      return '';
    }

    const preview = analyses.slice(0, previewLimit).map((analysis) => {
      const contractLabel =
        analysis.contract?.contractID || analysis.contractId || 'Контракт';
      const contractUrl = this.buildProzorroContractUrl(
        analysis.contract?.contractID,
      );
      const safeLabel = this.telegramService.escapeHtml(contractLabel);
      const renderedLabel = contractUrl
        ? `<a href="${contractUrl}">${safeLabel}</a>`
        : safeLabel;

      if (analysis.status === 'COMPLETE') {
        return `✅ ${renderedLabel}`;
      }

      if (analysis.status === 'FAILED') {
        return `❌ ${renderedLabel}`;
      }

      return `⏭️ ${renderedLabel}`;
    });

    if (analyses.length > preview.length) {
      preview.push(
        `• Ще ${analyses.length - preview.length} контракт(ів) у списку`,
      );
    }

    return preview.join('\n');
  }

  private buildTenderAnalysisLaunchMessage(params: {
    tenderLabel: string;
    tenderTitle?: string | null;
    tenderUrl?: string | null;
    contractsText?: string;
    viewUrl: string;
    noContractsText?: string;
  }): string {
    const {
      tenderLabel,
      tenderTitle,
      tenderUrl,
      contractsText,
      viewUrl,
      noContractsText,
    } = params;
    const tenderLabelHtml = this.telegramService.escapeHtml(tenderLabel);
    const renderedTenderLabel = tenderUrl
      ? `<a href="${tenderUrl}">${tenderLabelHtml}</a>`
      : tenderLabelHtml;
    const renderedTenderTitle = this.formatTenderTitle(tenderTitle);
    const lines = [
      '⏳ Аналіз контрактів тендеру',
      `📋 Тендер: ${renderedTenderLabel}`,
      renderedTenderTitle ? `   ${renderedTenderTitle}` : null,
    ];

    if (contractsText) {
      lines.push('', 'Контракти:', contractsText);
    } else if (noContractsText) {
      lines.push('', this.telegramService.escapeHtml(noContractsText));
    }

    lines.push('', '🔗 Детальний звіт:', viewUrl);

    return this.joinMessageLines(lines);
  }

  private buildTenderAnalysisCompletionMessage(params: {
    tenderLabel: string;
    tenderTitle?: string | null;
    tenderUrl?: string | null;
    contractsText?: string;
    viewUrl: string;
  }): string {
    const { tenderLabel, tenderTitle, tenderUrl, contractsText, viewUrl } =
      params;
    const tenderLabelHtml = this.telegramService.escapeHtml(tenderLabel);
    const renderedTenderLabel = tenderUrl
      ? `<a href="${tenderUrl}">${tenderLabelHtml}</a>`
      : tenderLabelHtml;
    const renderedTenderTitle = this.formatTenderTitle(tenderTitle);
    const lines = [
      '✅ Аналіз контрактів завершено',
      `📋 Тендер: ${renderedTenderLabel}`,
      renderedTenderTitle ? `   ${renderedTenderTitle}` : null,
    ];

    if (contractsText) {
      lines.push('', 'Контракти:', contractsText);
    }

    lines.push('', '🔗 Детальний звіт:', viewUrl);

    return this.joinMessageLines(lines);
  }

  private buildTenderAnalysisTimeoutMessage(params: {
    tenderLabel: string;
    tenderTitle?: string | null;
    tenderUrl?: string | null;
    viewUrl: string;
  }): string {
    const tenderLabelHtml = this.telegramService.escapeHtml(params.tenderLabel);
    const renderedTenderLabel = params.tenderUrl
      ? `<a href="${params.tenderUrl}">${tenderLabelHtml}</a>`
      : tenderLabelHtml;
    const renderedTenderTitle = this.formatTenderTitle(params.tenderTitle);

    return this.joinMessageLines([
      '⏰ Аналіз ще не завершився',
      `📋 Тендер: ${renderedTenderLabel}`,
      renderedTenderTitle ? `   ${renderedTenderTitle}` : null,
      'Перевірте детальний звіт пізніше.',
      '',
      '🔗 Детальний звіт:',
      params.viewUrl,
    ]);
  }

  private buildTenderSearchQuery(
    params: SearchRequestParams,
    skip: number,
    take: number,
  ) {
    const roles: Array<'customer' | 'supplier'> =
      params.role === 'both' ? ['customer', 'supplier'] : [params.role];

    return {
      edrpou: params.edrpou,
      role: roles,
      year: params.year ?? undefined,
      status: params.status ?? undefined,
      priceFrom: params.minPrice > 0 ? params.minPrice : undefined,
      skip,
      take,
    };
  }

  private async fetchAllTenderIds(
    params: SearchRequestParams,
  ): Promise<string[]> {
    const tenderIds: string[] = [];
    let skip = 0;
    let total = 0;

    do {
      const result = await this.searchService.searchTenders({
        ...this.buildTenderSearchQuery(params, skip, SEARCH_BATCH_SIZE),
        includeTotals: skip === 0,
      });

      if (skip === 0) {
        total = result.total;
      }

      tenderIds.push(...result.data.map((t) => t.id));
      skip += result.data.length;

      if (result.data.length === 0) {
        break;
      }
    } while (skip < total);

    return tenderIds;
  }

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

    searchSessions.set(chatId, { step: 'edrpou', stepMessageIds: [] });
    const msg = await ctx.reply('🔍 Введіть ЄДРПОУ компанії (8 або 10 цифр):');
    searchSessions.get(chatId)!.stepMessageIds.push(msg.message_id);
  }

  @Command('tender')
  async onTender(@Ctx() ctx: Context) {
    const message = ctx.message;
    if (!message || !('text' in message)) return;

    const parts = message.text.split(/\s+/);
    const tenderNumber = parts[1];

    if (!tenderNumber) {
      await ctx.reply(
        'Використання: /tender <номер тендеру>\nНаприклад: /tender UA-2025-03-15-000456-a',
      );
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
          await ctx.reply(
            '❌ ЄДРПОУ має бути 8 або 10 цифр. Спробуйте ще раз:',
          );
          return;
        }
        session.edrpou = text;
        session.step = 'role';
        const roleMsg = await ctx.reply(
          'Оберіть роль компанії:',
          Markup.inlineKeyboard([
            [
              Markup.button.callback('🏢 Замовник', 'role:customer'),
              Markup.button.callback('🔧 Підрядник', 'role:supplier'),
            ],
            [Markup.button.callback('📋 Обидва', 'role:both')],
          ]),
        );
        session.stepMessageIds.push(roleMsg.message_id);
        break;
      }

      case 'minPrice': {
        const price = parseFloat(text);
        if (isNaN(price) || price < 0) {
          await ctx.reply('❌ Введіть число >= 0. Спробуйте ще раз:');
          return;
        }
        session.minPrice = price;
        const stepMessageIds = [...session.stepMessageIds];
        searchSessions.delete(chatId);
        await this.executeSearch(
          ctx,
          session as Required<
            Pick<
              SearchSession,
              'edrpou' | 'role' | 'year' | 'status' | 'minPrice'
            >
          > &
            SearchSession,
          stepMessageIds,
        );
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
    const yearMsg = await ctx.reply(
      'Оберіть рік:',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('2025', 'year:2025'),
          Markup.button.callback('2026', 'year:2026'),
        ],
        [Markup.button.callback('Обидва роки', 'year:both')],
      ]),
    );
    session.stepMessageIds.push(yearMsg.message_id);
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
    session.step = 'status';

    await ctx.answerCbQuery();
    const statusMsg = await ctx.reply(
      'Оберіть статус тендеру:',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Завершений', 'status:complete'),
          Markup.button.callback('🟢 Активний', 'status:active'),
        ],
        [
          Markup.button.callback('❌ Скасований', 'status:cancelled'),
          Markup.button.callback('📋 Всі статуси', 'status:all'),
        ],
      ]),
    );
    session.stepMessageIds.push(statusMsg.message_id);
  }

  @Action(/^status:(.+)$/)
  async onStatusSelected(@Ctx() ctx: Context) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = searchSessions.get(chatId);
    if (!session || session.step !== 'status') return;

    const match = (ctx as any).match;
    const statusStr = match?.[1] as string;
    session.status = statusStr === 'all' ? null : statusStr;
    session.step = 'minPrice';

    await ctx.answerCbQuery();
    const priceMsg = await ctx.reply(
      '💰 Введіть мінімальну суму контракту (0 = без обмежень):',
    );
    session.stepMessageIds.push(priceMsg.message_id);
  }

  @Action(/^page:(.+):(\d+)$/)
  async onPageNavigation(@Ctx() ctx: Context) {
    const match = (ctx as any).match;
    const searchKey = match?.[1] as string;
    const page = parseInt(match?.[2], 10);

    const cached = searchResultsCache.get(searchKey);
    if (!cached) {
      await ctx.answerCbQuery(
        'Результати пошуку застаріли. Виконайте /search знову.',
      );
      return;
    }

    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => null);
    await this.showSearchPage(ctx, cached, page, searchKey);
  }

  @Action(/^analyze:(.+)$/)
  async onAnalyzeTender(@Ctx() ctx: Context) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const match = (ctx as any).match;
    const tenderId = match?.[1] as string;

    await ctx.answerCbQuery('Запускаю аналіз...');

    const statusMsg = await ctx.reply(
      '⏳ Запускаю аналіз контрактів тендеру...',
    );

    const result = await this.priceAnalysisService.triggerTenderAnalysis(
      tenderId,
      String(chatId),
      statusMsg.message_id,
    );
    const tender = await (this.searchService as any).prisma.tender.findUnique({
      where: { id: tenderId },
      select: { tenderID: true, title: true },
    });
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(
      /\/$/,
      '',
    );
    const runParam = result.analysisIds.length > 0
      ? `?run=${result.analysisIds.join(',')}`
      : '';
    const viewUrl = `${appUrl}/price-analysis/view/${tenderId}${runParam}`;
    const tenderLabel = tender?.tenderID || tenderId;
    const tenderUrl = tender?.tenderID
      ? `https://prozorro.gov.ua/tender/${encodeURIComponent(tender.tenderID)}`
      : null;
    const contractsText = this.formatTenderAnalysisContracts(
      result.startedContracts,
      result.skippedContracts,
    );
    const launchMessage = this.buildTenderAnalysisLaunchMessage({
      tenderLabel,
      tenderTitle: tender?.title,
      tenderUrl,
      contractsText: contractsText.length > 0 ? contractsText : undefined,
      viewUrl,
      noContractsText:
        result.skippedContracts.length === 0
          ? 'Тендер не має контрактів для аналізу.'
          : undefined,
    });

    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      undefined,
      launchMessage,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      },
    );

    // Start polling for completion
    if (result.analysisIds.length > 0) {
      this.pollForCompletion(ctx, tenderId, chatId, statusMsg.message_id, result.analysisIds);
    }
  }

  @Action(/^analyze_all:(.+)$/)
  async onBulkAnalyze(@Ctx() ctx: Context) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const match = (ctx as any).match;
    const searchKey = match?.[1] as string;

    const cached = searchResultsCache.get(searchKey);
    if (!cached) {
      await ctx.answerCbQuery(
        'Результати пошуку застаріли. Виконайте /search знову.',
      );
      return;
    }

    await ctx.answerCbQuery('Запускаю масовий аналіз...');

    const tenderIds = await this.fetchAllTenderIds(cached.params);

    const result = await this.priceAnalysisService.triggerBulkAnalysis(
      tenderIds,
      String(chatId),
    );

    const skippedText =
      result.skippedContracts.length > 0
        ? `\n\n⚠️ Пропущено: ${result.skippedContracts.length}\n${this.formatSkippedContracts(result.skippedContracts, { includeTenderId: true })}`
        : '';

    if (result.totalCount === 0) {
      await ctx.reply(
        result.skippedContracts.length > 0
          ? `⚠️ Масовий аналіз не запущено: серед вибраних тендерів немає контрактів, придатних для аналізу.${skippedText}`
          : '❌ Не знайдено контрактів для аналізу.',
      );
      return;
    }

    await ctx.reply(
      `⏳ Масовий аналіз запущено:\n` +
        `📋 Тендерів: ${tenderIds.length}\n` +
        `📄 Контрактів для аналізу: ${result.totalCount}\n\n` +
        `Результати будуть надіслані по мірі завершення.${skippedText}`,
    );

    // Poll for each tender
    for (const tenderId of result.startedTenderIds) {
      this.pollForCompletion(ctx, tenderId, chatId);
    }
  }

  private async executeSearch(
    ctx: Context,
    params: SearchRequestParams,
    stepMessageIds: number[] = [],
  ) {
    // Delete all step messages before showing results
    await Promise.all(
      stepMessageIds.map((id) => ctx.deleteMessage(id).catch(() => null)),
    );

    await ctx.reply('🔍 Шукаю тендери...');

    try {
      const result = await this.searchService.searchTenders(
        this.buildTenderSearchQuery(params, 0, RESULTS_PER_PAGE),
      );

      if (result.total === 0) {
        await ctx.reply('Тендерів за заданими фільтрами не знайдено.');
        return;
      }

      // Cache results for pagination and bulk analysis
      const searchKey = `s_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      searchResultsCache.set(searchKey, {
        params,
        total: result.total,
        relatedContractTotal: result.relatedContractTotal,
        chatId: String(ctx.chat!.id),
        createdAt: Date.now(),
      });

      const roleLabel =
        params.role === 'customer'
          ? 'замовник'
          : params.role === 'supplier'
            ? 'підрядник'
            : 'замовник+підрядник';
      const statusLabel =
        params.status === 'complete'
          ? 'завершені'
          : params.status === 'active'
            ? 'активні'
            : params.status === 'cancelled'
              ? 'скасовані'
              : 'всі статуси';

      await ctx.reply(
        `🔎 <b>${result.total}</b> тендерів\n` +
          `📄 <b>${result.relatedContractTotal}</b> контрактів\n` +
          `Фільтри: <code>${params.edrpou}</code>, ${roleLabel}, ${params.year || 'всі роки'}, ${statusLabel}, від ${this.telegramService.formatAmount(params.minPrice)}`,
        { parse_mode: 'HTML' },
      );

      await this.showSearchPage(
        ctx,
        searchResultsCache.get(searchKey)!,
        0,
        searchKey,
        result.data,
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Search failed: ${err.message}`, err.stack);
      await ctx.reply('❌ Помилка при пошуку. Спробуйте пізніше.');
    }
  }

  private async showSearchPage(
    ctx: Context,
    cache: SearchCache,
    page: number,
    searchKey: string,
    prefetchedTenders?: any[],
  ) {
    const totalPages = Math.ceil(cache.total / RESULTS_PER_PAGE);
    const start = page * RESULTS_PER_PAGE;
    const tenders =
      prefetchedTenders ??
      (
        await this.searchService.searchTenders({
          ...this.buildTenderSearchQuery(cache.params, start, RESULTS_PER_PAGE),
          includeTotals: false,
        })
      ).data;

    const lines = tenders.map((t: any, i: number) =>
      this.telegramService.formatTenderCard(t, start + i),
    );

    const text =
      lines.join('\n\n') +
      `\n\nСторінка ${page + 1}/${totalPages} (${cache.total} тендерів, ${cache.relatedContractTotal} контрактів)`;

    const keyboard = this.telegramService.buildSearchResultsKeyboard(
      tenders,
      page,
      totalPages,
      searchKey,
      start,
    );

    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }

  private pollForCompletion(
    ctx: Context,
    tenderId: string,
    chatId: number,
    messageId?: number,
    analysisIds: string[] = [],
  ) {
    const checkInterval = 15_000; // Check every 15 seconds
    const maxWait = 15 * 60 * 1000; // 15 minutes max
    const startTime = Date.now();

    const timer = setInterval(async () => {
      try {
        if (Date.now() - startTime > maxWait) {
          clearInterval(timer);
          const tender = await (
            this.searchService as any
          ).prisma.tender.findUnique({
            where: { id: tenderId },
            select: { tenderID: true, title: true },
          });
          const tenderLabel = tender?.tenderID || tenderId;
          const tenderUrl = tender?.tenderID
            ? `https://prozorro.gov.ua/tender/${encodeURIComponent(tender.tenderID)}`
            : null;
          const appUrl = (
            process.env.APP_URL || 'http://localhost:3000'
          ).replace(/\/$/, '');
          const viewUrl = `${appUrl}/price-analysis/view/${tenderId}?run=${analysisIds.join(',')}`;

          const timeoutMessage = this.buildTenderAnalysisTimeoutMessage({
            tenderLabel,
            tenderTitle: tender?.title,
            tenderUrl,
            viewUrl,
          });

          if (messageId != null) {
            await ctx.telegram.editMessageText(
              chatId,
              messageId,
              undefined,
              timeoutMessage,
              {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
              },
            );
          } else {
            await ctx.telegram.sendMessage(chatId, timeoutMessage, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            });
          }
          return;
        }

        const allDone =
          await this.priceAnalysisService.getTenderAnalysisIfComplete(tenderId);

        if (allDone) {
          clearInterval(timer);

          // Get tender info for the header
          const tender = await (
            this.searchService as any
          ).prisma.tender.findUnique({
            where: { id: tenderId },
            select: { tenderID: true, title: true },
          });

          const tenderLabel = tender?.tenderID || tenderId;
          const tenderUrl = tender?.tenderID
            ? `https://prozorro.gov.ua/tender/${encodeURIComponent(tender.tenderID)}`
            : null;
          const appUrl = (
            process.env.APP_URL || 'http://localhost:3000'
          ).replace(/\/$/, '');
          const runParam = analysisIds.length > 0
            ? `?run=${analysisIds.join(',')}`
            : '';
          const viewUrl = `${appUrl}/price-analysis/view/${tenderId}${runParam}`;

          const contractsText =
            this.formatCompletedTenderAnalysisContracts(allDone);

          const completionMessage = this.buildTenderAnalysisCompletionMessage({
            tenderLabel,
            tenderTitle: tender?.title,
            tenderUrl,
            contractsText: contractsText.length > 0 ? contractsText : undefined,
            viewUrl,
          });

          const reanalyzeKeyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback(
                '🔄 Аналізувати знову',
                `analyze:${tenderId}`,
              ),
            ],
          ]);

          if (messageId != null) {
            await ctx.telegram.editMessageText(
              chatId,
              messageId,
              undefined,
              completionMessage,
              {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
                ...reanalyzeKeyboard,
              },
            );
          } else {
            await ctx.telegram.sendMessage(chatId, completionMessage, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              ...reanalyzeKeyboard,
            });
          }
        }
      } catch (error: unknown) {
        // Silently continue polling on errors
        this.logger.warn(`Poll error for tender ${tenderId}: ${error}`);
      }
    }, checkInterval);
  }
}
