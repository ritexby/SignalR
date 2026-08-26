#!/usr/bin/env bash
# Прогон одного набора на своём порту и со своим каталогом данных.
#   bash proverki/run_iso_safe.sh <имя_набора> <порт>
#
# Каждый прогон обязан идти на своём порту и со своими данными, иначе наборы затирают друг
# другу состояние и падают не на продукте, а друг на друге.
#
# Окружение (всё необязательно):
#   SK_RABOTA  куда складывать данные и журналы прогонов. По умолчанию <репозиторий>/.proverki
#   SK_CHROME  путь к Chromium для Playwright. Пусто значит «пусть возьмёт свой»
#
# Имена переменных латиницей нарочно: оболочка спотыкается о кириллические имена вида «имя=0».
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="${SK_RABOTA:-$REPO/.proverki}"
SUITE="$1"; PORT="${2:-5093}"; NAME="SkIso$PORT"
DATA="$WORK/data_iso_$PORT"; RUNDIR="$WORK/runbin_iso_$PORT"
mkdir -p "$WORK"
rm -rf "$DATA" "$RUNDIR"; mkdir -p "$DATA" "$RUNDIR"

BIN="$REPO/src/SignatureKiosk/bin/Release/net10.0"
[ -d "$BIN" ] || { echo "НЕТ СБОРКИ: соберите проект (bash proverki/build_lock.sh)"; exit 2; }
cp -r "$BIN/." "$RUNDIR/" || { echo "НЕ СКОПИРОВАЛАСЬ СБОРКА"; exit 2; }
cp -r "$REPO/src/SignatureKiosk/wwwroot" "$RUNDIR/wwwroot"
# Точка входа переименована: чужой pkill по имени службы не заденет этот прогон.
cp "$RUNDIR/SignatureKiosk.dll" "$RUNDIR/$NAME.dll"
cp "$RUNDIR/SignatureKiosk.runtimeconfig.json" "$RUNDIR/$NAME.runtimeconfig.json"
cp "$RUNDIR/SignatureKiosk.deps.json" "$RUNDIR/$NAME.deps.json"

cd "$RUNDIR"
AdminPassword=test123 DataDir="$DATA" ASPNETCORE_URLS="http://127.0.0.1:$PORT" \
  ASPNETCORE_ENVIRONMENT=Production ASPNETCORE_CONTENTROOT="$RUNDIR" \
  nohup dotnet "$RUNDIR/$NAME.dll" > "$WORK/app_iso_$PORT.log" 2>&1 &
APP=$!
# Спящий sleep в переднем плане в некоторых средах не работает, поэтому ждём через curl.
curl -sS --retry 40 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$PORT/healthz" > /dev/null || {
  echo "СЛУЖБА НЕ ЗАПУСТИЛАСЬ (порт $PORT), журнал: $WORK/app_iso_$PORT.log"; kill $APP 2>/dev/null; exit 1; }

cd "$SCRIPT_DIR/nabory"
SK_DATA="$DATA" SK_RABOTA="$WORK" SK_BASE="http://127.0.0.1:$PORT" node "$SUITE.mjs"
code=$?
kill -0 $APP 2>/dev/null || { echo "СЛУЖБА УМЕРЛА ПО ХОДУ НАБОРА: результатам выше верить нельзя"; code=3; }
kill $APP 2>/dev/null
# Копия двоичных файлов весит больше сотни мегабайт. Оставленная после прогона, она копится:
# сто тридцать прогонов подряд забили диск целиком, и наборы начали падать не на продукте, а на
# нехватке места. Данные прогона остаются: по ним разбирают провал.
rm -rf "$RUNDIR"
exit $code
