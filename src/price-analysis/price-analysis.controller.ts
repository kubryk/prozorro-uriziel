import { Controller, Get, Param, NotFoundException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/api-key.guard';
import { PrismaService } from '../prisma/prisma.service';

function riskColor(score: number | null | undefined): string {
  if (score == null) return '#6b7280';
  if (score >= 0.5) return '#dc2626';
  if (score >= 0.2) return '#d97706';
  return '#16a34a';
}

function riskLabel(score: number | null | undefined): string {
  if (score == null) return 'Невідомо';
  if (score >= 0.5) return 'Високий ризик';
  if (score >= 0.2) return 'Середній ризик';
  return 'Низький ризик';
}

function deviationClass(dev: number | null | undefined): string {
  if (dev == null) return 'text-gray';
  if (dev > 0.3) return 'text-red';
  if (dev > 0.15) return 'text-yellow';
  return 'text-green';
}

function formatAmount(amount: number | null | undefined, currency = 'UAH'): string {
  if (amount == null) return 'н/д';
  return `${amount.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function escapeHtml(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(data: {
  tender: {
    tenderID?: string | null;
    title?: string | null;
    status?: string | null;
    amount?: number | null;
    currency?: string | null;
    customerName?: string | null;
    customerEdrpou?: string | null;
    procurementMethodType?: string | null;
    mainProcurementCategory?: string | null;
  };
  analyses: Array<{
    id: string;
    status: string;
    riskScore?: number | null;
    totalItems?: number | null;
    itemsAboveMarket?: number | null;
    errorMessage?: string | null;
    sourceDocumentTitle?: string | null;
    createdAt: Date;
    contract: {
      contractID?: string | null;
      contractNumber?: string | null;
      supplierName?: string | null;
      supplierEdrpou?: string | null;
      amount?: number | null;
      currency?: string | null;
      dateSigned?: Date | null;
    };
    extractedItems: Array<{
      itemName: string;
      unitPrice: number;
      quantity?: number | null;
      unit?: string | null;
      marketPrice?: number | null;
      marketPriceMin?: number | null;
      marketPriceMax?: number | null;
      marketSource?: string | null;
      priceDeviation?: number | null;
    }>;
  }>;
}): string {
  const { tender, analyses } = data;

  const overallRisk =
    analyses.length > 0
      ? analyses.reduce((sum, a) => sum + (a.riskScore ?? 0), 0) / analyses.length
      : null;

  const completedAnalyses = analyses.filter((a) => a.status === 'COMPLETE');
  const totalItemsAbove = completedAnalyses.reduce(
    (s, a) => s + (a.itemsAboveMarket ?? 0),
    0,
  );
  const totalItems = completedAnalyses.reduce(
    (s, a) => s + (a.totalItems ?? 0),
    0,
  );

  const analysisRows = analyses
    .map((analysis) => {
      const contractLabel =
        analysis.contract.contractID || analysis.contract.contractNumber || analysis.id;

      if (analysis.status !== 'COMPLETE') {
        const statusIcon =
          analysis.status === 'FAILED' ? '❌' : '⏳';
        return `
        <div class="contract-card error">
          <div class="contract-header">
            <span class="contract-id">${statusIcon} Контракт ${escapeHtml(contractLabel)}</span>
            <span class="supplier">${escapeHtml(analysis.contract.supplierName)}</span>
          </div>
          <p class="error-msg">${analysis.status === 'FAILED' ? escapeHtml(analysis.errorMessage) : 'Аналіз ще виконується...'}</p>
        </div>`;
      }

      const itemRows = analysis.extractedItems
        .map((item) => {
          const devPct =
            item.priceDeviation != null
              ? `${item.priceDeviation > 0 ? '+' : ''}${(item.priceDeviation * 100).toFixed(1)}%`
              : '—';
          const cls = deviationClass(item.priceDeviation);
          return `
            <tr class="${cls}-row">
              <td>${escapeHtml(item.itemName)}</td>
              <td class="num">${item.quantity != null ? item.quantity : '—'} ${escapeHtml(item.unit)}</td>
              <td class="num">${formatAmount(item.unitPrice)}</td>
              <td class="num">${item.marketPrice != null ? formatAmount(item.marketPrice) : '—'}</td>
              <td class="num ${cls}">${devPct}</td>
              <td class="source">${escapeHtml(item.marketSource)}</td>
            </tr>`;
        })
        .join('');

      const color = riskColor(analysis.riskScore);
      return `
      <div class="contract-card">
        <div class="contract-header">
          <div>
            <span class="contract-id">📄 Контракт ${escapeHtml(contractLabel)}</span>
            ${analysis.contract.contractNumber ? `<span class="contract-num"> №${escapeHtml(analysis.contract.contractNumber)}</span>` : ''}
          </div>
          <div class="contract-meta">
            <span class="supplier">${escapeHtml(analysis.contract.supplierName)}</span>
            ${analysis.contract.supplierEdrpou ? `<span class="edrpou">(${escapeHtml(analysis.contract.supplierEdrpou)})</span>` : ''}
          </div>
          <div class="contract-meta">
            <span>Сума: <b>${formatAmount(analysis.contract.amount, analysis.contract.currency ?? 'UAH')}</b></span>
            ${analysis.contract.dateSigned ? `<span> | Підписано: ${new Date(analysis.contract.dateSigned).toLocaleDateString('uk-UA')}</span>` : ''}
          </div>
        </div>
        <div class="risk-badge" style="background:${color}">
          ${riskLabel(analysis.riskScore)}: ${analysis.riskScore?.toFixed(2) ?? '—'}
        </div>
        <p class="stats">${analysis.itemsAboveMarket ?? 0} з ${analysis.totalItems ?? 0} позицій вище ринку на >20%</p>
        ${analysis.sourceDocumentTitle ? `<p class="doc-source">📎 Документ: ${escapeHtml(analysis.sourceDocumentTitle)}</p>` : ''}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Товар / послуга</th>
                <th>Кількість</th>
                <th>Ціна за од. (контракт)</th>
                <th>Ринкова ціна</th>
                <th>Відхилення</th>
                <th>Джерело</th>
              </tr>
            </thead>
            <tbody>${itemRows}</tbody>
          </table>
        </div>
      </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Аналіз цін — ${escapeHtml(tender.tenderID)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f1f5f9; color: #1e293b; }
    .page { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }

    /* Header */
    .header { background: #1e293b; color: #fff; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    .header h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 8px; }
    .header .meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 0.9rem; color: #94a3b8; margin-top: 12px; }
    .header .meta span { display: flex; align-items: center; gap: 4px; }

    /* Overall risk */
    .overall-risk { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
      background: #fff; border-radius: 12px; padding: 20px 24px; margin-bottom: 24px; border: 1px solid #e2e8f0; gap: 16px; }
    .risk-score { font-size: 2rem; font-weight: 800; }
    .risk-stats { display: flex; gap: 24px; flex-wrap: wrap; }
    .risk-stat { text-align: center; }
    .risk-stat .val { font-size: 1.5rem; font-weight: 700; }
    .risk-stat .lbl { font-size: 0.8rem; color: #64748b; }

    /* Contract cards */
    .contract-card { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 20px; border: 1px solid #e2e8f0; }
    .contract-card.error { border-color: #fca5a5; background: #fff7f7; }
    .contract-header { margin-bottom: 16px; }
    .contract-id { font-size: 1rem; font-weight: 700; }
    .contract-num { font-weight: 400; color: #64748b; }
    .supplier { font-size: 0.95rem; color: #334155; margin-top: 4px; display: block; }
    .edrpou { color: #94a3b8; font-size: 0.85rem; }
    .contract-meta { font-size: 0.85rem; color: #64748b; margin-top: 4px; }
    .risk-badge { display: inline-block; color: #fff; font-weight: 700; font-size: 0.85rem;
      padding: 4px 12px; border-radius: 20px; margin-bottom: 8px; }
    .stats { font-size: 0.9rem; color: #64748b; margin-bottom: 8px; }
    .doc-source { font-size: 0.8rem; color: #94a3b8; margin-bottom: 12px; }
    .error-msg { color: #dc2626; font-size: 0.9rem; }

    /* Table */
    .table-wrap { overflow-x: auto; margin-top: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { background: #f8fafc; font-weight: 600; text-align: left; padding: 10px 12px;
      border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
    td { padding: 9px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    .num { text-align: right; white-space: nowrap; }
    .source { font-size: 0.78rem; color: #94a3b8; max-width: 240px; }

    /* Row coloring */
    .text-red { color: #dc2626; font-weight: 700; }
    .text-red-row td { background: #fff5f5; }
    .text-yellow { color: #d97706; font-weight: 600; }
    .text-yellow-row td { background: #fffbeb; }
    .text-green { color: #16a34a; }
    .text-gray { color: #94a3b8; }

    /* Sections title */
    .section-title { font-size: 1.1rem; font-weight: 700; color: #1e293b; margin-bottom: 16px; }

    /* Footer */
    .footer { text-align: center; font-size: 0.8rem; color: #94a3b8; margin-top: 32px; padding-top: 16px;
      border-top: 1px solid #e2e8f0; }

    @media (max-width: 640px) {
      .overall-risk { flex-direction: column; }
      .risk-stats { gap: 12px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <h1>Аналіз цін тендеру ${escapeHtml(tender.tenderID || '—')}</h1>
      ${tender.title ? `<p style="color:#cbd5e1;margin-top:6px;">${escapeHtml(tender.title)}</p>` : ''}
      <div class="meta">
        ${tender.customerName ? `<span>🏢 ${escapeHtml(tender.customerName)}${tender.customerEdrpou ? ` (${escapeHtml(tender.customerEdrpou)})` : ''}</span>` : ''}
        ${tender.status ? `<span>📊 ${escapeHtml(tender.status)}</span>` : ''}
        ${tender.amount != null ? `<span>💰 ${formatAmount(tender.amount, tender.currency ?? 'UAH')}</span>` : ''}
        ${tender.procurementMethodType ? `<span>📋 ${escapeHtml(tender.procurementMethodType)}</span>` : ''}
      </div>
    </div>

    <div class="overall-risk">
      <div>
        <div style="font-size:0.85rem;color:#64748b;margin-bottom:4px;">Загальна оцінка ризику</div>
        <div class="risk-score" style="color:${riskColor(overallRisk)}">${riskLabel(overallRisk)} — ${overallRisk != null ? overallRisk.toFixed(2) : '—'}</div>
      </div>
      <div class="risk-stats">
        <div class="risk-stat">
          <div class="val">${analyses.length}</div>
          <div class="lbl">Контрактів</div>
        </div>
        <div class="risk-stat">
          <div class="val">${totalItems}</div>
          <div class="lbl">Позицій</div>
        </div>
        <div class="risk-stat" style="color:#dc2626">
          <div class="val">${totalItemsAbove}</div>
          <div class="lbl">Вище ринку >20%</div>
        </div>
      </div>
    </div>

    <div class="section-title">Аналіз контрактів (${analyses.length})</div>
    ${analysisRows}

    <div class="footer">Згенеровано системою Prozorro Track · ${new Date().toLocaleDateString('uk-UA')}</div>
  </div>
</body>
</html>`;
}

@Controller('price-analysis')
export class PriceAnalysisController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('view/:tenderId')
  async viewTenderAnalysis(
    @Param('tenderId') tenderId: string,
    @Res() res: Response,
  ): Promise<void> {
    const tender = await this.prisma.tender.findUnique({
      where: { id: tenderId },
      select: {
        tenderID: true,
        title: true,
        status: true,
        amount: true,
        currency: true,
        customerName: true,
        customerEdrpou: true,
        procurementMethodType: true,
        mainProcurementCategory: true,
      },
    });

    if (!tender) {
      throw new NotFoundException('Тендер не знайдено');
    }

    const analyses = await this.prisma.priceAnalysis.findMany({
      where: { contract: { tenderId } },
      include: {
        extractedItems: { orderBy: { priceDeviation: 'desc' } },
        contract: {
          select: {
            contractID: true,
            contractNumber: true,
            supplierName: true,
            supplierEdrpou: true,
            amount: true,
            currency: true,
            dateSigned: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Take the latest analysis per contract
    const latestByContract = new Map<string, (typeof analyses)[number]>();
    for (const a of analyses) {
      if (!latestByContract.has(a.contractId)) {
        latestByContract.set(a.contractId, a);
      }
    }

    const html = renderHtml({
      tender,
      analyses: [...latestByContract.values()],
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }
}
