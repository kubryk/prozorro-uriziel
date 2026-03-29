# Аналіз завищення цін через Telegram бот — План реалізації

## Context

Потрібен Telegram бот для 15 користувачів, який дозволяє шукати тендери/контракти за ЄДРПОУ та аналізувати їх на завищення цін. Аналіз: витягуємо ціни з PDF-документів договорів (розділ "Специфікація"), порівнюємо з ринковими через Gemini Flash + Google Search grounding.

**Рішення:** Google Gemini 2.0 Flash, telegraf + nestjs-telegraf, BullMQ черги для аналізу.

---

## UX Flow бота

### Flow 1: Пошук за ЄДРПОУ
```
Користувач: /search
Бот: Введіть ЄДРПОУ
Користувач: 12345678
Бот: Оберіть роль → [Замовник] [Підрядник] [Обидва]
Бот: Оберіть рік → [2025] [2026] [Обидва]
Бот: Введіть мінімальну суму контракту (0 = без обмежень)
Користувач: 100000

Бот: Знайдено 12 тендерів, 28 контрактів:

📋 Тендер UA-2025-03-15-000456-a
   Назва: Закупівля медичного обладнання
   Сума: 2,500,000 UAH | Статус: complete
   Контракти: 3
   [Аналіз цього тендеру]

📋 Тендер UA-2025-04-01-000789-b
   ...
   [Аналіз цього тендеру]

[◀ Назад] [▶ Далі] [🔍 Масовий аналіз всіх 12]
```

### Flow 2: Пошук за номером тендеру
```
Користувач: /tender UA-2025-03-15-000456-a
Бот:
📋 Тендер UA-2025-03-15-000456-a
   Назва: Закупівля медичного обладнання
   Замовник: ТОВ "Компанія" (12345678)
   Сума: 2,500,000 UAH
   Статус: complete
   Метод: aboveThreshold
   Категорія: goods

   📄 Контракт #1: 1,200,000 UAH — ТОВ "Постачальник А"
   📄 Контракт #2: 800,000 UAH — ТОВ "Постачальник Б"
   📄 Контракт #3: 500,000 UAH — ТОВ "Постачальник В"

   [🔍 Детальний аналіз тендеру]
```

### Flow 3: Результат аналізу
```
Бот: ⏳ Аналіз тендеру UA-2025-03-15-000456-a запущено...
     Контрактів для аналізу: 3
     Позиція в черзі: #4

[через деякий час — нове повідомлення з push notification]

Бот: ✅ Аналіз завершено: UA-2025-03-15-000456-a

📄 Контракт #1 (ТОВ "Постачальник А") — ⚠️ Ризик: 0.65
   🔴 Шприц одноразовий 5мл: 4.50 UAH (ринок: 2.80 UAH) +61%
   🟡 Бинт стерильний: 28.00 UAH (ринок: 22.00 UAH) +27%
   🟢 Рукавички нітрилові: 3.20 UAH (ринок: 3.10 UAH) +3%

📄 Контракт #2 (ТОВ "Постачальник Б") — 🟢 Ризик: 0.12
   🟢 Всі ціни в межах ринкових

📄 Контракт #3 — ❌ Не вдалося (PDF не містить специфікацію)

Загальний ризик тендеру: ⚠️ 0.45
Завищення: 4 з 12 позицій вище ринку на >20%
```

---

## Крок 1: Залежності

**Файл:** `package.json`

```bash
npm install nestjs-telegraf telegraf pdf-parse @google/generative-ai
npm install -D @types/pdf-parse
```

**Файл:** `.env.example` — додати:
```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_ALLOWED_USERS=123456789,987654321   # comma-separated Telegram user IDs
GEMINI_API_KEY=your_google_ai_api_key
PRICE_ANALYSIS_CONCURRENCY=3
```

---

## Крок 2: Database schema

**Файл:** `prisma/schema.prisma`

Додати дві моделі:

```prisma
model PriceAnalysis {
  id                  String   @id @default(uuid())
  contractId          String
  contract            Contract @relation(fields: [contractId], references: [id], onDelete: Cascade)
  status              String   @default("PENDING")
  // PENDING → DOWNLOADING_PDF → EXTRACTING_ITEMS → SEARCHING_PRICES → COMPLETE / FAILED
  errorMessage        String?
  totalItems          Int?
  itemsAboveMarket    Int?
  riskScore           Float?            // 0.0–1.0
  sourceDocumentTitle String?
  telegramChatId      String?           // для відправки результату назад
  telegramMessageId   Int?              // для edit повідомлення зі статусом
  extractedItems      PriceAnalysisItem[]
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([contractId])
  @@index([status])
  @@index([riskScore])
}

model PriceAnalysisItem {
  id             String        @id @default(uuid())
  analysisId     String
  analysis       PriceAnalysis @relation(fields: [analysisId], references: [id], onDelete: Cascade)
  itemName       String
  unitPrice      Float
  quantity       Float?
  unit           String?
  marketPrice    Float?
  marketPriceMin Float?
  marketPriceMax Float?
  marketSource   String?
  priceDeviation Float?        // (unitPrice - marketPrice) / marketPrice

  @@index([analysisId])
}
```

Додати relation на Contract: `priceAnalyses PriceAnalysis[]`

---

## Крок 3: Prozorro document API

**Файл:** `src/prozorro/prozorro.types.ts` — додати:
```typescript
export interface ProzorroDocument {
  id: string;
  title?: string;
  url?: string;
  format?: string;
  datePublished?: string;
  dateModified?: string;
}
```

**Файл:** `src/prozorro/prozorro.service.ts` — додати метод:
- `getContractDocuments(contractId: string): Promise<ProzorroDocument[]>`
- Використовує існуючий rate limiter + retry

---

## Крок 4: Модуль Telegram бота

**Нові файли:** `src/telegram/`
```
src/telegram/
  telegram.module.ts
  telegram.update.ts          # головний handler команд
  telegram.service.ts         # допоміжна логіка (форматування, пагінація)
  telegram.guard.ts           # перевірка whitelist user IDs
```

### telegram.module.ts
- Імпортує `TelegrafModule.forRoot({ token: process.env.TELEGRAM_BOT_TOKEN })`
- Імпортує `SearchModule`, `PriceAnalysisModule`

### telegram.guard.ts
- Middleware для telegraf: перевіряє `ctx.from.id` проти `TELEGRAM_ALLOWED_USERS`
- Якщо не в списку → `ctx.reply('Доступ заборонено')`

### telegram.update.ts — Команди бота
Використовує існуючий `SearchService` через DI:

**`/start`** → Привітання + список команд

**`/search`** → Запускає conversation flow:
1. Запитує ЄДРПОУ (text input)
2. Inline keyboard: роль (Замовник / Підрядник / Обидва)
3. Inline keyboard: рік (2025 / 2026 / Обидва)
4. Запитує мін. суму (text input, 0 = без обмежень)
5. Викликає `SearchService.searchTenders()` з фільтрами
6. Форматує результати з inline buttons для аналізу
7. Пагінація через inline buttons [◀ Назад] [▶ Далі]
8. Button [🔍 Масовий аналіз] → ставить всі контракти в чергу

**`/tender <номер>`** → Пошук одного тендеру:
1. Шукає тендер за `tenderID` в БД
2. Показує деталі + список контрактів
3. Button [🔍 Детальний аналіз] → ставить всі контракти тендеру в чергу

**Callback queries (inline buttons):**
- `analyze:{tenderId}` → запуск аналізу одного тендеру (всі його контракти)
- `analyze_all:{searchHash}` → масовий аналіз всіх знайдених тендерів
- `page:{searchHash}:{offset}` → пагінація результатів

### telegram.service.ts
- `formatTenderMessage(tender)` → Ukrainian markdown для Telegram
- `formatAnalysisResult(analysis)` → форматований звіт з емодзі (🔴🟡🟢)
- `paginateResults(results, page, perPage)` → нарізка + inline keyboard

---

## Крок 5: Модуль аналізу цін

**Нові файли:** `src/price-analysis/`
```
src/price-analysis/
  price-analysis.module.ts
  price-analysis.service.ts       # оркестратор pipeline
  price-analysis.processor.ts     # BullMQ worker
  pdf-extractor.service.ts        # завантаження + парсінг PDF
  gemini.service.ts               # Gemini API wrapper
  price-analysis.types.ts         # інтерфейси
```

### gemini.service.ts
- Обгортка над `@google/generative-ai`
- **`extractItemsFromText(text)`** → Gemini Flash, JSON mode, temperature 0
  - Prompt: витягти itemName, unitPrice, quantity, unit з тексту специфікації
- **`searchMarketPrices(items[])`** → Gemini Flash + `google_search` grounding tool
  - Batch по 10 товарів за запит
  - Повертає marketPrice, min, max, source для кожного

### pdf-extractor.service.ts
- **`selectBestDocument(docs[])`** → пріоритет: PDF з "специфікація" в назві → найбільший PDF
- **`downloadAndExtractPdf(url)`** → axios download + pdf-parse → текст
- **`extractSpecificationSection(text)`** → regex після "Специфікація" (case-insensitive), до наступного розділу

### price-analysis.service.ts — Оркестратор

**`triggerTenderAnalysis(tenderId, chatId, messageId)`**:
1. Знайти всі контракти тендеру
2. Для кожного контракту створити `PriceAnalysis` запис (status: PENDING, chatId, messageId)
3. Enqueue кожен в BullMQ чергу `price-analysis`
4. Повернути кількість створених аналізів

**`triggerBulkAnalysis(tenderIds[], chatId)`**:
1. Для кожного тендеру → `triggerTenderAnalysis()`
2. Повернути загальну кількість

**`runAnalysisPipeline(analysisId)`** — викликається процесором:
1. Fetch документів контракту з Prozorro API
2. Обрати найкращий PDF → скачати → витягти текст
3. Знайти розділ "Специфікація" (якщо немає — весь текст)
4. Gemini Flash: витягти товари/ціни → зберегти PriceAnalysisItem
5. Gemini + Search: знайти ринкові ціни → оновити items + обчислити deviation
6. Обчислити riskScore (зважене середнє відхилень по сумі позиції)
7. Статус → COMPLETE

**`onAnalysisComplete(analysisId)`** — після завершення:
1. Перевірити чи всі аналізи тендеру завершені
2. Якщо так → відправити зведений результат у Telegram chat (за chatId)
3. Використати `telegraf.telegram.sendMessage(chatId, formattedResult)`

### price-analysis.processor.ts — BullMQ Worker
- Черга: `price-analysis`
- Concurrency: `PRICE_ANALYSIS_CONCURRENCY` (default 3, бо LLM calls повільні)
- Lock duration: 600_000 (10 хв — PDF download + 2 LLM calls)
- Retry: 2 attempts з exponential backoff
- При помилці: status → FAILED + errorMessage
- При успіху: викликає `onAnalysisComplete()` для Telegram notification

---

## Крок 6: Інтеграція

**Файл:** `src/constants.ts` — додати:
```typescript
export const PRICE_ANALYSIS_QUEUE_NAME = 'price-analysis';
```

**Файл:** `src/app.module.ts` — додати:
- `TelegramModule` в imports
- `PriceAnalysisModule` в imports
- `BullModule.registerQueue({ name: PRICE_ANALYSIS_QUEUE_NAME })`
- `BullBoardModule.forFeature({ name: PRICE_ANALYSIS_QUEUE_NAME, adapter: BullMQAdapter })`

---

## Крок 7: Пошук тендеру за номером

**Файл:** `src/search/search.service.ts` — додати метод:
```typescript
async findTenderByTenderId(tenderID: string) {
  return this.prisma.tender.findFirst({
    where: { tenderID },
    include: { contracts: true, lots: true, bids: true },
  });
}
```
Цей метод потрібен для команди `/tender <номер>`.

---

## Порядок імплементації

1. `npm install` залежностей
2. Prisma schema → `npx prisma migrate dev --name add_price_analysis`
3. Prozorro types + `getContractDocuments()` метод
4. `src/constants.ts` — новий queue name
5. `src/price-analysis/gemini.service.ts`
6. `src/price-analysis/pdf-extractor.service.ts`
7. `src/price-analysis/price-analysis.service.ts`
8. `src/price-analysis/price-analysis.processor.ts`
9. `src/price-analysis/price-analysis.module.ts`
10. `src/search/search.service.ts` — додати `findTenderByTenderId()`
11. `src/telegram/telegram.guard.ts`
12. `src/telegram/telegram.service.ts` (форматування)
13. `src/telegram/telegram.update.ts` (команди)
14. `src/telegram/telegram.module.ts`
15. `src/app.module.ts` — підключити модулі
16. `.env.example` — нові змінні

---

## Верифікація

1. `npm run build` — компіляція без помилок
2. `npx prisma migrate dev` — міграція успішна
3. `npm test` — існуючі тести проходять
4. Запустити бот локально → `/start` → перевірити whitelist
5. `/search` → ввести ЄДРПОУ → перевірити фільтри → побачити результати
6. `/tender UA-...` → перевірити що показує інфо
7. Натиснути [Аналіз] → перевірити що job потрапляє в чергу
8. Дочекатися результату → перевірити Telegram повідомлення з аналізом
9. Масовий аналіз → перевірити що всі контракти аналізуються паралельно
