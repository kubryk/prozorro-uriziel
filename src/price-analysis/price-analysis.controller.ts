import { Controller, Get, Param, NotFoundException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/api-key.guard';
import { PrismaService } from '../prisma/prisma.service';
import { buildFinalContractAnalysis } from './final-contract-analysis';

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

function formatAmount(
  amount: number | null | undefined,
  currency = 'UAH',
): string {
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
    sourceDocumentUrl?: string | null;
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
  const prozorroTenderUrl = tender.tenderID
    ? `https://prozorro.gov.ua/tender/${encodeURIComponent(tender.tenderID)}`
    : null;

  const overallRisk =
    analyses.length > 0
      ? analyses.reduce((sum, a) => sum + (a.riskScore ?? 0), 0) /
        analyses.length
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
        analysis.contract.contractID ||
        analysis.contract.contractNumber ||
        analysis.id;
      const links: string[] = [];
      if (prozorroTenderUrl) {
        links.push(
          `<a href="${prozorroTenderUrl}" target="_blank" class="chip-link">Тендер на Prozorro</a>`,
        );
      }
      if (analysis.contract.contractID) {
        const contractDocsUrl = `https://prozorro.gov.ua/tender/${encodeURIComponent(tender.tenderID || '')}?tab=contracts`;
        links.push(
          `<a href="${contractDocsUrl}" target="_blank" class="chip-link">Контракт на Prozorro</a>`,
        );
      }
      if (analysis.sourceDocumentUrl) {
        links.push(
          `<a href="${escapeHtml(analysis.sourceDocumentUrl)}" target="_blank" class="chip-link chip-link--doc">Проаналізований документ</a>`,
        );
      }

      if (analysis.status !== 'COMPLETE') {
        const statusIcon =
          analysis.status === 'FAILED'
            ? '❌'
            : analysis.status === 'SKIPPED'
              ? '⏭️'
              : '⏳';
        const statusMessage =
          analysis.status === 'FAILED' || analysis.status === 'SKIPPED'
            ? escapeHtml(analysis.errorMessage)
            : 'Аналіз ще виконується...';
        return `
        <div class="contract-card error">
          <div class="contract-header">
            <span class="contract-id">${statusIcon} Контракт ${escapeHtml(contractLabel)}</span>
            <span class="supplier">${escapeHtml(analysis.contract.supplierName)}</span>
          </div>
          ${links.length > 0 ? `<div class="links-row">${links.join('')}</div>` : ''}
          ${analysis.sourceDocumentTitle ? `<div class="doc-badge">${escapeHtml(analysis.sourceDocumentTitle)}</div>` : ''}
          <p class="error-msg">${statusMessage}</p>
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
      const finalAnalysis = buildFinalContractAnalysis({
        contractAmount: analysis.contract.amount,
        currency: analysis.contract.currency,
        totalItems: analysis.totalItems,
        itemsAboveMarket: analysis.itemsAboveMarket,
        extractedItems: analysis.extractedItems,
      });

      const assessmentColor =
        finalAnalysis.overallAssessment === 'ПОТЕНЦІЙНО ЗАВИЩЕНО'
          ? '#dc2626'
          : finalAnalysis.overallAssessment === 'ЗАНИЖЕНО'
            ? '#2563eb'
            : finalAnalysis.overallAssessment === 'РИНКОВО'
              ? '#16a34a'
              : '#6b7280';

      return `
      <div class="contract-card">
        <div class="contract-header">
          <div class="contract-title-row">
            <span class="contract-id">Контракт ${escapeHtml(contractLabel)}</span>
            <div class="risk-badge" style="background:${color}">
              ${riskLabel(analysis.riskScore)} ${analysis.riskScore?.toFixed(2) ?? '—'}
            </div>
          </div>
          ${analysis.contract.contractNumber ? `<div class="contract-num">№ ${escapeHtml(analysis.contract.contractNumber)}</div>` : ''}
          <div class="contract-parties">
            <span class="supplier">${escapeHtml(analysis.contract.supplierName)}</span>
            ${analysis.contract.supplierEdrpou ? `<span class="edrpou">${escapeHtml(analysis.contract.supplierEdrpou)}</span>` : ''}
          </div>
          <div class="contract-details">
            <span class="detail"><span class="detail-label">Сума</span> ${formatAmount(analysis.contract.amount, analysis.contract.currency ?? 'UAH')}</span>
            ${analysis.contract.dateSigned ? `<span class="detail"><span class="detail-label">Підписано</span> ${new Date(analysis.contract.dateSigned).toLocaleDateString('uk-UA')}</span>` : ''}
            <span class="detail"><span class="detail-label">Позицій</span> ${analysis.totalItems ?? 0}</span>
            <span class="detail detail--warn"><span class="detail-label">Вище ринку</span> ${analysis.itemsAboveMarket ?? 0}</span>
          </div>
        </div>
        ${links.length > 0 ? `<div class="links-row">${links.join('')}</div>` : ''}
        ${analysis.sourceDocumentTitle ? `<div class="doc-badge">${escapeHtml(analysis.sourceDocumentTitle)}</div>` : ''}
        <div class="final-analysis">
          <div class="final-assessment" style="border-left: 4px solid ${assessmentColor}">
            <span class="final-assessment-label">Оцінка</span>
            <span class="final-assessment-value" style="color:${assessmentColor}">${escapeHtml(finalAnalysis.overallAssessment)}</span>
            ${finalAnalysis.overpricingSigns === 'ТАК' ? '<span class="overpricing-flag">⚠️ Ознаки завищення</span>' : ''}
          </div>
          <div class="final-stats">
            ${finalAnalysis.marketCoveragePercent != null ? `<span class="fstat"><span class="fstat-label">Покриття ринком</span><span class="fstat-val">${finalAnalysis.marketCoveragePercent.toFixed(1)}%</span></span>` : ''}
            ${finalAnalysis.averageDeviationPercent != null ? `<span class="fstat"><span class="fstat-label">Середнє відхилення</span><span class="fstat-val ${finalAnalysis.averageDeviationPercent > 0 ? 'text-red' : 'text-green'}">${finalAnalysis.averageDeviationPercent > 0 ? '+' : ''}${finalAnalysis.averageDeviationPercent.toFixed(1)}%</span></span>` : ''}
            <span class="fstat"><span class="fstat-label">Узгодженість сум</span><span class="fstat-val">${escapeHtml(finalAnalysis.consistency)}</span></span>
          </div>
          <p class="final-comment">${escapeHtml(finalAnalysis.comment)}</p>
        </div>
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

  const riskBg =
    overallRisk == null
      ? '#f8fafc'
      : overallRisk >= 0.5
        ? '#fef2f2'
        : overallRisk >= 0.2
          ? '#fffbeb'
          : '#f0fdf4';
  const riskBorder =
    overallRisk == null
      ? '#e2e8f0'
      : overallRisk >= 0.5
        ? '#fecaca'
        : overallRisk >= 0.2
          ? '#fde68a'
          : '#bbf7d0';

  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Аналіз цін — ${escapeHtml(tender.tenderID)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f1f5f9; color: #1e293b; line-height: 1.5; }
    .page { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }

    /* Header */
    .header { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #fff; border-radius: 16px; padding: 28px 32px; margin-bottom: 20px; }
    .header-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .header h1 { font-size: 1.1rem; font-weight: 600; color: #94a3b8; letter-spacing: 0.02em; }
    .header h1 a { color: #93c5fd; text-decoration: none; border-bottom: 1px dashed #93c5fd60; }
    .header h1 a:hover { color: #bfdbfe; border-bottom-color: #bfdbfe; }
    .tender-title { font-size: 1.3rem; font-weight: 700; color: #f1f5f9; margin-top: 8px; line-height: 1.4; }
    .prozorro-btn { display: inline-flex; align-items: center; gap: 6px; background: #334155; color: #93c5fd; font-size: 0.82rem;
      font-weight: 600; padding: 7px 14px; border-radius: 8px; text-decoration: none; white-space: nowrap; transition: background .15s; }
    .prozorro-btn:hover { background: #475569; color: #bfdbfe; }
    .header-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 20px; }
    .header-cell { background: #334155; border-radius: 8px; padding: 10px 14px; }
    .header-cell .label { font-size: 0.72rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
    .header-cell .value { font-size: 0.9rem; color: #e2e8f0; font-weight: 600; }

    /* Overall risk */
    .overall-risk { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
      background: ${riskBg}; border-radius: 14px; padding: 22px 28px; margin-bottom: 24px;
      border: 2px solid ${riskBorder}; gap: 16px; }
    .risk-main { }
    .risk-main .label { font-size: 0.8rem; color: #64748b; margin-bottom: 4px; }
    .risk-score { font-size: 2.2rem; font-weight: 800; letter-spacing: -0.02em; }
    .risk-stats { display: flex; gap: 28px; flex-wrap: wrap; }
    .risk-stat { text-align: center; min-width: 70px; }
    .risk-stat .val { font-size: 1.6rem; font-weight: 700; }
    .risk-stat .lbl { font-size: 0.75rem; color: #64748b; margin-top: 2px; }

    /* Contract cards */
    .contract-card { background: #fff; border-radius: 14px; padding: 0; margin-bottom: 20px; border: 1px solid #e2e8f0;
      overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .contract-card.error { border-color: #fca5a5; background: #fff7f7; padding: 24px; }
    .contract-header { padding: 20px 24px 16px; border-bottom: 1px solid #f1f5f9; }
    .contract-title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .contract-id { font-size: 1.05rem; font-weight: 700; color: #0f172a; }
    .contract-num { font-size: 0.85rem; color: #64748b; margin-top: 2px; }
    .contract-parties { display: flex; align-items: baseline; gap: 8px; margin-top: 8px; }
    .supplier { font-size: 0.95rem; color: #334155; font-weight: 500; }
    .edrpou { color: #94a3b8; font-size: 0.82rem; background: #f1f5f9; padding: 1px 8px; border-radius: 4px; }
    .contract-details { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 10px; }
    .detail { font-size: 0.85rem; color: #334155; }
    .detail-label { color: #94a3b8; font-size: 0.75rem; display: block; }
    .detail--warn .detail-label { color: #dc2626; }
    .risk-badge { display: inline-flex; align-items: center; color: #fff; font-weight: 700; font-size: 0.8rem;
      padding: 5px 14px; border-radius: 20px; flex-shrink: 0; }
    .error-msg { color: #dc2626; font-size: 0.9rem; }

    /* Links */
    .links-row { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 24px; background: #f8fafc; border-bottom: 1px solid #f1f5f9; }
    .chip-link { display: inline-flex; align-items: center; gap: 4px; font-size: 0.8rem; font-weight: 500; color: #2563eb;
      background: #eff6ff; padding: 5px 12px; border-radius: 6px; text-decoration: none; transition: background .15s; }
    .chip-link:hover { background: #dbeafe; }
    .chip-link--doc { color: #7c3aed; background: #f5f3ff; }
    .chip-link--doc:hover { background: #ede9fe; }
    .doc-badge { font-size: 0.78rem; color: #94a3b8; padding: 8px 24px 0; }

    /* Final analysis */
    .final-analysis { padding: 16px 24px 4px; }
    .final-assessment { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      background: #f8fafc; border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; }
    .final-assessment-label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    .final-assessment-value { font-size: 0.95rem; font-weight: 700; }
    .overpricing-flag { font-size: 0.8rem; color: #dc2626; font-weight: 600; margin-left: auto; }
    .final-stats { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 10px; }
    .fstat { display: flex; flex-direction: column; }
    .fstat-label { font-size: 0.72rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
    .fstat-val { font-size: 0.9rem; font-weight: 600; color: #1e293b; }
    .final-comment { font-size: 0.82rem; color: #475569; line-height: 1.6; padding-bottom: 12px; }

    /* Table */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
    th { background: #f8fafc; font-weight: 600; text-align: left; padding: 10px 16px;
      border-bottom: 2px solid #e2e8f0; white-space: nowrap; color: #475569; font-size: 0.78rem;
      text-transform: uppercase; letter-spacing: 0.03em; }
    td { padding: 10px 16px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    .num { text-align: right; white-space: nowrap; }
    .source { font-size: 0.76rem; color: #94a3b8; max-width: 240px; }

    /* Row coloring */
    .text-red { color: #dc2626; font-weight: 700; }
    .text-red-row td { background: #fef2f2; }
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
      .header { padding: 20px 16px; }
      .header-grid { grid-template-columns: 1fr 1fr; }
      .overall-risk { flex-direction: column; padding: 16px 20px; }
      .risk-stats { gap: 16px; }
      .contract-header { padding: 16px; }
      .links-row { padding: 10px 16px; }
      .final-analysis { padding: 12px 16px 0; }
      .final-analysis-grid { grid-template-columns: 1fr; }
      td, th { padding: 8px 10px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="header-top">
        <div>
          <h1>Аналіз цін тендеру ${prozorroTenderUrl ? `<a href="${prozorroTenderUrl}" target="_blank">${escapeHtml(tender.tenderID)}</a>` : escapeHtml(tender.tenderID || '—')}</h1>
          ${tender.title ? `<div class="tender-title">${escapeHtml(tender.title)}</div>` : ''}
        </div>
        ${prozorroTenderUrl ? `<a href="${prozorroTenderUrl}" target="_blank" class="prozorro-btn">&#8599; Відкрити на Prozorro</a>` : ''}
      </div>
      <div class="header-grid">
        ${tender.customerName ? `<div class="header-cell"><div class="label">Замовник</div><div class="value">${escapeHtml(tender.customerName)}${tender.customerEdrpou ? ` <span style="color:#94a3b8;font-weight:400">${escapeHtml(tender.customerEdrpou)}</span>` : ''}</div></div>` : ''}
        ${tender.status ? `<div class="header-cell"><div class="label">Статус</div><div class="value">${escapeHtml(tender.status)}</div></div>` : ''}
        ${tender.amount != null ? `<div class="header-cell"><div class="label">Очікувана вартість</div><div class="value">${formatAmount(tender.amount, tender.currency ?? 'UAH')}</div></div>` : ''}
        ${tender.procurementMethodType ? `<div class="header-cell"><div class="label">Метод закупівлі</div><div class="value">${escapeHtml(tender.procurementMethodType)}</div></div>` : ''}
        ${tender.mainProcurementCategory ? `<div class="header-cell"><div class="label">Категорія</div><div class="value">${escapeHtml(tender.mainProcurementCategory)}</div></div>` : ''}
      </div>
    </div>

    <div class="overall-risk">
      <div class="risk-main">
        <div class="label">Загальна оцінка цінового ризику</div>
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
