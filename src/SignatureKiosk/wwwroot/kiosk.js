/* Kiosk player: connects to the SignalR hub, shows a slideshow, and runs the
   signing document flow on command. Loaded by freekiosk as a single URL. */
(function () {
  "use strict";

  // ---------- Device identity ----------
  var qs = new URLSearchParams(location.search);
  function deviceId() {
    var id = qs.get("device");
    if (!id) {
      id = localStorage.getItem("sk_device_id");
      if (!id) {
        id = "kiosk-" + Math.random().toString(36).slice(2, 8);
        localStorage.setItem("sk_device_id", id);
      }
    }
    return id;
  }
  var DEVICE_ID = deviceId();
  var DEVICE_NAME = qs.get("name") || "";

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
    status: document.getElementById("statusOverlay"),
    statusText: document.getElementById("statusText"),
    badge: document.getElementById("deviceBadge")
  };
  el.badge.textContent = DEVICE_NAME ? (DEVICE_NAME + " · " + DEVICE_ID) : DEVICE_ID;
  el.badge.classList.remove("hidden");

  function showStatus(t) { el.statusText.textContent = t; el.status.classList.remove("hidden"); }
  function hideStatus() { el.status.classList.add("hidden"); }

  // ==================================================================
  // Slideshow
  // ==================================================================
  var slides = { images: [], interval: 6000, index: 0, front: null, timer: null };

  function stopSlides() { if (slides.timer) { clearInterval(slides.timer); slides.timer = null; } }

  function applySlides(payload) {
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

    // Show first image immediately on slide A.
    el.slideA.src = images[0];
    el.slideA.classList.add("show");
    slides.front = "A";

    if (images.length > 1) {
      slides.timer = setInterval(nextSlide, slides.interval);
    }
  }

  function nextSlide() {
    if (slides.images.length < 2) return;
    slides.index = (slides.index + 1) % slides.images.length;
    var url = slides.images[slides.index];
    var incoming = slides.front === "A" ? el.slideB : el.slideA;
    var outgoing = slides.front === "A" ? el.slideA : el.slideB;
    incoming.src = url;
    // Let the browser paint the new src before fading.
    requestAnimationFrame(function () {
      incoming.classList.add("show");
      outgoing.classList.remove("show");
      slides.front = slides.front === "A" ? "B" : "A";
    });
  }

  // ==================================================================
  // Signing document flow
  // ==================================================================
  var doc = { config: null, screens: [], index: 0, checks: {}, pad: null, submitting: false };

  function applyDocument(config) {
    stopSlides();
    showLayer("document");
    doc.config = config || { title: "", pages: [] };
    doc.checks = {};
    doc.pad = null;
    doc.submitting = false;
    // Build the screen list: one per content page, then signature, then thank-you.
    doc.screens = [];
    (doc.config.pages || []).forEach(function (p, i) {
      doc.screens.push({ type: "page", pageIndex: i });
    });
    doc.screens.push({ type: "signature" });
    doc.screens.push({ type: "thankyou" });
    doc.index = 0;
    el.docTitle.textContent = doc.config.title || "";
    renderScreen();
  }

  function checkKey(page, idx) { return "p" + page + "_c" + idx; }

  function requiredSatisfied(pageIndex) {
    var page = doc.config.pages[pageIndex];
    if (!page || !page.checkboxes) return true;
    for (var i = 0; i < page.checkboxes.length; i++) {
      if (page.checkboxes[i].required && !doc.checks[checkKey(pageIndex, i)]) return false;
    }
    return true;
  }

  function renderScreen() {
    var screen = doc.screens[doc.index];
    var isLast = doc.index === doc.screens.length - 1;
    el.docProgress.textContent = screen.type === "thankyou"
      ? "" : "Шаг " + (doc.index + 1) + " из " + (doc.screens.length - 1);

    if (screen.type === "page") return renderPage(screen.pageIndex);
    if (screen.type === "signature") return renderSignature();
    return renderThankYou();
  }

  function renderPage(pageIndex) {
    var page = doc.config.pages[pageIndex];
    doc.docPadResize = null;
    var body = document.createElement("div");

    var h = document.createElement("h2");
    h.textContent = page.heading || "";
    body.appendChild(h);

    var text = document.createElement("div");
    text.className = "doc-text";
    text.textContent = page.body || "";
    body.appendChild(text);

    if (page.checkboxes && page.checkboxes.length) {
      var checks = document.createElement("div");
      checks.className = "checks";
      page.checkboxes.forEach(function (cb, i) {
        var key = checkKey(pageIndex, i);
        var label = document.createElement("label");
        label.className = "check" + (doc.checks[key] ? " checked" : "");
        var input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!doc.checks[key];
        input.addEventListener("change", function () {
          doc.checks[key] = input.checked;
          label.classList.toggle("checked", input.checked);
          updateFooter();
        });
        var span = document.createElement("span");
        span.className = "label";
        span.textContent = cb.label || "";
        if (cb.required) {
          var req = document.createElement("span");
          req.className = "req";
          req.textContent = "*";
          span.appendChild(req);
        }
        label.appendChild(input);
        label.appendChild(span);
        checks.appendChild(label);
      });
      body.appendChild(checks);
    }

    el.docBody.innerHTML = "";
    el.docBody.appendChild(body);
    renderFooter({ back: doc.index > 0, next: true, nextLabel: "Далее" });
  }

  function renderSignature() {
    doc.docPadResize = null;
    var body = document.createElement("div");

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

    el.docBody.innerHTML = "";
    el.docBody.appendChild(body);

    // Size the canvas to its container (accounting for pixel ratio) and init pad.
    function sizeCanvas() {
      var ratio = Math.max(window.devicePixelRatio || 1, 1);
      var rect = wrap.getBoundingClientRect();
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      var ctx = canvas.getContext("2d");
      ctx.scale(ratio, ratio);
      if (doc.pad) doc.pad.clear();
    }
    doc.pad = new SignaturePad(canvas, { minWidth: 1.2, maxWidth: 3.2, penColor: "#111827" });
    doc.pad.addEventListener("beginStroke", function () { hint.style.display = "none"; });
    doc.pad.addEventListener("endStroke", updateFooter);
    sizeCanvas();
    doc.docPadResize = sizeCanvas;

    renderFooter({
      back: true, clear: true, sign: true
    });
  }

  function renderThankYou() {
    doc.docPadResize = null;
    el.docProgress.textContent = "";
    var body = document.createElement("div");
    body.className = "thankyou";
    var mark = document.createElement("div"); mark.className = "mark"; mark.textContent = "✓"; body.appendChild(mark);
    var h = document.createElement("h2"); h.textContent = doc.config.thankYouText || "Спасибо!"; body.appendChild(h);
    el.docBody.innerHTML = "";
    el.docBody.appendChild(body);
    el.docFooter.innerHTML = "";
    // Return to slideshow shortly; the server will push the current slides.
    setTimeout(function () { conn.invoke("FinishDocument").catch(function () {}); }, 6000);
  }

  // Footer rendering for page / signature screens.
  function renderFooter(opts) {
    el.docFooter.innerHTML = "";

    var back = document.createElement("button");
    back.className = "btn btn-ghost";
    back.textContent = "Назад";
    back.disabled = !opts.back;
    back.addEventListener("click", function () { if (doc.index > 0) { doc.index--; renderScreen(); } });
    el.docFooter.appendChild(back);

    var note = document.createElement("div");
    note.className = "footer-note";
    note.id = "footerNote";
    el.docFooter.appendChild(note);

    if (opts.clear) {
      var clear = document.createElement("button");
      clear.className = "btn btn-ghost";
      clear.textContent = "Очистить";
      clear.addEventListener("click", function () { if (doc.pad) { doc.pad.clear(); updateFooter(); } });
      el.docFooter.appendChild(clear);
    }

    if (opts.next) {
      var next = document.createElement("button");
      next.className = "btn btn-primary";
      next.id = "btnNext";
      next.textContent = opts.nextLabel || "Далее";
      next.addEventListener("click", function () {
        var screen = doc.screens[doc.index];
        if (screen.type === "page" && !requiredSatisfied(screen.pageIndex)) return;
        doc.index++; renderScreen();
      });
      el.docFooter.appendChild(next);
    }

    if (opts.sign) {
      var sign = document.createElement("button");
      sign.className = "btn btn-sign";
      sign.id = "btnSign";
      sign.textContent = "ПОДПИСАТЬ";
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

  function collectItems() {
    var items = [];
    (doc.config.pages || []).forEach(function (page, pi) {
      (page.checkboxes || []).forEach(function (cb, ci) {
        items.push({ label: cb.label, checked: !!doc.checks[checkKey(pi, ci)] });
      });
    });
    return items;
  }

  function submitSignature() {
    if (doc.submitting || !doc.pad || doc.pad.isEmpty()) return;
    doc.submitting = true;
    updateFooter();
    var payload = {
      deviceId: DEVICE_ID,
      items: collectItems(),
      signature: doc.pad.toDataURL("image/png")
    };
    fetch("/api/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) throw new Error("bad status " + r.status);
      // Move to the thank-you screen (last screen).
      doc.index = doc.screens.length - 1;
      renderScreen();
    }).catch(function () {
      doc.submitting = false;
      var note = document.getElementById("footerNote");
      if (note) note.textContent = "Ошибка отправки. Попробуйте ещё раз.";
      updateFooter();
    });
  }

  window.addEventListener("resize", function () { if (doc.docPadResize) doc.docPadResize(); });

  // ==================================================================
  // Layers
  // ==================================================================
  function showLayer(which) {
    if (which === "slides") {
      el.document.classList.add("hidden");
      el.slideshow.classList.remove("hidden");
    } else {
      el.slideshow.classList.add("hidden");
      el.document.classList.remove("hidden");
    }
  }

  function applyCommand(cmd) {
    if (!cmd) return;
    if (cmd.mode === "document") applyDocument(cmd.document);
    else applySlides(cmd.slides);
  }

  // ==================================================================
  // SignalR connection
  // ==================================================================
  var conn = new signalR.HubConnectionBuilder()
    .withUrl("/hub/kiosk")
    .withAutomaticReconnect([0, 2000, 5000, 10000, 15000, 30000])
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  conn.on("ShowSlides", applySlides);
  conn.on("ShowDocument", applyDocument);

  function register() {
    return conn.invoke("RegisterKiosk", DEVICE_ID, DEVICE_NAME)
      .then(applyCommand)
      .catch(function (e) { console.error("register failed", e); });
  }

  conn.onreconnecting(function () { showStatus("Соединение потеряно. Переподключение…"); });
  conn.onreconnected(function () { hideStatus(); register(); });
  conn.onclose(function () { showStatus("Нет связи с сервером. Переподключение…"); setTimeout(start, 4000); });

  function start() {
    showStatus("Подключение к серверу…");
    conn.start()
      .then(function () { hideStatus(); return register(); })
      .catch(function () { showStatus("Нет связи с сервером. Повтор через 4 с…"); setTimeout(start, 4000); });
  }

  start();
})();
