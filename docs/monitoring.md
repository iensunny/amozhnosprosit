# Сервисная диагностика

Приложение отправляет короткие обезличенные события на `/api/telemetry`. Сохраняются только фиксированные названия этапов, результат, длительность запроса, HTTP-код, версия приложения и тип запуска (`max` или `browser`). MAX ID, ID пары/участника, токены, ссылки-приглашения, тексты вопросов и ответы в этой таблице не сохраняются.

События покрывают загрузку HTML/CSS/JS и вопросов, готовность первого экрана, ответы API, основные шаги создания/принятия пары и отметку разговора. Сервер отдельно фиксирует, принял ли API MAX попытку отправить ежедневное уведомление. `accepted` означает ответ платформы на запрос, а не подтверждение доставки пользователю.

Таблица `telemetry_events` создаётся при старте Node-приложения командой `CREATE TABLE IF NOT EXISTS`. Если у MySQL-пользователя нет права создать таблицу, приложение всё равно запустится, но сбор телеметрии будет отключён; в серверном журнале появится предупреждение. Схема также есть в `database/mysql-schema.sql`. Записи удаляются старше 7 дней.

Чтобы посмотреть сводку в phpMyAdmin, выберите базу приложения и выполните:

```sql
SELECT event_name, stage, result, COUNT(*) AS events,
       ROUND(AVG(duration_ms)) AS avg_ms,
       MAX(duration_ms) AS max_ms,
       MAX(http_status) AS last_http_status
FROM telemetry_events
WHERE created_at >= DATE_FORMAT(UTC_TIMESTAMP() - INTERVAL 24 HOUR, '%Y-%m-%dT%H:%i:%s.000Z')
GROUP BY event_name, stage, result
ORDER BY event_name, stage, result;
```

Для ежедневных уведомлений:

```sql
SELECT LEFT(created_at, 10) AS day, result, COUNT(*) AS attempts
FROM telemetry_events
WHERE event_name = 'notification' AND stage = 'send_daily'
  AND created_at >= DATE_FORMAT(UTC_TIMESTAMP() - INTERVAL 7 DAY, '%Y-%m-%dT%H:%i:%s.000Z')
GROUP BY day, result
ORDER BY day DESC, result;
```

Сбор ограничен фиксированными значениями и 60 событиями в минуту на экземпляр сервера. Если отправка телеметрии не удалась, приложение продолжает работать, а несохранённые события удаляются из памяти.
