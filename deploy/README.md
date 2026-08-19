# Развёртывание на сервере (Ubuntu, signalr.zrobim.it)

Приложение — ASP.NET Core (Kestrel) за вашим nginx. nginx терминирует TLS и
проксирует на локальный порт `127.0.0.1:5080` (в т.ч. WebSocket для SignalR).

## Быстрый способ (один скрипт)

На сервере, из корня репозитория, под root:

```bash
sudo ADMIN_PASSWORD='ваш-пароль' bash deploy/deploy.sh
```

Скрипт:
1. поставит .NET 8 SDK (если его нет) через apt;
2. соберёт self-contained сборку в `/opt/signaturekiosk/app` (рантайм внутри — отдельно .NET ставить не нужно);
3. создаст каталог данных `/var/lib/signaturekiosk` и файл `/etc/signaturekiosk.env`;
4. установит и запустит systemd-сервис `signaturekiosk`.

Если `ADMIN_PASSWORD` не передать — сгенерируется случайный и будет напечатан в конце.

## Обратный прокси

У вас **Nginx Proxy Manager** на отдельной машине и уже настроен:
`signalr.zrobim.it` → `http://10.1.1.189:5080`, WebSocket включён, сертификат
Let's Encrypt. Дополнительно ничего делать не нужно. Рекомендуется включить
**«Всегда SSL»** и **HTTP/2**, чтобы планшеты всегда шли по HTTPS/WSS.

Важно (прокси на другой машине):

- приложение слушает `0.0.0.0:5080` (скрипт ставит это в `/etc/signaturekiosk.env`),
  иначе машина с прокси не достучится;
- порт `5080` на этом сервере должен быть доступен с хоста прокси. Если включён ufw:

  ```bash
  sudo ufw allow from <IP_прокси> to any port 5080 proto tcp
  ```

Файл `deploy/nginx-signalr.zrobim.it.conf` в репозитории — на случай, если
когда-нибудь захотите поднять обычный nginx вместо NPM (в вашем случае не нужен).

## Проверка

```bash
systemctl status signaturekiosk
journalctl -u signaturekiosk -f
curl -sS http://127.0.0.1:5080/            # должен вернуть HTML плеера
```

Откройте `https://signalr.zrobim.it/admin` и войдите по паролю.

## Планшеты (freekiosk)

В freekiosk на каждом планшете укажите URL с уникальным `device`:

```
https://signalr.zrobim.it/?device=tablet-1&name=Ресепшн
https://signalr.zrobim.it/?device=tablet-2&name=Кабинет
```

`device` — стабильный идентификатор (по нему в админке выбирается конкретный
планшет), `name` — человекочитаемое имя (можно потом переименовать в админке,
вкладка «Планшеты»). Если параметры не задать, планшет сам сгенерирует id и
запомнит его в localStorage.

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
| Данные (картинки, подписи, состояние) | `/var/lib/signaturekiosk` |
| Настройки (пароль, порт) | `/etc/signaturekiosk.env` |
| systemd-сервис | `/etc/systemd/system/signaturekiosk.service` |

## Настройки в `/etc/signaturekiosk.env`

```ini
AdminPassword=секрет          # пароль в админку
ASPNETCORE_URLS=http://127.0.0.1:5080
DataDir=/var/lib/signaturekiosk
```

После изменения: `systemctl restart signaturekiosk`.
