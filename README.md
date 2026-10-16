# а можно спросить?

Переносимый на Timeweb вариант приложения, восстановленный из действующей версии Cloudflare.

## Состав

- `public/` — статический интерфейс и брендовые изображения;
- `recovery/cloudflare-worker-2026-10-15.mjs` — сохранённая текущая серверная логика Cloudflare как эталон;
- `server/` — адаптер для запуска этой логики как Node.js-приложения;
- `database/schema.sql` — чистая PostgreSQL-схема. Тестовые данные Cloudflare не переносятся.

## Переменные окружения

Скопируйте `.env.example` в `.env` и задайте `DATABASE_URL` и `MAX_BOT_TOKEN`.

## Локальный запуск

```sh
npm install
psql "$DATABASE_URL" -f database/schema.sql
npm start
```
