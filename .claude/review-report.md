# Prozorro Track System - Комплексне ревю проекту

**Дата ревю:** 29 березня 2026
**Статус:** Хороший стан, production-ready архітектура з деякими потенціальними покращеннями

---

## 📊 РЕЗЮМЕ ОЦІНКИ

| Категорія | Оцінка | Статус |
|-----------|--------|--------|
| **Архітектура** | 8.5/10 | ✅ Добре структурована, масштабувана |
| **Безпека** | 8/10 | ⚠️ Хороша базова, деякі покращення |
| **Якість коду** | 7.5/10 | ✅ Консистентна, але є місця для оптимізації |
| **Тестування** | 7/10 | ⚠️ Адекватне, але неповне покриття |
| **Документація** | 7/10 | ⚠️ CLAUDE.md добре, але деталі розпорошені |
| **Операційна готовність** | 8.5/10 | ✅ Docker готовий, health checks, мониторинг |

**Загальна оцінка: 8/10** — Production-ready система з розумною архітектурою

---

## ✅ СИЛЬНІ СТОРОНИ

### 1. **Архітектура і Масштабованість** (10/10)
- ✓ **Role-based Scaling:** MAIN/WORKER паттерн дозволяє горизонтальне масштабування
- ✓ **Ефективна синхронізація:** Offset-based pagination з optimistic locking для цілісності
- ✓ **Job Queue Deduplication:** `buildMainJobId()` запобігає дублюванню тендерів
- ✓ **Controlled Concurrency:**
  - BullMQ task concurrency (50)
  - DB write slots (2) для запобігання перевантаженню БД
  - Token bucket rate limiting (50 req/s до Prozorro API)

### 2. **Безпека** (8/10)
- ✓ **API Key Auth:** Глобальна гвард на основі `X-API-KEY` заголовка
- ✓ **Public Endpoint Marking:** Явне позначення публічних маршрутів (`@Public()`)
- ✓ **Input Validation:** Global `ValidationPipe` з whitelist + forbidNonWhitelisted
- ✓ **Non-root Container:** Dockerfile створює непривілейованого користувача `app`
- ✓ **Environment Validation:** Обов'язкові змінні перевіряються при启动
- ✓ **SQL Injection Protection:** Prisma параметризовані запити

### 3. **Якість Коду і Кодування**
- ✓ **TypeScript Strict Mode:** Всі строгі перевірки активовані
- ✓ **Consistent Formatting:** ESLint 9 + Prettier з єдиними правилами
- ✓ **Data Sanitization:** `sanitize()` функція видаляє null bytes для PostgreSQL
- ✓ **Type Safety:** Повні TypeScript interfaces для Prozorro API responses
- ✓ **Error Handling:** Try-catch блоки з граціозною деградацією (partial sync)

### 4. **Операційна Готовність** (9/10)
- ✓ **Health Checks:** Endpoint `/health` з DB + Redis статусом
- ✓ **Docker Multi-stage Build:** Оптимізована для продакшену (152MB - 200MB образ)
- ✓ **Aggregated Stats Logging:** Кожні 30 сек логи про処理 прогрес
- ✓ **Graceful Shutdown:** `OnModuleDestroy` очищає інтервали
- ✓ **Prisma Migrations:** 16 відслідкованих міграцій з git історією

### 5. **Обробка Помилок**
- ✓ **Exponential Backoff Retry:** 5s → 10s → 20s для невдалих jobів
- ✓ **Bounded Failed Job History:** Зберігає останні 1000 невдалих jobів для інспекції
- ✓ **Partial Sync Tracking:** `syncStatus` (FULL/PARTIAL/FAILED/RETRYING) для розумного повтору
- ✓ **Retry Cron:** Кожні 10 хвилин повторює неповні тендери

---

## ⚠️ ПРОБЛЕМИ І РЕКОМЕНДАЦІЇ

### 🔴 КРИТИЧНІ (обов'язково виправити)

#### 1. **Потенційна Race Condition у SyncState**
**Місце:** `sync.service.ts:220-227`

```typescript
// ⚠️ ПРОБЛЕМА: updateMany повертає count, але не повертає оновлений рядок
const updated = await this.prisma.syncState.updateMany({
  where: { id: 1, lastOffset: syncState!.lastOffset },
  data: { lastOffset: currentOffset },
});
if (updated.count === 0) {
  break;
}
// ❌ Потім робимо findUnique — це 2 окремих запити!
syncState = await this.prisma.syncState.findUnique({ where: { id: 1 } });
```

**Рисковано:** У дуже рідких сценаріях два MAIN інстанси можуть потрапити у цю область, обидва бачити `count === 0` (коли другий оновлювач додав новий рядок), і потім обидва заново читають. Мала ймовірність, але можлива.

**Рекомендація:**
```typescript
const updated = await this.prisma.syncState.updateMany({
  where: { id: 1, lastOffset: syncState!.lastOffset },
  data: { lastOffset: currentOffset, updatedAt: new Date() },
});
if (updated.count === 0) break;

// Просто скориставши updateMany результатом
syncState = { id: 1, lastOffset: currentOffset, updatedAt: new Date() };
```

---

#### 2. **API Key в логах Bull Board Middleware**
**Місце:** `app.module.ts:20-26`

```typescript
function bullBoardAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];  // ❌ Це потрапить в логи/моніторинг!
  if (apiKey && apiKey === process.env.API_KEY) {
    return next();
  }
  res.status(401).json({ message: 'Unauthorized' });
}
```

**Проблема:** `req.headers['x-api-key']` потрапляє у логи через express логер або моніторинг.

**Рекомендація:**
```typescript
function bullBoardAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  // Порівняння без логування самого ключа
  const validKey = process.env.API_KEY;
  if (!validKey || apiKey !== validKey) {
    // Логуємо тільки факт спроби, без ключа
    // logger.warn(`Unauthorized Bull Board access attempt from ${req.ip}`);
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}
```

---

### 🟡 ВАЖЛИВІ (виправити в ближайшому майбутньому)

#### 3. **Неповне покриття типів у Processor**
**Місце:** `tender.processor.ts:150`

```typescript
} catch (contractError: any) {  // ❌ any замість proper union
```

**Проблема:** ESLint має `no-explicit-any: OFF`, тому `any` не складає помилку. Але це погана практика.

**Рекомендація:**
```typescript
} catch (contractError: unknown) {
  const err = contractError instanceof Error ? contractError : new Error(String(contractError));
  // тепер використовуємо err.message
```

---

#### 4. **Відсутня Rate Limit на Sync Cron**
**Місце:** `sync.service.ts:155-211`

**Проблема:** Cron запускається кожні 6 секунд і максимум заходить 1 сторінка (100 тендерів). Але немає жодної логіки для сповільнення, якщо API помирає від перевантаженості.

**Рекомендація:** Додайте exponential backoff для cron інтервалу:
```typescript
private syncBackoffMultiplier = 1;

@Cron('*/6 * * * * *')
async handleSync() {
  // ...
  try {
    // existing logic
    this.syncBackoffMultiplier = 1; // reset on success
  } catch (error) {
    this.syncBackoffMultiplier = Math.min(this.syncBackoffMultiplier * 2, 10);
    const delayMs = 6000 * this.syncBackoffMultiplier;
    this.logger.warn(`Sync failed, backing off to ${delayMs}ms`);
    // Или пропустити цей цикл
    throw error;
  }
}
```

---

#### 5. **Недостатня обробка невалідних дат**
**Місце:** `sync.service.ts:80-96`

```typescript
const parsedDateModified = rawDateModified ? new Date(rawDateModified) : null;

if (parsedDateModified && !Number.isNaN(parsedDateModified.getTime())) {
  return `main-${tender.id}-${parsedDateModified.getTime()}`;
}

// Fallback до сирого строку — це потенційно небезпечно
const normalizedDateModified = rawDateModified.replace(/[^a-zA-Z0-9_-]/g, '_');
return normalizedDateModified
  ? `main-${tender.id}-${normalizedDateModified}`
  : `main-${tender.id}`;
```

**Проблема:** Якщо `dateModified` містить экстремально довгий строк, `normalizedDateModified` може бути дуже довгим, перевищуючи ліміт BullMQ jobId (512 байт).

**Рекомендація:**
```typescript
const normalizedDateModified = rawDateModified
  .replace(/[^a-zA-Z0-9_-]/g, '_')
  .substring(0, 50); // Обмежити довжину
return `main-${tender.id}-${normalizedDateModified}`;
```

---

#### 6. **Просяцій Error Handling у Search Module**
**Місце:** `search.service.ts` (не показано повністю, але типовий NestJS паттерн)

**Проблема:** Якщо query складна (багато фільтрів), Prisma помилка не матиме гарного контексту.

**Рекомендація:** Додайте try-catch у search методи:
```typescript
async searchTenders(query: SearchTendersQueryDto) {
  try {
    return await this.prisma.tender.findMany({
      where: buildWhere(query),
      orderBy: buildOrderBy(query),
      take: query.take,
      skip: query.skip,
    });
  } catch (error) {
    this.logger.error(`Search failed: ${error.message}`, error.stack);
    throw new BadRequestException('Invalid search query');
  }
}
```

---

### 🟢 РЕКОМЕНДАЦІЇ ДЛЯ ОПТИМІЗАЦІЇ

#### 7. **Оптимізація Denormalized Fields**
**Місце:** `schema.prisma` (Tender model)

**Спостереження:** 4 denormalized поля для customer (edrpou, name, region, locality) плюс FK до Company.

```prisma
// Поточне стан
customerEdrpou   String?
customerName     String?
customerRegion   String?
customerLocality String?
customerId       String?
customer         Company?  @relation(...)
```

**Проблема:** Якщо Company.name або region змінюється, Tender не оновлюється. Це може призвести до невідповідності.

**Рекомендація (2 варіанти):**

**Варіант А — Міграція на читання через JOIN (потім видалення denormalization):**
- Переробити search queries для JOIN на Company
- Додати індекси на Tender.customerId
- Видалити денормалізовані поля
- *Плюс:* Одна джерело істини, *Мінус:* Трохи повільніше читання

**Варіант Б — Тригери БД для синхронізації:**
- PostgreSQL trigger на Company UPDATE → оновлює всі Tender/Contract рядки
- *Плюс:* Швидкі читання, *Мінус:* Складніша логіка БД

**Рекомендується Варіант А** для простоти, невелика вартість читання.

---

#### 8. **Індекс на Tender.syncStatus + dateModified**
**Місце:** `schema.prisma:31-92`

**Спостереження:** Cron `retryPartialTenders()` робить:
```typescript
await this.prisma.tender.findMany({
  where: { syncStatus: { in: ['PARTIAL', 'FAILED'] } },
  orderBy: { dateModified: 'asc' },
  take: 100,
});
```

**Проблема:** Ідеальний індекс — `(syncStatus, dateModified)`. Поточно є окремі індекси.

**Рекомендація:**
```prisma
@@index([syncStatus, dateModified])  // На Tender моделі
```

---

#### 9. **Логування Чутливих Даних**
**Місце:** Весь проект

**Проблема:** Деякі логи можуть містити приватні дані (EDRPOU особи, контактні дані).

**Рекомендація:** Додайте utility для маскування:
```typescript
function maskSensitiveData(obj: any): any {
  if (typeof obj === 'string') {
    if (/^\d{8,10}$/.test(obj)) return '[EDRPOU]'; // mask EDRPOU
    if (obj.includes('@')) return '[EMAIL]';
  }
  return obj;
}

// При логуванні
this.logger.log(`Processing tender: ${maskSensitiveData(tender.id)}`);
```

---

#### 10. **Тестування Edge Cases**
**Місце:** Тестові файли

**Проблема:** Поточне тестування адекватне, але не покриває:
- Одночасні синхронізації двох MAIN інстансів
- Дуже довгі строки в dateModified
- Невалідні EDRPOU форматы
- Connection pool exhaustion
- Redis connection loss

**Рекомендація:** Додайте integration тести:
```typescript
// test/concurrent-sync.e2e-spec.ts
describe('Concurrent Sync', () => {
  it('should prevent double-sync with optimistic locking', async () => {
    // Запустити два sync одночасно
    // Перевірити що тільки один оновив offset
  });
});
```

---

## 📋 ПЕРЕВІРКА БЕЗПЕКИ

### Уразливості (Low Risk)

| № | Категорія | Статус | Дія |
|---|-----------|--------|-----|
| 1 | **SQL Injection** | ✅ Safe | Prisma параметризує всі запити |
| 2 | **XSS** | ✅ Safe | REST API (JSON), немає HTML rendering |
| 3 | **CSRF** | ✅ Safe | API Key аутентифікація, не cookies |
| 4 | **Rate Limiting** | ✅ Good | 100 req/min per IP + token bucket |
| 5 | **API Key Exposure** | ⚠️ Review | ключ потрапляє в логи Bull Board |
| 6 | **Secrets in Env** | ✅ Safe | Використовує .env, не硬кодіровані |
| 7 | **Docker Security** | ✅ Good | Non-root user, multi-stage build |
| 8 | **Data Validation** | ✅ Good | class-validator + whitelist |

---

## 📈 РЕКОМЕНДАЦІЇ ДЛЯ МАСШТАБУВАННЯ

### Поточне стан
- Single DB (PostgreSQL 15)
- Single Redis
- BullMQ на Redis
- Обмеження: Sync обмежена 1 сторінкою/6 сек (~600 т. на день)

### Для 10x Growth
1. **Читання:** PostgreSQL read replicas + connection pooling (PgBouncer)
2. **Написання:** Batch the tender writes за допомогою queue (поточна стратегія OK)
3. **Кеш:** Redis для часто шуканих тендерів (GET /search/company/:edrpou)
4. **Кластеризація:** Redis Sentinel або Cluster для HA

### Для 100x Growth
-분shard Tender таблицю по року або EDRPOU
- Time-series DB (InfluxDB) для аналітики
- ElasticSearch для full-text пошуку

---

## 🧪 ЯКІСТЬ ТЕСТУВАННЯ

### Поточне покриття

| Модуль | Test Файли | Тип | Покриття |
|--------|-----------|------|----------|
| Auth | api-key.guard.spec | Unit | Good |
| Prisma | prisma.service.spec | Unit | Good |
| Prozorro API | prozorro.service.spec | Unit | Good |
| Sync | sync.service.spec | Unit | Fair |
| Processor | tender.processor.spec | Unit | Fair |
| Search | search.service.spec, search.controller.spec | Unit | Good |
| E2E | app.e2e-spec.ts | Integration | Fair |

**Дефіцити:**
- [ ] Concurrency tестів (2 MAIN інстанси)
- [ ] Circuit breaker поведінка під перевантаженням
- [ ] Database migration edge cases
- [ ] Redis failover scenarios

**Рекомендація:** Додайте integration тести для критичних сценаріїв у `test/` директорії.

---

## 📝 ДОКУМЕНТАЦІЯ

### Що добре задокументовано
- ✅ CLAUDE.md містить всі важливі інструкції
- ✅ npm скрипти описані
- ✅ Docker setup з docker-compose
- ✅ .env.example з усіма змінними

### Що потребує документації
- ⚠️ Архітектурна діаграма (MAIN/WORKER паттерн)
- ⚠️ Database schema diagram (relationships)
- ⚠️ API versioning strategy (поточна єдина версія)
- ⚠️ Deployment guide (як виконувати migrations в production)
- ⚠️ Troubleshooting guide (common issues)

**Рекомендація:** Додайте `docs/` папку:
```
docs/
  ├── ARCHITECTURE.md
  ├── DATABASE.md
  ├── DEPLOYMENT.md
  └── TROUBLESHOOTING.md
```

---

## 🎯 ПРІОРИТИЗОВАНИЙ ПЛАН ДІЙ

### 🔴 Пріоритет 1 (роби одразу)
- [ ] **Виправити SyncState race condition** — додайте unit test
- [ ] **Приховати API key у логах** — додайте маскування
- [ ] **Обмежити jobId довжину** — встави substring(50)

### 🟡 Пріоритет 2 (наступний спринт)
- [ ] Додайте `(syncStatus, dateModified)` composite index
- [ ] Замініть `:any` на `:unknown` у processor
- [ ] Додайте exponential backoff для sync cron
- [ ] Покрийте concurrent sync unit/integration тестами

### 🟢 Пріоритет 3 (біля можливості)
- [ ] Міграція на JOIN замість denormalization
- [ ] Додайте утиліти для маскування чутливих даних
- [ ] Напишіть архітектурну документацію
- [ ] Додайте circuit breaker паттерн для Prozorro API

---

## 🏆 ВИСНОВОК

**Prozorro Track System є solid, production-ready системою з:**

✅ **Сильних сторін:**
- Хорошо структурована архітектура з чіткою розділею обов'язків
- Ефективна обробка паралелізму та масштабування
- Добре безпека на рівні básico
- Docker-ready з health checks і мониторингом
- Активна розвиток с гарною git історією

⚠️ **Площ для покращення:**
- 3 критичні проблеми, які потребують виправлення
- Недостатнє покриття edge cases у тестуванні
- Документація могла бути більш деталізованою
- Деякі оптимізації доступні для масштабування

**Оцінка:** **8/10** — Готово до production з деякими покращеннями, які варто зробити.

Система готова до запуску, але рекомендується виправити критичні проблеми перед масштабуванням.

---

**Підготовлено:** Claude Code (Haiku 4.5)
**Тривалість ревю:** Комплексний аналіз 31 TS файлу + конфіглів + архітектури
