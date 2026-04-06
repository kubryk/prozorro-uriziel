import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getPrisma, disconnectPrisma } from './db.js';
import { searchTenders, searchContracts, getCompanyProfile, getTenderById, getStats } from './query.js';

const server = new McpServer({
  name: 'prozorro-mcp',
  version: '1.0.0',
});

// ─── search_tenders ───────────────────────────────────────────────────────────
server.tool(
  'search_tenders',
  'Пошук тендерів у базі Prozorro. Можна фільтрувати за ЄДРПОУ замовника/постачальника, статусом, роком, діапазоном дат та бюджету.',
  {
    edrpou: z.string().regex(/^\d{8}(\d{2})?$/).optional().describe('ЄДРПОУ компанії (8 або 10 цифр)'),
    role: z.array(z.enum(['customer', 'supplier'])).optional().describe('Роль компанії: customer (замовник) або supplier (постачальник). За замовчуванням: [customer]'),
    status: z.array(z.string()).optional().describe('Статуси тендера, напр. ["complete", "active.awarded"]'),
    year: z.number().int().min(2000).max(2100).optional().describe('Рік тендера'),
    dateFrom: z.string().optional().describe('Дата початку діапазону (YYYY-MM-DD)'),
    dateTo: z.string().optional().describe('Дата кінця діапазону (YYYY-MM-DD)'),
    dateType: z.enum([
      'dateModified', 'dateCreated', 'tenderPeriodStart', 'tenderPeriodEnd',
      'enquiryPeriodStart', 'enquiryPeriodEnd', 'auctionPeriodStart', 'awardPeriodStart',
    ]).optional().describe('Поле дати для фільтрації. За замовчуванням: dateModified'),
    priceFrom: z.number().min(0).optional().describe('Мінімальна сума тендера (грн)'),
    priceTo: z.number().min(0).optional().describe('Максимальна сума тендера (грн)'),
    sort: z.enum(['default', 'dateCreatedDesc', 'dateCreatedAsc', 'amountAsc', 'amountDesc']).optional(),
    skip: z.number().int().min(0).optional().describe('Зміщення для пагінації'),
    take: z.number().int().min(1).max(100).optional().describe('Кількість результатів (max 100). За замовчуванням: 20'),
  },
  async (input) => {
    const result = await searchTenders(getPrisma(), input);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── search_contracts ─────────────────────────────────────────────────────────
server.tool(
  'search_contracts',
  'Пошук контрактів у базі Prozorro. Можна фільтрувати за ЄДРПОУ постачальника/замовника, статусом, датою підписання та сумою.',
  {
    edrpou: z.string().regex(/^\d{8}(\d{2})?$/).optional().describe('ЄДРПОУ компанії (8 або 10 цифр)'),
    role: z.array(z.enum(['customer', 'supplier'])).optional().describe('Роль компанії: supplier (постачальник) або customer (замовник). За замовчуванням: [supplier]'),
    status: z.array(z.string()).optional().describe('Статуси контракту, напр. ["active", "terminated"]'),
    dateFrom: z.string().optional().describe('Дата початку діапазону (YYYY-MM-DD)'),
    dateTo: z.string().optional().describe('Дата кінця діапазону (YYYY-MM-DD)'),
    dateType: z.enum(['dateSigned', 'dateModified']).optional().describe('Поле дати для фільтрації. За замовчуванням: dateSigned'),
    priceFrom: z.number().min(0).optional().describe('Мінімальна сума контракту (грн)'),
    priceTo: z.number().min(0).optional().describe('Максимальна сума контракту (грн)'),
    sort: z.enum(['default', 'amountAsc', 'amountDesc', 'dateSignedDesc', 'dateSignedAsc']).optional(),
    skip: z.number().int().min(0).optional().describe('Зміщення для пагінації'),
    take: z.number().int().min(1).max(100).optional().describe('Кількість результатів (max 100). За замовчуванням: 20'),
  },
  async (input) => {
    const result = await searchContracts(getPrisma(), input);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── get_company_profile ──────────────────────────────────────────────────────
server.tool(
  'get_company_profile',
  'Профіль компанії за ЄДРПОУ: статистика тендерів як замовника, контрактів як постачальника, win rate, кількість скарг та останні записи.',
  {
    edrpou: z.string().regex(/^\d{8}(\d{2})?$/).describe('ЄДРПОУ компанії (8 або 10 цифр)'),
  },
  async ({ edrpou }) => {
    const result = await getCompanyProfile(getPrisma(), edrpou);
    if (!result) {
      return { content: [{ type: 'text', text: `Компанію з ЄДРПОУ ${edrpou} не знайдено в базі.` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── get_tender_by_id ─────────────────────────────────────────────────────────
server.tool(
  'get_tender_by_id',
  'Отримати повні дані тендера за його Prozorro ID (напр. "UA-2025-01-15-000107-a"). Повертає тендер з вкладеними контрактами.',
  {
    tenderID: z.string().min(1).describe('Prozorro ID тендера, напр. "UA-2025-01-15-000107-a"'),
  },
  async ({ tenderID }) => {
    const result = await getTenderById(getPrisma(), tenderID);
    if (!result) {
      return { content: [{ type: 'text', text: `Тендер ${tenderID} не знайдено в базі.` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── get_stats ────────────────────────────────────────────────────────────────
server.tool(
  'get_stats',
  'Загальна статистика бази: кількість тендерів, контрактів та час останньої синхронізації з Prozorro.',
  {},
  async () => {
    const result = await getStats(getPrisma());
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();

process.on('SIGINT', async () => {
  await disconnectPrisma();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await disconnectPrisma();
  process.exit(0);
});

await server.connect(transport);
