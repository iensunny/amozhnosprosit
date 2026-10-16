# а можно спросить?

Переносимый на Timeweb вариант приложения, восстановленный из действующей версии Cloudflare.

Приложение запускается в Timeweb App Platform на Node.js 22. Данные хранятся
в YDB Serverless в Yandex Cloud.

## Состав

- `public/` — статический интерфейс и брендовые изображения;
- `recovery/cloudflare-worker-2026-10-15.mjs` — сохранённая текущая серверная логика Cloudflare как эталон;
- `server/` — адаптер для запуска этой логики как Node.js-приложения;
- `database/ydb-schema.sql` — схема YDB. Тестовые данные Cloudflare не переносятся.

## Переменные окружения

В секреты Timeweb добавьте `YDB_CONNECTION_STRING`, `YDB_SERVICE_ACCOUNT_KEY`
и `MAX_BOT_TOKEN`. Авторизованный ключ Яндекс Облака не добавляйте в GitHub
или в локальный `.env`.

## Локальный запуск

```sh
npm install
npm start
```
