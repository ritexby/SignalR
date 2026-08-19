# Развёртывание на сервере (Ubuntu, signalr.zrobim.it)

Приложение: ASP.NET Core (Kestrel) за вашим nginx. nginx терминирует TLS и
проксирует на порт `5080` (в т.ч. WebSocket для SignalR).

## Быстрый способ (один скрипт)

На сервере, из корня репозитория, под root:

```bash
sudo ADMIN_PASSWORD='ваш-надёжный-пароль' bash deploy/deploy.sh
```

Скрипт:
1. поставит .NET 10 SDK (если его нет) через apt, с запасным официальным установщиком;
2. скачает клиентские библиотеки (SignalR, signature_pad) через `deploy/fetch-libs.sh`;
3. соберёт self-contained сборку в `/opt/signaturekiosk/app` (рантайм внутри, отдельно .NET ставить не нужно);
4. создаст каталог данных `/var/lib/signaturekiosk` и файл `/etc/signaturekiosk.env`;
5. установит и запустит systemd-сервис `signaturekiosk`.

Пароль обязателен. Сервис не запустится с пустым или дефолтным паролем `admin`.
Если `ADMIN_PASSWORD` не передать, скрипт сгенерирует случайный и напечатает его в конце.

## Обратный прокси

У вас **Nginx Proxy Manager** на отдельной машине и уже настроен:
`signalr.zrobim.it` в `http://10.1.1.189:5080`, WebSocket включён, сертификат
Let's Encrypt. Дополнительно ничего делать не нужно. Рекомендуется включить
**«Всегда SSL»** и **HTTP/2**, чтобы планшеты всегда шли по HTTPS/WSS.

Важно (прокси на другой машине):

- приложение слушает `0.0.0.0:5080` (скрипт ставит это в `/etc/signaturekiosk.env`),
  иначе машина с прокси не достучится;
- порт `5080` на этом сервере должен быть доступен с хоста прокси. Если включён ufw:

  ```bash
  sudo ufw allow from <IP_прокси> to any port 5080 proto tcp
  ```

Файл `deploy/nginx-signalr.zrobim.it.conf` в репозитории на случай, если
когда-нибудь захотите поднять обычный nginx вместо NPM (в вашем случае не нужен).

## Проверка

```bash
systemctl status signaturekiosk
journalctl -u signaturekiosk -f
curl -sS http://127.0.0.1:5080/            # должен вернуть HTML плеера
```

Откройте `https://signalr.zrobim.it/admin` и войдите по паролю.

## Планшеты (freekiosk): активация по коду

Планшеты больше не подключаются через параметры URL. Доступ выдаётся
одноразовым кодом активации, поэтому посторонний планшет не сможет подписаться
на хаб.

1. В админке откройте вкладку **«Планшеты»** и нажмите **«Добавить планшет (код)»**.
   Задайте имя, при желании сразу привяжите рабочее место и группы.
2. Получите код (например `7QF3-K92X`), он действует ограниченное время.
3. В freekiosk на планшете откройте:

   ```
   https://signalr.zrobim.it/
   ```

   и введите код один раз на экране «Активация». Планшет запомнит защищённый
   токен в localStorage. Можно также открыть ссылку `https://signalr.zrobim.it/?enroll=7QF3-K92X`,
   тогда код подставится автоматически.

Заблокировать доступ планшета можно кнопкой **«Заблокировать»** в той же вкладке:
токен сразу перестаёт работать.

## Обновление версии

```bash
git pull
sudo bash deploy/deploy.sh      # пересоберёт и перезапустит сервис
```

Данные (`/var/lib/signaturekiosk`) и пароль (`/etc/signaturekiosk.env`) при этом сохраняются.

## Где что лежит

| Что | Путь |
|-----|------|
| Бинарь приложения | `/opt/signaturekiosk/app/SignatureKiosk` |
| Данные (картинки, подписи, PDF, состояние) | `/var/lib/signaturekiosk` |
| Настройки (пароль, порт) | `/etc/signaturekiosk.env` |
| systemd-сервис | `/etc/systemd/system/signaturekiosk.service` |

Внутри каталога данных: `images/` (картинки рекламы), `signatures/<id>/`
(подпись и метаданные), `pdf/<id>.pdf` (готовые PDF по каждой подписи),
и JSON-файлы состояния (`devices.json`, `groups.json`, `workstations.json`,
`enrollments.json`, `apikeys.json`, `states.json`, `document.json`, `images.json`).

## Настройки в `/etc/signaturekiosk.env`

```ini
AdminPassword=секрет          # пароль в админку (обязателен)
ASPNETCORE_URLS=http://0.0.0.0:5080
DataDir=/var/lib/signaturekiosk
```

После изменения: `systemctl restart signaturekiosk`.
