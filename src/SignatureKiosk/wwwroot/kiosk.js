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
  // textStep это ступень размера текста, а firstIndex это экран, который клиент увидел первым.
  // Оба живут ровно столько же, сколько сам показ: их сбрасывает каждый новый документ и каждый
  // возврат к рекламе, поэтому следующий клиент начинает с обычного размера.
  var doc = { config: null, screens: [], index: 0, checks: {}, pad: null, submitting: false, docPadResize: null, idleTimer: null, idleMs: 0, thankTimer: null, session: 0, textStep: 0, firstIndex: null,
    // Подписи полей заведены сразу: их спрашивают и до того, как на планшет пришёл документ.
    signStrokes: {}, signGeom: {}, signs: {}, signThumbs: {} };
  // Щель для проверок, как и __padForTest рядом: без неё нельзя развести то, что знает
  // страница, и то, что знает снимок на сервере, а именно на этом расхождении и проверяется,
  // объясняет ли планшет отказ сервера или выдаёт его за обрыв связи.
  window.__docForTest = doc;

  function isInfoDoc() {
    return !!doc.config && String(doc.config.kind || "").toLowerCase() === "info";
  }

  function applyDocument(config, sessionId) {
    stopSlides();
    endDocSession();               // cancel any timers from a previous session; invalidates in-flight submits
    showLayer("document");
    doc.serverSession = sessionId || null;
    doc.config = config || { title: "", pages: [] };
    doc.checks = {};
    doc.picks = {};          // группа -> ключ выбранного варианта ("" = ничего не выбрано)
    // Подпись поля внутри страницы хранится росчерком, как и итоговая: это то, что клиент
    // нарисовал, и всё остальное считается от него. Картинка и копия для наблюдателя лежат
    // рядом готовыми, но собраны они из росчерка и сами по себе ничего не решают.
    doc.signStrokes = {};    // имя поля подписи -> точки росчерка: сама подпись
    doc.signGeom = {};       // и размер холста, на котором она снята
    doc.signs = {};          // имя поля подписи -> картинка в виде data URL
    doc.signThumbs = {};     // и её уменьшенная копия, только для наблюдателя
    doc.codes = {};          // имя поля сканирования -> { code, format, label }
    doc.inputs = {};         // имя поля ввода -> вписанное значение
    doc.pagePads = {};       // имя поля подписи -> перо, чтобы очистить и восстановить
    doc.pad = null;
    // Итоговая подпись (точками росчерка) и её копия для наблюдателя. Стереть их обязательно:
    // без этого подпись прежнего клиента оставалась в памяти, и оператор видел её в наблюдении
    // на экране подписи следующего человека, который ещё ничего не нарисовал.
    doc.finalStrokes = null;
    doc.finalInk = "";
    doc.submitting = false;
    // Размер текста это выбор одного клиента, а не настройка планшета: следующему он достаётся
    // обычным, даже если предыдущий увеличил буквы до предела.
    doc.textStep = 0;
    doc.firstIndex = null;
    applyTextScale();
    doc.screens = [];
    (doc.config.pages || []).forEach(function (p, i) {
      doc.screens.push({ type: "page", pageIndex: i });
      // Honour the initial checked state of API-supplied checkboxes.
      (p.checkboxes || []).forEach(function (cb, ci) { if (cb && cb.checked) doc.checks[checkKey(i, ci)] = true; });
      // Заказ мог прислать отмеченными оба взаимоисключающих пункта. Клиент к ним не притронется
      // и обработчик отметки не сработает ни разу, а сервер такую подпись отвергнет: оставляем
      // первый и снимаем остальные, как это делает отметка руками.
      (p.checkRules || []).forEach(function (rule) {
        if (!rule || rule.kind !== "exclusive" || !rule.keys) return;
        var первый = -1;
        (p.checkboxes || []).forEach(function (cb, ci) {
          if (!cb || !cb.key || rule.keys.indexOf(cb.key) < 0) return;
          if (!doc.checks[checkKey(i, ci)]) return;
          if (первый < 0) { первый = ci; return; }
          doc.checks[checkKey(i, ci)] = false;
        });
      });
      // И выбор в группах, если внешняя система его прислала.
      (p.groups || []).forEach(function (g) { if (g && g.key) doc.picks[g.key] = g.selected || ""; });
    });
    // Информационный документ не подписывают: он существует, чтобы показать клиенту то, что
    // прислала внешняя система. Экрана подписи у него нет вовсе, и после последней страницы
    // сразу идёт прощание, которое само возвращает планшет к рекламе.
    if (!isInfoDoc()) doc.screens.push({ type: "signature" });
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
    doc.serverSession = null;       // имя серверной сессии живёт ровно столько же, сколько сама
    doc.submissionId = null;        // a new signing session must never reuse the previous key
    stopIdle();
    if (doc.thankTimer) { clearTimeout(doc.thankTimer); doc.thankTimer = null; }
  }

  // Idle auto-return: if the signer walks away without signing, go back to ads and let the
  // server clear their data. Any interaction on the document resets the timer.
  function stopIdle() { if (doc.idleTimer) { clearTimeout(doc.idleTimer); doc.idleTimer = null; } }
  function startIdle() { stopIdle(); if (doc.idleMs > 0) doc.idleTimer = setTimeout(onIdle, doc.idleMs); }
  // На камере таймер бездействия намеренно остановлен: клиент там ищет код, а не бездействует.
  // Слушатель теперь висит на всём документе, поэтому проверяем слой явно, иначе касание экрана
  // сканирования взводило бы таймер обратно.
  function resetIdle() { if (doc.idleMs > 0 && doc.config && activeLayer !== "scan") startIdle(); }
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
    doc.config = null; doc.screens = []; doc.index = 0;
    забытьПодписанта();
    doc.pad = null; doc.submitting = false; doc.docPadResize = null; doc.idleMs = 0;
    // Размер текста уходит вместе с остальным: и ступень, и сам множитель на слое документа, и
    // значок из разметки. Иначе следующий клиент получил бы чужой размер, а на планшете, который
    // вернулся к рекламе, в DOM остался бы след прошлого приёма.
    doc.textStep = 0; doc.firstIndex = null;
    applyTextScale();
    unmountBigText();
    el.docBody.innerHTML = ""; el.docFooter.innerHTML = "";
    el.docTitle.textContent = ""; el.docProgress.textContent = "";
  }

  /// Стереть из памяти планшета всё, что клиент ответил или нарисовал.
  ///
  /// Названо отдельно, потому что звать это надо из двух мест: при возврате к рекламе и на
  /// экране прощания. Раньше стирание было только в первом, а на прощании чистились лишь
  /// заголовок, документ и отметки. Замер: после подписи в памяти планшета оставались вписанный
  /// телефон, выбранный вариант, росчерк поля, его картинка и уменьшенная копия, и всё это
  /// уезжало оператору, если тот открывал наблюдение уже после ухода человека. Жило это до
  /// срабатывания таймера прощания, то есть до минуты.
  ///
  /// Пояснение к экрану прощания при этом обещает обратное: данные стираются, как только
  /// подписание закончено.
  function забытьПодписанта() {
    doc.checks = {}; doc.picks = {};
    // Росчерки полей стираются вместе с их картинками. Порознь нельзя: росчерк это и есть
    // подпись, и оставленный в памяти он вернул бы её следующему клиенту на глаза.
    doc.signStrokes = {}; doc.signGeom = {};
    doc.signs = {}; doc.signThumbs = {}; doc.codes = {}; doc.pagePads = {};
    doc.finalInk = ""; doc.finalStrokes = null;
    // Вписанное клиентом стирается вместе со всем остальным.
    doc.inputs = {};
  }

  /// Была ли уже хоть одна команда от службы с момента загрузки страницы. Нужно, чтобы отличить
  /// «оператор прислал документ» от «страница перезагрузилась, пока клиент подписывал».
  var перваяКомандаПослеЗагрузки = true;

  function checkKey(page, idx) { return "p" + page + "_c" + idx; }

  /// Одно ли это имя. Сравнение без учёта регистра и с обрезкой краёв, как на сервере.
  ///
  /// Служба всюду сравнивает имена элементов без регистра: и в LiveKeys, и в ApplyLiveConditions,
  /// и при приёме отметок, и при приёме подписи, и внешним системам это обещано в справке API.
  /// Планшет же сравнивал строки точно, и условие с именем в другом написании служба признавала
  /// живым и отправляла сюда, а здесь оно не находило своего элемента.
  ///
  /// Замер до починки: восемь расхождений в обе стороны. Блок под «SOGLASIE eq true» на экране
  /// не показан, а в бумаге напечатан; блок под «SOGLASIE empty» показан на экране и пропал из
  /// бумаги. Целая страница под таким условием не показывалась клиенту и целиком попадала в
  /// подписанный лист. Обязательный пункт под таким условием делал документ неподписываемым:
  /// планшет пункт не показывал, а служба требовала его заполнить.
  function тоЖеИмя(своё, искомое) {
    return String(своё == null ? "" : своё).trim().toLowerCase()
        === String(искомое == null ? "" : искомое).trim().toLowerCase();
  }

  // Условие, которое сервер не смог решить сам, потому что оно зависит от того, что клиент
  // отмечает прямо сейчас. Сервер уже убрал всё, что решается по тегам, поэтому сюда доходят
  // только условия на чекбоксы и группы. Чекбокс в скрытом блоке считается неотмеченным: так
  // взаимные ссылки между блоками разрешаются сами и не могут зациклиться.
  // Идёт вычисление видимости этого элемента. Ссылка по кругу (A показывает B, B показывает A)
  // разрешается в пользу «не видно», иначе вычисление зациклилось бы.
  var вПути = {};
  function видноЛи(имя, своё, страница) {
    if (вПути[имя]) return false;
    вПути[имя] = true;
    try { return condHolds(страница) && condHolds(своё); }
    finally { delete вПути[имя]; }
  }

  function liveValue(key) {
    // Значение элемента, скрытого условием, считается пустым. Клиент его не видит, планшет его
    // не отправляет (collectItems, collectGroups, collectInputs шлют только видимое), и сервер
    // тоже считает его пустым. Раньше здесь бралось сохранённое значение как есть, и цепочка
    // «пункт A открывает пункт B, B открывает блок C» после снятия A оставляла C на экране: в
    // запись B не уходил, сервер вырезал C, и в PDF не было текста, под которым человек
    // расписался. Обещание в пояснении выше при этом стояло с самого начала.
    var found = "";
    var нашли = false;
    // Порядок тот же, что на сервере: отметки, потом выбор, потом вписанное. Последнее и
    // побеждает, если одно имя досталось двум элементам. Раньше порядок был обратный, и хозяин
    // имени получался разный: на экране одно, в записи другое.
    (doc.config.pages || []).forEach(function (p, pi) {
      (p.checkboxes || []).forEach(function (cb, ci) {
        if (!cb || !тоЖеИмя(cb.key, key)) return;
        нашли = true;
        found = (видноЛи("c" + pi + "_" + ci, cb.visibleWhen, p.visibleWhen)
          && doc.checks[checkKey(pi, ci)]) ? "true" : "false";
      });
      (p.groups || []).forEach(function (g, gi) {
        if (!g || !тоЖеИмя(g.key, key)) return;
        нашли = true;
        // Значение берётся по СОБСТВЕННОМУ имени элемента, а не по имени из условия: они могут
        // различаться регистром, и тогда элемент нашёлся бы, а значение прочиталось из пустоты.
        found = видноЛи("g" + pi + "_" + gi, g.visibleWhen, p.visibleWhen) ? (doc.picks[g.key] || "") : "";
      });
      (p.inputs || []).forEach(function (inp, ii) {
        if (!inp || !тоЖеИмя(inp.key, key)) return;
        нашли = true;
        found = видноЛи("i" + pi + "_" + ii, inp.visibleWhen, p.visibleWhen)
          ? String(doc.inputs[inp.key] != null ? doc.inputs[inp.key] : (inp.value || "")) : "";
      });
      // Имена полей подписи и сканирования тоже живые: сервер объявляет их такими и отдаёт
      // условие планшету. Значения для них планшет раньше не производил вовсе, и условие
      // «код отсканирован» не срабатывало ни разу, а обратное держалось всегда.
      (p.signatures || []).forEach(function (sg, si) {
        if (!sg || !тоЖеИмя(sg.key, key)) return;
        нашли = true;
        // Спрашивается росчерк: он и есть подпись. Картинка рядом с ним лишь его отпечаток.
        found = (видноЛи("s" + pi + "_" + si, sg.visibleWhen, p.visibleWhen)
          && (doc.signStrokes[sg.key] || []).length) ? "подписано" : "";
      });
      (p.scans || []).forEach(function (sc, ni) {
        if (!sc || !тоЖеИмя(sc.key, key)) return;
        нашли = true;
        var код = doc.codes[sc.key];
        found = (видноЛи("n" + pi + "_" + ni, sc.visibleWhen, p.visibleWhen) && код) ? (код.code || "") : "";
      });
    });
    // Имени в документе нет вовсе: значение могло прийти от присланного по API пункта, которого
    // в шаблоне не было. Тогда берётся то, что лежит.
    if (!нашли) {
      if (Object.prototype.hasOwnProperty.call(doc.picks, key)) return doc.picks[key] || "";
      if (Object.prototype.hasOwnProperty.call(doc.inputs, key)) return doc.inputs[key] || "";
    }
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

  // Дата в том виде, который понимает поле input[type=date], то есть yyyy-MM-dd. Всё, что не
  // разобралось, отдаётся как есть: поле такое значение отбросит само, и это лучше, чем молча
  // подставить выдуманную дату.
  function вДатуПоля(значение) {
    var v = String(значение == null ? "" : значение).trim();
    if (!v) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    var m = v.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (m) {
      var д = ("0" + m[1]).slice(-2), мес = ("0" + m[2]).slice(-2);
      return m[3] + "-" + мес + "-" + д;
    }
    return v;
  }

  // Почему значение не подходит виду поля. Слово в слово как на сервере: расхождение означало
  // бы, что планшет пускает дальше то, что сервер потом отвергнет.
  function badInput(вид, значение) {
    var v = String(значение == null ? "" : значение).trim();
    if (!v.length) return "";
    if (вид === "number") return /^-?\d+([.,]\d+)?$/.test(v) ? "" : "это не число";
    if (вид === "date") return /^\d{2}[./-]\d{2}[./-]\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(v)
      ? "" : "это не дата, подойдёт 01.01.1990 или 1990-01-01";
    if (вид === "phone") {
      var цифр = (v.match(/\d/g) || []).length;
      return цифр >= 5 && цифр <= 15 ? "" : "это не похоже на номер телефона";
    }
    return "";
  }

  // Число из строки, слово в слово как на сервере (decimal.TryParse по всей строке). parseFloat
  // читает начало строки и молча отбрасывает хвост: «12 мл» давало 12, «1 500» давало 1, и
  // планшет открывал блок, который сервер потом выбрасывал из записи и из бумаги.
  function числоИз(текст) {
    var v = String(текст == null ? "" : текст).trim().replace(",", ".");
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v)) return null;
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  // Возраст в полных годах на сегодня, как считает сервер. Пусто, если это не дата.
  function возрастЛет(текст) {
    var д = разобратьДату(текст);
    if (!д) return null;
    var сейчас = new Date();
    var лет = сейчас.getFullYear() - д.getFullYear();
    var м = сейчас.getMonth() - д.getMonth();
    if (м < 0 || (m0(м) && сейчас.getDate() < д.getDate())) лет--;
    return лет < 0 ? null : лет;
    function m0(x) { return x === 0; }
  }

  // Дата из «01.01.1990», «1990-01-01» или «01/01/1990». Пусто, если разобрать не вышло.
  function разобратьДату(текст) {
    var v = String(текст == null ? "" : текст).trim();
    if (!v) return null;
    var m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return собрать(+m[1], +m[2], +m[3]);
    m = v.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (m) return собрать(+m[3], +m[2], +m[1]);
    return null;
    function собрать(г, мес, д) {
      if (мес < 1 || мес > 12 || д < 1 || д > 31) return null;
      var x = new Date(г, мес - 1, д);
      return (x.getFullYear() === г && x.getMonth() === мес - 1 && x.getDate() === д) ? x : null;
    }
  }

  // Дни до годовщины этой даты (день и месяц) в прошлом, этом и следующем году, со знаком:
  // отрицательное означает, что годовщина прошла столько дней назад. Три года, а не один: так
  // же считает сервер, иначе окно у края года давало бы на планшете и в записи разный ответ.
  function дниДоГодовщины(текст) {
    var д = разобратьДату(текст);
    if (!д) return null;
    var сейчас = new Date();
    var сегодня = new Date(сейчас.getFullYear(), сейчас.getMonth(), сейчас.getDate());
    var сутки = 24 * 3600 * 1000;
    var out = [];
    [сегодня.getFullYear() - 1, сегодня.getFullYear(), сегодня.getFullYear() + 1].forEach(function (год) {
      var день = д.getDate(), месяц = д.getMonth() + 1;
      // 29 февраля в невисокосный год празднуют 28-го: иначе такая дата не совпала бы никогда.
      if (месяц === 2 && день === 29 && !високосный(год)) день = 28;
      out.push(Math.round((new Date(год, месяц - 1, день) - сегодня) / сутки));
    });
    return out;
    function високосный(г) { return (г % 4 === 0 && г % 100 !== 0) || г % 400 === 0; }
  }

  // Целое из строки, как int.TryParse на сервере: «5x» не число.
  function целоеИз(текст) {
    var v = String(текст == null ? "" : текст).trim();
    if (!/^[+-]?\d+$/.test(v)) return null;
    return parseInt(v, 10);
  }

  function partValue(cond) {
    // Счёт отметок: поле это перечень имён через запятую, а не одно имя.
    if (cond.op === "minchecked") {
      var надо = parseInt(cond.value, 10);
      if (!(надо >= 1)) return false;
      var есть = String(cond.field || "").split(",").map(function (x) { return x.trim(); })
        .filter(function (x) { return x.length; })
        .filter(function (k) { return String(liveValue(k) || "").trim().toLowerCase() === "true"; }).length;
      return есть >= надо;
    }
    var val = String(liveValue(cond.field) || "").trim().toLowerCase();
    var target = String(cond.value || "").trim().toLowerCase();
    // Числа сравниваются как числа: «9» меньше «10», хотя как строки наоборот.
    if (cond.op === "numlt" || cond.op === "numge" || cond.op === "numin") {
      var n = числоИз(val);
      if (n === null) return false;
      if (cond.op === "numin") {
        // Пустой край это «без предела», как у промежутка дат. Раньше требовались обе границы,
        // и «5..» не выполнялся ни при каком значении.
        var гр = target.split("..");
        var a = числоИз(гр[0]), b = числоИз(гр.length > 1 ? гр[1] : "");
        if (a === null && b === null) return false;
        if (a !== null && n < a) return false;
        if (b !== null && n > b) return false;
        return true;
      }
      var lim = числоИз(target);
      if (lim === null) return false;
      return cond.op === "numlt" ? n < lim : n >= lim;
    }
    // Возраст и годовщина считаются от того, что клиент вписал прямо сейчас. Сервер такие
    // условия отдаёт планшету, если имя поля живое, а планшет их не знал и сваливался в
    // сравнение строк: «2020-01-01» сравнивалось с «14». Обязательное поле под таким условием
    // делало документ непроходимым: на экране его нет, а сервер требует заполнить.
    if (cond.op === "agelt" || cond.op === "agege") {
      var лет = возрастЛет(val);
      var порог = целоеИз(target);
      if (лет === null || порог === null) return false;
      return cond.op === "agelt" ? лет < порог : лет >= порог;
    }
    if (cond.op === "annivwithin") {
      var дни = дниДоГодовщины(val);
      if (!дни) return false;
      // Окно задаётся как «до/после» или одним числом в обе стороны. Сам день попадает в оба,
      // поэтому нулевое окно с обеих сторон означает ровно этот день.
      var части = target.split("/");
      var до = целоеИз(части[0]);
      var после = части.length > 1 ? целоеИз(части[1]) : до;
      if (до === null || до < 0) return false;
      if (после === null || после < 0) return false;
      return дни.some(function (d) { return d >= 0 ? d <= до : (-d) <= после; });
    }
    switch (cond.op) {
      // «Не равно» не выполняется, когда значения нет вовсе: пустое это «не знаем», а не
      // «другое». Иначе блок про другую систему кодирования видел каждый, кому её не присылали.
      case "ne": return val.length > 0 && val !== target;
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
        condParts(group).forEach(function (part) {
          // У условия «отмечено не меньше N» поле это перечень имён через запятую, а не одно
          // имя. Сравнение целой строки с одним именем не совпадало никогда, поэтому отметка
          // пункта не считалась зависимостью: экран не перерисовывался, и блок, открытый счётом
          // отметок, на планшете не появлялся, хотя в записи и в бумаге он был.
          if (part.op === "minchecked") {
            String(part.field || "").split(",").forEach(function (x) { if (тоЖеИмя(x, key)) uses = true; });
            return;
          }
          if (тоЖеИмя(part.field, key)) uses = true;
        });
      });
    }
    (doc.config.pages || []).forEach(function (p) {
      check(p.visibleWhen);
      (p.blocks || []).forEach(function (b) { check(b.visibleWhen); });
      (p.checkboxes || []).forEach(function (c) { check(c.visibleWhen); });
      (p.groups || []).forEach(function (g) { check(g.visibleWhen); });
      // Подписи и сканы тоже живут под условиями: без них поле подписи, спрятанное за
      // чекбоксом «подписывает представитель», не появлялось бы при его отметке.
      (p.signatures || []).forEach(function (x) { check(x.visibleWhen); });
      (p.scans || []).forEach(function (x) { check(x.visibleWhen); });
      // И поля ввода: без этого поле, спрятанное за отметкой «есть представитель», не
      // появлялось при её постановке, а «Далее» уже считало его видимым и пустым. Клиент видел
      // «Отметьте выделенный пункт», а выделять было нечего: поля на экране не было.
      (p.inputs || []).forEach(function (x) { check(x.visibleWhen); });
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
  // Экран подписи или сканирования существует ради своего поля. Если поле спрятано условием на
  // то, что клиент отмечает прямо сейчас, показывать нечего: сервер такой экран выбрасывает,
  // когда условие решается по тегам, а живое условие он оставляет планшету. Без этой проверки
  // клиент получал шаг с заголовком, пустым телом и кнопкой «Далее».
  function экранПустой(page) {
    if (!page) return false;
    var вид = String(page.kind || "").toLowerCase();
    if (вид === "signature") return !(page.signatures || []).some(function (x) { return condHolds(x.visibleWhen); });
    if (вид === "scan") return !(page.scans || []).some(function (x) { return condHolds(x.visibleWhen); });
    return false;
  }

  function screenVisible(screen) {
    if (!screen) return false;
    if (screen.type !== "page") return true;
    var page = doc.config.pages[screen.pageIndex];
    return !!page && condHolds(page.visibleWhen) && !экранПустой(page);
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
      if (sg.required && condHolds(sg.visibleWhen) && !(doc.signStrokes[sg.key] || []).length)
        out.push({ kind: "sign", key: sg.key || "" });
    });
    (page.scans || []).forEach(function (sc) {
      if (sc.required && condHolds(sc.visibleWhen) && !doc.codes[sc.key])
        out.push({ kind: "scan", key: sc.key || "" });
    });
    (page.inputs || []).forEach(function (inp) {
      if (!inp || !condHolds(inp.visibleWhen)) return;
      var v = String(doc.inputs[inp.key] != null ? doc.inputs[inp.key] : (inp.value || "")).trim();
      // Пустое обязательное и заполненное неправильно держат кнопку одинаково: и то и другое
      // сервер всё равно не примет.
      // Пустое обязательное и заполненное неправильно это разные беды, и говорить о них надо
      // разными словами: «нужно заполнить» над заполненным полем сбивает с толку.
      var плохо = badInput((inp.type || "text").toLowerCase(), v);
      if (плохо) out.push({ kind: "input", key: inp.key || "", bad: плохо });
      else if (inp.required && !v.length) out.push({ kind: "input", key: inp.key || "" });
    });
    // Правило считается только по тем пунктам, которые клиент действительно видит. Скрытый
    // условием пункт на планшет не приходит и в запись не уходит, а раньше он считался
    // отмеченным: планшет пускал дальше, сервер отвергал подпись, и выйти из этого было нельзя.
    function видимыйПункт(cb) { return cb && cb.key && condHolds(cb.visibleWhen); }
    (page.checkRules || []).forEach(function (rule) {
      if (!rule || !rule.keys) return;
      if (rule.kind === "exclusive") {
        // Из взаимоисключающих отмеченным может быть только один. Сервер это проверяет и
        // отвергает подпись; клиенту надо сказать об этом до того, как он распишется.
        var отмеченные = [];
        (page.checkboxes || []).forEach(function (cb, i) {
          if (!видимыйПункт(cb) || rule.keys.indexOf(cb.key) < 0) return;
          if (doc.checks[checkKey(pageIndex, i)]) отмеченные.push(i);
        });
        if (отмеченные.length > 1)
          for (var j = 1; j < отмеченные.length; j++)
            out.push({ kind: "exclusive", key: checkKey(pageIndex, отмеченные[j]) });
        return;
      }
      if (rule.kind !== "minchecked") return;
      var есть = 0;
      (page.checkboxes || []).forEach(function (cb, i) {
        if (видимыйПункт(cb) && rule.keys.indexOf(cb.key) >= 0 && doc.checks[checkKey(pageIndex, i)]) есть++;
      });
      // Правило показывает на первый неотмеченный пункт из своего перечня: подсветить надо то,
      // что клиенту нажимать, а не абстрактное «правило не выполнено».
      if (есть < (rule.n || 1)) {
        for (var i = 0; i < (page.checkboxes || []).length; i++) {
          var cb = page.checkboxes[i];
          if (видимыйПункт(cb) && rule.keys.indexOf(cb.key) >= 0 && !doc.checks[checkKey(pageIndex, i)]) {
            out.push({ kind: "check", key: checkKey(pageIndex, i) });
            break;
          }
        }
      }
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
      var attr = (m.kind === "check" || m.kind === "exclusive") ? "data-miss-key"
        : m.kind === "group" ? "data-miss-group"
        : m.kind === "sign" ? "data-miss-sign"
        : m.kind === "input" ? "data-miss-input" : "data-miss-scan";
      var node = el.docBody.querySelector('[' + attr + '="' + m.key + '"]');
      if (!node) return;
      node.classList.add("miss");
      var note = document.createElement("div");
      note.className = "miss-note";
      // Про поле ввода раньше говорилось «Нужно отсканировать код»: ветки для него не было, и
      // оно попадало в общий хвост.
      note.textContent = m.kind === "check" ? "Нужно отметить, чтобы продолжить"
        : m.kind === "exclusive" ? "Эти пункты нельзя отметить вместе: оставьте один"
        : m.kind === "group" ? "Нужно выбрать один вариант"
        : m.kind === "sign" ? "Нужно расписаться в этом поле"
        : m.kind === "input" ? (m.bad || "Нужно заполнить это поле")
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
      if (sg.required && condHolds(sg.visibleWhen) && !(doc.signStrokes[sg.key] || []).length) return false;
    }
    for (var ci = 0; ci < (page.scans || []).length; ci++) {
      var sc = page.scans[ci];
      if (sc.required && condHolds(sc.visibleWhen) && !doc.codes[sc.key]) return false;
    }
    // Поля ввода и правила отметок считаются тем же кодом, что подсвечивает пропущенное: два
    // разных счёта однажды разошлись бы, и кнопка «Далее» перестала бы совпадать с подсветкой.
    return missingOn(pageIndex).length === 0;
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

  // Настройки пера одни на все поля подписи. Картинка поля собирается заново, отдельным пером,
  // и собраться она должна ровно такой же, какой клиент видел её на экране: разойдись здесь
  // толщина или цвет, и в записи оказалась бы не та подпись, что на планшете.
  var ПЕРО = { minWidth: 1.2, maxWidth: 3.2, penColor: "#111827", throttle: 0, minDistance: 0 };

  // Картинка поля подписи внутри страницы. Не хранится, а собирается из росчерка тогда, когда
  // нужна: в запись и в PDF. Источник истины здесь росчерк, потому что картинку перо своей не
  // считает, а росчерк переживает и перерисовку страницы, и пересчёт холста.
  // Размер холста берётся тот, на котором росчерк снят: в PDF подпись садится по пропорциям
  // своей картинки, и собранная в другом размере она встала бы на лист сплюснутой.
  function рисунокПоля(key) {
    var точки = doc.signStrokes[key];
    if (!точки || !точки.length) return "";
    var г = doc.signGeom[key];
    if (!г || !г.w || !г.h) return "";
    try {
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(г.w * г.k));
      c.height = Math.max(1, Math.round(г.h * г.k));
      c.getContext("2d").scale(г.k, г.k);
      var p = new SignaturePad(c, ПЕРО);
      p.fromData(точки);
      var out = p.toDataURL("image/png");
      p.off();                     // перо жило ровно столько, сколько собиралась картинка
      return out;
    } catch (e) { return ""; }
  }

  // Стереть подпись поля отовсюду: и росчерк, и собранную из него картинку, и копию для
  // наблюдателя. Одним куском нарочно: у итоговой подписи стирали по частям, росчерк оставался
  // в памяти и возвращал на экран подпись, которую клиент только что стёр.
  function забытьПоле(key) {
    delete doc.signStrokes[key];
    delete doc.signGeom[key];
    delete doc.signs[key];
    delete doc.signThumbs[key];
  }

  function watchState() {
    var screen = doc.screens[doc.index];
    var out = { mode: doc.config ? "document" : "slides" };
    // Сканирование идёт первым: экран камеры закрывает собой и рекламу, и документ, а значит
    // именно его и видит клиент. Прежде эта проверка стояла ниже ветки рекламы, и когда камеру
    // открывали на планшете без документа (а это обычный случай), наблюдатель дальше показывал
    // рекламу: на планшете камера, у оператора слайды.
    // Размер экрана планшета: ширина и высота окна в точках вёрстки, плотность пикселей и
    // размер самого экрана. По ним наблюдение строит окно тех же пропорций, а оператор видит,
    // на чём именно смотрит клиент: на семи дюймах текст переносится не так, как на десяти.
    // Считается один раз, до всех веток: экран не зависит от того, что на нём сейчас.
    var экран = {
      w: Math.round(window.innerWidth || 0),
      h: Math.round(window.innerHeight || 0),
      dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
      // window.screen, а не screen: рядом объявлена своя переменная screen с экраном документа,
      // и без явного window размер брался у неё. Он там не задан, поэтому наблюдение всегда
      // получало нули и физический размер экрана не показывало ни разу.
      sw: Math.round((window.screen && window.screen.width) || 0),
      sh: Math.round((window.screen && window.screen.height) || 0)
    };
    out.screen = экран;
    // По открытому экрану, а не по работающей камере. Считанный код показывается ещё две
    // секунды после того, как камера уже выключена, и разрешение камеры может не дать её вовсе:
    // в обоих случаях клиент смотрит на экран сканирования, а наблюдение показывало оператору
    // документ или рекламу. Оператор обязан видеть то же, что клиент.
    if (activeLayer === "scan") {
      // Про камеру говорим словами: у наблюдателя никакой камеры не открывается и разрешения
      // не спрашивается, он видит только, что клиент подносит код.
      out.mode = "scan";
      out.scanCode = scan.lastCode || "";
      return out;
    }
    if (out.mode === "slides") {
      // Реклама тоже показывается наблюдателю: оператору важно видеть, что на экране идёт
      // именно то, что он поставил. Уходит только адрес картинки, сама она у админки уже есть.
      out.slide = slides.images[slides.index] || "";
      out.slideIndex = slides.index + 1;
      out.slideCount = slides.images.length;
      return out;
    }
    if (!doc.config || !screen) return out;
    out.type = screen.type;
    out.pageIndex = screen.pageIndex != null ? screen.pageIndex : -1;
    var pos = stepPosition();
    out.step = pos.current; out.steps = pos.total;
    // Выбранный клиентом размер текста: наблюдатель должен видеть тот же документ, что и клиент,
    // а не тот, который был бы при обычном размере.
    out.textScale = bigScale();
    out.checks = doc.checks;
    out.picks = doc.picks;
    out.codes = doc.codes;
    // Вписанное клиентом: оператор должен видеть не только пустое поле, но и то, что в нём
    // сейчас набрано. Раньше значения не уходили вовсе, и наблюдение показывало пустоту.
    out.inputs = doc.inputs || {};
    // Подписи идут картинками только когда они уже готовы: пока клиент ведёт линию, штрихи
    // догоняют отдельным потоком, иначе на каждое движение уходил бы целый PNG.
    var signs = {};
    Object.keys(doc.signThumbs || {}).forEach(function (k) { if (doc.signThumbs[k]) signs[k] = doc.signThumbs[k]; });
    out.signs = signs;
    if (screen.type === "signature") out.finalInk = doc.finalInk || "";
    out.missing = screen.type === "page"
      ? (missingOn(screen.pageIndex) || []).map(function (m) { return m.kind + ":" + m.key; })
      : [];
    // Куда клиент отлистал страницу. Страница выше экрана листается пальцем, и без этого
    // оператор в наблюдении всегда видел её верх: клиент отмечал пункты внизу, а у оператора
    // они были за краем сцены, обрезанные. Смотреть за подписанием и не видеть, что человек
    // сейчас отмечает, значит не смотреть вовсе.
    if (el.docBody) {
      out.scroll = {
        top: Math.round(el.docBody.scrollTop || 0),
        h: Math.round(el.docBody.scrollHeight || 0),
        view: Math.round(el.docBody.clientHeight || 0)
      };
    }
    return out;
  }

  /// Показать или убрать кнопку «Ниже есть ещё». Порог в 24 точки нарочно: без него кнопка
  /// мигала бы на странице, у которой содержимое выходит за край на пару точек из-за округления.
  function обновитьКнопкуВниз() {
    var кн = document.getElementById("btnScrollDown");
    if (!кн || !el.docBody) return;
    var осталось = el.docBody.scrollHeight - el.docBody.scrollTop - el.docBody.clientHeight;
    кн.classList.toggle("hidden", !(осталось > 24));
  }

  // Листание пальцем это событие и для клиента, и для наблюдателя: у первого от него зависит
  // кнопка «Ниже есть ещё», у второго то, какое место страницы он видит. Слушатель ставится
  // один раз и навсегда, а не при включении наблюдения: кнопка нужна клиенту всегда, даже
  // когда за ним никто не смотрит. Пачки в watchPush сами прижимают поток к десяти сообщениям
  // в секунду, поэтому отдельного придерживания здесь не нужно.
  function следитьЗаПрокруткой() {
    if (!el.docBody || el.docBody.__следим) return;
    el.docBody.__следим = true;
    el.docBody.addEventListener("scroll", function () {
      обновитьКнопкуВниз();
      watchPush();
    }, { passive: true });
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

  // ==================================================================
  // Размер текста документа
  // ==================================================================
  // Клиент, который плохо видит, увеличивает буквы сам и сразу, не зовя оператора и не
  // разбираясь в настройках. Ступени подобраны так, чтобы каждое нажатие было видно с одного
  // взгляда и чтобы в упоре текст был примерно вдвое крупнее обычного: мельче шаг незаметен,
  // крупнее шаг перепрыгивает нужный размер.
  var BIG_STEPS = [1, 1.25, 1.5, 1.75, 2];
  var SVG_NS = "http://www.w3.org/2000/svg";
  var big = { node: null, minus: null, plus: null };

  // Управление разрешено, если признак стоит хоть у одной страницы показа. Признак у страницы,
  // а действие на весь документ: оператор, поставивший отметку не на той странице, иначе получил
  // бы документ, где нажимать нечего, и решил бы, что возможность не работает.
  function bigAllowed() {
    if (!doc.config) return false;
    var pages = doc.config.pages || [];
    for (var i = 0; i < pages.length; i++) if (pages[i] && pages[i].bigText) return true;
    return false;
  }

  function bigScale() { return BIG_STEPS[doc.textStep || 0] || 1; }

  // Множитель ставится один раз на весь слой документа: заголовок, текст, пункты, варианты,
  // подписи полей и таблицы берут размер через него, поэтому документ меняется целиком и в тот
  // же кадр, без перерисовки разметки. Ничего не пересобирается, а значит не теряются ни
  // нарисованная подпись, ни вписанное в поле, ни место, до которого клиент долистал.
  function applyTextScale() {
    var k = bigScale();
    if (k === 1) el.document.style.removeProperty("--doc-scale");
    else el.document.style.setProperty("--doc-scale", String(k));
    var step = doc.textStep || 0;
    // Упор показывается погашенной кнопкой, а не молчанием: нажал и ничего не произошло это
    // поломка с точки зрения человека.
    if (big.minus) big.minus.disabled = step <= 0;
    if (big.plus) big.plus.disabled = step >= BIG_STEPS.length - 1;
    // Крупный текст удлиняет страницу: то, что помещалось при обычном размере, при упоре уже
    // не помещается, и кнопка «Ниже есть ещё» обязана появиться. Через кадр, потому что до
    // перерисовки высота ещё прежняя.
    requestAnimationFrame(обновитьКнопкуВниз);
    watchPush();
  }

  function bigStep(на) {
    var было = doc.textStep || 0;
    var стало = Math.max(0, Math.min(BIG_STEPS.length - 1, было + на));
    if (стало === было) return;
    doc.textStep = стало;
    applyTextScale();
  }

  // Значок в стиле остальных значков продукта: линии одной толщины, никаких картинок и эмодзи.
  // Буква «А» со знаком читается с одного взгляда и не требует перевода.
  function bigIcon(плюс) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var линии = ["M2 20 7.5 4 13 20", "M4.2 15.2h6.6", "M15.5 9h6.5"];
    if (плюс) линии.push("M18.75 5.75v6.5");
    линии.forEach(function (d) {
      var path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    });
    return svg;
  }

  function bigButton(id, подпись, плюс, на) {
    var b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = "big-text-btn";
    b.setAttribute("aria-label", подпись);
    b.title = подпись;
    b.appendChild(bigIcon(плюс));
    b.addEventListener("click", function () { bigStep(на); });
    return b;
  }

  function mountBigText() {
    if (big.node) return;
    var box = document.createElement("div");
    box.id = "bigTextPanel";
    box.className = "big-text";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Размер текста");
    var cap = document.createElement("div");
    cap.className = "big-text-cap";
    cap.textContent = "Размер текста";
    box.appendChild(cap);
    var row = document.createElement("div");
    row.className = "big-text-row";
    big.minus = bigButton("bigTextMinus", "Мельче", false, -1);
    big.plus = bigButton("bigTextPlus", "Крупнее", true, 1);
    row.appendChild(big.minus);
    row.appendChild(big.plus);
    box.appendChild(row);
    // Живёт на слое документа, а не в рамке страницы: рамка прокручивается и переписывается на
    // каждой перерисовке, а значок должен стоять в углу экрана неподвижно.
    el.document.appendChild(box);
    big.node = box;
    applyTextScale();
  }

  function unmountBigText() {
    if (big.node && big.node.parentNode) big.node.parentNode.removeChild(big.node);
    big.node = null; big.minus = null; big.plus = null;
    var frame = el.document.querySelector(".doc-frame");
    if (frame) frame.classList.remove("has-bigtext");
  }

  // Значок показывается только на том экране, который клиент увидел первым: там он и нужен, а
  // дальше уже сделал своё дело. Первым может оказаться не первая страница документа: она могла
  // не подойти по условию, и тогда значок встаёт на той, что открылась.
  function updateBigText() {
    var надо = bigAllowed() && doc.firstIndex != null && doc.index === doc.firstIndex;
    if (!надо) { unmountBigText(); return; }
    mountBigText();
    // Шапка отодвигается ровно настолько, чтобы название документа не заезжало под значок.
    // Отступ снимается вместе со значком, поэтому на остальных экранах заголовок во всю ширину.
    var frame = el.document.querySelector(".doc-frame");
    if (frame) frame.classList.add("has-bigtext");
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
    // Какой экран клиент увидел первым, известно только здесь: до этой строки экран мог
    // смениться из-за условия, и значок встал бы на странице, которой клиент не видел.
    if (doc.firstIndex == null) doc.firstIndex = doc.index;
    var pos = stepPosition();
    el.docProgress.textContent = screen.type === "thankyou"
      ? "" : "Шаг " + pos.current + " из " + pos.total;
    updateBigText();
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
        // Выделение фоном, как маркером.
        if (r.mark && /^#[0-9a-fA-F]{6}$/.test(r.mark)) {
          span.style.backgroundColor = r.mark;
          span.style.padding = "0 2px";
          span.style.borderRadius = "3px";
        }
        // Свой размер в точках сильнее ступени: оператор задал его руками, значит хотел именно
        // его. Точки в CSS те же, что в PDF, поэтому экран и бумага сходятся.
        var pt = parseInt(r.sizePt, 10);
        if (pt >= 8 && pt <= 40) span.style.fontSize = "calc(" + pt + "pt * var(--doc-scale))";
        else if (r.size === "l") span.className = "rt-l";
        else if (r.size === "h") span.className = "rt-h";
        span.textContent = seg;
        parent.appendChild(span);
      });
    });
  }

  // Оформление плашки и рамки: общее для текста, списка и таблицы, поэтому вынесено.
  function styleBox(node, b) {
    if (b.bg && /^#[0-9a-fA-F]{6}$/.test(b.bg)) node.style.background = b.bg;
    if (b.borderColor && /^#[0-9a-fA-F]{6}$/.test(b.borderColor)) {
      node.style.border = "1px solid " + b.borderColor;
      node.style.borderRadius = "6px";
    }
    var pad = parseInt(b.pad, 10);
    if (pad > 0) node.style.padding = Math.min(pad, 40) + "px";
    var lh = parseInt(b.lineHeight, 10);
    if (lh >= 100 && lh <= 250) node.style.lineHeight = (lh / 100).toFixed(2);
  }

  // Render one block: an image (with its width) or styled text.
  function appendBlock(parent, b) {
    if (!b) return;
    // Горизонтальная черта. Разрыв страницы это свойство бумаги: на планшете свои экраны, и
    // рисовать там нечего, поэтому он просто пропускается.
    if (b.kind === "divider") {
      var hr = document.createElement("div"); hr.className = "doc-divider";
      parent.appendChild(hr); return;
    }
    if (b.kind === "pagebreak") return;

    if (b.table && b.table.rows && b.table.rows.length) {
      var wrapT = document.createElement("div"); wrapT.className = "doc-table-wrap";
      var t = document.createElement("table"); t.className = "doc-table";
      var widths = b.table.widths || [];
      (b.table.rows || []).forEach(function (row, ri) {
        var tr = document.createElement("tr");
        (row || []).forEach(function (cell, ci) {
          var шапка = b.table.headerRow !== false && ri === 0;
          var td = document.createElement(шапка ? "th" : "td");
          if (widths[ci] > 0) td.style.width = widths[ci] + "%";
          td.textContent = String(cell == null ? "" : cell);
          tr.appendChild(td);
        });
        t.appendChild(tr);
      });
      styleBox(wrapT, b);
      wrapT.appendChild(t); parent.appendChild(wrapT); return;
    }

    if (b.list === "bullet" || b.list === "number") {
      // Каждая строка блока это пункт списка. Оформление внутри строки сохраняется: куски
      // текста разносятся по пунктам по переводам строки, как и в обычном абзаце.
      var box = document.createElement(b.list === "number" ? "ol" : "ul");
      box.className = "doc-list";
      var пункты = [[]];
      ((b.runs) || []).forEach(function (r) {
        var segs = String(r && r.text != null ? r.text : "").split("\n");
        segs.forEach(function (seg, i) {
          if (i > 0) пункты.push([]);
          if (seg.length) пункты[пункты.length - 1].push({ text: seg, bold: r.bold, italic: r.italic, color: r.color, size: r.size, sizePt: r.sizePt, mark: r.mark });
        });
      });
      пункты.forEach(function (куски) {
        if (!куски.length) return;
        var li = document.createElement("li");
        appendRuns(li, куски);
        box.appendChild(li);
      });
      if (!box.childNodes.length) return;
      // Выравнивание списка планшет не выполнял вовсе, а бумага выполняла: оператор задавал
      // «по правому краю», клиент видел список слева, а в подписанном листе он стоял справа.
      // Замер: на планшете textAlign «start» и правый край пункта на 164 при ширине 800, в
      // бумаге правый край 544.9 при правом поле 545.
      var выравн = String((b && b.align) || "").toLowerCase();
      if (выравн === "center" || выравн === "right" || выравн === "justify") box.style.textAlign = выравн;
      styleBox(box, b);
      parent.appendChild(box); return;
    }

    // Картинка бывает своя, из хранилища, и присланная внешней системой прямо в заказе. Вторая
    // приходит уже разобранной и проверенной сервером по первым байтам: сюда попадает только
    // PNG, JPG или BMP.
    if (b && b.imageUrl && (/^\/media\/[^/\\]+$/.test(b.imageUrl) || /^data:image\/(png|jpeg|bmp);base64,[A-Za-z0-9+/=]+$/.test(b.imageUrl))) {
      var fig = document.createElement("div"); fig.className = "doc-image";
      // Картинку тоже выравниваем. По умолчанию она стоит по центру: так было всегда, и
      // менять это для документов, где выравнивание не задано, нельзя.
      var ia = (b && b.align || "").toLowerCase();
      if (ia === "right") fig.style.textAlign = "right";
      else if (ia === "center") fig.style.textAlign = "center";
      // «Слева» и «по обоим краям» для картинки это одно и то же: прижать к левому полю.
      // Раньше ветки для «слева» не было вовсе, и картинка, которой оператор явно задал левое
      // выравнивание, вставала по центру: экран не выполнял заданное.
      else if (ia === "left" || ia === "justify") fig.style.textAlign = "left";
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
      var im = document.createElement("img");
      // Рисунка может не оказаться: его удалили из библиотеки, а документ остался со ссылкой.
      // Раньше клиент видел на этом месте пустоту и подписывал документ, не зная, что схемы,
      // плана или бланка в нём не хватает. Теперь на месте рисунка стоят слова, и молчаливой
      // потери нет: то же самое печатается и в бумаге.
      im.onerror = function () {
        var вместо = document.createElement("div");
        вместо.className = "doc-image-missing";
        вместо.textContent = "Рисунок не отображается. Обратитесь к сотруднику, прежде чем подписывать.";
        if (im.parentNode) im.parentNode.replaceChild(вместо, im);
      };
      im.src = b.imageUrl;
      var w = Math.min(Math.max(parseInt(b.imageWidth, 10) || 100, 10), 100);
      im.style.width = (wrap === "left" || wrap === "right") ? "100%" : (w + "%");
      fig.appendChild(im); parent.appendChild(fig);
    } else {
      var text = document.createElement("div"); text.className = "doc-text";
      // Выравнивание задано на весь абзац, а не на кусок текста: так же оно попадёт и в PDF.
      var al = (b && b.align || "").toLowerCase();
      if (al === "center" || al === "right" || al === "justify") text.style.textAlign = al;
      styleBox(text, b);
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
    add(page.inputs, 5);
    items.sort(function (a, b) { return (a.ord - b.ord) || (a.kind - b.kind) || (a.index - b.index); });
    return items;
  }

  function renderPage(pageIndex) {
    var page = doc.config.pages[pageIndex];
    doc.docPadResize = null;
    // Пересчёт перьев, поставленных внутри страницы. Список свой у каждой отрисовки: старые
    // холсты со страницы уже ушли, и трогать их нельзя.
    var подогнатьПеро = [];
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

    // Снять отметки с пунктов, которые не могут стоять вместе с этим. Возвращает, сняла ли
    // что-нибудь: от этого зависит, надо ли перерисовывать страницу.
    function снятьВзаимоисключающие(ключ) {
      var снято = false;
      (page.checkRules || []).forEach(function (rule) {
        if (!rule || rule.kind !== "exclusive" || !rule.keys) return;
        if (rule.keys.indexOf(ключ) < 0) return;
        (page.checkboxes || []).forEach(function (cb, i) {
          if (!cb || !cb.key || cb.key === ключ) return;
          if (rule.keys.indexOf(cb.key) < 0) return;
          var k = checkKey(pageIndex, i);
          if (doc.checks[k]) { doc.checks[k] = false; снято = true; }
        });
      });
      return снято;
    }

    function makeCheckbox(cb, i) {
      var key = checkKey(pageIndex, i);
      var label = document.createElement("label");
      label.className = "check" + (doc.checks[key] ? " checked" : "");
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!doc.checks[key];
      input.addEventListener("change", function () {
        doc.checks[key] = input.checked;
        // Взаимоисключающие пункты: отметка снимает остальные из того же правила. Иначе клиент
        // отмечает «согласен» и «отказываюсь» разом, и документ подписан сам себе противореча.
        var снято = input.checked && cb.key ? снятьВзаимоисключающие(cb.key) : false;
        label.classList.toggle("checked", input.checked);
        // Пометка «не отмечено» снимается сразу, как только пункт отметили: человек должен
        // видеть, что список требований тает, а не что подсветка висит до конца.
        if (input.checked) clearMiss(label);
        // Перерисовываем, только если от этого пункта что-то зависит: иначе страница
        // дёргалась бы под пальцем на каждой галочке без всякой причины.
        // Наблюдателю отметка нужна всегда, даже когда от неё на странице ничего не зависит и
        // перерисовки не будет: он должен видеть то же, что клиент, а не через раз.
        watchPush();
        // Перерисовка обязательна и тогда, когда правило сняло соседние отметки: без неё
        // галочки на экране остались бы стоять, хотя в памяти их уже нет.
        if (снято || (cb.key && dependsOn(cb.key))) rerender(); else updateFooter();
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
    // Кнопка «отметить всё» над пунктами: у длинного согласия иначе двадцать нажатий подряд.
    // Ставится только когда видимых пунктов действительно много: над двумя она смотрелась бы
    // насмешкой.
    function makeCheckAll() {
      var видимых = (page.checkboxes || []).filter(function (cb, i) {
        return cb && condHolds(cb.visibleWhen);
      });
      if (видимых.length < 3) return null;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-ghost check-all";
      function все() {
        return видимых.every(function (cb) {
          var i = (page.checkboxes || []).indexOf(cb);
          return doc.checks[checkKey(pageIndex, i)];
        });
      }
      function подпись() { btn.textContent = все() ? "Снять все отметки" : "Отметить всё"; }
      подпись();
      btn.addEventListener("click", function () {
        var ставим = !все();
        видимых.forEach(function (cb) {
          var i = (page.checkboxes || []).indexOf(cb);
          doc.checks[checkKey(pageIndex, i)] = ставим;
          // Взаимоисключающие пункты нельзя отметить разом: сервер такую подпись не примет, а
          // клиент об этом узнал бы только в конце, уже расписавшись. Снимаем соседей тут же,
          // как это делает обычная отметка руками.
          if (ставим && cb && cb.key) снятьВзаимоисключающие(cb.key);
        });
        watchPush();
        rerender();
      });
      return btn;
    }

    // Поле ввода: клиент вписывает значение с экранной клавиатуры. Значение живёт как имя, то
    // есть работает в условиях ровно так же, как отметка чекбокса.
    function makeInput(inp) {
      var box = document.createElement("div");
      box.className = "page-input";
      box.setAttribute("data-miss-input", inp.key || "");
      if (inp.label) {
        var t = document.createElement("label");
        t.className = "page-input-title";
        t.textContent = inp.label;
        if (inp.required) {
          var req = document.createElement("span");
          req.className = "req"; req.textContent = "*";
          t.appendChild(req);
        }
        box.appendChild(t);
      }
      var field = document.createElement("input");
      // Вид значения решает, какую клавиатуру покажет планшет: телефонную, числовую или
      // обычную. Это не проверка, а удобство: проверяют планшет перед «Далее» и сервер.
      var вид = (inp.type || "text").toLowerCase();
      field.type = вид === "date" ? "date" : вид === "phone" ? "tel" : вид === "number" ? "text" : "text";
      if (вид === "number") field.setAttribute("inputmode", "decimal");
      if (вид === "phone") field.setAttribute("inputmode", "tel");
      field.className = "page-input-field";
      if (inp.placeholder) field.placeholder = inp.placeholder;
      // Значение уже могло прийти из тега или быть введённым до перелистывания страницы.
      var было = doc.inputs[inp.key];
      var значение = было != null ? было : (inp.value || "");
      // Поле вида «дата» принимает только yyyy-MM-dd и молча выбрасывает всё прочее. Внешняя
      // система шлёт даты как «01.01.1990», и такое значение пропадало: клиент видел пустое
      // поле, а обязательное ещё и не пускало дальше, пока он не наберёт дату заново.
      if (вид === "date") значение = вДатуПоля(значение);
      field.value = значение;
      doc.inputs[inp.key] = field.value;
      var подсказка = document.createElement("div");
      подсказка.className = "page-input-hint";
      box.appendChild(field); box.appendChild(подсказка);
      function проверить() {
        var плохо = badInput(вид, field.value);
        подсказка.textContent = плохо || "";
        box.classList.toggle("bad", !!плохо);
        return !плохо;
      }
      field.addEventListener("input", function () {
        doc.inputs[inp.key] = field.value;
        clearMiss(box);
        проверить();
        watchPush();
        // Перерисовка только если от поля что-то зависит: иначе страница дёргалась бы под
        // каждым набранным символом и уводила курсор. Но и в этом случае курсор надо вернуть:
        // страница пересобирается целиком, поле создаётся заново, экранная клавиатура
        // закрывается, и набрать телефон посимвольно было физически невозможно.
        if (inp.key && dependsOn(inp.key)) {
          var место = field.selectionStart, конец = field.selectionEnd, докуда = el.docBody.scrollTop;
          rerender();
          var снова = el.docBody.querySelector('[data-miss-input="' + (inp.key || "") + '"] .page-input-field');
          if (снова) {
            try { снова.focus({ preventScroll: true }); } catch (e) { снова.focus(); }
            // Не у всех видов поля есть каретка: у date выбор диапазона выбрасывает исключение.
            try { if (место != null) снова.setSelectionRange(место, конец); } catch (e) { /* вид поля без каретки */ }
          }
          el.docBody.scrollTop = докуда;
        } else updateFooter();
      });
      field.addEventListener("blur", проверить);
      // Проверяем сразу при отрисовке, а не только по вводу: значение могло прийти из заказа
      // негодным (в телефонное поле «уточнить»), и клиент упирался в «Далее» с пустой подсказкой
      // под полем и надписью «Нужно заполнить это поле» над заполненным полем.
      проверить();
      return box;
    }

    var поставленаКнопкаВсё = false;
    pageItems(page, blocks).forEach(function (it) {
      if (!condHolds(it.item.visibleWhen)) return;
      if (it.kind === 1) {
        if (page.showCheckAll && !поставленаКнопкаВсё) {
          поставленаКнопкаВсё = true;
          var кн = makeCheckAll();
          if (кн) body.appendChild(кн);
        }
        checksBox().appendChild(makeCheckbox(it.item, it.index));
        return;
      }
      checks = null;
      if (it.kind === 0) appendBlock(body, it.item);
      else if (it.kind === 2) body.appendChild(makeGroup(it.item));
      else if (it.kind === 3) body.appendChild(makePageSignature(it.item));
      else if (it.kind === 4) body.appendChild(makePageScan(it.item));
      else body.appendChild(makeInput(it.item));
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
        if (pad) pad.clear();
        // Память планшета чистится и тогда, когда пера уже нет: прежде всё стирание висело под
        // проверкой на перо, и без него подпись оставалась в памяти при пустом на вид поле.
        забытьПоле(sig.key);
        wrap.classList.remove("has-ink"); updateFooter();
        // Иначе у наблюдателя осталась бы подпись, которой уже нет.
        watchPush();
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
      var pad = new SignaturePad(canvas, ПЕРО);
      attachCoalesced(canvas);
      doc.pagePads[sig.key] = pad;

      // Снять с пера то, что на нём нарисовано, и сложить в память планшета: сам росчерк, размер
      // холста под него и обе картинки. Одним местом на все случаи, чтобы росчерк и картинка не
      // могли разойтись: разошлись бы, и в запись уехало бы не то, что клиент видел на экране.
      function запомнить() {
        var точки = null;
        try { точки = pad.isEmpty() ? null : pad.toData(); } catch (e) { точки = null; }
        if (!точки || !точки.length) { забытьПоле(sig.key); return; }
        var r = wrap.getBoundingClientRect();
        // Коробку поля могли померить в тот миг, когда её на экране ещё нет: ноль на ноль. Это
        // не повод стирать подпись, в памяти остаётся снятое прошлый раз. Стирает поле только
        // пустое перо, и только оно.
        if (!r.width || !r.height) return;
        // Своя копия: перо держит эти точки живым массивом и дописывает в него следующий
        // росчерк, а память планшета обязана хранить снятое сейчас, а не ссылку на чужое.
        doc.signStrokes[sig.key] = JSON.parse(JSON.stringify(точки));
        doc.signGeom[sig.key] = { w: r.width, h: r.height, k: Math.max(window.devicePixelRatio || 1, 1) };
        doc.signs[sig.key] = рисунокПоля(sig.key);
        doc.signThumbs[sig.key] = padThumb(canvas);
      }

      // Поворот планшета или всплывшая системная панель меняют коробку холста, но не его битмап:
      // нарисованное растягивается, а новая линия идёт со смещением от пальца. На отдельном
      // экране подписи это учтено, у полей внутри страницы забыли.
      подогнатьПеро.push(function () {
        var r2 = wrap.getBoundingClientRect();
        if (!r2.width || !r2.height) return;
        var k = Math.max(window.devicePixelRatio || 1, 1);
        var ш = Math.round(r2.width * k), в = Math.round(r2.height * k);
        // Размер битмапа задаётся даже тогда, когда он и так такой: это стирает холст. Если
        // коробка не менялась, стирать и перерисовывать нечего.
        if (canvas.width === ш && canvas.height === в) return;
        // Из пера, а если оно посреди росчерка отдало пустоту, то из памяти планшета. Картинкой
        // подпись отсюда не берётся вовсе: перо картинку своей не считает и стёрло бы её.
        var было = null;
        try { было = pad.isEmpty() ? null : pad.toData(); } catch (e) { было = null; }
        if (!было || !было.length) было = doc.signStrokes[sig.key] || null;
        canvas.width = ш;
        canvas.height = в;
        canvas.getContext("2d").scale(k, k);
        pad.clear();
        if (было && было.length) { try { pad.fromData(было); } catch (e) { /* не восстановилась */ } }
        // Холст стал другого размера, значит и картинка для записи должна стать другого: в PDF
        // подпись садится по пропорциям своей картинки, и старая встала бы на лист сплюснутой.
        запомнить();
        wrap.classList.toggle("has-ink", !pad.isEmpty());
      });

      // Возвращаем то, что клиент уже нарисовал в этом поле: страница перерисовывается от любой
      // отметки, и подпись обязана пережить перерисовку.
      // Точками росчерка, а не картинкой. Картинка ложится на холст мимо пера: точек в перо она
      // не кладёт, поэтому перо считает поле нарисованным, но пустым по данным, и ближайший же
      // пересчёт холста (поворот планшета, всплывшая клавиатура) стирал подпись начисто, а
      // следующий росчерк ложился уже на пустое поле и уносил всё, что было до него, в запись.
      // Точки же перо принимает как свои: они переживают любой пересчёт, и подпись, которую
      // видно, это ровно та подпись, которую планшет отправит.
      var сохранённый = doc.signStrokes[sig.key];
      if (сохранённый && сохранённый.length) {
        try {
          pad.fromData(сохранённый);
          wrap.classList.add("has-ink");
          // Коробка поля могла стать другой с прошлой отрисовки: раскрывшийся по условию блок
          // сдвигает вёрстку. Картинка пересобирается под нынешний холст.
          запомнить();
        } catch (e) { /* не восстановилась */ }
      }
      var сессияПоля = doc.session;
      pad.addEventListener("endStroke", function () {
        // Конец росчерка приходит от окна и может прийти уже после смены документа: писать в
        // состояние следующего клиента нельзя.
        if (doc.session !== сессияПоля) return;
        запомнить();
        watchPush();
        wrap.classList.toggle("has-ink", !pad.isEmpty());
        if (!pad.isEmpty()) clearMiss(wrap.closest(".page-sign"));
        // От поля подписи может зависеть показ блока: «покажите это, когда клиент расписался».
        if (sig.key && dependsOn(sig.key)) { rerender(); return; }
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
          // От поля сканирования тоже может зависеть показ: «покажите это, когда код считан».
          if (sc.key && dependsOn(sc.key)) { rerender(); return; }
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
    // Перья внутри страницы пересчитываются вместе с окном, как и итоговое поле подписи.
    // Без проверки на пустоту списка: перья встают не здесь, а следующим заданием (холст меряют
    // после того, как вёрстка встала), и на этой строке список ещё пуст всегда. Проверка
    // оставляла страницу без пересчёта вовсе, поэтому холст поля не менялся ни на поворот
    // планшета, ни на всплывшую клавиатуру: нарисованное растягивалось вместе с коробкой, а
    // новая линия шла мимо пальца тем сильнее, чем правее клиент вёл.
    doc.docPadResize = function () { подогнатьПеро.forEach(function (f) { try { f(); } catch (e) { /* поле уже ушло */ } }); };
    // На последней странице информационного документа дальше идти некуда: следующий экран это
    // прощание. Поэтому кнопка называется «Готово», а не «Далее»: клиент должен понимать, что
    // нажатием он заканчивает, а не переходит куда-то ещё.
    var последняя = isInfoDoc() && stepIndex(doc.index, 1) === doc.screens.length - 1;
    renderFooter({ back: doc.index > 0, next: true, nextLabel: последняя ? "Готово" : "Далее" });
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
    var сессияЭкрана = doc.session;
    doc.pad.addEventListener("beginStroke", function () { hint.style.display = "none"; });
    doc.pad.addEventListener("endStroke", function () {
      updateFooter();
      // Итоговая подпись уходит наблюдателю такой, какая она уже нарисована. Не на каждое
      // движение пера, а по концу штриха: так линия появляется у оператора почти сразу, а
      // канал не забивается сотней картинок в секунду.
      // Библиотека подписи слушает отпускание на окне, а не на холсте: конец росчерка приходит
      // и после того, как документ уже сменили и перо обнулили. Без этой проверки страница
      // падала с ошибкой прямо в руках у клиента.
      if (!doc.pad || doc.session !== сессияЭкрана) return;
      doc.finalInk = doc.pad.isEmpty() ? "" : padThumb(canvas);
      // И сам росчерк, чтобы вернуть подпись при возврате на этот экран. Перо создаётся заново
      // на каждый заход, и без сохранённого росчерка подпись пропадала, стоило клиенту нажать
      // «Назад» и вернуться: на экране пусто, а у оператора в наблюдении она ещё висит.
      // Точки, а не картинка: почему именно так, написано у восстановления ниже.
      try { doc.finalStrokes = doc.pad.isEmpty() ? null : doc.pad.toData(); } catch (e) { doc.finalStrokes = null; }
      watchPush();
    });
    sizeCanvas();
    // Возвращаем подпись, если клиент уже расписался и уходил перечитать документ или моргнул
    // Wi-Fi. Точками росчерка, а не картинкой: картинка ложится на холст мимо пера и приходит
    // с задержкой, потому что грузится как изображение. Перо после неё считает поле пустым, и
    // ближайший же замер холста (строка ниже, поворот экрана, системная панель) стирал подпись,
    // а картинка догружалась поверх уже стёртого. Клиент видел свою подпись на экране, а кнопка
    // ПОДПИСАТЬ отвечала «Поставьте подпись в выделенном поле»: выйти из этого было некуда.
    // Точки же перо принимает как свои: рисуются сразу, переживают любой замер, и подпись,
    // которую видно, это ровно та подпись, которую планшет отправит.
    if (doc.finalStrokes && doc.finalStrokes.length) {
      try { doc.pad.fromData(doc.finalStrokes); hint.style.display = "none"; } catch (e) { /* не восстановилась */ }
    }
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
    // Блоки прощания живут под условиями показа так же, как всё остальное в документе, и
    // показывать блок «вам придёт результат на почту» тому, кто почту не оставил, нельзя.
    // Считаем видимость прямо здесь: ниже отметки клиента стираются ради его же тайны, и
    // проверять условие будет уже не по чему. Условие с уцелевших блоков снимаем: экран
    // прощания рисуется заново при переподключении, и по стёртым отметкам все блоки под
    // условием исчезли бы у клиента на глазах.
    var blocks = visible((doc.config && doc.config.thankYouBlocks) || []).map(function (b) {
      var копия = {};
      Object.keys(b).forEach(function (имя) { if (имя !== "visibleWhen") копия[имя] = b[имя]; });
      return копия;
    });
    var держать = (doc.config && doc.config.thankYouSec) || 6;
    // PRIVACY: the title may contain the signer's data (for example "Согласие {{ФИО}}"), so it is
    // wiped as soon as signing is done, together with the resolved document held in memory. Only
    // the thank-you page survives on screen: она собрана оператором и личных данных не несёт.
    el.docTitle.textContent = "";
    doc.config = { thankYouText: thanks, thankYouRuns: runs, thankYouBlocks: blocks,
      thankYouAlign: align, thankYouSec: держать, pages: [] };
    // Ответы клиента стираются прямо здесь, а не через минуту, когда планшет вернётся к рекламе.
    // Блоки прощания уже посчитаны выше и условий на себе не несут, поэтому стирать безопасно.
    // Экран прощания личных данных не показывает: он собран оператором.
    забытьПодписанта();
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

    // Страница выше экрана листается пальцем, но человек об этом не догадывается: он видит
    // низ страницы, кнопку «Далее» и уходит дальше, не прочитав середину и не отметив то, что
    // там стоит. Поэтому внизу появляется заметная кнопка, и появляется только тогда, когда
    // ниже действительно что-то есть. Она не просто значок: по ней можно нажать, и страница
    // подъедет сама, потому что пожилому человеку нажать проще, чем тянуть пальцем.
    var вниз = document.createElement("button");
    вниз.type = "button";
    вниз.className = "btn scroll-down hidden";
    вниз.id = "btnScrollDown";
    вниз.setAttribute("aria-label", "Пролистать вниз, ниже есть ещё");
    вниз.innerHTML = '<span class="scroll-down-text">Ниже есть ещё</span>'
                   + '<span class="scroll-down-arrow" aria-hidden="true"></span>';
    вниз.addEventListener("click", function () {
      if (!el.docBody) return;
      // Чуть меньше экрана: так последняя прочитанная строка остаётся вверху и человек видит,
      // откуда продолжать. Полный экран за нажатие перескакивал бы через неё.
      var шаг = Math.max(120, Math.round(el.docBody.clientHeight * 0.8));
      el.docBody.scrollBy({ top: шаг, behavior: "smooth" });
    });
    el.docFooter.appendChild(вниз);

    if (opts.clear) {
      var clear = document.createElement("button");
      clear.className = "btn btn-ghost"; clear.textContent = "Очистить";
      clear.addEventListener("click", function () {
        if (!doc.pad) return;
        doc.pad.clear();
        doc.finalInk = "";
        // И сам росчерк: перо очистилось, а сохранённая подпись оставалась в памяти планшета и
        // возвращалась на экран, стоило уйти назад и вернуться. Клиент стёр её как раз для того,
        // чтобы её не было, и подписать стёртое он не соглашался.
        doc.finalStrokes = null;
        // Поле возвращается в исходный вид целиком, вместе с подсказкой: без неё клиент видит
        // пустой прямоугольник и не понимает, что от него теперь хотят.
        var подсказка = el.docBody.querySelector(".sign-hint");
        if (подсказка) подсказка.style.display = "";
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
    следитьЗаПрокруткой();
    // Высота содержимого известна только после того, как оно легло в страницу. Считать её
    // прямо здесь значило бы всегда получать нули и не показать кнопку ни разу.
    requestAnimationFrame(обновитьКнопкуВниз);
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
        // Картинка собирается из росчерка прямо сейчас: росчерк это подпись, а картинка её
        // отпечаток, и отпечаток обязан быть снят с того, что клиент видел последним. Готовая
        // картинка рядом остаётся страховкой на случай, если собрать не вышло.
        var img = рисунокПоля(sg.key) || doc.signs[sg.key] || "";
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

  // Вписанные значения. Собираются только с видимых страниц и видимых полей: скрытое условием
  // поле клиент не видел, и его значения в записи быть не должно.
  function collectInputs() {
    var out = [];
    (doc.config.pages || []).forEach(function (page) {
      if (!condHolds(page.visibleWhen)) return;
      (page.inputs || []).forEach(function (inp) {
        if (!inp || !condHolds(inp.visibleWhen)) return;
        var v = String(doc.inputs[inp.key] != null ? doc.inputs[inp.key] : (inp.value || "")).trim();
        // Пустое значение тоже сообщается. Раньше пустое поле просто не попадало в запись, и
        // «клиент видел поле и оставил его пустым» становилось неотличимо от «поля ему не
        // показывали». Хуже того, на бумаге вместо пустого печаталось значение, присланное
        // заказом, то есть ровно то, что клиент своими руками стёр. Замер: две бумаги, одна
        // после стирания телефона и адреса, другая где клиент ничего не трогал, совпали буква
        // в букву, а записи разошлись полностью.
        out.push({ key: inp.key || "", label: inp.label || "", value: v });
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
          // Вместе с оформлением подписи варианта. Бумага печатает варианты из записи, а не из
          // документа, и без кусков оформления жирное, цветное и выделенное превращалось на
          // листе в обычный чёрный текст: клиент видел одно, а подписывал на вид другое.
          options: (g.options || []).map(function (o) {
            return { key: o.key, label: o.label, labelRuns: o.labelRuns || [] };
          })
        });
      });
    });
    return groups;
  }

  function submitSignature() {
    if (doc.submitting || !doc.pad || doc.pad.isEmpty()) return;
    doc.submitting = true;
    // Таймер возврата к рекламе останавливается на время отправки. Человек, который расписался
    // и нажал кнопку, бездействующим не является, а таймер этого не знал и добивал сессию, пока
    // запрос был в пути. Замер: возврат через 2 секунды, отправка задержана на 5; записи не
    // появилось, планшет ушёл к рекламе, нарисованная подпись пропала, и клиенту не сказали
    // ничего. Отдельно тот же таймер стирал и подсказку «Нажмите ПОДПИСАТЬ ещё раз» вместе с
    // самой кнопкой: выполнить собственную просьбу планшета было нечем.
    //
    // Обратно таймер взводится только там, где кнопка возвращается клиенту, то есть в ветках
    // поправимого отказа ниже.
    stopIdle();
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
        signatures: collectSignatures(), scans: collectScans(), inputs: collectInputs(),
        signature: doc.pad.toDataURL("image/png"), submissionId: doc.submissionId,
        // Имя показа, под которым мы получили этот документ. Сервер сверит его со своим и
        // откажет, если на планшет успели послать другой документ: отметки этого клиента иначе
        // легли бы в снимок следующего.
        sessionId: doc.serverSession || "" })
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
      // Причину отказа сервер пишет в теле. Без неё человеку нечего сказать, а «попробуйте ещё
      // раз» при отказе по существу это бесконечная кнопка.
      return r.text().then(function (t) {
        var причина = "";
        try { причина = (JSON.parse(t) || {}).error || ""; } catch (e) { причина = ""; }
        var err = new Error("bad status " + r.status);
        err.status = r.status;
        err.reason = причина;
        // Повтор помогает только при сбое связи. Отказ по существу (400), закрытая сессия (409)
        // и потерянный доступ (401, 403) от повтора не изменятся.
        err.permanent = r.status === 400 || r.status === 401 || r.status === 403 || r.status === 409;
        throw err;
      });
    }).catch(function (err) {
      // A failed signature is the worst failure for the client, so it is always reported.
      reportError("Не удалось отправить подпись", err && (err.stack || err.message || String(err)));
      if (doc.session !== session) return;
      var note = document.getElementById("footerNote");
      if (err && err.permanent) {
        // Кнопку не возвращаем: нажимать её бессмысленно, а нарисованная подпись остаётся
        // на экране, чтобы сотрудник видел, что человек расписался.
        // Текст сервера показывается только при отказе по существу (400): там он написан для
        // человека и по-русски, вроде «Не заполнено обязательное: пункт «Я согласен»». У 401,
        // 403 и 409 в теле лежит служебная пометка для внешней системы, и клиенту от неё нет
        // никакой пользы: там свои понятные предложения.
        if (note) note.textContent = (err.status === 400 && err.reason)
          ? err.reason
          : (err.status === 409
            ? "Сессия подписания уже завершена. Обратитесь к сотруднику: документ нужно отправить заново."
            : "Планшет потерял доступ. Обратитесь к сотруднику.");
        // 400 это «чего-то не хватает», и это поправимо: клиент возвращается назад, дозаполняет
        // и подписывает. Кнопку поэтому возвращаем, иначе она умирала навсегда и выйти из этого
        // можно было только по таймеру бездействия, а при выключенном таймере вообще никак.
        // 401, 403 и 409 от повтора не изменятся: там кнопка остаётся выключенной.
        if (err.status === 400) {
          doc.submitting = false;
          // Кнопка вернулась клиенту, значит и таймер бездействия снова уместен: человек опять
          // что-то делает, а не ждёт ответа службы.
          startIdle();
          var текст = note ? note.textContent : "";
          updateFooter();
          if (note) note.textContent = текст;
        }
        return;
      }
      doc.submitting = false;
      startIdle();                                  // кнопка вернулась, таймер снова уместен
      updateFooter();                               // re-enable the button first...
      if (note) note.textContent = "Не удалось отправить: нет связи с сервером. Нажмите ПОДПИСАТЬ ещё раз."; // ...then show the error so it is not wiped
    });
  }

  window.addEventListener("resize", function () {
    if (doc.docPadResize) doc.docPadResize();
    // Поворот планшета меняет высоту экрана, а значит и то, помещается ли страница.
    обновитьКнопкуВниз();
  });
  // Слушаем на всём документе, а не только на слое документа. Оверлей «Соединение потеряно»
  // лежит поверх всего и не является потомком этого слоя: клиент тыкал в потемневший экран,
  // таймер бездействия этого не видел и дотикивал, а по истечении стирал всё заполненное.
  ["pointerdown", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, resetIdle, true);
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
  // Какой слой на экране прямо сейчас. Нужно переподключению: решить, тот же это документ или
  // новый, можно только зная, что документ вообще показан.
  var activeLayer = "";

  function showLayer(which) {
    activeLayer = which;
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
    // Код уходит и из памяти: наблюдению он нужен ровно столько, сколько виден клиенту, а
    // дальше это чужой код в планшете, который никому уже не показывают.
    scan.lastCode = "";
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
    scan.inline = (opts && typeof opts.onCode === "function") ? opts.onCode : null;
    if (scan.doneTimer) { clearTimeout(scan.doneTimer); scan.doneTimer = null; }  // stale "return" timer
    clearScanResult();                            // и код прошлого клиента вместе с ним
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
  // Обрыв связи для проверок: роняет соединение так же, как это делает пропавший Wi-Fi, и
  // страница переподключается своим обычным путём. Продукт этим не пользуется.
  window.__sk_test_drop = function () { if (conn) conn.stop(); };

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
    var inline = scan.inline;
    stopScan();
    el.scanMsg.textContent = "";
    // Код запоминается и уходит наблюдателю после остановки камеры, а не до неё: stopScan
    // стирает показанный код вместе с камерой, и записанное раньше он же и затирал. Рассылка
    // наблюдателю идёт пачкой через десятую долю секунды, то есть заведомо после stopScan.
    scan.lastCode = code;
    el.scanCode.textContent = code;
    el.scanResult.classList.remove("hidden");
    watchPush();

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
    if (cmd.mode === "document") {
      // Переподключение внутри той же сессии подписания. Пересоздать документ значило бы
      // сбросить клиента на первую страницу и стереть всё отмеченное из-за моргнувшего Wi-Fi.
      // Сервер прислал бы другое имя сессии, будь это другой показ.
      // Тот же самый показ: пересоздавать документ нельзя, это сбросило бы клиента на первую
      // страницу и стёрло всё отмеченное. Слой при этом не проверяем: клиент может быть на
      // камере, и раньше моргнувший Wi-Fi во время сканирования стирал всю анкету, хотя тот же
      // обрыв на обычной странице проходил без потерь.
      if (cmd.sessionId && doc.serverSession === cmd.sessionId && doc.config && doc.screens && doc.screens.length) {
        // Слой возвращаем только если клиент не на камере: иначе закроем ему сканирование.
        if (activeLayer !== "scan") { showLayer("document"); renderScreen(); startIdle(); }
        return;
      }
      // Страница перезагрузилась посреди подписания. Отличаем от обычного показа так: это
      // первая команда после загрузки страницы, а документ на планшете лежит уже не первую
      // секунду. Значит клиент что-то заполнял, и оно пропало: планшет между загрузками ничего
      // не хранит.
      //
      // Молчать нельзя. Клиент оказывается на первой странице, внизу пусто, и он не понимает,
      // что случилось с тем, что он уже отметил. А случается это не редко: «Обновить страницу»
      // есть кнопкой у оператора, действием расписания и шагом автолечения.
      //
      // Заполненное не восстанавливается намеренно: держать ответы клиента на планшете между
      // загрузками значило бы оставлять их там и после его ухода, а это противоречит правилу,
      // по которому данные подписанта уходят с планшета сразу.
      var потеряноПриПерезагрузке = перваяКомандаПослеЗагрузки
        && (cmd.shownSecondsAgo || 0) >= 5;
      перваяКомандаПослеЗагрузки = false;
      applyDocument(cmd.document, cmd.sessionId);
      if (потеряноПриПерезагрузке) {
        var подсказка = el.footerNote || document.getElementById("footerNote");
        if (подсказка) {
          подсказка.textContent = "Страница обновилась. То, что вы уже отмечали и вписывали, "
            + "не сохранилось: пожалуйста, заполните документ заново.";
          подсказка.classList.add("note-warn");
        }
      }
    }
    else { перваяКомандаПослеЗагрузки = false; applySlides(cmd.slides); }
  }

  // ==================================================================
  // Enrollment
  // ==================================================================
  // Почему планшет оказался на экране активации. Сервер обрывает соединение через четверть
  // секунды после сообщения об отзыве, и следом onclose показывал экран активации заново, уже
  // без объяснения: оператор видел обычный «введите код» и не понимал, что случилось.
  var причинаАктивации = "";

  function showEnroll(message) {
    stopSlides();
    // Close the camera and wipe any signer data: activation can be reached from any screen
    // (a revoked token, a reset device), and the scan layer would otherwise cover this one.
    stopScan();
    clearDocState();
    // Экран активации это тоже слой, и назвать его надо своим именем: наблюдение смотрит на
    // открытый слой, и планшет, ушедший на активацию прямо с камеры, иначе так и показывался бы
    // оператору снимающим код.
    activeLayer = "enroll";
    el.scan.classList.add("hidden");
    el.slideshow.classList.add("hidden");
    el.document.classList.add("hidden");
    hideStatus();
    el.enroll.classList.remove("hidden");
    if (message) причинаАктивации = message;
    el.enrollMsg.textContent = message || причинаАктивации || "";
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
      .then(function () { причинаАктивации = ""; el.enrollCode.value = ""; connect(); })
      .catch(function () { el.enrollMsg.textContent = "Код недействителен или истёк. Проверьте и попробуйте снова."; });
  });

  // ==================================================================
  // SignalR connection
  // ==================================================================
  var conn = null;

  // Reported on every connect so the operator can see which build a tablet is actually running.
  // A WebView that has not reloaded since an older deploy keeps working but ignores anything
  // added since, and without this the only symptom is a command that seems to do nothing.
  var APP_VERSION = "8.1";

  // ==================================================================
  // Размер экрана планшета
  // ==================================================================
  // Окно наблюдения показывает уменьшенный экран планшета один в один, но настоящие размеры
  // знает только сам планшет: сервер о них не знал ничего, и окно рисовало рамку по собственным
  // числам, к планшету отношения не имевшим. Планшет сообщает размер при подключении и дальше
  // при каждом изменении: поворот, системная панель, изменение области просмотра.
  //
  // Отдельно от потока состояния, который уходит наблюдателю: тот идёт, только пока за планшетом
  // кто-то смотрит, и обрывается вместе с наблюдением. Сервер же должен знать размер и заранее,
  // чтобы окно наблюдения открылось правильной формы ещё до первого кадра, и после того, как
  // планшет ушёл со связи.
  //
  // Пачками, а не на каждое событие. Поворот планшета это не одно изменение размера, а очередь
  // из них, пока система доводит разметку, и каждое ушло бы отдельным сообщением. Треть секунды
  // заведомо длиннее этой очереди и незаметна оператору, который смотрит на экран человека.
  var SCREEN_HOLD = 300;
  var screenTimer = null;
  var screenSent = null;    // что уже принято сервером: то же самое второй раз не отправляется
  var screenKnown = true;   // знает ли служба этот вызов; служба старше страницы его не знает
  var screenMine = false;   // узнала ли служба в этом подключении планшет; иначе говорить некому

  function screenNow() {
    // Те же точки, в которых планшет сам рисует: разметка идёт в них, и окну наблюдения нужны
    // они, а не пиксели матрицы. Плотность уходит отдельным числом и в размер не подмешивается.
    var w = Math.round(window.innerWidth || document.documentElement.clientWidth || 0);
    var h = Math.round(window.innerHeight || document.documentElement.clientHeight || 0);
    if (!(w > 0) || !(h > 0)) return null;
    var r = Number(window.devicePixelRatio);
    if (!(r > 0) || !isFinite(r)) r = 1;
    // До сотых: дальше идут только погрешности вычисления масштаба, из-за которых планшет
    // сообщал бы «изменение» на ровном месте.
    return { w: w, h: h, r: Math.round(r * 100) / 100 };
  }

  function screenSend() {
    screenTimer = null;
    if (!conn || !screenMine || !screenKnown) return;
    var s = screenNow();
    if (!s) return;
    var ключ = s.w + "x" + s.h + "@" + s.r;
    if (ключ === screenSent) return;
    // Отправленным считается только то, что служба действительно приняла и подтвердила: иначе
    // сообщение, потерянное на разрыве связи или отвергнутое службой (планшет отозвали),
    // считалось бы доставленным, и размер оставался бы неверным до следующего поворота.
    conn.invoke("ReportScreenSize", s.w, s.h, s.r).then(function (принято) {
      screenSent = принято === false ? null : ключ;
    }).catch(function (e) {
      screenSent = null;
      // Служба старше страницы: такого метода у неё нет, и звонить туда на каждый поворот
      // незачем. До следующего подключения планшет об этом молчит.
      if (/method does not exist/i.test(String((e && e.message) || e))) screenKnown = false;
    });
  }

  function screenPush(сразу) {
    clearTimeout(screenTimer);
    screenTimer = null;
    if (сразу) { screenSend(); return; }
    screenTimer = setTimeout(screenSend, SCREEN_HOLD);
  }

  ["resize", "orientationchange"].forEach(function (ev) {
    window.addEventListener(ev, function () { screenPush(false); });
  });
  // Область просмотра меняется и без изменения окна: экранная клавиатура, панели системы.
  // Есть не во всяком WebView, поэтому только там, где браузер это умеет.
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () { screenPush(false); });
  }

  function register() {
    return conn.invoke("RegisterKiosk").then(function (cmd) {
      applyCommand(cmd);
      // Sent separately, and failure is ignored: registering is what matters, the version is
      // only there so the operator can spot a tablet still running an older page.
      conn.invoke("ReportVersion", APP_VERSION).catch(function () { /* older server */ });
      // Размер экрана: тем же порядком и с теми же последствиями, что и версия страницы.
      // Заново на каждом подключении, а не один раз за жизнь страницы: служба могла
      // перезапуститься или обновиться, а кроме планшета размер его экрана не знает никто.
      // Окну, в котором планшет не узнан, рассказывать о себе нечего и некому: страницу
      // планшета открывают и в браузере оператора, и тогда за ней нет никакого железа.
      screenMine = !cmd || cmd.mode !== "notdevice";
      screenSent = null;
      screenKnown = true;
      if (screenMine) screenPush(true);
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
    conn.on("ShowDocument", function (config, sessionId) {
      // Тот же самый показ, а не новый: планшет уже показывает этот документ, и клиент в нём
      // что-то заполнил. Пересоздать его значило бы стереть заполненное и вернуть человека на
      // первую страницу. Новый показ всегда приходит с другим именем сессии, так что настоящую
      // смену документа это не пропустит.
      if (sessionId && doc.serverSession === sessionId && doc.config && doc.screens && doc.screens.length) {
        showLayer("document");
        renderScreen();
        startIdle();
        return;
      }
      applyDocument(config, sessionId);
    });
    // Планшет отозван. Показывать на нём больше нечего: стираем всё, что было на экране, и сам
    // токен, чтобы страница не пыталась переподключиться с недействующим доступом до
    // бесконечности. Дальше это обычный неактивированный планшет: оператор заводит новый код.
    conn.on("Revoked", function () {
      // Токен стирается обоими способами сразу: страница хранит его и в localStorage, и в куке
      // и восстанавливает одно из другого, поэтому чистить надо в одном месте, где это учтено.
      clearToken();
      showEnroll("Планшет отвязан от системы. Обратитесь к администратору за новым кодом активации.");
    });
    conn.on("Identify", function (p) { showIdentify(p && p.code, p && p.name); });
    conn.on("StartScan", startScan);
    // Не просто гасим камеру, а возвращаем экран: сервер обычно шлёт следом документ или рекламу,
    // но если второе сообщение не доедет (обрыв ровно между ними), планшет оставался на чёрном
    // экране «Поднесите код к камере» с мёртвым видео и без единого таймера, до переподключения.
    conn.on("StopScan", function () { leaveScan(); });
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
