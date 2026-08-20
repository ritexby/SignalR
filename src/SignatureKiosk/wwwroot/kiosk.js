/* Kiosk player: authenticates with a device token, shows a slideshow, runs the
   signing document flow, and can be "identified" on demand. Loaded by freekiosk. */
(function () {
  "use strict";

  var TOKEN_KEY = "sk_device_token";
  var qs = new URLSearchParams(location.search);

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

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
    scanCode: document.getElementById("scanCode"),
    scanFlip: document.getElementById("scanFlip")
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
    doc.pad = null; doc.submitting = false; doc.docPadResize = null; doc.idleMs = 0;
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

  function condHolds(cond) {
    if (!cond || !cond.field) return true;
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

  function dependsOn(key) {
    var uses = false;
    function check(c) { if (c && c.field === key) uses = true; }
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
    return true;
  }

  function renderScreen() {
    var screen = doc.screens[doc.index];
    if (!screen) return;              // the document was cleared while a callback was in flight
    el.docProgress.textContent = screen.type === "thankyou"
      ? "" : "Шаг " + (doc.index + 1) + " из " + (doc.screens.length - 1);
    if (screen.type === "page") return renderPage(screen.pageIndex);
    if (screen.type === "signature") return renderSignature();
    return renderThankYou();
  }

  // Append styled runs to a node using textContent only (never innerHTML), so signer data and
  // template text can never inject markup. \n inside a run becomes a line break.
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
      var im = document.createElement("img"); im.src = b.imageUrl;
      var w = Math.min(Math.max(parseInt(b.imageWidth, 10) || 100, 10), 100);
      im.style.width = w + "%";
      fig.appendChild(im); parent.appendChild(fig);
    } else {
      var text = document.createElement("div"); text.className = "doc-text";
      appendRuns(text, (b && b.runs) || []); parent.appendChild(text);
    }
  }

  function renderPage(pageIndex) {
    var page = doc.config.pages[pageIndex];
    doc.docPadResize = null;
    var body = document.createElement("div");

    var hruns = (page.headingRuns && page.headingRuns.length) ? page.headingRuns
      : (page.heading ? [{ text: page.heading }] : []);
    if (hruns.length) {
      var h = document.createElement("h2");
      appendRuns(h, hruns);
      body.appendChild(h);
    }

    var blocks = (page.blocks && page.blocks.length) ? page.blocks
      : (page.body ? [{ runs: [{ text: page.body }] }] : []);
    visible(blocks).forEach(function (b) { appendBlock(body, b); });

    // Нажатие меняет то, что показано: блок или пункт может появиться или исчезнуть, поэтому
    // страница перерисовывается целиком, а не правится по месту.
    function rerender() { renderPage(pageIndex); }

    if (page.checkboxes && page.checkboxes.length) {
      var checks = document.createElement("div");
      checks.className = "checks";
      page.checkboxes.forEach(function (cb, i) {
        if (!condHolds(cb.visibleWhen)) return;
        var key = checkKey(pageIndex, i);
        var label = document.createElement("label");
        label.className = "check" + (doc.checks[key] ? " checked" : "");
        var input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!doc.checks[key];
        input.addEventListener("change", function () {
          doc.checks[key] = input.checked;
          label.classList.toggle("checked", input.checked);
          // Перерисовываем, только если от этого пункта что-то зависит: иначе страница
          // дёргалась бы под пальцем на каждой галочке без всякой причины.
          if (cb.key && dependsOn(cb.key)) rerender(); else updateFooter();
        });
        var span = document.createElement("span");
        span.className = "label";
        span.textContent = cb.label || "";
        if (cb.required) {
          var req = document.createElement("span");
          req.className = "req"; req.textContent = "*";
          span.appendChild(req);
        }
        label.appendChild(input);
        label.appendChild(span);
        checks.appendChild(label);
      });
      if (checks.childNodes.length) body.appendChild(checks);
    }

    // Группы: выбрать можно один вариант, и «ни одного» это тоже состояние. Поэтому это
    // чекбоксы, а не радиокнопки: нажатие по уже выбранному снимает выбор.
    visible(page.groups).forEach(function (g) {
      var box = document.createElement("div");
      box.className = "group";
      if (g.title) {
        var t = document.createElement("div");
        t.className = "group-title";
        t.textContent = g.title;
        if (g.required) {
          var req = document.createElement("span");
          req.className = "req"; req.textContent = "*";
          t.appendChild(req);
        }
        box.appendChild(t);
      }
      var opts = document.createElement("div");
      opts.className = "checks";
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
        span.textContent = o.label || o.key || "";
        label.appendChild(input);
        label.appendChild(span);
        opts.appendChild(label);
      });
      box.appendChild(opts);
      body.appendChild(box);
    });

    el.docBody.innerHTML = "";
    el.docBody.appendChild(body);
    renderFooter({ back: doc.index > 0, next: true, nextLabel: "Далее" });
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

    // Между двумя кадрами планшет успевает снять несколько точек пера, и браузер отдаёт их не
    // отдельными событиями, а внутри getCoalescedEvents последнего. Без них быстрый росчерк
    // рисуется парой прямых срезов вместо кривой. Слушатель висит на самом холсте, а библиотека
    // слушает window, поэтому промежуточные точки успевают дойти до неё раньше основного события
    // и порядок не нарушается.
    var MAX_COALESCED = 32;   // защита от патологического всплеска событий
    var replaying = false;    // точки, разосланные здесь же, повторно разбирать не нужно
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
    // Настройки пера доступны наружу, чтобы их можно было проверить тестом, а не на глаз.
    window.__padForTest = doc.pad;
    doc.pad.addEventListener("beginStroke", function () { hint.style.display = "none"; });
    doc.pad.addEventListener("endStroke", updateFooter);
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
    // PRIVACY: the title may contain the signer's data (for example "Согласие {{ФИО}}"), so it is
    // wiped as soon as signing is done, together with the resolved document held in memory. Only
    // the thank-you text survives on screen.
    el.docTitle.textContent = "";
    doc.config = { thankYouText: thanks, pages: [] };
    doc.checks = {};
    var body = document.createElement("div");
    body.className = "thankyou";
    var mark = document.createElement("div"); mark.className = "mark"; body.appendChild(mark);
    var h = document.createElement("h2"); h.textContent = thanks; body.appendChild(h);
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
    }, 6000);
  }

  function renderFooter(opts) {
    el.docFooter.innerHTML = "";

    var back = document.createElement("button");
    back.className = "btn btn-ghost"; back.textContent = "Назад"; back.disabled = !opts.back;
    back.addEventListener("click", function () { if (doc.index > 0) { doc.index--; renderScreen(); } });
    el.docFooter.appendChild(back);

    var note = document.createElement("div");
    note.className = "footer-note"; note.id = "footerNote";
    el.docFooter.appendChild(note);

    if (opts.clear) {
      var clear = document.createElement("button");
      clear.className = "btn btn-ghost"; clear.textContent = "Очистить";
      clear.addEventListener("click", function () { if (doc.pad) { doc.pad.clear(); updateFooter(); } });
      el.docFooter.appendChild(clear);
    }
    if (opts.next) {
      var next = document.createElement("button");
      next.className = "btn btn-primary"; next.id = "btnNext"; next.textContent = opts.nextLabel || "Далее";
      next.addEventListener("click", function () {
        var screen = doc.screens[doc.index];
        if (screen.type === "page" && !requiredSatisfied(screen.pageIndex)) return;
        doc.index++; renderScreen();
      });
      el.docFooter.appendChild(next);
    }
    if (opts.sign) {
      var sign = document.createElement("button");
      sign.className = "btn btn-sign"; sign.id = "btnSign"; sign.textContent = "ПОДПИСАТЬ";
      sign.addEventListener("click", submitSignature);
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
      var ok = requiredSatisfied(screen.pageIndex);
      next.disabled = !ok;
      if (note) note.textContent = ok ? "" : "Отметьте обязательные пункты (*) для продолжения";
    }
    if (screen.type === "signature" && sign) {
      var empty = !doc.pad || doc.pad.isEmpty();
      sign.disabled = empty || doc.submitting;
      if (note) note.textContent = empty ? "Поставьте подпись в поле выше" : "";
    }
  }

  // В запись уходит только то, что клиент действительно видел: скрытый условием пункт нельзя
  // считать ни отмеченным, ни сознательно пропущенным.
  function collectItems() {
    var items = [];
    (doc.config.pages || []).forEach(function (page, pi) {
      if (!condHolds(page.visibleWhen)) return;
      (page.checkboxes || []).forEach(function (cb, ci) {
        if (!condHolds(cb.visibleWhen)) return;
        items.push({ key: cb.key || "", label: cb.label, checked: !!doc.checks[checkKey(pi, ci)] });
      });
    });
    return items;
  }

  function collectGroups() {
    var groups = [];
    (doc.config.pages || []).forEach(function (page) {
      if (!condHolds(page.visibleWhen)) return;
      visible(page.groups).forEach(function (g) {
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
        signature: doc.pad.toDataURL("image/png"), submissionId: doc.submissionId })
    }).then(function (r) {
      if (doc.session !== session) return;          // document was replaced/cleared while sending
      if (!r.ok) throw new Error("bad status " + r.status);
      doc.index = doc.screens.length - 1;
      renderScreen();
    }).catch(function (err) {
      // A failed signature is the worst failure for the client, so it is always reported.
      reportError("Не удалось отправить подпись", err && (err.stack || err.message || String(err)));
      if (doc.session !== session) return;
      doc.submitting = false;
      updateFooter();                               // re-enable the button first...
      var note = document.getElementById("footerNote");
      if (note) note.textContent = "Ошибка отправки. Попробуйте ещё раз."; // ...then show the error so it is not wiped
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
  // "user" is the front camera. Remembered per tablet, because which camera actually reads a
  // barcode depends on the hardware and on how the tablet is mounted.
  var scan = {
    controls: null, active: false, doneTimer: null, capTimer: null, gen: 0,
    facing: localStorage.getItem("sk_scan_facing") === "environment" ? "environment" : "user"
  };

  // Switching cameras restarts the reader: the constraint is fixed when the stream opens.
  if (el.scanFlip) el.scanFlip.addEventListener("click", function () {
    scan.facing = scan.facing === "user" ? "environment" : "user";
    try { localStorage.setItem("sk_scan_facing", scan.facing); } catch (e) { /* private mode */ }
    var wasActive = scan.active;
    stopScan();
    if (wasActive) startScan();
  });
  var SCAN_MAX_MS = 90000;   // hard local cap: never film longer than this without a result

  function clearScanResult() {
    el.scanCode.textContent = "";
    el.scanResult.classList.add("hidden");
  }

  function stopScan() {
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

  function startScan() {
    if (scan.active) return;
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
        hints.set(HINT_POSSIBLE_FORMATS, [
          ZX.BarcodeFormat.QR_CODE, ZX.BarcodeFormat.EAN_13,
          ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.CODE_128
        ]);
      }
      // Spend more effort per frame. A tablet camera gives a soft, low contrast image, and
      // without this a printed EAN-13 often never resolves at all.
      hints.set(HINT_TRY_HARDER, true);
    } catch (e) { /* fall back to all formats */ }

    var reader = new window.ZXingBrowser.BrowserMultiFormatReader(hints.size ? hints : undefined);
    // Wall-mounted tablets face the client, so the front camera is the default. It is also the
    // weaker one on most tablets, so the client can switch to the rear camera on the spot and the
    // choice is remembered.
    el.scanFlip.classList.remove("hidden");
    el.scanFlip.textContent = scan.facing === "user" ? "Камера сзади" : "Камера спереди";
    // Mirror the front camera only: the rear one already faces the same way as the client's hand.
    el.scanVideo.classList.toggle("mirrored", scan.facing === "user");
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
    stopScan();
    el.scanMsg.textContent = "";
    el.scanCode.textContent = code;
    el.scanResult.classList.remove("hidden");

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
  var APP_VERSION = "4.8";

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

  function connect() {
    var token = getToken();
    if (!token) { showEnroll(""); return; }

    conn = new signalR.HubConnectionBuilder()
      .withUrl("/hub/kiosk", { accessTokenFactory: function () { return getToken() || ""; } })
      .withAutomaticReconnect([0, 2000, 5000, 10000, 15000, 30000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    conn.on("ShowSlides", applySlides);
    conn.on("ShowDocument", applyDocument);
    conn.on("Identify", function (p) { showIdentify(p && p.code, p && p.name); });
    conn.on("StartScan", startScan);
    conn.on("StopScan", stopScan);

    conn.onreconnecting(function () { showStatus("Соединение потеряно. Переподключение…"); });
    conn.onreconnected(function () { hideStatus(); register(); });
    conn.onclose(function () {
      if (getToken()) { showStatus("Нет связи с сервером. Переподключение…"); setTimeout(connect, 4000); }
      else showEnroll("");
    });

    showStatus("Подключение к серверу…");
    conn.start()
      .then(function () { hideStatus(); return register(); })
      .catch(function (e) {
        conn = null;
        if (isAuthError(e)) { clearToken(); showEnroll("Планшет не авторизован. Введите новый код активации."); }
        else { showStatus("Нет связи с сервером. Повтор через 4 с…"); setTimeout(connect, 4000); }
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
