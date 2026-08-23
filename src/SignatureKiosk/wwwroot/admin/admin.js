/* Admin panel: slides, signing document, signatures, and fleet management -
   devices (enrollment codes, revoke, identify), groups, workstations, API keys. */
(function () {
  "use strict";

  // Kept in step with the version badge and with APP_VERSION in kiosk.js. A tablet reports the
  // build of the page it is running, so a WebView still on an older page can be spotted rather
  // than silently ignoring anything added since.
  var APP_VERSION = "7.0";

  var state = {
    slidesTarget: "all",   // кому идёт реклама: all / group:{id} / device:{id} / devices
    slidesDeviceIds: [],   // отмеченные планшеты, когда выбран произвольный набор
    docTarget: "",         // recipient for the document: exactly ONE device, or "" if none yet
    scanTarget: "",        // tablet used for barcode / QR scanning
    images: [], playlist: [], interval: 6,
    doc: null,
    devices: [], groups: [], workstations: [], apikeys: [], scans: [], logs: [], alerts: []
  };

  // Client-side filter for the devices list.
  var devFilter = { q: "", status: "", groupId: "", wsId: "" };

  var $ = function (id) { return document.getElementById(id); };
  /// Иконка из вшитого набора Lucide. Цвет и размер задаются в CSS через currentColor,
  /// поэтому одна и та же иконка одинаково смотрится в кнопке, в заголовке и в списке.
  function icon(name, cls) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "ic" + (cls ? " " + cls : ""));
    svg.innerHTML = (window.SK_ICONS && window.SK_ICONS[name]) || "";
    return svg;
  }

  /// Кнопка с иконкой и подписью: везде одинаковый порядок и отступ.
  function iconBtn(name, label, cls) {
    var b = el("button", "btn " + (cls || "btn-ghost"));
    b.appendChild(icon(name));
    if (label) b.appendChild(el("span", null, label));
    return b;
  }

  /// Подпись раздела внутри страницы, с иконкой.
  function sectionLabel(name, text) {
    var d = el("div", "section-label");
    d.appendChild(icon(name));
    d.appendChild(el("span", null, text));
    return d;
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // ---------------- API ----------------
  function api(path, opts) {
    opts = opts || {}; opts.credentials = "same-origin";
    return fetch("/api/admin" + path, opts).then(function (r) {
      if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
      // A failed call must never look like success: surface the server's message and reject, so
      // callers cannot report "Сохранено" for a save the server refused.
      if (!r.ok) {
        return r.text().then(function (t) {
          var msg = "";
          try { msg = (JSON.parse(t) || {}).error || ""; } catch (e) { msg = ""; }
          toast(msg || ("Ошибка сервера (" + r.status + ")"));
          var err = new Error(msg || ("HTTP " + r.status));
          err.status = r.status;
          err.reported = true;      // already shown to the operator (see the handler below)
          throw err;
        });
      }
      return r;
    });
  }
  function apiJson(path, opts) { return api(path, opts).then(function (r) { return r.json(); }); }
  function apiSend(path, method, body) {
    return api(path, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  // A failed request has already been shown to the operator by api(); swallow the rejection so an
  // admin panel that stays open all day does not fill the console with "Uncaught (in promise)".
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    if (r && (r.reported || r.message === "unauthorized")) e.preventDefault();
  });

  // ---------------- Auth ----------------
  function showLogin() {
    stopLogPolling();   // a logged-out page must not keep polling (401 loop every 10 s)
    stopHub();          // ...nor keep a live hub: scanned codes were toasted over the login box
    $("login").classList.remove("hidden");
    $("app").classList.add("hidden");
  }
  function showApp() { $("login").classList.add("hidden"); $("app").classList.remove("hidden"); }

  function checkAuth() {
    fetch("/api/admin/me", { credentials: "same-origin" }).then(function (r) { return r.json(); })
      .then(function (j) { if (j.authenticated) { showApp(); init(); } else showLogin(); })
      .catch(showLogin);
  }
  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault(); $("loginError").textContent = "";
    fetch("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ password: $("password").value })
    }).then(function (r) {
      if (r.ok) { $("password").value = ""; showApp(); init(); }
      else $("loginError").textContent = "Неверный пароль";
    }).catch(function () { $("loginError").textContent = "Ошибка соединения"; });
  });
  // .finally would re-throw a rejected logout (a already-expired session returns 401), so catch first.
  $("logout").addEventListener("click", function () {
    api("/logout", { method: "POST" }).catch(function () {}).then(showLogin);
  });

  // ---------------- Tabs ----------------
  // Открытая вкладка запоминается в адресе. Иначе обновление страницы во время работы над
  // документом выбрасывало обратно на «Слайды», а вернуться приходилось руками. Заодно на
  // конкретную вкладку теперь можно дать ссылку, и работает кнопка «назад» в браузере.
  function openTab(name, remember) {
    var tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (!tab) return false;
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
    tab.classList.add("active");
    document.querySelectorAll(".panel").forEach(function (p) { p.classList.toggle("hidden", p.getAttribute("data-panel") !== name); });
    if (remember !== false && location.hash !== "#" + name) {
      // replaceState, а не запись в hash: иначе каждое переключение вкладки копилось бы в
      // истории браузера и «назад» пришлось бы жать десять раз.
      try { history.replaceState(null, "", "#" + name); } catch (e) { location.hash = name; }
    }
    loadTab(name);
    return true;
  }

  function loadTab(name) {
    // Библиотека нужна вкладке документа: без неё переключатель пуст, а сохранять некуда.
    if (name === "document" && !docList.length) loadLibrary().catch(function () { /* уже показано */ });
    if (name === "signatures") loadSignatures();
    if (name === "document") maybeOfferDraft();
    var content = document.querySelector(".content");
    if (content) content.classList.toggle("content-wide", name === "document");
    if (name === "devices") { loadDevices(); loadKioskControl(); loadSchedule(); }
    if (name === "groups") loadGroups();
    if (name === "workstations") loadWorkstations();
    if (name === "apikeys") loadKeys();
    if (name === "apidocs") renderApiDocs();
    if (name === "scan") loadScans();
    if (name === "logs") loadLogs();
    if (name === "alerts") { loadAlerts().then(renderAlerts); loadAlertSettings(); }
    // The log tab polls while it is open; stop polling when the operator leaves it.
    if (name !== "logs") stopLogPolling();
  }

  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () { openTab(tab.getAttribute("data-tab"), true); });
  });
  window.addEventListener("hashchange", restoreTab);

  // Вкладка из адреса открывается после входа: до него панели скрыты целиком. Имя из адреса
  // приходит закодированным, если в нём есть кириллица, поэтому его надо раскодировать.
  // Незнакомое имя не оставляем в адресе: иначе адрес говорит одно, а на экране другое.
  function restoreTab() {
    var raw = (location.hash || "").replace(/^#/, "");
    var name = "";
    try { name = decodeURIComponent(raw); } catch (e) { name = raw; }
    // Ссылка вида #watch=WS-204 открывает окно наблюдения за нужным планшетом. Это окно целиком
    // занято экраном планшета: оператор нажал «смотреть экран планшета» и в новом окне ждёт
    // экран планшета, а не админку со списком.
    var m = /^watch=(.+)$/.exec(name);
    if (m) { watchSoloStart(m[1]); return; }
    if (name && openTab(name, false)) return;
    openTab("slides", true);
  }

  // ---------------- Modal ----------------
  // A modal may hold images built from blobs (a tablet screenshot). Dropping the markup does not
  // free the blob, so release every URL we handed out before the content goes away.
  function releaseModalUrls() {
    $("modalContent").querySelectorAll("img[data-url]").forEach(function (img) {
      URL.revokeObjectURL(img.dataset.url);
      delete img.dataset.url;
    });
  }
  // wide: окно во всю ширину экрана. Нужно там, где показывается лист документа: в обычной
  // колонке на 680 пикселей лист A4 читался бы только под лупой.
  function openModal(node, wide) {
    var c = $("modalContent"); releaseModalUrls(); c.innerHTML = ""; c.appendChild(node);
    document.querySelector("#modal .modal-box").classList.toggle("wide", !!wide);
    $("modal").classList.remove("hidden");
  }
  function closeModal() {
    // Окно наблюдения закрыли: планшет должен перестать рассказывать о себе, иначе он говорил
    // бы в пустоту и тратил батарею.
    if (watch && watch.deviceId) watchStop();
    releaseModalUrls(); $("modalContent").innerHTML = "";
    document.querySelector("#modal .modal-box").classList.remove("wide");
    $("modal").classList.add("hidden");
  }
  $("modalClose").addEventListener("click", closeModal);
  $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) closeModal(); });

  // ---------------- Target selectors (independent: slides vs document) ----------------
  var slidesPicker = null;
  function ensureSlidesPicker() {
    var host = $("slidesDevices");
    if (!host) return null;
    if (!slidesPicker) {
      slidesPicker = devicePicker(state.slidesDeviceIds || []);
      host.appendChild(slidesPicker);
    }
    host.classList.toggle("hidden", state.slidesTarget !== "devices");
    return slidesPicker;
  }
  $("slidesTarget").addEventListener("change", function () {
    state.slidesTarget = this.value;
    ensureSlidesPicker();
    loadPlaylist();
  });
  $("docTarget").addEventListener("change", function () { state.docTarget = this.value; });

  function targetExists(t) {
    return t === "all" || t === "devices"
      || state.groups.some(function (g) { return "group:" + g.id === t; })
      || state.devices.some(function (d) { return "device:" + d.id === t; });
  }

  function fillTargetSelect(sel, current) {
    sel.innerHTML = "";
    sel.appendChild(new Option("Все планшеты", "all"));
    if (state.groups.length) {
      var og = document.createElement("optgroup"); og.label = "Группы";
      state.groups.forEach(function (g) { og.appendChild(new Option(g.name, "group:" + g.id)); });
      sel.appendChild(og);
    }
    if (state.devices.length) {
      var od = document.createElement("optgroup"); od.label = "Планшеты";
      state.devices.forEach(function (d) { od.appendChild(new Option(d.name + (d.online ? "" : " (офлайн)"), "device:" + d.id)); });
      sel.appendChild(od);
    }
    // Произвольный набор: последним пунктом, после всех, групп и отдельных планшетов.
    sel.appendChild(new Option("Выбранные планшеты…", "devices"));
    sel.value = current === "devices" || targetExists(current) ? current : "all";
    return sel.value;
  }

  // The document is ALWAYS shown on exactly one tablet, so its selector lists devices only.
  function fillDeviceSelect(sel, current) {
    sel.innerHTML = "";
    if (!state.devices.length) { sel.appendChild(new Option("Нет планшетов", "")); sel.value = ""; return ""; }
    state.devices.forEach(function (d) { sel.appendChild(new Option(d.name + (d.online ? "" : " (офлайн)"), "device:" + d.id)); });
    var exists = state.devices.some(function (d) { return "device:" + d.id === current; });
    sel.value = exists ? current : ("device:" + state.devices[0].id);
    return sel.value;
  }

  function renderTargetOptions() {
    state.slidesTarget = fillTargetSelect($("slidesTarget"), state.slidesTarget);
    // Список планшетов мог измениться: перерисовываем отметки, сохраняя выбранное.
    if (slidesPicker) { state.slidesDeviceIds = slidesPicker.ids(); slidesPicker.refresh(); }
    ensureSlidesPicker();
    state.docTarget = fillDeviceSelect($("docTarget"), state.docTarget);
    // Keep the scan target fresh too: it used to be refilled only when the scan tab was loaded, so
    // a deleted tablet stayed selectable and "start scanning" silently did nothing.
    if ($("scanTarget")) state.scanTarget = fillDeviceSelect($("scanTarget"), state.scanTarget);
    syncTabletActions();
  }

  // Действие, для которого нужен планшет, а планшетов нет вообще. Раньше кнопка оставалась
  // рабочей и на нажатие отвечала «Выберите планшет», хотя выбирать было не из чего. Теперь
  // она выключена и прямо говорит, что делать: завести планшет на вкладке «Планшеты».
  function syncTabletActions() {
    var none = !state.devices.length;
    var why = "Сначала добавьте планшет на вкладке «Планшеты»: там создаётся код активации.";
    ["showDocument", "showSlides", "startScan", "stopScan"].forEach(function (id) {
      var b = $(id); if (!b) return;
      b.disabled = none;
      if (none) b.title = why; else b.removeAttribute("title");
    });
    // Рекламу можно настроить и без планшетов: она сохранится и достанется тем, кто появится
    // позже. Кнопку поэтому не выключаем, но говорим заранее, что показывать её пока некому.
    var save = $("saveSlides");
    if (save) {
      if (none) save.title = "Планшетов пока нет. Настройка сохранится и покажется на планшетах, когда они появятся.";
      else save.removeAttribute("title");
    }
    ["docNoDevices", "scanNoDevices"].forEach(function (id) {
      var note = $(id); if (note) note.classList.toggle("hidden", !none);
    });
  }

  // ---------------- Images / slides ----------------
  function loadImages() { return apiJson("/images").then(function (imgs) { state.images = imgs; }); }
  function loadPlaylist() {
    var q = "/playlist?target=" + encodeURIComponent(state.slidesTarget);
    if (state.slidesTarget === "devices" && slidesPicker) q += "&ids=" + encodeURIComponent(slidesPicker.ids().join(","));
    return apiJson(q).then(function (p) {
      state.playlist = p.imageIds || []; state.interval = p.intervalSec || 6;
      $("intervalInput").value = state.interval; renderImages();
    });
  }
  function renderImages() {
    var grid = $("imageGrid"); grid.innerHTML = "";
    if (!state.images.length) { grid.innerHTML = '<div class="empty-note">Пока нет картинок. Нажмите «Загрузить картинки».</div>'; return; }
    state.images.forEach(function (img) {
      var pos = state.playlist.indexOf(img.id);
      var card = el("div", "card" + (pos >= 0 ? " selected" : ""));
      var order = el("div", "order", pos >= 0 ? (pos + 1) : ""); card.appendChild(order);
      var del = el("button", "del", "×"); del.title = "Удалить";
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!confirm("Удалить эту картинку?")) return;
        api("/images/" + img.id, { method: "DELETE" }).then(function () {
          var i = state.playlist.indexOf(img.id); if (i >= 0) state.playlist.splice(i, 1);
          return loadImages();
        }).then(renderImages);
      });
      card.appendChild(del);
      var im = el("img"); im.src = img.url; im.alt = img.originalName || ""; card.appendChild(im);
      card.appendChild(el("div", "name", img.originalName || img.id));

      // Срок показа: с какого и по какой день картинка участвует в рекламе. Пустая дата
      // означает «без ограничения» с этой стороны. Считает сроки сервер, поэтому и отметка
      // «сегодня не показывается» приходит от него, а не вычисляется здесь по своим часам.
      var сроки = el("div", "img-dates");
      сроки.addEventListener("click", function (e) { e.stopPropagation(); });
      var сНадпись = el("label", "img-date", "с");
      var сПоле = el("input"); сПоле.type = "date"; сПоле.value = img.showFrom || "";
      сПоле.title = "С какого дня показывать, включительно. Пусто - с самого начала";
      сНадпись.appendChild(сПоле);
      var поНадпись = el("label", "img-date", "по");
      var поПоле = el("input"); поПоле.type = "date"; поПоле.value = img.showTo || "";
      поПоле.title = "По какой день показывать, включительно. Пусто - без конца";
      поНадпись.appendChild(поПоле);
      сроки.appendChild(сНадпись); сроки.appendChild(поНадпись);
      var метка = el("span", "img-date-state", "");
      сроки.appendChild(метка);
      function метку() {
        var задано = (сПоле.value || "") || (поПоле.value || "");
        if (!задано) { метка.textContent = "показывается всегда"; метка.className = "img-date-state"; return; }
        метка.textContent = img.showsToday === false ? "сегодня не показывается" : "показывается сегодня";
        метка.className = "img-date-state " + (img.showsToday === false ? "off" : "on");
      }
      метку();
      function сохранить() {
        apiSend("/images/" + img.id + "/dates", "PUT", { showFrom: сПоле.value || "", showTo: поПоле.value || "" })
          .then(function (r) { return r.json(); })
          .then(function () { return loadImages(); })
          .then(function () { renderImages(); toast("Сроки показа сохранены"); })
          .catch(function () { /* сообщение уже показано */ });
      }
      сПоле.addEventListener("change", сохранить);
      поПоле.addEventListener("change", сохранить);
      card.appendChild(сроки);

      card.addEventListener("click", function () {
        var i = state.playlist.indexOf(img.id);
        if (i >= 0) state.playlist.splice(i, 1); else state.playlist.push(img.id);
        renderImages();
      });
      if (img.showsToday === false) card.classList.add("img-hidden-today");
      grid.appendChild(card);
    });
  }
  $("imageUpload").addEventListener("change", function () {
    var input = $("imageUpload"); if (!input.files.length) return;
    var fd = new FormData();
    Array.prototype.forEach.call(input.files, function (f) { fd.append("files", f); });
    // Reset the file input on BOTH paths: after a failed upload the input still held the same
    // files, so re-picking them fired no change event and the button looked dead.
    apiJson("/images", { method: "POST", body: fd }).then(function (r) {
      return loadImages().then(renderImages).then(function () {
        // Что-то могло не загрузиться: не картинка или слишком большой файл. Молчать об этом
        // нельзя, иначе оператор не поймёт, почему в списке не все.
        var взято = (r && r.added ? r.added.length : 0);
        var пропущено = (r && r.skipped) || [];
        if (пропущено.length) {
          toast("Загружено: " + взято + ". Не загружено: " + пропущено.join("; "), true);
        } else {
          toast(взято === 1 ? "Картинка загружена" : ("Загружено картинок: " + взято));
        }
      });
    }).catch(function () { /* сообщение уже показано */ })
      .then(function () { input.value = ""; });
  });
  $("saveSlides").addEventListener("click", function () {
    var interval = parseInt($("intervalInput").value, 10) || 6;
    var ids = state.slidesTarget === "devices" && slidesPicker ? slidesPicker.ids() : null;
    if (state.slidesTarget === "devices" && (!ids || !ids.length)) { toast("Отметьте хотя бы один планшет."); return; }
    // Пустой список это чёрный экран у клиента. Задать его случайно легко: достаточно снять
    // отметки со всех картинок, поэтому спрашиваем ещё раз.
    if (!state.playlist.length &&
        !confirm("Ни одна картинка не выбрана.\n\nПланшеты останутся с пустым экраном. Продолжить?")) return;
    // Все выбранные картинки вне срока показа: на экране будет то же пустое место.
    var живых = state.playlist.filter(function (id) {
      var img = (state.images || []).filter(function (x) { return x.id === id; })[0];
      return !img || img.showsToday !== false;
    });
    if (state.playlist.length && !живых.length &&
        !confirm("Все выбранные картинки вне срока показа.\n\nСегодня планшеты покажут пустой экран. Продолжить?")) return;
    apiSend("/playlist", "PUT", { target: state.slidesTarget, imageIds: state.playlist, intervalSec: interval, deviceIds: ids })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        // Сохранить настройку и показать её на экране это разные события. Раньше сообщение было
        // одинаковым и когда реклама поехала на десять планшетов, и когда ни один не включён.
        var дошло = j && j.shown != null ? j.shown : null;
        var кому = targetLabel(state.slidesTarget, ids);
        if (дошло === 0) toast("Сохранено (" + кому + "), но ни один планшет сейчас не на связи: реклама покажется, когда они включатся", true);
        else if (дошло != null) toast("Сохранено и показано на " + дошло + " планшетах (" + кому + ")");
        else toast("Сохранено (" + кому + ")");
      });
  });

  function targetLabel(t, ids) {
    if (t === "all") return "все планшеты";
    if (t === "devices") {
      var n = (ids || []).length;
      if (n === 1) {
        var one = state.devices.find(function (x) { return x.id === ids[0]; });
        return one ? one.name : "1 планшет";
      }
      return "отмеченные планшеты: " + n;
    }
    if (t.indexOf("group:") === 0) { var g = state.groups.find(function (x) { return "group:" + x.id === t; }); return "группа " + (g ? g.name : ""); }
    var d = state.devices.find(function (x) { return "device:" + x.id === t; }); return d ? d.name : "планшет";
  }

  // ---------------- Document editor ----------------
  // The documented set of API fields (tags) offered in the editor. Keep in sync with the
  // server (DocumentTemplating.KnownFields).
  // Fallback only. The real list comes from the server (/field-schema) so the editor, the API
  // documentation and the validation cannot drift apart: adding a tag in one place used to mean
  // remembering to add it in the other.
  var KNOWN_FIELDS = ["ФИО", "ДР", "Адрес регистрации", "Пол", "email", "telephone", "document",
    "date", "cross-border", "urine", "UG",
    "text1", "text2", "text3", "text4", "text5", "text6", "text7", "text8", "text9", "text10"];
  // Curated colour palette (matches the tablet and the PDF renderer).
  var RT_COLORS = ["#1a1c22", "#16a34a", "#dc2626", "#2563eb", "#ea580c", "#7c3aed", "#0d9488", "#6b7280"];
  // Цвета маркера: светлые, чтобы чёрный текст поверх оставался читаемым и на экране, и на бумаге.
  var RT_MARKS = ["#fde68a", "#bbf7d0", "#bfdbfe", "#fecaca"];
  // Возраст считается из даты рождения: внешняя система присылает только ДР, а документу нужно
  // знать, младше ли человек четырнадцати, чтобы показать блок для законных представителей.
  // Две операции, а не четыре: «младше N» и «N и старше» делят людей ровно надвое.
  var COND_OPS = [["eq", "равно"], ["ne", "не равно"], ["empty", "пусто"], ["notempty", "не пусто"],
    ["in", "одно из (через запятую)"], ["agelt", "возраст меньше, лет"], ["agege", "возраст от, лет"],
    ["annivwithin", "до годовщины не больше, дней"],
    ["numlt", "число меньше"], ["numge", "число от"], ["numin", "число в промежутке (от..до)"],
    ["dow", "день недели (1 пн … 7 вс, через запятую)"], ["daterange", "в промежутке дат (от..до)"],
    ["timerange", "во время суток (ЧЧ:ММ..ЧЧ:ММ)"]];
  // Условия по моменту показа считаются по часам сервера, а не по значению тега: поле у них
  // служебное, и выбирать его оператору незачем.
  var CLOCK_OPS = ["dow", "daterange", "timerange"];
  var TODAY_FIELD = "@сегодня";
  function isClockOp(op) { return CLOCK_OPS.indexOf(op) >= 0; }
  // Как читается сравнение под пометкой «не». Не «не равно X», а сразу обратное словами: у
  // сравнений обратное есть у всех, кроме «одно из» и «до годовщины», и для них оно тут и
  // появляется. Иначе свёрнутая строка звучала бы как «не «Пол» равно Ж».
  var COND_OPS_NOT = {
    eq: "не равно", ne: "равно", empty: "не пусто", notempty: "пусто",
    in: "ни одно из",
    numlt: "число от", numge: "число меньше",
    numin: "число вне промежутка", dow: "не в этот день недели",
    daterange: "вне промежутка дат", timerange: "вне этого времени суток"
  };
  var AGE_OPS = ["agelt", "agege"];
  // Условие по сроку: сколько дней между сегодняшним днём и годовщиной даты из тега. Считается
  // день и месяц, год не важен: это случай дня рождения, где полная дата в прошлом на десятки
  // лет. Окно задаётся отдельно до годовщины и после неё.
  var DAYS_OPS = ["annivwithin"];
  function isAgeOp(op) { return AGE_OPS.indexOf(op) >= 0; }
  function isDaysOp(op) { return DAYS_OPS.indexOf(op) >= 0; }
  function isDateOp(op) { return isAgeOp(op) || isDaysOp(op); }
  // Возраст считается из даты рождения, поэтому тег в таком условии может быть только один:
  // тот, в котором эта дата приходит по API. Оператору его выбирать незачем, а раньше без него
  // условие просто пропадало при сохранении.
  var BIRTH_TAGS = ["др", "датарождения", "дата рождения", "birth", "birthday", "birthdate", "dob"];
  function isBirthTag(name) {
    var n = String(name || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
    return BIRTH_TAGS.some(function (h) { return n === h.replace(/[\s_-]+/g, ""); });
  }
  function birthTagName() {
    for (var i = 0; i < KNOWN_FIELDS.length; i++) if (isBirthTag(KNOWN_FIELDS[i])) return KNOWN_FIELDS[i];
    return "";
  }
  // Tags that only ever carry a fixed set of values. Offering them as a list removes the guesswork
  // (was it "M" or "муж"? "да" or "yes"?) and the typo that silently makes a condition never match.
  // Подписи значений для человека: на проводе пол остаётся M и F, потому что так его шлёт
  // внешняя система и так записаны уже существующие условия, а на экране оператор видит Ж и М.
  // Настоящие подписи приходят с сервера, здесь только запасной вариант до его ответа.
  var FIELD_LABELS = { "Пол": { "M": "М (мужской)", "F": "Ж (женский)" } };
  var FIELD_VALUES = {
    "Пол": ["M", "F"],
    "cross-border": ["true", "false"],
    "urine": ["true", "false"],
    "UG": ["true", "false"]
  };

  /// Имена чекбоксов и групп, которые есть в документе. Условие может ссылаться на них так же,
  /// как на тег, но считаться оно будет уже на планшете, по ходу заполнения.
  function docKeys() {
    var checks = [], groups = {};
    ((state.doc || {}).pages || []).forEach(function (p) {
      (p.checkboxes || []).forEach(function (c) { if (c.key && checks.indexOf(c.key) < 0) checks.push(c.key); });
      (p.groups || []).forEach(function (g) {
        if (!g.key) return;
        groups[g.key] = (g.options || []).map(function (o) { return o.key; }).filter(Boolean);
      });
    });
    return { checks: checks, groups: groups };
  }

  /// Всё, что можно поставить в условие: имя чекбокса, имя группы или тег.
  function isDocKey(name) {
    var k = docKeys();
    return k.checks.indexOf(name) >= 0 || Object.prototype.hasOwnProperty.call(k.groups, name);
  }

  /// Replace the fallback list with what the server actually accepts.
  function loadFieldSchema() {
    return apiJson("/field-schema").then(function (s) {
      if (!s || !s.fields || !s.fields.length) return;
      KNOWN_FIELDS = s.fields.map(function (f) { return f.name; });
      FIELD_VALUES = {};
      s.fields.forEach(function (f) {
        if (f.values && f.values.length) FIELD_VALUES[f.name] = f.values;
        if (f.valueLabels) FIELD_LABELS[f.name] = f.valueLabels;
      });
    }).catch(function (e) { console.error(e); });
  }
  var OTHER_OPTION = "\u0000other";   // cannot collide with a real tag or value

  function loadDoc(id) {
    var путь = id ? "/document?id=" + encodeURIComponent(id) : "/document";
    return api(путь).then(function (r) {
      // Версия, от которой оператор правит. Уедет с сохранением, и сервер откажет, если
      // документ уже переписали из другого окна.
      state.docRev = r.headers.get("X-Doc-Rev") || "";
      // Какой именно документ открыт: от него зависит и ключ черновика, и адрес сохранения.
      state.docId = r.headers.get("X-Doc-Id") || id || "";
      return r.json();
    }).then(function (d) {
      state.doc = d; renderDoc(); docLoaded = true;
      // Черновик предлагается, только когда открыта вкладка документа: окно поверх «Слайдов»
      // перекрывало бы вкладки и мешало тому, кто про документ сейчас и не думает.
      if (document.querySelector('[data-panel="document"]:not(.hidden)')) maybeOfferDraft();
    });
  }

  var docLoaded = false;

  // ---------------- Библиотека документов ----------------
  // Документов может быть несколько: согласие, договор, анкета. Здесь оператор переключается
  // между ними, заводит новые и задаёт коды, которыми документ вызывается из внешней системы.
  var docList = [];

  // Закладки документов, как листы в книге: видно, что документов несколько, в каком ты сейчас,
  // и что рядом есть плюс. Выпадающий список этого не показывал вовсе: он выглядел настройкой,
  // а не местом, где ты находишься.
  function renderLibrary() {
    var host = $("docTabs");
    if (!host) return;
    host.innerHTML = "";

    docList.forEach(function (d) {
      var таб = el("button", "doc-tab"); таб.type = "button";
      таб.setAttribute("role", "tab");
      таб.setAttribute("data-role", "doctab");
      таб.setAttribute("data-id", d.id);
      var свой = d.id === state.docId;
      таб.classList.toggle("on", свой);
      таб.setAttribute("aria-selected", свой ? "true" : "false");

      // Основной документ помечается значком, а не словами «по умолчанию»: раньше они слипались
      // с названием и читались как его часть.
      if (d.isDefault) {
        var дом = icon("check", "doc-tab-mark");
        дом.setAttribute("title", "Основной: показывается, когда запрос пришёл без кода");
        таб.appendChild(дом);
      }
      // Вид документа виден с одного взгляда: подписной или только показ.
      var инфо = свой ? String((state.doc && state.doc.kind) || "") === "info" : d.kind === "info";
      var видЗнак = icon(инфо ? "eye" : "pen", "doc-tab-kind");
      видЗнак.setAttribute("title", инфо ? "Только показ, без подписи" : "Подписной документ");
      таб.appendChild(видЗнак);

      // У открытого документа имя берётся из его заголовка: он мог быть только что изменён и
      // ещё не сохранён, а закладка обязана показывать то, что оператор видит перед собой.
      var имяТаба = свой && state.doc && String(state.doc.title || "").trim()
        ? String(state.doc.title).trim() : (d.name || d.code);
      таб.appendChild(el("span", "doc-tab-name", имяТаба));
      // Несохранённое видно прямо на закладке, как в редакторах кода.
      if (свой && dirty) таб.appendChild(el("span", "doc-tab-dot", "•"));
      таб.title = d.name + "\nКод для API: " + d.code + (d.isDefault ? "\nОсновной документ" : "");
      таб.addEventListener("click", function () {
        if (свой) { docMenu(таб, d); return; }   // повторное нажатие на своей закладке открывает меню
        switchDoc(d.id);
      });
      // Меню закладки: всё, что делают с самим документом, живёт здесь, а не в общем ряду кнопок,
      // где непонятно, к чему оно относится: к документу или к странице.
      var меню = el("span", "doc-tab-menu"); меню.textContent = "⋯";
      меню.title = "Действия с документом";
      меню.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!свой) { switchDoc(d.id); return; }
        docMenu(таб, d);
      });
      таб.appendChild(меню);
      host.appendChild(таб);
    });

    var плюс = el("button", "doc-tab doc-tab-add"); плюс.type = "button";
    плюс.appendChild(icon("plus"));
    плюс.appendChild(el("span", null, "Документ"));
    плюс.title = "Завести ещё один документ";
    плюс.addEventListener("click", function () { docMetaDialog(null, null); });
    host.appendChild(плюс);

    // Пока документ один, о библиотеке никто не догадается: подсказка говорит это словами и
    // исчезает, как только документов становится больше.
    if (docList.length < 2) {
      var подсказка = el("span", "doc-tabs-hint",
        "документов может быть несколько, каждый вызывается из внешней системы по своему коду");
      host.appendChild(подсказка);
    }

    // Заголовок и описание меняются вместе с видом: у документа, который только показывают,
    // «Документ для подписанта» это неправда.
    syncDocHeading();
    // Своя закладка должна быть на виду: после переключения или создания она может оказаться за
    // краем прокрутки.
    var своя = host.querySelector(".doc-tab.on");
    if (своя && своя.scrollIntoView) своя.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // Заголовок правят в поле редактора, и закладка должна показывать его сразу: ждать
  // сохранения значит держать на закладке вчерашнее имя.
  (function () {
    var поле = $("docTitle");
    if (!поле) return;
    поле.addEventListener("input", function () {
      var своя = document.querySelector(".doc-tab.on .doc-tab-name");
      if (своя) своя.textContent = поле.value.trim() || "без заголовка";
    });
  })();

  function syncDocHeading() {
    var инфо = state.doc && String(state.doc.kind || "") === "info";
    var h = $("docHeading");
    if (h) h.textContent = инфо ? "Документ для показа" : "Документ для подписанта";
    var hint = $("docHint");
    if (hint) {
      hint.textContent = инфо
        ? "Этот документ не подписывают: его показывают клиенту и возвращают рекламу. Ни записи, ни PDF после него не остаётся. Показывается только на один выбранный планшет."
        : "Документ показывается только на один выбранный планшет (вместе с его персональными данными). Реклама (вкладка «Слайды») настраивается отдельно и может идти на все планшеты, группу или один - это независимо.";
    }
  }

  // Меню закладки: переименование, вид, копия, основной, удаление.
  function docMenu(anchor, d) {
    closeDocMenu();
    var m = el("div", "doc-menu"); m.setAttribute("data-role", "docmenu");
    var инфо = String((state.doc && state.doc.kind) || "") === "info";

    function пункт(значок, текст, действие, опасный) {
      var b = iconBtn(значок, текст, "btn-ghost btn-sm" + (опасный ? " btn-danger" : ""));
      b.addEventListener("click", function () { closeDocMenu(); действие(); });
      m.appendChild(b);
    }

    m.appendChild(el("div", "doc-menu-head", d.name + " · код " + d.code));

    пункт("pen", инфо ? "Сделать подписным" : "Сделать документом только для показа", function () {
      if (!state.doc) return;
      var прежний = state.doc.kind || null;
      state.doc.kind = инфо ? null : "info";
      saveDoc().then(function () { renderDoc(); return loadLibrary(); }).catch(function () {
        state.doc.kind = прежний;   // сервер отказал и объяснил почему
      });
    });
    пункт("settings", "Код для API", function () { docMetaDialog(d, null); });
    пункт("copy", "Создать копию", function () { docMetaDialog(null, d.id); });
    if (!d.isDefault) {
      пункт("check", "Сделать основным", function () {
        apiSend("/documents/" + encodeURIComponent(d.id) + "/default", "POST", {})
          .then(function () { return loadLibrary(); })
          .then(function () { toast("Документ показывается по умолчанию"); })
          .catch(function () { /* уже показано */ });
      });
      пункт("trash", "Удалить документ", function () {
        if (!confirm("Удалить документ «" + d.name + "»?\n\n" +
          "Подписи, собранные по нему, останутся: у каждой записи своя копия документа.")) return;
        api("/documents/" + encodeURIComponent(d.id), { method: "DELETE" })
          .then(function () { state.docId = ""; return loadLibrary(); })
          .then(function () { return loadDoc(); })
          .then(function () { renderLibrary(); toast("Документ удалён"); })
          .catch(function () { /* уже показано */ });
      }, true);
    } else {
      m.appendChild(el("div", "doc-menu-note",
        "Основной документ нельзя удалить: он показывается, когда запрос пришёл без кода. Сначала назначьте основным другой."));
    }

    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 12) + "px";
    m.style.top = (r.bottom + window.scrollY + 4) + "px";
    setTimeout(function () { document.addEventListener("click", closeDocMenu, { once: true }); }, 0);
  }

  function closeDocMenu() {
    var m = document.querySelector('[data-role="docmenu"]');
    if (m) m.remove();
  }

  function loadLibrary() {
    return apiJson("/documents").then(function (list) {
      docList = list || [];
      if (!state.docId) {
        var поумолч = docList.filter(function (d) { return d.isDefault; })[0] || docList[0];
        if (поумолч) state.docId = поумолч.id;
      }
      renderLibrary();
    });
  }

  // Переключение документа: несохранённые правки нельзя терять молча, это та же потеря работы,
  // что и закрытая вкладка, только браузер о ней не предупреждает.
  function switchDoc(id) {
    if (!id || id === state.docId) return;
    function перейти() {
      state.docId = id;
      loadDoc(id).then(function () { renderLibrary(); });
    }
    if (!dirty) { перейти(); return; }
    var c = el("div");
    c.appendChild(el("h3", null, "Есть несохранённые правки"));
    c.appendChild(el("p", "sig-meta",
      "Вы правили этот документ и не сохранили. Правки останутся в черновике этого браузера " +
      "и вернутся, когда вы снова его откроете."));
    var сохранить = iconBtn("save", "Сохранить и перейти", "btn-primary");
    сохранить.addEventListener("click", function () {
      closeModal();
      saveDoc().then(перейти).catch(function () { /* уже показано */ });
    });
    var без = iconBtn("right", "Перейти без сохранения", "btn-ghost");
    без.addEventListener("click", function () {
      closeModal();
      saveDraft();
      dirty = false; syncDirty();
      перейти();
    });
    var отмена = iconBtn("back", "Остаться", "btn-ghost");
    отмена.addEventListener("click", function () {
      closeModal();
      renderLibrary();   // закладки перерисовываются: своя остаётся выделенной
    });
    c.appendChild(сохранить); c.appendChild(без); c.appendChild(отмена);
    openModal(c);
  }

  // Код документа. Имя документа это его заголовок, который оператор видит и правит в самом
  // редакторе: два поля для одного имени однажды разъезжаются, и на закладке оказывается
  // написано не то, что в документе. Поле названия остаётся только для документа без заголовка.
  function docMetaDialog(текущий, копияИз) {
    var c = el("div");
    c.appendChild(el("h3", null, текущий ? "Код документа для API"
      : копияИз ? "Новый документ копией этого" : "Новый документ"));
    c.appendChild(el("p", "sig-meta",
      "Код это имя, которым документ вызывается из внешней системы: латиница, цифры, дефис. " +
      "Название на закладке берётся из заголовка документа и меняется вместе с ним."));
    var кодL = el("label", "field", "Код для API");
    var код = el("input"); код.type = "text"; код.placeholder = "например: SOGLASIE";
    код.value = текущий ? текущий.code : "";
    кодL.appendChild(код); c.appendChild(кодL);
    var имяL = el("label", "field", "Название, пока у документа нет заголовка");
    var имя = el("input"); имя.type = "text"; имя.placeholder = "например: Согласие на обработку данных";
    имя.value = текущий ? текущий.name : "";
    имяL.appendChild(имя); c.appendChild(имяL);
    var ok = iconBtn("check", текущий ? "Сохранить" : "Завести", "btn-primary");
    ok.addEventListener("click", function () {
      var тело = { code: код.value, name: имя.value };
      if (текущий) {
        apiSend("/documents/" + encodeURIComponent(текущий.id), "PUT", тело)
          .then(function () { closeModal(); return loadLibrary(); })
          .then(function () { toast("Сохранено"); })
          .catch(function () { /* уже показано */ });
      } else {
        тело.copyOfId = копияИз || null;
        apiSend("/documents", "POST", тело)
          .then(function (r) { return r.json(); })
          .then(function (созданный) {
            closeModal();
            state.docId = созданный.id;
            return loadLibrary().then(function () { return loadDoc(созданный.id); });
          })
          .then(function () { renderLibrary(); toast("Документ заведён"); })
          .catch(function () { /* уже показано */ });
      }
    });
    c.appendChild(ok);
    openModal(c);
  }
  var draftOffered = false;

  function maybeOfferDraft() {
    if (draftOffered || !docLoaded) return;
    draftOffered = true;
    offerDraft();
  }
  function renderDoc() {
    mountRtBar();
    $("docTitle").value = state.doc.title || ""; $("signPrompt").value = state.doc.signPrompt || "";
    $("idleReturn").value = state.doc.idleReturnSec != null ? state.doc.idleReturnSec : 180;
    ensureFieldsDatalist();
    renderPages();
    updatePlaceholders();
  }

  function ensureFieldsDatalist() {
    if (document.getElementById("knownFieldsList")) return;
    var dl = document.createElement("datalist"); dl.id = "knownFieldsList";
    KNOWN_FIELDS.forEach(function (f) { dl.appendChild(new Option(f, f)); });
    document.body.appendChild(dl);
  }

  // ---------- rich-text editor (contentEditable <-> structured runs) ----------
  function rgbToHex(c) {
    if (!c) return null; c = String(c).trim();
    if (c.charAt(0) === "#") { if (c.length === 7) return c.toLowerCase(); if (c.length === 4) return ("#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toLowerCase(); return null; }
    var m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i); if (!m) return null;
    function h(n) { n = parseInt(n, 10); return (n < 16 ? "0" : "") + n.toString(16); }
    return ("#" + h(m[1]) + h(m[2]) + h(m[3])).toLowerCase();
  }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]; }); }

  function runsToHtml(runs) {
    if (!runs || !runs.length) return "";
    return runs.map(function (r) {
      return String(r.text == null ? "" : r.text).split("\n").map(function (seg, i) {
        var br = i > 0 ? "<br>" : "";
        if (!seg.length) return br;
        var sty = [];
        if (r.bold) sty.push("font-weight:700");
        if (r.italic) sty.push("font-style:italic");
        if (r.color && /^#[0-9a-fA-F]{6}$/.test(r.color)) sty.push("color:" + r.color);
        var cls = r.size === "l" ? "rt-l" : r.size === "h" ? "rt-h" : "";
        if (r.mark && /^#[0-9a-fA-F]{6}$/.test(r.mark)) sty.push("background-color:" + r.mark);
        if (r.sizePt >= 8 && r.sizePt <= 40) sty.push("font-size:" + r.sizePt + "pt");
        return br + "<span" + (cls ? ' class="' + cls + '"' : "") + (sty.length ? ' style="' + sty.join(";") + '"' : "") + ">" + escapeHtml(seg) + "</span>";
      }).join("");
    }).join("");
  }

  function editorToRuns(root) {
    var runs = [], atStart = true;
    function push(text, f) {
      if (!text) return;
      var last = runs[runs.length - 1];
      var color = f.color || null, size = f.size || null;
      var mark = f.mark || null, sizePt = f.sizePt || 0;
      if (last && !!last.bold === !!f.bold && !!last.italic === !!f.italic && (last.color || null) === color
          && (last.size || null) === size && (last.mark || null) === mark && (last.sizePt || 0) === sizePt) last.text += text;
      else {
        var кусок = { text: text, bold: !!f.bold, italic: !!f.italic, color: color, size: size };
        // Пустые свойства не пишутся: документ, где маркера нет, должен лежать в файле точно
        // так же, как лежал раньше, иначе сравнение выгрузок покажет изменения на ровном месте.
        if (mark) кусок.mark = mark;
        if (sizePt) кусок.sizePt = sizePt;
        runs.push(кусок);
      }
      atStart = false;
    }
    function nl(f) { push("\n", f); atStart = true; }
    function derive(elm, f) {
      var g = { bold: f.bold, italic: f.italic, color: f.color, size: f.size, mark: f.mark, sizePt: f.sizePt }, t = elm.tagName;
      if (t === "B" || t === "STRONG") g.bold = true;
      if (t === "I" || t === "EM") g.italic = true;
      var st = elm.style;
      if (st) {
        if (st.fontWeight === "bold" || parseInt(st.fontWeight, 10) >= 600) g.bold = true;
        if (st.fontStyle === "italic") g.italic = true;
        if (st.color) { if (st.color === "inherit") g.color = null; else { var hx = rgbToHex(st.color); if (hx) g.color = hx; } }
        // Выделение маркером. «transparent» это снятое выделение, а не цвет.
        if (st.backgroundColor && st.backgroundColor !== "transparent") {
          var hm = rgbToHex(st.backgroundColor);
          if (hm) g.mark = hm;
        }
        // Свой размер в точках. Записывается стилем, а не классом: ступеней всего три, а
        // размеров нужно сколько угодно.
        if (st.fontSize && /pt$/.test(st.fontSize)) {
          var pt = parseInt(st.fontSize, 10);
          if (pt >= 8 && pt <= 40) g.sizePt = pt;
        }
      }
      if (elm.classList) {
        if (elm.classList.contains("rt-h")) g.size = "h";
        else if (elm.classList.contains("rt-l")) g.size = "l";
        else if (elm.classList.contains("rt-n")) g.size = null;
      }
      return g;
    }
    (function walk(node, f) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var ch = node.childNodes[i];
        if (ch.nodeType === 3) push(ch.nodeValue.replace(/\r/g, ""), f);
        else if (ch.nodeType === 1) {
          if (ch.tagName === "BR") {
            // A browser represents an empty line as <div><br></div>; that trailing <br> is a
            // placeholder, not a real break. Counting it would add a blank line to the document
            // (and to the PDF) on every Enter.
            var isFiller = node !== root && i === node.childNodes.length - 1 &&
              (node.tagName === "DIV" || node.tagName === "P");
            if (!isFiller) nl(f);
            continue;
          }
          var block = ch.tagName === "DIV" || ch.tagName === "P";
          if (block && !atStart) nl(f);
          walk(ch, derive(ch, f));
        }
      }
    })(root, { bold: false, italic: false, color: null, size: null, mark: null, sizePt: 0 });
    // Пустые свойства не пишутся: документ без оформления должен лежать в файле так же, как
    // лежал раньше. Перечисление поимённое, поэтому новое свойство надо добавлять и сюда:
    // маркер и свой размер один раз уже потерялись именно на этой строке.
    return runs.map(function (r) {
      return { text: r.text, bold: r.bold || undefined, italic: r.italic || undefined,
        color: r.color || undefined, size: r.size || undefined,
        mark: r.mark || undefined, sizePt: r.sizePt || undefined };
    });
  }

  // ---------- Вставка из буфера ----------
  // Из Word, PDF и с сайтов приходит чужая разметка: свои шрифты, размеры в пунктах, таблицы,
  // списки, неразрывные пробелы и переносы строк прямо в исходнике. contentEditable всё это
  // показывал как есть, а документ такого не хранит - на планшет уезжал другой текст. Поэтому
  // вставляемое приводится ровно к тому, что документ умеет: жирный, курсив, цвет, размер,
  // переносы строк. Что показал редактор, то и увидит клиент.

  var PASTE_JUNK = /[\u00AD\u200B\u200C\u200D\uFEFF]/g;   // мягкий перенос и нулевая ширина
  var PASTE_BLOCKS = "li,tr,h1,h2,h3,h4,h5,h6,blockquote,pre,section,article,header,footer,figcaption,dt,dd";

  // Разбор в отдельном документе: ничего не грузится и не выполняется, в отличие от innerHTML.
  function parseInert(html) {
    var doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    var body = doc.body;
    if (!body) return null;
    body.querySelectorAll("script,style,link,meta,title,noscript,iframe,object,embed,svg,img,input,button,select,textarea")
      .forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    return body;
  }

  function preparePasted(root) {
    // В <pre> переносы значимы, в остальном HTML - нет. Превращаем их в <br> до того,
    // как схлопнем пробелы, иначе стихотворная вёрстка склеится в одну строку.
    root.querySelectorAll("pre").forEach(function (pre) {
      var parts = String(pre.textContent || "").split("\n");
      pre.textContent = "";
      parts.forEach(function (line, i) {
        if (i > 0) pre.appendChild(root.ownerDocument.createElement("br"));
        pre.appendChild(root.ownerDocument.createTextNode(line));
      });
    });

    // Маркер и номер пункта становятся обычным текстом: списков документ не знает, а без них
    // перечисление из соглашения превратилось бы на планшете в сплошную строку.
    root.querySelectorAll("ol,ul").forEach(function (list) {
      var ordered = list.tagName === "OL", n = parseInt(list.getAttribute("start"), 10) || 1;
      Array.prototype.slice.call(list.children).forEach(function (li) {
        if (li.tagName !== "LI") return;
        li.insertBefore(root.ownerDocument.createTextNode(ordered ? (n++) + ". " : "• "), li.firstChild);
      });
    });

    // Ячейки таблицы разделяем пробелом, строки ниже станут отдельными абзацами.
    root.querySelectorAll("td,th").forEach(function (c) { c.appendChild(root.ownerDocument.createTextNode(" ")); });

    // Всё, что в исходнике было абзацем, заголовком, пунктом или строкой таблицы, приводим к
    // <div>: перенос строки редактор понимает именно так. Обход идёт сверху вниз, поэтому
    // вложенные элементы остаются на месте и обрабатываются следом.
    root.querySelectorAll(PASTE_BLOCKS).forEach(function (n) {
      if (!n.parentNode) return;
      var d = root.ownerDocument.createElement("div");
      // Заголовок в чужой вёрстке задан тегом, а не стилем; сохраняем хотя бы насыщенность.
      if (/^H[1-6]$/.test(n.tagName)) d.style.fontWeight = "700";
      while (n.firstChild) d.appendChild(n.firstChild);
      n.parentNode.replaceChild(d, n);
    });

    // Схлопываем пробелы по правилам HTML: перевод строки в исходнике - это пробел, а не
    // новая строка. Без этого разметка Word рассыпала бы текст на десятки строк.
    var walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      node.nodeValue = String(node.nodeValue || "")
        .replace(PASTE_JUNK, "")
        .replace(/\u00A0/g, " ")
        .replace(/[\t\r\n]+/g, " ")
        .replace(/ {2,}/g, " ");
    }
    return root;
  }

  // Пробелы у краёв строк и пустые строки подряд убираем уже на готовых кусках текста:
  // в исходнике они стоят между тегами и на экране не значат ничего.
  function tidyRuns(runs) {
    var out = [], lineStart = true;
    (runs || []).forEach(function (r) {
      var t = String(r.text == null ? "" : r.text).replace(/ +\n/g, "\n").replace(/\n +/g, "\n");
      if (lineStart) t = t.replace(/^ +/, "");
      if (!t) return;
      lineStart = /\n$/.test(t);
      out.push({ text: t, bold: r.bold, italic: r.italic, color: r.color, size: r.size });
    });
    while (out.length && /^\n+$/.test(out[0].text)) out.shift();
    if (out.length) {
      var last = out[out.length - 1];
      last.text = last.text.replace(/[ \n]+$/, "");
      if (!last.text) out.pop();
    }
    // Больше одной пустой строки подряд документ всё равно не показывает осмысленно.
    out.forEach(function (r) { r.text = r.text.replace(/\n{3,}/g, "\n\n"); });
    return out.filter(function (r) { return r.text.length > 0; });
  }

  function pastedRuns(dt) {
    if (!dt) return [];
    var html = "";
    try { html = dt.getData("text/html") || ""; } catch (e) { html = ""; }
    if (html) {
      var body = parseInert(html);
      if (body) {
        var runs = tidyRuns(editorToRuns(preparePasted(body)));
        if (runs.length) return runs;
      }
    }
    var plain = "";
    try { plain = dt.getData("text/plain") || ""; } catch (e) { plain = ""; }
    plain = plain.replace(PASTE_JUNK, "").replace(/\u00A0/g, " ").replace(/\r\n?/g, "\n");
    return tidyRuns(plain ? [{ text: plain }] : []);
  }

  // Вставляем уже собственную разметку, поэтому в редакторе оказывается ровно то, что документ
  // умеет сохранить. Через execCommand - чтобы отмена по Ctrl+Z продолжала работать.
  function insertRuns(ed, runs) {
    if (!runs.length) return false;
    ed.focus();
    var html = runsToHtml(runs);
    var done = false;
    try { done = document.execCommand("insertHTML", false, html); } catch (e) { done = false; }
    if (!done) {
      var s = window.getSelection();
      if (!s || !s.rangeCount || !ed.contains(s.anchorNode)) return false;
      var range = s.getRangeAt(0); range.deleteContents();
      var tmp = document.createElement("div"); tmp.innerHTML = html;
      var frag = document.createDocumentFragment(), lastNode = null;
      while (tmp.firstChild) { lastNode = tmp.firstChild; frag.appendChild(lastNode); }
      range.insertNode(frag);
      if (lastNode) { range.setStartAfter(lastNode); range.collapse(true); s.removeAllRanges(); s.addRange(range); }
    }
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function attachPasteGuard(ed) {
    ed.addEventListener("paste", function (e) {
      var runs = pastedRuns(e.clipboardData || window.clipboardData);
      if (!runs.length) return;               // пустой буфер - пусть браузер делает как обычно
      e.preventDefault();
      insertRuns(ed, runs);
    });
    // Текст, перетянутый мышью из другого окна, приходит той же чужой разметкой.
    ed.addEventListener("drop", function (e) {
      var runs = pastedRuns(e.dataTransfer);
      if (!runs.length) return;
      e.preventDefault();
      var range = null;
      if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
      else if (document.caretPositionFromPoint) {
        var cp = document.caretPositionFromPoint(e.clientX, e.clientY);
        if (cp) { range = document.createRange(); range.setStart(cp.offsetNode, cp.offset); range.collapse(true); }
      }
      if (range && ed.contains(range.startContainer)) {
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
      }
      insertRuns(ed, runs);
    });
  }

  // BOTH ends of the selection must be inside this editor: a selection dragged from one block into
  // the next would otherwise have its whole span (including the other block's toolbar and text)
  // extracted into this one.
  function insideEditor(ed) {
    var s = window.getSelection();
    return !!(s && s.rangeCount && ed.contains(s.anchorNode) && ed.contains(s.focusNode));
  }
  var RT_SIZE_CLASSES = ["rt-n", "rt-l", "rt-h"];

  /// Wrap the selection in a span the caller configures. A size or colour set on the new span has
  /// to win, so anything of the same kind already inside the selection is stripped first;
  /// otherwise an older nested span kept overriding the button that was just pressed.
  function wrapSelection(ed, applyFn, kind) {
    var s = window.getSelection();
    if (!insideEditor(ed)) { ed.focus(); return; }
    var range = s.getRangeAt(0); if (range.collapsed) return;
    var span = document.createElement("span"); applyFn(span);
    try { span.appendChild(range.extractContents()); range.insertNode(span); } catch (e) { return; }
    if (kind === "size")
      span.querySelectorAll("span").forEach(function (inner) {
        RT_SIZE_CLASSES.forEach(function (c) { inner.classList.remove(c); });
        if (!inner.className && !inner.getAttribute("style")) unwrap(inner);
      });
    if (kind === "color")
      span.querySelectorAll("span").forEach(function (inner) {
        inner.style.color = "";
        if (!inner.className && !inner.getAttribute("style")) unwrap(inner);
      });
    // Маркер и свой размер снимаются с вложенных кусков так же, как цвет: иначе выделение
    // ложится поверх старого, и вложенные обёртки копятся с каждым нажатием.
    if (kind === "mark")
      span.querySelectorAll("span").forEach(function (inner) {
        inner.style.backgroundColor = "";
        if (!inner.className && !inner.getAttribute("style")) unwrap(inner);
      });
    if (kind === "sizept")
      span.querySelectorAll("span").forEach(function (inner) {
        inner.style.fontSize = "";
        if (!inner.className && !inner.getAttribute("style")) unwrap(inner);
      });
    s.removeAllRanges(); var nr = document.createRange(); nr.selectNodeContents(span); s.addRange(nr);
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /// Replace an element with its own children, so stripped spans do not pile up in the markup.
  function unwrap(node) {
    var parent = node.parentNode; if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }
  function insertTag(ed, tag) {
    ed.focus(); var s = window.getSelection(), text = "{{" + tag + "}}";
    if (s.rangeCount && ed.contains(s.anchorNode)) {
      var range = s.getRangeAt(0); range.deleteContents();
      var node = document.createTextNode(text); range.insertNode(node);
      range.setStartAfter(node); range.collapse(true); s.removeAllRanges(); s.addRange(range);
    } else ed.appendChild(document.createTextNode(text));
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // Текст, скопированный из PDF, приходит разорванным по строкам показа: перенос стоит там, где
  // строка кончилась на бумаге. На планшете ширина другая, и такой текст выглядит рваным. Здесь
  // одиночные переносы становятся пробелами, а пустая строка между абзацами остаётся границей
  // абзаца. Операция явная, потому что в адресе или в реквизитах переносы бывают осмысленными.
  function unwrapLines(ed) {
    var runs = editorToRuns(ed);
    if (!runs.length) return;

    // Разбираем текст посимвольно, помня, какому куску оформления принадлежит каждый символ.
    // Иначе перенос на стыке жирного и обычного текста попал бы в разные строки и не опознался.
    var chars = [], owner = [];
    runs.forEach(function (r, i) {
      String(r.text == null ? "" : r.text).split("").forEach(function (ch) { chars.push(ch); owner.push(i); });
    });

    var out = [], own = [];
    function drop() { while (out.length && out[out.length - 1] === " ") { out.pop(); own.pop(); } }
    for (var i = 0; i < chars.length; i++) {
      if (chars[i] !== "\n") { out.push(chars[i]); own.push(owner[i]); continue; }
      var j = i, breaks = 0;
      while (j < chars.length && (chars[j] === "\n" || chars[j] === " " || chars[j] === "\t")) {
        if (chars[j] === "\n") breaks++;
        j++;
      }
      drop();
      if (breaks >= 2) { out.push("\n"); own.push(owner[i]); out.push("\n"); own.push(owner[i]); }
      else if (out.length) { out.push(" "); own.push(owner[i]); }
      i = j - 1;
    }
    drop();

    var joined = [];
    for (var k = 0; k < out.length; k++) {
      var src = runs[own[k]] || {};
      var last = joined[joined.length - 1];
      if (last && last.owner === own[k]) last.text += out[k];
      else joined.push({ owner: own[k], text: out[k], bold: src.bold, italic: src.italic, color: src.color, size: src.size });
    }
    ed.innerHTML = runsToHtml(joined);
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function tbBtn(label, title, fn, italicLabel) {
    var b = el("button", "rt-btn", label); b.type = "button"; b.title = title || "";
    if (italicLabel) b.style.fontStyle = "italic";
    b.addEventListener("mousedown", function (e) { e.preventDefault(); });
    b.addEventListener("click", function (e) { e.preventDefault(); fn(); });
    return b;
  }
  // ---------- Панель оформления ----------
  // Панель одна на всю страницу и всплывает над тем полем, которое редактируется. Раньше своя
  // панель была у каждого блока и каждого заголовка: на документе из пяти страниц это
  // пятнадцать одинаковых панелей и больше двухсот кнопок, из-за которых карточка блока
  // становилась вдвое выше, а вся страница растягивалась на девять экранов.
  var rtBar = null;      // сама панель
  var rtTarget = null;   // поле, к которому она сейчас относится

  // Выравнивание это свойство всего абзаца, а не выделенного куска: выровнять половину строки
  // нельзя. Поэтому оно хранится на самом поле, а не в разметке текста, и одинаково доходит и
  // до планшета, и до PDF.
  var ALIGNS = [["", "align-left", "По левому краю"], ["center", "align-center", "По центру"],
    ["right", "align-right", "По правому краю"], ["justify", "align-justify", "По обоим краям"]];
  function setAlign(ed, align) {
    var a = (align || "").toLowerCase();
    if (a !== "center" && a !== "right" && a !== "justify") a = "";
    if (a) ed.setAttribute("data-align", a); else ed.removeAttribute("data-align");
    ed.style.textAlign = a || "";
  }
  function alignOf(ed) { return ed ? (ed.getAttribute("data-align") || "") : ""; }

  function rtCommand(fn) {
    return function () { if (rtTarget) fn(rtTarget); };
  }

  function buildRtBar() {
    var bar = el("div", "rt-toolbar rt-float"); bar.setAttribute("data-role", "rtbar");
    bar.appendChild(tbBtn("Ж", "Жирный", rtCommand(function (ed) {
      if (insideEditor(ed)) { document.execCommand("bold", false, null); ed.dispatchEvent(new Event("input", { bubbles: true })); }
    })));
    bar.appendChild(tbBtn("К", "Курсив", rtCommand(function (ed) {
      if (insideEditor(ed)) { document.execCommand("italic", false, null); ed.dispatchEvent(new Event("input", { bubbles: true })); }
    }), true));
    bar.appendChild(tbBtn("A", "Обычный размер", rtCommand(function (ed) { wrapSelection(ed, function (s) { s.className = "rt-n"; }, "size"); })));
    bar.appendChild(tbBtn("A+", "Крупный", rtCommand(function (ed) { wrapSelection(ed, function (s) { s.className = "rt-l"; }, "size"); })));
    bar.appendChild(tbBtn("A++", "Огромный", rtCommand(function (ed) { wrapSelection(ed, function (s) { s.className = "rt-h"; }, "size"); })));
    RT_COLORS.forEach(function (c) {
      var sw = el("button", "rt-swatch"); sw.type = "button"; sw.style.background = c; sw.title = "Цвет " + c;
      sw.addEventListener("mousedown", function (e) { e.preventDefault(); });
      sw.addEventListener("click", function (e) {
        e.preventDefault();
        if (rtTarget) wrapSelection(rtTarget, function (s) { s.style.color = c; }, "color");
      });
      bar.appendChild(sw);
    });
    bar.appendChild(tbBtn("○", "Цвет по умолчанию", rtCommand(function (ed) { wrapSelection(ed, function (s) { s.style.color = "inherit"; }, "color"); })));

    // Выделение маркером: тот же приём, что и с цветом букв, но красится фон. Цвета мягкие:
    // маркер должен выделять, а не закрашивать текст до нечитаемости.
    RT_MARKS.forEach(function (c) {
      var sw = el("button", "rt-swatch rt-swatch-mark"); sw.type = "button";
      sw.style.background = c; sw.title = "Выделить фоном";
      sw.addEventListener("mousedown", function (e) { e.preventDefault(); });
      sw.addEventListener("click", function (e) {
        e.preventDefault();
        if (rtTarget) wrapSelection(rtTarget, function (s) { s.style.backgroundColor = c; }, "mark");
      });
      bar.appendChild(sw);
    });
    bar.appendChild(tbBtn("⌫", "Убрать выделение фоном", rtCommand(function (ed) {
      wrapSelection(ed, function (s) { s.style.backgroundColor = "transparent"; }, "mark");
    })));

    // Свой размер в точках: ступеней «обычный, крупный, огромный» хватает не всегда, а мелкий
    // шрифт сноски или крупный заголовок раздела задаются именно числом.
    // Размер в точках нельзя сделать кнопкой: число надо ввести, а ввод требует перевести в
    // поле курсор, и выделение текста при этом пропадает. Поэтому выделение запоминается в тот
    // момент, когда оператор только тянется к полю, и восстанавливается перед применением.
    var ptWrap = el("span", "rt-pt");
    var pt = el("input"); pt.type = "number"; pt.min = "8"; pt.max = "40"; pt.placeholder = "пт";
    pt.title = "Свой размер в точках: выделите текст и введите число";
    var ptRange = null, ptEd = null;
    function запомнитьВыделение() {
      var s = window.getSelection();
      if (!rtTarget || !s.rangeCount) return;
      var r = s.getRangeAt(0);
      if (r.collapsed || !rtTarget.contains(r.commonAncestorContainer)) return;
      ptRange = r.cloneRange(); ptEd = rtTarget;
    }
    // И мышью, и с клавиатуры: до поля можно дойти табуляцией.
    pt.addEventListener("mousedown", запомнитьВыделение);
    pt.addEventListener("focus", запомнитьВыделение);
    pt.addEventListener("change", function () {
      if (!ptRange || !ptEd) return;
      var s = window.getSelection();
      s.removeAllRanges(); s.addRange(ptRange);
      var n = parseInt(pt.value, 10);
      if (n >= 8 && n <= 40) wrapSelection(ptEd, function (sp) { sp.style.fontSize = n + "pt"; }, "sizept");
      else wrapSelection(ptEd, function (sp) { sp.style.fontSize = ""; }, "sizept");
      ptRange = null;
    });
    ptWrap.appendChild(pt);
    bar.appendChild(ptWrap);
    ALIGNS.forEach(function (a) {
      var b = iconBtn(a[1], "", "rt-btn"); b.type = "button"; b.title = a[2];
      b.setAttribute("data-align-btn", a[0]);
      b.addEventListener("mousedown", function (e) { e.preventDefault(); });
      b.addEventListener("click", function (e) {
        e.preventDefault();
        if (!rtTarget) return;
        setAlign(rtTarget, a[0]);
        rtTarget.dispatchEvent(new Event("input", { bubbles: true }));
        syncRtBar();
      });
      bar.appendChild(b);
    });
    bar.appendChild(tbBtn("¶", "Склеить перенесённые строки: абзацы останутся абзацами, а разрывы посреди предложения уйдут. Нужно после копирования из PDF, где каждая строка приходит отдельной.",
      rtCommand(function (ed) { unwrapLines(ed); })));
    var tsel = el("select", "rt-tag"); tsel.appendChild(new Option("+ тег", ""));
    KNOWN_FIELDS.forEach(function (f) { tsel.appendChild(new Option(f, f)); });
    // mousedown с preventDefault нельзя: список тогда не открывается. Поле не теряет выделение,
    // потому что при возврате фокуса оно восстанавливается сохранённым диапазоном.
    tsel.addEventListener("change", function () {
      if (tsel.value && rtTarget) { insertTag(rtTarget, tsel.value); }
      tsel.value = "";
    });
    bar.appendChild(tsel);
    bar.appendChild(el("span", "rt-hint"));
    return bar;
  }

  /// Панель встаёт над редактором документа и остаётся там всё время.
  function mountRtBar() {
    if (rtBar) return;
    var host = document.getElementById("rtBarHost");
    if (!host) return;
    rtBar = buildRtBar();
    host.appendChild(rtBar);
    syncTopbarHeight();
    syncRtBar();
  }

  // Панель стоит на своём месте всегда: одной строкой под шапкой, прилипая при прокрутке.
  // Всплывающая над полем панель закрывала собой то, что было выше: кнопку условия показа,
  // подпись «Заголовок», переключатель «Текст / Картинка» и часть текста. Постоянное место
  // не закрывает ничего и не прыгает: пока поле не выбрано, кнопки просто неактивны.
  function syncRtBar() {
    if (!rtBar) return;
    rtBar.classList.toggle("rt-idle", !rtTarget);
    var hint = rtBar.querySelector(".rt-hint");
    if (hint) hint.textContent = rtTarget ? "" : "Поставьте курсор в текст, чтобы оформить его";
    var now = alignOf(rtTarget);
    rtBar.querySelectorAll("[data-align-btn]").forEach(function (b) {
      b.classList.toggle("on", !!rtTarget && b.getAttribute("data-align-btn") === now);
    });
    Array.prototype.forEach.call(rtBar.querySelectorAll("button, select"), function (c) {
      c.disabled = !rtTarget;
    });
  }

  function showRtBar(ed) { rtTarget = ed; syncRtBar(); }
  function hideRtBar() { rtTarget = null; syncRtBar(); }

  // Панель показывается по фокусу в поле и гаснет, когда фокус ушёл и из поля, и из неё.
  document.addEventListener("focusin", function (e) {
    var ed = e.target.closest ? e.target.closest(".rt-editor") : null;
    if (ed) { showRtBar(ed); return; }
    if (rtBar && rtBar.contains(e.target)) return;
    hideRtBar();
  });

  // Высота шапки нужна панели, чтобы прилипать точно под ней. При узком окне вкладки
  // переносятся на вторую строку, и высота меняется.
  function syncTopbarHeight() {
    var bar = document.querySelector(".topbar");
    document.documentElement.style.setProperty("--topbar-h", ((bar ? bar.offsetHeight : 0)) + "px");
  }
  window.addEventListener("resize", syncTopbarHeight);

  function richEditor(labelText, runs, role, align) {
    var wrap = el("div", "rt-field");
    if (labelText) wrap.appendChild(el("div", "rt-label", labelText));
    var ed = el("div", "rt-editor"); ed.contentEditable = "true"; ed.setAttribute("data-role", role); ed.innerHTML = runsToHtml(runs);
    setAlign(ed, align);
    attachPasteGuard(ed);
    wrap.appendChild(ed);
    return wrap;
  }

  // ---------- condition editor (show block / page only when a field matches) ----------
  function conditionEditor(cond, role) {
    var box = el("div", "cond-box"); box.setAttribute("data-role", role);
    var mode = el("select", "cond-mode");
    mode.appendChild(new Option("Показывать всегда", "")); mode.appendChild(new Option("Показывать по условию", "cond"));
    var fields = el("div", "cond-fields");
    var rows = el("div", "cond-rows");
    fields.appendChild(rows);

    // Условие складывается из нескольких строк. «И» дополняет тот же набор: показывать, только
    // если выполнены обе части сразу. «ИЛИ» начинает новый набор: хватит любого выполненного
    // целиком. Вложенности нет и скобок оператор не расставляет: «и» связывает сильнее, как и
    // принято, поэтому «А и Б или В» это «(А и Б) или В», и ровно так же читается свёрнутая
    // строка условия.
    var adds = el("div", "cond-adds");
    var addAnd = iconBtn("plus", "и ещё условие", "btn-ghost btn-sm cond-add");
    function appendRow(asOr) {
      addRow(null, asOr);
      badge.textContent = describe();
      var last = rows.lastElementChild;
      var sel = last && last.querySelector('[data-role="cfieldsel"]');
      if (sel) sel.focus();
    }
    addAnd.addEventListener("click", function () { appendRow(false); });
    // Своя пометка, без общей cond-add: иначе «добавить условие» и «добавить набор» неразличимы
    // ни для правил оформления, ни для того, кто ищет кнопку по её пометке.
    var addOr = iconBtn("plus", "или другой набор", "btn-ghost btn-sm cond-add-or");
    addOr.title = "Показывать, если выполнен хотя бы один из наборов";
    addOr.addEventListener("click", function () { appendRow(true); });
    adds.appendChild(addAnd); adds.appendChild(addOr);
    fields.appendChild(adds);

    // Одна строка условия: тег, сравнение, значение. Строки после первой присоединяются к
    // предыдущим словом «и» или начинают новый набор словом «или».
    function condRow(part, joinOr) {
      var row = el("div", "cond-row"); row.setAttribute("data-role", "crow");
      var joiner = el("select", "cond-and cond-join"); joiner.setAttribute("data-role", "cjoin");
      joiner.appendChild(new Option("и", "and"));
      joiner.appendChild(new Option("или", "or"));
      joiner.value = joinOr ? "or" : "and";
      joiner.addEventListener("change", function () {
        row.classList.toggle("cond-or", joiner.value === "or");
        badge.textContent = describe();
      });
      if (joinOr) row.classList.add("cond-or");
      row.appendChild(joiner);

      // Тег выбирается списком, а не текстом с подсказками: у подсказок список пустеет, как
      // только что-то выбрано, и сменить тег можно только стерев поле руками.
      var fld = el("select", "cond-field"); fld.setAttribute("data-role", "cfieldsel");
      fld.appendChild(new Option("выберите тег", ""));
      var keys = docKeys();
      var tagGroup = document.createElement("optgroup"); tagGroup.label = "Теги из API";
      KNOWN_FIELDS.forEach(function (f) { tagGroup.appendChild(new Option(f, f)); });
      fld.appendChild(tagGroup);
      // Отдельной группой, потому что это другая природа: считается на планшете, пока клиент
      // заполняет документ, а не один раз на сервере до отправки.
      if (keys.checks.length) {
        var cg = document.createElement("optgroup"); cg.label = "Чекбоксы в документе";
        keys.checks.forEach(function (k) { cg.appendChild(new Option(k, k)); });
        fld.appendChild(cg);
      }
      var groupNames = Object.keys(keys.groups);
      if (groupNames.length) {
        var gg = document.createElement("optgroup"); gg.label = "Двойные зависимые чекбоксы";
        groupNames.forEach(function (k) { gg.appendChild(new Option(k, k)); });
        fld.appendChild(gg);
      }
      fld.appendChild(new Option("другой тег...", OTHER_OPTION));
      // Оставлено для тега вне известного списка, чтобы уже работающее не перестало работать.
      var fldOther = el("input", "cond-field-other"); fldOther.type = "text";
      fldOther.placeholder = "свой тег"; fldOther.setAttribute("data-role", "cfield");

      // Пометка «не»: часть должна быть НЕ выполнена. Вместе со связкой «и» это и есть «и не»,
      // вместе с «или» это «или не», а на первой строке просто «не». Отдельной пометкой, а не
      // отдельными сравнениями: «ни одно из» и «не в окне годовщины» иначе не выразить, а
      // остальным обратное сравнение уже есть в списке.
      var not = el("button", "cond-not"); not.type = "button";
      not.textContent = "не";
      not.title = "Показывать, когда эта часть НЕ выполнена";
      not.setAttribute("data-role", "cnot");
      not.setAttribute("aria-pressed", "false");
      not.addEventListener("click", function () {
        var on = not.getAttribute("aria-pressed") !== "true";
        not.setAttribute("aria-pressed", on ? "true" : "false");
        not.classList.toggle("on", on);
        badge.textContent = describe();
      });
      row.appendChild(not);

      var op = el("select", "cond-op"); op.setAttribute("data-role", "cop");
      COND_OPS.forEach(function (o) { op.appendChild(new Option(o[1], o[0])); });

      // Значение выбирается списком, если у тега фиксированный набор, иначе вводится текстом.
      var valSel = el("select", "cond-val-sel"); valSel.setAttribute("data-role", "cvalsel");
      var val = el("input", "cond-val"); val.type = "text"; val.placeholder = "значение"; val.setAttribute("data-role", "cval");
      // Второе число для условий по сроку: сколько дней после даты. Отдельным полем, а не
      // записью «14/3» в одном: оператор не должен знать, как это хранится.
      var valTo = el("span", "cond-window");
      var valAfter = el("input", "cond-val cond-age"); valAfter.type = "number"; valAfter.min = "0"; valAfter.max = "3650";
      valAfter.placeholder = "после"; valAfter.setAttribute("data-role", "cvalafter");
      valTo.appendChild(el("span", "cond-window-sep", "до и"));
      valTo.appendChild(valAfter);
      valTo.appendChild(el("span", "cond-window-sep", "после"));

      row.appendChild(fld); row.appendChild(fldOther); row.appendChild(op);
      row.appendChild(valSel); row.appendChild(val); row.appendChild(valTo);

      var подсказка = el("span", "cond-hint");
      подсказка.style.display = "none";
      row.appendChild(подсказка);

      var drop = el("button", "btn btn-danger btn-sm cond-drop", "×");
      drop.type = "button"; drop.title = "Убрать это условие";
      drop.addEventListener("click", function () {
        row.remove();
        renumber();
        badge.textContent = describe();
      });
      row.appendChild(drop);

      function currentField() { return fld.value === OTHER_OPTION ? fldOther.value.trim() : fld.value; }

      // Пересобрать поле значения под выбранный тег, сохранив то, что уже задано.
      function syncValues(keep) {
        var f = currentField();
        var dk = docKeys();
        var known = fieldValues(f);
        if (dk.checks.indexOf(f) >= 0) known = ["true", "false"];
        else if (Object.prototype.hasOwnProperty.call(dk.groups, f)) known = dk.groups[f].slice();
        // У возраста значение это число лет: список значений тега тут ни при чём. То же у
        // числовых сравнений и у условий по моменту показа: там значение это число, промежуток
        // или перечень дней недели.
        if (isDateOp(op.value) || isClockOp(op.value) || op.value === "numlt" || op.value === "numge" || op.value === "numin") known = null;
        // «одно из» принимает список через запятую, одним выбором его не выразить.
        var listable = known && op.value !== "in";
        valSel.innerHTML = "";
        if (listable) {
          known.forEach(function (v) { valSel.appendChild(new Option(valueLabel(f, v), v)); });
          valSel.appendChild(new Option("другое...", OTHER_OPTION));
          if (keep && known.indexOf(keep) < 0) { valSel.value = OTHER_OPTION; val.value = keep; }
          else { valSel.value = keep || known[0]; val.value = ""; }
        } else if (keep != null) {
          // Сохранённое окно «14/3» раскладывается обратно в два поля.
          if (isDaysOp(op.value)) {
            var parts = String(keep).split("/");
            val.value = (parts[0] || "").trim();
            valAfter.value = (parts.length > 1 ? parts[1] : parts[0] || "").trim();
          } else {
            val.value = keep;
          }
        }
        valSel.style.display = listable ? "" : "none";
        val.style.display = (!listable || valSel.value === OTHER_OPTION) ? "" : "none";
      }

      // Часы сервера вместо тега: у условий по моменту показа выбирать нечего, и список тегов
      // только сбивал бы с толку. Само поле при этом всё равно уедет служебным: сервер его
      // подменяет, что бы ни пришло.
      function syncClock() {
        var часы = isClockOp(op.value);
        fld.style.display = часы ? "none" : "";
        fldOther.style.display = часы ? "none" : (fld.value === OTHER_OPTION ? "" : "none");
        var метка = row.querySelector('[data-role="clocknote"]');
        if (часы && !метка) {
          метка = el("span", "cond-clock-note", "по часам сервера");
          метка.setAttribute("data-role", "clocknote");
          метка.title = "Считается по дате и времени сервера, а не по значению тега";
          row.insertBefore(метка, op);
        } else if (!часы && метка) метка.remove();
      }

      function syncRow() {
        fldOther.style.display = fld.value === OTHER_OPTION ? "" : "none";
        // Пока тег не выбран, условие никуда не сохранится. Молчать об этом нельзя: оператор
        // задаёт значение, нажимает «Сохранить» и не понимает, почему условия нет.
        var пусто = !currentField();
        row.classList.toggle("cond-bad", пусто);
        fld.options[0].textContent = isDateOp(op.value) ? "выберите тег с датой рождения" : "выберите тег";
        подсказка.textContent = пусто
          ? "выберите тег, иначе условие не сохранится"
          : isAgeOp(op.value) ? "возраст считается из даты рождения на сервере"
            : isDaysOp(op.value) ? "считается день и месяц, год не важен: это случай дня рождения" : "";
        подсказка.style.display = подсказка.textContent ? "" : "none";
        // Возраст вводится числом, а не текстом: так в поле не окажется «четырнадцать».
        if (isDateOp(op.value)) {
          val.type = "number"; val.min = "0";
          val.max = isDaysOp(op.value) ? "3650" : "130";
          val.placeholder = isDaysOp(op.value) ? "дней" : "лет";
          val.classList.add("cond-age");
        } else {
          val.type = "text"; val.removeAttribute("min"); val.removeAttribute("max");
          val.placeholder = "значение"; val.classList.remove("cond-age");
        }
        var needsValue = op.value !== "empty" && op.value !== "notempty";
        valSel.style.display = needsValue && valSel.options.length ? "" : "none";
        val.style.display = needsValue && (!valSel.options.length || valSel.value === OTHER_OPTION) ? "" : "none";
        valTo.style.display = isDaysOp(op.value) ? "" : "none";
        if (isDaysOp(op.value)) val.placeholder = "до";
      }

      fld.addEventListener("change", function () { syncValues(null); syncRow(); });
      fldOther.addEventListener("input", function () { syncValues(val.value); syncRow(); });
      op.addEventListener("change", function () {
        // Выбрали условие по возрасту - тег с датой рождения подставляется сам. Другого тега
        // здесь быть и не может: возраст берётся только из даты рождения.
        if (isDateOp(op.value) && !currentField()) {
          var b = birthTagName();
          if (b) fld.value = b;
        }
        syncValues(readRowValue(row)); syncRow();
      });
      valSel.addEventListener("change", syncRow);

      if (part && part.field) {
        // Регистр не важен: тег ПОЛ, сохранённый до переименования, должен выбраться как Пол,
        // а не выпасть в «другой тег».
        var match = null;
        for (var mi = 0; mi < fld.options.length; mi++)
          if (fld.options[mi].value && fld.options[mi].value !== OTHER_OPTION &&
              fld.options[mi].value.toLowerCase() === String(part.field).toLowerCase()) { match = fld.options[mi].value; break; }
        if (match) fld.value = match;
        else { fld.value = OTHER_OPTION; fldOther.value = part.field; }
        op.value = part.op || "eq";
        if (part.not) { not.setAttribute("aria-pressed", "true"); not.classList.add("on"); }
        syncValues(part.value || "");
      } else {
        syncValues(null);
      }
      syncRow();
      syncClock();
      op.addEventListener("change", syncClock);

      [fld, fldOther, op, val, valSel, valAfter].forEach(function (e) {
        e.addEventListener("change", function () { badge.textContent = describe(); });
        e.addEventListener("input", function () { badge.textContent = describe(); });
      });
      return row;
    }

    function addRow(part, joinOr) { rows.appendChild(condRow(part, joinOr)); renumber(); }

    // Соединение и кнопка удаления нужны только у строк после первой: первая строка это само
    // условие, без неё остальные не имеют смысла.
    function renumber() {
      var list = rows.querySelectorAll('[data-role="crow"]');
      if (!list.length) { addRow(null); return; }
      for (var i = 0; i < list.length; i++) {
        list[i].classList.toggle("cond-extra", i > 0);
        var drop = list[i].querySelector(".cond-drop");
        if (drop) drop.style.display = i > 0 ? "" : "none";
        // Первая строка ни к чему не присоединяется. Если «или» осталось на ней после удаления
        // строки выше, набор начинался бы с пустого места.
        var join = list[i].querySelector('[data-role="cjoin"]');
        if (join && i === 0) { join.value = "and"; list[i].classList.remove("cond-or"); }
      }
    }

    addRow(cond || null);
    ((cond && cond.and) || []).forEach(function (extra) { addRow(extra); });
    ((cond && cond.or) || []).forEach(function (alt) {
      if (!alt) return;
      addRow(alt, true);
      ((alt && alt.and) || []).forEach(function (extra) { addRow(extra); });
    });

    function sync() {
      fields.style.display = mode.value === "cond" ? "" : "none";
    }
    mode.addEventListener("change", sync);
    if (cond && cond.field) mode.value = "cond";
    sync();

    // Свёрнутый вид: пока условия нет, это одна ссылка, а когда есть, короткая строка вида
    // «только если «Пол» равно F и «UG» равно true». Выпадающие списки у каждого элемента
    // занимали треть высоты страницы, даже когда условие не задано ни у одного.
    var badge = el("button", "cond-badge");
    var open = false;
    // Часть под пометкой «не» описывается сразу обратным по смыслу, а не приставкой «не» перед
    // фразой: «не «Пол» равно Ж» по-русски не читается, а «Пол не равно Ж» читается. Возраст и
    // годовщина переворачиваются целыми фразами, потому что там отрицается не сравнение, а
    // попадание в промежуток.
    function describePart(c) {
      var не = !!c.not;
      var opName = "";
      COND_OPS.forEach(function (o) { if (o[0] === c.op) opName = o[1]; });
      if (не && COND_OPS_NOT[c.op]) opName = COND_OPS_NOT[c.op];
      if (c.op === "empty" || c.op === "notempty") return "«" + c.field + "» " + opName;
      if (c.op === "agelt" || c.op === "agege") {
        // Обратное к «меньше N» это «от N», и наоборот: отдельной формулировки не нужно.
        var меньше = (c.op === "agelt") !== не;
        return "возраст по «" + c.field + "» " + (меньше ? "меньше " : "от ") + (c.value || "?") + " лет";
      }
      if (c.op === "numlt" || c.op === "numge")
        return "«" + c.field + "» " + (не === (c.op === "numlt") ? "не меньше " : (c.op === "numlt" ? "меньше " : "от ")) + (c.value || "?");
      if (c.op === "numin") {
        var гр = String(c.value || "").split("..");
        return "«" + c.field + "» " + (не ? "вне промежутка " : "в промежутке ") + (гр[0] || "?") + ".." + (гр[1] || "?");
      }
      if (c.op === "dow") {
        var дни = { "1": "пн", "2": "вт", "3": "ср", "4": "чт", "5": "пт", "6": "сб", "7": "вс" };
        var сп = String(c.value || "").split(",").map(function (x) { return дни[x.trim()] || x.trim(); })
          .filter(function (x) { return x.length; }).join(", ");
        return (не ? "сегодня не " : "сегодня ") + (сп || "?");
      }
      if (c.op === "daterange" || c.op === "timerange") {
        var г2 = String(c.value || "").split("..");
        var что = c.op === "daterange" ? "дата" : "время";
        return (не ? что + " вне " : что + " в промежутке ") + (г2[0] || "?") + ".." + (г2[1] || "?");
      }
      if (c.op === "annivwithin") {
        var что = "годовщины";
        var p = String(c.value || "").split("/");
        var до = (p[0] || "?").trim(), после = (p.length > 1 ? p[1] : p[0] || "?").trim();
        var окно = до === после
          ? ("до " + что + " «" + c.field + "» не больше " + до + " дней в обе стороны")
          : ("«" + c.field + "»: " + до + " дней до " + что + " и " + после + " после");
        return не ? ("не выполнено: " + окно) : окно;
      }
      return "«" + c.field + "» " + opName + " " + (valueLabel(c.field, c.value) || "(пусто)");
    }
    function describe() {
      var c = readCondition(box);
      if (!c) return "+ условие показа";
      var groups = condGroups(c).map(function (g) {
        var parts = [describePart(g)];
        (g.and || []).forEach(function (extra) { parts.push(describePart(extra)); });
        return parts;
      });
      if (groups.length === 1) return "только если " + groups[0].join(" и ");
      // Наборов больше одного: в скобки берутся те, что сами состоят из нескольких частей. Без
      // них «А и Б или В» читалось бы двояко, а от прочтения зависит, покажется блок или нет.
      // Набору из одной части скобки не нужны, и лишние только мешают читать.
      return "только если " + groups.map(function (parts) {
        return parts.length > 1 ? "(" + parts.join(" и ") + ")" : parts[0];
      }).join(" или ");
    }
    function applyOpen() {
      box.classList.toggle("cond-open", open);
      mode.classList.toggle("hidden", !open);
      fields.classList.toggle("hidden", !open || mode.value !== "cond");
      badge.classList.toggle("hidden", open);
      badge.textContent = describe();
      badge.classList.toggle("set", !!readCondition(box));
    }
    badge.addEventListener("click", function () {
      open = true;
      // Первое открытие сразу переводит в режим условия: иначе оператор жмёт «+ условие»
      // и видит список «Показывать всегда», то есть ничего не произошло.
      if (mode.value !== "cond") { mode.value = "cond"; sync(); }
      applyOpen();
      var first = rows.querySelector("select");
      if (first) first.focus();
    });
    mode.addEventListener("change", function () {
      // Вернули «Показывать всегда»: сворачиваем обратно, показывать нечего.
      if (mode.value !== "cond") { open = false; applyOpen(); }
    });

    box.appendChild(badge);
    box.appendChild(mode); box.appendChild(fields);
    applyOpen();   // всегда начинаем со свёрнутого вида, и с условием, и без него
    return box;
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

  // Части одного набора: он сам и всё, что присоединено через «и».
  function condParts(cond) {
    var out = [];
    if (cond && cond.field) out.push(cond);
    ((cond && cond.and) || []).forEach(function (extra) { if (extra && extra.field) out.push(extra); });
    return out;
  }

  function readRowValue(row) {
    var op = row.querySelector('[data-role="cop"]');
    var valInput = row.querySelector('[data-role="cval"]');
    // Условие по сроку хранит окно одной строкой: «7» это семь дней в обе стороны, «14/3» это
    // четырнадцать до и три после. Оператор при этом видит два обычных поля.
    if (op && isDaysOp(op.value)) {
      var after = row.querySelector('[data-role="cvalafter"]');
      var b = (valInput ? valInput.value : "").trim();
      var a = (after ? after.value : "").trim();
      if (!b && !a) return "";
      if (b === "" ) b = "0";
      if (a === "" || a === b) return b;
      return b + "/" + a;
    }
    var valSel = row.querySelector('[data-role="cvalsel"]');
    return (valSel && valSel.options.length && valSel.value !== OTHER_OPTION)
      ? valSel.value
      : (valInput ? valInput.value : "");
  }

  function readRow(row) {
    var sel = row.querySelector('[data-role="cfieldsel"]');
    var other = row.querySelector('[data-role="cfield"]');
    var field = (sel && sel.value && sel.value !== OTHER_OPTION ? sel.value : (other ? other.value : "")).trim();
    var opEl = row.querySelector('[data-role="cop"]');
    if (!field && !isClockOp((opEl && opEl.value) || "")) return null;
    var op = row.querySelector('[data-role="cop"]');
    var not = row.querySelector('[data-role="cnot"]');
    var вид = (op && op.value) || "eq";
    // У условий по моменту показа поле служебное: тег тут ни при чём, значение берётся из часов
    // сервера. Иначе строка без выбранного тега считалась бы незаполненной и не сохранялась.
    var part = { field: isClockOp(вид) ? TODAY_FIELD : field, op: вид, value: (readRowValue(row) || "").trim() };
    // Пометка пишется только когда она стоит: без этого каждое условие таскало бы «not: false»,
    // и сравнение сохранённого с прежним видом показывало бы изменения там, где их нет.
    if (not && not.getAttribute("aria-pressed") === "true") part.not = true;
    return part;
  }

  function readCondition(box) {
    if (!box) return null;
    var mode = box.querySelector(".cond-mode"); if (!mode || mode.value !== "cond") return null;
    var groups = [];
    box.querySelectorAll('[data-role="crow"]').forEach(function (row) {
      var part = readRow(row);
      if (!part) return;
      var join = row.querySelector('[data-role="cjoin"]');
      // Новый набор начинает строка со словом «или». Пустые строки выше при этом пропущены,
      // поэтому первый же набор начинается с той строки, которая действительно заполнена.
      if (!groups.length || (join && join.value === "or")) groups.push([part]);
      else groups[groups.length - 1].push(part);
    });
    if (!groups.length) return null;
    var heads = groups.map(function (parts) {
      var head = parts[0];
      if (parts.length > 1) head.and = parts.slice(1);
      return head;
    });
    var first = heads[0];
    if (heads.length > 1) first.or = heads.slice(1);
    return first;
  }

  // Блоки текста, чекбоксы и группы живут на странице в одном общем порядке: оператор
  // расставляет их так, как того требует соглашение. Документ, сохранённый до появления
  // свободного порядка, номеров не имеет, и тогда порядок прежний: текст, чекбоксы, группы.
  var ORD_TAIL = 100000;
  function pageOrder(page, blocks) {
    var items = [];
    function add(list, kind) {
      (list || []).forEach(function (it, i) {
        if (!it) return;
        var ord = (typeof it.ord === "number" && it.ord >= 0) ? it.ord : ORD_TAIL + kind * ORD_TAIL + i;
        items.push({ ord: ord, kind: kind, index: i, item: it });
      });
    }
    add(blocks || page.blocks, 0);
    add(page.checkboxes, 1);
    add(page.groups, 2);
    add(page.signatures, 3);
    add(page.scans, 4);
    add(page.inputs, 5);
    items.sort(function (a, b) { return (a.ord - b.ord) || (a.kind - b.kind) || (a.index - b.index); });
    return items;
  }

  function headingRunsOf(page) { return (page.headingRuns && page.headingRuns.length) ? page.headingRuns : (page.heading ? [{ text: page.heading }] : []); }
  function blocksOf(page) { return (page.blocks && page.blocks.length) ? page.blocks : (page.body ? [{ runs: [{ text: page.body }] }] : []); }

  function scanPlaceholders() {
    var texts = [$("docTitle").value, $("signPrompt").value, runsText(state.doc.thankYouRuns || [])];
    document.querySelectorAll('#pagesEditor [data-role="heading"], #pagesEditor [data-role="blockbody"]').forEach(function (e) { texts.push(e.textContent || ""); });
    document.querySelectorAll('#pagesEditor [data-role="cblabel"]').forEach(function (i) { texts.push(i.value); });
    var re = /\{\{\s*(.+?)\s*\}\}/g, seen = [], known = {};
    texts.forEach(function (t) {
      if (!t) return; var m;
      while ((m = re.exec(t))) { var k = m[1].trim(), lk = k.toLowerCase(); if (k && !known[lk]) { known[lk] = 1; seen.push(k); } }
    });
    return seen;
  }
  // Список тегов, которые принимает API, целиком. Использованные в документе выделены.
  // Раньше здесь показывались только использованные, под заголовком «Поля для передачи по
  // API», и это читалось как ограничение: будто прислать можно только их.
  function updatePlaceholders() {
    var wrap = $("docPlaceholders"); if (!wrap) return; wrap.innerHTML = "";
    var used = scanPlaceholders();
    var usedLower = {};
    used.forEach(function (k) { usedLower[k.toLowerCase()] = 1; });

    wrap.appendChild(el("span", "ph-label", "Теги, которые принимает API (" + KNOWN_FIELDS.length + "):"));
    KNOWN_FIELDS.forEach(function (k) {
      var isUsed = !!usedLower[k.toLowerCase()];
      var tag = el("code", "ph-tag" + (isUsed ? " ph-used" : ""), "{{" + k + "}}");
      var values = fieldValues(k);
      tag.title = (isUsed ? "Используется в документе. " : "В документе не используется. ")
        + (values ? "Принимает только: " + values.join(", ") + ". " : "")
        + "Нажмите, чтобы скопировать.";
      tag.addEventListener("click", function () { copyTag(k); });
      wrap.appendChild(tag);
    });

    // Тег не из стандартного списка. Это не ошибка: API принимает любое имя, и такой тег
    // заполнится, если внешняя система пришлёт ровно такое же имя. Но выглядит он точно так
    // же, как опечатка в стандартном теге, поэтому показывается отдельно и с пояснением.
    var custom = used.filter(function (k) { return !isKnownField(k); });
    if (custom.length) {
      wrap.appendChild(el("span", "ph-label ph-label-warn", "Свои теги (не из списка выше):"));
      custom.forEach(function (k) {
        var tag = el("code", "ph-tag ph-unknown", "{{" + k + "}}");
        tag.title = "Свой тег. Он заполнится, если внешняя система пришлёт поле с точно таким же " +
          "именем: в fields можно передать любое имя, не только из списка. Если это опечатка в " +
          "стандартном теге, исправьте её здесь, иначе клиент увидит {{" + k + "}} прямо в тексте.";
        wrap.appendChild(tag);
      });
    }
  }

  function isKnownField(name) {
    var lk = String(name || "").toLowerCase();
    return KNOWN_FIELDS.some(function (k) { return k.toLowerCase() === lk; });
  }

  function copyTag(name) { copyText("{{" + name + "}}", "Скопировано: {{" + name + "}}"); }

  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(done); },
        function () { toast("Не удалось скопировать: " + text); });
    } else {
      // Старый WebView без Clipboard API: показываем значение, чтобы его можно было выделить.
      toast(text);
    }
  }

  // Сворачивание элемента страницы в одну строку. Блок с абзацем текста занимает полтора
  // сантиметра высоты, и на документе из тридцати элементов страница растягивается на девять
  // экранов, по которым невозможно ориентироваться. Свёрнутый элемент показывает начало своего
  // текста, и его видно в общем списке рядом с соседями.
  function addItemCollapse(card, summaryOf) {
    var head = card.querySelector(".drag-handle");
    if (!head || !head.parentNode) return;
    var toggle = el("button", "page-toggle item-toggle"); toggle.type = "button";
    toggle.appendChild(icon("down"));
    var summary = el("span", "item-summary");

    function sync() {
      var off = card.classList.contains("item-collapsed");
      toggle.innerHTML = ""; toggle.appendChild(icon(off ? "right" : "down"));
      toggle.title = off ? "Развернуть" : "Свернуть";
      summary.textContent = off ? summaryOf() : "";
      summary.classList.toggle("hidden", !off);
    }
    toggle.addEventListener("click", function () {
      card.classList.toggle("item-collapsed");
      sync();
    });
    card.setCollapsed = function (v) { card.classList.toggle("item-collapsed", !!v); sync(); };

    head.parentNode.insertBefore(toggle, head.nextSibling);
    head.parentNode.insertBefore(summary, toggle.nextSibling);
    sync();
  }

  /// Короткая выжимка из набора фрагментов: начало текста, чтобы элемент узнавался в списке.
  function shortRuns(runs, max) {
    var t = (runs || []).map(function (r) { return (r && r.text) || ""; }).join("").replace(/\s+/g, " ").trim();
    if (!t) return "(пусто)";
    return t.length > (max || 90) ? t.slice(0, max || 90) + "…" : t;
  }

  // Редактор таблицы. Правится прямо ячейками: переносить сюда возможности табличного
  // процессора незачем, документ это не расчёт, а текст в клетках.
  function tableEditor(t) {
    var wrap = el("div", "block-table");
    wrap.setAttribute("data-role", "blocktable");
    var данные = t && t.rows && t.rows.length
      ? t.rows.map(function (r) { return (r || []).slice(); })
      : [["", ""], ["", ""]];
    var шапкаЕсть = !t || t.headerRow !== false;
    var ширины = (t && t.widths) ? t.widths.slice() : [];

    var шапкаLabel = el("label", "check-inline");
    var шапкаCb = el("input"); шапкаCb.type = "checkbox"; шапкаCb.checked = шапкаЕсть;
    шапкаCb.setAttribute("data-role", "tblhead");
    шапкаLabel.appendChild(шапкаCb);
    шапкаLabel.appendChild(document.createTextNode(" Первая строка это шапка"));
    wrap.appendChild(шапкаLabel);

    var холст = el("div", "table-grid");
    wrap.appendChild(холст);

    function столбцов() { return данные.length ? данные[0].length : 0; }

    function собрать() {
      // Данные читаются из полей перед каждой перестройкой: иначе набранное в ячейках
      // терялось бы при добавлении строки.
      var поля = холст.querySelectorAll('[data-cell]');
      поля.forEach(function (i) {
        var rc = i.getAttribute("data-cell").split(":");
        var r = parseInt(rc[0], 10), c = parseInt(rc[1], 10);
        if (данные[r]) данные[r][c] = i.value;
      });
      var шп = холст.querySelectorAll('[data-width]');
      шп.forEach(function (i, ci) { ширины[ci] = parseInt(i.value, 10) || 0; });
    }

    function нарисовать() {
      холст.innerHTML = "";
      var cols = столбцов();
      холст.style.gridTemplateColumns = "repeat(" + cols + ", 1fr) auto";

      // Строка ширин: пусто означает поровну.
      for (var c = 0; c < cols; c++) {
        var w = el("input", "table-width"); w.type = "number"; w.min = "5"; w.max = "90";
        w.placeholder = "%"; w.setAttribute("data-width", String(c));
        if (ширины[c] > 0) w.value = ширины[c];
        w.title = "Ширина столбца в процентах. Пусто у всех означает поровну.";
        холст.appendChild(w);
      }
      холст.appendChild(el("span"));

      данные.forEach(function (row, ri) {
        row.forEach(function (cell, ci) {
          var i = el("input", "table-cell"); i.type = "text";
          i.value = cell == null ? "" : cell;
          i.setAttribute("data-cell", ri + ":" + ci);
          if (шапкаCb.checked && ri === 0) i.classList.add("table-cell-head");
          холст.appendChild(i);
        });
        var del = el("button", "btn btn-danger btn-sm", "×"); del.type = "button";
        del.title = "Убрать строку";
        del.addEventListener("click", function () {
          собрать();
          if (данные.length <= 1) return;
          данные.splice(ri, 1); нарисовать(); markDirty();
        });
        холст.appendChild(del);
      });
    }

    var кнопки = el("div", "table-actions");
    var плюсСтрока = iconBtn("plus", "Строка", "btn-ghost btn-sm");
    плюсСтрока.addEventListener("click", function () {
      собрать();
      данные.push(new Array(столбцов()).fill(""));
      нарисовать(); markDirty();
    });
    var плюсСтолбец = iconBtn("plus", "Столбец", "btn-ghost btn-sm");
    плюсСтолбец.addEventListener("click", function () {
      собрать();
      if (столбцов() >= 8) { toast("Больше восьми столбцов не читается ни на планшете, ни на бумаге", true); return; }
      данные.forEach(function (r) { r.push(""); });
      нарисовать(); markDirty();
    });
    var минусСтолбец = iconBtn("trash", "Убрать столбец", "btn-ghost btn-sm");
    минусСтолбец.addEventListener("click", function () {
      собрать();
      if (столбцов() <= 1) return;
      данные.forEach(function (r) { r.pop(); });
      ширины.pop();
      нарисовать(); markDirty();
    });
    кнопки.appendChild(плюсСтрока); кнопки.appendChild(плюсСтолбец); кнопки.appendChild(минусСтолбец);
    wrap.appendChild(кнопки);

    шапкаCb.addEventListener("change", function () { собрать(); нарисовать(); });
    // Чтение наружу: собрать текущее состояние и отдать готовую таблицу.
    wrap.__read = function () {
      собрать();
      var заданы = ширины.filter(function (w) { return w > 0; }).length === столбцов();
      return { headerRow: шапкаCb.checked, rows: данные.map(function (r) { return r.slice(); }),
        widths: заданы ? ширины.slice(0, столбцов()) : [] };
    };
    нарисовать();
    return wrap;
  }

  function blockCard(b) {
    b = b || {};
    var bc = el("div", "block-card page-item"); bc.setAttribute("data-role", "blockcard");
    bc.setAttribute("data-kind", "block");

    // Черта и разрыв страницы это не блоки с содержимым: у них нечего править, кроме условия.
    // Отдельная карточка на одну строку честнее, чем пустой редактор текста с надписью.
    if (b.kind === "divider" || b.kind === "pagebreak") {
      bc.setAttribute("data-mode", "special");
      bc.setAttribute("data-special", b.kind);
      var row = el("div", "cb-row");
      var h2 = el("span", "drag-handle"); h2.appendChild(icon("grip"));
      h2.title = "Перетащите, чтобы изменить порядок";
      row.appendChild(h2);
      row.appendChild(icon(b.kind === "divider" ? "layout" : "page", "item-icon"));
      row.appendChild(el("span", "special-name", b.kind === "divider"
        ? "Горизонтальная черта"
        : "Разрыв страницы в PDF (на планшете не виден)"));
      var c2 = conditionEditor(b.visibleWhen, "blockcond"); c2.classList.add("cond-inline"); row.appendChild(c2);
      var d2 = el("button", "btn btn-danger", "×");
      d2.addEventListener("click", function () { removeItem(bc); });
      row.appendChild(d2);
      bc.appendChild(row);
      return bc;
    }

    var isImage = !!b.imageUrl;
    var isTable = !!(b.table && b.table.rows);

    var modeBar = el("div", "block-mode");
    var handle = el("span", "drag-handle");
    handle.appendChild(icon("grip"));
    handle.title = "Перетащите, чтобы изменить порядок блоков";
    modeBar.appendChild(handle);
    var seg = el("div", "seg");
    var btnText = iconBtn("text", "Текст", "btn-sm"); btnText.type = "button";
    var btnImg = iconBtn("image", "Картинка", "btn-sm"); btnImg.type = "button";
    var btnTable = iconBtn("list", "Таблица", "btn-sm"); btnTable.type = "button";
    seg.appendChild(btnText); seg.appendChild(btnImg); seg.appendChild(btnTable);
    modeBar.appendChild(seg);
    bc.appendChild(modeBar);

    var textWrap = richEditor("", b.runs || [], "blockbody", b.align);
    bc.appendChild(textWrap);

    var imgWrap = el("div", "block-image");
    var img = el("img", "block-image-preview");
    if (b.imageUrl) { img.src = b.imageUrl; } else { img.style.display = "none"; }
    img.style.width = (b.imageWidth || 100) + "%";
    if (b.imageUrl) bc.setAttribute("data-imgurl", b.imageUrl);
    // Картинка может приходить из заказа: оператор задаёт имя тега, а на его место встаёт то,
    // что прислала внешняя система. Выбранная здесь картинка остаётся запасной и показывается,
    // когда заказ картинку не принёс.
    var тегLabel = el("label", "field-sm", "Имя тега картинки из API");
    var тег = el("input"); тег.type = "text"; тег.placeholder = "например: ПЕЧАТЬ";
    тег.value = b.imageTag || ""; тег.setAttribute("data-role", "blockimgtag");
    тег.title = "Оставьте пустым, если картинка всегда одна и та же. Заданный тег означает, что картинку пришлёт внешняя система.";
    тегLabel.appendChild(тег);

    var pick = el("button", "btn btn-ghost btn-sm", "Выбрать картинку"); pick.type = "button";
    pick.addEventListener("click", function () {
      openImagePicker(function (url) { img.src = url; img.style.display = ""; bc.setAttribute("data-imgurl", url); });
    });
    var wLabel = el("label", "field-sm", "Ширина, %");
    var wRange = el("input"); wRange.type = "range"; wRange.min = "10"; wRange.max = "100"; wRange.step = "5";
    wRange.value = b.imageWidth || 100; wRange.setAttribute("data-role", "blockimgw");
    var wVal = el("span", "img-wval", wRange.value + "%");
    wRange.addEventListener("input", function () { wVal.textContent = wRange.value + "%"; img.style.width = wRange.value + "%"; });
    wLabel.appendChild(wRange); wLabel.appendChild(wVal);
    imgWrap.appendChild(img); imgWrap.appendChild(pick); imgWrap.appendChild(тегLabel); imgWrap.appendChild(wLabel);

    // Обтекание: картинка встаёт сбоку, а текст следующих абзацев идёт рядом с ней. Пункты,
    // группы и подпись рядом не встают: они и так узкие, а рядом с картинкой превратились бы
    // в обрывки. Зазор задаётся отдельно, потому что вплотную к тексту читается плохо.
    var обтLabel = el("label", "field-sm", "Обтекание текстом");
    var обтSel = el("select"); обтSel.setAttribute("data-role", "blockwrap");
    [["", "нет, картинка отдельной строкой"], ["left", "картинка слева, текст справа"],
     ["right", "картинка справа, текст слева"]].forEach(function (o) {
      обтSel.appendChild(new Option(o[1], o[0]));
    });
    обтSel.value = (b.wrap || "");
    обтLabel.appendChild(обтSel);
    imgWrap.appendChild(обтLabel);

    var зазорLabel = el("label", "field-sm", "Отступ от текста, точек");
    var зазор = el("input"); зазор.type = "number"; зазор.min = "0"; зазор.max = "60";
    зазор.value = b.wrapGap != null ? b.wrapGap : 10;
    зазор.setAttribute("data-role", "blockwrapgap");
    зазорLabel.appendChild(зазор);
    imgWrap.appendChild(зазорLabel);

    function обтекание() {
      var есть = обтSel.value === "left" || обтSel.value === "right";
      зазорLabel.style.display = есть ? "" : "none";
      // Картинка во всю ширину обтекать не может: текста рядом с ней не поместится.
      wRange.max = есть ? "70" : "100";
      if (есть && parseInt(wRange.value, 10) > 70) {
        wRange.value = "70"; wVal.textContent = "70%"; img.style.width = "70%";
      }
    }
    обтSel.addEventListener("change", обтекание);
    обтекание();
    bc.appendChild(imgWrap);

    // Редактор таблицы строится только тогда, когда блок действительно становится таблицей.
    // Держать его скрытым в каждом текстовом блоке значило бы носить в разметке по лишнему
    // редактору на блок: и память, и путаница при поиске элементов.
    var tableHost = el("div", "block-table-host");
    bc.appendChild(tableHost);
    var tableWrap = null;
    function таблицаНужна() {
      if (!tableWrap) { tableWrap = tableEditor(b.table); tableHost.appendChild(tableWrap); }
      return tableWrap;
    }

    // Оформление блока: плашка, рамка, отступ, межстрочный, список. Одна панель на всё, как и
    // у остального оформления: пятнадцать отдельных полей когда-то уже пробовали.
    var стиль = el("div", "block-style");
    var спLabel = el("label", "field-sm", "Список");
    var сп = el("select"); сп.setAttribute("data-role", "blocklistmode");
    [["", "нет"], ["bullet", "маркированный"], ["number", "нумерованный"]]
      .forEach(function (o) { сп.appendChild(new Option(o[1], o[0])); });
    сп.value = b.list || "";
    сп.title = "Каждая строка блока станет пунктом списка";
    спLabel.appendChild(сп); стиль.appendChild(спLabel);

    var фонLabel = el("label", "field-sm", "Фон");
    var фон = el("input"); фон.type = "color"; фон.setAttribute("data-role", "blockbg");
    фон.value = b.bg || "#ffffff";
    var фонВкл = el("input"); фонВкл.type = "checkbox"; фонВкл.setAttribute("data-role", "blockbgon");
    фонВкл.checked = !!b.bg;
    фонВкл.title = "Залить блок плашкой";
    фонLabel.appendChild(фонВкл); фонLabel.appendChild(фон); стиль.appendChild(фонLabel);

    var рамLabel = el("label", "field-sm", "Рамка");
    var рам = el("input"); рам.type = "color"; рам.setAttribute("data-role", "blockborder");
    рам.value = b.borderColor || "#94a3b8";
    var рамВкл = el("input"); рамВкл.type = "checkbox"; рамВкл.setAttribute("data-role", "blockborderon");
    рамВкл.checked = !!b.borderColor;
    рамLabel.appendChild(рамВкл); рамLabel.appendChild(рам); стиль.appendChild(рамLabel);

    var отсLabel = el("label", "field-sm", "Отступ, точек");
    var отс = el("input"); отс.type = "number"; отс.min = "0"; отс.max = "40";
    отс.value = b.pad || 0; отс.setAttribute("data-role", "blockpad");
    отсLabel.appendChild(отс); стиль.appendChild(отсLabel);

    var межLabel = el("label", "field-sm", "Межстрочный, %");
    var меж = el("input"); меж.type = "number"; меж.min = "100"; меж.max = "250"; меж.step = "10";
    меж.value = b.lineHeight || ""; меж.placeholder = "обычный";
    меж.setAttribute("data-role", "blocklh");
    межLabel.appendChild(меж); стиль.appendChild(межLabel);
    bc.appendChild(стиль);

    function setMode(m) {
      bc.setAttribute("data-mode", m);
      textWrap.style.display = m === "text" ? "" : "none";
      imgWrap.style.display = m === "image" ? "" : "none";
      if (m === "table") таблицаНужна();
      tableHost.style.display = m === "table" ? "" : "none";
      // Список это про текст, а плашка про всё, кроме картинки: у картинки она рисовала бы
      // пустую коробку вокруг снимка.
      спLabel.style.display = m === "text" ? "" : "none";
      стиль.style.display = m === "image" ? "none" : "";
      btnText.classList.toggle("mode-on", m === "text");
      btnImg.classList.toggle("mode-on", m === "image");
      btnTable.classList.toggle("mode-on", m === "table");
    }
    btnText.addEventListener("click", function () { setMode("text"); });
    btnImg.addEventListener("click", function () { setMode("image"); });
    btnTable.addEventListener("click", function () { setMode("table"); });
    setMode(isTable ? "table" : isImage ? "image" : "text");

    // Признак «в PDF» у блока. Ограничений тут нет: текст, картинка и таблица сами по себе
    // ничего не подтверждают, поэтому исключить можно любой блок.
    var вPdfБлок = el("label", "check-inline pdf-flag");
    var вPdfБлокCb = el("input"); вPdfБлокCb.type = "checkbox";
    вPdfБлокCb.checked = b.inPdf !== false;
    вPdfБлокCb.setAttribute("data-role", "blockinpdf");
    вPdfБлок.title = "Снимите, если этот блок нужен только на экране. В записи он останется, в PDF не попадёт.";
    вPdfБлок.appendChild(вPdfБлокCb);
    вPdfБлок.appendChild(document.createTextNode(" Сохранять в PDF"));
    bc.appendChild(вPdfБлок);

    bc.appendChild(el("div", "sub-label", "Условие показа блока"));
    bc.appendChild(conditionEditor(b.visibleWhen, "blockcond"));
    var del = iconBtn("trash", "Удалить блок", "btn-danger btn-sm");
    del.addEventListener("click", function () { removeItem(bc); });
    bc.appendChild(del);
    addItemCollapse(bc, function () {
      if (bc.getAttribute("data-mode") === "image") return "картинка";
      var ed = bc.querySelector('[data-role="blockbody"]');
      return shortRuns(ed ? editorToRuns(ed) : []);
    });
    return bc;
  }

  // Один блок текста или картинки. Возвращает null, если в нём нечего сохранять.
  function readBlockCard(bc) {
    var cond = readCondition(bc.querySelector('[data-role="blockcond"]'));
    var вPdf = (bc.querySelector('[data-role="blockinpdf"]') || {}).checked !== false;
    // Признак дописывается тому, что вернёт разбор ниже: он одинаков для всех видов блока, а
    // видов у него три, и повторять присвоение в каждой ветке значит однажды забыть в одной.
    function сПризнаком(блок) {
      if (блок && !вPdf) блок.inPdf = false;
      return блок;
    }
    var режим = bc.getAttribute("data-mode");

    // Черта и разрыв: у них нет содержимого, только вид и условие.
    if (режим === "special") {
      var спец = { kind: bc.getAttribute("data-special") || "divider" };
      if (cond) спец.visibleWhen = cond;
      return сПризнаком(спец);
    }

    // Оформление блока. Считается один раз и приклеивается к любому виду, кроме картинки.
    function оформление(blk) {
      var фонВкл = bc.querySelector('[data-role="blockbgon"]');
      var фон = bc.querySelector('[data-role="blockbg"]');
      if (фонВкл && фонВкл.checked && фон) blk.bg = фон.value;
      var рамВкл = bc.querySelector('[data-role="blockborderon"]');
      var рам = bc.querySelector('[data-role="blockborder"]');
      if (рамВкл && рамВкл.checked && рам) blk.borderColor = рам.value;
      var отс = parseInt((bc.querySelector('[data-role="blockpad"]') || {}).value, 10);
      if (отс > 0) blk.pad = отс;
      var меж = parseInt((bc.querySelector('[data-role="blocklh"]') || {}).value, 10);
      if (меж >= 100) blk.lineHeight = меж;
      return сПризнаком(blk);
    }

    if (режим === "table") {
      var tw = bc.querySelector('[data-role="blocktable"]');
      var t = tw && tw.__read ? tw.__read() : null;
      // Совсем пустая таблица не хранится: это заготовка, а не содержимое.
      if (!t || !t.rows.length || t.rows.every(function (r) { return r.every(function (c) { return !String(c || "").trim(); }); })) {
        if (!cond) { выброшеноПустых++; return null; }
        t = null;
      }
      var blkT = оформление({ table: t });
      if (cond) blkT.visibleWhen = cond;
      return сПризнаком(blkT.table ? blkT : null);
    }

    if (режим === "image") {
      var url = bc.getAttribute("data-imgurl");
      var имяТега = ((bc.querySelector('[data-role="blockimgtag"]') || {}).value || "").trim();
      // Блок с тегом живёт и без выбранной картинки: её пришлёт внешняя система.
      if (!url && !имяТега) { выброшеноПустых++; return null; }
      var w = parseInt((bc.querySelector('[data-role="blockimgw"]') || {}).value, 10) || 100;
      var blk = { imageUrl: url || null, imageWidth: w };
      if (имяТега) blk.imageTag = имяТега;
      var обт = (bc.querySelector('[data-role="blockwrap"]') || {}).value || "";
      if (обт === "left" || обт === "right") {
        blk.wrap = обт;
        blk.wrapGap = parseInt((bc.querySelector('[data-role="blockwrapgap"]') || {}).value, 10);
        if (!(blk.wrapGap >= 0)) blk.wrapGap = 10;
      }
      // Картинку тоже можно выровнять: печать или герб обычно стоят по центру или у правого
      // края. Выравнивание берётся из того же поля, что и у текста этого блока.
      var ia = alignOf(bc.querySelector('[data-role="blockbody"]'));
      if (ia) blk.align = ia;
      if (cond) blk.visibleWhen = cond; return сПризнаком(blk);
    }
    var ed = bc.querySelector('[data-role="blockbody"]');
    var runs = ed ? editorToRuns(ed) : [];
    var hasText = runs.some(function (r) { return (r.text || "").trim().length; });
    if (!hasText && !cond) { выброшеноПустых++; return null; }
    var blk2 = оформление({ runs: runs });
    var сп = (bc.querySelector('[data-role="blocklistmode"]') || {}).value || "";
    if (сп === "bullet" || сп === "number") blk2.list = сп;
    var al = alignOf(ed); if (al) blk2.align = al;
    if (cond) blk2.visibleWhen = cond; return сПризнаком(blk2);
  }

  function readCheckboxRow(r) {
    var ed = r.querySelector('[data-role="cblabel"]');
    var runs = ed ? editorToRuns(ed) : [];
    var lab = runsText(runs);
    // Как и у групп: совсем пустая заготовка выбрасывается со счётом, а недоделанная, где уже
    // есть имя или условие, остаётся, и о недостающем тексте скажет проверка документа.
    if (!lab.trim()) {
      var естьИмя = ((r.querySelector('[data-role="cbkey"]') || {}).value || "").trim();
      var естьУсловие = readCondition(r.querySelector('[data-role="cbcond"]'));
      if (!естьИмя && !естьУсловие) { выброшеноПустых++; return null; }
    }
    var item = {
      key: ((r.querySelector('[data-role="cbkey"]') || {}).value || "").trim(),
      label: lab,
      labelRuns: runs,
      required: r.querySelector('[data-role="cbreq"]').checked,
      checked: !!(r.querySelector('[data-role="cbchecked"]') || {}).checked
    };
    var cond = readCondition(r.querySelector('[data-role="cbcond"]'));
    if (cond) item.visibleWhen = cond;
    return item;
  }

  function readGroupRow(r) {
    var options = [], used = [], выбран = "";
    r.querySelectorAll('[data-role="optrow"]').forEach(function (o, i) {
      var okey = (o.querySelector('[data-role="okey"]').value || "").trim();
      var oruns = editorToRuns(o.querySelector('[data-role="olabel"]'));
      var olabel = runsText(oruns);
      // Вариант с текстом, но без имени, раньше молча пропадал, и проверка потом сообщала, что
      // вариантов нет, хотя оператор видел их на экране. Теперь имя достраивается здесь же.
      if (!okey && olabel.trim()) okey = uniqueKey(slugKey(olabel) || ("opt" + (i + 1)), used);
      if (!okey) return;
      used.push(okey);
      options.push({ key: okey, label: olabel, labelRuns: oruns });
      var def = o.querySelector('[data-role="odefault"]');
      if (def && def.checked) выбран = okey;
    });
    var gkey = (r.querySelector('[data-role="gkey"]').value || "").trim();
    var truns = editorToRuns(r.querySelector('[data-role="gtitle"]'));
    var gtitle = runsText(truns);
    // То же самое для имени самой группы: заголовок есть, значит группа нужна.
    if (!gkey && gtitle.trim()) gkey = slugKey(gtitle);
    // Совсем пустую заготовку выбрасываем, а недоделанную оставляем: молча стирать работу
    // оператора нельзя, о недостающем имени и вариантах ему скажет проверка документа.
    if (!gkey && !options.length && !gtitle.trim()) { выброшеноПустых++; return null; }
    var grp = { key: gkey, title: gtitle, titleRuns: truns,
      required: r.querySelector('[data-role="greq"]').checked, options: options };
    if (выбран) grp.selected = выбран;
    var gcond = readCondition(r.querySelector('[data-role="gcond"]'));
    if (gcond) grp.visibleWhen = gcond;
    return grp;
  }

  function collectBlocks(container) {
    var out = [];
    if (!container) return out;
    container.querySelectorAll('[data-role="blockcard"]').forEach(function (bc) {
      var blk = readBlockCard(bc);
      // Номер по месту в списке: без него блок уходил без порядка, и выгруженный файл не
      // совпадал с сохранённым документом.
      if (blk) { blk.ord = out.length; out.push(blk); }
    });
    return out;
  }

  // Image picker: choose an uploaded image or upload a new one.
  function openImagePicker(onPick) {
    var c = el("div");
    c.appendChild(el("h3", null, "Выберите картинку"));
    var grid = el("div", "img-picker-grid");
    function refresh() {
      grid.innerHTML = "";
      // Only formats that can also be embedded in the signed PDF: a GIF or WEBP would be visible
      // to the signer and missing from the archived document.
      (state.images || []).forEach(function (im) {
        if (!im.url || !/\.(png|jpe?g|bmp)$/i.test(im.url)) return;
        var cell = el("button", "img-picker-cell"); cell.type = "button";
        var t = el("img"); t.src = im.url; cell.appendChild(t);
        cell.addEventListener("click", function () { onPick(im.url); closeModal(); });
        grid.appendChild(cell);
      });
      if (!grid.children.length)
        grid.appendChild(el("p", "sig-meta", "Подходящих картинок нет. Для документа годятся PNG, JPG и BMP - их можно вложить в PDF. Загрузите файл ниже."));
    }
    refresh();
    c.appendChild(grid);
    var upLabel = el("label", "field", "Загрузить новую картинку");
    var up = el("input"); up.type = "file"; up.accept = "image/*";
    up.addEventListener("change", function () {
      if (!up.files || !up.files[0]) return;
      var fd = new FormData(); fd.append("file", up.files[0]);
      fetch("/api/admin/images", { method: "POST", credentials: "same-origin", body: fd })
        .then(function (r) { return r.json(); })
        .then(function () { return loadImages(); })
        .then(function () { refresh(); toast("Картинка загружена"); })
        .catch(function () { toast("Не удалось загрузить"); });
    });
    upLabel.appendChild(up); c.appendChild(upLabel);
    openModal(c);
  }
  // ---------- Проверка документа ----------
  // Ошибки такого рода иначе выясняются на планшете перед клиентом: условие ссылается на
  // несуществующий чекбокс, у группы нет имени, тег написан с опечаткой. Всё это видно
  // заранее, если посмотреть.
  function validateDoc() {
    var problems = [];
    var pages = state.doc.pages || [];
    var keys = docKeys();
    var known = keys.checks.concat(Object.keys(keys.groups));
    var seenKeys = {};

    function checkCondition(cond, where) {
      // Условие может состоять из нескольких частей и нескольких наборов: проверять надо каждую,
      // иначе ошибка во второй осталась бы незамеченной до показа клиенту.
      var n = 0;
      condGroups(cond).forEach(function (group) {
        condParts(group).forEach(function (part) {
          n++;
          checkOnePart(part, n === 1 ? where : where + ", условие " + n);
        });
      });
    }

    function checkOnePart(cond, where) {
      if (!cond || !cond.field) return;
      var f = cond.field;
      var isTag = KNOWN_FIELDS.some(function (k) { return k.toLowerCase() === f.toLowerCase(); });
      var isKey = known.some(function (k) { return k === f; });
      if (!isTag && !isKey)
        problems.push({ level: "warn", text: where + ": условие ссылается на «" + f + "». Такого имени нет ни среди стандартных тегов, ни среди чекбоксов документа. Это сработает, только если внешняя система пришлёт поле с точно таким именем; иначе блок не покажется никогда." });
      if (cond.op !== "empty" && cond.op !== "notempty" && !String(cond.value || "").trim())
        problems.push({ level: "error", text: where + ": в условии не задано значение." });
      if (isDaysOp(cond.op)) {
        var окно = String(cond.value || "").split("/");
        var плохо = окно.length > 2 || окно.some(function (x) {
          var n = parseInt(x, 10);
          return !(n >= 0 && n <= 3650);
        });
        if (плохо)
          problems.push({ level: "error", text: where + ": в условии по сроку нужно число дней, а стоит «" + cond.value + "»." });
        if (isKey)
          problems.push({ level: "error", text: where + ": срок считается по дате, а «" + f + "» это чекбокс документа, а не дата." });
      }
      if (isAgeOp(cond.op)) {
        var лет = parseInt(cond.value, 10);
        if (!(лет >= 0 && лет <= 130))
          problems.push({ level: "error", text: where + ": в условии по возрасту нужно число лет, а стоит «" + cond.value + "»." });
        if (isKey)
          problems.push({ level: "error", text: where + ": возраст считается по дате рождения, а «" + f + "» это чекбокс документа, а не дата." });
        else if (!/^(ДР|дата рождения|birth|dob)$/i.test(f))
          problems.push({ level: "warn", text: where + ": возраст считается по «" + f + "». Убедитесь, что в этом теге приходит дата рождения, например 01.01.1990." });
      }
      if (isKey && keys.groups[f] && cond.op !== "empty" && cond.op !== "notempty") {
        var opts = keys.groups[f];
        if (opts.length && opts.indexOf(cond.value) < 0)
          problems.push({ level: "warn", text: where + ": в условии значение «" + cond.value + "», а у «" + f + "» есть только " + opts.join(", ") + "." });
      }
    }

    function noteKey(key, where) {
      if (!key) return;
      if (seenKeys[key]) problems.push({ level: "error", text: where + ": имя «" + key + "» уже занято (" + seenKeys[key] + ")." });
      else seenKeys[key] = where;
    }

    if (!pages.length) problems.push({ level: "error", text: "В документе нет ни одной страницы." });

    pages.forEach(function (page, pi) {
      var where = "Страница " + (pi + 1);
      checkCondition(page.visibleWhen, where);
      var blocks = blocksOf(page) || [];
      var empty = blocks.filter(function (b) { return !b.imageUrl && !runsText(b.runs).trim(); }).length;
      if (empty) problems.push({ level: "warn", text: where + ": пустых блоков без текста и без картинки: " + empty + "." });
      blocks.forEach(function (b, bi) { checkCondition(b.visibleWhen, where + ", блок " + (bi + 1)); });

      (page.checkboxes || []).forEach(function (cb, ci) {
        var w = where + ", чекбокс " + (ci + 1);
        if (!String(cb.label || "").trim()) problems.push({ level: "error", text: w + ": нет текста, на планшете он будет пустой строкой." });
        noteKey(cb.key, w);
        checkCondition(cb.visibleWhen, w);
      });

      (page.groups || []).forEach(function (g, gi) {
        var w = where + ", зависимые чекбоксы " + (gi + 1);
        if (!String(g.key || "").trim()) problems.push({ level: "error", text: w + ": нет имени для API, задать выбор извне будет нельзя." });
        noteKey(g.key, w);
        var opts = g.options || [];
        if (opts.length < 2) problems.push({ level: "error", text: w + ": нужно хотя бы два варианта, иначе выбирать не из чего." });
        opts.forEach(function (o, oi) {
          if (!String(o.key || "").trim()) problems.push({ level: "error", text: w + ", вариант " + (oi + 1) + ": нет имени для API, он не сохранится." });
          if (!String(o.label || "").trim()) problems.push({ level: "warn", text: w + ", вариант " + (oi + 1) + ": нет текста, клиент увидит имя для API." });
        });
        checkCondition(g.visibleWhen, w);
      });

      // Поля подписи и сканирования живут в том же пространстве имён, что чекбоксы и группы:
      // по API одно имя должно означать одно. Раньше их имена не проверялись вовсе, и совпадение
      // всплывало только на живом клиенте.
      (page.signatures || []).forEach(function (sg, si) {
        var w = where + ", поле подписи " + (si + 1);
        noteKey(sg.key, w);
        checkCondition(sg.visibleWhen, w);
        if (!String(sg.label || "").trim())
          problems.push({ level: "warn", text: w + ": нет подписи над полем, клиент не поймёт, что именно подписывает." });
      });
      (page.scans || []).forEach(function (sc, si) {
        var w = where + ", сканирование " + (si + 1);
        noteKey(sc.key, w);
        checkCondition(sc.visibleWhen, w);
        if (!String(sc.label || "").trim())
          problems.push({ level: "warn", text: w + ": нет подписи над полем, клиент не поймёт, что подносить к камере." });
      });

      var экран = (page.kind || "").toLowerCase();
      var пусто = !blocks.length && !(page.checkboxes || []).length && !(page.groups || []).length && !page.includeDynamic;
      // На экране подписи и сканирования своё поле и есть содержимое: пустым такой экран не
      // считается, иначе проверка ругалась бы на каждый из них.
      if (пусто && !экран)
        problems.push({ level: "error", text: where + ": на странице ничего нет. Клиент увидит пустой экран с кнопкой «Далее»." });
    });

    (state.doc.signBlocks || []).concat(state.doc.signBlocksBelow || []).forEach(function (b, i) {
      checkCondition(b.visibleWhen, "Страница подписи, блок " + (i + 1));
    });

    // Свой тег это не ошибка: в fields можно прислать любое имя. Но незаполненный тег
    // остаётся в тексте как {{вот так}} и виден клиенту, поэтому о нём стоит сказать.
    scanPlaceholders().forEach(function (t) {
      var isTag = KNOWN_FIELDS.some(function (k) { return k.toLowerCase() === t.toLowerCase(); });
      if (!isTag) problems.push({ level: "warn", text: "Тег {{" + t + "}} не из стандартного списка. Так можно: внешняя система вправе прислать любое имя, и он заполнится. Но если это опечатка, клиент увидит {{" + t + "}} прямо в тексте." });
    });

    return problems;
  }

  /// Показать список замечаний. onProceed вызывается, если оператор решил продолжить.
  function showProblems(problems, onProceed) {
    var c = el("div", "problems");
    var errors = problems.filter(function (p) { return p.level === "error"; });
    c.appendChild(el("h3", null, errors.length ? "Документ можно отправить, но есть ошибки" : "Замечания к документу"));
    c.appendChild(el("p", "sig-meta", errors.length
      ? "Красное почти наверняка сломает сценарий у клиента. Серое стоит просто проверить."
      : "Ничего критичного, но стоит проверить."));
    var list = el("div", "problem-list");
    problems.forEach(function (p) {
      list.appendChild(el("div", "problem " + (p.level === "error" ? "problem-error" : "problem-warn"), p.text));
    });
    c.appendChild(list);
    var row = el("div", "toolbar-actions");
    var back = iconBtn("back", "Вернуться и исправить", "btn-ghost");
    back.addEventListener("click", closeModal);
    var go = el("button", "btn btn-primary", "Всё равно продолжить");
    go.addEventListener("click", function () { closeModal(); onProceed(); });
    row.appendChild(back); row.appendChild(go);
    c.appendChild(row);
    openModal(c);
  }

  // Строки условий, где тег не выбран. Их не видно в собранном документе: readRow такую строку
  // выбрасывает, поэтому искать их надо в самом редакторе.
  function незаполненныеУсловия() {
    var n = 0;
    document.querySelectorAll('[data-panel="document"] [data-role="crow"]').forEach(function (row) {
      // Строки выключенного условия остаются в разметке, но в документ не идут и потеряться
      // не могут: считать надо только те, где показ действительно задан условием.
      var box = row.closest(".cond-box") || row.parentNode;
      var mode = box && box.querySelector ? box.querySelector(".cond-mode") : null;
      if (!mode || mode.value !== "cond") return;
      var sel = row.querySelector('[data-role="cfieldsel"]');
      var other = row.querySelector('[data-role="cfield"]');
      var field = (sel && sel.value && sel.value !== OTHER_OPTION ? sel.value : (other ? other.value : "")).trim();
      if (!field) n++;
    });
    return n;
  }

  $("checkDoc").addEventListener("click", function () {
    collectDoc();
    var problems = validateDoc();
    var пустых = незаполненныеУсловия();
    if (пустых) problems.unshift({ level: "error", text: "Условий без выбранного тега: " + пустых +
      ". Такое условие не сохраняется: блок будет показан всем. Выберите тег или уберите условие." });
    if (!problems.length) { toast("Замечаний нет."); return; }
    showProblems(problems, function () { /* просто закрыть */ });
  });

  // ---------- Перетаскивание ----------
  // Порядок элементов собирается из DOM, поэтому переставить узлы достаточно: модель менять не
  // нужно. Перетаскивание включается только по ручке, иначе браузер начинал бы тащить блок при
  // попытке выделить текст в редакторе внутри него.
  function makeSortable(list, itemSelector) {
    if (!list || list.dataset.sortable) return;
    list.dataset.sortable = "1";

    var item = null, moved = false;

    // Список, над которым сейчас курсор. Для элементов страницы это может быть другая страница:
    // перенести пункт со страницы 4 на страницу 2 иначе можно было только удалив и набрав
    // заново. Для самих страниц список всегда один.
    function listUnder(x, y) {
      if (list.getAttribute("data-role") !== "itemlist") return list;
      var under = document.elementFromPoint(x, y);
      var other = under && under.closest ? under.closest('[data-role="itemlist"]') : null;
      return other || list;
    }

    // Положение элемента по координатам курсора. Вынесено отдельно, потому что пересчитывать
    // его надо и при движении мыши, и при автопрокрутке: когда страница едет сама, курсор стоит
    // на месте, событий движения нет, и без пересчёта элемент оставался бы там, где был.
    var lastX = 0, lastY = 0;
    function placeAt(x, y) {
      if (!item) return;
      var target = listUnder(x, y);
      var others = Array.prototype.slice.call(target.children).filter(function (n) {
        return n !== item && n.matches && n.matches(itemSelector);
      });
      var before = null;
      // Первый сосед, чья середина ниже курсора: перед ним и встаём.
      for (var i = 0; i < others.length; i++) {
        var r = others[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = others[i]; break; }
      }
      if (before) { if (item.nextSibling !== before) target.insertBefore(item, before); }
      else if (target.lastElementChild !== item) target.appendChild(item);
    }

    // Автопрокрутка у края окна. Без неё перенести пункт со страницы 1 на страницу 4 нельзя
    // физически: обе страницы одновременно на экран не помещаются, а курсор за окно не выходит.
    var edgeTimer = null;
    function edgeScroll(y) {
      var зона = 90, шаг = 0;
      if (y < зона) шаг = -Math.ceil((зона - y) / 4);
      else if (y > window.innerHeight - зона) шаг = Math.ceil((y - (window.innerHeight - зона)) / 4);
      if (!шаг) { stopEdge(); return; }
      if (edgeTimer) return;
      edgeTimer = setInterval(function () {
        if (!item) { stopEdge(); return; }
        var было = window.scrollY;
        window.scrollBy(0, шаг);
        if (window.scrollY === было) { stopEdge(); return; }   // дальше ехать некуда
        placeAt(lastX, lastY);
      }, 16);
    }
    function stopEdge() { if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; } }

    function onMove(e) {
      if (!item) return;
      moved = true;
      lastX = e.clientX; lastY = e.clientY;
      edgeScroll(lastY);
      placeAt(lastX, lastY);
      e.preventDefault();
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      document.body.classList.remove("dragging-now");
      stopEdge();
      if (!item) return;
      item.classList.remove("dragging");
      var wasMoved = moved;
      var landed = item.parentNode;
      item = null; moved = false;
      if (!wasMoved) return;
      // Порядок изменился: перечитываем документ из DOM. Для страниц ещё и перерисовываем,
      // иначе номера страниц и оглавление разойдутся с тем, что на экране.
      if (list === $("pagesEditor")) { collectDoc(); collapsedPages = {}; renderPages(); }
      else if (list.getAttribute("data-role") === "itemlist") {
        // Полосы вставки пересобираются в обоих списках: и там, откуда унесли, и там, куда
        // положили, иначе в одном из них полосы окажутся подряд.
        normalizeBars(list);
        if (landed && landed !== list && landed.getAttribute("data-role") === "itemlist") normalizeBars(landed);
      }
      updatePlaceholders();
    }

    list.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      var handle = e.target.closest && e.target.closest(".drag-handle");
      if (!handle || !list.contains(handle)) return;
      var target = handle.closest(itemSelector);
      // Ручка вложенного списка не должна тащить внешний элемент.
      if (!target || target.parentNode !== list) return;
      item = target; moved = false;
      item.classList.add("dragging");
      document.body.classList.add("dragging-now");
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      // Иначе браузер начнёт выделять текст соседних блоков вместо перетаскивания.
      e.preventDefault();
    });
  }

  // После перетаскивания полосы вставки оказываются не там, где нужно: расставляем заново,
  // по одной перед списком и после каждого элемента.
  // Удаление элемента страницы. Полосы вставки стоят между элементами, поэтому после удаления
  // две соседние полосы оказываются подряд и выглядят как ошибка. Пересобираем их сразу.
  function removeItem(node) {
    var list = node.closest('[data-role="itemlist"]');
    node.remove();
    if (list) normalizeBars(list);
    updatePlaceholders();
  }

  function normalizeBars(list) {
    Array.prototype.slice.call(list.querySelectorAll(":scope > .insert-bar")).forEach(function (b) { b.remove(); });
    var nodes = Array.prototype.slice.call(list.children).filter(function (n) { return n.classList.contains("page-item"); });
    list.insertBefore(insertBar(list, null), list.firstChild);
    nodes.forEach(function (n) { list.insertBefore(insertBar(list, n), n.nextSibling); });
  }

  // Прокрутка к странице с поправкой на закреплённую шапку. Обычный scrollIntoView ставит
  // карточку вплотную к верху окна, а шапка её закрывает, и первой видимой оказывается уже
  // следующая страница: нажимаешь «2», а на экране «3». Высота шапки считается на месте,
  // потому что при узком окне вкладки переносятся на вторую строку.
  function scrollToCard(card) {
    if (!card) return;
    var bar = document.querySelector(".topbar");
    var offset = (bar ? bar.offsetHeight : 0) + 12;
    var top = card.getBoundingClientRect().top + window.pageYOffset - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  // Полоса вставки между элементами страницы. Нужна потому, что дотащить новый пункт из конца
  // длинной страницы на нужное место мышью тяжело: проще поставить его сразу туда, где он нужен.
  // Полоса видна всегда, а не только при наведении: иначе о ней просто не догадаться.
  function insertBar(list, afterNode, pageKind) {
    var bar = el("div", "insert-bar");
    var chip = el("button", "insert-chip"); chip.type = "button";
    chip.appendChild(icon("plus"));
    chip.appendChild(el("span", null, "вставить сюда"));
    bar.appendChild(chip);

    function place(node) {
      if (afterNode && afterNode.parentNode === list) list.insertBefore(node, bar);
      else list.insertBefore(node, list.firstChild === bar ? bar.nextSibling : bar);
      list.insertBefore(insertBar(list, node), node.nextSibling);
      collapse();
      updatePlaceholders();
    }

    function collapse() { bar.innerHTML = ""; bar.appendChild(chip); bar.classList.remove("open"); }

    chip.addEventListener("click", function () {
      bar.innerHTML = ""; bar.classList.add("open");
      // На обычной странице подпись и сканирование можно поставить блоком, рядом с тем текстом,
      // к которому они относятся. На экране подписи или сканирования своё поле уже есть, и
      // добавлять туда второе незачем: там клиент занят одним делом.
      var opts = [["Блок текста", function () { place(blockCard({ runs: [] })); }]];
      if (!pageKind) opts = opts.concat([
        ["Чекбокс", function () { place(checkboxRow({ label: "", required: true })); }],
        ["Двойные зависимые чекбоксы", function () { place(groupCard({ options: [{ key: "", label: "" }, { key: "", label: "" }] })); }],
        ["Поле подписи", function () { place(signatureRow({ label: "", required: true })); }],
        ["Сканирование кода", function () { place(scanRow({ label: "", required: true })); }],
        ["Поле ввода", function () { place(inputRow({ label: "", required: true, type: "text" })); }],
        ["Таблица", function () { place(blockCard({ table: { headerRow: true, rows: [["", ""], ["", ""]] } })); }],
        ["Горизонтальная черта", function () { place(blockCard({ kind: "divider" })); }],
        ["Разрыв страницы в PDF", function () { place(blockCard({ kind: "pagebreak" })); }]
      ]);
      opts.forEach(function (o) {
        var b = iconBtn("plus", o[0], "btn-sm");
        b.addEventListener("click", o[1]);
        bar.appendChild(b);
      });
      var cancel = iconBtn("x", "Отмена", "btn-ghost btn-sm");
      cancel.addEventListener("click", collapse);
      bar.appendChild(cancel);
    });
    return bar;
  }

  // ---------- Оглавление ----------
  function pageSummary(page) {
    var parts = [];
    var heading = runsText(headingRunsOf(page)).trim();
    if (heading) parts.push("«" + (heading.length > 40 ? heading.slice(0, 40) + "..." : heading) + "»");
    var nb = (blocksOf(page) || []).length;
    var nc = (page.checkboxes || []).length;
    var ng = (page.groups || []).length;
    if (nb) parts.push("блоков: " + nb);
    if (nc) parts.push("чекбоксов: " + nc);
    if (ng) parts.push("зависимых: " + ng);
    if (page.visibleWhen && page.visibleWhen.field) parts.push("по условию");
    return parts.join("   ·   ") || "пустая страница";
  }

  function runsText(runs) {
    return (runs || []).map(function (r) { return r && r.text ? r.text : ""; }).join("");
  }

  function renderToc() {
    var toc = $("docToc");
    if (!toc) return;
    toc.innerHTML = "";
    var pages = state.doc.pages || [];

    var head = el("div", "toc-title");
    head.appendChild(icon("layout"));
    head.appendChild(el("span", null, "Страницы"));
    toc.appendChild(head);

    // Добавить страницу можно прямо отсюда: оглавление всегда на виду, а единственная кнопка
    // внизу списка означала бы прокрутку через весь документ каждый раз.
    var addTop = iconBtn("plus", "Добавить страницу", "btn-primary btn-sm toc-add");
    addTop.addEventListener("click", function () { openPageKinds(addTop); });
    toc.appendChild(addTop);

    var list = el("div", "toc-list");
    pages.forEach(function (page, pi) {
      var heading = runsText(headingRunsOf(page)).trim();
      var item = el("button", "toc-item" + (collapsedPages[pi] ? " folded" : ""));
      item.type = "button";
      item.appendChild(el("span", "toc-num", String(pi + 1)));
      item.appendChild(el("span", "toc-text", heading || "без заголовка"));
      if (page.visibleWhen && page.visibleWhen.field) item.appendChild(icon("filter", "toc-mark"));
      item.title = pageSummary(page);
      item.addEventListener("click", function () {
        var cards = document.querySelectorAll('#pagesEditor [data-role="pagecard"]');
        scrollToCard(cards[pi]);
      });
      list.appendChild(item);
    });
    toc.appendChild(list);

    // Завершающие экраны клиент тоже видит, поэтому в оглавлении они есть. Но это не страницы:
    // их нельзя удалить, переставить и открыть на правку. Раньше они стояли в одном ряду с
    // обычными и выглядели как страницы, которые почему-то не нажимаются. Теперь отделены
    // чертой и подписаны, чем они являются.
    var инфо = state.doc && String(state.doc.kind || "") === "info";
    var fixed = el("div", "toc-list toc-fixed-list");
    fixed.appendChild(el("div", "toc-fixed-title", "Завершающие экраны"));
    var экраны = инфо ? [["tick", "Спасибо"]] : [["pen", "Подпись"], ["tick", "Спасибо"]];
    экраны.forEach(function (pair) {
      var row = el("div", "toc-fixed");
      row.appendChild(icon(pair[0]));
      row.appendChild(el("span", null, pair[1]));
      row.title = pair[1] === "Подпись"
        ? "Экран подписи. Ставится системой в конце документа, его нельзя переставить или удалить."
        : "Экран прощания. Показывается после подписания и сам возвращает планшет к рекламе.";
      fixed.appendChild(row);
    });
    // У документа только для показа экрана подписи нет вовсе: показывать там нечего.
    if (инфо) fixed.appendChild(el("div", "toc-fixed-note", "Этот документ не подписывают: экрана подписи у него нет."));
    toc.appendChild(fixed);

    var actions = el("div", "toc-actions");
    var foldAll = iconBtn("right", "Свернуть все", "btn-ghost btn-sm");
    foldAll.addEventListener("click", function () {
      collectDoc();
      (state.doc.pages || []).forEach(function (_, i) { collapsedPages[i] = true; });
      renderPages();
    });
    var openAll = iconBtn("down", "Развернуть все", "btn-ghost btn-sm");
    openAll.addEventListener("click", function () { collectDoc(); collapsedPages = {}; renderPages(); });
    actions.appendChild(foldAll); actions.appendChild(openAll);
    toc.appendChild(actions);
  }

  // Какие страницы свёрнуты. Хранится по номеру и переживает перерисовку: иначе любое
  // изменение внутри страницы разворачивало бы обратно всё, что оператор свернул.
  var collapsedPages = {};

  // ---------- Прожектор условий ----------
  // Условия видно только словами, а увидеть их итог можно было лишь в предпросмотре, отдельным
  // окном. Прожектор показывает итог прямо в редакторе: оператор задаёт тестовые значения, и
  // всё, что при них не покажется клиенту, гаснет на своём месте. Ничего не сохраняется и не
  // меняется в документе: это способ смотреть, а не править.
  var прожектор = { вкл: false, значения: {} };

  // Значение имени для прожектора. Тег берётся из заданных значений, чекбокс и группа из них же:
  // оператор задаёт «как будто клиент отметил вот это».
  function прожекторЗначение(имя) {
    var v = прожектор.значения[имя];
    return v == null ? "" : String(v);
  }

  // Выполняется ли условие при заданных значениях. Считает тем же кодом, что и планшет: своя
  // копия однажды разошлась бы с ним, и прожектор врал бы уверенно.
  function прожекторДержит(cond) {
    if (!cond) return true;
    return condGroups(cond).some(function (g) {
      return condParts(g).every(function (part) {
        var ok = прожекторЧасть(part);
        return part.not ? !ok : ok;
      });
    });
  }

  function прожекторЧасть(c) {
    if (c.op === "minchecked") {
      var надо = parseInt(c.value, 10);
      if (!(надо >= 1)) return false;
      var есть = String(c.field || "").split(",").map(function (x) { return x.trim(); })
        .filter(function (x) { return x.length; })
        .filter(function (k) { return прожекторЗначение(k).trim().toLowerCase() === "true"; }).length;
      return есть >= надо;
    }
    // Условия по часам сервера прожектор не вычисляет: у него нет часов службы, а гадать по
    // часам браузера значит показывать не то, что увидит клиент. Такие части считаются
    // выполненными, и рядом об этом сказано.
    if (isClockOp(c.op)) return true;
    var val = прожекторЗначение(c.field).trim().toLowerCase();
    var target = String(c.value || "").trim().toLowerCase();
    if (c.op === "numlt" || c.op === "numge" || c.op === "numin") {
      var n = parseFloat(val.replace(",", "."));
      if (!isFinite(n)) return false;
      if (c.op === "numin") {
        var гр = target.split("..");
        var a = parseFloat(String(гр[0]).replace(",", ".")), b = parseFloat(String(гр[1] || "").replace(",", "."));
        return isFinite(a) && isFinite(b) && n >= a && n <= b;
      }
      var lim = parseFloat(target.replace(",", "."));
      if (!isFinite(lim)) return false;
      return c.op === "numlt" ? n < lim : n >= lim;
    }
    if (c.op === "agelt" || c.op === "agege") {
      var лет = возрастПоДате(val);
      var предел = parseInt(target, 10);
      if (лет == null || !(предел >= 0)) return false;
      return c.op === "agelt" ? лет < предел : лет >= предел;
    }
    if (c.op === "annivwithin") return true;   // срок считается от сегодняшнего дня службы
    switch (c.op) {
      case "ne": return val !== target;
      case "empty": return val.length === 0;
      case "notempty": return val.length > 0;
      case "in": return target.split(",").map(function (x) { return x.trim(); })
        .filter(function (x) { return x.length; }).indexOf(val) >= 0;
      default: return val === target;
    }
  }

  function возрастПоДате(текст) {
    var m = /^(\d{2})[.\/-](\d{2})[.\/-](\d{4})$/.exec(текст) || null;
    var d = m ? new Date(+m[3], +m[2] - 1, +m[1]) : new Date(текст);
    if (isNaN(d.getTime())) return null;
    var сейчас = new Date();
    var лет = сейчас.getFullYear() - d.getFullYear();
    var м = сейчас.getMonth() - d.getMonth();
    if (м < 0 || (м === 0 && сейчас.getDate() < d.getDate())) лет--;
    return лет;
  }

  // Погасить всё, что при заданных значениях клиент не увидит. Работает по уже нарисованному
  // редактору, поэтому ничего не пересобирает и не теряет несохранённых правок.
  function прожекторПрименить() {
    var wrap = $("pagesEditor");
    if (!wrap) return;
    wrap.classList.toggle("spot-on", прожектор.вкл);
    wrap.querySelectorAll(".spot-off").forEach(function (n) { n.classList.remove("spot-off"); });
    wrap.querySelectorAll(".spot-empty").forEach(function (n) { n.classList.remove("spot-empty"); });
    if (!прожектор.вкл) return;

    collectDoc();
    var карточки = wrap.querySelectorAll('[data-role="pagecard"]');
    (state.doc.pages || []).forEach(function (page, pi) {
      var card = карточки[pi];
      if (!card) return;
      var видна = прожекторДержит(page.visibleWhen);
      card.classList.toggle("spot-off", !видна);
      // Элементы страницы гаснут по отдельности: страница может быть видна, а половина её
      // содержимого нет.
      var узлы = card.querySelectorAll('[data-role="itemlist"] > .page-item');
      var виднохоть = false;
      pageOrder(page, page.blocks).forEach(function (it, i) {
        var node = узлы[i];
        if (!node) return;
        var ok = видна && прожекторДержит(it.item.visibleWhen);
        node.classList.toggle("spot-off", !ok);
        if (ok) виднохоть = true;
      });
      // Страница, от которой при этих значениях не осталось ничего, помечается отдельно: клиент
      // увидит пустой экран, и это почти всегда недосмотр.
      if (видна && узлы.length && !виднохоть) card.classList.add("spot-empty");
    });
  }

  function прожекторПанель() {
    var box = el("div", "spotlight");
    var шапка = el("div", "spotlight-head");
    var вкл = el("label", "check-inline");
    var cb = el("input"); cb.type = "checkbox"; cb.setAttribute("data-role", "spoton");
    вкл.appendChild(cb);
    вкл.appendChild(document.createTextNode(" Показать, что увидит клиент при этих значениях"));
    шапка.appendChild(вкл);
    var сброс = el("button", "btn btn-ghost btn-sm", "Сбросить"); сброс.type = "button";
    сброс.addEventListener("click", function () {
      прожектор.значения = {};
      нарисоватьПоля();
      прожекторПрименить();
    });
    шапка.appendChild(сброс);
    box.appendChild(шапка);

    var поля = el("div", "spotlight-fields");
    box.appendChild(поля);
    var примечание = el("div", "spotlight-note sig-meta");
    box.appendChild(примечание);

    function нарисоватьПоля() {
      поля.innerHTML = "";
      collectDoc();
      var имена = previewFields();
      var dk = docKeys();
      // Чекбоксы и группы это тоже имена: условие может смотреть и на них.
      dk.checks.forEach(function (k) { if (имена.indexOf(k) < 0) имена.push(k); });
      Object.keys(dk.groups).forEach(function (k) { if (имена.indexOf(k) < 0) имена.push(k); });
      if (!имена.length) {
        поля.appendChild(el("div", "sig-meta", "В документе нет ни одного условия и ни одного тега."));
        return;
      }
      имена.forEach(function (имя) {
        var l = el("label", "field-sm", имя);
        var есть = dk.checks.indexOf(имя) >= 0;
        var варианты = Object.prototype.hasOwnProperty.call(dk.groups, имя) ? dk.groups[имя] : null;
        var i;
        if (есть || варианты) {
          i = el("select");
          i.appendChild(new Option("не задано", ""));
          (есть ? ["true", "false"] : варианты).forEach(function (v) { i.appendChild(new Option(v, v)); });
        } else {
          i = el("input"); i.type = "text"; i.placeholder = "значение";
        }
        i.value = прожектор.значения[имя] || "";
        i.addEventListener("change", function () {
          прожектор.значения[имя] = i.value;
          прожекторПрименить();
        });
        i.addEventListener("input", function () {
          прожектор.значения[имя] = i.value;
          прожекторПрименить();
        });
        l.appendChild(i);
        поля.appendChild(l);
      });
      // Условия по моменту показа прожектор не считает: у браузера свои часы, а решает служба.
      var часовые = false;
      (state.doc.pages || []).forEach(function (page) {
        function смотреть(c) {
          condGroups(c).forEach(function (g) {
            condParts(g).forEach(function (part) { if (isClockOp(part.op)) часовые = true; });
          });
        }
        смотреть(page.visibleWhen);
        (page.blocks || []).forEach(function (b) { смотреть(b.visibleWhen); });
        (page.checkboxes || []).forEach(function (c) { смотреть(c.visibleWhen); });
        (page.groups || []).forEach(function (g) { смотреть(g.visibleWhen); });
        (page.inputs || []).forEach(function (x) { смотреть(x.visibleWhen); });
      });
      примечание.textContent = часовые
        ? "Условия по дню недели, дате и времени здесь считаются выполненными: их решают часы сервера, а не браузера."
        : "";
    }

    cb.addEventListener("change", function () {
      прожектор.вкл = cb.checked;
      if (прожектор.вкл) нарисоватьПоля();
      поля.style.display = прожектор.вкл ? "" : "none";
      примечание.style.display = прожектор.вкл ? "" : "none";
      // Рамка и плашка только у включённого: выключенный это одна строка, которая не должна
      // отодвигать список страниц вниз и мозолить глаза.
      box.classList.toggle("spot-active", прожектор.вкл);
      прожекторПрименить();
    });
    поля.style.display = "none";
    примечание.style.display = "none";
    box.__refresh = нарисоватьПоля;
    return box;
  }

  function renderPages() {
    // Панель прожектора живёт над списком страниц и переживает перерисовку: она не часть
    // документа, и пересобирать её на каждую правку значило бы терять заданные значения.
    var host = $("spotlightHost");
    if (host && !host.firstChild) host.appendChild(прожекторПанель());

    var wrap = $("pagesEditor"); wrap.innerHTML = "";
    (state.doc.pages || []).forEach(function (page, pi) {
      // Подпись и сканирование это отдельные экраны, а не элементы среди текста: клиент на них
      // занят одним делом. У такого экрана свой заголовок, свой текст над полем и само поле.
      var kind = (page.kind || "").toLowerCase();
      if (kind !== "signature" && kind !== "scan") kind = "";
      var card = el("div", "page-card" + (kind ? " page-" + kind : ""));
      card.setAttribute("data-role", "pagecard");
      card.setAttribute("data-page-kind", kind);
      var title = el("div", "page-title");

      // За эту ручку страницу перетаскивают. Само перетаскивание включается только по ней,
      // иначе оно перехватывало бы выделение текста в редакторах внутри страницы.
      var handle = el("span", "drag-handle");
      handle.appendChild(icon("grip"));
      handle.title = "Перетащите, чтобы изменить порядок страниц";
      title.appendChild(handle);

      var toggle = el("button", "page-toggle");
      toggle.type = "button";
      title.appendChild(toggle);

      var name = el("span", "page-name", (kind === "signature" ? "Экран подписи "
        : kind === "scan" ? "Экран сканирования " : "Страница ") + (pi + 1));
      title.appendChild(name);

      // Сводка занимает всё свободное место, поэтому кнопка удаления всегда у правого края,
      // а не плавает по середине, как было при распределении по краям.
      var summary = el("span", "page-summary", "");
      title.appendChild(summary);

      var delPage = iconBtn("trash", "Удалить", "btn-danger btn-sm");
      delPage.title = "Удалить страницу";
      delPage.addEventListener("click", function () {
        if (!confirm("Удалить страницу " + (pi + 1) + " целиком?")) return;
        collectDoc(); state.doc.pages.splice(pi, 1); renderPages(); updatePlaceholders();
      });
      title.appendChild(delPage); card.appendChild(title);

      var body = el("div", "page-body");
      card.appendChild(body);

      function applyCollapsed() {
        var off = !!collapsedPages[pi];
        card.classList.toggle("collapsed", off);
        body.classList.toggle("hidden", off);
        toggle.innerHTML = "";
        toggle.appendChild(icon(off ? "right" : "down"));
        toggle.title = off ? "Развернуть страницу" : "Свернуть страницу";
        summary.textContent = off ? pageSummary(page) : "";
      }
      toggle.addEventListener("click", function () {
        // Собираем перед сворачиванием: иначе правки в скрытой странице потерялись бы
        // при следующей перерисовке.
        collectDoc();
        collapsedPages[pi] = !collapsedPages[pi];
        applyCollapsed();
      });

      body.appendChild(sectionLabel("filter", "Условие показа страницы"));
      body.appendChild(conditionEditor(page.visibleWhen, "pagecond"));

      body.appendChild(richEditor("Заголовок", headingRunsOf(page), "heading", page.headingAlign));

      // Один список на всю страницу: текст, чекбоксы и выбор одного варианта стоят вперемешку,
      // в том порядке, в каком их читает клиент. Пункт должен идти сразу за своим абзацем, а не
      // в общей куче внизу страницы.
      body.appendChild(sectionLabel("layout", "Содержимое страницы (порядок такой же, как увидит клиент)"));
      var items = el("div", "item-list"); items.setAttribute("data-role", "itemlist");
      var blocks = blocksOf(page);
      if (!blocks.length && !(page.checkboxes || []).length && !(page.groups || []).length) blocks = [{ runs: [] }];
      var built = pageOrder(page, blocks)
        .filter(function (it) { return kind ? it.kind === 0 : true; })
        .map(function (it) {
          return it.kind === 0 ? blockCard(it.item)
            : it.kind === 1 ? checkboxRow(it.item)
              : it.kind === 2 ? groupCard(it.item)
                : it.kind === 5 ? inputRow(it.item)
                : it.kind === 3 ? signatureRow(it.item)
                  : scanRow(it.item);
        });
      items.appendChild(insertBar(items, null, kind));
      built.forEach(function (node) { items.appendChild(node); items.appendChild(insertBar(items, node, kind)); });
      makeSortable(items, ".page-item");
      body.appendChild(items);

      // Само поле экрана стоит отдельно и в общий список не попадает: переставлять его местами
      // не с чем, а удалять надо вместе с экраном.
      if (kind === "signature") {
        body.appendChild(sectionLabel("pen", "Поле подписи на этом экране"));
        body.appendChild(signatureRow((page.signatures || [])[0] || { label: "", required: true }));
      } else if (kind === "scan") {
        body.appendChild(sectionLabel("search", "Сканирование на этом экране"));
        body.appendChild(scanRow((page.scans || [])[0] || { label: "", required: true }));
      }

      // Признак «в PDF». Страницу, на которой клиент что-то подтверждает, исключить нельзя:
      // в бумаге оказалась бы отметка без того, под чем она стоит. Переключатель тогда не
      // прячется, а гаснет с объяснением: спрятанный оставил бы оператора гадать, куда он делся.
      var взаимодействие = (page.checkboxes || []).length || (page.groups || []).length ||
        (page.signatures || []).length || (page.scans || []).length || (page.inputs || []).length;
      var вPdf = el("label", "check-inline pdf-flag");
      var вPdfCb = el("input"); вPdfCb.type = "checkbox";
      вPdfCb.checked = page.inPdf !== false || !!взаимодействие;
      вPdfCb.setAttribute("data-role", "pageinpdf");
      if (взаимодействие) {
        вPdfCb.checked = true;
        вPdfCb.disabled = true;
        вPdf.title = "На этой странице клиент что-то подтверждает, поэтому она обязана быть в PDF: " +
          "иначе в бумаге окажется отметка без того, под чем она стоит.";
      } else {
        вPdf.title = "Снимите, если эта страница нужна только на экране: вступление, пояснение, заставка. " +
          "В записи она останется целиком, в PDF не попадёт.";
      }
      вPdf.appendChild(вPdfCb);
      вPdf.appendChild(document.createTextNode(" Сохранять эту страницу в PDF"));
      body.appendChild(вPdf);

      if (!kind) {
        var dyn = el("label", "check-inline dyn-anchor");
        var dynCb = el("input"); dynCb.type = "checkbox"; dynCb.checked = !!page.includeDynamic; dynCb.setAttribute("data-role", "includedynamic");
        dyn.appendChild(dynCb); dyn.appendChild(document.createTextNode(" Показывать здесь чекбоксы, присланные по API"));
        body.appendChild(dyn);

        var всё = el("label", "check-inline dyn-anchor");
        var всёCb = el("input"); всёCb.type = "checkbox"; всёCb.checked = !!page.showCheckAll;
        всёCb.setAttribute("data-role", "checkall");
        всё.appendChild(всёCb);
        всё.appendChild(document.createTextNode(" Кнопка «отметить всё» над пунктами (нужна от трёх пунктов)"));
        body.appendChild(всё);

        body.appendChild(rulesPanel(card, page));
      }

      applyCollapsed();
      wrap.appendChild(card);
    });
    makeSortable(wrap, ".page-card");
    renderToc();
    // Список страниц пересобран: подсветку надо наложить заново, иначе она осталась бы на
    // прежних узлах, которых уже нет.
    if (прожектор.вкл) прожекторПрименить();

    // Signature page: custom content (text / image) on either side of the signature field.
    var signCard = el("div", "page-card sign-page-card");
    var st = el("div", "page-title");
    st.appendChild(icon("pen", "page-icon"));
    st.appendChild(el("span", "page-name", "Страница подписи"));
    st.appendChild(el("span", "page-summary", "клиент видит её последней, перед экраном «Спасибо»"));
    signCard.appendChild(st);
    signCard.appendChild(el("p", "sig-meta", "Здесь можно разместить текст или картинку (реквизиты, печать, пояснение) над полем подписи и под ним. То же самое попадёт в PDF."));

    signCard.appendChild(sectionLabel("text", "Над полем подписи"));
    var sblist = el("div", "block-list"); sblist.setAttribute("data-role", "signblocklist");
    (state.doc.signBlocks || []).forEach(function (b) { sblist.appendChild(blockCard(b)); });
    signCard.appendChild(sblist);
    var addSb = iconBtn("plus", "Блок над подписью");
    addSb.addEventListener("click", function () { sblist.appendChild(blockCard({ runs: [] })); });
    signCard.appendChild(addSb);

    signCard.appendChild(el("div", "sign-divider", "Поле подписи"));

    signCard.appendChild(sectionLabel("text", "Под полем подписи"));
    var sblistBelow = el("div", "block-list"); sblistBelow.setAttribute("data-role", "signblocklistbelow");
    (state.doc.signBlocksBelow || []).forEach(function (b) { sblistBelow.appendChild(blockCard(b)); });
    signCard.appendChild(sblistBelow);
    var addSbBelow = iconBtn("plus", "Блок под подписью");
    addSbBelow.addEventListener("click", function () { sblistBelow.appendChild(blockCard({ runs: [] })); });
    signCard.appendChild(addSbBelow);
    wrap.appendChild(signCard);

    // Экран благодарности: такая же страница, как остальные. Заголовок оформляется той же
    // панелью, под ним можно поставить текст и картинки, а время показа задаётся здесь же:
    // раньше это была одна строка без оформления и жёсткие шесть секунд.
    var thxCard = el("div", "page-card thanks-page-card");
    var tt = el("div", "page-title");
    tt.appendChild(icon("tick", "page-icon"));
    tt.appendChild(el("span", "page-name", "Экран «Спасибо»"));
    tt.appendChild(el("span", "page-summary", "последнее, что видит клиент, потом планшет возвращается к рекламе"));
    thxCard.appendChild(tt);

    thxCard.appendChild(richEditor("Заголовок", labelRuns(state.doc.thankYouRuns, state.doc.thankYouText || "Спасибо!"),
      "thanksheading", state.doc.thankYouAlign));

    thxCard.appendChild(sectionLabel("text", "Что показать под заголовком"));
    var thxList = el("div", "block-list"); thxList.setAttribute("data-role", "thanksblocklist");
    (state.doc.thankYouBlocks || []).forEach(function (b) { thxList.appendChild(blockCard(b)); });
    thxCard.appendChild(thxList);
    var addThx = iconBtn("plus", "Блок на экране «Спасибо»");
    addThx.addEventListener("click", function () { thxList.appendChild(blockCard({ runs: [] })); });
    thxCard.appendChild(addThx);

    var сек = el("label", "field-sm", "Показывать, сек");
    var секПоле = el("input"); секПоле.type = "number"; секПоле.min = "2"; секПоле.max = "60";
    секПоле.value = state.doc.thankYouSec != null ? state.doc.thankYouSec : 6;
    секПоле.setAttribute("data-role", "thankssec");
    секПоле.title = "Сколько секунд держать этот экран, прежде чем вернуться к рекламе";
    сек.appendChild(секПоле);
    сек.appendChild(el("span", "field-hint", "От двух до шестидесяти. Меньше двух человек не успевает прочитать, больше минуты планшет впустую занят."));
    thxCard.appendChild(сек);
    wrap.appendChild(thxCard);
  }
  // Имя для API у группы и у её вариантов обязательно: без него выбор неадресуем извне, и сервер
  // такой вариант не сохранит. Раньше оператор видел на экране два варианта, а проверка говорила,
  // что вариантов нет: они молча отбрасывались из-за пустого имени. Теперь имя подставляется само,
  // латиницей, из текста, и остаётся на виду - его можно поправить руками.
  var TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z",
    "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
    "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya"
  };
  function slugKey(text) {
    var out = String(text || "").toLowerCase().split("").map(function (ch) {
      if (TRANSLIT[ch] != null) return TRANSLIT[ch];
      return /[a-z0-9]/.test(ch) ? ch : "-";
    }).join("").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return out.slice(0, 40);
  }
  function uniqueKey(base, taken) {
    var k = base || "opt", n = 2;
    while (taken.indexOf(k) >= 0) { k = base + "-" + n; n++; }
    return k;
  }

  // Связать поле текста с полем имени: пока имя не правили руками, оно следует за текстом.
  function linkAutoKey(source, keyInput, siblingsOf) {
    if ((keyInput.value || "").trim()) keyInput.removeAttribute("data-auto");
    else keyInput.setAttribute("data-auto", "1");
    keyInput.addEventListener("input", function () { keyInput.removeAttribute("data-auto"); });
    source.addEventListener("input", function () {
      if (!keyInput.hasAttribute("data-auto")) return;
      var taken = (siblingsOf() || []).filter(function (i) { return i !== keyInput; })
        .map(function (i) { return (i.value || "").trim(); });
      // Источником может быть и обычное поле, и поле с оформлением: у второго значение это
      // его текст, а не value.
      var текст = source.value != null ? source.value : (source.textContent || "");
      var base = slugKey(текст);
      keyInput.value = base ? uniqueKey(base, taken) : "";
    });
  }

  // Поле подписи внутри страницы. Документ может требовать несколько подписей, и каждая
  // хранится отдельно под своим именем, поэтому в записи и в PDF видно, что именно подписано.
  function signatureRow(sig) {
    sig = sig || {};
    var box = el("div", "sign-item page-item"); box.setAttribute("data-role", "signrow");
    box.setAttribute("data-kind", "signature");
    var row = el("div", "cb-row");
    var handle = el("span", "drag-handle");
    handle.appendChild(icon("grip"));
    handle.title = "Перетащите, чтобы изменить порядок";
    row.appendChild(handle);
    row.appendChild(icon("pen", "item-icon"));
    var label = el("input"); label.type = "text"; label.placeholder = "Что подписывают, например: Подпись пациента";
    label.value = sig.label || ""; label.setAttribute("data-role", "siglabel"); row.appendChild(label);
    var key = el("input", "cb-key"); key.type = "text"; key.placeholder = "имя для API";
    key.value = sig.key || ""; key.setAttribute("data-role", "sigkey");
    key.title = "Имя этого поля подписи. По нему подпись различается в записи и в PDF.";
    row.appendChild(key);
    linkAutoKey(label, key, function () {
      var card = box.closest('[data-role="pagecard"]');
      return card ? Array.prototype.slice.call(card.querySelectorAll('[data-role="sigkey"]')) : [];
    });
    var reqLabel = el("label"); var req = el("input"); req.type = "checkbox";
    req.checked = sig.required !== false; req.setAttribute("data-role", "sigreq");
    reqLabel.appendChild(req); reqLabel.appendChild(document.createTextNode(" обязательная")); row.appendChild(reqLabel);

    // Размер и положение места подписи. Ширина в процентах от страницы, высота в точках:
    // те же единицы, что и в PDF, поэтому на бумаге получается ровно то, что задано.
    var шLabel = el("label", "field-sm", "Ширина, точек");
    var ш = el("input"); ш.type = "number"; ш.min = "60"; ш.max = "495";
    ш.value = sig.width != null ? sig.width : 280; ш.setAttribute("data-role", "sigwidth");
    шLabel.appendChild(ш); row.appendChild(шLabel);
    var вLabel = el("label", "field-sm", "Высота, точек");
    var в = el("input"); в.type = "number"; в.min = "40"; в.max = "300";
    в.value = sig.height != null ? sig.height : 100; в.setAttribute("data-role", "sigheight");
    вLabel.appendChild(в); row.appendChild(вLabel);
    var аLabel = el("label", "field-sm", "Положение");
    var а = el("select"); а.setAttribute("data-role", "sigalign");
    [["", "слева"], ["center", "по центру"], ["right", "справа"]].forEach(function (o) {
      а.appendChild(new Option(o[1], o[0]));
    });
    а.value = sig.align || ""; аLabel.appendChild(а); row.appendChild(аLabel);
    var cond = conditionEditor(sig.visibleWhen, "sigcond"); cond.classList.add("cond-inline"); row.appendChild(cond);
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { removeItem(box); }); row.appendChild(del);
    box.appendChild(row);
    return box;
  }

  // Сканирование кода внутри страницы: клиент подносит штрихкод пробирки или QR из направления.
  // Код попадает в запись подписи, но не в PDF: это служебные данные заказа, а не то, что
  // человек подписывает.
  function scanRow(sc) {
    sc = sc || {};
    var box = el("div", "scan-item page-item"); box.setAttribute("data-role", "scanrow");
    box.setAttribute("data-kind", "scan");
    var row = el("div", "cb-row");
    var handle = el("span", "drag-handle");
    handle.appendChild(icon("grip"));
    handle.title = "Перетащите, чтобы изменить порядок";
    row.appendChild(handle);
    row.appendChild(icon("search", "item-icon"));
    var label = el("input"); label.type = "text"; label.placeholder = "Что сканировать, например: штрихкод пробирки";
    label.value = sc.label || ""; label.setAttribute("data-role", "scanlabel"); row.appendChild(label);
    var key = el("input", "cb-key"); key.type = "text"; key.placeholder = "имя для API";
    key.value = sc.key || ""; key.setAttribute("data-role", "scankey");
    key.title = "Имя этого поля. По нему считанный код различается в записи подписи.";
    row.appendChild(key);
    linkAutoKey(label, key, function () {
      var card = box.closest('[data-role="pagecard"]');
      return card ? Array.prototype.slice.call(card.querySelectorAll('[data-role="scankey"]')) : [];
    });
    var reqLabel = el("label"); var req = el("input"); req.type = "checkbox";
    req.checked = sc.required !== false; req.setAttribute("data-role", "scanreq");
    reqLabel.appendChild(req); reqLabel.appendChild(document.createTextNode(" обязательно")); row.appendChild(reqLabel);
    var cond = conditionEditor(sc.visibleWhen, "scancond"); cond.classList.add("cond-inline"); row.appendChild(cond);
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { removeItem(box); }); row.appendChild(del);
    box.appendChild(row);
    return box;
  }

  // Поле ввода: клиент вписывает значение с экранной клавиатуры. Вид значения решает, какую
  // клавиатуру он увидит и как значение проверится, поэтому он выбирается явно, а не угадывается
  // по названию поля.
  var INPUT_TYPES = [["text", "текст"], ["number", "число"], ["date", "дата"], ["phone", "телефон"]];

  function inputRow(inp) {
    inp = inp || {};
    var box = el("div", "input-item page-item"); box.setAttribute("data-role", "inputrow");
    box.setAttribute("data-kind", "input");
    var row = el("div", "cb-row");
    var handle = el("span", "drag-handle");
    handle.appendChild(icon("grip"));
    handle.title = "Перетащите, чтобы изменить порядок";
    row.appendChild(handle);
    row.appendChild(icon("text", "item-icon"));
    var label = el("input"); label.type = "text"; label.placeholder = "Что вписывают, например: Телефон";
    label.value = inp.label || ""; label.setAttribute("data-role", "inplabel"); row.appendChild(label);
    var key = el("input", "cb-key"); key.type = "text"; key.placeholder = "имя для API";
    key.value = inp.key || ""; key.setAttribute("data-role", "inpkey");
    key.title = "Имя этого поля. По нему вписанное значение попадает в запись и работает в условиях.";
    row.appendChild(key);
    linkAutoKey(label, key, function () {
      var card = box.closest('[data-role="pagecard"]');
      return card ? Array.prototype.slice.call(card.querySelectorAll('[data-role="inpkey"]')) : [];
    });
    var вид = el("select", "cb-key"); вид.setAttribute("data-role", "inptype");
    INPUT_TYPES.forEach(function (t) { вид.appendChild(new Option(t[1], t[0])); });
    вид.value = inp.type || "text";
    вид.title = "Вид значения: от него зависит клавиатура на планшете и проверка";
    row.appendChild(вид);
    var подсказка = el("input"); подсказка.type = "text"; подсказка.className = "cb-key";
    подсказка.placeholder = "подсказка в поле";
    подсказка.value = inp.placeholder || ""; подсказка.setAttribute("data-role", "inpph");
    row.appendChild(подсказка);
    var reqLabel = el("label"); var req = el("input"); req.type = "checkbox";
    req.checked = !!inp.required; req.setAttribute("data-role", "inpreq");
    reqLabel.appendChild(req); reqLabel.appendChild(document.createTextNode(" обязательно")); row.appendChild(reqLabel);
    var cond = conditionEditor(inp.visibleWhen, "inpcond"); cond.classList.add("cond-inline"); row.appendChild(cond);
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { removeItem(box); }); row.appendChild(del);
    box.appendChild(row);
    return box;
  }

  function readInputRow(box) {
    if (!box) return null;
    var label = (box.querySelector('[data-role="inplabel"]') || {}).value || "";
    var key = (box.querySelector('[data-role="inpkey"]') || {}).value || "";
    if (!label.trim() && !key.trim()) {
      if (!readCondition(box.querySelector('[data-role="inpcond"]'))) { выброшеноПустых++; return null; }
    }
    var out = {
      key: key.trim(), label: label,
      type: (box.querySelector('[data-role="inptype"]') || {}).value || "text",
      placeholder: (box.querySelector('[data-role="inpph"]') || {}).value || "",
      required: !!(box.querySelector('[data-role="inpreq"]') || {}).checked
    };
    var cond = readCondition(box.querySelector('[data-role="inpcond"]'));
    if (cond) out.visibleWhen = cond;
    return out;
  }

  // Панель правил отметок: список правил словами и кнопки добавления. Правило связывает пункты
  // между собой, поэтому живёт у страницы, а не у пункта.
  function rulesPanel(card, page) {
    var box = el("div", "rules-panel");
    card.setAttribute("data-check-rules", JSON.stringify(page.checkRules || []));

    function имена() {
      return Array.prototype.slice.call(card.querySelectorAll('[data-role="cbkey"]'))
        .map(function (i) { return (i.value || "").trim(); })
        .filter(function (k) { return k.length; });
    }
    function текстПункта(ключ) {
      var поля = Array.prototype.slice.call(card.querySelectorAll('[data-role="cbkey"]'));
      for (var i = 0; i < поля.length; i++) {
        if ((поля[i].value || "").trim() !== ключ) continue;
        var строка = поля[i].closest(".page-item");
        var ed = строка && строка.querySelector('[data-role="cblabel"]');
        var t = ed ? (ed.textContent || "").trim() : "";
        return t.length ? t : ключ;
      }
      return ключ;
    }
    function правила() {
      try { return JSON.parse(card.getAttribute("data-check-rules") || "[]") || []; } catch (e) { return []; }
    }
    function записать(list) {
      card.setAttribute("data-check-rules", JSON.stringify(list));
      markDirty();
      нарисовать();
    }

    var список = el("div", "rules-list");
    box.appendChild(список);

    function нарисовать() {
      список.innerHTML = "";
      var list = правила();
      if (!list.length) {
        список.appendChild(el("div", "sig-meta", "Правил нет: пункты не связаны между собой."));
      }
      list.forEach(function (r, i) {
        var строка = el("div", "rule-row");
        var текст = r.kind === "minchecked"
          ? "отметить не меньше " + (r.n || 1) + " из: " + (r.keys || []).map(текстПункта).join(", ")
          : "взаимоисключающие: " + (r.keys || []).map(текстПункта).join(", ");
        строка.appendChild(el("span", "rule-text", текст));
        var del = el("button", "btn btn-danger btn-sm", "×");
        del.type = "button";
        del.title = "Убрать правило";
        del.addEventListener("click", function () {
          var l = правила(); l.splice(i, 1); записать(l);
        });
        строка.appendChild(del);
        список.appendChild(строка);
      });
    }

    function добавить(вид) {
      var доступные = имена();
      if (доступные.length < 2) {
        toast("Правилу нужны минимум два названных пункта на этой странице", true);
        return;
      }
      var c = el("div");
      c.appendChild(el("h3", null, вид === "minchecked" ? "Отметить не меньше N" : "Взаимоисключающие пункты"));
      c.appendChild(el("p", "sig-meta", вид === "minchecked"
        ? "Клиент не пройдёт дальше, пока не отметит нужное число пунктов из выбранных."
        : "Отметка одного из выбранных пунктов снимает остальные."));
      var поля = el("div", "rule-picks");
      доступные.forEach(function (k) {
        var l = el("label", "check-inline");
        var cb = el("input"); cb.type = "checkbox"; cb.value = k;
        l.appendChild(cb); l.appendChild(document.createTextNode(" " + текстПункта(k)));
        поля.appendChild(l);
      });
      c.appendChild(поля);
      var n = null;
      if (вид === "minchecked") {
        var nl = el("label", "field-sm", "Сколько отметить");
        n = el("input"); n.type = "number"; n.min = "1"; n.max = "50"; n.value = "1";
        nl.appendChild(n); c.appendChild(nl);
      }
      var ok = iconBtn("check", "Добавить правило", "btn-primary");
      ok.addEventListener("click", function () {
        var keys = Array.prototype.slice.call(поля.querySelectorAll("input:checked")).map(function (i) { return i.value; });
        if (keys.length < 2) { toast("Выберите хотя бы два пункта", true); return; }
        var l = правила();
        l.push({ kind: вид, keys: keys, n: n ? (parseInt(n.value, 10) || 1) : 1 });
        записать(l);
        closeModal();
      });
      c.appendChild(ok);
      openModal(c);
    }

    var кнопки = el("div", "rules-actions");
    var b1 = iconBtn("plus", "Взаимоисключающие", "btn-ghost btn-sm");
    b1.addEventListener("click", function () { добавить("exclusive"); });
    var b2 = iconBtn("plus", "Не меньше N", "btn-ghost btn-sm");
    b2.addEventListener("click", function () { добавить("minchecked"); });
    кнопки.appendChild(b1); кнопки.appendChild(b2);
    box.appendChild(кнопки);

    нарисовать();
    return box;
  }

  // Правила отметок страницы. Хранятся в самой карточке строкой JSON: правило это не поле
  // ввода, а связь между пунктами, и рисовать под него отдельную форму значило бы городить
  // редактор внутри редактора. Оператор задаёт правило кнопкой, а видит его строкой словами.
  function readCheckRules(card, checkboxes) {
    var raw = card.getAttribute("data-check-rules") || "";
    if (!raw) return [];
    var rules = [];
    try { rules = JSON.parse(raw) || []; } catch (e) { return []; }
    var есть = {};
    (checkboxes || []).forEach(function (c) { if (c && c.key) есть[c.key] = true; });
    return rules.filter(function (r) {
      return r && r.keys && r.keys.filter(function (k) { return есть[k]; }).length >= 2;
    }).map(function (r) {
      return { kind: r.kind === "minchecked" ? "minchecked" : "exclusive",
        keys: r.keys.filter(function (k) { return есть[k]; }), n: parseInt(r.n, 10) || 1 };
    });
  }

  function readSignatureRow(box) {
    if (!box) return null;
    var label = (box.querySelector('[data-role="siglabel"]') || {}).value || "";
    var key = (box.querySelector('[data-role="sigkey"]') || {}).value || "";
    if (!label.trim() && !key.trim()) {
      // Поле с условием уже не пустая заготовка: оператор его настраивал. Оно остаётся, а о
      // недостающем имени скажет проверка документа.
      if (!readCondition(box.querySelector('[data-role="sigcond"]'))) { выброшеноПустых++; return null; }
    }
    var out = { key: key.trim(), label: label, required: (box.querySelector('[data-role="sigreq"]') || {}).checked !== false };
    out.width = parseInt((box.querySelector('[data-role="sigwidth"]') || {}).value, 10) || 280;
    out.height = parseInt((box.querySelector('[data-role="sigheight"]') || {}).value, 10) || 100;
    var са = (box.querySelector('[data-role="sigalign"]') || {}).value || "";
    if (са) out.align = са;
    var cond = readCondition(box.querySelector('[data-role="sigcond"]'));
    if (cond) out.visibleWhen = cond;
    return out;
  }

  function readScanRow(box) {
    if (!box) return null;
    var label = (box.querySelector('[data-role="scanlabel"]') || {}).value || "";
    var key = (box.querySelector('[data-role="scankey"]') || {}).value || "";
    if (!label.trim() && !key.trim()) {
      if (!readCondition(box.querySelector('[data-role="scancond"]'))) { выброшеноПустых++; return null; }
    }
    var out = { key: key.trim(), label: label, required: (box.querySelector('[data-role="scanreq"]') || {}).checked !== false };
    var cond = readCondition(box.querySelector('[data-role="scancond"]'));
    if (cond) out.visibleWhen = cond;
    return out;
  }

  // Однострочное поле с оформлением: то же, что редактор абзаца, но в одну строку и с подсказкой
  // на пустом месте. Панель оформления цепляется к нему сама, как к любому .rt-editor.
  function labelEditor(runs, plain, role, placeholder) {
    var ed = el("div", "rt-editor rt-inline");
    ed.contentEditable = "true";
    ed.setAttribute("data-role", role);
    ed.setAttribute("data-placeholder", placeholder || "");
    ed.innerHTML = runsToHtml(labelRuns(runs, plain));
    attachPasteGuard(ed);
    return ed;
  }

  function checkboxRow(cb) {
    var box = el("div", "cb-item page-item"); box.setAttribute("data-role", "cbrow");
    box.setAttribute("data-kind", "checkbox");
    var row = el("div", "cb-row");
    var handle = el("span", "drag-handle");
    handle.appendChild(icon("grip"));
    handle.title = "Перетащите, чтобы изменить порядок";
    row.appendChild(handle);
    // Текст пункта оформляется той же панелью, что и абзацы: жирный, курсив, цвет, размер.
    // Раньше это было обычное поле ввода, и выделить в пункте ничего было нельзя.
    var label = labelEditor(cb.labelRuns, cb.label, "cblabel", "Текст пункта");
    row.appendChild(label);
    // Имя, по которому внешняя система адресует именно этот пункт. Подставляется само из
    // текста, латиницей, и остаётся на виду: его можно поправить руками. Без имени пункт
    // остаётся обычным чекбоксом из шаблона: он работает и попадает в запись, но задать его
    // из API и сослаться на него в условии нельзя.
    var key = el("input", "cb-key"); key.type = "text"; key.placeholder = "имя для API";
    key.value = cb.key || ""; key.setAttribute("data-role", "cbkey");
    key.title = "Имя этого пункта для внешней системы. Заполняется само из текста. " +
      "По нему API задаёт начальное состояние пункта и по нему на пункт ссылаются условия показа. " +
      "Можно оставить пустым: тогда пункт просто нельзя будет задать из API.";
    row.appendChild(key);
    linkAutoKey(label, key, function () {
      var card = box.closest('[data-role="pagecard"]');
      return card ? Array.prototype.slice.call(card.querySelectorAll('[data-role="cbkey"]')) : [];
    });
    var reqLabel = el("label"); var req = el("input"); req.type = "checkbox"; req.checked = cb.required !== false; req.setAttribute("data-role", "cbreq");
    reqLabel.appendChild(req); reqLabel.appendChild(document.createTextNode(" обязательный")); row.appendChild(reqLabel);
    var chkLabel = el("label"); var chk = el("input"); chk.type = "checkbox"; chk.checked = !!cb.checked; chk.setAttribute("data-role", "cbchecked");
    chkLabel.appendChild(chk); chkLabel.appendChild(document.createTextNode(" отмечен")); row.appendChild(chkLabel);
    // Условие стоит в той же строке, а не под ней: пункт это одна строка, и вторая строка
    // с одной кнопкой «+ условие показа» удваивала высоту списка на ровном месте. Когда
    // условие задано, значок разворачивается в поля и строка временно становится выше.
    var cond = conditionEditor(cb.visibleWhen, "cbcond");
    cond.classList.add("cond-inline");
    row.appendChild(cond);
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { removeItem(box); }); row.appendChild(del);
    box.appendChild(row);
    return box;
  }

  // --- группа вариантов: выбрать можно один, «ни одного» тоже состояние ---
  function groupCard(g) {
    var card = el("div", "group-card page-item"); card.setAttribute("data-role", "grouprow");
    card.setAttribute("data-kind", "group");
    var head = el("div", "cb-row");
    var handle = el("span", "drag-handle");
    handle.appendChild(icon("grip"));
    handle.title = "Перетащите, чтобы изменить порядок";
    head.appendChild(handle);
    var title = labelEditor(g.titleRuns, g.title, "gtitle", "Общий заголовок");
    head.appendChild(title);
    var key = el("input", "cb-key"); key.type = "text"; key.placeholder = "имя для API";
    key.value = g.key || ""; key.setAttribute("data-role", "gkey");
    key.title = "Имя этой группы для внешней системы. Заполняется само из заголовка. " +
      "По нему API присылает выбранный вариант и по нему на группу ссылаются условия показа.";
    head.appendChild(key);
    linkAutoKey(title, key, function () {
      var page = card.closest('[data-role="pagecard"]');
      return page ? Array.prototype.slice.call(page.querySelectorAll('[data-role="gkey"]')) : [];
    });
    linkAutoKey(title, key, function () { return []; });
    var reqLabel = el("label"); var req = el("input"); req.type = "checkbox"; req.checked = !!g.required; req.setAttribute("data-role", "greq");
    reqLabel.appendChild(req); reqLabel.appendChild(document.createTextNode(" обязательно выбрать")); head.appendChild(reqLabel);
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { removeItem(card); }); head.appendChild(del);
    setTimeout(function () {
      addItemCollapse(card, function () {
        var t = (card.querySelector('[data-role="gtitle"]') || {}).value || "";
        var n = card.querySelectorAll('[data-role="optrow"]').length;
        return (t || "(без заголовка)") + "   ·   вариантов: " + n;
      });
    }, 0);
    card.appendChild(head);

    var opts = el("div", "opt-list"); opts.setAttribute("data-role", "optlist");
    (g.options || []).forEach(function (o) { opts.appendChild(optionRow(o, g.selected)); });
    card.appendChild(opts);
    var addOpt = iconBtn("plus", "Вариант", "btn-ghost btn-sm");
    addOpt.addEventListener("click", function () { opts.appendChild(optionRow({ key: "", label: "" })); });
    card.appendChild(addOpt);
    card.appendChild(conditionEditor(g.visibleWhen, "gcond"));
    return card;
  }

  function optionRow(o, selected) {
    var row = el("div", "cb-row"); row.setAttribute("data-role", "optrow");
    var label = labelEditor(o.labelRuns, o.label, "olabel", "Текст варианта");
    row.appendChild(label);
    var key = el("input", "cb-key"); key.type = "text"; key.placeholder = "имя для API"; key.value = o.key || ""; key.setAttribute("data-role", "okey"); row.appendChild(key);
    linkAutoKey(label, key, function () {
      var list = row.closest('[data-role="optlist"]');
      return list ? Array.prototype.slice.call(list.querySelectorAll('[data-role="okey"]')) : [];
    });
    // Вариант, отмеченный заранее. У чекбокса такая пометка есть давно, а у группы её не было:
    // выбор по умолчанию задавался только по API, а при сохранении из редактора молча пропадал,
    // хотя планшет его использует.
    var defLabel = el("label", "opt-default");
    var def = el("input"); def.type = "checkbox";
    def.setAttribute("data-role", "odefault");
    def.checked = !!(o.key && selected && String(selected).toLowerCase() === String(o.key).toLowerCase());
    def.title = "Этот вариант отмечен заранее. Отмеченным может быть только один.";
    def.addEventListener("change", function () {
      if (!def.checked) return;
      // Отмеченным может быть только один: выбор одного снимает остальные.
      var list = row.closest('[data-role="optlist"]');
      if (list) list.querySelectorAll('[data-role="odefault"]').forEach(function (x) { if (x !== def) x.checked = false; });
    });
    defLabel.appendChild(def); defLabel.appendChild(el("span", null, "отмечен"));
    row.appendChild(defLabel);
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { row.remove(); updatePlaceholders(); }); row.appendChild(del);
    return row;
  }
  // Сколько совсем пустых заготовок выброшено при последнем сборе. Пустая заготовка это
  // элемент, который добавили и не тронули: хранить его нечем, но выбрасывать молча нельзя,
  // сохранение назовёт число вслух.
  var выброшеноПустых = 0;

  function collectDoc() {
    выброшеноПустых = 0;
    state.doc.title = $("docTitle").value; state.doc.signPrompt = $("signPrompt").value;
    state.doc.idleReturnSec = parseInt($("idleReturn").value, 10) || 0;
    var pages = [];
    document.querySelectorAll('#pagesEditor [data-role="pagecard"]').forEach(function (card) {
      var hEd = card.querySelector('[data-role="heading"]');
      var headingRuns = hEd ? editorToRuns(hEd) : [];
      var pageCond = readCondition(card.querySelector('[data-role="pagecond"]'));
      var includeDynamic = !!(card.querySelector('[data-role="includedynamic"]') || {}).checked;
      var pageInPdf = (card.querySelector('[data-role="pageinpdf"]') || {}).checked !== false;

      // Блоки текста, чекбоксы и группы лежат в одном списке в том порядке, в каком их
      // расставил оператор. Номер берётся прямо из положения в списке, поэтому на планшете
      // страница выглядит ровно так, как в редакторе.
      var blocks = [], checkboxes = [], groups = [], signatures = [], scans = [], inputs = [], ord = 0;
      card.querySelectorAll('[data-role="itemlist"] > .page-item').forEach(function (node) {
        var kind = node.getAttribute("data-kind");
        var got = kind === "block" ? readBlockCard(node)
          : kind === "checkbox" ? readCheckboxRow(node)
            : kind === "group" ? readGroupRow(node)
              : kind === "signature" ? readSignatureRow(node)
                : kind === "scan" ? readScanRow(node)
                  : kind === "input" ? readInputRow(node) : null;
        if (!got) return;
        got.ord = ord++;
        if (kind === "block") blocks.push(got);
        else if (kind === "checkbox") checkboxes.push(got);
        else if (kind === "group") groups.push(got);
        else if (kind === "signature") signatures.push(got);
        else if (kind === "scan") scans.push(got);
        else inputs.push(got);
      });
      var headingAlign = alignOf(hEd);
      // Поле экрана подписи или сканирования стоит вне общего списка: там переставлять его не
      // с чем. Читается оно отдельно и кладётся в тот же массив, что и блоки внутри страницы,
      // поэтому в записи подписи, в PDF и в раскладке ничего не меняется.
      var pageKind = card.getAttribute("data-page-kind") || "";
      if (pageKind === "signature") {
        // Поле экрана остаётся, даже если оператор ещё не вписал подпись под ним: иначе
        // добавленный экран молча исчезал бы при сохранении. Имя подставит сервер.
        var sigOwn = readSignatureRow(card.querySelector('[data-role="signrow"]'))
          || { key: "", label: "", required: true };
        sigOwn.ord = 0; signatures = [sigOwn]; scans = [];
      } else if (pageKind === "scan") {
        var scanOwn = readScanRow(card.querySelector('[data-role="scanrow"]'))
          || { key: "", label: "", required: true };
        scanOwn.ord = 0; scans = [scanOwn]; signatures = [];
      }
      var page = { heading: "", body: "", kind: pageKind || null, headingRuns: headingRuns, headingAlign: headingAlign, blocks: blocks, checkboxes: checkboxes,
        groups: groups, signatures: signatures, scans: scans, inputs: inputs, inPdf: pageInPdf, includeDynamic: includeDynamic,
        checkRules: readCheckRules(card, checkboxes), showCheckAll: !!(card.querySelector('[data-role="checkall"]') || {}).checked };
      if (pageCond) page.visibleWhen = pageCond;
      pages.push(page);
    });
    state.doc.pages = pages;
    state.doc.signBlocks = collectBlocks(document.querySelector('[data-role="signblocklist"]'));
    state.doc.signBlocksBelow = collectBlocks(document.querySelector('[data-role="signblocklistbelow"]'));

    // Экран благодарности собирается так же, как страница: оформленный заголовок, блоки и время.
    var thxEd = document.querySelector('[data-role="thanksheading"]');
    if (thxEd) {
      var thxRuns = editorToRuns(thxEd);
      state.doc.thankYouRuns = thxRuns;
      state.doc.thankYouText = runsText(thxRuns);
      state.doc.thankYouAlign = alignOf(thxEd) || null;
    }
    state.doc.thankYouBlocks = collectBlocks(document.querySelector('[data-role="thanksblocklist"]'));
    var секЭл = document.querySelector('[data-role="thankssec"]');
    if (секЭл) state.doc.thankYouSec = parseInt(секЭл.value, 10) || 6;
  }
  // Новая страница встаёт в конец и сразу показывается: иначе после нажатия непонятно,
  // добавилось ли что-нибудь, особенно если кнопку нажали из оглавления.
  // Страница бывает трёх видов. Обычная это текст, пункты и выбор вариантов. Экран подписи и
  // экран сканирования это отдельные шаги, где клиент занят только одним делом: расписаться или
  // поднести код. То же самое можно поставить и блоком внутри обычной страницы, если подпись
  // относится к конкретному абзацу, а не ко всему документу.
  function addPage(kind) {
    collectDoc();
    var page = { headingRuns: [{ text: "Новая страница" }], blocks: [], checkboxes: [], groups: [], includeDynamic: false };
    if (kind === "signature") {
      page.kind = "signature";
      page.headingRuns = [{ text: "Подпись" }];
      page.signatures = [{ label: "", required: true, ord: 0 }];
    } else if (kind === "scan") {
      page.kind = "scan";
      page.headingRuns = [{ text: "Сканирование кода" }];
      page.scans = [{ label: "", required: true, ord: 0 }];
    }
    state.doc.pages.push(page);
    renderPages();
    markDirty();
    var cards = document.querySelectorAll('#pagesEditor [data-role="pagecard"]');
    scrollToCard(cards[cards.length - 1]);
  }

  // Меню видов раскрывается прямо под кнопкой: три отдельные кнопки в панели страниц заняли бы
  // столько места, что список страниц уехал бы вниз.
  function openPageKinds(anchor) {
    var host = anchor.parentNode;
    var open = host.querySelector('[data-role="pagekinds"]');
    if (open) { open.remove(); return; }
    var menu = el("div", "page-kinds"); menu.setAttribute("data-role", "pagekinds");
    [["Обычная страница", ""], ["Экран подписи", "signature"], ["Экран сканирования кода", "scan"]]
      .forEach(function (o) {
        var b = el("button", "btn btn-ghost btn-sm", o[0]); b.type = "button";
        b.addEventListener("click", function () { menu.remove(); addPage(o[1]); });
        menu.appendChild(b);
      });
    host.insertBefore(menu, anchor.nextSibling);
  }
  $("addPage").addEventListener("click", function () { openPageKinds($("addPage")); });
  // Сообщение об итоге показывает сам saveDoc: тост здесь один на всех, и «Документ сохранён»
  // из обработчика затирал бы предупреждение о несохранённых заготовках, не дав его прочитать.
  $("saveDocument").addEventListener("click", function () { saveDoc().catch(function () { /* уже показано */ }); });

  // ---- Защита несохранённого ----
  // Документ пишется на сервер только по кнопке. Закрытая вкладка, обновление страницы или
  // упавший браузер до этого момента уносили с собой всю работу, и ничто об этом не
  // предупреждало. Теперь правки видно в шапке, браузер спрашивает при уходе, а черновик
  // лежит в самом браузере и предлагается к восстановлению.
  // Черновик хранится под ключом своего документа. Общий ключ означал бы, что переключение
  // документа предлагает восстановить черновик от другого, и оператор однажды подложил бы текст
  // договора в согласие.
  var DRAFT_PREFIX = "sk_doc_draft";
  function draftKey() {
    return state.docId ? DRAFT_PREFIX + ":" + state.docId : DRAFT_PREFIX;
  }
  var dirty = false;
  var draftTimer = null;

  function markDirty() {
    if (!dirty) { dirty = true; syncDirty(); }
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 1200);
    // Прожектор показывает итог условий: правка условия должна сразу менять то, что погашено.
    // С задержкой, потому что правка идёт по букве, а пересчёт трогает весь список страниц.
    if (прожектор.вкл) {
      clearTimeout(прожекторТаймер);
      прожекторТаймер = setTimeout(прожекторПрименить, 400);
    }
  }
  var прожекторТаймер = null;

  function syncDirty() {
    var btn = $("saveDocument");
    if (btn) {
      btn.classList.toggle("btn-primary", dirty);
      btn.classList.toggle("btn-ghost", !dirty);
      btn.title = dirty ? "Есть несохранённые изменения" : "Изменений нет";
    }
    var mark = $("docDirty");
    if (mark) mark.classList.toggle("hidden", !dirty);
    // Точка на своей закладке. Меняется только она: перестраивать весь ряд на каждое нажатие
    // клавиши значило бы дёргать закладки под курсором оператора.
    var своя = document.querySelector(".doc-tab.on");
    if (своя) {
      var точка = своя.querySelector(".doc-tab-dot");
      if (dirty && !точка) {
        var т = el("span", "doc-tab-dot", "•");
        своя.insertBefore(т, своя.querySelector(".doc-tab-menu"));
      } else if (!dirty && точка) точка.remove();
    }
  }

  function saveDraft() {
    try {
      collectDoc();
      localStorage.setItem(draftKey(), JSON.stringify({ at: Date.now(), doc: state.doc }));
    } catch (e) { /* приватный режим или переполнение: черновик просто не сохранится */ }
  }

  function dropDraft() {
    try { localStorage.removeItem(draftKey()); } catch (e) { /* нечего убирать */ }
  }

  function saveDoc(поверх) {
    collectDoc();
    // Условие без выбранного тега в документ не попадает. Сохранить документ всё равно надо,
    // но сказать об этом обязательно: иначе блок молча покажется всем.
    var пустых = незаполненныеУсловия();
    var headers = { "Content-Type": "application/json" };
    // Версия отправляется, только когда она есть и оператор не решил сохранить поверх: сервер
    // сверит её и откажет, если документ уже переписали из другого окна.
    if (state.docRev && !поверх) headers["X-Doc-Rev"] = state.docRev;
    var путь = state.docId ? "/document?id=" + encodeURIComponent(state.docId) : "/document";
    return api(путь, { method: "PUT", headers: headers, body: JSON.stringify(state.doc) }).then(function (r) {
      state.docRev = r.headers.get("X-Doc-Rev") || state.docRev;
      dirty = false; syncDirty(); dropDraft();
      // Одно сообщение целиком: предупреждения приклеены к «сохранён», иначе следующее
      // сообщение затёрло бы их раньше, чем оператор успел прочитать.
      var итог = "Документ сохранён";
      if (пустых) итог += ". Условий без выбранного тега: " + пустых + ", они не сохранены, блок будет показан всем";
      if (выброшеноПустых) итог += ". Пустых заготовок не сохранено: " + выброшеноПустых;
      toast(итог);
      return r;
    }).catch(function (err) {
      if (err && err.status === 409) { offerConflict(); }
      throw err;
    });
  }

  // Документ переписали из другого окна, пока оператор правил здесь. Молча затереть чужую
  // работу нельзя, молча выбросить свою тоже: выбор за оператором, и оба пути безопасны,
  // потому что свои правки в любом случае лежат в черновике.
  function offerConflict() {
    saveDraft();
    var c = el("div");
    c.appendChild(el("h3", null, "Документ изменён в другом окне"));
    c.appendChild(el("p", "sig-meta",
      "Пока вы правили, документ сохранили из другого окна или другой оператор. " +
      "Ваши правки целы: они лежат в черновике этого браузера."));
    var взять = iconBtn("download", "Взять свежий с сервера", "btn-primary");
    взять.addEventListener("click", function () {
      closeModal();
      loadDoc(state.docId).then(function () { toast("Загружена свежая версия. Ваши правки можно вернуть из черновика."); });
    });
    var поверх = iconBtn("upload", "Сохранить мою версию поверх", "btn-ghost");
    поверх.title = "Затирает то, что сохранили в другом окне";
    поверх.addEventListener("click", function () {
      closeModal();
      saveDoc(true).catch(function () { /* уже показано */ });
    });
    c.appendChild(взять); c.appendChild(поверх);
    openModal(c);
  }

  // Любая правка внутри вкладки документа считается изменением: перечислять поля по одному
  // значило бы однажды забыть новое и снова терять работу молча.
  (function () {
    var panel = document.querySelector('[data-panel="document"]');
    if (!panel) return;
    ["input", "change"].forEach(function (ev) {
      panel.addEventListener(ev, function (e) {
        // Предпросмотр и переключатель документов это не правка документа: первый только
        // смотрит, второй переключает. Без этого выбор документа в списке помечал только что
        // открытый документ изменённым, и следующее переключение спрашивало о правках,
        // которых никто не делал.
        if (e.target.closest && e.target.closest(".preview-setup, .preview-wrap, .doc-library, .spotlight")) return;
        markDirty();
      });
    });
    panel.addEventListener("click", function (e) {
      // Добавление, удаление и перетаскивание тоже меняют документ, а событий ввода не дают.
      if (e.target.closest && e.target.closest(".doc-library, .spotlight")) return;
      if (e.target.closest && e.target.closest(".insert-chip, .btn-danger, .btn-add, #addPage, .page-toggle, .item-toggle"))
        markDirty();
    });
  })();

  window.addEventListener("beforeunload", function (e) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });

  /// Черновик предлагается, только если он новее и отличается от того, что на сервере.
  function offerDraft() {
    var raw = null;
    try { raw = localStorage.getItem(draftKey()); } catch (e) { return; }
    if (!raw) return;
    var draft = null;
    try { draft = JSON.parse(raw); } catch (e) { dropDraft(); return; }
    if (!draft || !draft.doc) { dropDraft(); return; }
    if (JSON.stringify(draft.doc) === JSON.stringify(state.doc)) { dropDraft(); return; }

    var c = el("div");
    c.appendChild(el("h3", null, "Есть несохранённый черновик"));
    c.appendChild(el("p", "sig-meta",
      "В браузере остались правки от " + new Date(draft.at).toLocaleString("ru-RU") +
      ", которые не были сохранены на сервер. Восстановить их или продолжить с того, что на сервере?"));
    var restore = iconBtn("upload", "Восстановить черновик", "btn-primary");
    restore.addEventListener("click", function () {
      state.doc = draft.doc; renderDoc(); dirty = true; syncDirty(); closeModal();
      toast("Черновик восстановлен. Не забудьте сохранить.");
    });
    var drop = iconBtn("trash", "Отказаться от черновика", "btn-ghost");
    drop.addEventListener("click", function () { dropDraft(); closeModal(); });
    c.appendChild(restore); c.appendChild(drop);
    openModal(c);
  }

  // ---- Preview: see the document exactly as the tablet will render it ----
  // Values are entered by the operator, resolved on the server (same code path as a real show),
  // and rendered here with the tablet's own markup, so conditions and formatting are truthful.
  $("previewDoc").addEventListener("click", function () {
    collectDoc();
    // Offer BOTH the {{tags}} used in text and the fields used only in conditions: without the
    // latter the operator could not test which blocks and pages actually appear.
    openPreviewSetup(previewFields());
  });

  // Distinct fields the preview should ask for: text placeholders plus condition fields.
  function previewFields() {
    var out = [], seen = {};
    function add(k) {
      var key = (k || "").trim(); if (!key) return;
      var lk = key.toLowerCase(); if (seen[lk]) return;
      seen[lk] = 1; out.push(key);
    }
    scanPlaceholders().forEach(add);
    function addCond(c) {
      condGroups(c).forEach(function (group) {
        condParts(group).forEach(function (part) { add(part.field); });
      });
    }
    (state.doc.pages || []).forEach(function (p) {
      addCond(p.visibleWhen);
      (p.blocks || []).forEach(function (b) { addCond(b.visibleWhen); });
      (p.checkboxes || []).forEach(function (c) { addCond(c.visibleWhen); });
      (p.groups || []).forEach(function (g) { addCond(g.visibleWhen); });
      // Подписи и сканы тоже живут под условиями: тег, использованный только там, иначе не
      // предлагался бы в предпросмотре, и проверить показ поля подписи было бы нечем.
      (p.signatures || []).forEach(function (x) { addCond(x.visibleWhen); });
      (p.scans || []).forEach(function (x) { addCond(x.visibleWhen); });
    });
    (state.doc.signBlocks || []).forEach(function (b) { addCond(b.visibleWhen); });
    (state.doc.signBlocksBelow || []).forEach(function (b) { addCond(b.visibleWhen); });
    // Условие на чекбокс задаёт клиент на планшете, а не внешняя система: спрашивать для него
    // тестовое значение бессмысленно и только путало бы оператора.
    return out.filter(function (name) { return !isDocKey(name); });
  }

  // ---- Раскладка подписей на листе PDF ----
  // Лист строится по координатам, которые прислал сервер: их считает тот же генератор, что
  // потом соберёт готовый файл. Поэтому здесь не «похоже на PDF», а тот самый PDF, только без
  // самих подписей: их оператор и расставляет.
  $("watchDoc").addEventListener("click", function () {
    var sel = $("docTarget");
    var id = sel && sel.value ? String(sel.value).replace(/^device:/, "") : "";
    if (!id) { toast("Сначала выберите планшет"); return; }
    openWatchWindow(id, sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : "");
  });

  $("pdfLayout").addEventListener("click", function () {
    collectDoc();
    var btn = $("pdfLayout");
    btn.classList.add("btn-wait");
    // Тестовые значения тегов берутся те же, что и в предпросмотре: длина подставленного
    // текста влияет на то, где закончится страница, а значит и на место подписи.
    var fields = {};
    previewFields().forEach(function (k) { fields[k] = previewDefault(k); });
    pdfLayoutOf(state.doc.signaturePlacements || [], fields, state.doc.pdfFontScale,
      state.doc.pdfSignatureScale).then(function (data) {
      openPdfLayout(data, fields);
    }).catch(function (e) {
      toast(e && e.message ? e.message : "Не удалось построить макет PDF", true);
    }).then(function () { btn.classList.remove("btn-wait"); });
  });

  // Макет считает сервер, и пересчитывать его надо при каждом изменении раскладки: подпись,
  // снятая с потока, укорачивает документ, а возвращённая в поток удлиняет, и разбивка на
  // страницы вместе с ней меняется.
  function pdfLayoutOf(places, fields, fontScale, signScale) {
    var doc = {};
    for (var k in state.doc) if (Object.prototype.hasOwnProperty.call(state.doc, k)) doc[k] = state.doc[k];
    doc.signaturePlacements = places;
    if (fontScale) doc.pdfFontScale = fontScale;
    if (signScale) doc.pdfSignatureScale = signScale;
    return apiJson("/document/pdf-layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: doc, fields: fields })
    });
  }

  function openPdfLayout(data, previewValues) {
    var PW = data.pageWidth || 595, PH = data.pageHeight || 842;
    var pageCount = Math.max(1, data.pageCount || 1);
    previewValues = previewValues || {};
    // Копия, а не исходный массив: пока оператор не нажал «Применить», документ не меняется.
    var places = (data.placements || []).map(function (p) {
      return { key: p.key || "", page: p.page || 0, x: p.x || 0, y: p.y || 0, w: p.w || 0.35, h: p.h || 0.08 };
    });
    var fields = data.fields || [];
    var scale = 1, sheets = null, side = null, zoomLabel = null;

    var root = el("div", "pdfl");
    var head = el("div", "pdfl-head");
    head.appendChild(el("h3", null, "Листы PDF и раскладка подписей"));
    // Размер шрифта в PDF. Экран и бумага это разные носители: на планшете крупный шрифт нужен,
    // чтобы читалось с расстояния, а на бумаге тот же размер раздувает документ на лишние
    // страницы. Пересчёт идёт сразу, поэтому видно, во сколько листов документ уложится.
    var scaleWrap = el("label", "pdfl-scale");
    scaleWrap.appendChild(el("span", null, "Шрифт в PDF"));
    var scaleSel = el("select");
    [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50].forEach(function (v) {
      scaleSel.appendChild(new Option(v + "%", String(v)));
    });
    scaleSel.value = String(state.doc.pdfFontScale || 100);
    scaleSel.title = "100% это тот же размер, что видит клиент на планшете";
    scaleSel.addEventListener("change", function () { reflow(); });
    scaleWrap.appendChild(scaleSel);
    head.appendChild(scaleWrap);

    // Размер места под подпись задаётся отдельно от шрифта: подпись может занимать на бумаге
    // слишком много, даже когда текст уже мелкий. На подпись со своим местом это не влияет.
    var signWrap = el("label", "pdfl-scale");
    signWrap.appendChild(el("span", null, "Подпись в PDF"));
    var signSel = el("select");
    [100, 90, 80, 70, 60, 50, 40].forEach(function (v) { signSel.appendChild(new Option(v + "%", String(v))); });
    signSel.value = String(state.doc.pdfSignatureScale || 100);
    signSel.title = "Размер места под подпись в потоке документа. Подпись, которой задано своё место на листе, меняется перетаскиванием.";
    signSel.addEventListener("change", function () { reflow(); });
    signWrap.appendChild(signSel);
    head.appendChild(signWrap);

    // Колонтитул внизу каждого листа. Нужен бумажному архиву: по номеру страницы видно, что
    // документ не разрознен, а по штрихкоду записи лист находится сканером, не глазами.
    var ftWrap = el("div", "pdfl-footer");
    ftWrap.appendChild(el("span", "pdfl-footer-title", "Колонтитул PDF:"));
    var ftOpts = [
      ["pdfPageNumbers", "номер страницы"],
      ["pdfFooterTitle", "название документа"],
      ["pdfFooterRecordId", "номер записи"],
      ["pdfFooterBarcode", "штрихкод записи"]
    ];
    ftOpts.forEach(function (o) {
      var l = el("label", "check-inline");
      var cb = el("input"); cb.type = "checkbox";
      cb.checked = !!state.doc[o[0]];
      cb.setAttribute("data-role", "pdf-" + o[0]);
      l.appendChild(cb); l.appendChild(document.createTextNode(" " + o[1]));
      ftWrap.appendChild(l);
    });
    head.appendChild(ftWrap);

    var zoom = el("div", "pdfl-zoom");
    var less = el("button", "btn btn-ghost", "−"); less.title = "Мельче";
    zoomLabel = el("span", null, "100%");
    var more = el("button", "btn btn-ghost", "+"); more.title = "Крупнее";
    less.addEventListener("click", function () { setScale(scale - 0.15); });
    more.addEventListener("click", function () { setScale(scale + 0.15); });
    zoom.appendChild(less); zoom.appendChild(zoomLabel); zoom.appendChild(more);
    head.appendChild(zoom);
    root.appendChild(head);
    root.appendChild(el("p", "sig-meta", "Так документ будет напечатан. Подпись, которой не задано место, печатается там же, где стоит её поле в документе, и показана серой рамкой. Перетащите синий прямоугольник туда, где подпись должна оказаться на листе."));

    var body = el("div", "pdfl-body");
    side = el("div", "pdfl-side");
    sheets = el("div", "pdfl-sheets");
    var inner = el("div", "pdfl-sheets-inner");
    sheets.appendChild(inner);
    body.appendChild(side); body.appendChild(sheets);
    root.appendChild(body);

    var actions = el("div", "modal-actions");
    var cancel = el("button", "btn btn-ghost", "Отмена");
    cancel.addEventListener("click", closeModal);
    var apply = el("button", "btn btn-primary", "Применить");
    apply.addEventListener("click", function () {
      state.doc.signaturePlacements = places.map(function (p) {
        return { key: p.key, page: p.page, x: round4(p.x), y: round4(p.y), w: round4(p.w), h: round4(p.h) };
      });
      ftOpts.forEach(function (o) {
        var cb = document.querySelector('[data-role="pdf-' + o[0] + '"]');
        state.doc[o[0]] = !!(cb && cb.checked);
      });
      state.doc.pdfFontScale = parseInt(scaleSel.value, 10) || 100;
      state.doc.pdfSignatureScale = parseInt(signSel.value, 10) || 100;
      markDirty();
      closeModal();
      toast(places.length ? "Раскладка подписей применена, не забудьте сохранить документ"
        : "Все подписи печатаются в потоке документа");
    });
    actions.appendChild(cancel); actions.appendChild(apply);
    root.appendChild(actions);
    openModal(root, true);

    // Пересчитать макет на сервере и перерисовать. Пока считает, лист остаётся на экране:
    // мигание пустотой на каждое движение оператора выглядело бы сломанным.
    function reflow(after) {
      pdfLayoutOf(places, previewValues, parseInt(scaleSel.value, 10) || 100,
        parseInt(signSel.value, 10) || 100).then(function (fresh) {
        data = fresh;
        pageCount = Math.max(1, fresh.pageCount || 1);
        PW = fresh.pageWidth || PW; PH = fresh.pageHeight || PH;
        draw();
        if (after) after();
      }).catch(function (e) {
        toast(e && e.message ? e.message : "Не удалось пересчитать макет PDF", true);
        draw();
      });
    }

    function round4(v) { return Math.round(v * 10000) / 10000; }
    // Имя поля задаёт оператор, в нём может оказаться кавычка: в селектор её пускать нельзя.
    function cssKey(k) { return String(k).replace(/["\\]/g, "\\$&"); }
    // Имена полей сервер сравнивает без учёта регистра, здесь должно быть так же: иначе одна
    // и та же подпись показалась бы и рамкой в потоке, и прямоугольником.
    function same(a, b) { return String(a || "").toLowerCase() === String(b || "").toLowerCase(); }
    function placeOf(key) {
      for (var i = 0; i < places.length; i++) if (same(places[i].key, key)) return places[i];
      return null;
    }
    function labelOf(key) {
      for (var i = 0; i < fields.length; i++) if (same(fields[i].key, key)) return fields[i].label || fields[i].key;
      return key;
    }

    // При открытии лист показывается целиком: подпись ставят относительно всей страницы, и
    // видеть надо весь лист, а не его верхнюю треть. Дальше масштаб меняет оператор.
    var availW = Math.max(240, sheets.clientWidth - 40);
    var availH = Math.max(240, sheets.clientHeight - 40);
    setScale(Math.min(1.4, Math.min(availW / PW, availH / PH)));

    function setScale(v) {
      scale = Math.min(2, Math.max(0.3, Math.round(v * 100) / 100));
      zoomLabel.textContent = Math.round(scale * 100) + "%";
      draw();
    }

    function draw() {
      inner.innerHTML = "";
      var pages = [];
      for (var i = 0; i < pageCount; i++) {
        var pg = el("div", "pdf-page");
        pg.style.width = (PW * scale) + "px";
        pg.style.height = (PH * scale) + "px";
        pg.setAttribute("data-page", String(i));
        var no = el("div", "pdf-page-no", "страница " + (i + 1) + " из " + pageCount);
        pg.appendChild(no);
        inner.appendChild(pg);
        pages.push(pg);
      }
      (data.items || []).forEach(function (it) {
        var pg = pages[it.page]; if (!pg) return;
        if (it.kind === "text") {
          var t = el("span", "pdf-t");
          t.textContent = it.text || "";
          t.style.left = (it.x * scale) + "px";
          t.style.top = (it.y * scale) + "px";
          t.style.fontSize = ((it.size || 11) * scale) + "px";
          if (it.bold) t.style.fontWeight = "700";
          if (it.italic) t.style.fontStyle = "italic";
          if (it.color) t.style.color = it.color;
          pg.appendChild(t);
        } else if (it.kind === "image") {
          var im = el(it.text ? "img" : "div", "pdf-img");
          if (it.text) im.src = it.text;
          im.style.left = (it.x * scale) + "px"; im.style.top = (it.y * scale) + "px";
          im.style.width = (it.w * scale) + "px"; im.style.height = (it.h * scale) + "px";
          pg.appendChild(im);
        } else if (it.kind === "sign" && !placeOf(it.text || "")) {
          // Подпись без заданного места печатается в потоке: показываем, где именно.
          var fl = el("div", "pdf-flow");
          fl.style.left = (it.x * scale) + "px"; fl.style.top = (it.y * scale) + "px";
          fl.style.width = (it.w * scale) + "px"; fl.style.height = (it.h * scale) + "px";
          fl.appendChild(el("b", null, "в потоке: " + labelOf(it.text || "")));
          pg.appendChild(fl);
        }
      });
      places.forEach(function (p) {
        var pg = pages[Math.min(p.page, pages.length - 1)];
        if (!pg) return;
        pg.appendChild(rect(p, pages));
      });
      renderSide(pages);
    }

    function rect(p, pages) {
      var box = el("div", "pdf-place");
      box.setAttribute("data-key", p.key);
      box.style.left = (p.x * PW * scale) + "px";
      box.style.top = (p.y * PH * scale) + "px";
      box.style.width = (p.w * PW * scale) + "px";
      box.style.height = (p.h * PH * scale) + "px";
      box.appendChild(el("b", null, labelOf(p.key)));
      var grip = el("i");
      box.appendChild(grip);

      // Тянуть можно и сам прямоугольник, и его угол. Указатель ловится захватом, иначе
      // при быстром движении курсор уходит с элемента и перетаскивание обрывается.
      function start(ev, resizing) {
        if (ev.button != null && ev.button !== 0) return;
        ev.preventDefault(); ev.stopPropagation();
        var startX = ev.clientX, startY = ev.clientY;
        var x0 = p.x, y0 = p.y, w0 = p.w, h0 = p.h;
        box.classList.add("drag");
        var target = resizing ? grip : box;
        target.setPointerCapture(ev.pointerId);
        function move(e) {
          var dx = (e.clientX - startX) / (PW * scale), dy = (e.clientY - startY) / (PH * scale);
          if (resizing) {
            p.w = Math.min(1 - p.x, Math.max(0.05, w0 + dx));
            p.h = Math.min(1 - p.y, Math.max(0.02, h0 + dy));
            box.style.width = (p.w * PW * scale) + "px";
            box.style.height = (p.h * PH * scale) + "px";
            return;
          }
          p.x = Math.min(1 - p.w, Math.max(0, x0 + dx));
          p.y = Math.min(1 - p.h, Math.max(0, y0 + dy));
          box.style.left = (p.x * PW * scale) + "px";
          box.style.top = (p.y * PH * scale) + "px";
          // Прямоугольник, вытащенный на соседний лист, переезжает на него: иначе подпись
          // на многостраничном документе пришлось бы ставить вслепую.
          var over = pageUnder(e.clientX, e.clientY, pages);
          if (over >= 0 && over !== p.page) {
            p.page = over;
            pages[over].appendChild(box);
            var r = pages[over].getBoundingClientRect();
            p.x = Math.min(1 - p.w, Math.max(0, (e.clientX - r.left) / (PW * scale) - p.w / 2));
            p.y = Math.min(1 - p.h, Math.max(0, (e.clientY - r.top) / (PH * scale) - p.h / 2));
            box.style.left = (p.x * PW * scale) + "px";
            box.style.top = (p.y * PH * scale) + "px";
            startX = e.clientX; startY = e.clientY; x0 = p.x; y0 = p.y;
            renderSide(pages);
          }
        }
        function up(e) {
          box.classList.remove("drag");
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
          target.removeEventListener("pointercancel", up);
          try { target.releasePointerCapture(e.pointerId); } catch (err) { /* указатель уже отпущен */ }
          renderSide(pages);
        }
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
      }
      box.addEventListener("pointerdown", function (ev) { start(ev, false); });
      grip.addEventListener("pointerdown", function (ev) { start(ev, true); });
      return box;
    }

    function pageUnder(cx, cy, pages) {
      for (var i = 0; i < pages.length; i++) {
        var r = pages[i].getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return i;
      }
      return -1;
    }

    function renderSide(pages) {
      side.innerHTML = "";
      side.appendChild(sectionLabel("pen", "Поля подписи"));
      // Документ мог стать короче с тех пор, как подписи расставляли. Молча переносить их на
      // последний лист нельзя: оператор должен об этом узнать и поправить.
      var съехали = places.filter(function (x) { return x.page >= pageCount; });
      if (съехали.length) {
        съехали.forEach(function (x) { x.page = pageCount - 1; });
        side.appendChild(el("p", "sig-meta", "Документ стал короче: " + съехали.length +
          " подпись перенесена на последний лист. Проверьте место."));
      }
      if (!fields.length) { side.appendChild(el("p", "sig-meta", "В документе нет полей подписи.")); return; }
      fields.forEach(function (f) {
        var p = placeOf(f.key);
        var card = el("div", "pdfl-field" + (p ? " on" : ""));
        card.appendChild(el("div", "nm", f.label || f.key));
        card.appendChild(el("div", "st", p ? "лист " + (p.page + 1) + ", своё место" : "печатается в потоке документа"));
        var row = el("div", "row");
        if (p) {
          var back = el("button", "btn btn-ghost", "Вернуть в поток");
          back.addEventListener("click", function () {
            places = places.filter(function (x) { return x !== p; });
            reflow();
          });
          row.appendChild(back);
        } else {
          var put = el("button", "btn btn-ghost", "Разместить");
          put.addEventListener("click", function () {
            // Прямоугольник появляется на том листе, который сейчас перед глазами, и сразу
            // показывается: иначе при мелком масштабе непонятно, добавилось ли что-нибудь.
            var добавлен = { key: f.key, page: visiblePage(pages), x: 0.08, y: 0.75, w: 0.35, h: 0.08 };
            places.push(добавлен);
            reflow(function () {
              var box = sheets.querySelector('.pdf-place[data-key="' + cssKey(добавлен.key) + '"]');
              if (box && box.scrollIntoView) box.scrollIntoView({ block: "center", inline: "nearest" });
            });
          });
          row.appendChild(put);
        }
        card.appendChild(row);
        side.appendChild(card);
      });
    }

    function visiblePage(pages) {
      var top = sheets.getBoundingClientRect().top;
      for (var i = pages.length - 1; i >= 0; i--)
        if (pages[i].getBoundingClientRect().top <= top + 60) return i;
      return 0;
    }
  }

  function openPreviewSetup(placeholders) {
    var c = el("div", "preview-setup");
    c.appendChild(el("h3", null, "Предпросмотр документа"));
    c.appendChild(el("p", "sig-meta", "Укажите тестовые значения тегов. Документ будет показан так, как его увидит клиент на планшете, включая условия показа блоков и страниц. На планшеты ничего не отправляется."));

    var inputs = {};
    if (!placeholders.length) c.appendChild(el("p", "sig-meta", "В шаблоне нет тегов - будет показан документ как есть."));
    placeholders.forEach(function (k) {
      // A tag with a fixed set of values gets a dropdown here too, so a preview cannot be run
      // against a value the real system would never send.
      var known = fieldValues(k);
      if (known) {
        var wrap = el("label", "field", k);
        var sel = el("select");
        known.forEach(function (v) { sel.appendChild(new Option(valueLabel(k, v), v)); });
        sel.value = known.indexOf(previewDefault(k)) >= 0 ? previewDefault(k) : known[0];
        wrap.appendChild(sel);
        c.appendChild(wrap); inputs[k] = sel;
      } else {
        var f = labeledInput(k, previewDefault(k));
        c.appendChild(f.wrap); inputs[k] = f.input;
      }
    });

    // Внешняя система задаёт и состояние именованных чекбоксов, и выбор в двойных зависимых
    // чекбоксах. Раньше проверить это в предпросмотре было нельзя, хотя по API оно приходит
    // так же, как теги, и точно так же влияет на условия показа.
    var keys = docKeys();
    var cbState = {};
    if (keys.checks.length) {
      c.appendChild(sectionLabel("check", "Чекбоксы документа (что прислано отмеченным)"));
      var cbBox = el("div", "pv-setup-list");
      keys.checks.forEach(function (k) {
        var lbl = el("label", "sch-dev");
        var cb = document.createElement("input");
        cb.type = "checkbox"; cb.setAttribute("data-check", k);
        cb.addEventListener("change", function () { cbState[k] = cb.checked; lbl.classList.toggle("on", cb.checked); });
        lbl.appendChild(cb); lbl.appendChild(el("span", null, k));
        cbBox.appendChild(lbl);
      });
      c.appendChild(cbBox);
    }

    var groupSel = {};
    var groupNames = Object.keys(keys.groups);
    if (groupNames.length) {
      c.appendChild(sectionLabel("list", "Двойные зависимые чекбоксы (что выбрано)"));
      groupNames.forEach(function (g) {
        var wrap = el("label", "field", g);
        var sel = el("select"); sel.setAttribute("data-group", g);
        sel.appendChild(new Option("не выбрано", ""));
        (keys.groups[g] || []).forEach(function (o) { sel.appendChild(new Option(o, o)); });
        wrap.appendChild(sel); c.appendChild(wrap); groupSel[g] = sel;
      });
    }

    c.appendChild(sectionLabel("plus", "Чекбоксы, добавленные через API (которых нет в документе)"));
    var cbLabel = el("label", "field", "По одному в строке, «+» в начале - отмечен");
    var cbArea = el("textarea"); cbArea.rows = 3; cbArea.placeholder = "+Согласен на рассылку\nДополнительное согласие";
    cbLabel.appendChild(cbArea); c.appendChild(cbLabel);

    // Здесь набирают текст построчно, а внешняя система шлёт JSON. Показываем, во что именно
    // превращается набранное: иначе непонятно, что должен прислать тот, кто пишет интеграцию.
    var пример = el("details", "pv-json");
    пример.appendChild(el("summary", null, "Как это выглядит в запросе POST /api/ext/show-document"));
    пример.appendChild(el("p", "sig-meta",
      "Чекбокс, который есть в документе, задаётся по key и отмечается на своём месте. " +
      "Чекбокса, которого в документе нет, задаётся по label и дописывается в конец страницы, помеченной приёмником. " +
      "Двойные зависимые чекбоксы это groups: key это имя группы, selected это имя выбранного варианта, пустая строка означает, что не выбрано ничего."));
    var код = el("pre", "api-code");
    пример.appendChild(код);
    c.appendChild(пример);
    function обновитьПример() {
      var d = collect();
      // Адресуется рабочее место, а не планшет: код места задаёт сам интегратор, он не меняется
      // при замене планшета, и внутренний dev-... наружу не отдаётся. deviceId нужен только
      // тогда, когда на одном месте стоит несколько планшетов.
      var тело = { workstationExternalId: "WS-204", fields: d.fields };
      // Массивы показываются всегда, даже пустыми: иначе по примеру не видно, как выглядят
      // чекбоксы и двойные зависимые чекбоксы, пока их не набрали.
      тело.checkboxes = d.checkboxes;
      тело.groups = d.groups;
      код.textContent = JSON.stringify(тело, null, 2);
    }
    cbArea.addEventListener("input", обновитьПример);

    function collect() {
      var fields = {}; placeholders.forEach(function (k) { fields[k] = inputs[k].value; });
      // Именованный чекбокс документа задаётся по имени: сервер поймёт, что это он, и поставит
      // отметку на его месте, а не допишет новый пункт в конец страницы.
      var checkboxes = keys.checks.map(function (k) { return { key: k, checked: !!cbState[k] }; });
      (cbArea.value || "").split("\n").forEach(function (line) {
        var t = line.trim(); if (!t) return;
        var checked = t.charAt(0) === "+";
        checkboxes.push({ label: checked ? t.slice(1).trim() : t, checked: checked, required: false });
      });
      var groups = groupNames.map(function (g) { return { key: g, selected: groupSel[g].value }; });
      return { fields: fields, checkboxes: checkboxes, groups: groups };
    }

    // Пример собирается после collect(), потому что берёт из него готовое тело запроса.
    обновитьПример();
    c.addEventListener("change", обновитьПример);
    c.addEventListener("input", обновитьПример);

    var go = iconBtn("eye", "Показать предпросмотр", "btn-primary");
    go.addEventListener("click", function () {
      var d = collect();
      runPreview(d.fields, d.checkboxes, d.groups);
    });
    c.appendChild(go);

    // Отправка тех же данных на настоящий планшет: то же самое, что прислала бы внешняя
    // система. Нужно, чтобы проверить документ на живом экране, а не только в окне.
    if (state.devices.length) {
      c.appendChild(checkOnTabletRow(collect));
    }

    openModal(c);
    if (placeholders.length && inputs[placeholders[0]]) inputs[placeholders[0]].focus();
  }

  // Тег в документе может быть записан в другом регистре, чем в списке известных: сервер
  // сравнивает имена без учёта регистра, и редактор обязан вести себя так же. Иначе «ПОЛ»
  // остаётся полем для ручного ввода без списка значений и без образца, хотя «Пол» их имеет.
  // Подпись значения там, где значение на проводе и слово на экране это разные вещи.
  function valueLabel(field, value) {
    var k = (field || "").trim();
    var map = FIELD_LABELS[k];
    if (!map) {
      var lk = k.toLowerCase();
      for (var key in FIELD_LABELS) if (key.toLowerCase() === lk) { map = FIELD_LABELS[key]; break; }
    }
    if (!map) return value;
    if (map[value]) return map[value];
    var lv = String(value || "").toLowerCase();
    for (var v in map) if (v.toLowerCase() === lv) return map[v];
    return value;
  }

  function fieldValues(name) {
    var k = (name || "").trim();
    if (FIELD_VALUES[k]) return FIELD_VALUES[k];
    var lk = k.toLowerCase();
    for (var key in FIELD_VALUES) if (key.toLowerCase() === lk) return FIELD_VALUES[key];
    return null;
  }

  // Sensible sample values so the operator can preview without typing everything.
  function previewDefault(tag) {
    var map = {
      "ФИО": "Иванова Анна Петровна", "ДР": "01.01.1990", "Адрес регистрации": "г. Минск, ул. Ленина 1",
      "Пол": "F", "email": "anna@example.by", "telephone": "+375291234567",
      "document": "MP1234567", "date": new Date().toLocaleDateString("ru-RU"),
      "cross-border": "true", "urine": "true", "UG": "true"
    };
    if (map[tag]) return map[tag];
    var lt = String(tag || "").toLowerCase();
    for (var k in map) if (k.toLowerCase() === lt) return map[k];
    return /^text\d+$/.test(lt) ? "Текст из внешней системы" : "";
  }

  // Строка «проверить на планшете»: те же тестовые значения уходят на выбранный планшет ровно
  // так, как их прислала бы внешняя система. Одна и та же строка и в окне ввода значений, и в
  // самом предпросмотре: решение «выглядит правильно, посмотрю на живом экране» приходит и там,
  // и там.
  function checkOnTabletRow(collect) {
    var row = el("div", "pv-setup-send");
    if (!state.devices.length) {
      row.appendChild(el("span", "sig-meta", "Проверить на планшете нельзя: планшетов пока нет."));
      return row;
    }
    var sel = el("select", "sch-target");
    fillDeviceSelect(sel, state.docTarget);
    row.appendChild(el("span", "sig-meta", "Планшет:"));
    row.appendChild(sel);
    var send = iconBtn("send", "Проверить на планшете", "btn-ghost");
    send.title = "Отправить эти же тестовые значения на выбранный планшет ровно так, как их прислала бы внешняя система. Документ появится на его экране.";
    send.addEventListener("click", function () {
      var d = collect();
      apiSend("/show-document", "POST", { target: sel.value, fields: d.fields, checkboxes: d.checkboxes, groups: d.groups })
        .then(function () { closeModal(); toast("Отправлено на планшет: " + targetLabel(sel.value)); });
    });
    row.appendChild(send);
    return row;
  }

  function runPreview(fields, checkboxes, groups) {
    apiSend("/document/preview", "POST", { document: state.doc, fields: fields, checkboxes: checkboxes, groups: groups })
      .then(function (r) { return r.json(); })
      .then(function (data) { renderPreview(data, fields, checkboxes, groups); })
      .catch(function (e) {
        // Сетевую ошибку уже показал api(). А вот поломку самой отрисовки раньше глушил пустой
        // catch: окно просто не открывалось, и понять почему было нельзя.
        if (e) { console.error(e); toast("Не удалось построить предпросмотр: " + (e.message || e)); }
      });
  }

  // Mirrors the tablet renderer (kiosk.js): styled runs, images, checkboxes, page steps.
  // Оформленный текст подписи пункта: когда оформления нет, из простого текста делается один
  // кусок, и дальше всё рисуется одинаково.
  function labelRuns(runs, plain) {
    if (runs && runs.length) return runs;
    return plain ? [{ text: plain }] : [];
  }

  // Подпись с оформлением плюс звёздочка обязательного одним куском разметки.
  function labelNode(cls, runs, plain, required) {
    var n = el("span", cls);
    previewRuns(n, labelRuns(runs, plain));
    if (required) n.appendChild(el("span", "req", " *"));
    return n;
  }

  function previewRuns(parent, runs) {
    (runs || []).forEach(function (r) {
      String(r && r.text != null ? r.text : "").split("\n").forEach(function (seg, i) {
        if (i > 0) parent.appendChild(document.createElement("br"));
        if (!seg.length) return;
        var span = el("span", r.size === "l" ? "rt-l" : r.size === "h" ? "rt-h" : null, seg);
        if (r.bold) span.style.fontWeight = "700";
        if (r.italic) span.style.fontStyle = "italic";
        if (r.color && /^#[0-9a-fA-F]{6}$/.test(r.color)) span.style.color = r.color;
        parent.appendChild(span);
      });
    });
  }
  function previewBlock(parent, b) {
    if (b && b.imageUrl && /^\/media\/[^/\\]+$/.test(b.imageUrl)) {
      var fig = el("div", "pv-image");
      var ia = (b && b.align || "").toLowerCase();
      if (ia === "center" || ia === "right" || ia === "justify") fig.style.textAlign = ia === "justify" ? "left" : ia;
      else fig.style.textAlign = "left";
      var wrap = (b && b.wrap || "").toLowerCase();
      var im = el("img"); im.src = b.imageUrl;
      if (wrap === "left" || wrap === "right") {
        var зазор = Math.max(0, Math.min(60, parseInt(b.wrapGap, 10) || 0));
        fig.className = "pv-image pv-image-wrap";
        fig.style.cssFloat = wrap;
        fig.style.width = Math.min(Math.max(parseInt(b.imageWidth, 10) || 100, 10), 70) + "%";
        fig.style.textAlign = "";
        fig.style.margin = wrap === "left"
          ? "0 " + зазор + "px " + зазор + "px 0"
          : "0 0 " + зазор + "px " + зазор + "px";
        im.style.width = "100%";
      } else {
        im.style.width = Math.min(Math.max(parseInt(b.imageWidth, 10) || 100, 10), 100) + "%";
      }
      fig.appendChild(im); parent.appendChild(fig);
    } else {
      var t = el("div", "pv-text");
      var al = (b && b.align || "").toLowerCase();
      if (al === "center" || al === "right" || al === "justify") t.style.textAlign = al;
      previewRuns(t, (b && b.runs) || []);
      parent.appendChild(t);
    }
  }

  function renderPreview(data, fields, checkboxes, groups) {
    var doc = (data && data.document) || { pages: [] };
    var pages = doc.pages || [];
    var screens = pages.map(function (_, i) { return { type: "page", index: i }; });
    screens.push({ type: "signature" });
    var idx = 0;

    // Предпросмотр повторяет планшет не только видом, но и поведением: пункты отмечаются,
    // в группах выбирается один вариант, условия на отметки пересчитываются на месте, а
    // «Далее» не пускает дальше, пока не отмечено обязательное. Без этого блок, который
    // появляется по отметке клиента, нельзя было проверить вообще: он не показывался никогда.
    var checks = {};   // "p{страница}_c{номер}" -> отмечен
    var picks = {};    // имя группы -> имя выбранного варианта ("" = ничего)
    pages.forEach(function (p, pi) {
      (p.checkboxes || []).forEach(function (cb, ci) { if (cb && cb.checked) checks["p" + pi + "_c" + ci] = true; });
      (p.groups || []).forEach(function (g) { if (g && g.key) picks[g.key] = g.selected || ""; });
    });

    // Значение имени, на которое ссылается условие. Скрытый пункт считается неотмеченным:
    // так взаимные ссылки разрешаются сами и не зацикливаются. Точно как на планшете.
    function liveValue(key) {
      if (Object.prototype.hasOwnProperty.call(picks, key)) return picks[key] || "";
      var found = "";
      pages.forEach(function (p, pi) {
        (p.checkboxes || []).forEach(function (cb, ci) {
          if (cb && cb.key === key) found = checks["p" + pi + "_c" + ci] ? "true" : "false";
        });
      });
      return found;
    }
    // Точно как на планшете, включая «не»: предпросмотр обязан показывать то же самое.
    function partHolds(c) {
      var ok = partValue(c);
      return c.not ? !ok : ok;
    }
    function partValue(c) {
      var val = String(liveValue(c.field) || "").trim().toLowerCase();
      var target = String(c.value || "").trim().toLowerCase();
      switch (c.op) {
        case "ne": return val !== target;
        case "empty": return val.length === 0;
        case "notempty": return val.length > 0;
        case "in": return target.split(",").map(function (x) { return x.trim(); })
          .filter(function (x) { return x.length; }).indexOf(val) >= 0;
        default: return val === target;
      }
    }
    function holds(cond) {
      if (!cond) return true;
      var groups = condGroups(cond);
      for (var i = 0; i < groups.length; i++) {
        var parts = condParts(groups[i]), ok = true;
        for (var j = 0; j < parts.length; j++) if (!partHolds(parts[j])) { ok = false; break; }
        if (ok) return true;
      }
      return false;
    }
    function shown(list) { return (list || []).filter(function (x) { return x && holds(x.visibleWhen); }); }
    function screenShown(s) {
      if (s.type !== "page") return true;
      var p = pages[s.index];
      return !!p && holds(p.visibleWhen);
    }
    function step(from, dir) {
      for (var i = from + dir; i >= 0 && i < screens.length; i += dir) if (screenShown(screens[i])) return i;
      return -1;
    }
    function requiredOk(pageIndex) {
      var p = pages[pageIndex];
      if (!p) return true;
      var ok = true;
      (p.checkboxes || []).forEach(function (cb, ci) {
        if (cb.required && holds(cb.visibleWhen) && !checks["p" + pageIndex + "_c" + ci]) ok = false;
      });
      (p.groups || []).forEach(function (g) {
        if (g.required && holds(g.visibleWhen) && !(picks[g.key] || "")) ok = false;
      });
      return ok;
    }

    var c = el("div", "preview-wrap");
    var head = el("div", "pv-head");
    head.appendChild(el("h3", null, "Предпросмотр: так увидит клиент"));
    var stats = el("div", "sig-meta",
      "Страниц показано: " + data.pagesShown + " из " + data.pagesTotal +
      (data.missingPlaceholders && data.missingPlaceholders.length ? " · Не заполнены: " + data.missingPlaceholders.join(", ") : ""));
    head.appendChild(stats);
    head.appendChild(el("div", "pv-hint", "Пункты можно отмечать: условия показа пересчитываются так же, как на планшете."));
    c.appendChild(head);

    var frame = el("div", "pv-frame");
    var title = el("div", "pv-title"); frame.appendChild(title);
    var progress = el("div", "pv-progress"); frame.appendChild(progress);
    var body = el("div", "pv-body"); frame.appendChild(body);
    var footer = el("div", "pv-footer"); frame.appendChild(footer);
    c.appendChild(frame);

    var back = el("button", "btn btn-ghost", "Назад");
    var note = el("div", "pv-note");
    var next = el("button", "btn btn-primary", "Далее");
    footer.appendChild(back); footer.appendChild(note); footer.appendChild(next);
    back.addEventListener("click", function () { var to = step(idx, -1); if (to >= 0) { idx = to; draw(); } });
    next.addEventListener("click", function () {
      var s = screens[idx];
      if (s.type === "page" && !requiredOk(s.index)) return;
      var to = step(idx, 1); if (to >= 0) { idx = to; draw(); }
    });

    function makeCheck(cb, pageIndex, ci) {
      var key = "p" + pageIndex + "_c" + ci;
      var label = el("label", "pv-check pv-live" + (checks[key] ? " on" : ""));
      var input = document.createElement("input");
      input.type = "checkbox"; input.checked = !!checks[key];
      input.addEventListener("change", function () { checks[key] = input.checked; draw(); });
      label.appendChild(input);
      label.appendChild(labelNode(null, cb.labelRuns, cb.label, cb.required));
      return label;
    }

    // Группа: выбрать можно один вариант, повторное нажатие снимает выбор. Это чекбоксы, а не
    // радиокнопки, потому что «не выбрано» тоже состояние. Так же устроено на планшете.
    function makeGroup(g) {
      var box = el("div", "pv-group");
      if (g.title || (g.titleRuns || []).length) {
        var gt = el("div", "pv-group-title");
        previewRuns(gt, labelRuns(g.titleRuns, g.title));
        if (g.required) gt.appendChild(el("span", "req", " *"));
        box.appendChild(gt);
      }
      (g.options || []).forEach(function (o) {
        var chosen = (picks[g.key] || "") === o.key;
        var label = el("label", "pv-check pv-live" + (chosen ? " on" : ""));
        var input = document.createElement("input");
        input.type = "checkbox"; input.checked = chosen;
        input.addEventListener("change", function () {
          picks[g.key] = input.checked ? o.key : "";
          draw();
        });
        label.appendChild(input);
        label.appendChild(labelNode(null, o.labelRuns, o.label || o.key, false));
        box.appendChild(label);
      });
      if (!(picks[g.key] || "")) box.appendChild(el("div", "sig-meta", "Вариант не выбран."));
      return box;
    }

    function draw() {
      var s = screens[idx];
      if (!screenShown(s)) {
        var to = step(idx, 1); if (to < 0) to = step(idx, -1);
        if (to >= 0 && to !== idx) { idx = to; return draw(); }
      }
      title.textContent = doc.title || "";
      var всего = 0, текущий = 0;
      screens.forEach(function (x, i) {
        if (!screenShown(x)) return;
        всего++; if (i === idx) текущий = всего;
      });
      progress.textContent = "Шаг " + текущий + " из " + всего;
      body.innerHTML = "";
      if (s.type === "page") {
        var p = pages[s.index];
        var h = el("h2", "pv-heading");
        var ha = (p.headingAlign || "").toLowerCase();
        if (ha === "center" || ha === "right" || ha === "justify") h.style.textAlign = ha;
        previewRuns(h, p.headingRuns || []); body.appendChild(h);
        // Порядок ровно тот же, что покажет планшет: иначе предпросмотр обещал бы одно, а
        // клиент видел другое, и проверять по нему было бы нечего.
        pageOrder(p).forEach(function (it) {
          if (!holds(it.item.visibleWhen)) return;
          if (it.kind === 0) { previewBlock(body, it.item); return; }
          if (it.kind === 1) { body.appendChild(makeCheck(it.item, s.index, it.index)); return; }
          if (it.kind === 2) { body.appendChild(makeGroup(it.item)); return; }
          // Подпись и сканирование показываются местом, которое они займут: рисовать в
          // предпросмотре настоящее перо незачем, а вот где они стоят, видеть надо.
          if (it.kind === 3) {
                var sw = el("div", "pv-inline-sign");
            sw.appendChild(el("div", "pv-inline-title", (it.item.label || "Поле подписи") + (it.item.required ? " *" : "")));
            var pad = el("div", "pv-pad", "Распишитесь здесь");
            // Размер и положение места подписи видны и в предпросмотре: иначе оператор узнавал
            // бы о том, что подпись занимает пол-листа, только по готовому PDF.
            pad.style.width = Math.round(Math.max(60, Math.min(495, parseInt(it.item.width, 10) || 280)) / 495 * 1000) / 10 + "%";
            pad.style.height = Math.round(Math.max(40, Math.min(300, parseInt(it.item.height, 10) || 100)) * 1.3) + "px";
            var па = (it.item.align || "").toLowerCase();
            pad.style.marginLeft = (па === "center" || па === "right") ? "auto" : "0";
            pad.style.marginRight = (па === "center") ? "auto" : (па === "right" ? "0" : "auto");
            sw.appendChild(pad);
            body.appendChild(sw);
            return;
          }
          var cw = el("div", "pv-inline-scan");
          cw.appendChild(el("div", "pv-inline-title", (it.item.label || "Отсканируйте код") + (it.item.required ? " *" : "")));
          cw.appendChild(el("div", "pv-scan-btn", "Сканировать код"));
          body.appendChild(cw);
        });
      } else {
        // Порядок ровно как на планшете: блоки над подписью, надпись, само поле, блоки под
        // подписью. Раньше здесь рисовались два поля подписи, а нижние блоки оказывались выше
        // надписи, и предпросмотр обещал не тот экран, который увидит клиент.
        shown(doc.signBlocks).forEach(function (b) { previewBlock(body, b); });
        body.appendChild(el("div", "pv-prompt", doc.signPrompt || ""));
        body.appendChild(el("div", "pv-pad", "Распишитесь здесь"));
        shown(doc.signBlocksBelow).forEach(function (b) { previewBlock(body, b); });
      }
      var ok = s.type !== "page" || requiredOk(s.index);
      back.disabled = step(idx, -1) < 0;
      next.disabled = step(idx, 1) < 0 || !ok;
      note.textContent = ok ? "" : "Отметьте обязательные пункты (*) для продолжения";
    }
    draw();

    var again = iconBtn("back", "Изменить значения", "btn-ghost");
    again.addEventListener("click", function () { closeModal(); openPreviewSetup(previewFields()); });
    c.appendChild(again);
    c.appendChild(checkOnTabletRow(function () {
      return { fields: fields, checkboxes: checkboxes, groups: groups };
    }));
    openModal(c);
  }

  // ---- Backup: export all pages to a file, import them back ----
  // Export saves what is currently in the editor, so unsaved edits are included in the backup.
  // Картинки, на которые ссылается документ, читаются из медиатеки и кладутся в файл целиком.
  // Иначе шаблон, перенесённый на другой сервер, показывал бы пустые рамки вместо печатей.
  function собратьКартинки(doc) {
    var файлы = [], seen = {};
    function add(b) {
      var u = b && b.imageUrl;
      if (!u || !/^\/media\/[^/\\]+$/.test(u)) return;
      var name = u.slice("/media/".length);
      if (seen[name]) return;
      seen[name] = 1; файлы.push(name);
    }
    (doc.pages || []).forEach(function (p) { (p.blocks || []).forEach(add); });
    (doc.signBlocks || []).forEach(add);
    (doc.signBlocksBelow || []).forEach(add);
    return Promise.all(файлы.map(function (name) {
      return fetch("/media/" + name, { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.blob() : null; })
        .then(function (b) {
          if (!b) return null;
          return new Promise(function (res) {
            var fr = new FileReader();
            fr.onload = function () {
              var s = String(fr.result);
              var i = s.indexOf(",");
              res({ file: name, data: i >= 0 ? s.slice(i + 1) : "" });
            };
            fr.onerror = function () { res(null); };
            fr.readAsDataURL(b);
          });
        })
        .catch(function () { return null; });
    })).then(function (list) { return list.filter(Boolean); });
  }

  $("exportDoc").addEventListener("click", function () {
    saveDoc().then(function () { return собратьКартинки(state.doc); }).then(function (images) {
      var payload = { kind: "helix-signtablet-document", version: 2, exportedUtc: new Date().toISOString(),
        document: state.doc, images: images };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
      a.href = url;
      a.download = "signtablet-document-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast(images.length ? ("Файл с шаблоном сохранён, картинок внутри: " + images.length)
        : "Файл с шаблоном сохранён");
    });
  });

  $("importDoc").addEventListener("click", function () { $("importDocFile").click(); });
  $("importDocFile").addEventListener("change", function () {
    var input = this, file = input.files && input.files[0];
    if (!file) return;
    if (!confirm("Файл будет добавлен в библиотеку новым документом. Открытый документ не изменится. Продолжить?")) { input.value = ""; return; }
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(reader.result); }
      catch (e) { toast("Файл повреждён: это не JSON"); input.value = ""; return; }
      // api() already reports a server-side rejection (wrong file, no pages), so success here
      // means the template really was replaced.
      apiSend("/document/import", "POST", parsed)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          // Импортированный документ сразу открывается: иначе оператор не понимает, куда он
          // делся, и ищет его в списке.
          if (j && j.id) state.docId = j.id;
          return loadLibrary().then(function () { return loadDoc(j && j.id); }).then(function () {
            renderLibrary();
            var хвост = j && j.images ? (", восстановлено картинок: " + j.images) : "";
            toast("Документ добавлен в библиотеку под кодом " + ((j && j.code) || "?") +
              ". Страниц: " + (j && j.pages != null ? j.pages : "") + хвост);
          });
        })
        .catch(function () { /* already reported by api() */ })
        .then(function () { input.value = ""; });
    };
    reader.readAsText(file);
  });

  // Планшет из адресата вида device:{id}. Нужно, чтобы сказать, на связи он или нет: от этого
  // зависит, увидит ли клиент документ сейчас или он дождётся подключения.
  function targetDevice(target) {
    var id = String(target || "").replace(/^device:/, "");
    return state.devices.filter(function (d) { return d.id === id; })[0] || null;
  }

  function doShowDocument(fields) {
    var dev = targetDevice(state.docTarget);
    apiSend("/show-document", "POST", { target: state.docTarget, fields: fields })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        // Говорим то, что произошло на самом деле. Планшету не на связи документ сохраняется и
        // появится при подключении, а сообщение «документ показан» заставляло оператора идти
        // смотреть на экран, где ничего не изменилось.
        if (dev && !dev.online) {
          toast("Отправлено, но планшет «" + dev.name + "» сейчас не на связи. Документ появится, как только он подключится.");
        } else {
          toast("Документ показан (" + targetLabel(state.docTarget) + ")");
        }
        if (j && j.missingPlaceholders && j.missingPlaceholders.length)
          setTimeout(function () { toast("Не заполнены: " + j.missingPlaceholders.join(", ")); }, 1500);
      });
  }
  function openFieldsModal(placeholders) {
    var c = el("div");
    c.appendChild(el("h3", null, "Данные для документа"));
    var dev = targetDevice(state.docTarget);
    c.appendChild(el("p", "sig-meta", "Значения подставятся в плейсхолдеры и отправятся на: " + targetLabel(state.docTarget)));
    // Состояние адресата видно до отправки, а не выясняется по молчащему экрану.
    if (dev && !dev.online)
      c.appendChild(el("div", "note-box note-warn",
        "Планшет «" + dev.name + "» сейчас не на связи. Документ сохранится и появится на нём, как только он подключится. " +
        "Если нужно показать прямо сейчас, выберите другой планшет в списке над кнопками."));
    var inputs = {};
    placeholders.forEach(function (k) {
      var known = fieldValues(k);
      if (known) {
        var wrap = el("label", "field", k);
        var sel = el("select");
        sel.appendChild(new Option("не передавать", ""));
        known.forEach(function (v) { sel.appendChild(new Option(valueLabel(k, v), v)); });
        wrap.appendChild(sel); c.appendChild(wrap); inputs[k] = sel;
      } else {
        var f = labeledInput(k, ""); c.appendChild(f.wrap); inputs[k] = f.input;
      }
    });

    // Это окно отправляет документ живому человеку, поэтому вымышленные значения сами тут не
    // подставляются: подписать чужое имя хуже, чем набрать своё. Но для проверки они нужны, и
    // одна кнопка заполняет всё сразу.
    var sample = iconBtn("copy", "Заполнить примером (для проверки)", "btn-ghost");
    sample.title = "Подставить вымышленные значения во все поля. Нужно, чтобы быстро проверить документ на планшете.";
    sample.addEventListener("click", function () {
      placeholders.forEach(function (k) {
        var input = inputs[k];
        var known = fieldValues(k);
        if (known) {
          var want = previewDefault(k);
          input.value = known.indexOf(want) >= 0 ? want : known[0];
        } else {
          input.value = previewDefault(k);
        }
      });
      toast("Поля заполнены примером. Проверьте перед отправкой.");
    });
    c.appendChild(sample);

    var btn = iconBtn("send", "Отправить на планшет", "btn-primary");
    btn.addEventListener("click", function () {
      var fields = {}; placeholders.forEach(function (k) { fields[k] = inputs[k].value; });
      closeModal(); doShowDocument(fields);
    });
    c.appendChild(btn);
    openModal(c);
    if (inputs[placeholders[0]]) inputs[placeholders[0]].focus();
  }
  $("showDocument").addEventListener("click", function () {
    if (!state.devices.length) { toast("Планшетов пока нет. Заведите планшет на вкладке «Планшеты»."); return; }
    if (!/^device:/.test(state.docTarget)) { toast("Выберите планшет. Документ показывается только на один планшет."); return; }
    collectDoc();
    var proceed = function () {
      saveDoc().then(function () {
        // Именно previewFields, а не только теги из текста: тег, использованный лишь в условии,
        // иначе не спрашивался, значение уходило пустым, и блок молча не показывался.
        var fields = previewFields();
        if (fields.length) openFieldsModal(fields);
        else doShowDocument(null);
      });
    };
    // Перед клиентом уже поздно: показываем замечания здесь, но не запрещаем отправку.
    var problems = validateDoc();
    if (problems.length) showProblems(problems, proceed); else proceed();
  });
  (function () {
    var docPanel = document.querySelector('[data-panel="document"]');
    if (docPanel) docPanel.addEventListener("input", updatePlaceholders);
  })();
  $("showSlides").addEventListener("click", function () {
    if (!/^device:/.test(state.docTarget)) { toast("Выберите планшет."); return; }
    apiSend("/show-slides", "POST", { target: state.docTarget }).then(function () { toast("Реклама возвращена (" + targetLabel(state.docTarget) + ")"); });
  });

  // ---------------- Signatures ----------------
  function loadSignatures() {
    return apiJson("/signatures").then(function (list) {
      var wrap = $("signaturesList"); wrap.innerHTML = "";
      if (!list.length) { wrap.innerHTML = '<div class="empty-note">Пока нет подписей.</div>'; return; }
      list.forEach(function (s) {
        var item = el("div", "sig-item");
        var col = el("div");
        col.appendChild(el("div", "when", new Date(s.createdUtc).toLocaleString("ru-RU")));
        var where = (s.workstationName ? s.workstationName + " · " : "") + (s.deviceName || s.deviceId || "-");
        col.appendChild(el("div", "meta", where + " · " + (s.documentTitle || "")));
        item.appendChild(col);
        item.appendChild(el("div", "badge", "отмечено " + s.checkedCount + " из " + s.totalCount));
        item.addEventListener("click", function () { openSignature(s.id); });
        wrap.appendChild(item);
      });
    });
  }
  function openSignature(id) {
    apiJson("/signatures/" + id).then(function (rec) {
      var c = el("div");
      c.appendChild(el("h3", null, rec.documentTitle || "Подпись"));
      var where = (rec.workstationName ? rec.workstationName + " · " : "") + (rec.deviceName || rec.deviceId || "-");
      c.appendChild(el("div", "sig-meta", new Date(rec.createdUtc).toLocaleString("ru-RU") + " · " + where));
      if (rec.fields && Object.keys(rec.fields).length) {
        c.appendChild(el("div", "field-caption", "Данные подписанта"));
        var fl = el("div", "field-list");
        Object.keys(rec.fields).forEach(function (k) {
          var row = el("div", "field-row");
          row.appendChild(el("span", "field-key", k));
          row.appendChild(el("span", "field-val", rec.fields[k]));
          fl.appendChild(row);
        });
        c.appendChild(fl);
      }
      var list = el("div", "item-list");
      (rec.items || []).forEach(function (it) {
        var row = el("div", "item " + (it.checked ? "on" : "off"));
        row.appendChild(el("span", "tick", it.checked ? "Да" : "Нет"));
        row.appendChild(el("span", null, it.label)); list.appendChild(row);
      });
      if (!(rec.items || []).length) list.appendChild(el("div", "empty-note", "Без чекбоксов"));
      c.appendChild(list);
      var img = el("img", "sig-image"); img.src = "/api/admin/signatures/" + id + "/image"; img.alt = "Подпись"; c.appendChild(img);
      var dl = document.createElement("a");
      dl.className = "btn btn-ghost"; dl.appendChild(icon("download")); dl.appendChild(el("span", null, "Скачать PDF"));
      dl.href = "/api/admin/signatures/" + id + "/pdf"; dl.target = "_blank";
      dl.style.cssText = "display:inline-block;margin-top:12px;text-decoration:none;";
      c.appendChild(dl);
      openModal(c);
    });
  }
  $("reloadSignatures").addEventListener("click", loadSignatures);

  // ---------------- Devices ----------------
  function loadDevices() {
    return apiJson("/devices").then(function (list) { state.devices = list; populateDeviceFilters(); renderDevices(); renderTargetOptions(); });
  }

  function populateDeviceFilters() {
    var gSel = $("devGroupFilter"), wSel = $("devWsFilter");
    if (!gSel || !wSel) return;
    var gCur = devFilter.groupId, wCur = devFilter.wsId;
    gSel.innerHTML = ""; gSel.appendChild(new Option("Все группы", ""));
    state.groups.forEach(function (g) { gSel.appendChild(new Option(g.name, g.id)); });
    gSel.value = state.groups.some(function (g) { return g.id === gCur; }) ? gCur : "";
    devFilter.groupId = gSel.value;
    wSel.innerHTML = ""; wSel.appendChild(new Option("Все места", ""));
    state.workstations.forEach(function (w) { wSel.appendChild(new Option(w.name || w.id, w.id)); });
    wSel.value = state.workstations.some(function (w) { return w.id === wCur; }) ? wCur : "";
    devFilter.wsId = wSel.value;
  }

  function matchesDeviceFilter(d) {
    if (devFilter.status === "online" && !d.online) return false;
    if (devFilter.status === "offline" && (d.online || d.status === "revoked")) return false;
    if (devFilter.status === "revoked" && d.status !== "revoked") return false;
    if (devFilter.groupId && (d.groupIds || []).indexOf(devFilter.groupId) < 0) return false;
    if (devFilter.wsId && d.workstationId !== devFilter.wsId) return false;
    var q = devFilter.q.trim().toLowerCase();
    if (q) {
      var hay = ((d.name || "") + " " + (d.id || "")).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }

  function renderDevices() {
    var wrap = $("devicesList"); wrap.innerHTML = "";
    var countEl = $("devFilterCount");
    if (!state.devices.length) {
      wrap.innerHTML = '<div class="empty-note">Планшетов пока нет. Нажмите «Добавить планшет (код)».</div>';
      if (countEl) countEl.textContent = "";
      return;
    }
    var shown = state.devices.filter(matchesDeviceFilter);
    if (countEl) countEl.textContent = "Показано " + shown.length + " из " + state.devices.length;
    if (!shown.length) { wrap.innerHTML = '<div class="empty-note">Ничего не найдено по заданным фильтрам.</div>'; return; }
    shown.forEach(function (d) {
      var item = el("div", "dev-item" + (d.status === "revoked" ? " revoked" : ""));
      item.appendChild(el("div", "dot" + (d.online ? " online" : "")));
      var info = el("div", "dev-info");
      var nameRow = el("div", "dev-name");
      nameRow.appendChild(el("strong", null, d.name));
      if (d.status === "revoked") nameRow.appendChild(el("span", "chip chip-danger", "заблокирован"));
      else if (d.online) nameRow.appendChild(el("span", "chip chip-ok", "онлайн"));
      else nameRow.appendChild(el("span", "chip chip-muted", "офлайн"));
      info.appendChild(nameRow);

      // Workstation: name, external ID and description (location).
      var ws = d.workstation;
      if (ws) {
        var wsRow = el("div", "dev-meta");
        wsRow.appendChild(el("span", null, "Рабочее место: " + (ws.name || "-")));
        if (ws.externalId) {
          // Внешний код рабочего места это обычный способ адресации из внешней системы:
          // она уже знает свой код стойки и не должна знать внутренние идентификаторы.
          wsRow.appendChild(el("span", "dev-sep", "   ·   "));
          wsRow.appendChild(el("span", null, "код для API: "));
          var wsCode = el("code", "dev-id-code", ws.externalId);
          wsCode.title = "Этот код передаётся в API как workstationExternalId. Нажмите, чтобы скопировать.";
          wsCode.addEventListener("click", function () { copyText(ws.externalId, "Код рабочего места скопирован"); });
          wsRow.appendChild(wsCode);
        }
        if (ws.location) {
          wsRow.appendChild(el("span", "dev-sep", "   ·   "));
          wsRow.appendChild(el("span", null, "описание: " + ws.location));
        }
        info.appendChild(wsRow);
      } else {
        info.appendChild(el("div", "dev-meta", "Рабочее место: не привязано"));
      }

      // Group(s) the tablet belongs to.
      var groupsText = (d.groups && d.groups.length) ? d.groups.join(", ") : "без группы";
      info.appendChild(el("div", "dev-meta", "Группа: " + groupsText));

      // Внутренний идентификатор планшета. Внешняя система обычно им не пользуется: она
      // адресует по коду рабочего места. Но этот же идентификатор стоит в логах, в
      // уведомлениях и в записях подписей, и он нужен, когда к одному рабочему месту
      // привязано несколько планшетов: тогда API просит указать планшет прямо.
      var idRow = el("div", "dev-meta dev-id");
      idRow.appendChild(el("span", null, "ID планшета: "));
      var idCode = el("code", "dev-id-code", d.id);
      idCode.title = "Внутренний идентификатор. Он стоит в логах и в записях подписей. " +
        "В API нужен, только если адресовать планшет напрямую, а не по коду рабочего места. " +
        "Нажмите, чтобы скопировать.";
      idCode.addEventListener("click", function () { copyText(d.id, "ID планшета скопирован"); });
      idRow.appendChild(idCode);
      info.appendChild(idRow);

      info.appendChild(el("div", "dev-meta", d.online
        ? "Связь: на связи сейчас"
        : "Последняя связь: " + (d.lastSeenUtc ? new Date(d.lastSeenUtc).toLocaleString("ru-RU") : "-")));
      info.appendChild(el("div", "dev-meta", (d.online ? "Текущий IP: " : "Последний IP: ") + (d.lastIp || "-") +
        (d.controlIp ? "   ·   Адрес управления: " + d.controlIp + (d.controlPort ? ":" + d.controlPort : "") : "")));

      // Which build of the kiosk page the tablet is really running. A tablet whose WebView has not
      // reloaded since an older deploy keeps showing ads and answering nothing else, and this is
      // the only place that difference is visible.
      if (d.online) {
        if (!d.appVersion) {
          var oldPage = el("div", "dev-meta dev-health warn",
            "На планшете открыта старая версия страницы. Новые функции работать не будут: " +
            "обновите страницу на планшете (кнопка «Управление», затем «Обновить страницу»).");
          info.appendChild(oldPage);
        } else if (d.appVersion !== APP_VERSION) {
          info.appendChild(el("div", "dev-meta dev-health warn",
            "Версия страницы на планшете: " + d.appVersion + ", на сервере: " + APP_VERSION +
            ". Обновите страницу на планшете."));
        }
      }

      // Health read from the tablet itself (FreeKiosk API), when tablet control is configured.
      var kc = state.kioskControl || {};
      var h = d.health;
      if (h) {
        if (h.reachable) {
          var parts = [];
          var lowBattery = false, lowStorage = false;
          if (h.batteryPercent != null) {
            lowBattery = h.batteryPercent <= (kc.batteryWarnPercent != null ? kc.batteryWarnPercent : 20) && h.charging !== true;
            parts.push("Заряд: " + h.batteryPercent + "%" + (h.charging ? "\u00A0(заряжается)" : ""));
          }
          if (h.wifiSignalPercent != null) parts.push("Wi-Fi: " + h.wifiSignalPercent + "%");
          if (h.storageFreePercent != null) {
            lowStorage = h.storageFreePercent <= (kc.storageWarnPercent != null ? kc.storageWarnPercent : 10);
            parts.push("Свободно: " + h.storageFreePercent + "%");
          }
          if (h.deviceOwner != null) parts.push("Device\u00A0Owner: " + (h.deviceOwner ? "да" : "нет"));
          if (h.appVersion) parts.push("FreeKiosk\u00A0" + h.appVersion);
          // The reading is up to 5 minutes old, and it sits right under the live connection state,
          // so say when it was taken instead of letting it read as "now".
          if (h.checkedUtc) parts.push("проверено\u00A0" + new Date(h.checkedUtc).toLocaleTimeString("ru-RU"));
          if (parts.length) {
            var row = el("div", "dev-meta dev-health", parts.join("   ·   "));
            if (lowBattery || lowStorage) row.classList.add("warn");
            info.appendChild(row);
          }
          // The tablet answered but we could not read its reply: that is not a healthy tablet,
          // and without this line it would look identical to one.
          if (h.error) info.appendChild(el("div", "dev-meta dev-health warn", h.error));
        } else if (h.error) {
          // A tablet that is off or out of range is an everyday state, not an alarm: the loud
          // version of this belongs to the "tablet off air" alert, not to every card.
          info.appendChild(el("div", "dev-meta dev-health", "Управление недоступно: " + h.error));
        }
      }
      item.appendChild(info);

      // Кнопки в том же стиле, что на странице документа: значок плюс подпись, обычные
      // действия слева, необратимые справа за разделителем. Блокировка отделена от удаления
      // намеренно: заблокированный планшет можно вернуть, удалённый нет, и одинаково красными
      // они выглядели одинаково опасными.
      var actions = el("div", "dev-actions");
      var bId = iconBtn("search", "Опознать", "btn-ghost btn-sm");
      bId.title = "Показать номер на экране планшета, чтобы понять, который из них перед вами";
      bId.addEventListener("click", function () {
        apiSend("/devices/" + d.id + "/identify", "POST", {}).then(function (r) { return r.json(); })
          .then(function (j) { toast("На планшете «" + d.name + "» показан номер " + j.code); });
      });
      actions.appendChild(bId);

      // Наблюдение за экраном. Только для планшета на связи: у выключенного смотреть нечего,
      // и кнопка отвечала бы «нет связи» вместо того, чтобы этого не предлагать.
      if (d.online) {
        var bWatch = iconBtn("eye", d.screen === "document" ? "Смотреть подписание" : "Смотреть", "btn-ghost btn-sm");
        bWatch.title = "Видеть то же, что видит клиент на планшете. Только просмотр: изменить отсюда ничего нельзя";
        bWatch.addEventListener("click", function () { openWatchWindow(d.id, d.name); });
        actions.appendChild(bWatch);
      }

      // Only offered when tablet control is switched on: otherwise every button in the modal would
      // answer "управление выключено" and the operator would be left guessing where the switch is.
      if (kc.enabled) {
        var bCtl = iconBtn("monitor", "Управление", "btn-ghost btn-sm");
        bCtl.title = "Перезагрузка, перезапуск приложения, очистка кэша, экран, снимок экрана";
        bCtl.addEventListener("click", function () { openControl(d); });
        actions.appendChild(bCtl);
      }
      var bEdit = iconBtn("settings", "Изменить", "btn-ghost btn-sm");
      bEdit.title = "Имя, рабочее место и группы планшета";
      bEdit.addEventListener("click", function () { editDevice(d); });
      actions.appendChild(bEdit);
      actions.appendChild(el("span", "tb-sep"));
      if (d.status === "revoked") {
        var bUn = iconBtn("tick", "Разблокировать", "btn-ghost btn-sm");
        bUn.title = "Вернуть планшету доступ";
        bUn.addEventListener("click", function () { apiSend("/devices/" + d.id + "/unrevoke", "POST", {}).then(loadDevices).then(function () { toast("Разблокирован"); }); });
        actions.appendChild(bUn);
      } else {
        var bRev = iconBtn("shield", "Заблокировать", "btn-warn btn-sm");
        bRev.title = "Планшет потеряет доступ. Действие обратимо: его можно разблокировать";
        bRev.addEventListener("click", function () { if (confirm("Заблокировать планшет «" + d.name + "»? Он потеряет доступ. Разблокировать можно в любой момент.")) apiSend("/devices/" + d.id + "/revoke", "POST", {}).then(loadDevices).then(function () { toast("Заблокирован"); }); });
        actions.appendChild(bRev);
      }
      var bDel = iconBtn("trash", "Удалить", "btn-danger btn-sm");
      bDel.title = "Запись планшета удаляется навсегда. Планшет придётся активировать заново";
      bDel.addEventListener("click", function () { if (confirm("Удалить планшет «" + d.name + "» полностью?\n\nЭто необратимо: планшет потеряет привязку, и его придётся активировать новым кодом. Если нужно временно закрыть доступ, используйте «Заблокировать».")) api("/devices/" + d.id, { method: "DELETE" }).then(loadDevices).then(function () { toast("Удалён"); }); });
      actions.appendChild(bDel);
      item.appendChild(actions);
      wrap.appendChild(item);
    });
  }

  // Device filter controls
  $("devSearch").addEventListener("input", function () { devFilter.q = this.value; renderDevices(); });
  $("devStatusFilter").addEventListener("change", function () { devFilter.status = this.value; renderDevices(); });
  $("devGroupFilter").addEventListener("change", function () { devFilter.groupId = this.value; renderDevices(); });
  $("devWsFilter").addEventListener("change", function () { devFilter.wsId = this.value; renderDevices(); });
  $("devFilterReset").addEventListener("click", function () {
    devFilter = { q: "", status: "", groupId: "", wsId: "" };
    $("devSearch").value = ""; $("devStatusFilter").value = "";
    $("devGroupFilter").value = ""; $("devWsFilter").value = "";
    renderDevices();
  });

  $("addDevice").addEventListener("click", function () {
    var form = el("div");
    form.appendChild(el("h3", null, "Новый планшет"));
    form.appendChild(el("p", "sig-meta", "Заполните и получите код активации. Введите его на планшете один раз."));
    var name = labeledInput("Имя планшета (напр. Ресепшн 1)", "");
    form.appendChild(name.wrap);
    var wsSel = labeledSelect("Рабочее место", [{ v: "", t: "- не привязывать -" }].concat(state.workstations.map(function (w) { return { v: w.id, t: wsOptionLabel(w) }; })));
    form.appendChild(wsSel.wrap);
    var groupsBox = el("div", "field"); groupsBox.appendChild(document.createTextNode("Группы"));
    var gWrap = el("div", "check-group");
    state.groups.forEach(function (g) {
      var l = el("label", "check-inline"); var cb = el("input"); cb.type = "checkbox"; cb.value = g.id; l.appendChild(cb); l.appendChild(document.createTextNode(" " + g.name)); gWrap.appendChild(l);
    });
    if (!state.groups.length) gWrap.appendChild(el("span", "sig-meta", "нет групп"));
    groupsBox.appendChild(gWrap); form.appendChild(groupsBox);
    var ttl = labeledInput("Код действителен, минут", "60"); ttl.input.type = "number";
    form.appendChild(ttl.wrap);
    var btn = iconBtn("plus", "Сгенерировать код", "btn-primary");
    btn.addEventListener("click", function () {
      var groupIds = Array.prototype.slice.call(gWrap.querySelectorAll("input:checked")).map(function (c) { return c.value; });
      apiSend("/devices/enroll", "POST", {
        name: name.input.value, workstationId: wsSel.select.value || null,
        groupIds: groupIds, ttlMinutes: parseInt(ttl.input.value, 10) || 60
      }).then(function (r) { return r.json(); }).then(function (j) { showEnrollCode(j); });
    });
    form.appendChild(btn);
    openModal(form);
  });

  function showEnrollCode(j) {
    var c = el("div", "enroll-result");
    c.appendChild(el("h3", null, "Код активации"));
    c.appendChild(el("div", "enroll-code", j.code));
    c.appendChild(el("p", "sig-meta", "Действует до " + new Date(j.expiresUtc).toLocaleString("ru-RU") + ". Введите этот код на планшете (экран «Активация»)."));
    c.appendChild(el("p", "sig-meta", "Или откройте на планшете ссылку: /?enroll=" + j.code));
    var done = el("button", "btn btn-primary", "Готово");
    done.addEventListener("click", function () { closeModal(); loadDevices(); });
    c.appendChild(done);
    openModal(c);
  }

  function editDevice(d) {
    var form = el("div");
    form.appendChild(el("h3", null, "Планшет: " + d.name));
    var name = labeledInput("Имя", d.name); form.appendChild(name.wrap);
    var wsSel = labeledSelect("Рабочее место", [{ v: "", t: "- не привязывать -" }].concat(state.workstations.map(function (w) { return { v: w.id, t: wsOptionLabel(w) }; })));
    wsSel.select.value = d.workstationId || ""; form.appendChild(wsSel.wrap);
    var groupsBox = el("div", "field"); groupsBox.appendChild(document.createTextNode("Группы (применятся при след. подключении)"));
    var gWrap = el("div", "check-group");
    state.groups.forEach(function (g) {
      var l = el("label", "check-inline"); var cb = el("input"); cb.type = "checkbox"; cb.value = g.id; cb.checked = (d.groupIds || []).indexOf(g.id) >= 0; l.appendChild(cb); l.appendChild(document.createTextNode(" " + g.name)); gWrap.appendChild(l);
    });
    if (!state.groups.length) gWrap.appendChild(el("span", "sig-meta", "нет групп"));
    groupsBox.appendChild(gWrap); form.appendChild(groupsBox);
    var save = iconBtn("save", "Сохранить", "btn-primary");
    save.addEventListener("click", function () {
      var groupIds = Array.prototype.slice.call(gWrap.querySelectorAll("input:checked")).map(function (c) { return c.value; });
      apiSend("/devices/" + d.id, "PUT", { name: name.input.value, workstationId: wsSel.select.value || "", groupIds: groupIds })
        .then(function () { closeModal(); return loadDevices(); }).then(function () { toast("Сохранено"); });
    });
    form.appendChild(save);
    openModal(form);
  }

  // Набор планшетов: отметки вместо одного выпадающего списка. Один и тот же вид везде, где
  // можно выбрать несколько планшетов, чтобы оператору не приходилось привыкать заново.
  // Возвращает элемент с методами: ids() отдаёт отмеченные, refresh() перерисовывает список.
  function devicePicker(selected, onChange) {
    var picked = {};
    (selected || []).forEach(function (id) { picked[id] = true; });
    var box = el("div", "sch-devices"); box.setAttribute("data-role", "devpicker");
    var count = el("span", "sch-devices-count");

    function syncCount() {
      var n = box.querySelectorAll('input[data-device]:checked').length;
      count.textContent = n ? "Отмечено планшетов: " + n
        : "Ни один планшет не отмечен: сейчас это ничего не сделает.";
      count.classList.toggle("bad", !n);
      if (onChange) onChange(n);
    }

    function render() {
      box.innerHTML = "";
      if (!state.devices.length) {
        box.appendChild(el("span", "sch-devices-empty", "Планшетов пока нет."));
        box.appendChild(count);
        syncCount();
        return;
      }
      var all = el("button", "sch-dev sch-dev-all", "Отметить все");
      all.type = "button";
      all.addEventListener("click", function () {
        var boxes = box.querySelectorAll('input[data-device]');
        var everyOn = Array.prototype.every.call(boxes, function (c) { return c.checked; });
        Array.prototype.forEach.call(boxes, function (c) {
          c.checked = !everyOn;
          picked[c.getAttribute("data-device")] = c.checked;
          c.parentNode.classList.toggle("on", c.checked);
        });
        all.textContent = everyOn ? "Отметить все" : "Снять все";
        syncCount();
      });
      box.appendChild(all);

      state.devices.forEach(function (d) {
        var lbl = el("label", "sch-dev" + (picked[d.id] ? " on" : ""));
        var cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = !!picked[d.id]; cb.setAttribute("data-device", d.id);
        cb.addEventListener("change", function () {
          picked[d.id] = cb.checked;
          lbl.classList.toggle("on", cb.checked);
          syncCount();
        });
        lbl.appendChild(cb);
        lbl.appendChild(el("span", null, d.name + (d.online ? "" : " (офлайн)")));
        box.appendChild(lbl);
      });
      box.appendChild(count);
      syncCount();
    }

    box.ids = function () {
      return Array.prototype.slice.call(box.querySelectorAll('input[data-device]:checked'))
        .map(function (c) { return c.getAttribute("data-device"); });
    };
    box.refresh = render;
    render();
    return box;
  }

  // ---------------- Расписание управления планшетами ----------------
  var SCH_DAYS = [["Пн", 1], ["Вт", 2], ["Ср", 3], ["Чт", 4], ["Пт", 5], ["Сб", 6], ["Вс", 7]];
  var schActions = [];

  // Смещение пояса из вида «03:00:00» в вид «+3». Оператору нужна разница с UTC, а не
  // продолжительность с точностью до секунды.
  function смещение(текст) {
    var m = /^(-)?(\d+):(\d+)/.exec(String(текст || ""));
    if (!m) return "";
    var знак = m[1] ? "-" : "+";
    var ч = parseInt(m[2], 10), мин = parseInt(m[3], 10);
    return знак + ч + (мин ? ":" + String(мин).padStart(2, "0") : "");
  }

  function loadSchedule() {
    return apiJson("/schedule/actions").then(function (list) { schActions = list || []; })
      .then(function () { return apiJson("/schedule"); })
      .then(function (data) {
        // Часы сервера целиком: дата, время и пояс. По этим суткам считается не только
        // расписание, но и возраст, и окно вокруг годовщины. Пояс сервера, не совпадающий с тем,
        // в котором живёт оператор, сдвигает границы окна на несколько часов, и выглядит это как
        // ошибка на день в счёте дней. Пусть будет видно, а не подразумевается.
        var t = $("schServerTime");
        if (t) {
          var зона = data.serverZone ? (data.serverZone + (data.serverOffset ? ", UTC" + смещение(data.serverOffset) : "")) : "";
          t.textContent = "часы сервера: " + (data.serverDate || "-") + " " + (data.serverTime || "-") +
            (зона ? " (" + зона + ")" : "");
        }
        renderSchedule((data && data.rules) || []);
      });
  }

  function renderSchedule(rules) {
    var wrap = $("scheduleList"); if (!wrap) return;
    wrap.innerHTML = "";
    // Почти всё в расписании идёт по локальной сети. Если управление выключено, правила
    // сохранятся и будут выглядеть рабочими, но команда до планшета не дойдёт. Сказать об
    // этом надо здесь, а не оставлять оператора выяснять это по итогам следующего утра.
    var kc = state.kioskControl || {};
    if (!kc.enabled && rules.length) {
      wrap.appendChild(el("div", "note-box note-warn",
        "Управление планшетами по локальной сети выключено (переключатель выше). Правила сохранятся, " +
        "но команды экрана, яркости и перезагрузки до планшетов не дойдут. Без локальной сети работает " +
        "только «Вернуть рекламу»: она идёт через уже открытое соединение."));
    }
    if (!rules.length) {
      wrap.appendChild(el("div", "empty-note", "Правил пока нет. Например: «в 06:50 по будням включить экраны на всех планшетах»."));
      return;
    }
    rules.forEach(function (r) { wrap.appendChild(scheduleRow(r)); });
  }

  function scheduleRow(r) {
    r = r || {};
    var row = el("div", "sch-rule" + (r.enabled === false ? " off" : ""));
    row.setAttribute("data-role", "schrule");
    row.setAttribute("data-id", r.id || "");

    var on = document.createElement("input");
    on.type = "checkbox"; on.checked = r.enabled !== false;
    on.setAttribute("data-role", "schon");
    on.title = "Правило включено";
    on.addEventListener("change", function () { row.classList.toggle("off", !on.checked); });
    row.appendChild(on);

    var time = document.createElement("input");
    time.type = "time"; time.value = r.time || "07:00"; time.setAttribute("data-role", "schtime");
    // Браузер показывает время по своим настройкам, где-то с AM/PM. В подсказке всегда
    // 24-часовой вид, чтобы «девять вечера» нельзя было прочитать как «девять утра».
    function syncTimeTitle() { time.title = "Время по часам сервера: " + (time.value || "-") + " (24 часа)"; }
    time.addEventListener("change", syncTimeTitle);
    syncTimeTitle();
    row.appendChild(time);

    // Дни недели: семь переключателей вместо списка с галочками, иначе строка не читается.
    var days = el("div", "sch-days");
    var chosen = {}; (r.days || []).forEach(function (d) { chosen[d] = true; });
    SCH_DAYS.forEach(function (d) {
      var b = el("button", "sch-day" + (chosen[d[1]] ? " on" : ""), d[0]);
      b.type = "button"; b.setAttribute("data-day", d[1]);
      b.title = "Нажмите, чтобы включить или выключить этот день. Ни одного дня означает каждый день.";
      b.addEventListener("click", function () { b.classList.toggle("on"); });
      days.appendChild(b);
    });
    row.appendChild(days);

    var act = el("select", "sch-action"); act.setAttribute("data-role", "schaction");
    schActions.forEach(function (a) { act.appendChild(new Option(a.title, a.key)); });
    act.value = r.action || "screen-on";
    row.appendChild(act);

    var value = document.createElement("input");
    value.type = "number"; value.min = 0; value.max = 100; value.className = "sch-value";
    value.value = r.value != null ? r.value : 100; value.setAttribute("data-role", "schvalue");
    value.title = "Значение в процентах";
    row.appendChild(value);

    var text = document.createElement("input");
    text.type = "text"; text.className = "sch-note"; text.placeholder = "текст сообщения";
    text.value = r.text || ""; text.setAttribute("data-role", "schtext");
    row.appendChild(text);

    var target = el("select", "sch-target"); target.setAttribute("data-role", "schtarget");
    fillTargetSelect(target, r.target || "all");
    row.appendChild(target);

    // Список отметок появляется только при выборе набора: постоянно висящий список планшетов
    // сделал бы строку правила нечитаемой.
    var devBox = devicePicker(r.deviceIds || []);
    devBox.setAttribute("data-role", "schdevices");
    row.appendChild(devBox);

    var flags = el("label", "sch-flags");
    var busy = document.createElement("input");
    busy.type = "checkbox"; busy.checked = r.skipBusy !== false; busy.setAttribute("data-role", "schbusy");
    flags.appendChild(busy);
    flags.appendChild(el("span", null, "не трогать планшет, где идёт подписание"));
    flags.title = "Погасить экран или перезагрузить планшет под рукой у подписывающего человека значит потерять его подпись.";
    row.appendChild(flags);

    var note = document.createElement("input");
    note.type = "text"; note.className = "sch-note"; note.placeholder = "заметка (необязательно)";
    note.value = r.note || ""; note.setAttribute("data-role", "schnote");
    row.appendChild(note);

    var run = iconBtn("send", "Запустить", "btn-ghost btn-sm");
    run.title = "Выполнить правило прямо сейчас, чтобы проверить его";
    run.addEventListener("click", function () {
      if (!r.id) { toast("Сначала сохраните расписание, потом можно будет проверить правило."); return; }
      saveSchedule().then(function () {
        return apiSend("/schedule/" + r.id + "/run", "POST", {}).then(function (x) { return x.json(); });
      }).then(function (j) { toast("Правило выполнено: " + (j && j.result)); return loadSchedule(); })
        .catch(function () { /* об ошибке уже сообщили */ });
    });
    row.appendChild(run);

    var del = iconBtn("trash", "Удалить", "btn-danger btn-sm");
    del.addEventListener("click", function () { row.remove(); });
    row.appendChild(del);

    if (r.lastRunUtc) {
      var bad = /не ответил|выключено|нет/.test(r.lastResult || "");
      row.appendChild(el("div", "sch-last" + (bad ? " bad" : ""),
        "Последний запуск: " + new Date(r.lastRunUtc).toLocaleString("ru-RU") + " — " + (r.lastResult || "")));
    }

    // Поля значения и текста нужны не всякому действию: лишние поля в строке только мешают.
    function syncFields() {
      var a = null;
      schActions.forEach(function (x) { if (x.key === act.value) a = x; });
      value.style.display = a && a.needsValue ? "" : "none";
      text.style.display = a && a.needsText ? "" : "none";
      devBox.style.display = target.value === "devices" ? "" : "none";
    }
    act.addEventListener("change", syncFields);
    target.addEventListener("change", syncFields);
    syncFields();
    return row;
  }

  function collectSchedule() {
    var rules = [];
    document.querySelectorAll('[data-role="schrule"]').forEach(function (row) {
      var days = [];
      row.querySelectorAll(".sch-day.on").forEach(function (b) { days.push(parseInt(b.getAttribute("data-day"), 10)); });
      var q = function (role) { return row.querySelector('[data-role="' + role + '"]'); };
      rules.push({
        id: row.getAttribute("data-id") || "",
        enabled: q("schon").checked,
        time: q("schtime").value || "07:00",
        days: days,
        action: q("schaction").value,
        value: parseInt(q("schvalue").value, 10) || 0,
        text: q("schtext").value,
        target: q("schtarget").value,
        deviceIds: Array.prototype.slice.call(row.querySelectorAll('input[data-device]:checked'))
          .map(function (c) { return c.getAttribute("data-device"); }),
        skipBusy: q("schbusy").checked,
        note: q("schnote").value
      });
    });
    return rules;
  }

  function saveSchedule() {
    return apiSend("/schedule", "PUT", collectSchedule()).then(function (r) { return r.json(); })
      .then(function (j) { renderSchedule((j && j.rules) || []); return j; });
  }

  if ($("addSchedule")) {
    $("addSchedule").addEventListener("click", function () {
      var wrap = $("scheduleList");
      var note = wrap.querySelector(".empty-note");
      if (note) note.remove();
      wrap.appendChild(scheduleRow({ enabled: true, time: "07:00", days: [1, 2, 3, 4, 5], action: "screen-on", target: "all", skipBusy: true }));
    });
  }
  if ($("saveSchedule")) {
    $("saveSchedule").addEventListener("click", function () {
      saveSchedule().then(function () { toast("Расписание сохранено"); });
    });
  }

  // ---------------- Groups ----------------
  function loadGroups() { return apiJson("/groups").then(function (list) { state.groups = list; renderGroups(); renderTargetOptions(); populateDeviceFilters(); }); }
  function renderGroups() {
    var wrap = $("groupsList"); wrap.innerHTML = "";
    if (!state.groups.length) { wrap.innerHTML = '<div class="empty-note">Групп пока нет.</div>'; return; }
    state.groups.forEach(function (g) {
      var row = el("div", "simple-row");
      var inp = el("input"); inp.value = g.name; inp.className = "grow"; row.appendChild(inp);
      var save = iconBtn("save", "Переименовать", "btn-ghost btn-sm");
      save.addEventListener("click", function () { apiSend("/groups/" + g.id, "PUT", { name: inp.value }).then(loadGroups).then(function () { toast("Сохранено"); }); });
      row.appendChild(save);
      var del = iconBtn("trash", "Удалить", "btn-danger btn-sm");
      del.addEventListener("click", function () { if (confirm("Удалить группу «" + g.name + "»?")) api("/groups/" + g.id, { method: "DELETE" }).then(loadGroups).then(loadDevices); });
      row.appendChild(del);
      wrap.appendChild(row);
    });
  }
  $("addGroup").addEventListener("click", function () {
    var name = ($("newGroupName").value || "").trim(); if (!name) return;
    apiSend("/groups", "POST", { name: name }).then(function () { $("newGroupName").value = ""; return loadGroups(); }).then(function () { toast("Группа добавлена"); });
  });

  // ---------------- Workstations ----------------
  function loadWorkstations() { return apiJson("/workstations").then(function (list) { state.workstations = list; renderWorkstations(); populateDeviceFilters(); }); }
  function wsCol(labelText, value, placeholder, grow) {
    var col = el("label", "ws-col" + (grow ? " grow" : ""), labelText);
    var input = el("input"); input.value = value || ""; input.placeholder = placeholder;
    col.appendChild(input);
    return { col: col, input: input };
  }
  function renderWorkstations() {
    var wrap = $("workstationsList"); wrap.innerHTML = "";
    if (!state.workstations.length) { wrap.innerHTML = '<div class="empty-note">Рабочих мест пока нет.</div>'; return; }
    state.workstations.forEach(function (w) {
      var row = el("div", "simple-row ws-row");
      var extF = wsCol("Внешний ID", w.externalId, "напр. WS-204", false); extF.col.style.flex = "0 0 150px";
      var nameF = wsCol("Название", w.name, "напр. Ресепшн 1", true);
      var locF = wsCol("Описание", w.location, "напр. Главный холл", true);
      var ext = extF.input, name = nameF.input, loc = locF.input;
      row.appendChild(extF.col); row.appendChild(nameF.col); row.appendChild(locF.col);
      var save = iconBtn("save", "Сохранить", "btn-ghost btn-sm");
      save.addEventListener("click", function () { apiSend("/workstations/" + w.id, "PUT", { externalId: ext.value, name: name.value, location: loc.value }).then(loadWorkstations).then(function () { toast("Сохранено"); }); });
      row.appendChild(save);
      var del = iconBtn("trash", "Удалить", "btn-danger btn-sm");
      del.addEventListener("click", function () { if (confirm("Удалить место «" + w.name + "»?")) api("/workstations/" + w.id, { method: "DELETE" }).then(loadWorkstations).then(loadDevices); });
      row.appendChild(del);
      wrap.appendChild(row);
    });
  }
  $("addWorkstation").addEventListener("click", function () {
    apiSend("/workstations", "POST", { externalId: "", name: "Новое место", location: "" }).then(loadWorkstations).then(function () { toast("Место добавлено"); });
  });

  // ---------------- API keys ----------------
  function loadKeys() { return apiJson("/apikeys").then(function (list) { state.apikeys = list; renderKeys(); }); }
  function renderKeys() {
    var wrap = $("keysList"); wrap.innerHTML = "";
    if (!state.apikeys.length) { wrap.innerHTML = '<div class="empty-note">Ключей пока нет.</div>'; return; }
    state.apikeys.forEach(function (k) {
      var row = el("div", "simple-row");
      row.appendChild(el("strong", "grow", k.label));
      row.appendChild(el("span", "sig-meta", new Date(k.createdUtc).toLocaleString("ru-RU")));
      var del = iconBtn("trash", "Удалить", "btn-danger btn-sm");
      del.addEventListener("click", function () { if (confirm("Удалить ключ «" + k.label + "»?")) api("/apikeys/" + k.id, { method: "DELETE" }).then(loadKeys); });
      row.appendChild(del); wrap.appendChild(row);
    });
  }
  $("addKey").addEventListener("click", function () {
    var label = ($("newKeyLabel").value || "").trim() || "API key";
    apiSend("/apikeys", "POST", { label: label }).then(function (r) { return r.json(); }).then(function (j) {
      $("newKeyLabel").value = "";
      var c = el("div");
      c.appendChild(el("h3", null, "Ключ создан"));
      c.appendChild(el("p", "sig-meta", "Скопируйте ключ сейчас - позже он не показывается."));
      var code = el("div", "enroll-code"); code.style.fontSize = "1rem"; code.style.wordBreak = "break-all"; code.textContent = j.key;
      c.appendChild(code);
      c.appendChild(el("p", "sig-meta", "Передавайте его в заголовке X-Api-Key при запросах к /api/ext/*"));
      var done = el("button", "btn btn-primary", "Готово"); done.addEventListener("click", function () { closeModal(); loadKeys(); });
      c.appendChild(done); openModal(c);
    });
  });

  // ---------------- Tablet control (FreeKiosk API on the tablet) ----------------
  // Everything here goes server -> tablet over the local network. A tablet that is off or on
  // another network simply reports as unreachable; nothing about signing is affected.
  function openControl(d) {
    var c = el("div", "ctl-wrap");
    c.appendChild(el("h3", null, "Управление планшетом: " + d.name));

    var status = el("div", "sig-meta", "");
    c.appendChild(status);
    function say(msg, bad) { status.textContent = msg; status.classList.toggle("ctl-bad", !!bad); }

    // Address the server uses to reach this tablet.
    var addr = el("div", "ctl-addr");
    // Deliberately NOT prefilled with lastIp: saving that would pin the tablet to today's DHCP
    // lease, and control would quietly break the next time the address changes.
    var ipField = labeledInput("IP планшета (пусто = определять автоматически)", d.controlIp || "");
    ipField.input.placeholder = d.lastIp ? "сейчас виден как " + d.lastIp : "например 192.168.1.50";
    var portField = labeledInput("Порт (пусто = общий из настроек)", d.controlPort || "");
    addr.appendChild(ipField.wrap); addr.appendChild(portField.wrap);
    var saveAddr = el("button", "btn btn-ghost btn-sm", "Сохранить адрес");
    saveAddr.addEventListener("click", function () {
      apiSend("/devices/" + d.id + "/control-address", "PUT",
        { ip: ipField.input.value.trim(), port: parseInt(portField.input.value, 10) || null })
        .then(function () { say("Адрес сохранён."); return loadDevices(); })
        .catch(function () { /* reported by api() */ });
    });
    addr.appendChild(saveAddr);
    c.appendChild(addr);

    // Live check, so the operator can tell at once whether the address and key are right.
    var health = el("div", "ctl-health sig-meta", "");
    c.appendChild(health);
    function refreshHealth() {
      health.textContent = "Опрашиваю планшет...";
      apiJson("/devices/" + d.id + "/kiosk/health")
        .then(function (h) {
          if (!h.reachable) {
            health.textContent = "Планшет не отвечает. " + (h.error || "");
            health.classList.add("ctl-bad");
            return;
          }
          // The tablet answered but we could not read the reply: say so instead of reporting
          // a healthy tablet with no readings.
          if (h.error) { health.textContent = h.error; health.classList.add("ctl-bad"); return; }
          health.classList.remove("ctl-bad");
          if (h.brightnessPercent != null) { br.value = h.brightnessPercent; brVal.textContent = h.brightnessPercent + "%"; }
          var parts = [];
          if (h.model) parts.push(h.model);
          if (h.androidVersion) parts.push("Android " + h.androidVersion);
          if (h.appVersion) parts.push("FreeKiosk " + h.appVersion);
          if (h.batteryPercent != null) parts.push("заряд " + h.batteryPercent + "%" + (h.charging ? ", заряжается" : ""));
          if (h.wifiSignalPercent != null) parts.push("Wi-Fi " + h.wifiSignalPercent + "%");
          if (h.storageFreePercent != null) parts.push("свободно " + h.storageFreePercent + "%");
          if (h.deviceOwner != null) parts.push("Device Owner: " + (h.deviceOwner ? "включён" : "выключен"));
          health.textContent = parts.join(" · ") || "Планшет ответил, но не сообщил ни одного показателя.";
          loadDevices();
        })
        .catch(function () { health.textContent = "Не удалось опросить планшет."; health.classList.add("ctl-bad"); });
    }

    function cmdButton(label, command, cls, confirmText) {
      var b = el("button", "btn " + (cls || "btn-ghost") + " btn-sm", label);
      b.addEventListener("click", function () {
        if (confirmText && !confirm(confirmText)) return;
        b.disabled = true; say("Выполняю: " + label + "...");
        apiSend("/devices/" + d.id + "/kiosk/" + command, "POST", {})
          .then(function () { say(label + ": выполнено."); })
          .catch(function (e) { say(label + ": не удалось. " + (e && e.message ? e.message : ""), true); })
          .then(function () { b.disabled = false; });
      });
      return b;
    }

    var grid = el("div", "ctl-grid");
    grid.appendChild(cmdButton("Обновить страницу", "reload"));
    grid.appendChild(cmdButton("Очистить кэш", "clear-cache", null,
      "Очистить кэш планшета? Планшет перезагрузит страницу и заберёт свежую версию."));
    grid.appendChild(cmdButton("Перезапустить приложение", "restart-app", null,
      "Перезапустить FreeKiosk на планшете?"));
    grid.appendChild(cmdButton("Перезагрузить планшет", "reboot", "btn-danger",
      "Перезагрузить планшет целиком? Это займёт около минуты. Требуется режим Device Owner."));
    grid.appendChild(cmdButton("Включить экран", "screen-on"));
    grid.appendChild(cmdButton("Выключить экран", "screen-off"));
    grid.appendChild(cmdButton("Звуковой сигнал", "beep"));
    var bHealth = el("button", "btn btn-ghost btn-sm", "Проверить связь");
    bHealth.addEventListener("click", refreshHealth);
    grid.appendChild(bHealth);
    c.appendChild(grid);

    // Brightness
    var brLabel = el("label", "field-sm", "Яркость экрана");
    var br = el("input"); br.type = "range"; br.min = "5"; br.max = "100"; br.step = "5"; br.value = "80";
    var brVal = el("span", "img-wval", "80%");
    br.addEventListener("input", function () { brVal.textContent = br.value + "%"; });
    br.addEventListener("change", function () {
      apiSend("/devices/" + d.id + "/kiosk/brightness", "POST", { value: parseInt(br.value, 10) })
        .then(function () { say("Яркость: " + br.value + "%"); })
        .catch(function () { say("Не удалось изменить яркость.", true); });
    });
    brLabel.appendChild(br); brLabel.appendChild(brVal);
    c.appendChild(brLabel);

    // Speak / toast: get the client's attention at the tablet.
    var sayRow = el("div", "ctl-say");
    var sayField = labeledInput("Произнести или показать на планшете", "Пожалуйста, подпишите документ");
    // One field feeds both buttons, so keep to the stricter of the two server limits.
    sayField.input.maxLength = 200;
    sayRow.appendChild(sayField.wrap);
    var bSpeak = el("button", "btn btn-ghost btn-sm", "Произнести");
    bSpeak.addEventListener("click", function () {
      apiSend("/devices/" + d.id + "/kiosk/say", "POST", { text: sayField.input.value })
        .then(function () { say("Произнесено."); }).catch(function () { say("Не удалось произнести.", true); });
    });
    var bToast = el("button", "btn btn-ghost btn-sm", "Показать сообщение");
    bToast.addEventListener("click", function () {
      apiSend("/devices/" + d.id + "/kiosk/toast", "POST", { text: sayField.input.value })
        .then(function () { say("Сообщение показано."); }).catch(function () { say("Не удалось показать.", true); });
    });
    sayRow.appendChild(bSpeak); sayRow.appendChild(bToast);
    c.appendChild(sayRow);

    // Screenshot: see what is actually on the tablet right now.
    var shotWrap = el("div", "ctl-shot");
    var bShot = el("button", "btn btn-primary btn-sm ctl-shot-btn", "Снимок экрана");
    var shotImg = el("img", "ctl-shot-img"); shotImg.style.display = "none";
    var shotGen = 0;
    bShot.addEventListener("click", function () {
      var gen = ++shotGen;
      bShot.disabled = true;
      say("Снимаю экран...");
      // Cache-busting so a repeated click always shows the current screen.
      var url = "/api/admin/devices/" + d.id + "/kiosk/screenshot?t=" + Date.now();
      fetch(url, { credentials: "same-origin" })
        .then(function (r) {
          // The session can expire while the panel is open, exactly as in api().
          if (r.status === 401) { showLogin(); throw new Error("сессия истекла"); }
          if (!r.ok) {
            // An error body is not always JSON (a 404 has no body at all), so read it as text.
            return r.text().then(function (t) {
              var msg = ""; try { msg = (JSON.parse(t) || {}).error || ""; } catch (e) { msg = ""; }
              throw new Error(msg || ("ошибка " + r.status));
            });
          }
          return r.blob();
        })
        .then(function (blob) {
          // A newer click has already been made, or the modal is gone: release this image at once
          // rather than attaching it to a node nobody will ever revoke.
          var u = URL.createObjectURL(blob);
          if (gen !== shotGen || !document.body.contains(shotImg)) { URL.revokeObjectURL(u); return; }
          if (shotImg.dataset.url) URL.revokeObjectURL(shotImg.dataset.url);
          shotImg.dataset.url = u; shotImg.src = u; shotImg.style.display = "";
          say("Экран получен " + new Date().toLocaleTimeString("ru-RU") + ".");
          // The image lands below the buttons; without this the operator sees no change at all
          // on a short screen.
          if (shotImg.scrollIntoView) shotImg.scrollIntoView({ block: "nearest" });
        })
        .catch(function (e) { if (gen === shotGen) say("Не удалось получить экран: " + e.message, true); })
        .then(function () { if (gen === shotGen) bShot.disabled = false; });
    });
    shotWrap.appendChild(bShot); shotWrap.appendChild(shotImg);
    c.appendChild(shotWrap);

    openModal(c);
    refreshHealth();
  }

  // Fleet-wide control settings: one address scheme and one key for the whole fleet, plus the
  // thresholds the monitor uses. The key never comes back from the server, so the field shows
  // whether one is stored and stays empty unless the operator types a new one.
  var kcFields = ["kcEnabled", "kcPort", "kcApiKey", "kcTimeout", "kcAutoHeal", "kcHealAfter", "kcBattery", "kcStorage"];
  var kcDirty = false;

  function loadKioskControl(force) {
    // Never overwrite what the operator is in the middle of typing. Without this, opening the
    // tablets tab again would silently drop a half-entered key and they would then save the old
    // values believing they had saved the new ones.
    if (kcDirty && !force) return Promise.resolve();
    return apiJson("/kiosk-control/settings").then(function (s) {
      state.kioskControl = s;
      $("kcEnabled").checked = !!s.enabled;
      $("kcPort").value = s.port;
      $("kcApiKey").value = "";
      $("kcApiKey").placeholder = s.apiKeySet ? "ключ сохранён, введите новый для замены" : "пусто = без ключа";
      $("kcTimeout").value = s.timeoutSec;
      $("kcAutoHeal").checked = !!s.autoHeal;
      $("kcHealAfter").value = s.autoHealAfterMinutes;
      $("kcBattery").value = s.batteryWarnPercent;
      $("kcStorage").value = s.storageWarnPercent;
      $("kcClearApiKey").checked = false;
      $("kcClearApiKey").parentNode.classList.toggle("hidden", !s.apiKeySet);
      kcDirty = false;
      renderDevices();
    }).catch(function (e) { console.error(e); });
  }

  kcFields.concat(["kcClearApiKey"]).forEach(function (id) {
    var e = $(id); if (e) e.addEventListener("input", function () { kcDirty = true; });
    if (e) e.addEventListener("change", function () { kcDirty = true; });
  });

  // Blank means "use the server default", but an explicit 0 is a real choice (never warn), so a
  // parsed number is always kept as it is.
  function kcNumber(id, fallback) {
    var v = parseInt($(id).value, 10);
    return isNaN(v) ? fallback : v;
  }

  $("saveKioskControl").addEventListener("click", function () {
    apiSend("/kiosk-control/settings", "PUT", {
      enabled: $("kcEnabled").checked,
      port: kcNumber("kcPort", 8080),
      apiKey: $("kcApiKey").value.trim(),
      clearApiKey: $("kcClearApiKey").checked,
      timeoutSec: kcNumber("kcTimeout", 5),
      autoHeal: $("kcAutoHeal").checked,
      autoHealAfterMinutes: kcNumber("kcHealAfter", 5),
      batteryWarnPercent: kcNumber("kcBattery", 20),
      storageWarnPercent: kcNumber("kcStorage", 10)
    }).then(function () { kcDirty = false; return loadKioskControl(true); })
      .then(loadDevices)
      .then(function () { toast("Настройки управления сохранены"); })
      .catch(function () { /* reported by api() */ });
  });

  // ---------------- Operator alerts ----------------
  // The operator is not always looking at this screen, so a new alert can also raise a desktop
  // notification and a short beep. Both are opt-in and remembered in this browser.
  var alertPrefs = {
    desktop: localStorage.getItem("sk_alert_desktop") === "1",
    sound: localStorage.getItem("sk_alert_sound") === "1"
  };
  var knownAlertIds = {};
  var alertsLoadedOnce = false;

  function loadAlerts() {
    return apiJson("/alerts").then(function (data) {
      var list = (data && data.alerts) || [];
      state.alerts = list;
      renderAlertBadge(data && data.unacknowledged);
      // Announce only genuinely new alerts, and never on the first load after opening the page.
      var fresh = list.filter(function (a) { return !knownAlertIds[a.id]; });
      var seen = {};
      list.forEach(function (a) { seen[a.id] = true; });
      knownAlertIds = seen;
      if (alertsLoadedOnce && fresh.length) announceAlerts(fresh);
      alertsLoadedOnce = true;
      if (!document.querySelector('[data-panel="alerts"]').classList.contains("hidden")) renderAlerts();
      return true;
    }).catch(function () { return false; });   // api() already reported it
  }

  function renderAlertBadge(count) {
    var b = $("alertBadge"); if (!b) return;
    var n = count || 0;
    b.textContent = n;
    b.classList.toggle("hidden", n === 0);
  }

  function announceAlerts(fresh) {
    var first = fresh[0];
    toast("Уведомление: " + first.title + (fresh.length > 1 ? " (и ещё " + (fresh.length - 1) + ")" : ""));
    if (alertPrefs.sound) beep();
    if (alertPrefs.desktop && "Notification" in window && Notification.permission === "granted") {
      try { new Notification("HELIX SignTablet", { body: first.title + "\n" + (first.detail || "") }); }
      catch (e) { /* some browsers block it outside a gesture */ }
    }
  }

  // Short two-tone beep via WebAudio: no asset to load, works offline.
  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
      var ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      setTimeout(function () { osc.frequency.value = 660; }, 120);
      setTimeout(function () { osc.stop(); ctx.close(); }, 260);
    } catch (e) { /* audio unavailable */ }
  }

  function renderAlerts() {
    var wrap = $("alertsList"); if (!wrap) return;
    wrap.innerHTML = "";
    var list = state.alerts || [];
    if (!list.length) {
      wrap.appendChild(el("div", "empty-note", "Активных уведомлений нет. Все планшеты на связи, ошибок не накопилось."));
      return;
    }
    list.forEach(function (a) {
      var item = el("div", "log-item log-" + (a.severity === "error" ? "error" : "warn") + (a.acknowledged ? " acked" : ""));
      var head = el("div", "log-head");
      head.appendChild(el("span", "chip " + (a.severity === "error" ? "chip-danger" : "chip-warn"),
        a.kind === "offline" ? "нет связи" : a.kind === "errors" ? "ошибки"
          : a.kind === "duplicate" ? "дубль кода" : "проверка"));
      head.appendChild(el("span", "log-time", "с " + new Date(a.sinceUtc).toLocaleString("ru-RU")));
      if (a.deviceName) head.appendChild(el("span", "log-device", "Планшет: " + a.deviceName));
      if (a.acknowledged) head.appendChild(el("span", "log-source", "прочитано"));
      item.appendChild(head);
      item.appendChild(el("div", "log-msg", a.title));
      if (a.detail) item.appendChild(el("div", "sig-meta", a.detail));
      if (a.kind === "test") {
        var close = el("button", "btn btn-ghost btn-sm", "Закрыть");
        close.addEventListener("click", function () {
          api("/alerts/" + encodeURIComponent(a.id), { method: "DELETE" }).then(loadAlerts).catch(function () {});
        });
        item.appendChild(close);
      }
      wrap.appendChild(item);
    });
  }

  function loadAlertSettings() {
    return apiJson("/alerts/settings").then(function (s) {
      $("alertEnabled").checked = s.enabled !== false;
      $("alertOffline").value = s.offlineMinutes;
      $("alertErrCount").value = s.errorCount;
      $("alertErrWindow").value = s.errorWindowMinutes;
      $("alertDesktop").checked = alertPrefs.desktop;
      $("alertSound").checked = alertPrefs.sound;
    }).catch(function () { /* reported by api() */ });
  }

  $("saveAlertSettings").addEventListener("click", function () {
    apiSend("/alerts/settings", "PUT", {
      enabled: $("alertEnabled").checked,
      offlineMinutes: parseInt($("alertOffline").value, 10) || 10,
      errorCount: parseInt($("alertErrCount").value, 10) || 5,
      errorWindowMinutes: parseInt($("alertErrWindow").value, 10) || 10
    }).then(function () { return loadAlertSettings(); })
      .then(function () { toast("Настройки сохранены"); })
      .catch(function () { /* reported by api() */ });
  });
  $("alertDesktop").addEventListener("change", function () {
    alertPrefs.desktop = this.checked;
    localStorage.setItem("sk_alert_desktop", this.checked ? "1" : "0");
    if (this.checked && "Notification" in window && Notification.permission === "default")
      Notification.requestPermission().catch(function () {});
  });
  $("alertSound").addEventListener("change", function () {
    alertPrefs.sound = this.checked;
    localStorage.setItem("sk_alert_sound", this.checked ? "1" : "0");
    if (this.checked) beep();
  });
  $("testAlert").addEventListener("click", function () {
    apiSend("/alerts/test", "POST", {}).then(loadAlerts).catch(function () {});
  });
  $("ackAlerts").addEventListener("click", function () {
    apiSend("/alerts/ack", "POST", {}).then(loadAlerts).then(function () { toast("Отмечено"); }).catch(function () {});
  });
  $("reloadAlerts").addEventListener("click", function () {
    loadAlerts().then(function (okResult) { if (okResult) toast("Обновлено"); });
  });

  // ---------------- Operational logs ----------------
  var logFilter = { q: "", level: "all" };
  var logTimer = null;

  function stopLogPolling() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }
  function startLogPolling() {
    stopLogPolling();
    if ($("logAuto") && $("logAuto").checked && logsPanelVisible())
      logTimer = setInterval(function () {
        if (!logsPanelVisible()) { stopLogPolling(); return; }
        loadLogs(true);
      }, 10000);
  }

  function logsPanelVisible() {
    var p = document.querySelector('[data-panel="logs"]');
    return !!p && !p.classList.contains("hidden");
  }

  function loadLogs(quiet) {
    var qs = "?level=" + encodeURIComponent(logFilter.level) + "&q=" + encodeURIComponent(logFilter.q) + "&limit=300";
    return apiJson("/logs" + qs).then(function (data) {
      state.logs = (data && data.entries) || [];
      renderLogs(data && data.total);
      // Only (re)start polling if the operator is still on this tab: the response may arrive after
      // they have already moved on, and an orphaned interval would poll for the rest of the day.
      if (!quiet && logsPanelVisible()) startLogPolling();
      if (!logsPanelVisible()) stopLogPolling();
      return true;
    }).catch(function () {
      // A transient failure must not silently kill auto-refresh: keep polling while the operator
      // is still on this tab (a 401 already stops it via showLogin).
      if (!logsPanelVisible()) stopLogPolling();
      return false;
    });
  }

  function renderLogs(total) {
    var wrap = $("logsList"); if (!wrap) return;
    wrap.innerHTML = "";
    var list = state.logs || [];
    var countEl = $("logsCount");
    if (countEl) countEl.textContent = list.length ? ("Показано " + list.length + (total != null ? " из " + total : "")) : "";
    if (!list.length) {
      wrap.appendChild(el("div", "empty-note", "Записей нет. Это хорошо: сбоев не зафиксировано."));
      return;
    }
    list.forEach(function (e) {
      var item = el("div", "log-item log-" + (e.level || "error"));
      var head = el("div", "log-head");
      head.appendChild(el("span", "chip " + (e.level === "error" ? "chip-danger" : e.level === "warn" ? "chip-warn" : "chip-muted"),
        e.level === "error" ? "ошибка" : e.level === "warn" ? "предупреждение" : "информация"));
      head.appendChild(el("span", "log-time", new Date(e.utc).toLocaleString("ru-RU")));
      var src = e.source === "tablet" ? "планшет" : e.source === "service" ? "сервис" : (e.source || "");
      head.appendChild(el("span", "log-source", src));
      if (e.deviceName) head.appendChild(el("span", "log-device", "Планшет: " + e.deviceName));
      item.appendChild(head);
      item.appendChild(el("div", "log-msg", e.message || ""));
      if (e.detail) {
        var det = document.createElement("details");
        var sum = document.createElement("summary"); sum.textContent = "Подробности";
        det.appendChild(sum);
        det.appendChild(el("pre", "log-detail", e.detail));
        item.appendChild(det);
      }
      wrap.appendChild(item);
    });
  }

  $("logSearch").addEventListener("input", function () { logFilter.q = this.value; loadLogs(true); });
  $("logLevel").addEventListener("change", function () { logFilter.level = this.value; loadLogs(true); });
  $("logAuto").addEventListener("change", function () { if (this.checked) startLogPolling(); else stopLogPolling(); });
  // loadLogs resolves with false on failure (api() already showed the error), so do not claim success.
  $("reloadLogs").addEventListener("click", function () {
    loadLogs().then(function (okResult) { if (okResult) toast("Обновлено"); });
  });
  $("clearLogs").addEventListener("click", function () {
    if (!confirm("Очистить журнал ошибок? Записи будут удалены безвозвратно.")) return;
    api("/logs", { method: "DELETE" }).then(function () { return loadLogs(); }).then(function () { toast("Журнал очищен"); });
  });

  // ---------------- Barcode / QR scanning ----------------
  // Scanning targets exactly ONE tablet, like the document.
  function loadScans() {
    fillDeviceSelect($("scanTarget"), state.scanTarget);
    state.scanTarget = $("scanTarget").value;
    return apiJson("/scans").then(function (list) { state.scans = list; renderScans(); });
  }
  function renderScans() {
    var wrap = $("scansList"); if (!wrap) return;
    wrap.innerHTML = "";
    var list = state.scans || [];
    if (!list.length) { wrap.appendChild(el("div", "empty-note", "Считанных кодов пока нет.")); return; }
    list.forEach(function (s) {
      var row = el("div", "sig-item");
      var col = el("div", "sig-col");
      var code = el("div", "scan-code-row"); code.appendChild(el("strong", null, s.code || ""));
      if (s.format) code.appendChild(el("span", "chip chip-muted", s.format));
      col.appendChild(code);
      var where = [];
      if (s.deviceName) where.push("Планшет: " + s.deviceName);
      if (s.workstationName) where.push("Место: " + s.workstationName);
      col.appendChild(el("div", "sig-meta", new Date(s.createdUtc).toLocaleString("ru-RU") + (where.length ? " · " + where.join(" · ") : "")));
      row.appendChild(col);
      var actions = el("div", "dev-actions");
      var copy = iconBtn("copy", "Копировать", "btn-ghost btn-sm");
      copy.addEventListener("click", function () { copyText(s.code || ""); });
      actions.appendChild(copy);
      var del = iconBtn("trash", "Удалить", "btn-danger btn-sm");
      del.addEventListener("click", function () { api("/scans/" + s.id, { method: "DELETE" }).then(loadScans).then(function () { toast("Удалено"); }); });
      actions.appendChild(del);
      row.appendChild(actions);
      wrap.appendChild(row);
    });
  }
  $("scanTarget").addEventListener("change", function () { state.scanTarget = this.value; });
  $("reloadScans").addEventListener("click", function () { loadScans().then(function () { toast("Обновлено"); }); });
  $("startScan").addEventListener("click", function () {
    if (!/^device:/.test(state.scanTarget || "")) { toast("Выберите планшет."); return; }
    apiSend("/scan/start", "POST", { target: state.scanTarget })
      .then(function () { toast("Сканирование запущено на планшете"); })
      .catch(function () { /* already reported by api() */ });
  });
  $("stopScan").addEventListener("click", function () {
    if (!/^device:/.test(state.scanTarget || "")) { toast("Выберите планшет."); return; }
    apiSend("/scan/stop", "POST", { target: state.scanTarget })
      .then(function () { toast("Сканирование остановлено"); })
      .catch(function () { /* already reported by api() */ });
  });

  // ---------------- API docs ----------------
  var API_ENDPOINTS = [
    {
      method: "GET", path: "/api/ext/devices",
      desc: "Список всех планшетов: статус (онлайн/офлайн), группы и привязанное рабочее место.",
      sample: 'curl -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  {BASE}/api/ext/devices'
    },
    {
      method: "GET", path: "/api/ext/workstations",
      desc: "Список рабочих мест с внешними идентификаторами (externalId).",
      sample: 'curl -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  {BASE}/api/ext/workstations'
    },
    {
      method: "POST", path: "/api/ext/workstations",
      desc: "Создать рабочее место. Поле externalId - ключ в вашей учётной системе.",
      sample: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"externalId":"WS-204","name":"Касса 4","location":"1 этаж"}\' \\\n  {BASE}/api/ext/workstations'
    },
    {
      method: "POST", path: "/api/ext/enrollments",
      desc: "Сгенерировать код активации нового планшета. Можно сразу привязать к месту через workstationExternalId. Ответ: { code, expiresUtc }.",
      sample: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"Ресепшн 1","workstationExternalId":"WS-204"}\' \\\n  {BASE}/api/ext/enrollments'
    },
    {
      method: "PUT", path: "/api/ext/devices/{id}/workstation",
      desc: "Привязать планшет к рабочему месту по externalId места. Так внешняя система задаёт, какой планшет на каком месте.",
      sample: 'curl -X PUT -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"externalId":"WS-204"}\' \\\n  {BASE}/api/ext/devices/DEVICE_ID/workstation'
    },
    {
      method: "POST", path: "/api/ext/show-document",
      desc: "Показать документ на планшете с данными подписанта. Плейсхолдеры {{тег}} в шаблоне (текст задаётся в админке) заполняются из fields. Поддерживаемые теги: ФИО, ДР, Адрес регистрации, Пол (M/F), email, telephone, document, date, cross-border, urine, UG (true/false), text1..text10. Булевы теги принимают только true или false, в любом виде: настоящий JSON-булев true, либо строку true в кавычках, регистр не важен. Другое значение возвращает ошибку с именем тега, а не молчаливо скрытый блок. По этим же тегам работают условия показа блоков и страниц (см. раздел «Условия показа»). Есть условия по возрасту: он считается из даты рождения на сервере, поэтому присылать нужно только ДР, а документ сам решит, показывать ли блок для законных представителей (например «возраст меньше 14 лет»). Есть и условие по сроку: «до годовщины не больше N дней» считает день и месяц из даты, год не важен, и это случай дня рождения. Окно задаётся отдельно до годовщины и после неё, например четырнадцать дней до и один после. Дата принимается как 01.01.1990 или 1990-01-01; если её не удалось разобрать, приходит ошибка с именем тега, а не молча скрытый блок. Имена тегов сравниваются без учёта регистра: пол, Пол и ПОЛ это один и тот же тег. Массив checkboxes задаёт пункты согласия: если key совпадает с именем чекбокса в документе, задаётся его начальное состояние прямо на своём месте; если такого имени в документе нет, пункт добавляется в конец страницы, помеченной как приёмник, и тогда нужен label. Массив groups задаёт выбор в двойных зависимых чекбоксах: key - имя группы в документе, selected - имя выбранного варианта, пустая строка означает, что не выбрано ничего. Текст тоже можно прислать: label у чекбокса и title у группы заменяют формулировку документа целиком, а labelAppend и titleAppend дописывают к ней, если внешняя система не знает, что именно написано в документе. Подписи вариантов группы задаются так же: groups[].options[] с key варианта и label или labelAppend. Если прислать options, они и становятся списком вариантов вместо того, что стоит в документе: заказ может приходить со своим набором ответов, а складывать два набора значило бы показать клиенту оба сразу. Дописка, начинающаяся со знака препинания, прилипает к предыдущему слову без пробела. Присланный текст живёт до конца этого показа и в шаблон не попадает. Цель: deviceId или workstationExternalId (если на месте несколько планшетов - ответ 409, укажите deviceId: показать документ не на том экране хуже, чем вернуть ошибку). В ответе missingPlaceholders - какие теги не переданы.",
      sample: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"WS-204",\n       "fields":{"ФИО":"Иванова Анна","ДР":"01.01.1990","Пол":"F",\n                 "email":"a@example.by","telephone":"+375291234567",\n                 "document":"MP1234567","date":"20.08.2026",\n                 "cross-border":true,"urine":true,"UG":false,\n                 "Адрес регистрации":"г. Минск, ул. Ленина 1","text1":"доп. текст"},\n       "checkboxes":[{"key":"consent","checked":true},\n                     {"key":"golod","labelAppend":"(с 22:00)"},\n                     {"label":"Согласен на рассылку","checked":false,"required":false}],\n       "groups":[{"key":"transfer","selected":"deny","title":"Передача данных",\n                  "options":[{"key":"deny","label":"Запрещаю"}]}]}\' \\\n  {BASE}/api/ext/show-document'
    },
    {
      method: "GET", path: "/admin/#watch={код рабочего места}",
      desc: "Не метод API, а прямая ссылка: открывает в админке наблюдение за экраном нужного планшета. Внешняя система может дать её оператору рядом со своим заказом, чтобы он не искал планшет в списке. Адресуется код рабочего места (workstationExternalId), как и везде; имя планшета и внутренний идентификатор тоже принимаются. Оператор должен быть уже вошедшим в админку. Окно только для просмотра: оттуда на планшет не уходит ничего, камера у оператора не открывается, запись не ведётся.",
      sample: '{BASE}/admin/#watch=WS-204'
    },
    {
      method: "POST", path: "/api/ext/scan-request",
      desc: "Запросить сканирование ШК/QR и ДОЖДАТЬСЯ результата: на планшете открывается камера, клиент показывает код, код возвращается в ответе и сохраняется. Поддерживаются QR, Data Matrix, EAN-13, EAN-8, Code-128 и ITF (Interleaved 2 of 5, только цифры и только чётное их количество). Цель: deviceId или workstationExternalId. timeoutSec - сколько ждать (по умолчанию 60, максимум 300). Ответ: { ok, code, format, scanId, createdUtc }. Если код не показали за отведённое время - 408 и камера на планшете закрывается. Если планшет не на связи - сразу 409 с объяснением, а не ожидание до таймаута: команда сканирования живёт только в момент отправки и до выключенного планшета не дойдёт.",
      sample: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"WS-204","timeoutSec":60}\' \\\n  {BASE}/api/ext/scan-request'
    },
    {
      method: "POST", path: "/api/ext/scan-cancel",
      desc: "Отменить сканирование на планшете и вернуть его к обычному экрану.",
      sample: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"WS-204"}\' \\\n  {BASE}/api/ext/scan-cancel'
    },
    {
      method: "GET", path: "/api/ext/scans",
      desc: "Последние считанные коды (сначала новые). Параметр limit (по умолчанию 50, максимум 500). Подходит, если удобнее опрашивать список, а не ждать ответа scan-request.",
      sample: 'curl -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  "{BASE}/api/ext/scans?limit=20"'
    },
    {
      method: "POST", path: "/api/ext/return-slides",
      desc: "Вернуть планшет к рекламе и очистить данные подписанта. Цель: deviceId или workstationExternalId.",
      sample: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"WS-204"}\' \\\n  {BASE}/api/ext/return-slides'
    }
  ];

  function renderApiDocs() {
    var base = window.location.origin;
    var baseEl = $("apiBaseUrl"); if (baseEl) baseEl.textContent = base;
    var wrap = $("apiDocsList"); if (!wrap) return; wrap.innerHTML = "";

    // Reference: the supported tags, conditions, formatting and checkboxes.
    var intro = el("div", "api-intro");
    intro.appendChild(el("h3", null, "Теги (поля) для подстановки"));
    intro.appendChild(el("p", "api-desc", "Значения передаются в fields запроса show-document, в шаблоне используются как {{тег}}. Неизвестный тег остаётся как есть, поэтому пропущенное поле видно."));
    var tags = el("div", "api-tags");
    KNOWN_FIELDS.forEach(function (f) { tags.appendChild(el("code", "ph-tag", "{{" + f + "}}")); });
    intro.appendChild(tags);
    intro.appendChild(el("h3", null, "Условия показа блоков и страниц"));
    intro.appendChild(el("p", "api-desc", "В редакторе документа блок текста или целую страницу можно показывать по условию на тег: равно, не равно, пусто, не пусто, одно из. Пример: блок показывать, если Пол равно F; страницу «Трансграничная передача» - если cross-border равно true."));
    intro.appendChild(el("p", "api-desc", "Условий может быть несколько, соединённых через «и»: содержимое показывается, только если выполнены все сразу. Например: Пол равно F и UG равно true. Имена тегов сравниваются без учёта регистра, поэтому пол, Пол и ПОЛ это один и тот же тег и в условии, и в запросе, и в подстановке."));
    intro.appendChild(el("h3", null, "Оформление и чекбоксы"));
    intro.appendChild(el("p", "api-desc", "Текст заголовков и блоков оформляется в редакторе (жирный, курсив, размер, цвет) и так же выводится на планшете и в PDF. В блок можно вставить картинку и задать её ширину. Чекбоксы из API (массив checkboxes) приходят с полем checked - отмеченным или пустым. На странице подписи блоки размещаются и над полем подписи, и под ним: реквизиты, печать, пояснение. Условия показа работают и там."));
    intro.appendChild(el("h3", null, "Именованные чекбоксы и группы вариантов"));
    intro.appendChild(el("p", "api-desc", "У чекбокса в редакторе можно задать имя, и тогда внешняя система задаёт состояние именно ему: {\"key\":\"consent\",\"checked\":true}. Чекбокс без имени и чекбокс с незнакомым именем по-прежнему просто дописываются на страницу с якорем «Показывать здесь чекбоксы, присланные по API». Текст можно переопределить полем label, иначе берётся из шаблона."));
    intro.appendChild(el("p", "api-desc", "Группа вариантов это набор, где выбрать можно только один, и «ни одного» тоже допустимое состояние. Задаётся массивом groups: {\"key\":\"transfer\",\"selected\":\"deny\"}. Пустое selected снимает выбор. Имена чекбоксов и групп живут отдельно от тегов: одно имя никогда не значит две вещи."));
    intro.appendChild(el("h3", null, "Условия по тому, что отметил клиент"));
    intro.appendChild(el("p", "api-desc", "В условии показа можно выбрать не только тег, но и имя чекбокса или группы. Такое условие считается прямо на планшете, пока клиент заполняет документ: блок появляется и исчезает по нажатию. Обязательный пункт, скрытый условием, не блокирует кнопку «Далее», иначе клиент упирался бы в галочку, которой не видит."));
    intro.appendChild(el("p", "api-desc", "В подпись и в PDF попадает только то, что клиент действительно видел: сервер пересчитывает условия по его финальным отметкам. Скрытый пункт не записывается как сознательный отказ. В записи подписи чекбоксы лежат с ключами, а группы отдельным списком, вместе со всеми вариантами, из которых выбирали."));
    intro.appendChild(el("h3", null, "Резервная копия шаблона"));
    intro.appendChild(el("p", "api-desc", "На вкладке «Документ» кнопки «Экспорт» и «Импорт» сохраняют все страницы в файл и восстанавливают их обратно. Импорт заменяет текущие страницы целиком, поэтому перед правками полезно сделать экспорт."));
    intro.appendChild(el("h3", null, "Логи"));
    intro.appendChild(el("p", "api-desc", "Вкладка «Логи» показывает сбои сервиса и планшетов: ошибки отправки подписи, отказ камеры, сбои генерации PDF, перезапуски сервиса. Записи хранятся на сервере и переживают перезапуск."));
    intro.appendChild(el("h3", null, "Управление планшетами по локальной сети"));
    intro.appendChild(el("p", "api-desc", "Приложение FreeKiosk на планшете принимает команды по своему адресу в локальной сети (по умолчанию порт 8080). Включите управление на вкладке «Планшеты», и на карточке планшета появится кнопка «Управление»: обновить страницу, очистить кэш, перезапустить приложение, перезагрузить планшет, включить или выключить экран, яркость, звуковой сигнал, произнести текст, показать сообщение, снимок экрана. Сервер сам опрашивает планшеты каждые 5 минут и предупреждает о низком заряде и нехватке места, а при включённом автолечении поднимает зависший планшет: сначала перезапуском приложения, затем перезагрузкой. Если планшет не вернулся и после этого, автолечение останавливается и оператор получает уведомление, что планшет требует осмотра."));
    intro.appendChild(el("p", "api-desc", "Перезагрузка планшета и надёжное выключение экрана работают, когда FreeKiosk назначен владельцем устройства (Device Owner). Это делается один раз при настройке планшета: на чистом устройстве, без добавленных аккаунтов Google, командой adb shell dpm set-device-owner com.freekiosk/.DeviceAdminReceiver. В том же режиме FreeKiosk блокирует кнопки «Домой» и «Недавние» и шторку уведомлений, поэтому клиент не может выйти из киоска."));
    wrap.appendChild(intro);

    API_ENDPOINTS.forEach(function (ep) {
      var card = el("div", "api-ep");
      var head = el("div", "api-ep-head");
      var m = ep.method.toLowerCase();
      head.appendChild(el("span", "api-method api-" + m, ep.method));
      head.appendChild(el("span", "api-path", ep.path));
      var copy = iconBtn("copy", "Копировать", "btn-ghost btn-sm api-copy");
      var sample = ep.sample.replace(/\{BASE\}/g, base);
      copy.addEventListener("click", function () { copyText(sample); });
      head.appendChild(copy);
      card.appendChild(head);
      card.appendChild(el("p", "api-desc", ep.desc));
      card.appendChild(el("pre", "api-code", sample));
      wrap.appendChild(card);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Скопировано"); }, function () { toast("Не удалось скопировать"); });
    } else {
      var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("Скопировано"); } catch (e) { toast("Не удалось скопировать"); }
      document.body.removeChild(ta);
    }
  }

  // ---------------- Small form helpers ----------------
  function labeledInput(labelText, value) {
    var wrap = el("label", "field", labelText); var input = el("input"); input.type = "text"; input.value = value; wrap.appendChild(input); return { wrap: wrap, input: input };
  }
  // Workstation option label: name, external ID and description, so the operator can tell
  // workstations apart when several share a name.
  function wsOptionLabel(w) {
    var parts = [w.name || w.id];
    if (w.externalId) parts.push("ID: " + w.externalId);
    if (w.location) parts.push(w.location);
    return parts.join(" · ");
  }
  function labeledSelect(labelText, options) {
    var wrap = el("label", "field", labelText); var select = el("select");
    options.forEach(function (o) { select.appendChild(new Option(o.t, o.v)); }); wrap.appendChild(select); return { wrap: wrap, select: select };
  }

  // ---------------- Toast ----------------
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) { toastEl = el("div"); toastEl.className = "toast"; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.style.opacity = "1";
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.style.opacity = "0"; }, 2400);
  }

  // ---------------- Realtime ----------------
  // Reconnects for the whole life of the page (24/7): the automatic policy handles brief blips,
  // and onclose re-opens a fresh connection after longer outages (e.g. a server restart), then
  // re-syncs so the dashboard is never left stale.
  // Exactly ONE live connection per page: re-logging in (session expiry, logout and back) must not
  // stack connections, or every event would be handled N times.
  var hub = null;
  var hubRetry = null;

  function stopHub() {
    if (hubRetry) { clearTimeout(hubRetry); hubRetry = null; }
    if (hub) { var old = hub; hub = null; try { old.stop(); } catch (e) { /* ignore */ } }
  }

  // ==================================================================
  // Проверка всей схемы запросом, как из внешней системы
  // ==================================================================
  // Оператор вставляет тело запроса и нажимает «Отправить». Запрос уходит на тот же адрес, что и
  // у внешней системы, поэтому проверяется вся цепочка целиком: разбор полей, подстановка тегов,
  // условия показа, выбор планшета по коду рабочего места. Ошибка возвращается такой же, какую
  // получила бы интеграция, вместе с кодом ответа.
  function openApiTest() {
    collectDoc();
    var c = el("div", "apitest");
    c.appendChild(el("h3", null, "Проверка запроса API"));
    c.appendChild(el("p", "sig-meta", "Вставьте тело запроса и нажмите «Отправить запрос». Он уйдёт на /api/ext/show-document так же, как его прислала бы внешняя система, и документ появится на том планшете, который указан в запросе."));

    var поле = el("textarea", "api-input");
    поле.rows = 14;
    поле.spellcheck = false;
    // Заготовка собирается из настоящего документа: тегами, которые в нём есть, и планшетом,
    // который сейчас выбран. Оператору остаётся подставить значения, а не сочинять запрос.
    var цель = "";
    var sel = $("docTarget");
    var dev = null;
    if (sel && sel.value) {
      var id = String(sel.value).replace(/^device:/, "");
      dev = (state.devices || []).filter(function (d) { return d.id === id; })[0] || null;
    }
    if (dev && dev.workstation && dev.workstation.externalId) цель = '"workstationExternalId": "' + dev.workstation.externalId + '"';
    else if (dev) цель = '"deviceId": "' + dev.id + '"';
    else цель = '"workstationExternalId": "WS-204"';

    var поля = {};
    previewFields().forEach(function (k) { поля[k] = previewDefault(k); });
    var keys = docKeys();
    var тело = { fields: поля };
    if (keys.checks.length) тело.checkboxes = keys.checks.map(function (k) { return { key: k, checked: false }; });
    var groupNames = Object.keys(keys.groups);
    if (groupNames.length) тело.groups = groupNames.map(function (g) { return { key: g, selected: "" }; });
    var текст = JSON.stringify(тело, null, 2);
    поле.value = "{\n  " + цель + ",\n" + текст.slice(текст.indexOf("\n") + 1);
    c.appendChild(поле);

    var ключЛабел = el("label", "field", "Ключ API (необязательно: вошедший администратор проходит и без него)");
    var ключ = el("input"); ключ.type = "text"; ключ.placeholder = "sk_...";
    ключЛабел.appendChild(ключ); c.appendChild(ключЛабел);

    // Куда именно уйдёт запрос. Это настоящая отправка, а не имитация: если на планшете сейчас
    // подписывается живой клиент, документ у него сменится прямо под рукой. Поэтому цель
    // разбирается из запроса и показывается заранее, а на занятый планшет спрашивается ещё раз.
    var цельНадпись = el("div", "api-target");
    c.appendChild(цельНадпись);

    function найтиПланшет(тело) {
      var код = String((тело && (тело.workstationExternalId || тело.deviceId)) || "").trim().toLowerCase();
      if (!код) return null;
      return (state.devices || []).filter(function (d) {
        return String(d.id || "").toLowerCase() === код
          || (d.workstation && String(d.workstation.externalId || "").toLowerCase() === код);
      })[0] || null;
    }

    function обновитьЦель() {
      var тело1 = null;
      try { тело1 = JSON.parse(поле.value); } catch (e) { /* ещё не дописан */ }
      if (!тело1) { цельНадпись.className = "api-target"; цельНадпись.textContent = "Запрос пока не разобран."; return; }
      var d = найтиПланшет(тело1);
      if (!d) {
        цельНадпись.className = "api-target warn";
        цельНадпись.textContent = "Планшет по этому запросу не найден. Сервер ответит ошибкой, как ответил бы внешней системе.";
        return;
      }
      var занят = d.screen === "document";
      цельНадпись.className = "api-target" + (занят ? " busy" : " ok");
      цельНадпись.textContent = занят
        ? "Документ уйдёт на планшет «" + d.name + "», а на нём сейчас идёт подписание. Отправка прервёт его и заменит документ."
        : "Документ уйдёт на планшет «" + d.name + "»" + (d.online ? "." : ", а он сейчас не на связи: документ ляжет и покажется, когда планшет вернётся.");
    }
    поле.addEventListener("input", обновитьЦель);
    обновитьЦель();

    var ответ = el("pre", "api-code"); ответ.style.display = "none";
    c.appendChild(ответ);

    var actions = el("div", "modal-actions");
    var close = el("button", "btn btn-ghost", "Закрыть");
    close.addEventListener("click", closeModal);
    var смотреть = el("button", "btn btn-ghost", "Смотреть экран планшета");
    смотреть.style.display = "none";
    actions.appendChild(close); actions.appendChild(смотреть);
    var go = iconBtn("send", "Отправить запрос", "btn-primary");
    actions.appendChild(go);
    c.appendChild(actions);
    openModal(c, true);

    var последнийПланшет = "";
    go.addEventListener("click", function () {
      var тело1;
      try { тело1 = JSON.parse(поле.value); }
      catch (e) {
        ответ.style.display = "";
        ответ.textContent = "Это не JSON: " + (e && e.message ? e.message : e);
        return;
      }
      последнийПланшет = String(тело1.workstationExternalId || тело1.deviceId || "");
      // На планшете идёт подписание: спрашиваем ещё раз. Оборвать живого клиента посреди
      // документа хуже, чем задать один вопрос.
      var d = найтиПланшет(тело1);
      if (d && d.screen === "document" &&
          !confirm("На планшете «" + d.name + "» сейчас идёт подписание.\n\nОтправка прервёт его и заменит документ. Продолжить?")) return;
      go.classList.add("btn-wait");
      var headers = { "Content-Type": "application/json" };
      if ((ключ.value || "").trim()) headers["X-Api-Key"] = ключ.value.trim();
      fetch("/api/ext/show-document", {
        method: "POST", credentials: "same-origin", headers: headers, body: JSON.stringify(тело1)
      }).then(function (r) {
        return r.text().then(function (t) {
          var красиво = t;
          try { красиво = JSON.stringify(JSON.parse(t), null, 2); } catch (e) { /* не JSON */ }
          ответ.style.display = "";
          ответ.textContent = "HTTP " + r.status + "\n" + красиво;
          if (r.ok) {
            смотреть.style.display = "";
            toast("Запрос выполнен, документ ушёл на планшет");
          } else {
            смотреть.style.display = "none";
          }
        });
      }).catch(function (e) {
        ответ.style.display = "";
        ответ.textContent = "Запрос не ушёл: " + (e && e.message ? e.message : e);
      }).then(function () { go.classList.remove("btn-wait"); });
    });
    смотреть.addEventListener("click", function () {
      if (последнийПланшет) openWatchWindow(последнийПланшет, последнийПланшет);
    });
  }
  $("apiTest").addEventListener("click", openApiTest);

  // ==================================================================
  // Наблюдение за экраном планшета
  // ==================================================================
  // Оператор видит у себя то же, что клиент видит на планшете. Картинка не передаётся: документ
  // берётся с сервера один раз, а планшет присылает только то, что меняется, и окно
  // перерисовывает у себя. Расход измеряется сотнями байт на событие вместо мегабит видео.
  //
  // Окно только для просмотра: в нём нет ни одной кнопки, которая что-то меняет, и на планшет
  // отсюда не уходит ничего. Камера здесь не открывается никогда: про сканирование сообщается
  // словами, поэтому запроса на доступ к камере у оператора не появляется.
  //
  // Ничего не сохраняется: поток живёт, пока открыто окно, и не оставляет следов ни на сервере,
  // ни здесь.
  var watch = { deviceId: null, name: "", doc: null, mode: "", state: null, node: null, solo: false };


  // Окно, открытое ссылкой #watch=, показывает только экран планшета. Раньше в нём открывалась
  // вкладка «Планшеты», а наблюдение всплывало поверх неё окошком. Пока планшет был на связи,
  // это ещё сходило за задуманное, но стоило ему быть офлайн, и окошко не появлялось вовсе:
  // оператор получал новое окно со списком планшетов и мимолётной всплывашкой, которую успевал
  // не заметить, и не понимал, почему экрана нет.
  //
  // Теперь окно ждёт планшет само. Не на связи это не отказ: планшет мог перезагружаться или
  // только что получить документ, поэтому окно так и говорит и продолжает ждать, а экран
  // появляется сам, как только планшет отзовётся.
  var СОЛО_ОПРОС = 3000;
  function watchSoloStart(искомое) {
    if (watch.solo) return;              // окно уже в этом виде, второй раз перестраивать нечего
    watch.solo = true;
    document.body.classList.add("watch-solo");
    // Панели закрываются и в разметке, а не только правилом оформления: иначе в окне остаётся
    // открытой вкладка, которая просто не видна, и она продолжает подгружать свои данные.
    document.querySelectorAll(".panel").forEach(function (p) { p.classList.add("hidden"); });
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });

    var корень = el("div", "watch watch-solo-page");
    var шапка = el("div", "watch-head");
    var заголовок = el("h3", null, "Экран планшета");
    шапка.appendChild(заголовок);
    var метка = el("span", "watch-live", "поиск планшета…");
    шапка.appendChild(метка);
    корень.appendChild(шапка);
    корень.appendChild(el("p", "sig-meta", "Здесь видно то же, что видит клиент. Окно только для просмотра: изменить отсюда ничего нельзя, на планшет не уходит ничего, и запись не ведётся."));

    var рамка = el("div", "watch-frame");
    watch.node = el("div", "watch-screen");
    рамка.appendChild(watch.node);
    корень.appendChild(рамка);

    var низ = el("div", "modal-actions");
    var закрыть = el("button", "btn btn-ghost", "Закрыть окно");
    закрыть.addEventListener("click", function () {
      window.close();
      // Закрыть удаётся только окну, которое открыла сама страница. Ссылку могли открыть и
      // руками в обычной вкладке: там браузер закрытие запрещает, и кнопка выглядела бы
      // сломанной. Тогда возвращаемся в админку к списку планшетов, а не оставляем оператора
      // в окне, из которого нет выхода.
      setTimeout(function () {
        if (window.closed) return;
        location.hash = "#devices";
        location.reload();
      }, 300);
    });
    низ.appendChild(закрыть);
    корень.appendChild(низ);

    var место = document.querySelector(".content");
    if (место) место.appendChild(корень);
    watchSay("Ищем планшет…");

    var q = String(искомое || "").trim().toLowerCase();
    var идёт = false;
    function попытка() {
      if (watch.deviceId || идёт) return;         // уже смотрим или ответ ещё не пришёл
      идёт = true;
      apiJson("/devices").then(function (list) {
        идёт = false;
        if (watch.deviceId) return;
        var dev = (list || []).filter(function (d) {
          return (d.workstation && String(d.workstation.externalId || "").toLowerCase() === q)
            || String(d.name || "").toLowerCase() === q
            || String(d.id || "").toLowerCase() === q;
        })[0];
        if (!dev) {
          метка.textContent = "планшет не найден";
          метка.className = "watch-live off";
          watchSay("Планшет «" + искомое + "» не найден. Возможно, он удалён или в ссылке другое имя.");
          return;
        }
        заголовок.textContent = "Экран планшета: " + (dev.name || dev.id);
        if (!dev.online) {
          метка.textContent = "планшет не на связи";
          метка.className = "watch-live off";
          watchSay("Планшет «" + (dev.name || dev.id) + "» сейчас не на связи. Экран появится сам, как только планшет отзовётся.");
          return;
        }
        // Планшет нашёлся и на связи: с этого мгновения окно смотрит за ним, а опрос списка
        // больше ничего не решает.
        watch.deviceId = dev.id;
        watch.name = dev.name || dev.id;
        watch.doc = null; watch.state = null;
        метка.textContent = "наблюдение";
        метка.className = "watch-live";
        watchSay("Подключение к планшету…");
        watchStart();
      }).catch(function () {
        идёт = false;
        watchSay("Не удалось прочитать список планшетов. Пробуем ещё раз…");
      });
    }

    // Связь нужна и для самого наблюдения: без живого соединения планшету не сказать, что за
    // ним смотрят. Поэтому первая попытка ждёт соединения, а дальше опрос идёт по кругу.
    var ждём = setInterval(function () {
      if (!hub || hub.state !== "Connected") return;
      clearInterval(ждём);
      попытка();
      setInterval(попытка, СОЛО_ОПРОС);
    }, 200);
  }

  // Наблюдение открывается отдельным окном браузера, а не поверх админки: оператору обычно надо
  // и смотреть за клиентом, и продолжать работать в админке, а окно поверх этого не даёт. Внутри
  // того окна открывается та же самая админка по ссылке #watch=, поэтому вход, права и вид
  // остаются ровно теми же.
  function openWatchWindow(idOrCode, name) {
    var код = String(idOrCode || "").trim();
    if (!код) { toast("Планшет не выбран"); return; }
    var w = window.open("/admin/#watch=" + encodeURIComponent(код), "sk-watch-" + код,
      "width=1200,height=980,menubar=no,toolbar=no,location=no");
    if (!w) { toast("Браузер заблокировал новое окно. Разрешите всплывающие окна для этого адреса", true); return; }
    try { w.focus(); } catch (e) { /* окно уже на переднем плане */ }
  }

  function openWatch(dev) {
    if (!dev || !dev.id) return;
    watch.deviceId = dev.id;
    watch.name = dev.name || dev.id;
    watch.doc = null; watch.state = null;

    var root = el("div", "watch");
    var head = el("div", "watch-head");
    head.appendChild(el("h3", null, "Экран планшета: " + watch.name));
    var live = el("span", "watch-live", "наблюдение");
    head.appendChild(live);
    root.appendChild(head);
    root.appendChild(el("p", "sig-meta", "Здесь видно то же, что видит клиент. Окно только для просмотра: изменить отсюда ничего нельзя, на планшет не уходит ничего, и запись не ведётся."));

    var frame = el("div", "watch-frame");
    watch.node = el("div", "watch-screen");
    frame.appendChild(watch.node);
    root.appendChild(frame);

    var actions = el("div", "modal-actions");
    var close = el("button", "btn btn-ghost", "Закрыть");
    close.addEventListener("click", closeModal);
    actions.appendChild(close);
    root.appendChild(actions);

    openModal(root, true);
    watchSay("Подключение к планшету…");
    watchStart();
    watchAlive();
  }

  // Всплывающая подсказка с предложением посмотреть. Не открывает окно сама: оператор мог быть
  // занят другим, и подменять ему экран без спроса нельзя.
  function toastWatch(d) {
    // Своё место, а не общая всплывашка: та живёт две секунды и заменяется следующей, а здесь
    // нужно, чтобы предложение подождало оператора.
    var host = document.body;
    var box = el("div", "toast-watch");
    box.appendChild(el("span", null, "Документ отправлен на планшет «" + (d.name || d.deviceId) + "»"));
    var b = el("button", "btn btn-ghost btn-sm", "Смотреть");
    b.addEventListener("click", function () { box.remove(); openWatchWindow(d.deviceId, d.name); });
    box.appendChild(b);
    var x = el("button", "btn btn-ghost btn-sm", "×");
    x.addEventListener("click", function () { box.remove(); });
    box.appendChild(x);
    host.appendChild(box);
    setTimeout(function () { if (box.parentNode) box.remove(); }, 20000);
  }

  // На связи ли планшет, за которым смотрим. Метка «наблюдение» гаснет, когда он пропал.
  function watchAlive() {
    if (!watch.deviceId) return;
    apiJson("/devices").then(function (list) {
      var d = (list || []).filter(function (x) { return x.id === watch.deviceId; })[0];
      var метка = document.querySelector(".watch-live");
      if (!метка) return;
      if (!d) {
        метка.textContent = "планшет удалён";
        метка.className = "watch-live off";
      } else if (!d.online) {
        метка.textContent = "планшет не на связи";
        метка.className = "watch-live off";
      } else {
        метка.textContent = "наблюдение";
        метка.className = "watch-live";
      }
    }).catch(function () { /* список не прочитался, метку не трогаем */ });
  }

  function watchSay(text) {
    if (!watch.node) return;
    watch.node.innerHTML = "";
    watch.node.appendChild(el("div", "watch-note", text));
  }

  function watchStart() {
    if (!hub || !watch.deviceId) { watchSay("Нет связи с сервером."); return; }
    hub.invoke("WatchDevice", watch.deviceId)
      .then(watchLoad)
      .catch(function (e) { watchSay("Не удалось начать наблюдение: " + (e && e.message ? e.message : e)); });
  }

  function watchStop() {
    var id = watch.deviceId;
    watch.deviceId = null; watch.node = null; watch.doc = null; watch.state = null;
    if (hub && id) hub.invoke("UnwatchDevice").catch(function () { /* соединение уже закрыто */ });
  }

  // Документ читается с сервера тем же, каким его получил планшет. Здесь он только рисуется.
  function watchLoad() {
    if (!watch.deviceId) return;
    var id = watch.deviceId;
    return apiJson("/devices/" + encodeURIComponent(id) + "/screen").then(function (data) {
      if (watch.deviceId !== id) return;    // окно уже закрыли или переключили
      watch.doc = (data && data.document) || null;
      watch.mode = (data && data.mode) || "slides";
      watchRender();
    }).catch(function () { watchSay("Не удалось прочитать экран планшета."); });
  }

  function watchApply(deviceId, st) {
    if (!watch.deviceId || deviceId !== watch.deviceId) return;
    watch.state = st || null;
    watchRender();
  }

  function watchRender() {
    if (!watch.node) return;
    var st = watch.state;
    var mode = (st && st.mode) || watch.mode || "slides";

    if (mode === "scan") {
      watch.node.innerHTML = "";
      var sc = el("div", "watch-scan");
      sc.appendChild(el("div", "watch-scan-title", "Открыта камера"));
      sc.appendChild(el("div", "sig-meta", "Клиент подносит код к камере планшета. Здесь камера не включается."));
      if (st && st.scanCode) {
        sc.appendChild(el("div", "watch-code", st.scanCode));
        sc.appendChild(el("div", "sig-meta", "Код считан."));
      }
      watch.node.appendChild(sc);
      return;
    }
    if (mode === "slides") {
      // Показываем сам слайд, а не надпись про рекламу: оператору важно видеть, что на экране
      // идёт именно то, что он поставил. Картинка берётся из медиатеки, планшет её не шлёт.
      watch.node.innerHTML = "";
      var sl = el("div", "watch-slides");
      if (st && st.slide) {
        var im = el("img", "watch-slide"); im.src = st.slide;
        sl.appendChild(im);
        sl.appendChild(el("div", "sig-meta", "Слайд " + (st.slideIndex || 1) + " из " + (st.slideCount || 1)));
      } else {
        sl.appendChild(el("div", "watch-note", "На планшете идёт реклама."));
      }
      watch.node.appendChild(sl);
      return;
    }
    if (mode !== "document" || !watch.doc) { watchSay("Документ загружается…"); return; }

    var doc = watch.doc, pages = doc.pages || [];
    watch.node.innerHTML = "";

    var bar = el("div", "watch-bar");
    var шаг = st && st.step ? ("Шаг " + st.step + " из " + st.steps) : "Документ";
    bar.appendChild(el("span", null, шаг));
    bar.appendChild(el("span", "watch-title", doc.title || ""));
    watch.node.appendChild(bar);

    var body = el("div", "watch-body pv-body");
    var type = (st && st.type) || "page";
    if (type === "thankyou") {
      var th = el("h2", "pv-heading");
      var ta = (doc.thankYouAlign || "").toLowerCase();
      if (ta === "center" || ta === "right" || ta === "justify") th.style.textAlign = ta;
      previewRuns(th, labelRuns(doc.thankYouRuns, doc.thankYouText || "Спасибо!"));
      body.appendChild(th);
      (doc.thankYouBlocks || []).forEach(function (b) { previewBlock(body, b); });
    } else if (type === "signature") {
      body.appendChild(el("h2", "pv-heading", doc.signPrompt || "Распишитесь"));
      (doc.signBlocks || []).forEach(function (b) { previewBlock(body, b); });
      body.appendChild(watchInk(st && st.finalInk, "Клиент ещё не расписался"));
      (doc.signBlocksBelow || []).forEach(function (b) { previewBlock(body, b); });
    } else {
      var pi = st && st.pageIndex != null ? st.pageIndex : 0;
      var page = pages[pi];
      if (!page) { watchSay("Страница не найдена."); return; }
      watchPage(body, page, pi, st);
    }
    watch.node.appendChild(body);
  }

  // Страница рисуется теми же кирпичиками, что и предпросмотр, но без единого обработчика:
  // отметки здесь только показываются, нажать на них нельзя.
  function watchPage(body, page, pi, st) {
    var checks = (st && st.checks) || {};
    var picks = (st && st.picks) || {};
    var codes = (st && st.codes) || {};
    var signs = (st && st.signs) || {};
    var missing = {};
    ((st && st.missing) || []).forEach(function (m) { missing[m] = true; });

    var hruns = (page.headingRuns && page.headingRuns.length) ? page.headingRuns
      : (page.heading ? [{ text: page.heading }] : []);
    if (hruns.length) {
      var h = el("h2", "pv-heading");
      var ha = (page.headingAlign || "").toLowerCase();
      if (ha === "center" || ha === "right" || ha === "justify") h.style.textAlign = ha;
      previewRuns(h, hruns);
      body.appendChild(h);
    }
    var blocks = (page.blocks && page.blocks.length) ? page.blocks
      : (page.body ? [{ runs: [{ text: page.body }] }] : []);
    pageOrder(page, blocks).forEach(function (it) {
      if (it.kind === 0) { previewBlock(body, it.item); return; }
      if (it.kind === 1) {
        var key = "p" + pi + "_c" + it.index;
        body.appendChild(watchCheck(it.item.labelRuns, it.item.label, !!checks[key], it.item.required, missing["check:" + key]));
        return;
      }
      if (it.kind === 2) {
        var g = it.item;
        var box = el("div", "pv-group");
        if (g.title || (g.titleRuns || []).length) {
          var gt = el("div", "pv-group-title");
          previewRuns(gt, labelRuns(g.titleRuns, g.title));
          if (g.required) gt.appendChild(el("span", "req", " *"));
          box.appendChild(gt);
        }
        var opts = el("div", "pv-group-options");
        (g.options || []).forEach(function (o) {
          opts.appendChild(watchCheck(o.labelRuns, o.label || o.key, (picks[g.key] || "") === o.key, false, false));
        });
        box.appendChild(opts);
        body.appendChild(box);
        return;
      }
      if (it.kind === 3) {
        var sg = it.item;
        var sw = el("div", "pv-inline-sign");
        sw.appendChild(el("div", "pv-inline-title", (sg.label || "Поле подписи") + (sg.required ? " *" : "")));
        sw.appendChild(watchInk(signs[sg.key], "Ещё не подписано"));
        body.appendChild(sw);
        return;
      }
      var sc = it.item;
      var cw = el("div", "pv-inline-scan");
      cw.appendChild(el("div", "pv-inline-title", (sc.label || "Сканирование кода") + (sc.required ? " *" : "")));
      cw.appendChild(el("div", codes[sc.key] ? "watch-code" : "sig-meta",
        codes[sc.key] ? codes[sc.key] : "Код ещё не считан"));
      body.appendChild(cw);
    });
  }

  function watchCheck(runs, plain, on, required, missed) {
    var row = el("div", "watch-check" + (on ? " on" : "") + (missed ? " miss" : ""));
    row.appendChild(el("span", "watch-box", on ? "✓" : ""));
    row.appendChild(labelNode("watch-label", runs, plain, required));
    return row;
  }

  function watchInk(dataUrl, empty) {
    var box = el("div", "watch-ink");
    if (dataUrl) {
      var im = el("img"); im.src = dataUrl; box.appendChild(im);
    } else {
      box.appendChild(el("div", "sig-meta", empty));
    }
    return box;
  }

  function connectHub() {
    stopHub();
    var conn = new signalR.HubConnectionBuilder()
      .withUrl("/hub/kiosk")
      // Своё правило, а не список задержек: список исчерпывается, и после последней попытки
      // страница перестаёт пытаться совсем. Открытая на ночь админка после моргнувшей сети
      // молча замирала бы до перезагрузки страницы.
      .withAutomaticReconnect({ nextRetryDelay: function (ctx) {
        var шаги = [0, 2000, 5000, 10000, 15000, 30000];
        var база = шаги[Math.min(ctx.previousRetryCount, шаги.length - 1)];
        return база + Math.floor(Math.random() * (база / 2 + 500));
      } })
      .configureLogging(signalR.LogLevel.Warning)
      .build();
    hub = conn;
    function reconnectLater() { if (hub === conn) { hubRetry = setTimeout(connectHub, 4000); } }
    conn.on("SignatureReceived", function () { toast("Получена новая подпись"); loadSignatures(); });
    conn.on("ScanReceived", function (s) {
      toast("Считан код: " + ((s && s.code) || ""));
      if (!document.querySelector('[data-panel="scan"]').classList.contains("hidden")) loadScans();
    });
    conn.on("DevicesChanged", function () {
      loadDevices();
      // За планшетом смотрят, а он мог уйти со связи. Застывшая картинка без единого слова
      // выглядит как поломка наблюдения, хотя дело в самом планшете.
      if (watch.deviceId) watchAlive();
    });
    // Планшет рассказал, что у него на экране. Приходит только тому, кто смотрит именно за ним.
    conn.on("WatchState", watchApply);
    // Документ поехал на планшет. Отправить его могла и внешняя система, поэтому оператору
    // предлагается посмотреть прямо отсюда: иначе он узнал бы об этом только случайно.
    conn.on("DocumentShown", function (d) {
      if (!d || !d.deviceId) return;
      if (watch.deviceId === d.deviceId) return;   // уже смотрим за этим планшетом
      toastWatch(d);
    });
    // На планшете сменился документ: перечитываем его целиком, иначе рисовали бы старый.
    conn.on("WatchReload", function () { watchLoad(); });
    conn.on("AlertsChanged", function () { loadAlerts(); });
    function reg() { conn.invoke("RegisterAdmin").catch(function () {}); }
    // Переподключение теряет группы: если окно наблюдения открыто, в свою надо войти заново.
    conn.onreconnected(function () { reg(); loadDevices(); loadAlerts(); if (watch.deviceId) watchStart(); });
    conn.onclose(reconnectLater);
    conn.start().then(reg).then(loadAlerts).catch(reconnectLater);
  }

  // ---------------- Init ----------------
  /// Кнопкам, объявленным в разметке, иконка проставляется по data-icon: так подпись и
  /// иконка не разъезжаются между разметкой и кодом.
  function applyMarkupIcons() {
    document.querySelectorAll("[data-icon]").forEach(function (b) {
      if (b.dataset.iconDone) return;
      b.dataset.iconDone = "1";
      var label = b.textContent;
      b.textContent = "";
      b.appendChild(icon(b.getAttribute("data-icon")));
      b.appendChild(el("span", null, label));
    });
  }

  function init() {
    applyMarkupIcons();
    // Realtime first and unconditionally: it drives alerts, live device state and new signatures.
    // It used to sit behind six data loads, so one transient error left the panel with no live
    // connection (and no alerts) until the operator reloaded the page.
    connectHub();
    var safe = function (fn) { return function () { return fn().catch(function (e) { console.error(e); }); }; };
    Promise.all([safe(loadFieldSchema)().then(safe(loadDoc)),
      safe(loadGroups)(), safe(loadWorkstations)(), safe(loadImages)(),
      safe(loadDevices)(), safe(loadKioskControl)()])
      .then(function () { renderTargetOptions(); return safe(loadPlaylist)(); })
      .then(safe(loadSignatures))
      .catch(function (e) { console.error(e); });
    // Вкладку восстанавливаем сразу, не дожидаясь загрузок: иначе оператор пару мгновений
    // видит «Слайды», а потом его перебрасывает, и это выглядит как сбой.
    restoreTab();
  }

  checkAuth();
})();
