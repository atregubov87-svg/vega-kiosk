---
name: vega-kiosk
description: Use when working in the Vega-M info-kiosk repository (Node.js server + touch client). Covers the repository map, running and restarting the service, editing server/client code, bumping static asset versions, updating README, checking health and logs, and preparing a safe commit and push to GitHub.
---

# Инфо-киоск «Вега-М» — рабочий процесс репозитория

## Когда применять

Любая задача в этом репозитории: разобраться в устройстве киоска, запустить или перезапустить сервис, изменить интерфейс или API, обновить документацию, найти ошибку, подготовить и опубликовать изменения.

## Карта репозитория

| Путь | Назначение |
|---|---|
| `server.js` | Node-сервер: API, кэш, снимки, раздача статики |
| `public/index.html` | разметка сцены 1080×1920, плитки и разделы |
| `public/app.js` | клиентская логика: ленты, поиск, расписание, врачи, запись |
| `public/style.css` | оформление, анимации, масштаб сцены |
| `public/assets/`, `public/fonts/` | логотип, документы, Open Sans локально |
| `run_server.ps1` | супервизор: держит `node server.js`, перезапускает через 5 с |
| `install_task.ps1` | регистрация задачи «Vega Kiosk Server» |
| `install_browser.ps1` | настройка Edge в киоск-режиме и политик |
| `docs/` | описание проекта, скриншоты, эксплуатационная памятка |
| `.claude/skills/vega-kiosk/` | этот скилл |

## Как устроено

- Данные: МИС Archimed+, только чтение через четыре вьюхи `v_kiosk_price`, `v_kiosk_schedule`, `v_kiosk_doctors`, `v_kiosk_doctor_photo`.
- Сервер кэширует ленты и пишет снимки в `data/`: прайс 10 минут, расписание 2 минуты, врачи 30 минут.
- При недоступной БД отдаётся последний снимок, клиент показывает жёлтую плашку.
- Клиент — чистый JS без CDN. Сцена `#stage` 1080×1920 масштабируется под экран; `?nofit=1` рисует 1:1 с прокруткой для проверки на обычном мониторе.
- API: `/api/price`, `/api/schedule`, `/api/doctors`, `/api/photo/:id`, `/api/health`, `/api/version`.

## Запуск и перезапуск

Локально:

```powershell
npm install
node server.js
```

- http://localhost:8080 — масштабированный вид;
- http://localhost:8080/?nofit=1 — 1:1 для проверки вёрстки;
- порт меняется через `VEGA_KIOSK_PORT`.

Конфиг БД лежит **вне репозитория**: `~/.claude/tools/db/kiosk_config.json` или путь в `VEGA_KIOSK_CONFIG`. Пароль не копировать в репозиторий и не выводить в чат.

Продакшен:

- задача планировщика **«Vega Kiosk Server»** (AtStartup, S4U) запускает `run_server.ps1`, тот держит `node server.js`;
- `Stop-ScheduledTask` не останавливает `node` — нужно найти процесс `server.js` и завершить его, супервизор поднимет новый;
- журналы: `logs/server.log`, `logs/supervisor.log`, `logs/stdout.log`.

## Проверка ошибок

```powershell
curl http://192.168.88.53:8080/api/health
```

Ожидается `ok:true`, `db:true` и `source` = `db`, `stale` или `snapshot`.

Дополнительно:

- открыть главный экран, прайс, расписание и врачей, посмотреть ошибки в консоли браузера;
- `tail logs/server.log` — новые исключения;
- если изменилась вёрстка — снять скриншот и обновить галерею.

## Внесение изменений

- **Интерфейс:** `public/index.html`, `public/app.js`, `public/style.css`. После правок CSS/JS поднять номер `?v=N` в `index.html` (сейчас `v=70`) — статика кэшируется на час.
- **Сервер/API:** `server.js`. Сохранять существующие эндпоинты и TTL кэша, если не попросили иначе.
- **Данные:** только вьюхи `v_kiosk_*`. Не добавлять доступ к `risk_list` и `polises`. SQL-скрипты и админские утилиты — в `~/.claude/tools/db`, вне репозитория.
- **PowerShell:** `.ps1` с кириллицей сохранять в UTF-8 **с BOM** — PowerShell 5.1 читает UTF-8 без BOM как cp1251.
- **Версия клиента:** `GET /api/version` парсит `?v=N` из `index.html`; клиент сам перезагружается при смене версии. Во время записи или чтения документа перезагрузки нет.

## README

`README.md` держится в формате проектного документа:

1. Название
2. Проблема
3. Пользователь
4. Основная функция — Вход / Обработка / Выход
5. Формат результата
6. Минимальный функционал
7. Технологии
8. Состав репозитория
9. Запуск
10. Безопасность
11. Скриншоты

При добавлении функции обновить раздел 6, карту репозитория и галерею скриншотов, если интерфейс изменился. Текст — по-русски, без паролей и внутренних путей к секретам.

## Подготовка к публикации

1. `git status` — в индекс должны попасть только код и документация.
2. `.gitignore` уже исключает `node_modules/`, `data/`, `logs/`, `docs/dumps/`, `docs/preview/`, `docs/source/`, `*.docx`, `*.log`.
3. Если менялись статические файлы — поднять `?v=N`.
4. Коммит с понятным сообщением на русском и строкой `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
5. `git push origin main`.
6. Проверить, что репозиторий приватный: `gh repo view atregubov87-svg/vega-kiosk --json visibility`.

**Никогда не коммитить:** `kiosk_config.json`, снимки `data/`, журналы, пароли БД, персональные данные пациентов.
