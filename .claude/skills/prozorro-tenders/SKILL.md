---
name: prozorro-tenders
description: Навичка для роботи з Prozorro Public API — отримання тендерів, контрактів та учасників закупівель
---

# Prozorro Public API — Skill

## Overview

Prozorro — українська система публічних закупівель. Публічний API доступний без авторизації.

**Base URL:** `https://public.api.openprocurement.org/api/2.5`

---

## Ключові ендпоінти

### 1. Список тендерів (пагінація по dateModified)
```
GET /tenders?offset={offset}
```
- `offset` — дата `2025-01-01` або рядок-курсор з попередньої відповіді
- Повертає 100 тендерів за запит, відсортованих по `dateModified`
- `next_page.offset` — курсор для наступної сторінки

### 2. Деталі тендеру
```
GET /tenders/{tender_id}
```
→ Приклад відповіді: `examples/tender.json`

### 3. Деталі контракту (окремий ендпоінт, НЕ вкладений у тендер)
```
GET /contracts/{contract_id}
```
→ Приклад відповіді: `examples/contract.json`

> ⚠️ Об'єкт `contracts[]` всередині тендеру є скороченим. Для повних даних (`dateModified`, `dateCreated`, `dateSigned`, `amountPaid`, `changes`, `documents`) потрібен окремий запит до `/contracts/{id}`.

---

## Важливі нюанси

1. **Пагінація вперед** — тендери відсортовані по `dateModified`. Оновлений тендер з'являється знову в кінці черги → завжди підхоплюємо оновлення.
2. **bids** — доступні тільки після завершення торгів. Під час активної фази — `null` або прихований.
3. **amount = 0** — сума може бути `0` (не `null`). Використовуй `?? null`, НЕ `|| null`.
4. **contracts[].value** — може бути відсутнім у старих даних. Fallback: `contract.amount`.
5. **Rate limit** — публічний API дозволяє ~50 req/s. При перевищенні — 429.
