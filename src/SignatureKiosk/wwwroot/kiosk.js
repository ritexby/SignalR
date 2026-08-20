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
    doc.pad = null;
    doc.submitting = false;
    doc.screens = [];
    (doc.config.pages || []).forEach(function (p, i) {
      doc.screens.push({ type: "page", pageIndex: i });
      // Honour the initial checked state of API-supplied checkboxes.
      (p.checkboxes || []).forEach(function (cb, ci) { if (cb && cb.checked) doc.checks[checkKey(i, ci)] = true; });
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
    doc.config = null; doc.screens = []; doc.index = 0; doc.checks = {};
    doc.pad = null; doc.submitting = false; doc.docPadResize = null; doc.idleMs = 0;
    el.docBody.innerHTML = ""; el.docFooter.innerHTML = "";
    el.docTitle.textContent = ""; el.docProgress.textContent = "";
  }

  function checkKey(page, idx) { return "p" + page + "_c" + idx; }

  function requiredSatisfied(pageIndex) {
    var page = doc.config.pages[pageIndex];
    if (!page || !page.checkboxes) return true;
    for (var i = 0; i < page.checkboxes.length; i++)
      if (page.checkboxes[i].required && !doc.checks[checkKey(pageIndex, i)]) return false;
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
    blocks.forEach(function (b) { appendBlock(body, b); });

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
          req.className = "req"; req.textContent = "*";
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
    body.className = "sign-screen";

    // Custom signature-page content (text / images) authored in the admin, above the pad.
    var sblocks = doc.config.signBlocks || [];
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
    doc.pad = new SignaturePad(canvas, { minWidth: 1.2, maxWidth: 3.2, penColor: "#111827" });
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
    var session = doc.session;     // this signing session; abandon the callbacks if it changed
    updateFooter();
    // One id per signing session: if the response is lost and the signer presses ПОДПИСАТЬ again,
    // the server recognises the retry and returns the record it already stored instead of writing
    // a second, data-less one.
    if (!doc.submissionId) doc.submissionId = "s" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    fetch("/api/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (getToken() || "") },
      body: JSON.stringify({ items: collectItems(), signature: doc.pad.toDataURL("image/png"), submissionId: doc.submissionId })
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
  var scan = { controls: null, active: false, doneTimer: null, capTimer: null, gen: 0 };
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
      if (ZX && ZX.DecodeHintType && ZX.BarcodeFormat) {
        hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
          ZX.BarcodeFormat.QR_CODE, ZX.BarcodeFormat.EAN_13,
          ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.CODE_128
        ]);
      }
    } catch (e) { /* fall back to all formats */ }

    var reader = new window.ZXingBrowser.BrowserMultiFormatReader(hints.size ? hints : undefined);
    // "user" is the front camera, as the tablets are wall-mounted facing the client.
    reader.decodeFromConstraints(
      { video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } },
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

  function register() {
    return conn.invoke("RegisterKiosk").then(applyCommand)
      .catch(function (e) { console.error("register failed", e); });
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
