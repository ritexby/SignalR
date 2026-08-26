#!/usr/bin/env bash
# Несколько наборов ОДНОВРЕМЕННО, каждый на своём порту и со своим каталогом данных.
#   bash proverki/run_par.sh <первый_порт> <сколько_разом> <набор> [набор...]
#
# Наборы независимы друг от друга по построению, и гонять их по очереди значит ждать сумму, а не
# наибольшее. На четырёх ядрах три одновременно это разумный предел: каждый набор поднимает
# службу и браузер.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="${SK_RABOTA:-$REPO/.proverki}"
mkdir -p "$WORK"
BASEPORT="$1"; shift
LIMIT="$1"; shift
i=0
for n in "$@"; do
  port=$((BASEPORT + i * 2))
  (
    out=$(timeout 1200 bash "$SCRIPT_DIR/run_iso_safe.sh" "$n" "$port" 2>&1 | grep -v "^curl")
    bad=""
    if echo "$out" | grep -qE "^FAIL"; then bad="есть строки FAIL"; fi
    if echo "$out" | grep -qE "ПРОВАЛОВ:? [1-9]"; then bad="счётчик провалов не ноль"; fi
    if echo "$out" | grep -qE "TimeoutError|Cannot read properties|is not defined|ECONNREFUSED"; then
      bad="набор упал с ошибкой"
    fi
    if [ -z "$out" ]; then bad="набор ничего не вывел"; fi
    echo "$out" > "$WORK/out_$n.log"
    if [ -z "$bad" ]; then echo "OK   $n"; else echo "FAIL $n :: $bad"; fi
  ) > "$WORK/par_$n.res" 2>&1 &
  i=$((i + 1))
  while [ "$(jobs -r | wc -l)" -ge "$LIMIT" ]; do wait -n 2>/dev/null || break; done
done
wait
echo "=== ОДНОВРЕМЕННЫЙ ПРОГОН (с порта $BASEPORT, по $LIMIT разом) ==="
echo
for n in "$@"; do cat "$WORK/par_$n.res" 2>/dev/null; done
