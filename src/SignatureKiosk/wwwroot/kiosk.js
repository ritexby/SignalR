/* Kiosk player: authenticates with a device token, shows a slideshow, runs the
   signing document flow, and can be "identified" on demand. Loaded by freekiosk. */
(function () {
  "use strict";

  var TOKEN_KEY = "sk_device_token";
  var qs = new URLSearchParams(location.search);

  // Токен планшета хранится в двух местах сразу: в localStorage и в cookie. Это одна и та же
  // «жизнь» с точки зрения браузера, но чистятся они разными вызовами Android WebView
  // (clearCache трогает кэш, WebStorage.deleteAllData - хранилище, CookieManager - cookie),
  // поэтому частичная чистка не лишает планшет привязки: недостающее восстанавливается из
  // уцелевшего. Полная чистка данных стирает всё, и планшет придётся активировать заново.
  var TOKEN_DAYS = 3650;

  function readCookie(name) {
    var parts = ("; " + document.cookie).split("; " + name + "=");
    return parts.length === 2 ? decodeURIComponent(parts.pop().split(";").shift()) : null;
  }
  function writeCookie(name, value, days) {
    var attrs = "; path=/; max-age=" + (days * 86400) + "; SameSite=Lax"
      + (location.protocol === "https:" ? "; Secure" : "");
    document.cookie = name + "=" + encodeURIComponent(value) + attrs;
  }

  function getToken() {
    var fromStorage = null;
    try { fromStorage = localStorage.getItem(TOKEN_KEY); } catch (e) { fromStorage = null; }
    var fromCookie = readCookie(TOKEN_KEY);
    var token = fromStorage || fromCookie;
    // Восстанавливаем то, чего не хватает, чтобы следующая чистка снова не осталась
    // единственной копией.
    if (token) {
      if (!fromStorage) { try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* приватный режим */ } }
      if (!fromCookie) writeCookie(TOKEN_KEY, token, TOKEN_DAYS);
    }
    return token;
  }
  function setToken(t) {
    try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* приватный режим */ }
    writeCookie(TOKEN_KEY, t, TOKEN_DAYS);
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* приватный режим */ }
    writeCookie(TOKEN_KEY, "", -1);
  }

  // ---------- Fault reporting ----------
  // Tablet-side failures are sent to the server so they appear on the admin "Логи" tab: a kiosk
  // has nobody watching its console. Reporting is best-effort, throttled, and never throws.
  var recentReports = {};        // message -> last sent timestamp
  var reportBudget = { from: 0, sent: 0 };
  var REPORT_WINDOW_MS = 300000; // 5 minutes
  var REPORT_MAX = 10;           // at most this many reports per window, whatever happens

  function reportError(message, detail, level) {
    try {
      if (!getToken()) return;
      var text = String(message || "");
      if (!text) return;
      var now = Date.now();

      // Suppress the same message repeating within 30 s (a render loop can throw continuously),
      // and cap the total volume so a faulty tablet cannot flood the log or eat the shared
      // per-IP rate limit that /api/sign also uses.
      if (recentReports[text] && now - recentReports[text] < 30000) return;
      if (now - reportBudget.from > REPORT_WINDOW_MS) reportBudget = { from: now, sent: 0 };
      if (reportBudget.sent >= REPORT_MAX) return;
      reportBudget.sent++;

      recentReports[text] = now;
      // Keep the dedup map small: drop entries older than the suppression window.
      var keys = Object.keys(recentReports);
      if (keys.length > 50) keys.forEach(function (k) { if (now - recentReports[k] > 30000) delete recentReports[k]; });
      fetch("/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + getToken() },
        body: JSON.stringify({ level: level || "error", message: text, detail: detail ? String(detail).slice(0, 4000) : null })
      }).catch(function () { /* offline: the failure is transient anyway */ });
    } catch (e) { /* reporting must never break the kiosk */ }
  }

  window.addEventListener("error", function (e) {
    reportError((e && e.message) || "Ошибка на странице планшета", e && e.error && e.error.stack);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    reportError("Необработанная ошибка: " + ((r && r.message) || r || ""), r && r.stack);
  });

  // ---------- DOM ----------
  var el = {
    slideshow: document.getElementById("slideshow"),
    slideA: document.getElementById("slideA"),
    slideB: document.getElementById("slideB"),
    slidesEmpty: document.getElementById("slidesEmpty"),
    document: document.getElementById("document"),
    docTitle: document.getElementById("docTitle"),
    docProgress: document.getElementById("docProgress"),
    docBody: document.getElementById("docBody"),
    docFooter: document.getElementById("docFooter"),
    enroll: document.getElementById("enroll"),
    enrollForm: document.getElementById("enrollForm"),
    enrollCode: document.getElementById("enrollCode"),
    enrollMsg: document.getElementById("enrollMsg"),
    status: document.getElementById("statusOverlay"),
    statusText: document.getElementById("statusText"),
    identify: document.getElementById("identifyOverlay"),
    identifyCode: document.getElementById("identifyCode"),
    identifyName: document.getElementById("identifyName"),
    scan: document.getElementById("scan"),
    scanVideo: document.getElementById("scanVideo"),
    scanMsg: document.getElementById("scanMsg"),
    scanResult: document.getElementById("scanResult"),
    scanCode: document.getElementById("scanCode")
  };

  function showStatus(t) { el.statusText.textContent = t; el.status.classList.remove("hidden"); }
  function hideStatus() { el.status.classList.add("hidden"); }

  // ==================================================================
  // Slideshow
  // ==================================================================
  var slides = { images: [], interval: 6000, index: 0, front: null, timer: null };

  function stopSlides() { if (slides.timer) { clearInterval(slides.timer); slides.timer = null; } }

  function applySlides(payload) {
    clearDocState();
    showLayer("slides");
    stopSlides();
    var images = (payload && payload.images) || [];
    slides.images = images;
    slides.interval = Math.max(1, (payload && payload.intervalSec) || 6) * 1000;
    slides.index = 0;
    // Список рекламы доступен наружу, чтобы его можно было проверить тестом, а не по картинке
    // на экране: в каждый момент видна только одна, а важен весь список.
    window.__slidesForTest = slides.images.slice();
    setTimeout(watchPush, 0);

    el.slideA.classList.remove("show");
    el.slideB.classList.remove("show");

    if (images.length === 0) {
      el.slidesEmpty.classList.remove("hidden");
      el.slideA.removeAttribute("src");
      el.slideB.removeAttribute("src");
      return;
    }
    el.slidesEmpty.classList.add("hidden");

    el.slideA.src = images[0];
    el.slideA.classList.add("show");
    slides.front = "A";

    if (images.length > 1) slides.timer = setInterval(nextSlide, slides.interval);
  }

  function nextSlide() {
    if (slides.images.length < 2) return;
    slides.index = (slides.index + 1) % slides.images.length;
    var url = slides.images[slides.index];
    watchPush();
    var incoming = slides.front === "A" ? el.slideB : el.slideA;
    var outgoing = slides.front === "A" ? el.slideA : el.slideB;
    incoming.src = url;
    requestAnimationFrame(function () {
      incoming.classList.add("show");
      outgoing.classList.remove("show");
      slides.front = slides.front === "A" ? "B" : "A";
    });
  }

  // ==================================================================
  // Signing document flow
  // ==================================================================
  var doc = { config: null, screens: [], index: 0, checks: {}, pad: null, submitting: false, docPadResize: null, idleTimer: null, idleMs: 0, thankTimer: null, session: 0 };

  function applyDocument(config) {
    stopSlides();
    endDocSession();               // cancel any timers from a previous session; invalidates in-flight submits
    showLayer("document");
    doc.config = config || { title: "", pages: [] };
    doc.checks = {};
    doc.picks = {};          // группа -> ключ выбранного варианта ("" = ничего не выбрано)
    doc.signs = {};          // имя поля подписи -> картинка в виде data URL
    doc.signThumbs = {};     // и её уменьшенная копия, только для наблюдателя
    doc.codes = {};          // имя поля сканирования -> { code, format, label }
    doc.pagePads = {};       // имя поля подписи -> перо, чтобы очистить и восстановить
    doc.pad = null;
    doc.submitting = false;
    doc.screens = [];
    (doc.config.pages || []).forEach(function (p, i) {
      doc.screens.push({ type: "page", pageIndex: i });
      // Honour the initial checked state of API-supplied checkboxes.
      (p.checkboxes || []).forEach(function (cb, ci) { if (cb && cb.checked) doc.checks[checkKey(i, ci)] = true; });
      // И выбор в группах, если внешняя система его прислала.
      (p.groups || []).forEach(function (g) { if (g && g.key) doc.picks[g.key] = g.selected || ""; });
    });
    doc.screens.push({ type: "signature" });
    doc.screens.push({ type: "thankyou" });
    doc.index = 0;
    el.docTitle.textContent = doc.config.title || "";
    doc.idleMs = Math.max(0, parseInt(doc.config.idleReturnSec, 10) || 0) * 1000;
    startIdle();
    renderScreen();
  }

  // A monotonic session id lets async callbacks (submit) detect that the document has been
  // replaced or cleared meanwhile and quietly stop, avoiding cross-session jumps / null refs.
  function endDocSession() {
    doc.session++;
    doc.submissionId = null;        // a new signing session must never reuse the previous key
    stopIdle();
    if (doc.thankTimer) { clearTimeout(doc.thankTimer); doc.thankTimer = null; }
  }

  // Idle auto-return: if the signer walks away without signing, go back to ads and let the
  // server clear their data. Any interaction on the document resets the timer.
  function stopIdle() { if (doc.idleTimer) { clearTimeout(doc.idleTimer); doc.idleTimer = null; } }
  function startIdle() { stopIdle(); if (doc.idleMs > 0) doc.idleTimer = setTimeout(onIdle, doc.idleMs); }
  function resetIdle() { if (doc.idleMs > 0 && doc.config) startIdle(); }
  function onIdle() {
    // Privacy first: clear the signer's data from THIS tablet immediately, without waiting for the
    // server. Losing the connection must never leave a client's document on a wall-mounted screen.
    if (!conn) { clearDocState(); showLayer("slides"); return; }
    // Then ask the server to return to ads and clear the stored session too. If that call fails,
    // re-arm so it is retried rather than leaving the tablet in an odd state.
    conn.invoke("FinishDocument").catch(function () { clearDocState(); showLayer("slides"); });
  }

  // Wipe every trace of the signer session from the tablet when returning to ads.
  function clearDocState() {
    endDocSession();
    doc.config = null; doc.screens = []; doc.index = 0; doc.checks = {}; doc.picks = {};
    doc.signs = {}; doc.signThumbs = {}; doc.codes = {}; doc.pagePads = {};
    doc.pad = null; doc.finalInk = ""; doc.submitting = false; doc.docPadResize = null; doc.idleMs = 0;
    el.docBody.innerHTML = ""; el.docFooter.innerHTML = "";
    el.docTitle.textContent = ""; el.docProgress.textContent = "";
  }

  function checkKey(page, idx) { return "p" + page + "_c" + idx; }

  // Условие, которое сервер не смог решить сам, потому что оно зависит от того, что клиент
  // отмечает прямо сейчас. Сервер уже убрал всё, что решается по тегам, поэтому сюда доходят
  // только условия на чекбоксы и группы. Чекбокс в скрытом блоке считается неотмеченным: так
  // взаимные ссылки между блоками разрешаются сами и не могут зациклиться.
  function liveValue(key) {
    if (Object.prototype.hasOwnProperty.call(doc.picks, key)) return doc.picks[key] || "";
    var found = "";
    (doc.config.pages || []).forEach(function (p, pi) {
      (p.checkboxes || []).forEach(function (cb, ci) {
        if (cb && cb.key === key) found = doc.checks[checkKey(pi, ci)] ? "true" : "false";
      });
    });
    return found;
  }

  // Части составного условия: само условие и всё, что присоединено через «и». Выполниться
  // должны все части сразу.
  function condParts(cond) {
    var out = [];
    if (cond && cond.field) out.push(cond);
    ((cond && cond.and) || []).forEach(function (extra) { if (extra && extra.field) out.push(extra); });
    return out;
  }

  // «Не» переворачивает ответ части целиком. Считать это должен тот же код, что и обычную часть,
  // иначе планшет и сервер разошлись бы в понимании одного и того же условия.
  function partHolds(cond) {
    var ok = partValue(cond);
    return cond.not ? !ok : ok;
  }

  function partValue(cond) {
    var val = String(liveValue(cond.field) || "").trim().toLowerCase();
    var target = String(cond.value || "").trim().toLowerCase();
    switch (cond.op) {
      case "ne": return val !== target;
      case "empty": return val.length === 0;
      case "notempty": return val.length > 0;
      case "in": return target.split(",").map(function (x) { return x.trim(); })
        .filter(function (x) { return x.length; }).indexOf(val) >= 0;
      default: return val === target;
    }
  }

  // Наборы условия: само оно со своим «и» и всё, что присоединено через «или». Хватает одного
  // набора, выполненного целиком.
  function condGroups(cond) {
    var out = [];
    if (!cond) return out;
    out.push(cond);
    ((cond && cond.or) || []).forEach(function (alt) { if (alt) out.push(alt); });
    return out;
  }

  function groupHolds(group) {
    var parts = condParts(group);
    for (var i = 0; i < parts.length; i++) if (!partHolds(parts[i])) return false;
    return true;
  }

  function condHolds(cond) {
    if (!cond) return true;
    var groups = condGroups(cond);
    for (var i = 0; i < groups.length; i++) if (groupHolds(groups[i])) return true;
    return false;
  }

  function dependsOn(key) {
    var uses = false;
    function check(c) {
      condGroups(c).forEach(function (group) {
        condParts(group).forEach(function (part) { if (part.field === key) uses = true; });
      });
    }
    (doc.config.pages || []).forEach(function (p) {
      check(p.visibleWhen);
      (p.blocks || []).forEach(function (b) { check(b.visibleWhen); });
      (p.checkboxes || []).forEach(function (c) { check(c.visibleWhen); });
      (p.groups || []).forEach(function (g) { check(g.visibleWhen); });
    });
    (doc.config.signBlocks || []).forEach(function (b) { check(b.visibleWhen); });
    (doc.config.signBlocksBelow || []).forEach(function (b) { check(b.visibleWhen); });
    return uses;
  }

  function visible(list) {
    return (list || []).filter(function (item) { return item && condHolds(item.visibleWhen); });
  }

  // Страница со скрывающим условием не должна показываться. Условие на тег сервер решает сам и
  // такую страницу не присылает, а условие на чекбокс решается здесь, пока клиент отмечает.
  // Раньше такая страница показывалась всё равно, а при отправке её отметки отбрасывались:
  // человек видел страницу, ставил галочки, и они не попадали в запись.
  function screenVisible(screen) {
    if (!screen) return false;
    if (screen.type !== "page") return true;
    var page = doc.config.pages[screen.pageIndex];
    return !!page && condHolds(page.visibleWhen);
  }

  // Ближайший показываемый экран в заданную сторону, начиная со следующего за from.
  function stepIndex(from, dir) {
    for (var i = from + dir; i >= 0 && i < doc.screens.length; i += dir)
      if (screenVisible(doc.screens[i])) return i;
    return -1;
  }

  // Номер шага считается по показываемым экранам, иначе клиент видел бы «Шаг 2 из 5», пролистав
  // всего две страницы из пяти.
  function stepPosition() {
    var shown = 0, current = 0;
    for (var i = 0; i < doc.screens.length; i++) {
      if (doc.screens[i].type === "thankyou" || !screenVisible(doc.screens[i])) continue;
      shown++;
      if (i === doc.index) current = shown;
    }
    return { current: current, total: shown };
  }

  // ---------- Что осталось отметить ----------
  // Кнопка «Далее» остаётся рабочей, а по нажатию система показывает, чего именно не хватает.
  // Выключенная кнопка на нажатие не отвечает ничем: клиент видит серый прямоугольник и не
  // понимает, что от него хотят, а искать одну неотмеченную галочку среди десятка приходится
  // глазами. Здесь наоборот: пропущенное подсвечивается, экран прокручивается к первому из них,
  // и подсказка называет их число.
  function missingOn(pageIndex) {
    var page = doc.config.pages[pageIndex];
    var out = [];
    if (!page) return out;
    (page.checkboxes || []).forEach(function (cb, i) {
      if (cb.required && condHolds(cb.visibleWhen) && !doc.checks[checkKey(pageIndex, i)])
        out.push({ kind: "check", key: checkKey(pageIndex, i) });
    });
    (page.groups || []).forEach(function (g) {
      if (g.required && condHolds(g.visibleWhen) && !(doc.picks[g.key] || ""))
        out.push({ kind: "group", key: g.key || "" });
    });
    (page.signatures || []).forEach(function (sg) {
      if (sg.required && condHolds(sg.visibleWhen) && !(doc.signs[sg.key] || ""))
        out.push({ kind: "sign", key: sg.key || "" });
    });
    (page.scans || []).forEach(function (sc) {
      if (sc.required && condHolds(sc.visibleWhen) && !doc.codes[sc.key])
        out.push({ kind: "scan", key: sc.key || "" });
    });
    return out;
  }

  function clearMiss(node) {
    if (!node) return;
    node.classList.remove("miss");
    var note = node.querySelector(".miss-note");
    if (note) note.remove();
  }

  function clearAllMiss() {
    el.docBody.querySelectorAll(".miss").forEach(clearMiss);
  }

  /// Подсветить пропущенное и подвести к первому. Возвращает, сколько нашлось.
  function showMissing(pageIndex) {
    clearAllMiss();
    var missing = missingOn(pageIndex);
    var first = null;
    missing.forEach(function (m) {
      var attr = m.kind === "check" ? "data-miss-key"
        : m.kind === "group" ? "data-miss-group"
        : m.kind === "sign" ? "data-miss-sign" : "data-miss-scan";
      var node = el.docBody.querySelector('[' + attr + '="' + m.key + '"]');
      if (!node) return;
      node.classList.add("miss");
      var note = document.createElement("div");
      note.className = "miss-note";
      note.textContent = m.kind === "check" ? "Нужно отметить, чтобы продолжить"
        : m.kind === "group" ? "Нужно выбрать один вариант"
        : m.kind === "sign" ? "Нужно расписаться в этом поле"
        : "Нужно отсканировать код";
      node.appendChild(note);
      if (!first) first = node;
    });
    if (first) {
      // Прокручиваем так, чтобы пункт оказался в удобном месте, а не вплотную к краю.
      var box = first.getBoundingClientRect();
      var area = el.docBody.getBoundingClientRect();
      el.docBody.scrollBy({ top: box.top - area.top - 80, behavior: "smooth" });
    }
    return missing.length;
  }

  function requiredSatisfied(pageIndex) {
    var page = doc.config.pages[pageIndex];
    if (!page) return true;
    // Скрытый условием пункт не держит кнопку «Далее»: иначе клиент упирается в галочку,
    // которой не видит, и выйти из документа не может.
    for (var i = 0; i < (page.checkboxes || []).length; i++) {
      var cb = page.checkboxes[i];
      if (cb.required && condHolds(cb.visibleWhen) && !doc.checks[checkKey(pageIndex, i)]) return false;
    }
    for (var g = 0; g < (page.groups || []).length; g++) {
      var grp = page.groups[g];
      if (grp.required && condHolds(grp.visibleWhen) && !(doc.picks[grp.key] || "")) return false;
    }
    for (var si = 0; si < (page.signatures || []).length; si++) {
      var sg = page.signatures[si];
      if (sg.required && condHolds(sg.visibleWhen) && !(doc.signs[sg.key] || "")) return false;
    }
    for (var ci = 0; ci < (page.scans || []).length; ci++) {
      var sc = page.scans[ci];
      if (sc.required && condHolds(sc.visibleWhen) && !doc.codes[sc.key]) return false;
    }
    return true;
  }

  // ==================================================================
  // Наблюдение за экраном: что здесь происходит, видит оператор
  // ==================================================================
  // Картинка не шлётся. У админки есть тот же отрисовщик документа, поэтому достаточно
  // рассказать, что изменилось: экран, страница, отметки, штрихи подписи. Расход измеряется
  // сотнями байт на событие вместо мегабит видео.
  //
  // Планшет молчит, пока за ним никто не смотрит: сервер включает и выключает рассказ.
  // Связь односторонняя: отсюда наверх уходит только состояние, а обратно не приходит ничего.
  var watch = { on: false, timer: null };

  // Наблюдателю уходит уменьшенная копия подписи, а не оригинал. Подпись с настоящего планшета
  // весит сотни килобайт, а сообщение хаба ограничено по размеру, и превышение рвёт соединение:
  // планшет переподключается, получает документ заново и возвращает клиента на первую страницу
  // прямо посреди подписания. Оригинал подписи при этом не трогается: он уходит на сервер
  // обычным запросом и в полном качестве.
  var WATCH_THUMB_W = 320;      // ширина копии для наблюдателя
  var WATCH_THUMB_MAX = 24000;  // и жёсткий предел веса: что не влезло, не отправляется вовсе
  function padThumb(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return "";
    try {
      var k = Math.min(1, WATCH_THUMB_W / canvas.width);
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(canvas.width * k));
      c.height = Math.max(1, Math.round(canvas.height * k));
      var g = c.getContext("2d");
      // На белом, а не на прозрачном: JPEG прозрачности не знает, а он вчетверо легче PNG.
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(canvas, 0, 0, c.width, c.height);
      var out = c.toDataURL("image/jpeg", 0.6);
      return out.length > WATCH_THUMB_MAX ? "" : out;
    } catch (e) { return ""; }
  }

  function watchState() {
    var screen = doc.screens[doc.index];
    var out = { mode: doc.config ? "document" : "slides" };
    if (out.mode === "slides") {
      // Реклама тоже показывается наблюдателю: оператору важно видеть, что на экране идёт
      // именно то, что он поставил. Уходит только адрес картинки, сама она у админки уже есть.
      out.slide = slides.images[slides.index] || "";
      out.slideIndex = slides.index + 1;
      out.slideCount = slides.images.length;
      return out;
    }
    if (scan && scan.active) {
      // Про камеру говорим словами: у наблюдателя никакой камеры не открывается и разрешения
      // не спрашивается, он видит только, что клиент подносит код.
      out.mode = "scan";
      out.scanCode = scan.lastCode || "";
      return out;
    }
    if (!doc.config || !screen) return out;
    out.type = screen.type;
    out.pageIndex = screen.pageIndex != null ? screen.pageIndex : -1;
    var pos = stepPosition();
    out.step = pos.current; out.steps = pos.total;
    out.checks = doc.checks;
    out.picks = doc.picks;
    out.codes = doc.codes;
    // Подписи идут картинками только когда они уже готовы: пока клиент ведёт линию, штрихи
    // догоняют отдельным потоком, иначе на каждое движение уходил бы целый PNG.
    var signs = {};
    Object.keys(doc.signThumbs || {}).forEach(function (k) { if (doc.signThumbs[k]) signs[k] = doc.signThumbs[k]; });
    out.signs = signs;
    if (screen.type === "signature") out.finalInk = doc.finalInk || "";
    out.missing = screen.type === "page"
      ? (missingOn(screen.pageIndex) || []).map(function (m) { return m.kind + ":" + m.key; })
      : [];
    return out;
  }

  function watchPush() {
    if (!watch.on || !conn) return;
    if (watch.timer) return;
    // Пачками, а не на каждое движение: перо даёт до сотни событий в секунду, и без окна
    // канал захлебнулся бы. Десятая доля секунды на глаз неотличима от мгновенного.
    watch.timer = setTimeout(function () {
      watch.timer = null;
      if (!watch.on || !conn) return;
      try {
        var st = watchState();
        // Последняя защита: если сообщение всё-таки распухло, картинки выбрасываются целиком.
        // Наблюдение не должно ронять связь ни при каких обстоятельствах: разрыв посреди
        // подписания возвращает клиента на первую страницу.
        if (JSON.stringify(st).length > 28000) { st.signs = {}; st.finalInk = ""; st.tooBig = true; }
        conn.invoke("ReportScreen", st).catch(function () { /* смотреть перестали */ });
      } catch (e) { /* соединение уже закрыто */ }
    }, 120);
  }

  function renderScreen() {
    watchPush();
    var screen = doc.screens[doc.index];
    if (!screen) return;              // the document was cleared while a callback was in flight
    // Страница могла стать скрытой от только что поставленной галочки: показывать её дальше
    // нельзя, её отметки всё равно не попадут в запись.
    if (!screenVisible(screen)) {
      var to = stepIndex(doc.index, 1);
      if (to < 0) to = stepIndex(doc.index, -1);
      if (to >= 0 && to !== doc.index) { doc.index = to; return renderScreen(); }
    }
    var pos = stepPosition();
    el.docProgress.textContent = screen.type === "thankyou"
      ? "" : "Шаг " + pos.current + " из " + pos.total;
    if (screen.type === "page") return renderPage(screen.pageIndex);
    if (screen.type === "signature") return renderSignature();
    return renderThankYou();
  }

  // Append styled runs to a node using textContent only (never innerHTML), so signer data and
  // template text can never inject markup. \n inside a run becomes a line break.
  // Оформленный текст подписи пункта. Когда оформления нет, из простого текста делается один
  // кусок: дальше всё рисуется одинаково и не приходится разбирать два случая.
  function labelRuns(runs, plain) {
    if (runs && runs.length) return runs;
    return plain ? [{ text: plain }] : [];
  }

  function appendRuns(parent, runs) {
    (runs || []).forEach(function (r) {
      var segs = String(r && r.text != null ? r.text : "").split("\n");
      segs.forEach(function (seg, i) {
        if (i > 0) parent.appendChild(document.createElement("br"));
        if (!seg.length) return;
        var span = document.createElement("span");
        if (r.bold) span.style.fontWeight = "700";
        if (r.italic) span.style.fontStyle = "italic";
        if (r.color && /^#[0-9a-fA-F]{6}$/.test(r.color)) span.style.color = r.color;
        if (r.size === "l") span.className = "rt-l";
        else if (r.size === "h") span.className = "rt-h";
        span.textContent = seg;
        parent.appendChild(span);
      });
    });
  }

  // Render one block: an image (with its width) or styled text.
  function appendBlock(parent, b) {
    if (b && b.imageUrl && /^\/media\/[^/\\]+$/.test(b.imageUrl)) {
      var fig = document.createElement("div"); fig.className = "doc-image";
      // Картинку тоже выравниваем. По умолчанию она стоит по центру: так было всегда, и
      // менять это для документов, где выравнивание не задано, нельзя.
      var ia = (b && b.align || "").toLowerCase();
      if (ia === "right") fig.style.textAlign = "right";
      else if (ia === "center") fig.style.textAlign = "center";
      else if (ia === "justify") fig.style.textAlign = "left";
      // Обтекание: картинка встаёт сбоку, а текст следующих абзацев идёт рядом с ней.
      var wrap = (b && b.wrap || "").toLowerCase();
      if (wrap === "left" || wrap === "right") {
        var зазор = Math.max(0, Math.min(60, parseInt(b.wrapGap, 10) || 0));
        fig.className = "doc-image doc-image-wrap";
        fig.style.cssFloat = wrap;
        fig.style.width = Math.min(Math.max(parseInt(b.imageWidth, 10) || 100, 10), 70) + "%";
        fig.style.textAlign = "";
        fig.style.margin = wrap === "left"
          ? "0 " + зазор + "px " + зазор + "px 0"
          : "0 0 " + зазор + "px " + зазор + "px";
      }
      var im = document.createElement("img"); im.src = b.imageUrl;
      var w = Math.min(Math.max(parseInt(b.imageWidth, 10) || 100, 10), 100);
      im.style.width = (wrap === "left" || wrap === "right") ? "100%" : (w + "%");
      fig.appendChild(im); parent.appendChild(fig);
    } else {
      var text = document.createElement("div"); text.className = "doc-text";
      // Выравнивание задано на весь абзац, а не на кусок текста: так же оно попадёт и в PDF.
      var al = (b && b.align || "").toLowerCase();
      if (al === "center" || al === "right" || al === "justify") text.style.textAlign = al;
      appendRuns(text, (b && b.runs) || []); parent.appendChild(text);
    }
  }

  // Элементы страницы стоят в одном общем порядке: оператор чередует текст, чекбоксы и группы
  // так, как того требует соглашение. У документа, сохранённого до появления свободного порядка,
  // номеров нет, и тогда порядок остаётся прежним: сначала текст, потом чекбоксы, потом группы.
  var ORD_TAIL = 100000;
  function pageItems(page, blocks) {
    var items = [];
    function add(list, kind) {
      (list || []).forEach(function (it, i) {
        if (!it) return;
        var ord = (typeof it.ord === "number" && it.ord >= 0) ? it.ord : ORD_TAIL + kind * ORD_TAIL + i;
        items.push({ ord: ord, kind: kind, index: i, item: it });
      });
    }
    add(blocks, 0);
    add(page.checkboxes, 1);
    add(page.groups, 2);
    add(page.signatures, 3);
    add(page.scans, 4);
    items.sort(function (a, b) { return (a.ord - b.ord) || (a.kind - b.kind) || (a.index - b.index); });
    return items;
  }

  function renderPage(pageIndex) {
    var page = doc.config.pages[pageIndex];
    doc.docPadResize = null;
    var body = document.createElement("div");
    // Подпись и сканирование это отдельные экраны: клиент на них занят одним делом, и место
    // под подпись или под камеру занимает столько, сколько нужно, а не полоску среди текста.
    var kind = (page.kind || "").toLowerCase();
    if (kind === "signature") body.className = "screen-sign";
    else if (kind === "scan") body.className = "screen-scan";

    var hruns = (page.headingRuns && page.headingRuns.length) ? page.headingRuns
      : (page.heading ? [{ text: page.heading }] : []);
    if (hruns.length) {
      var h = document.createElement("h2");
      var ha = (page.headingAlign || "").toLowerCase();
      if (ha === "center" || ha === "right" || ha === "justify") h.style.textAlign = ha;
      appendRuns(h, hruns);
      body.appendChild(h);
    }

    var blocks = (page.blocks && page.blocks.length) ? page.blocks
      : (page.body ? [{ runs: [{ text: page.body }] }] : []);

    // Нажатие меняет то, что показано: блок или пункт может появиться или исчезнуть, поэтому
    // страница перерисовывается целиком, а не правится по месту. Через renderScreen, а не
    // напрямую: от отметки могла измениться и видимость целых страниц, а значит и номер шага,
    // и сама текущая страница могла стать скрытой.
    function rerender() { renderScreen(); }

    function makeCheckbox(cb, i) {
      var key = checkKey(pageIndex, i);
      var label = document.createElement("label");
      label.className = "check" + (doc.checks[key] ? " checked" : "");
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!doc.checks[key];
      input.addEventListener("change", function () {
        doc.checks[key] = input.checked;
        label.classList.toggle("checked", input.checked);
        // Пометка «не отмечено» снимается сразу, как только пункт отметили: человек должен
        // видеть, что список требований тает, а не что подсветка висит до конца.
        if (input.checked) clearMiss(label);
        // Перерисовываем, только если от этого пункта что-то зависит: иначе страница
        // дёргалась бы под пальцем на каждой галочке без всякой причины.
        // Наблюдателю отметка нужна всегда, даже когда от неё на странице ничего не зависит и
        // перерисовки не будет: он должен видеть то же, что клиент, а не через раз.
        watchPush();
        if (cb.key && dependsOn(cb.key)) rerender(); else updateFooter();
      });
      label.setAttribute("data-miss-key", key);
      var span = document.createElement("span");
      span.className = "label";
      // Текст пункта оформляется так же, как обычный абзац: жирный, курсив, цвет, размер.
      appendRuns(span, labelRuns(cb.labelRuns, cb.label || ""));
      if (cb.required) {
        var req = document.createElement("span");
        req.className = "req"; req.textContent = "*";
        span.appendChild(req);
      }
      label.appendChild(input);
      label.appendChild(span);
      return label;
    }

    // Группы: выбрать можно один вариант, и «ни одного» это тоже состояние. Поэтому это
    // чекбоксы, а не радиокнопки: нажатие по уже выбранному снимает выбор.
    function makeGroup(g) {
      var box = document.createElement("div");
      box.className = "group";
      if (g.title) {
        var t = document.createElement("div");
        t.className = "group-title";
        appendRuns(t, labelRuns(g.titleRuns, g.title));
        if (g.required) {
          var req = document.createElement("span");
          req.className = "req"; req.textContent = "*";
          t.appendChild(req);
        }
        box.appendChild(t);
      }
      box.setAttribute("data-miss-group", g.key || "");
      var opts = document.createElement("div");
      // Варианты стоят в одну строку: их два или три, они короткие («ДА», «НЕТ»), и в столбик
      // они занимали пол-экрана впустую, отрывая ответ от вопроса. Вопрос при этом остаётся
      // сверху. Если варианты длинные или их много, строка переносится сама.
      opts.className = "checks group-options";
      (g.options || []).forEach(function (o) {
        var chosen = (doc.picks[g.key] || "") === o.key;
        var label = document.createElement("label");
        label.className = "check" + (chosen ? " checked" : "");
        var input = document.createElement("input");
        input.type = "checkbox";
        input.checked = chosen;
        input.addEventListener("change", function () {
          doc.picks[g.key] = (doc.picks[g.key] || "") === o.key ? "" : o.key;
          rerender();
        });
        var span = document.createElement("span");
        span.className = "label";
        appendRuns(span, labelRuns(o.labelRuns, o.label || o.key || ""));
        label.appendChild(input);
        label.appendChild(span);
        opts.appendChild(label);
      });
      box.appendChild(opts);
      return box;
    }

    // Идущие подряд чекбоксы собираются в один блок: между ними должен быть тесный отступ,
    // а не такой же, как между чекбоксом и абзацем текста.
    var checks = null;
    function checksBox() {
      if (!checks) { checks = document.createElement("div"); checks.className = "checks"; body.appendChild(checks); }
      return checks;
    }
    pageItems(page, blocks).forEach(function (it) {
      if (!condHolds(it.item.visibleWhen)) return;
      if (it.kind === 1) { checksBox().appendChild(makeCheckbox(it.item, it.index)); return; }
      checks = null;
      if (it.kind === 0) appendBlock(body, it.item);
      else if (it.kind === 2) body.appendChild(makeGroup(it.item));
      else if (it.kind === 3) body.appendChild(makePageSignature(it.item));
      else body.appendChild(makePageScan(it.item));
    });

    // Поле подписи внутри страницы. Документ может требовать несколько подписей: согласие,
    // отдельное согласие законного представителя, подтверждение отказа. Каждое поле хранит свою
    // картинку и своё имя, поэтому в записи и в PDF видно, что именно подписано.
    function makePageSignature(sig) {
      var box = document.createElement("div");
      box.className = "page-sign";
      box.setAttribute("data-miss-sign", sig.key || "");
      if (sig.label) {
        var t = document.createElement("div");
        t.className = "page-sign-title";
        t.textContent = sig.label;
        if (sig.required) {
          var req = document.createElement("span");
          req.className = "req"; req.textContent = "*";
          t.appendChild(req);
        }
        box.appendChild(t);
      }
      var wrap = document.createElement("div");
      wrap.className = "sign-wrap page-sign-wrap";
      // Размер и положение места подписи заданы у поля, в точках, как и в PDF. На экране
      // подписи размер не применяется: там поле занимает весь экран, в этом и смысл отдельного
      // экрана, а сжимать его до полоски значило бы отменить его назначение.
      var экран = (page.kind || "").toLowerCase() === "signature";
      if (!экран) {
        var ш = Math.max(60, Math.min(495, parseInt(sig.width, 10) || 280));
        var в = Math.max(40, Math.min(300, parseInt(sig.height, 10) || 100));
        // Точка листа на планшете шире точки PDF: доля от ширины текста на A4 (495 точек)
        // сохраняет пропорцию, а не привязывает поле к бумажным миллиметрам.
        wrap.style.width = Math.round(ш / 495 * 1000) / 10 + "%";
        wrap.style.height = Math.round(в * 1.9) + "px";
        var са = (sig.align || "").toLowerCase();
        if (са === "right") { wrap.style.marginLeft = "auto"; wrap.style.marginRight = "0"; }
        else if (са === "center") { wrap.style.marginLeft = "auto"; wrap.style.marginRight = "auto"; }
        else { wrap.style.marginLeft = "0"; wrap.style.marginRight = "auto"; }
      }
      var canvas = document.createElement("canvas");
      wrap.appendChild(canvas);
      var line = document.createElement("div"); line.className = "sign-line"; wrap.appendChild(line);
      var hint = document.createElement("div"); hint.className = "sign-hint"; hint.textContent = "Распишитесь здесь"; wrap.appendChild(hint);
      box.appendChild(wrap);

      var clear = document.createElement("button");
      clear.className = "btn btn-ghost page-sign-clear"; clear.type = "button"; clear.textContent = "Очистить";
      clear.addEventListener("click", function () {
        var pad = doc.pagePads[sig.key];
        if (pad) {
          pad.clear(); doc.signs[sig.key] = ""; doc.signThumbs[sig.key] = "";
          wrap.classList.remove("has-ink"); updateFooter();
          // Иначе у наблюдателя осталась бы подпись, которой уже нет.
          watchPush();
        }
      });
      box.appendChild(clear);

      // Планшет мог уже получить эту подпись раньше: возвращаясь назад, человек должен видеть
      // то, что уже нарисовал, а не пустое поле.
      setTimeout(function () { mountPad(sig, canvas, wrap); }, 0);
      return box;
    }

    function mountPad(sig, canvas, wrap) {
      var ratio = Math.max(window.devicePixelRatio || 1, 1);
      var rect = wrap.getBoundingClientRect();
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      canvas.getContext("2d").scale(ratio, ratio);
      var pad = new SignaturePad(canvas, { minWidth: 1.2, maxWidth: 3.2, penColor: "#111827", throttle: 0, minDistance: 0 });
      attachCoalesced(canvas);
      doc.pagePads[sig.key] = pad;
      var saved = doc.signs[sig.key];
      if (saved) { try { pad.fromDataURL(saved); wrap.classList.add("has-ink"); } catch (e) { /* не восстановилась */ } }
      pad.addEventListener("endStroke", function () {
          doc.signs[sig.key] = pad.isEmpty() ? "" : pad.toDataURL("image/png");
        doc.signThumbs[sig.key] = pad.isEmpty() ? "" : padThumb(canvas);
        watchPush();
        wrap.classList.toggle("has-ink", !pad.isEmpty());
        if (!pad.isEmpty()) clearMiss(wrap.closest(".page-sign"));
        updateFooter();
      });
    }

    // Сканирование кода прямо на странице: клиент подносит штрихкод пробирки или QR из
    // направления, и код попадает в запись подписи рядом с тем, что он подписал.
    function makePageScan(sc) {
      var box = document.createElement("div");
      box.className = "page-scan";
      box.setAttribute("data-miss-scan", sc.key || "");
      var t = document.createElement("div");
      t.className = "page-scan-title";
      t.textContent = sc.label || "Отсканируйте код";
      if (sc.required) {
        var req = document.createElement("span");
        req.className = "req"; req.textContent = "*";
        t.appendChild(req);
      }
      box.appendChild(t);

      var value = document.createElement("div");
      value.className = "page-scan-value";
      var btn = document.createElement("button");
      btn.className = "btn btn-primary page-scan-btn"; btn.type = "button";

      function sync() {
        var got = doc.codes[sc.key];
        value.textContent = got ? got.code : "";
        value.classList.toggle("hidden", !got);
        btn.textContent = got ? "Сканировать заново" : "Сканировать код";
        box.classList.toggle("scanned", !!got);
      }
      btn.addEventListener("click", function () {
        startScan({ label: sc.label, onCode: function (code, format) {
          doc.codes[sc.key] = { code: code, format: format || "", label: sc.label || "" };
          sync();
          clearMiss(box);
          updateFooter();
        } });
      });
      box.appendChild(value);
      box.appendChild(btn);
      sync();
      return box;
    }

    el.docBody.innerHTML = "";
    el.docBody.appendChild(body);
    renderFooter({ back: doc.index > 0, next: true, nextLabel: "Далее" });
  }

  // Между двумя кадрами планшет успевает снять несколько точек пера, и браузер отдаёт их не
  // отдельными событиями, а внутри getCoalescedEvents последнего. Без них быстрый росчерк
  // рисуется парой прямых срезов вместо кривой. Слушатель висит на самом холсте, а библиотека
  // слушает window, поэтому промежуточные точки успевают дойти до неё раньше основного события
  // и порядок не нарушается. Нужен и итоговому полю подписи, и полям внутри страниц.
  var MAX_COALESCED = 32;   // защита от патологического всплеска событий
  function attachCoalesced(canvas) {
    var replaying = false;  // точки, разосланные здесь же, повторно разбирать не нужно
    canvas.addEventListener("pointermove", function (e) {
      if (replaying || typeof e.getCoalescedEvents !== "function") return;
      var pts;
      try { pts = e.getCoalescedEvents(); } catch (err) { return; }
      if (!pts || pts.length < 2) return;                 // последняя точка это само событие
      var start = Math.max(0, pts.length - 1 - MAX_COALESCED);
      replaying = true;
      try {
        for (var i = start; i < pts.length - 1; i++) {
          var c = pts[i];
          canvas.dispatchEvent(new PointerEvent("pointermove", {
            clientX: c.clientX, clientY: c.clientY,
            pressure: c.pressure, pointerId: e.pointerId, pointerType: e.pointerType,
            buttons: 1, bubbles: true, cancelable: false
          }));
        }
      } finally { replaying = false; }   // рассылка синхронная, флаг всегда снимается
    }, true);
  }

  function renderSignature() {
    doc.docPadResize = null;
    var body = document.createElement("div");
    body.className = "sign-screen";

    // Custom signature-page content (text / images) authored in the admin, above the pad.
    var sblocks = visible(doc.config.signBlocks);
    if (sblocks.length) {
      var custom = document.createElement("div"); custom.className = "sign-custom";
      sblocks.forEach(function (b) { appendBlock(custom, b); });
      body.appendChild(custom);
    }

    var prompt = document.createElement("div");
    prompt.className = "sign-prompt";
    prompt.textContent = doc.config.signPrompt || "Пожалуйста, поставьте вашу подпись ниже";
    body.appendChild(prompt);

    var wrap = document.createElement("div");
    wrap.className = "sign-wrap";
    var canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    var line = document.createElement("div"); line.className = "sign-line"; wrap.appendChild(line);
    var hint = document.createElement("div"); hint.className = "sign-hint"; hint.textContent = "Распишитесь здесь"; wrap.appendChild(hint);
    body.appendChild(wrap);

    // The same kind of custom content, but under the signature field.
    var sbelow = visible(doc.config.signBlocksBelow);
    if (sbelow.length) {
      var below = document.createElement("div"); below.className = "sign-custom sign-custom-below";
      sbelow.forEach(function (b) { appendBlock(below, b); });
      body.appendChild(below);
    }

    el.docBody.innerHTML = "";
    el.docBody.appendChild(body);

    function sizeCanvas() {
      var ratio = Math.max(window.devicePixelRatio || 1, 1);
      var rect = wrap.getBoundingClientRect();
      // Preserve a signature already drawn: resizing a canvas clears it, and an Android WebView
      // resizes on rotation or when a system bar appears. Losing the stroke mid-signing is worse
      // than a slight rescale.
      var strokes = null;
      try { if (doc.pad && !doc.pad.isEmpty()) strokes = doc.pad.toData(); } catch (e) { strokes = null; }
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      canvas.getContext("2d").scale(ratio, ratio);
      if (doc.pad) {
        doc.pad.clear();
        if (strokes && strokes.length) {
          try { doc.pad.fromData(strokes); hint.style.display = "none"; } catch (e) { /* keep it cleared */ }
        }
      }
    }
    // Стилус опрашивается заметно чаще, чем обновляется экран, а библиотека по умолчанию
    // выбрасывает точки ближе 5 пикселей к предыдущей и обрабатывает движение не чаще раза
    // в 16 мс. Из-за этого линия тянется за наконечником: до 5 пикселей отставания на медленном
    // росчерке, что при подписи и есть основной режим. Обе задержки убраны.
    doc.pad = new SignaturePad(canvas, {
      minWidth: 1.2, maxWidth: 3.2, penColor: "#111827",
      throttle: 0,        // рисовать каждое движение сразу, без окна в 16 мс
      minDistance: 0      // не выбрасывать близкие точки: именно они дают отставание от пера
    });

    attachCoalesced(canvas);
    // Настройки пера доступны наружу, чтобы их можно было проверить тестом, а не на глаз.
    window.__padForTest = doc.pad;
    doc.pad.addEventListener("beginStroke", function () { hint.style.display = "none"; });
    doc.pad.addEventListener("endStroke", function () {
      updateFooter();
      // Итоговая подпись уходит наблюдателю такой, какая она уже нарисована. Не на каждое
      // движение пера, а по концу штриха: так линия появляется у оператора почти сразу, а
      // канал не забивается сотней картинок в секунду.
      doc.finalInk = doc.pad.isEmpty() ? "" : padThumb(canvas);
      watchPush();
    });
    sizeCanvas();
    // Re-measure once the flex layout has settled so the pad fills its final size.
    requestAnimationFrame(sizeCanvas);
    doc.docPadResize = sizeCanvas;

    renderFooter({ back: doc.index > 0, clear: true, sign: true });
  }

  function renderThankYou() {
    doc.docPadResize = null;
    stopIdle();
    doc.idleMs = 0;                 // no idle timer on the thank-you screen (a touch must not re-arm it)
    el.docProgress.textContent = "";
    var thanks = (doc.config && doc.config.thankYouText) || "Спасибо!";
    var runs = labelRuns(doc.config && doc.config.thankYouRuns, thanks);
    var align = (doc.config && doc.config.thankYouAlign) || "";
    var blocks = (doc.config && doc.config.thankYouBlocks) || [];
    var держать = (doc.config && doc.config.thankYouSec) || 6;
    // PRIVACY: the title may contain the signer's data (for example "Согласие {{ФИО}}"), so it is
    // wiped as soon as signing is done, together with the resolved document held in memory. Only
    // the thank-you page survives on screen: она собрана оператором и личных данных не несёт.
    el.docTitle.textContent = "";
    doc.config = { thankYouText: thanks, thankYouRuns: runs, thankYouBlocks: blocks,
      thankYouAlign: align, thankYouSec: держать, pages: [] };
    doc.checks = {};
    var body = document.createElement("div");
    body.className = "thankyou";
    var mark = document.createElement("div"); mark.className = "mark"; body.appendChild(mark);
    var h = document.createElement("h2");
    if (align === "center" || align === "right" || align === "justify") h.style.textAlign = align;
    appendRuns(h, runs);
    body.appendChild(h);
    // Страница благодарности собирается как обычная: текст и картинки с тем же оформлением.
    blocks.forEach(function (b) { appendBlock(body, b); });
    el.docBody.innerHTML = "";
    el.docBody.appendChild(body);
    el.docFooter.innerHTML = "";
    if (doc.thankTimer) clearTimeout(doc.thankTimer);
    // Always leave the thank-you screen, even if the server cannot be reached: fall back to the
    // local slideshow so the tablet never sits on a dead-end screen.
    doc.thankTimer = setTimeout(function () {
      doc.thankTimer = null;
      if (conn) conn.invoke("FinishDocument").catch(function () { clearDocState(); showLayer("slides"); });
      else { clearDocState(); showLayer("slides"); }
    }, Math.max(2, Math.min(60, держать)) * 1000);
  }

  function renderFooter(opts) {
    el.docFooter.innerHTML = "";

    var back = document.createElement("button");
    back.className = "btn btn-ghost"; back.textContent = "Назад";
    back.disabled = !opts.back || stepIndex(doc.index, -1) < 0;
    back.addEventListener("click", function () {
      var to = stepIndex(doc.index, -1);
      if (to >= 0) { doc.index = to; renderScreen(); }
    });
    el.docFooter.appendChild(back);

    var note = document.createElement("div");
    note.className = "footer-note"; note.id = "footerNote";
    el.docFooter.appendChild(note);

    if (opts.clear) {
      var clear = document.createElement("button");
      clear.className = "btn btn-ghost"; clear.textContent = "Очистить";
      clear.addEventListener("click", function () {
        if (!doc.pad) return;
        doc.pad.clear();
        doc.finalInk = "";
        updateFooter();
        watchPush();
      });
      el.docFooter.appendChild(clear);
    }
    if (opts.next) {
      var next = document.createElement("button");
      next.className = "btn btn-primary"; next.id = "btnNext"; next.textContent = opts.nextLabel || "Далее";
      next.addEventListener("click", function () {
        var screen = doc.screens[doc.index];
        if (screen.type === "page" && !requiredSatisfied(screen.pageIndex)) {
          // Не молчим и не блокируем кнопку: показываем, что именно осталось отметить.
          var n = showMissing(screen.pageIndex);
          var note = document.getElementById("footerNote");
          if (note) note.textContent = n === 1
            ? "Отметьте выделенный пункт, чтобы продолжить"
            : "Отметьте выделенные пункты: осталось " + n;
          return;
        }
        var to = stepIndex(doc.index, 1);
        if (to >= 0) { doc.index = to; renderScreen(); }
      });
      el.docFooter.appendChild(next);
    }
    if (opts.sign) {
      var sign = document.createElement("button");
      sign.className = "btn btn-sign"; sign.id = "btnSign"; sign.textContent = "ПОДПИСАТЬ";
      sign.addEventListener("click", function () {
        if (!doc.pad || doc.pad.isEmpty()) {
          var wrap = el.docBody.querySelector(".sign-wrap");
          if (wrap) {
            wrap.classList.add("miss");
            setTimeout(function () { wrap.classList.remove("miss"); }, 2000);
          }
          var note = document.getElementById("footerNote");
          if (note) note.textContent = "Поставьте подпись в выделенном поле";
          return;
        }
        submitSignature();
      });
      el.docFooter.appendChild(sign);
    }
    updateFooter();
  }

  function updateFooter() {
    var screen = doc.screens[doc.index];
    var note = document.getElementById("footerNote");
    var next = document.getElementById("btnNext");
    var sign = document.getElementById("btnSign");
    if (screen.type === "page" && next) {
      // Кнопка остаётся рабочей: по нажатию она объясняет, чего не хватает, и подсвечивает
      // это на экране. Выключенная кнопка не отвечает ничем, и человек остаётся один на один
      // с серым прямоугольником.
      var ok = requiredSatisfied(screen.pageIndex);
      next.disabled = false;
      next.classList.toggle("btn-wait", !ok);
      if (note && !el.docBody.querySelector(".miss"))
        note.textContent = ok ? "" : "Отметьте обязательные пункты (*)";
      if (ok) clearAllMiss();
    }
    if (screen.type === "signature" && sign) {
      var empty = !doc.pad || doc.pad.isEmpty();
      sign.disabled = doc.submitting;
      sign.classList.toggle("btn-wait", empty);
      if (note) note.textContent = empty ? "Поставьте подпись в поле выше" : "";
    }
  }

  // В запись уходит только то, что клиент действительно видел: скрытый условием пункт нельзя
  // считать ни отмеченным, ни сознательно пропущенным.
  // Порядок отметок в записи и в PDF должен совпадать с тем, в каком клиент видел их на экране:
  // пункт относится к абзацу над ним, и переставленный список читался бы уже про другое.
  function collectItems() {
    var items = [];
    (doc.config.pages || []).forEach(function (page, pi) {
      if (!condHolds(page.visibleWhen)) return;
      pageItems(page, page.blocks || []).forEach(function (it) {
        if (it.kind !== 1 || !condHolds(it.item.visibleWhen)) return;
        items.push({ key: it.item.key || "", label: it.item.label, checked: !!doc.checks[checkKey(pi, it.index)] });
      });
    });
    return items;
  }

  // Подписи, поставленные внутри страниц. В запись идёт только то, что клиент видел: подпись
  // в скрытом условием поле не считается поставленной.
  function collectSignatures() {
    var out = [];
    (doc.config.pages || []).forEach(function (page) {
      if (!condHolds(page.visibleWhen)) return;
      (page.signatures || []).forEach(function (sg) {
        if (!condHolds(sg.visibleWhen)) return;
        var img = doc.signs[sg.key] || "";
        if (!img) return;
        out.push({ key: sg.key || "", label: sg.label || "", image: img });
      });
    });
    return out;
  }

  function collectScans() {
    var out = [];
    (doc.config.pages || []).forEach(function (page) {
      if (!condHolds(page.visibleWhen)) return;
      (page.scans || []).forEach(function (sc) {
        if (!condHolds(sc.visibleWhen)) return;
        var got = doc.codes[sc.key];
        if (!got) return;
        out.push({ key: sc.key || "", label: sc.label || "", code: got.code || "", format: got.format || "" });
      });
    });
    return out;
  }

  function collectGroups() {
    var groups = [];
    (doc.config.pages || []).forEach(function (page) {
      if (!condHolds(page.visibleWhen)) return;
      var ordered = pageItems(page, []).filter(function (it) { return it.kind === 2; }).map(function (it) { return it.item; });
      visible(ordered).forEach(function (g) {
        var selected = doc.picks[g.key] || "";
        var chosen = (g.options || []).filter(function (o) { return o.key === selected; })[0];
        groups.push({
          key: g.key || "",
          title: g.title || "",
          selected: selected,
          selectedLabel: chosen ? (chosen.label || chosen.key) : "",
          options: (g.options || []).map(function (o) { return { key: o.key, label: o.label }; })
        });
      });
    });
    return groups;
  }

  function submitSignature() {
    if (doc.submitting || !doc.pad || doc.pad.isEmpty()) return;
    doc.submitting = true;
    var session = doc.session;     // this signing session; abandon the callbacks if it changed
    updateFooter();
    // One id per signing session: if the response is lost and the signer presses ПОДПИСАТЬ again,
    // the server recognises the retry and returns the record it already stored instead of writing
    // a second, data-less one.
    if (!doc.submissionId) doc.submissionId = "s" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    fetch("/api/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (getToken() || "") },
      body: JSON.stringify({ items: collectItems(), groups: collectGroups(),
        signatures: collectSignatures(), scans: collectScans(),
        signature: doc.pad.toDataURL("image/png"), submissionId: doc.submissionId })
    }).then(function (r) {
      if (doc.session !== session) return;          // document was replaced/cleared while sending
      if (r.ok) {
        doc.index = doc.screens.length - 1;
        renderScreen();
        return;
      }
      // Сообщение должно соответствовать тому, что произошло. Повтор помогает только при
      // временном сбое связи. Если сессия уже закрыта или планшет отвязан, предлагать
      // «попробуйте ещё раз» значит заставлять человека жать кнопку, которая не сработает
      // никогда.
      var err = new Error("bad status " + r.status);
      err.status = r.status;
      err.permanent = r.status === 401 || r.status === 403 || r.status === 409;
      throw err;
    }).catch(function (err) {
      // A failed signature is the worst failure for the client, so it is always reported.
      reportError("Не удалось отправить подпись", err && (err.stack || err.message || String(err)));
      if (doc.session !== session) return;
      var note = document.getElementById("footerNote");
      if (err && err.permanent) {
        // Кнопку не возвращаем: нажимать её бессмысленно, а нарисованная подпись остаётся
        // на экране, чтобы сотрудник видел, что человек расписался.
        if (note) note.textContent = err.status === 409
          ? "Сессия подписания уже завершена. Обратитесь к сотруднику: документ нужно отправить заново."
          : "Планшет потерял доступ. Обратитесь к сотруднику.";
        return;
      }
      doc.submitting = false;
      updateFooter();                               // re-enable the button first...
      if (note) note.textContent = "Не удалось отправить: нет связи с сервером. Нажмите ПОДПИСАТЬ ещё раз."; // ...then show the error so it is not wiped
    });
  }

  window.addEventListener("resize", function () { if (doc.docPadResize) doc.docPadResize(); });
  ["pointerdown", "keydown"].forEach(function (ev) {
    el.document.addEventListener(ev, resetIdle, true);
  });

  // ==================================================================
  // Identify overlay
  // ==================================================================
  var identifyTimer = null;
  function showIdentify(code, name) {
    el.identifyCode.textContent = code || "";
    el.identifyName.textContent = name || "";
    el.identify.classList.remove("hidden");
    clearTimeout(identifyTimer);
    identifyTimer = setTimeout(function () { el.identify.classList.add("hidden"); }, 6000);
  }

  // ==================================================================
  // Layers
  // ==================================================================
  function showLayer(which) {
    el.enroll.classList.add("hidden");
    // Смена экрана это то, что наблюдателю надо увидеть первым делом.
    setTimeout(watchPush, 0);
    // Any layer switch ends scanning: the camera must never keep running behind another screen.
    if (which !== "scan") stopScan();
    el.scan.classList.toggle("hidden", which !== "scan");
    if (which === "slides") {
      el.document.classList.add("hidden");
      el.slideshow.classList.remove("hidden");
    } else if (which === "scan") {
      el.document.classList.add("hidden");
      el.slideshow.classList.add("hidden");
    } else {
      el.slideshow.classList.add("hidden");
      el.document.classList.remove("hidden");
    }
  }

  // ==================================================================
  // Barcode / QR scanning (QR, EAN-13, EAN-8, Code-128)
  // ==================================================================
  // The camera runs only while the scan screen is open: it is started by an explicit operator
  // command and always stopped when the screen closes, so the tablet never films silently.
  // gen invalidates a camera that is still starting when scanning has already been stopped, so a
  // stream can never be attached after the fact and keep filming behind another screen.
  // Только передняя камера. Планшет висит лицом к клиенту, код показывают в неё, и выбор
  // камеры на экране только сбивал: нажав «другая камера», человек видел пустой кадр с
  // обратной стороны планшета и решал, что сканирование сломалось.
  var scan = { controls: null, active: false, doneTimer: null, capTimer: null, gen: 0, facing: "user", inline: null };
  var SCAN_MAX_MS = 90000;   // hard local cap: never film longer than this without a result

  function clearScanResult() {
    el.scanCode.textContent = "";
    el.scanResult.classList.add("hidden");
  }

  function stopScan() {
    scan.inline = null;
    scan.gen++;                                   // invalidate any camera start still in flight
    if (scan.doneTimer) { clearTimeout(scan.doneTimer); scan.doneTimer = null; }
    if (scan.capTimer) { clearTimeout(scan.capTimer); scan.capTimer = null; }
    if (scan.controls) { try { scan.controls.stop(); } catch (e) { /* already stopped */ } scan.controls = null; }
    // Release the camera track explicitly: some WebViews keep the light on otherwise.
    var v = el.scanVideo;
    if (v && v.srcObject) {
      try { v.srcObject.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
      v.srcObject = null;
    }
    scan.active = false;
    clearScanResult();                            // never leave one client's code on screen
  }

  // Leaving the scan screen must never depend on the server: if the hub is unreachable the tablet
  // would otherwise sit on a black screen forever with no way out. Fall back to what it should be
  // showing locally (the open document, or ads), and re-arm the document's idle timer.
  function leaveScan() {
    stopScan();
    if (doc.config && doc.screens && doc.screens.length) {
      showLayer("document");
      renderScreen();
      startIdle();
    } else {
      clearDocState();
      showLayer("slides");
    }
  }

  function finishScanOrLeave() {
    if (conn) conn.invoke("FinishScan").catch(leaveScan);
    else leaveScan();
  }

  // ZXing hint keys, by value: the browser bundle does not export the DecodeHintType enum.
  var HINT_POSSIBLE_FORMATS = 2;
  var HINT_TRY_HARDER = 3;

  /// opts.onCode: сканирование вызвано элементом страницы, код возвращается ему, и планшет
  /// возвращается к документу. Без opts это привычное сканирование по команде оператора.
  function startScan(opts) {
    if (scan.active) return;
    scan.lastCode = "";
    scan.inline = (opts && typeof opts.onCode === "function") ? opts.onCode : null;
    if (scan.doneTimer) { clearTimeout(scan.doneTimer); scan.doneTimer = null; }  // stale "return" timer
    clearScanResult();
    if (!window.ZXingBrowser || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showLayer("scan");
      el.scanMsg.textContent = "Сканирование недоступно на этом устройстве.";
      reportError("Сканирование недоступно: нет камеры или библиотеки");
      // Show the reason briefly, then go back: a kiosk must never be left on a dead screen.
      scan.doneTimer = setTimeout(function () { scan.doneTimer = null; finishScanOrLeave(); }, 5000);
      return;
    }
    scan.active = true;
    var gen = ++scan.gen;
    showLayer("scan");
    // The document's idle timer must not fire while the client is holding a code to the camera.
    stopIdle();
    el.scanMsg.textContent = "Запуск камеры…";
    scan.capTimer = setTimeout(function () {
      scan.capTimer = null;
      if (!scan.active) return;
      finishScanOrLeave();
    }, SCAN_MAX_MS);

    var hints = new Map();
    try {
      var ZX = window.ZXing || window.ZXingBrowser;
      // The @zxing/browser bundle exports BarcodeFormat but NOT DecodeHintType, so the hint keys
      // are given by value. They are a fixed part of the ZXing wire format: POSSIBLE_FORMATS is 2
      // and TRY_HARDER is 3. Without this the reader ran with no hints at all, which is why a
      // barcode held to the camera was never picked up.
      if (ZX && ZX.BarcodeFormat) {
        // ITF это чередующийся 2 из 5: линейный, только цифры и только чётное их количество,
        // им маркируют транспортную упаковку и пробирки. Data Matrix это двумерный код,
        // которым метят пробирки и реагенты там, где для QR не хватает места.
        hints.set(HINT_POSSIBLE_FORMATS, [
          ZX.BarcodeFormat.QR_CODE, ZX.BarcodeFormat.DATA_MATRIX,
          ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8,
          ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.ITF
        ]);
      }
      // Spend more effort per frame. A tablet camera gives a soft, low contrast image, and
      // without this a printed EAN-13 often never resolves at all.
      hints.set(HINT_TRY_HARDER, true);
    } catch (e) { /* fall back to all formats */ }

    var reader = new window.ZXingBrowser.BrowserMultiFormatReader(hints.size ? hints : undefined);
    // Кадр зеркалим: клиент видит себя как в зеркале и наводит код увереннее.
    el.scanVideo.classList.add("mirrored");
    reader.decodeFromConstraints(
      { video: { facingMode: scan.facing, width: { ideal: 1920 }, height: { ideal: 1080 } } },
      el.scanVideo,
      function (result, err, controls) {
        if (!scan.active || gen !== scan.gen) { try { controls.stop(); } catch (e) {} return; }
        scan.controls = controls;
        el.scanMsg.textContent = "Наведите код на окно";
        if (result) onScanned(result);
      }
    ).then(function (controls) {
      // Keep the controls even if no frame has been decoded yet, so stopScan() can always close
      // the camera. If scanning was stopped while the camera was starting, close it right away.
      if (!scan.active || gen !== scan.gen) { try { controls && controls.stop(); } catch (e) {} return; }
      scan.controls = controls || scan.controls;
    }).catch(function (err) {
      if (gen !== scan.gen) return;
      el.scanMsg.textContent = "Нет доступа к камере. Разрешите доступ и повторите.";
      scan.active = false;
      if (scan.capTimer) { clearTimeout(scan.capTimer); scan.capTimer = null; }
      reportError("Не удалось запустить камеру для сканирования", err && (err.stack || err.message || String(err)));
      // Do not strand the tablet on the scan screen when the camera is unavailable.
      scan.doneTimer = setTimeout(function () { scan.doneTimer = null; finishScanOrLeave(); }, 6000);
    });
  }

  // Проверить путь кода без камеры иначе нельзя: в браузере проверки камеры нет, а разбирать
  // надо именно то, что происходит после считывания. Работает только при открытом сканировании,
  // поэтому подсунуть код в обход экрана не получится.
  window.__sk_test_scan = function (code, format) {
    if (scan.active || scan.inline) onScanned({ text: code, format: format });
  };

  function onScanned(result) {
    var code = "";
    try { code = result.getText ? result.getText() : (result.text || ""); } catch (e) { code = ""; }
    if (!code) return;
    var format = "";
    try {
      var f = result.getBarcodeFormat ? result.getBarcodeFormat() : result.format;
      var ZX = window.ZXing || window.ZXingBrowser;
      format = (ZX && ZX.BarcodeFormat && typeof f === "number") ? (ZX.BarcodeFormat[f] || String(f)) : String(f || "");
    } catch (e) { format = ""; }

    // One code per session: stop the camera immediately, show confirmation, save, then leave.
    scan.lastCode = code;
    watchPush();
    var inline = scan.inline;
    stopScan();
    el.scanMsg.textContent = "";
    el.scanCode.textContent = code;
    el.scanResult.classList.remove("hidden");

    // Код для элемента страницы принадлежит документу: он уедет вместе с подписью и в общий
    // список сканирований не попадает, иначе оператор видел бы там чужие коды вперемешку.
    if (inline) {
      scan.inline = null;
      scan.doneTimer = setTimeout(function () {
        scan.doneTimer = null;
        clearScanResult();
        showLayer("document");
        startIdle();
        inline(code, format);
        renderScreen();
      }, 900);
      return;
    }

    fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (getToken() || "") },
      body: JSON.stringify({ code: code, format: format })
    }).catch(function (err) {
      el.scanMsg.textContent = "Код не сохранён, повторите.";
      reportError("Не удалось отправить считанный код", err && (err.stack || err.message || String(err)));
    }).then(function (r) {
      if (r && !r.ok) {
        el.scanMsg.textContent = "Код не сохранён, повторите.";
        reportError("Сервер отклонил считанный код (HTTP " + r.status + ")");
      }
    });

    // Return to the normal screen shortly after, and wipe the code from the screen. If the server
    // cannot be reached, leave the scan screen locally rather than sitting on it forever.
    scan.doneTimer = setTimeout(function () {
      scan.doneTimer = null;
      clearScanResult();
      finishScanOrLeave();
    }, 2500);
  }

  function applyCommand(cmd) {
    if (!cmd) return;
    // Сервер не узнал в этом подключении планшет: страницу открыли в браузере, где есть вход в
    // админку, или токен уже не тот. Дальше ждать нечего, показываем экран активации.
    if (cmd.mode === "notdevice") {
      showEnroll("Это окно не привязано к планшету. Введите код активации.");
      return;
    }
    if (cmd.mode === "document") applyDocument(cmd.document);
    else applySlides(cmd.slides);
  }

  // ==================================================================
  // Enrollment
  // ==================================================================
  function showEnroll(message) {
    stopSlides();
    // Close the camera and wipe any signer data: activation can be reached from any screen
    // (a revoked token, a reset device), and the scan layer would otherwise cover this one.
    stopScan();
    clearDocState();
    el.scan.classList.add("hidden");
    el.slideshow.classList.add("hidden");
    el.document.classList.add("hidden");
    hideStatus();
    el.enroll.classList.remove("hidden");
    el.enrollMsg.textContent = message || "";
    setTimeout(function () { try { el.enrollCode.focus(); } catch (e) {} }, 100);
  }

  function enroll(code) {
    return fetch("/api/kiosk/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code })
    }).then(function (r) {
      if (!r.ok) throw new Error("enroll " + r.status);
      return r.json();
    }).then(function (j) {
      setToken(j.token);
      return j;
    });
  }

  el.enrollForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var code = (el.enrollCode.value || "").trim();
    if (!code) return;
    el.enrollMsg.textContent = "Активация…";
    enroll(code)
      .then(function () { el.enrollCode.value = ""; connect(); })
      .catch(function () { el.enrollMsg.textContent = "Код недействителен или истёк. Проверьте и попробуйте снова."; });
  });

  // ==================================================================
  // SignalR connection
  // ==================================================================
  var conn = null;

  // Reported on every connect so the operator can see which build a tablet is actually running.
  // A WebView that has not reloaded since an older deploy keeps working but ignores anything
  // added since, and without this the only symptom is a command that seems to do nothing.
  var APP_VERSION = "6.5";

  function register() {
    return conn.invoke("RegisterKiosk").then(function (cmd) {
      applyCommand(cmd);
      // Sent separately, and failure is ignored: registering is what matters, the version is
      // only there so the operator can spot a tablet still running an older page.
      conn.invoke("ReportVersion", APP_VERSION).catch(function () { /* older server */ });
    }).catch(function (e) { console.error("register failed", e); });
  }

  function isAuthError(e) {
    if (!e) return false;
    if (e.statusCode === 401 || e.statusCode === 403) return true;
    return /\b401\b|\b403\b|unauthorized|forbidden/i.test(String(e.message || e));
  }

  // Задержки между попытками вернуться на связь. Двести планшетов теряют её одновременно:
  // погасла точка доступа, перезапустилась служба. С одинаковыми задержками они и возвращаются
  // одновременно, все двести в одну и ту же секунду, и служба получает залп подключений ровно
  // тогда, когда сама только встала. Поэтому к каждой задержке добавляется случайная надбавка
  // до половины её длины: возвращение растягивается, а не бьёт одним ударом.
  var RETRY_STEPS = [0, 2000, 5000, 10000, 15000, 30000];
  var connectTries = 0;
  function retryDelay(attempt) {
    var base = RETRY_STEPS[Math.min(attempt, RETRY_STEPS.length - 1)];
    return base + Math.floor(Math.random() * (base / 2 + 500));
  }

  function connect() {
    var token = getToken();
    if (!token) { showEnroll(""); return; }

    conn = new signalR.HubConnectionBuilder()
      .withUrl("/hub/kiosk", { accessTokenFactory: function () { return getToken() || ""; } })
      // Своё правило, а не список задержек: список в SignalR исчерпывается, и после последней
      // попытки планшет перестаёт пытаться совсем. Планшет в киоске никто не перезагружает
      // руками, поэтому пытаться он должен без конца.
      .withAutomaticReconnect({ nextRetryDelay: function (ctx) { return retryDelay(ctx.previousRetryCount); } })
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    conn.on("ShowSlides", applySlides);
    conn.on("ShowDocument", applyDocument);
    conn.on("Identify", function (p) { showIdentify(p && p.code, p && p.name); });
    conn.on("StartScan", startScan);
    conn.on("StopScan", stopScan);
    // За планшетом начали или перестали смотреть. Пока не смотрят, он не рассказывает ничего.
    conn.on("WatchOn", function () { watch.on = true; watchPush(); });
    conn.on("WatchOff", function () { watch.on = false; });

    conn.onreconnecting(function () { showStatus("Соединение потеряно. Переподключение…"); });
    conn.onreconnected(function () { hideStatus(); register(); });
    conn.onclose(function () {
      if (getToken()) { showStatus("Нет связи с сервером. Переподключение…"); setTimeout(connect, retryDelay(1)); }
      else showEnroll("");
    });

    showStatus("Подключение к серверу…");
    conn.start()
      .then(function () { hideStatus(); connectTries = 0; return register(); })
      .catch(function (e) {
        conn = null;
        if (isAuthError(e)) { clearToken(); showEnroll("Планшет не авторизован. Введите новый код активации."); }
        else {
          // Служба не поднялась: повторять чаще с каждым разом бессмысленно, а всем парком в
          // одну секунду тем более. Пауза растёт до полуминуты и у каждого планшета своя.
          var пауза = retryDelay(connectTries++);
          showStatus("Нет связи с сервером. Повтор через " + Math.round(пауза / 1000) + " с…");
          setTimeout(connect, пауза);
        }
      });
  }

  // ==================================================================
  // Boot
  // ==================================================================
  (function boot() {
    if (getToken()) { connect(); return; }
    var code = qs.get("enroll");
    if (code) {
      showStatus("Активация…");
      enroll(code).then(connect).catch(function () { showEnroll("Код из ссылки недействителен. Введите код вручную."); });
    } else {
      showEnroll("");
    }
  })();
})();
