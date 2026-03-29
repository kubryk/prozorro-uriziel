import { Injectable } from '@nestjs/common';
import { Markup } from 'telegraf';

interface TenderForDisplay {
  id: string;
  tenderID?: string | null;
  title?: string | null;
  status?: string | null;
  amount?: number | null;
  currency?: string | null;
  customerName?: string | null;
  customerEdrpou?: string | null;
  mainProcurementCategory?: string | null;
  procurementMethodType?: string | null;
  contracts?: Array<{
    id: string;
    contractID?: string | null;
    status?: string | null;
    amount?: number | null;
    supplierName?: string | null;
    supplierEdrpou?: string | null;
  }>;
}

interface AnalysisItemForDisplay {
  itemName: string;
  unitPrice: number;
  quantity?: number | null;
  unit?: string | null;
  marketPrice?: number | null;
  priceDeviation?: number | null;
}

interface AnalysisForDisplay {
  id: string;
  status: string;
  riskScore?: number | null;
  totalItems?: number | null;
  itemsAboveMarket?: number | null;
  errorMessage?: string | null;
  contract?: {
    contractID?: string | null;
    supplierName?: string | null;
    amount?: number | null;
  } | null;
  extractedItems?: AnalysisItemForDisplay[];
}

@Injectable()
export class TelegramService {
  formatAmount(amount: number | null | undefined, currency?: string | null): string {
    if (amount == null) return 'н/д';
    const formatted = amount.toLocaleString('uk-UA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${formatted} ${currency || 'UAH'}`;
  }

  formatTenderCard(tender: TenderForDisplay, index?: number): string {
    const prefix = index != null ? `${index + 1}. ` : '';
    const contractCount = tender.contracts?.length || 0;

    return [
      `${prefix}📋 <b>${this.escapeHtml(tender.tenderID || tender.id)}</b>`,
      tender.title ? `   ${this.escapeHtml(this.truncate(tender.title, 80))}` : null,
      `   💰 ${this.formatAmount(tender.amount, tender.currency)} | 📊 ${tender.status || 'н/д'}`,
      tender.customerName
        ? `   🏢 ${this.escapeHtml(tender.customerName)}`
        : null,
      `   📄 Контрактів: ${contractCount}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  formatTenderDetails(tender: TenderForDisplay): string {
    const lines = [
      `📋 <b>Тендер ${this.escapeHtml(tender.tenderID || tender.id)}</b>\n`,
      tender.title ? `📝 ${this.escapeHtml(tender.title)}\n` : null,
      `🏢 Замовник: ${this.escapeHtml(tender.customerName || 'н/д')} (${tender.customerEdrpou || 'н/д'})`,
      `💰 Сума: ${this.formatAmount(tender.amount, tender.currency)}`,
      `📊 Статус: ${tender.status || 'н/д'}`,
      tender.procurementMethodType
        ? `📋 Метод: ${tender.procurementMethodType}`
        : null,
      tender.mainProcurementCategory
        ? `📦 Категорія: ${tender.mainProcurementCategory}`
        : null,
    ];

    if (tender.contracts && tender.contracts.length > 0) {
      lines.push('\n<b>Контракти:</b>');
      for (const c of tender.contracts) {
        lines.push(
          `  📄 ${this.escapeHtml(c.contractID || c.id)}: ${this.formatAmount(c.amount)} — ${this.escapeHtml(c.supplierName || 'н/д')}`,
        );
      }
    }

    return lines.filter(Boolean).join('\n');
  }

  formatAnalysisResult(analyses: AnalysisForDisplay[]): string {
    const lines: string[] = [];

    for (const a of analyses) {
      const riskEmoji = this.riskEmoji(a.riskScore);
      const contractLabel = a.contract?.contractID || 'Контракт';
      const supplierLabel = a.contract?.supplierName || '';

      if (a.status === 'FAILED') {
        lines.push(
          `\n📄 ${this.escapeHtml(contractLabel)} (${this.escapeHtml(supplierLabel)}) — ❌ Помилка`,
          `   ${this.escapeHtml(a.errorMessage || 'Невідома помилка')}`,
        );
        continue;
      }

      if (a.status !== 'COMPLETE') {
        lines.push(
          `\n📄 ${this.escapeHtml(contractLabel)} — ⏳ ${a.status}`,
        );
        continue;
      }

      lines.push(
        `\n📄 <b>${this.escapeHtml(contractLabel)}</b> (${this.escapeHtml(supplierLabel)}) — ${riskEmoji} Ризик: ${a.riskScore?.toFixed(2) ?? 'н/д'}`,
      );

      if (a.extractedItems && a.extractedItems.length > 0) {
        for (const item of a.extractedItems.slice(0, 10)) {
          const devPercent =
            item.priceDeviation != null
              ? `${item.priceDeviation > 0 ? '+' : ''}${(item.priceDeviation * 100).toFixed(0)}%`
              : '';
          const itemEmoji = this.deviationEmoji(item.priceDeviation);

          if (item.marketPrice != null) {
            lines.push(
              `   ${itemEmoji} ${this.escapeHtml(this.truncate(item.itemName, 40))}: ${item.unitPrice.toFixed(2)} UAH (ринок: ${item.marketPrice.toFixed(2)} UAH) ${devPercent}`,
            );
          } else {
            lines.push(
              `   ⚪ ${this.escapeHtml(this.truncate(item.itemName, 40))}: ${item.unitPrice.toFixed(2)} UAH (ринок: н/д)`,
            );
          }
        }

        if (a.extractedItems.length > 10) {
          lines.push(
            `   ... ще ${a.extractedItems.length - 10} позицій`,
          );
        }
      }
    }

    // Summary
    const completed = analyses.filter((a) => a.status === 'COMPLETE');
    if (completed.length > 0) {
      const avgRisk =
        completed.reduce((sum, a) => sum + (a.riskScore || 0), 0) /
        completed.length;
      const totalAbove = completed.reduce(
        (sum, a) => sum + (a.itemsAboveMarket || 0),
        0,
      );
      const totalItems = completed.reduce(
        (sum, a) => sum + (a.totalItems || 0),
        0,
      );

      lines.push(
        `\n<b>Загальний ризик:</b> ${this.riskEmoji(avgRisk)} ${avgRisk.toFixed(2)}`,
        `<b>Завищення:</b> ${totalAbove} з ${totalItems} позицій вище ринку на >20%`,
      );
    }

    return lines.join('\n');
  }

  buildSearchResultsKeyboard(
    tenders: Array<{ id: string; tenderID?: string | null }>,
    currentPage: number,
    totalPages: number,
    searchKey: string,
  ) {
    const buttons: any[][] = [];

    // Analysis buttons for each tender on this page
    for (const tender of tenders) {
      buttons.push([
        Markup.button.callback(
          `🔍 Аналіз ${tender.tenderID || tender.id}`,
          `analyze:${tender.id}`,
        ),
      ]);
    }

    // Navigation row
    const navRow: any[] = [];
    if (currentPage > 0) {
      navRow.push(
        Markup.button.callback('◀ Назад', `page:${searchKey}:${currentPage - 1}`),
      );
    }
    if (currentPage < totalPages - 1) {
      navRow.push(
        Markup.button.callback('▶ Далі', `page:${searchKey}:${currentPage + 1}`),
      );
    }
    if (navRow.length > 0) buttons.push(navRow);

    // Bulk analysis button
    buttons.push([
      Markup.button.callback(
        `🔍 Масовий аналіз всіх`,
        `analyze_all:${searchKey}`,
      ),
    ]);

    return Markup.inlineKeyboard(buttons);
  }

  buildTenderDetailKeyboard(tenderId: string) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Детальний аналіз', `analyze:${tenderId}`)],
    ]);
  }

  private riskEmoji(score: number | null | undefined): string {
    if (score == null) return '⚪';
    if (score >= 0.5) return '🔴';
    if (score >= 0.2) return '⚠️';
    return '🟢';
  }

  private deviationEmoji(deviation: number | null | undefined): string {
    if (deviation == null) return '⚪';
    if (deviation > 0.3) return '🔴';
    if (deviation > 0.15) return '🟡';
    return '🟢';
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 1) + '…';
  }

  escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
