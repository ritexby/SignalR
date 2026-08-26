/* Admin panel: slides, signing document, signatures, and fleet management -
   devices (enrollment codes, revoke, identify), groups, workstations, API keys. */
(function () {
  "use strict";

  // Какую версию страницы сервер отдаёт планшетам. Своей копии этой константы здесь больше
  // нет: копия жила в admin.js, вторая в kiosk.js, третья в шапке страницы, синхронизировались
  // они руками и разошлись на первом же выпуске. Кончилось это тем, что админка писала «старая
  // версия страницы» на каждой карточке всего парка, хотя страница у всех была свежая.
  //
  // Источник один и настоящий: сама страница, которую планшет и получает от этого сервера.
  // Пока она не прочитана, версия неизвестна, и тогда админка не обвиняет никого: недоказанное
  // обвинение хуже молчания, потому что после него идут снимать исправный планшет со стены.
  var версияСтраницы = null;

  function узнатьВерсиюСтраницы() {
    // Номер спрашивается у службы, а не вычитывается из самой страницы планшета: страница весит
    // за сотню килобайт, и качать её целиком ради одной строки означало бы платить этим за
    // каждое открытие админки. Служба читает файл один раз при запуске.
    return fetch("/api/admin/page-version", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (ответ) {
        if (!ответ || !ответ.version) return;
        версияСтраницы = ответ.version;
        // Той же строкой подписана и сама админка: иначе в шапке снова заведётся третья копия
        // номера версии, которую однажды забудут поправить.
        var знак = $("appVersion");
        if (знак) знак.textContent = "v" + версияСтраницы;
        // Список планшетов мог быть нарисован до того, как версия стала известна.
        if (state.devices && state.devices.length) renderDevices();
      })
      .catch(function () { /* не узнали: значит и обвинять некого */ });
  }

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
    // Нажатие «Выйти» это «я закончил, за этот браузер может сесть другой». Значит вместе с
    // кукой уходит и всё, что помнит браузер о работе: какой документ был открыт и черновики
    // несохранённых правок.
    //
    // Замер до починки: оператор А набрал в документе паспортные данные клиента и не сохранил,
    // вышел; оператор Б вошёл в том же браузере, попал в чужой документ, ему предложили
    // восстановить чужой черновик, и окно даже не сказало, чей он.
    //
    // Чистится ТОЛЬКО по нажатию кнопки. Показ окна входа сам по себе значит ещё и «кука
    // протухла, пока вы работали», и стирать там черновики значило бы своими руками уничтожать
    // несохранённую работу того же самого человека: беда ровно обратная и не легче.
    забытьРаботуБраузера();
    api("/logout", { method: "POST" }).catch(function () {}).then(showLogin);
  });

  /// Убрать из браузера всё, что помнит о работе этого оператора: открытый документ и черновики.
  function забытьРаботуБраузера() {
    // Сначала остановить запись черновика, потом стирать. Иначе стёртое возвращается: нажатие
    // «Выйти» уводит курсор из поля заголовка, это помечает документ изменённым и заводит
    // отложенную запись на 1200 мс, которая срабатывает уже после уборки. Замер: уборка
    // находила и стирала ключ, а через две секунды он снова лежал на месте.
    clearTimeout(draftTimer);
    dirty = false;
    try {
      sessionStorage.removeItem(КЛЮЧ_ОТКРЫТОГО);
      localStorage.removeItem(КЛЮЧ_ОТКРЫТОГО);
      // Черновиков столько, сколько документов правили: ключ у каждого свой, с номером
      // документа на конце. Собираем имена заранее: удаление на ходу сбивает перебор.
      var ключи = [];
      for (var i = 0; i < localStorage.length; i++) {
        var к = localStorage.key(i);
        if (к && к.indexOf(DRAFT_PREFIX) === 0) ключи.push(к);
      }
      ключи.forEach(function (к) { localStorage.removeItem(к); });
    } catch (e) { /* приватный режим: браузер и так ничего не помнит */ }
  }

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
  $("docTarget").addEventListener("change", function () { state.docTarget = this.value; syncOfflineNote(); });
  if ($("undoDoc")) $("undoDoc").addEventListener("click", шагНазад);
  // Ctrl+Z привычнее кнопки, но внутри поля ввода и редактора текста родная отмена полезнее:
  // там она возвращает буквы, а не весь документ. Перехватываем только вне полей.
  document.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || String(e.key).toLowerCase() !== "z") return;
    var t = e.target;
    var вПоле = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));
    if (вПоле) return;
    var панель = document.querySelector('[data-panel="document"]:not(.hidden)');
    if (!панель) return;
    e.preventDefault();
    шагНазад();
  });

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
    // Сначала те, что на связи. Отправить можно и на выключенный, документ его дождётся, но
    // выбирать по умолчанию надо рабочий, а не первый по алфавиту.
    var поПорядку = state.devices.slice().sort(function (a, b) {
      if (!!a.online === !!b.online) return 0;
      return a.online ? -1 : 1;
    });
    поПорядку.forEach(function (d) { sel.appendChild(new Option(d.name + (d.online ? "" : " (не на связи)"), "device:" + d.id)); });
    var exists = state.devices.some(function (d) { return "device:" + d.id === current; });
    sel.value = exists ? current : ("device:" + поПорядку[0].id);
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
  // Выбранный планшет не на связи. Говорим об этом до нажатия и объясняем, что произойдёт:
  // отправка не запрещена, документ дождётся планшета, но оператор должен решать это знающе.
  function syncOfflineNote() {
    var n = $("docOffline");
    if (!n) return;
    var id = String(state.docTarget || "").replace(/^device:/, "");
    var d = state.devices.filter(function (x) { return x.id === id; })[0];
    if (!d || d.online) { n.classList.add("hidden"); n.textContent = ""; return; }
    n.textContent = "Планшет «" + d.name + "» сейчас не на связи. Отправить можно: документ вместе с "
      + "данными клиента сохранится и покажется, как только планшет подключится. Если это не то, "
      + "чего вы хотите, дождитесь планшета: через два часа отправленное стирается само.";
    n.classList.remove("hidden");
  }

  function syncTabletActions() {
    syncOfflineNote();
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
  // Имя группы по её номеру. Удалённая группа сюда попасть не должна: ссылки на неё сервер
  // вычищает из картинок при удалении, но подстраховка дешевле пустой строки на экране.
  function имяГруппы(id) {
    var g = (state.groups || []).filter(function (x) { return x.id === id; })[0];
    return g ? g.name : id;
  }

  // Сколько планшетов подойдёт картинке по её группам. Ноль это ловушка: настройка задана, а
  // видеть картинку некому, и без подсказки оператор об этом не узнает.
  function планшетовПодходит(img) {
    var только = img.groupIds || [], кроме = img.exceptGroupIds || [];
    if (!только.length && !кроме.length) return (state.devices || []).filter(function (d) { return d.status !== "revoked"; }).length;
    return (state.devices || []).filter(function (d) {
      if (d.status === "revoked") return false;
      var свои = d.groupIds || [];
      if (кроме.length && свои.some(function (g) { return кроме.indexOf(g) >= 0; })) return false;
      if (!только.length) return true;
      return свои.some(function (g) { return только.indexOf(g) >= 0; });
    }).length;
  }

  // Короткая строка «Где» для карточки. Групп может быть много, и перечень имён в узкой карточке
  // превратился бы в простыню: с трёх штук называем число, а полный перечень показывает панель.
  function описаниеГрупп(img) {
    var только = (img.groupIds || []).map(имяГруппы), кроме = (img.exceptGroupIds || []).map(имяГруппы);
    if (!только.length && !кроме.length) return "на всех планшетах";
    function свод(список, одна, много) {
      if (список.length <= 2) return список.join(", ");
      return список.length + " " + склонение(список.length, одна, много[0], много[1]);
    }
    var т = только.length ? свод(только, "группе", ["группах", "группах"]) : "на всех планшетах";
    return кроме.length ? (т + ", кроме " + свод(кроме, "группы", ["групп", "групп"])) : т;
  }

  // «1 группе», «2 группах», «5 группах»: без этого выходит «в 5 группа».
  function склонение(n, одна, две, много) {
    var д = n % 10, с = n % 100;
    if (д === 1 && с !== 11) return одна;
    if (д >= 2 && д <= 4 && (с < 10 || с >= 20)) return две;
    return много;
  }

  // Строка «Где: ...» на карточке. Открывает выбор групп: где показывать эту картинку и где не
  // показывать. Настройка у каждой картинки своя и не зависит от адресата всей рекламы («Кому»).
  function строкаГрупп(img) {
    var строка = el("div", "img-where");
    строка.addEventListener("click", function (e) { e.stopPropagation(); });
    var кнопка = el("button", "img-where-btn");
    кнопка.type = "button";
    кнопка.appendChild(el("span", "img-where-cap", "Где:"));
    кнопка.appendChild(el("span", "img-where-val", описаниеГрупп(img)));
    кнопка.title = "Где показывать эту картинку: во всех группах планшетов или только в выбранных, и где не показывать";
    кнопка.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      выборГрупп(img, кнопка);
    });
    строка.appendChild(кнопка);
    var подходит = планшетовПодходит(img);
    if (((img.groupIds || []).length || (img.exceptGroupIds || []).length) && !подходит) {
      var беда = el("div", "img-where-warn", "Ни один планшет не подходит под эти группы: картинку сейчас никто не увидит.");
      строка.appendChild(беда);
    }
    return строка;
  }

  // Выбор групп для одной картинки.
  //
  // Групп у большой сети бывает шестьдесят и больше, поэтому два отдельных списка «показывать» и
  // «кроме» не годятся: это сто двадцать строк, по которым надо ползать глазами и в которых
  // легко отметить одну и ту же группу в обоих. Список один, а у каждой строки три состояния:
  // не участвует, показывать, кроме. Противоречие тогда невозможно по построению, строк вдвое
  // меньше, и видно сразу, что с группой происходит. Сверху поиск по названию и итог словами.
  //
  // Панель кладётся в body, а не в карточку: у карточки обрезается всё, что вылезло за края.
  function выборГрупп(img, якорь) {
    document.querySelectorAll(".groups-pop").forEach(function (n) { n.remove(); });
    var панель = el("div", "groups-pop");
    панель.addEventListener("click", function (e) { e.stopPropagation(); });

    var шапка = el("div", "groups-pop-head");
    шапка.appendChild(el("div", "groups-pop-title", "Где показывать картинку"));
    var итог = el("div", "groups-pop-sum", "");
    шапка.appendChild(итог);
    панель.appendChild(шапка);

    var группы = (state.groups || []).slice().sort(function (a, b) {
      return String(a.name || "").localeCompare(String(b.name || ""), "ru");
    });
    if (!группы.length) {
      панель.appendChild(el("div", "groups-pop-empty",
        "Групп пока нет. Создайте их на вкладке «Группы», тогда картинку можно будет направить в нужные места."));
    }

    var только = (img.groupIds || []).slice(), кроме = (img.exceptGroupIds || []).slice();
    function состояние(id) {
      if (только.indexOf(id) >= 0) return "in";
      if (кроме.indexOf(id) >= 0) return "out";
      return "";
    }
    function поставить(id, что) {
      var i = только.indexOf(id); if (i >= 0) только.splice(i, 1);
      var j = кроме.indexOf(id); if (j >= 0) кроме.splice(j, 1);
      if (что === "in") только.push(id);
      if (что === "out") кроме.push(id);
    }
    function обновитьИтог() {
      if (!только.length && !кроме.length) { итог.textContent = "Сейчас: на всех планшетах"; return; }
      var т = только.length
        ? ("в " + только.length + " " + склонение(только.length, "группе", "группах", "группах"))
        : "на всех планшетах";
      итог.textContent = "Сейчас: " + т
        + (кроме.length ? (", кроме " + кроме.length + " " + склонение(кроме.length, "группы", "групп", "групп")) : "");
    }

    // Поиск нужен ровно тогда, когда групп много: на трёх он только занимает место.
    var поиск = null;
    if (группы.length > 8) {
      поиск = el("input", "groups-pop-search");
      поиск.type = "search";
      поиск.placeholder = "Поиск по названию";
      панель.appendChild(поиск);
    }

    панель.appendChild(el("div", "groups-pop-hint",
      "Ничего не выбрано - картинка идёт на все планшеты. «Кроме» сильнее «показывать»."));

    var список = el("div", "groups-pop-list");
    панель.appendChild(список);

    var строки = [];
    группы.forEach(function (g) {
      var строка = el("div", "groups-pop-row");
      var имя = el("span", "groups-pop-name", g.name || g.id);
      имя.title = g.name || g.id;
      строка.appendChild(имя);
      var переключатель = el("span", "groups-pop-switch");
      [["", "везде", "Группа не участвует в отборе"],
       ["in", "показывать", "Показывать картинку в этой группе"],
       ["out", "кроме", "Не показывать картинку в этой группе"]].forEach(function (в) {
        var b = el("button", "groups-pop-opt", в[1]);
        b.type = "button";
        b.title = в[2];
        b.setAttribute("data-val", в[0]);
        b.addEventListener("click", function (e) {
          e.preventDefault();
          поставить(g.id, в[0]);
          отрисовать();
        });
        переключатель.appendChild(b);
      });
      строка.appendChild(переключатель);
      строки.push({ id: g.id, узел: строка, имя: (g.name || g.id).toLowerCase() });
      список.appendChild(строка);
    });

    function отрисовать() {
      var что = поиск ? String(поиск.value || "").trim().toLowerCase() : "";
      var видно = 0;
      строки.forEach(function (r) {
        var подходит = !что || r.имя.indexOf(что) >= 0;
        r.узел.classList.toggle("hidden", !подходит);
        if (подходит) видно++;
        var сост = состояние(r.id);
        r.узел.classList.toggle("chosen", сост !== "");
        r.узел.querySelectorAll(".groups-pop-opt").forEach(function (b) {
          b.classList.toggle("on", b.getAttribute("data-val") === сост);
        });
      });
      пусто.classList.toggle("hidden", видно > 0 || !что);
      обновитьИтог();
    }
    var пусто = el("div", "groups-pop-empty hidden", "По этому запросу групп не нашлось.");
    список.appendChild(пусто);
    if (поиск) поиск.addEventListener("input", отрисовать);

    var низ = el("div", "groups-pop-foot");
    var сброс = el("button", "btn btn-ghost btn-sm", "Сбросить");
    сброс.type = "button";
    сброс.title = "Убрать все ограничения: картинка пойдёт на все планшеты";
    сброс.addEventListener("click", function () { только = []; кроме = []; отрисовать(); });
    низ.appendChild(сброс);
    var промежуток = el("span", "groups-pop-spacer");
    низ.appendChild(промежуток);
    var отмена = el("button", "btn btn-ghost btn-sm", "Отмена");
    отмена.type = "button";
    отмена.addEventListener("click", function () { панель.remove(); });
    var ок = el("button", "btn btn-primary btn-sm", "Сохранить");
    ок.type = "button";
    ок.addEventListener("click", function () {
      ок.disabled = true;
      apiSend("/images/" + img.id + "/groups", "PUT", { groupIds: только, exceptGroupIds: кроме })
        .then(function (r) { return r.json(); })
        .then(function () { панель.remove(); return loadImages(); })
        .then(function () { renderImages(); toast("Где показывать - сохранено"); })
        .catch(function () { ок.disabled = false; /* сообщение уже показано */ });
    });
    низ.appendChild(отмена); низ.appendChild(ок);
    панель.appendChild(низ);

    document.body.appendChild(панель);
    отрисовать();
    // Панель ставится под кнопкой и подтягивается внутрь окна, если у края не помещается:
    // у крайней правой карточки она иначе уезжала бы за экран.
    var r = якорь.getBoundingClientRect();
    var ш = панель.offsetWidth, в = панель.offsetHeight;
    var x = Math.min(r.left, Math.max(8, window.innerWidth - ш - 8));
    var y = r.bottom + 6;
    if (y + в > window.innerHeight - 8) y = Math.max(8, r.top - в - 6);
    панель.style.left = x + "px";
    панель.style.top = y + "px";
    if (поиск) setTimeout(function () { try { поиск.focus(); } catch (e) { /* окно уже закрыли */ } }, 0);
    setTimeout(function () {
      document.addEventListener("click", function убрать() {
        панель.remove();
        document.removeEventListener("click", убрать);
      }, { once: true });
    }, 0);
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
        // Главная причина «не показывается» это не срок, а то, что картинку не выбрали. Раньше
        // здесь в обоих случаях стояло «показывается всегда», и невыбранная картинка выглядела
        // работающей, хотя на планшет она не уходила вовсе.
        if (pos < 0) { метка.textContent = "не выбрана, не показывается"; метка.className = "img-date-state idle"; return; }
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
      card.appendChild(строкаГрупп(img));

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
    var checks = [], groups = {}, inputs = [], signs = [], scans = [];
    ((state.doc || {}).pages || []).forEach(function (p) {
      (p.checkboxes || []).forEach(function (c) { if (c.key && checks.indexOf(c.key) < 0) checks.push(c.key); });
      (p.groups || []).forEach(function (g) {
        if (!g.key) return;
        groups[g.key] = (g.options || []).map(function (o) { return o.key; }).filter(Boolean);
      });
      // Имена полей ввода, подписи и сканирования живут в условиях наравне с отметками: и
      // планшет, и сервер их так считают. В списке «выберите тег» их не было вовсе, и добраться
      // до этой возможности можно было только набрав имя руками через «другой тег...».
      (p.inputs || []).forEach(function (x) { if (x && x.key && inputs.indexOf(x.key) < 0) inputs.push(x.key); });
      (p.signatures || []).forEach(function (x) { if (x && x.key && signs.indexOf(x.key) < 0) signs.push(x.key); });
      (p.scans || []).forEach(function (x) { if (x && x.key && scans.indexOf(x.key) < 0) scans.push(x.key); });
    });
    return { checks: checks, groups: groups, inputs: inputs, signs: signs, scans: scans };
  }

  /// Всё, что можно поставить в условие: имя чекбокса, имя группы или тег.
  function isDocKey(name) {
    var k = docKeys();
    return k.checks.indexOf(name) >= 0 || Object.prototype.hasOwnProperty.call(k.groups, name)
      || k.inputs.indexOf(name) >= 0 || k.signs.indexOf(name) >= 0 || k.scans.indexOf(name) >= 0;
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

  /// Прочитать документ с сервера. «Перечитать» это не «открыть»: когда документ уже открыт и
  /// его перечитывают по чужой воле (взяли свежую версию из-за конфликта, освежили после смены
  /// кода), окно про черновик оператору не показывается. Он не открывал документ и о черновике
  /// не спрашивал, а окно поверх работы это как раз то, за что админку и ругают.
  function loadDoc(id, перечитывание) {
    // Черновик пишется таймером через 1200 мс после последней буквы. Если оператор набрал текст
    // и сразу ушёл на другой документ, таймер не успевал, и работа пропадала молча: черновика
    // нет, документ не сохранён, вернуться не к чему. Переход по закладке это дожимал руками, а
    // «Новый документ», «Создать копию» и ввоз файлом нет.
    //
    // Замер до починки: правка «БЫСТРЫЙ УХОД» и сразу «Создать копию» без пауз; после ухода в
    // черновике исходного документа пусто, в поле «ОСНОВНОЙ», окна с предложением восстановить
    // не появлялось.
    //
    // Дожимается здесь, потому что через loadDoc уходят ВСЕ пути: и те три, и переход по
    // закладке, и перезагрузка. Значит следующий путь, который кто-нибудь добавит, получит это
    // даром и не заведёт четвёртую дырку.
    if (dirty && docLoaded && редакторПоказывает && редакторПоказывает !== id) {
      clearTimeout(draftTimer);
      // Ключ берётся у того документа, С КОТОРОГО уходят, а не у state.docId: создание, копия и
      // ввоз переставляют state.docId на новый ещё до этого вызова, и черновик лёг бы под ключ
      // нового документа. Тогда правка не просто терялась, а всплывала потом в чужом документе.
      saveDraft(редакторПоказывает);
    }
    var путь = id ? "/document?id=" + encodeURIComponent(id) : "/document";
    return api(путь).then(function (r) {
      // Версия, от которой оператор правит. Уедет с сохранением, и сервер откажет, если
      // документ уже переписали из другого окна.
      state.docRev = r.headers.get("X-Doc-Rev") || "";
      // Какой именно документ открыт: от него зависит и ключ черновика, и адрес сохранения.
      state.docId = r.headers.get("X-Doc-Id") || id || "";
      return r.json();
    }).then(function (d) {
      state.doc = d;
      // Какой документ открыт, помнит браузер: перезагрузка страницы обязана вернуть оператора
      // туда, где он работал, а не в основной документ.
      запомнитьОткрытый(state.docId);
      // О черновике спрашивают на каждое открытие документа, а не один раз за загрузку страницы.
      черновикСпрошенДля = перечитывание ? state.docId : null;
      историяТихо = true;
      try { renderDoc(); } finally { историяТихо = false; }
      историяНачать();
      docLoaded = true;
      редакторПоказывает = state.docId;
      // Документ открыт заново: несохранённого в нём нет, значит нет и правки на закладке.
      // Снимается это после отрисовки: сборка редактора сама рассылает события правки, и
      // снятый до неё признак тут же зажёгся бы обратно.
      dirty = false;
      syncDirty();
      renderLibrary();
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

  // ---------------- Закладки документов и один источник для них ----------------
  // Закладки документов, как листы в книге: видно, что документов несколько, в каком ты сейчас,
  // и что рядом есть плюс. Выпадающий список этого не показывал вовсе: он выглядел настройкой,
  // а не местом, где ты находишься.
  //
  // Закладка обязана выглядеть одинаково, открыт её документ или нет. Источников было два:
  // у своей закладки имя и вид брались из открытого документа (state.doc), у чужих из
  // библиотеки, прочитанной один раз за загрузку страницы. Два источника расходятся всегда,
  // вопрос только когда, и выглядело это так, будто вкладка переименовывается при переходе на
  // неё. Заплатки «обновим имя ещё и здесь» лечили по одному месту и не лечили правила.
  //
  // Правило: ВСЁ, что видно на закладке и в её меню (имя, знак вида, пометка основного,
  // подсказка, шапка меню, текст подтверждения удаления), читается из записи документа в
  // docList и больше ниоткуда. Открытый документ вторым источником не является: его
  // несохранённая правка заголовка кладётся в ту же запись полем «правкаЗаголовка» и снимается
  // оттуда же. Библиотека перечитывается с сервера после каждого действия, которое её меняет:
  // сохранение, переименование, смена вида, копия, импорт, удаление, «сделать основным».

  /// Запись документа в библиотеке. Это и есть источник для закладки.
  function запись(id) {
    return docList.filter(function (x) { return x.id === id; })[0] || null;
  }

  /// То же правило имени, что и на сервере: заголовок документа, иначе отдельное название,
  /// иначе код. Повторено здесь затем, чтобы имя, показанное до сохранения, совпадало с тем,
  /// которое сервер вернёт после него.
  function имяДляСписка(заголовок, название, код) {
    var з = String(заголовок == null ? "" : заголовок).trim(); if (з) return з;
    var н = String(название == null ? "" : название).trim(); if (н) return н;
    return String(код == null ? "" : код).trim();
  }

  function имяЗакладки(d) {
    return имяДляСписка(d.правкаЗаголовка, d.name, d.code) || "без заголовка";
  }
  function видИнфо(d) { return String(d.kind || "") === "info"; }
  function подсказкаЗакладки(d) {
    return имяЗакладки(d) + "\nКод для API: " + d.code + (d.isDefault ? "\nОсновной документ" : "");
  }

  /// Несохранённая правка заголовка живёт на записи открытого документа и только на ней: одно
  /// место, где она заводится, и одно, где снимается. Иначе она осядет на чужой закладке или
  /// переживёт отказ от правок.
  function отразитьЗаголовокВСписке() {
    var поле = $("docTitle");
    // Чей документ сейчас в редакторе. Без этой проверки правка легла бы на запись документа,
    // который только начали открывать: закладка переключается раньше, чем долетает документ,
    // и на новой закладке на мгновение оказалось бы имя из поля от прежней.
    var свой = поле && dirty && редакторПоказывает && редакторПоказывает === state.docId;
    docList.forEach(function (d) {
      if (свой && d.id === state.docId) d.правкаЗаголовка = поле.value;
      else delete d.правкаЗаголовка;
    });
  }

  /// Документ, который сейчас показан в редакторе. Пока он не загружен, поля редактора
  /// принадлежат прежнему документу, и брать из них имя нельзя.
  var редакторПоказывает = "";

  /// Как выглядит закладка. Одна функция и одна запись: отсюда рисует и полная перерисовка
  /// ряда, и точечное обновление на каждую букву заголовка, поэтому «пока правишь» и «после
  /// перехода» это по построению одна и та же картинка.
  function оформитьЗакладку(таб) {
    var d = запись(таб.getAttribute("data-id"));
    if (!d) return;
    var свой = d.id === state.docId;
    таб.innerHTML = "";
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
    var инфо = видИнфо(d);
    var видЗнак = icon(инфо ? "eye" : "pen", "doc-tab-kind");
    видЗнак.setAttribute("title", инфо ? "Только показ, без подписи" : "Подписной документ");
    таб.appendChild(видЗнак);

    таб.appendChild(el("span", "doc-tab-name", имяЗакладки(d)));
    // Несохранённое видно прямо на закладке, как в редакторах кода. Это единственное, чем своя
    // закладка отличается от чужой: точка про несохранённое, а не про имя.
    if (свой && dirty) таб.appendChild(el("span", "doc-tab-dot", "•"));
    таб.title = подсказкаЗакладки(d);

    // Меню закладки: всё, что делают с самим документом, живёт здесь, а не в общем ряду кнопок,
    // где непонятно, к чему оно относится: к документу или к странице.
    var меню = el("span", "doc-tab-menu"); меню.textContent = "⋯";
    меню.title = "Действия с документом";
    меню.addEventListener("click", function (e) {
      e.stopPropagation();
      if (d.id !== state.docId) { switchDoc(d.id); return; }
      docMenu(таб, запись(d.id) || d);
    });
    таб.appendChild(меню);
  }

  /// Своя закладка после правки в редакторе. Перерисовывается одна закладка, а не весь ряд:
  /// дёргать ряд под курсором оператора на каждую букву незачем.
  function освежитьСвоюЗакладку() {
    var своя = document.querySelector('[data-role="doctab"].on');
    if (своя) оформитьЗакладку(своя);
  }

  function renderLibrary() {
    var host = $("docTabs");
    if (!host) return;
    отразитьЗаголовокВСписке();
    host.innerHTML = "";

    docList.forEach(function (d) {
      var таб = el("button", "doc-tab"); таб.type = "button";
      таб.setAttribute("role", "tab");
      таб.setAttribute("data-role", "doctab");
      таб.setAttribute("data-id", d.id);
      // Что делает нажатие, решается в момент нажатия, а не в момент отрисовки: закладка живёт
      // дольше одной перерисовки, и запомненное «свой» однажды окажется чужим.
      таб.addEventListener("click", function () {
        if (таб.getAttribute("data-id") === state.docId) {
          docMenu(таб, запись(state.docId) || d);   // повторное нажатие на своей закладке открывает меню
          return;
        }
        switchDoc(таб.getAttribute("data-id"));
      });
      оформитьЗакладку(таб);
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
  // сохранения значит держать на закладке вчерашнее имя. Правка кладётся в ту же запись
  // библиотеки, из которой закладка и рисуется, поэтому показанное имя одно и то же и пока
  // правишь, и после перехода на другой документ и обратно.
  (function () {
    var поле = $("docTitle");
    if (!поле) return;
    поле.addEventListener("input", function () {
      // Правка заголовка это правка документа: без этого закладка узнавала бы о ней раньше,
      // чем страница узнаёт, что есть несохранённое.
      markDirty();
      отразитьЗаголовокВСписке();
      освежитьСвоюЗакладку();
    });
  })();

  function syncDocHeading() {
    var инфо = state.doc && String(state.doc.kind || "") === "info";
    var h = $("docHeading");
    if (h) h.textContent = инфо ? "Документ для показа" : "Документ для подписанта";
    var hint = $("docHint");
    var знак = document.getElementById("docHeadHelp");
    if (hint && !знак) {
      знак = помощь(hint.textContent || "");
      знак.id = "docHeadHelp";
      if (h && h.parentNode) h.parentNode.appendChild(знак);
    }
    if (hint) {
      hint.textContent = инфо
        ? "Этот документ не подписывают: его показывают клиенту и возвращают рекламу. Ни записи, ни PDF после него не остаётся. Показывается только на один выбранный планшет."
        : "Документ показывается только на один выбранный планшет (вместе с его персональными данными). Реклама (вкладка «Слайды») настраивается отдельно и может идти на все планшеты, группу или один - это независимо.";
      if (знак) знак.title = hint.textContent;
    }
  }

  // Меню закладки: переименование, вид, копия, основной, удаление.
  function docMenu(anchor, d) {
    closeDocMenu();
    var m = el("div", "doc-menu"); m.setAttribute("data-role", "docmenu");
    // Вид документа берётся из той же записи, что и знак на закладке: иначе меню предлагает
    // «сделать подписным» документу, у которого на закладке уже перо.
    var инфо = видИнфо(d);

    function пункт(значок, текст, действие, опасный) {
      var b = iconBtn(значок, текст, "btn-ghost btn-sm" + (опасный ? " btn-danger" : ""));
      b.addEventListener("click", function () { closeDocMenu(); действие(); });
      m.appendChild(b);
    }

    // Шапка меню это та же закладка, только словами: имя берётся оттуда же, а не из списка,
    // прочитанного когда-то раньше.
    m.appendChild(el("div", "doc-menu-head", имяЗакладки(d) + " · код " + d.code));

    пункт("pen", инфо ? "Сделать подписным" : "Сделать документом только для показа", function () {
      if (!state.doc || d.id !== state.docId) return;
      var прежний = state.doc.kind || null;
      state.doc.kind = инфо ? null : "info";
      // Список перечитывает само сохранение: вид в записи документа обновляет сервер, и
      // угадывать его здесь значило бы завести второй источник для знака на закладке.
      saveDoc().then(function () { renderDoc(); }).catch(function () {
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
        if (!confirm("Удалить документ «" + имяЗакладки(d) + "»?\n\n" +
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

  // Код документа, открытого в редакторе. Без него сервер берёт документ по умолчанию, и
  // оператор, правивший неосновной документ, отправлял на планшет совсем другой текст.
  function кодОткрытогоДокумента() {
    var d = docList.filter(function (x) { return x.id === state.docId; })[0];
    return d && d.code ? d.code : "";
  }

  // Какой документ был открыт, помнит браузер. Открытый документ не запоминался нигде, и
  // перезагрузка страницы всегда выбрасывала в основной: оператор правил договор, обновил
  // страницу и оказался в согласии, а его черновик остался лежать в браузере невидимым.
  // Помнится это дважды и с разным сроком: в окне (пока оно открыто) и в браузере (до
  // следующего раза). Двух админок в двух окнах хватает, чтобы разница стала видна: каждое окно
  // возвращается в свой документ, а не в тот, который последним открыли в соседнем. Открытое
  // заново окно берёт последний известный, и черновик того документа сразу предлагается.
  /// Одно ли это имя. Сравнение без учёта регистра и с обрезкой краёв, как на сервере и как на
  /// планшете. Служба всюду сравнивает имена элементов без регистра, и всё, что показывает
  /// оператору «то же, что видит клиент» (предпросмотр, окно наблюдения, прожектор условий),
  /// обязано считать так же. Иначе оператор смотрит на экран клиента и видит не то.
  function тоЖеИмя(своё, искомое) {
    return String(своё == null ? "" : своё).trim().toLowerCase()
        === String(искомое == null ? "" : искомое).trim().toLowerCase();
  }

  /// Дата из «01.01.1990», «1990-01-01» или «01/01/1990». Пусто, если разобрать не вышло.
  /// Повторяет разбор планшета: окно наблюдения обязано считать условия ровно так же, иначе
  /// оператор смотрит на экран клиента и видит не то.
  function датаДляНаблюдения(текст) {
    var v = String(текст == null ? "" : текст).trim();
    if (!v) return null;
    function собрать(г, мес, д) {
      if (мес < 1 || мес > 12 || д < 1 || д > 31) return null;
      var x = new Date(г, мес - 1, д);
      return (x.getFullYear() === г && x.getMonth() === мес - 1 && x.getDate() === д) ? x : null;
    }
    var m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return собрать(+m[1], +m[2], +m[3]);
    m = v.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (m) return собрать(+m[3], +m[2], +m[1]);
    return null;
  }

  /// Целое из строки, как на планшете: «5x» числом не считается.
  function целоеДляНаблюдения(текст) {
    var v = String(текст == null ? "" : текст).trim();
    return /^-?\d+$/.test(v) ? parseInt(v, 10) : null;
  }

  function возрастЛетДляНаблюдения(текст) {
    var д = датаДляНаблюдения(текст);
    if (!д) return null;
    var сейчас = new Date();
    var лет = сейчас.getFullYear() - д.getFullYear();
    var м = сейчас.getMonth() - д.getMonth();
    if (м < 0 || (м === 0 && сейчас.getDate() < д.getDate())) лет--;
    return лет < 0 ? null : лет;
  }

  /// Дни до годовщины в прошлом, этом и следующем году, со знаком. Три года, а не один: так же
  /// считает планшет и сервер, иначе окно у края года давало бы разный ответ.
  function дниДоГодовщиныДляНаблюдения(текст) {
    var д = датаДляНаблюдения(текст);
    if (!д) return null;
    var сейчас = new Date();
    var сегодня = new Date(сейчас.getFullYear(), сейчас.getMonth(), сейчас.getDate());
    var сутки = 24 * 3600 * 1000;
    var out = [];
    function високосный(г) { return (г % 4 === 0 && г % 100 !== 0) || г % 400 === 0; }
    [сегодня.getFullYear() - 1, сегодня.getFullYear(), сегодня.getFullYear() + 1].forEach(function (год) {
      var день = д.getDate(), месяц = д.getMonth() + 1;
      // 29 февраля в невисокосный год празднуют 28-го: иначе такая дата не совпала бы никогда.
      if (месяц === 2 && день === 29 && !високосный(год)) день = 28;
      out.push(Math.round((new Date(год, месяц - 1, день) - сегодня) / сутки));
    });
    return out;
  }

  var КЛЮЧ_ОТКРЫТОГО = "sk_doc_open";
  // Начало ключа черновика. Объявлено здесь, а не рядом с работой черновиков ниже по файлу:
  // им пользуется ещё и уборка при выходе из админки, а она стоит в самом верху. Объявление
  // ниже места первого применения означало бы, что при выходе имя ключа пусто и черновики не
  // стираются, а именно это и случилось при первой попытке починки.
  var DRAFT_PREFIX = "sk_doc_draft";
  function запомнитьОткрытый(id) {
    if (!id) return;
    try { sessionStorage.setItem(КЛЮЧ_ОТКРЫТОГО, id); } catch (e) { /* приватный режим */ }
    try { localStorage.setItem(КЛЮЧ_ОТКРЫТОГО, id); } catch (e) { /* приватный режим */ }
  }
  function запомненныйОткрытый() {
    try { var своё = sessionStorage.getItem(КЛЮЧ_ОТКРЫТОГО); if (своё) return своё; } catch (e) { /* нет так нет */ }
    try { return localStorage.getItem(КЛЮЧ_ОТКРЫТОГО) || ""; } catch (e) { return ""; }
  }

  function loadLibrary() {
    return apiJson("/documents").then(function (list) {
      docList = list || [];
      if (!state.docId) {
        // Тот, что правили в прошлый раз, если он ещё есть. Удалённый или чужой идентификатор
        // молча уступает место основному: гадать тут нельзя, документ открывается настоящий.
        var помню = запись(запомненныйОткрытый());
        var поумолч = помню || docList.filter(function (d) { return d.isDefault; })[0] || docList[0];
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
      var прежний = state.docId;
      state.docId = id;
      // В редакторе пока прежний документ, и его поля к новой закладке отношения не имеют.
      редакторПоказывает = "";
      renderLibrary();          // закладка переключается сразу, но без чужого имени на ней
      loadDoc(id).then(function () { renderLibrary(); }).catch(function () {
        // Документ не открылся: его могли удалить из другого окна. Возвращаемся к прежнему,
        // иначе закладки показывают одно, а редактор другое.
        state.docId = прежний;
        редакторПоказывает = прежний;
        renderLibrary();
        toast("Не удалось открыть документ. Возможно, его удалили из другого окна.", true);
      });
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
    // Главное действие своей строкой во всю ширину, два запасных ниже в общем ряду с зазором.
    // Раньше все три висели подряд прямо в окне: кнопки сходились вплотную и читались как одна.
    c.appendChild(сохранить);
    var ряд = el("div", "modal-actions modal-actions-left");
    ряд.appendChild(без); ряд.appendChild(отмена);
    c.appendChild(ряд);
    openModal(c);
  }

  /// Имя, под которым заведётся копия: «исходный (копия)», а если такое уже занято, с числом.
  /// Правило повторяет серверное, чтобы окно показывало ровно то имя, которое получится.
  function имяКопии(id) {
    var d = запись(id);
    var основа = d ? имяЗакладки(d) : "";
    if (!основа) return "";
    var занято = function (имя) {
      var н = имя.toLowerCase();
      return docList.some(function (x) { return имяЗакладки(x).toLowerCase() === н; });
    };
    var кандидат = основа + " (копия)";
    for (var n = 2; занято(кандидат) && n < 100; n++) кандидат = основа + " (копия " + n + ")";
    return кандидат;
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
    // Заголовок открытого документа, каким его прямо сейчас видит оператор. Пока он есть, имя
    // документа это он: правка поля ниже переписала бы заголовок в самом документе, а подпись
    // «пока у документа нет заголовка» обещала обратное. Поле в этом случае только показывает.
    var поле = $("docTitle");
    var свойЗаголовок = текущий && текущий.id === state.docId && поле
      ? String(поле.value || "").trim() : "";
    // Подпись поля говорит ровно то, что произойдёт. У нового документа и у копии заданное имя
    // станет заголовком самого документа, у документа с заголовком имя это и есть заголовок, и
    // только у документа без заголовка это отдельное название. Одна подпись на все три случая
    // и была той полуправдой, из-за которой оператор правил не то, что думал.
    var имяL = el("label", "field", !текущий
      ? "Название документа: оно станет его заголовком"
      : свойЗаголовок ? "Название документа: это его заголовок"
        : "Название, пока у документа нет заголовка");
    var имя = el("input"); имя.type = "text"; имя.placeholder = "например: Согласие на обработку данных";
    имя.value = текущий ? имяЗакладки(текущий) : (копияИз ? имяКопии(копияИз) : "");
    имяL.appendChild(имя); c.appendChild(имяL);
    if (свойЗаголовок) {
      // Отсюда документ переименовать можно, и это одно и то же имя, что в поле «Заголовок
      // документа»: подписант видит его же. Правка здесь переписывает заголовок в самом
      // документе, поэтому меняется и его версия.
      //
      // Раньше поле тут только показывало имя, и вот почему: переименование меняло версию, а
      // следующее «Сохранить документ» упиралось в отказ «изменён в другом окне» и теряло
      // правку. Теперь версия перечитывается сразу после переименования, не трогая набранного
      // оператором, поэтому запирать поле незачем.
      имя.title = "Это же имя стоит в поле «Заголовок документа» и его видит подписант.";
      c.appendChild(el("p", "sig-meta",
        "Это то же имя, что в поле «Заголовок документа», и его видит подписант. " +
        "Изменить его можно и здесь, и там."));
      var кЗаголовку = iconBtn("pen", "Перейти к полю «Заголовок документа»", "btn-ghost");
      кЗаголовку.addEventListener("click", function () {
        closeModal();
        if (!поле) return;
        if (поле.scrollIntoView) поле.scrollIntoView({ block: "center" });
        поле.focus(); поле.select();
      });
      c.appendChild(кЗаголовку);
    }
    var ok = iconBtn("check", текущий ? "Сохранить" : "Завести", "btn-primary");
    ok.addEventListener("click", function () {
      var тело = { code: код.value, name: имя.value };
      if (текущий) {
        apiSend("/documents/" + encodeURIComponent(текущий.id), "PUT", тело)
          .then(function () { closeModal(); return loadLibrary(); })
          .then(function () { return освежитьПослеПереименования(текущий.id); })
          .then(function () { toast("Сохранено"); })
          .catch(function () { /* уже показано */ });
      } else {
        тело.copyOfId = копияИз || null;
        // Заведение и копия уводят с открытого документа так же, как переход по закладке,
        // поэтому и спрашивать про несохранённое надо так же. Раньше эти два пути уводили без
        // вопроса, и правка, набранная минуту назад, оставалась только в черновике, о котором
        // оператор в этот момент не думает. Дожим черновика при уходе стоит в loadDoc и
        // сработает в любом случае, но вопрос важнее: он даёт сохранить по-настоящему.
        var завести = function () {
          apiSend("/documents", "POST", тело)
            .then(function (r) { return r.json(); })
            .then(function (созданный) {
              closeModal();
              state.docId = созданный.id;
              return loadLibrary().then(function () { return loadDoc(созданный.id); });
            })
            .then(function () { renderLibrary(); toast("Документ заведён"); })
            .catch(function () { /* уже показано */ });
        };
        if (!dirty) { завести(); return; }
        closeModal();
        var сп = el("div");
        сп.appendChild(el("h3", null, "Есть несохранённые правки"));
        сп.appendChild(el("p", "sig-meta",
          "Вы правили открытый документ и не сохранили. Сейчас редактор перейдёт на новый, и " +
          "правки останутся только в черновике этого браузера."));
        var сСохранением = iconBtn("save", "Сохранить и завести", "btn-primary");
        сСохранением.addEventListener("click", function () {
          closeModal();
          saveDoc().then(завести).catch(function () { /* уже показано */ });
        });
        var без = iconBtn("right", "Завести без сохранения", "btn-ghost");
        без.addEventListener("click", function () {
          closeModal();
          saveDraft();
          dirty = false; syncDirty();
          завести();
        });
        var отмена = iconBtn("back", "Остаться", "btn-ghost");
        отмена.addEventListener("click", function () { closeModal(); });
        сп.appendChild(сСохранением);
        var ряд2 = el("div", "modal-actions modal-actions-left");
        ряд2.appendChild(без); ряд2.appendChild(отмена);
        сп.appendChild(ряд2);
        openModal(сп);
      }
    });
    c.appendChild(ok);
    openModal(c);
  }
  /// Переименование переписывает заголовок в самом документе, значит меняет его версию.
  /// Клиент оставался со старой версией, и первое же сохранение из редактора упиралось в
  /// «документ изменён в другом окне»: оператор переименовал и получил отказ на ровном месте.
  /// Поэтому открытый документ после переименования перечитывается, а если в нём есть
  /// несохранённая правка, освежается хотя бы версия и заголовок: правку терять нельзя.
  function освежитьПослеПереименования(id) {
    if (!id || id !== state.docId) return Promise.resolve();
    if (!dirty) return loadDoc(id, true);
    // Есть несохранённая правка. Берётся ТОЛЬКО свежая версия документа: ради неё функция и
    // писалась, чтобы следующее сохранение не упёрлось в отказ «изменён в другом окне».
    //
    // Поле заголовка и state.doc.title здесь не трогаются ни при каких условиях. Раньше они
    // перезаписывались серверным заголовком, и это была молчаливая потеря работы: оператор
    // набирал заголовок, заходил сменить код для API, выходил, и набранное молча возвращалось
    // к прежнему. Признак «не сохранено» при этом горел, оператор был уверен, что работа на
    // месте, и своим же следующим сохранением уносил стёртое на службу, а черновик к тому
    // времени уже перезаписывался стёртым.
    //
    // Замер до починки: документу без заголовка дали имя «ДОГОВОР АРЕНДЫ», после окна кода в
    // поле пусто и в черновике пусто. Ни одной всплывашки про подмену показано не было.
    //
    // Перезаписывать было ещё и не за чем: окно кода документ с заголовком не переименовывает,
    // оно шлёт пустое имя, а по пустому имени служба в текст документа не заходит и версию не
    // меняет. То есть работа выбрасывалась ради перечитывания, которое ничего не приносит.
    //
    // Если когда-нибудь понадобится показать чужое переименование, спрашивать надо окном, как
    // это делает offerConflict, а не решать молча в пользу службы.
    return api("/document?id=" + encodeURIComponent(id)).then(function (r) {
      state.docRev = r.headers.get("X-Doc-Rev") || state.docRev;
      return r.json();
    }).then(function () {
      отразитьЗаголовокВСписке();
      освежитьСвоюЗакладку();
    }).catch(function () { /* не вышло: сохранение честно спросит про конфликт */ });
  }

  // Черновик предлагается для того документа, который открыли, и заново на каждое его открытие.
  // Сторож «один раз за загрузку страницы» вместе с потерей открытого документа при перезагрузке
  // и был потерей работы: правку второго документа не предлагали восстановить уже никогда.
  var черновикСпрошенДля = null;

  function maybeOfferDraft() {
    if (!docLoaded) return;
    if (черновикСпрошенДля === state.docId) return;   // об этом открытии уже спросили
    var окно = $("modal");
    if (окно && !окно.classList.contains("hidden")) return;   // поверх чужого окна не лезем
    черновикСпрошенДля = state.docId;
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

  // Значок «?» рядом с полем или инструментом: нажал, прочитал, закрыл. Описание висит и
  // подсказкой при наведении, чтобы его можно было прочесть, ничего не нажимая.
  function помощь(текст) {
    var b = el("button", "help-dot", "?");
    b.type = "button";
    b.title = текст;
    b.setAttribute("aria-label", "Что это");
    b.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      // Своё облачко, а не любое в том же поддереве: два значка рядом (у вида блока и у «в PDF»
      // лежат в одном родителе) закрывали облачко друг друга, и второй значок приходилось
      // нажимать дважды.
      var было = b.__шар && b.__шар.parentNode ? b.__шар : null;
      if (было) { было.remove(); b.__шар = null; return; }
      document.querySelectorAll(".help-bubble").forEach(function (n) { n.remove(); });
      // Текст берётся из подписи в момент нажатия: у значка в шапке документа он меняется вместе
      // с видом документа, и замкнутый при создании текст был бы уже неверным.
      var шар = el("div", "help-bubble", b.title || текст);
      b.__шар = шар;
      if (b.parentNode) b.parentNode.appendChild(шар);
      // Закрывается щелчком где угодно: держать открытым до повторного нажатия на тот же
      // значок значит копить на экране несколько облачков.
      setTimeout(function () {
        document.addEventListener("click", function убрать() {
          шар.remove();
          if (b.__шар === шар) b.__шар = null;
          document.removeEventListener("click", убрать);
        }, { once: true });
      }, 0);
    });
    return b;
  }
  // Подпись раздела со значком «?» рядом: то же, что sectionLabel, но с объяснением.
  function sectionLabelHelp(значок, текст, объяснение) {
    var n = sectionLabel(значок, текст);
    n.appendChild(помощь(объяснение));
    return n;
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
        // Свой размер в точках сильнее ступени: так же считают планшет, предпросмотр и PDF.
        // Класс ступени рядом с ним не пишется, иначе правило оформления с !important перебило
        // бы точки, и редактор один показывал бы не тот размер, что все остальные.
        if (r.sizePt >= 8 && r.sizePt <= 40) { cls = ""; sty.push("font-size:" + r.sizePt + "pt"); }
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
      var свои = 0;
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
          if (pt >= 8 && pt <= 40) свои = pt;
        }
      }
      // Ступень и точки это два способа сказать про один и тот же размер, поэтому побеждает
      // тот, что ближе к тексту: последнее, что оператор задал этому куску. Раньше точки
      // побеждали всегда, и кнопка «A++» поверх куска с заданными точками не делала ничего.
      if (elm.classList) {
        if (elm.classList.contains("rt-h")) { g.size = "h"; if (!свои) g.sizePt = 0; }
        else if (elm.classList.contains("rt-l")) { g.size = "l"; if (!свои) g.sizePt = 0; }
        else if (elm.classList.contains("rt-n")) { g.size = null; if (!свои) g.sizePt = 0; }
      }
      if (свои) { g.sizePt = свои; g.size = null; }
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

  /// Выделение, подрезанное по границам поля.
  /// Тройной щелчок по заголовку и Ctrl+A уводят край выделения за пределы поля: браузер
  /// прихватывает начало следующего узла. Такое выделение отбрасывалось целиком, и оформление
  /// не применялось, хотя оператор выделил весь текст. Отсюда и жалоба «выделяю слово - работает,
  /// выделяю заголовок целиком - число в поле меняется, а в редакторе ничего».
  function диапазонВПоле(ed) {
    var s = window.getSelection();
    if (!ed || !s || !s.rangeCount) return null;
    var r = s.getRangeAt(0);
    var задевает;
    try { задевает = r.intersectsNode(ed); } catch (e) { задевает = ed.contains(r.commonAncestorContainer); }
    if (!задевает) return null;
    var к = r.cloneRange();
    if (!ed.contains(к.startContainer)) к.setStart(ed, 0);
    if (!ed.contains(к.endContainer)) к.setEnd(ed, ed.childNodes.length);
    return к.collapsed ? null : к;
  }

  /// Всё содержимое поля одним диапазоном.
  function всёПоле(ed) {
    if (!ed || !ed.childNodes.length) return null;
    var r = document.createRange(); r.selectNodeContents(ed);
    return r.collapsed ? null : r;
  }

  /// Wrap the selection in a span the caller configures. A size or colour set on the new span has
  /// to win, so anything of the same kind already inside the selection is stripped first;
  /// otherwise an older nested span kept overriding the button that was just pressed.
  function wrapSelection(ed, applyFn, kind) {
    var s = window.getSelection();
    var range = диапазонВПоле(ed);
    // Размер без выделения применяется ко всему полю: оператор ставит курсор в заголовок и
    // задаёт размер, ожидая, что изменится заголовок. Цвет и маркер так не делают: ими
    // помечают кусок, и покрасить заодно весь блок было бы неожиданно.
    if (!range && (kind === "size" || kind === "sizept")) range = всёПоле(ed);
    if (!range) { ed.focus(); return; }
    var span = document.createElement("span"); applyFn(span);
    try { span.appendChild(range.extractContents()); range.insertNode(span); }
    catch (e) { toast("Это выделение оформить не получилось, выделите текст внутри одного поля", true); return; }
    // Ступень и точки это два способа задать один и тот же размер, поэтому при любой установке
    // размера с вложенных кусков снимаются оба: иначе внутренняя обёртка остаётся сильнее, и
    // нажатие не делает ровно ничего.
    if (kind === "size" || kind === "sizept")
      span.querySelectorAll("span").forEach(function (inner) {
        RT_SIZE_CLASSES.forEach(function (c) { inner.classList.remove(c); });
        inner.style.fontSize = "";
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

  // Ступени размера в точках ровно те же, что печатает PdfService: 11/15/20 для текста и
  // 14/18/24 для заголовка. Показывать экранный размер нельзя: на экране текст рисуется
  // крупнее бумаги, и число не сошлось бы с PDF.
  var РОЛИ_ЗАГОЛОВКА = { heading: 1, gtitle: 1, thanksheading: 1 };
  function ступеньВТочках(ed, шаг) {
    var заг = !!(ed && РОЛИ_ЗАГОЛОВКА[ed.getAttribute("data-role") || ""]);
    if (шаг === "h") return заг ? 24 : 20;
    if (шаг === "l") return заг ? 18 : 15;
    return заг ? 14 : 11;
  }

  /// Размер куска текста в точках. Читается так же, как читает editorToRuns: ближний к тексту
  /// кусок оформления сильнее дальнего, а на одном узле точки сильнее ступени.
  function точкиУзла(ed, node) {
    var n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n !== ed && n.nodeType === 1) {
      var st = n.style;
      if (st && st.fontSize && /pt$/.test(st.fontSize)) {
        var pt = parseInt(st.fontSize, 10);
        if (pt >= 8 && pt <= 40) return pt;
      }
      if (n.classList) {
        if (n.classList.contains("rt-h")) return ступеньВТочках(ed, "h");
        if (n.classList.contains("rt-l")) return ступеньВТочках(ed, "l");
        if (n.classList.contains("rt-n")) return ступеньВТочках(ed, "");
      }
      n = n.parentNode;
    }
    return ступеньВТочках(ed, "");
  }

  /// Размер выделенного текста или того места, где стоит курсор. Ноль, если в выделении
  /// сошлись разные размеры: показывать одно из них значило бы соврать.
  function точкиВыделения(ed) {
    if (!ed) return 0;
    var s = window.getSelection();
    var r = диапазонВПоле(ed), найдено = [];
    if (!r) {
      if (!s || !s.rangeCount) return 0;
      var д = s.getRangeAt(0), n = д.startContainer;
      if (!ed.contains(n)) return 0;
      if (n.nodeType === 1) n = n.childNodes[Math.max(0, д.startOffset - 1)] || n.childNodes[д.startOffset] || n;
      найдено.push(точкиУзла(ed, n));
    } else {
      var w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null), t;
      while ((t = w.nextNode())) {
        if (!t.nodeValue || !t.nodeValue.trim()) continue;
        var нр = document.createRange(); нр.selectNode(t);
        // Настоящее пересечение, а не касание краями: иначе соседний кусок другого размера
        // считался бы выделенным и поле молча пустело.
        if (r.compareBoundaryPoints(Range.START_TO_END, нр) <= 0) continue;
        if (r.compareBoundaryPoints(Range.END_TO_START, нр) >= 0) continue;
        найдено.push(точкиУзла(ed, t));
      }
      if (!найдено.length) найдено.push(ступеньВТочках(ed, ""));
    }
    for (var i = 1; i < найдено.length; i++) if (найдено[i] !== найдено[0]) return 0;
    return найдено[0] || 0;
  }

  /// Показать в панели размер того текста, где сейчас стоит курсор.
  function обновитьПолеРазмера() {
    if (!rtBar) return;
    var поле = rtBar.querySelector(".rt-pt input");
    // Пока в поле вводят, не мешаем. И пока в нём стоит набранное, но ещё не применённое
    // число, тоже: браузер шлёт blur раньше change, и обновление успевало затереть набранное
    // прежним размером - применялся он, а не то, что задал оператор.
    if (!поле || поле.__своё || document.activeElement === поле) return;
    var т = rtTarget ? точкиВыделения(rtTarget) : 0;
    поле.value = т ? String(т) : "";
  }

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
    // Кнопок «A», «A+» и «A++» здесь больше нет. Они делали ровно то же, что поле размера в
    // точках, только тремя заранее выбранными числами, и панель из-за них не помещалась в одну
    // строку. Два способа задать одно и то же это не выбор, а повод гадать, какой из них
    // победит: они и спорили между собой, пока это не пришлось разбирать отдельно.
    //
    // Понимание уже сделанного ими никуда не делось: куски со ступенью размера (size «l» и «h»)
    // по-прежнему читаются и показываются и на планшете, и в бумаге, и в поле размера видно их
    // размер в точках. Иначе документы, набранные раньше, потеряли бы вид.
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
    // Списки: две кнопки рядом с выравниванием. Нажатие переключает вид списка у блока, в
    // котором стоит курсор, и редактор сразу показывает маркеры и номера, а не просто строки.
    var спНет = el("span", "rt-sep");
    bar.appendChild(спНет);
    [["bullet", "•", "Маркированный список: каждая строка блока станет пунктом"],
     ["number", "1.", "Нумерованный список: каждая строка блока станет пронумерованным пунктом"]]
      .forEach(function (o) {
        var b = el("button", "rt-btn rt-list-btn", o[1]);
        b.type = "button"; b.title = o[2];
        b.setAttribute("data-list-btn", o[0]);
        b.addEventListener("mousedown", function (e) { e.preventDefault(); });
        b.addEventListener("click", function () {
          var карточка = rtTarget && rtTarget.closest ? rtTarget.closest('[data-role="blockcard"]') : null;
          if (!карточка) { toast("Поставьте курсор в текст блока"); return; }
          var сел = карточка.querySelector('[data-role="blocklistmode"]');
          if (!сел) return;
          сел.value = (сел.value === o[0]) ? "" : o[0];
          сел.dispatchEvent(new Event("change", { bubbles: true }));
          применитьВидСписка(карточка);
          syncRtBar();
          markDirty();
        });
        bar.appendChild(b);
      });

    var ptWrap = el("span", "rt-pt");
    var pt = el("input"); pt.type = "number"; pt.min = "8"; pt.max = "40"; pt.placeholder = "пт";
    pt.title = "Размер в точках. Показывает размер текста под курсором. Введите своё число: "
      + "выделенному куску или всему полю, если ничего не выделено";
    var ptRange = null, ptEd = null;
    function запомнитьВыделение() {
      if (!rtTarget) return;
      // Курсор без выделения значит «этот текст целиком»: оператор ставит курсор в заголовок и
      // задаёт размер, ожидая, что изменится заголовок.
      var r = диапазонВПоле(rtTarget) || всёПоле(rtTarget);
      if (!r) return;
      ptRange = r; ptEd = rtTarget;
    }
    // И мышью, и с клавиатуры: до поля можно дойти табуляцией.
    pt.addEventListener("mousedown", запомнитьВыделение);
    pt.addEventListener("focus", запомнитьВыделение);
    pt.addEventListener("input", function () { pt.__своё = true; });
    // Уход из поля: набранное либо уже применилось, либо оператор передумал. И то, и другое
    // значит, что поле снова показывает размер под курсором.
    pt.addEventListener("blur", function () {
      setTimeout(function () { pt.__своё = false; обновитьПолеРазмера(); }, 0);
    });
    pt.addEventListener("change", function () {
      if (!ptRange || !ptEd) запомнитьВыделение();
      if (!ptRange || !ptEd) return;
      var s = window.getSelection();
      s.removeAllRanges(); s.addRange(ptRange);
      var n = parseInt(pt.value, 10);
      if (n >= 8 && n <= 40) wrapSelection(ptEd, function (sp) { sp.style.fontSize = n + "pt"; }, "sizept");
      else wrapSelection(ptEd, function (sp) { sp.style.fontSize = ""; }, "sizept");
      // Выделение остаётся на том же куске: второе число подряд применялось в пустоту, потому
      // что диапазон обнулялся после первого применения, а нового фокуса в поле уже не было.
      ptRange = диапазонВПоле(ptEd);
      pt.__своё = false;
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
    // Подсказки отдельной строкой в панели больше нет. Она была неломающейся строкой в треть
    // ряда и сталкивала тег на вторую строку, а перенос в гибком ряду происходит раньше сжатия,
    // поэтому ужать её было нельзя. Вдобавок она появлялась и исчезала вместе с курсором, и
    // прилипшая панель прыгала по высоте, а с ней и весь документ под ней.
    //
    // Сказать то же самое есть чем: пока поле не выбрано, кнопки гаснут, а объяснение висит на
    // самой панели и показывается при наведении.
    return bar;
  }

  /// Панель встаёт над редактором документа и остаётся там всё время.
  function mountRtBar() {
    if (rtBar) return;
    var host = document.getElementById("rtBarHost");
    if (!host) return;
    rtBar = buildRtBar();
    host.appendChild(rtBar);
    // «Шаг назад» переезжает ВНУТРЬ панели, в её пустой правый край. Отменяют то, что только
    // что набрали или оформили, и кнопка должна стоять там же, где рука, в одной коробке с
    // остальным оформлением. Под панелью она читалась как что-то отдельное и занимала лишнюю
    // строку. В разметке она лежит рядом с панелью потому, что панель собирается кодом, а
    // разметка статическая.
    var кнопкаОтмены = host.querySelector(".tb-group-undo");
    if (кнопкаОтмены) rtBar.appendChild(кнопкаОтмены);
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
    rtBar.title = rtTarget ? "" : "Поставьте курсор в текст, чтобы оформить его";
    var карточкаСп = rtTarget && rtTarget.closest ? rtTarget.closest('[data-role="blockcard"]') : null;
    var селСп = карточкаСп ? карточкаСп.querySelector('[data-role="blocklistmode"]') : null;
    var now = alignOf(rtTarget);
    rtBar.querySelectorAll("[data-align-btn]").forEach(function (b) {
      b.classList.toggle("on", !!rtTarget && b.getAttribute("data-align-btn") === now);
    });
    // Общая блокировка идёт первой, своя после неё: раньше было наоборот, и кнопки списков
    // выглядели рабочими там, где список поставить некуда, например в заголовке страницы.
    Array.prototype.forEach.call(rtBar.querySelectorAll("button, select, input"), function (c) {
      c.disabled = !rtTarget;
    });
    обновитьПолеРазмера();
    rtBar.querySelectorAll("[data-list-btn]").forEach(function (b) {
      b.disabled = !селСп;
      b.classList.toggle("on", !!селСп && селСп.value === b.getAttribute("data-list-btn"));
    });
  }

  // Вид списка на самом редакторе блока. Строки в редакторе разделены переводом строки, и
  // маркеры рисуются правилами оформления по классу: так оператор видит список ровно там, где
  // его набирает, а не только в предпросмотре.
  function применитьВидСписка(карточка) {
    if (!карточка) return;
    var сел = карточка.querySelector('[data-role="blocklistmode"]');
    var ed = карточка.querySelector('[data-role="blockbody"]');
    if (!сел || !ed) return;
    var было = ed.classList.contains("rt-as-bullet") || ed.classList.contains("rt-as-number");
    var стало = сел.value === "bullet" || сел.value === "number";
    ed.classList.toggle("rt-as-bullet", сел.value === "bullet");
    ed.classList.toggle("rt-as-number", сел.value === "number");
    // Маркер рисуется у строки, поэтому в режиме списка каждая строка становится отдельным
    // узлом. Переводы строки и обычные абзацы читаются одинаково, так что документ от этого
    // не меняется: меняется только то, что видит оператор во время набора.
    if (стало && !было) построчно(ed);
  }

  // Разложить содержимое редактора по строкам: каждая строка отдельным узлом, чтобы у неё был
  // свой маркер или номер.
  function построчно(ed) {
    var runs = editorToRuns(ed);
    var строки = [[]];
    (runs || []).forEach(function (r) {
      String(r.text == null ? "" : r.text).split("\n").forEach(function (seg, i) {
        if (i > 0) строки.push([]);
        if (seg.length) строки[строки.length - 1].push({ text: seg, bold: r.bold, italic: r.italic,
          color: r.color, size: r.size, mark: r.mark, sizePt: r.sizePt });
      });
    });
    var html = строки.map(function (куски) {
      var внутри = runsToHtml(куски);
      return "<div class=\"rt-li\">" + (внутри || "<br>") + "</div>";
    }).join("");
    ed.innerHTML = html;
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

  // Размер под курсором показывается сразу, как курсор переехал. Панель до этого обновлялась
  // только при смене поля, и число в ней относилось к прошлому месту.
  document.addEventListener("selectionchange", function () {
    if (rtBar && rtTarget) обновитьПолеРазмера();
  });

  // Высота шапки нужна панели, чтобы прилипать точно под ней. При узком окне вкладки
  // переносятся на вторую строку, и высота меняется.
  function syncTopbarHeight() {
    var bar = document.querySelector(".topbar");
    document.documentElement.style.setProperty("--topbar-h", ((bar ? bar.offsetHeight : 0)) + "px");
    // И высота липкой шапки документа: под ней прилипает панель оформления текста, а высота
    // меняется от числа закладок и от того, переносятся ли кнопки на вторую строку.
    var шапкаДок = document.getElementById("docHeadSticky");
    document.documentElement.style.setProperty("--doc-head-h", ((шапкаДок ? шапкаДок.offsetHeight : 0)) + "px");
  }
  window.addEventListener("resize", syncTopbarHeight);
  // Шапка меняет высоту и без изменения окна: появилась пометка о несохранённом, добавилась
  // закладка, предупреждение о планшете не на связи. Следим за самой шапкой.
  (function () {
    var шапкаДок = document.getElementById("docHeadSticky");
    if (!шапкаДок || !window.ResizeObserver) return;
    new ResizeObserver(function () {
      document.documentElement.style.setProperty("--doc-head-h", шапкаДок.offsetHeight + "px");
    }).observe(шапкаДок);
  })();

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
    addAnd.title = "Показывать, только если выполнены все условия набора сразу";
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
    addOr.title = "Показывать, если выполнен хотя бы один из наборов целиком";
    addOr.addEventListener("click", function () { appendRow(true); });
    adds.appendChild(addAnd); adds.appendChild(addOr);
    adds.appendChild(помощь(
      "«И ещё условие» добавляет строку в тот же набор: блок покажется, только если выполнены "
      + "все строки набора сразу. «Или другой набор» начинает новый набор: хватит любого "
      + "выполненного целиком. Например, «Пол равно Ж и Возраст от 18» это один набор, а если "
      + "нужно ещё и «Пол равно М и есть направление», это второй набор, и подойдёт любой из них."));
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
      // Имена полей ввода, подписи и сканирования живут в условиях наравне с отметками: и планшет,
      // и сервер их так считают. В списке их не было вовсе, и о такой возможности оператор не
      // узнавал: добраться до неё можно было только набрав имя руками через «другой тег...».
      [["Поля ввода в документе", keys.inputs],
       ["Поля подписи в документе", keys.signs],
       ["Поля сканирования в документе", keys.scans]].forEach(function (пара) {
        if (!пара[1] || !пара[1].length) return;
        var og = document.createElement("optgroup"); og.label = пара[0];
        пара[1].forEach(function (k) { og.appendChild(new Option(k, k)); });
        fld.appendChild(og);
      });
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
        // Пустой край читается словами, а не знаком вопроса: «от 5 и выше» понятно, а «5..?»
        // читается как недописанное условие, хотя оно рабочее.
        var гр = String(c.value || "").split("..");
        var низ = String(гр[0] || "").trim(), верх = String(гр[1] || "").trim();
        var как = низ && верх ? "от " + низ + " до " + верх
          : низ ? "от " + низ + " и выше"
          : верх ? "до " + верх + " и ниже"
          : "промежуток не задан";
        return "«" + c.field + "» " + (не ? "не " : "") + как;
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
    // Все оформленные тексты это редакторы, а не поля: у них textContent, а не value. Подписи
    // пунктов читались через value и всегда давали undefined, поэтому тег, написанный в пункте,
    // не попадал ни в список использованных, ни в опрос значений для предпросмотра.
    document.querySelectorAll('#pagesEditor [data-role="heading"], #pagesEditor [data-role="blockbody"],' +
      ' #pagesEditor [data-role="cblabel"], #pagesEditor [data-role="gtitle"], #pagesEditor [data-role="olabel"]')
      .forEach(function (e) { texts.push(e.textContent || ""); });
    // Надписи полей ввода, подписей и сканирований это обычные поля.
    document.querySelectorAll('#pagesEditor [data-role="inplabel"], #pagesEditor [data-role="siglabel"],' +
      ' #pagesEditor [data-role="scanlabel"]')
      .forEach(function (i) { texts.push(i.value || ""); });
    // Ячейки таблиц: тег в таблице подставляется наравне с текстом, и его тоже надо спросить у
    // оператора в предпросмотре и предупредить, если внешняя система его не пришлёт.
    document.querySelectorAll('#pagesEditor input.table-cell').forEach(function (i) { texts.push(i.value || ""); });
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

  // Одна функция на всю админку. Прежде их было две с одним именем: объявленная ниже побеждала
  // молча, и все сообщения вида «Код рабочего места скопирован» превращались в «Скопировано».
  function copyText(text, done) {
    var готово = done || "Скопировано";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(готово); },
        function () { toast("Не удалось скопировать: " + text); });
      return;
    }
    // Старый WebView без Clipboard API: копируем через временное поле, а если и это не вышло,
    // показываем значение, чтобы его можно было выделить руками.
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(готово); }
    catch (e) { toast(text); }
    document.body.removeChild(ta);
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

    // Что делает отметка, видно из самой надписи, а не из подсказки под курсором. Слово «шапка»
    // ничего не объясняло: непонятно было ни что с этой строкой станет, ни где это будет видно.
    var шапкаСтрока = el("div", "table-head-row");
    var шапкаLabel = el("label", "check-inline");
    var шапкаCb = el("input"); шапкаCb.type = "checkbox"; шапкаCb.checked = шапкаЕсть;
    шапкаCb.setAttribute("data-role", "tblhead");
    шапкаLabel.appendChild(шапкаCb);
    шапкаLabel.appendChild(document.createTextNode(" Первая строка это заголовки столбцов"));
    шапкаСтрока.appendChild(шапкаLabel);
    шапкаСтрока.appendChild(помощь(
      "Первая строка таблицы будет напечатана как строка заголовков: полужирным шрифтом и на "
      + "серой плашке, одинаково на планшете и в PDF. В самом редакторе она тоже видна серой. "
      + "Снимите отметку, если первая строка это обычные данные."));
    wrap.appendChild(шапкаСтрока);

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

      // Строка ширин. Подпись видна всегда: без неё ряд полей с заглушкой «%» читался как
      // первая строка таблицы, в которой почему-то стоят проценты. Занимает всю ширину сетки,
      // поэтому стоит над полями ширин, а не сбоку от них.
      var подписьШирин = el("div", "table-width-cap");
      подписьШирин.appendChild(el("span", "table-width-cap-name", "Ширина столбцов, проценты"));
      подписьШирин.appendChild(el("span", "table-width-hint",
        "это не строка таблицы. Ширины действуют, только когда заданы у всех столбцов сразу; "
        + "если хоть одно поле пустое, столбцы будут поровну"));
      холст.appendChild(подписьШирин);

      for (var c = 0; c < cols; c++) {
        var w = el("input", "table-width"); w.type = "number"; w.min = "5"; w.max = "90";
        w.placeholder = "поровну"; w.setAttribute("data-width", String(c));
        if (ширины[c] > 0) w.value = ширины[c];
        w.title = "Ширина столбца " + (c + 1) + " в процентах от ширины таблицы, от 5 до 90. "
          + "Пусто хотя бы у одного столбца означает, что все столбцы будут поровну.";
        холст.appendChild(w);
      }
      холст.appendChild(el("span"));

      // Единственный столбец убрать нельзя: кнопка гаснет, а не молчит в ответ на нажатие.
      // Присваивание безопасно и до первой отрисовки: переменная объявлена через var и на
      // момент первого вызова уже получила значение.
      if (минусСтолбец) минусСтолбец.disabled = cols <= 1;

      данные.forEach(function (row, ri) {
        row.forEach(function (cell, ci) {
          var i = el("input", "table-cell"); i.type = "text";
          i.value = cell == null ? "" : cell;
          i.setAttribute("data-cell", ri + ":" + ci);
          i.placeholder = (шапкаCb.checked && ri === 0)
            ? "заголовок столбца " + (ci + 1)
            : "строка " + (ri + 1) + ", столбец " + (ci + 1);
          if (шапкаCb.checked && ri === 0) i.classList.add("table-cell-head");
          холст.appendChild(i);
        });
        var del = el("button", "btn btn-danger btn-sm", "×"); del.type = "button";
        // Номер строки в подсказке: кнопок в столбик много, и по одному крестику не видно, какую
        // именно строку он уберёт. Единственную строку убрать нельзя, и кнопка это показывает
        // видом, а не молчаливым бездействием в ответ на нажатие.
        var шапкаЗдесь = шапкаCb.checked && ri === 0;
        del.title = данные.length <= 1
          ? "Это единственная строка таблицы, убрать её нельзя"
          : "Убрать строку " + (ri + 1) + (шапкаЗдесь ? " (строку заголовков)" : "");
        del.disabled = данные.length <= 1;
        del.addEventListener("click", function () {
          собрать();
          if (данные.length <= 1) return;
          данные.splice(ri, 1); нарисовать(); markDirty();
        });
        холст.appendChild(del);
      });
    }

    // Надписи кнопок говорят, куда именно добавится и что именно уберётся: строка встаёт снизу,
    // столбец справа, а убирается всегда последний столбец. Прежде из надписи «Убрать столбец»
    // нельзя было понять, какой из них исчезнет.
    var кнопки = el("div", "table-actions");
    var плюсСтрока = iconBtn("plus", "Строка снизу", "btn-ghost btn-sm");
    плюсСтрока.title = "Добавить пустую строку в конец таблицы";
    плюсСтрока.addEventListener("click", function () {
      собрать();
      данные.push(new Array(столбцов()).fill(""));
      нарисовать(); markDirty();
    });
    var плюсСтолбец = iconBtn("plus", "Столбец справа", "btn-ghost btn-sm");
    плюсСтолбец.title = "Добавить пустой столбец в конец таблицы. Столбцов может быть не больше восьми";
    плюсСтолбец.addEventListener("click", function () {
      собрать();
      if (столбцов() >= 8) { toast("Больше восьми столбцов не читается ни на планшете, ни на бумаге", true); return; }
      данные.forEach(function (r) { r.push(""); });
      нарисовать(); markDirty();
    });
    var минусСтолбец = iconBtn("trash", "Убрать последний столбец", "btn-ghost btn-sm");
    минусСтолбец.title = "Убрать самый правый столбец вместе со всем, что в нём набрано";
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
      // Выбор идёт в модальном окне, вне панели документа, поэтому общий слушатель правок его
      // не видит: без этой пометки оператор ставил печать и уходил, теряя работу без вопроса.
      openImagePicker(function (url) {
        img.src = url; img.style.display = ""; bc.setAttribute("data-imgurl", url); markDirty();
      });
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
    // Оформление блока свёрнуто, пока им не пользуются. Раньше пять полей висели под каждым
    // блоком всегда, и оператор видел набор непонятных настроек, к которым непонятно что
    // относится. Теперь это одна строка, которая сама рассказывает, что задано.
    var стильБокс = el("details", "block-style-box");
    var стильЗаг = el("summary", "block-style-head");
    стильЗаг.appendChild(el("span", "block-style-name", "Оформление блока"));
    var стильИтог = el("span", "block-style-sum", "обычный");
    стильЗаг.appendChild(стильИтог);
    стильЗаг.appendChild(помощь(
      "Как выглядит сам блок: список с маркерами или номерами, плашка с фоном и рамкой, отступ "
      + "внутри плашки и расстояние между строками. Всё это попадёт и на планшет, и в PDF. "
      + "Оформление отдельных слов задаётся панелью над редактором, а не здесь."));
    стильБокс.appendChild(стильЗаг);
    // Признак «в PDF» это настройка блока, поэтому он стоит в шапке блока рядом с его видом,
    // а не отдельной строкой посреди карточки, где его искали глазами. Ограничений тут нет:
    // текст, картинка и таблица сами по себе ничего не подтверждают, исключить можно любой блок.
    var вPdfБлок = el("label", "check-inline pdf-flag head-flag");
    var вPdfБлокCb = el("input"); вPdfБлокCb.type = "checkbox";
    вPdfБлокCb.checked = b.inPdf !== false;
    вPdfБлокCb.setAttribute("data-role", "blockinpdf");
    вPdfБлок.title = "Снимите, если этот блок нужен только на экране. В записи он останется, в PDF не попадёт.";
    вPdfБлок.appendChild(вPdfБлокCb);
    вPdfБлок.appendChild(document.createTextNode(" в PDF"));
    вPdfБлок.appendChild(помощь(
      "Печатать этот блок в PDF. Снимите, если он нужен только на экране: подсказка, картинка "
      + "для клиента, пояснение. В записи подписи блок останется, в бумагу не попадёт."));
    modeBar.appendChild(помощь(
      "Блок это кусок страницы. «Текст» набирается прямо здесь и оформляется панелью сверху, "
      + "«Картинка» берётся из медиатеки или присылается внешней системой по тегу, «Таблица» "
      + "заполняется по ячейкам. Вид меняется на ходу, но набранное сохраняется только у "
      + "текущего вида: переключив блок в «Картинку», текст вы потеряете."));
    modeBar.appendChild(вPdfБлок);


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
    // Пояснение идёт перед самой строкой настроек, поэтому и добавляется раньше неё: вставка
    // «перед» работает только для узла, который уже лежит внутри, а строка добавляется следом.
    стильБокс.appendChild(стиль);
    bc.appendChild(стильБокс);

    // Строка над свёрнутым оформлением: по ней видно, что задано, не разворачивая.
    function итогОформления() {
      var части = [];
      if (сп.value === "bullet") части.push("маркированный список");
      else if (сп.value === "number") части.push("нумерованный список");
      if (фонВкл.checked) части.push("плашка");
      if (рамВкл.checked) части.push("рамка");
      var п = parseInt(отс.value, 10) || 0;
      if (п > 0) части.push("отступ " + п);
      var м = parseInt(меж.value, 10) || 0;
      if (м > 0) части.push("межстрочный " + м + "%");
      стильИтог.textContent = части.length ? части.join(", ") : "обычный";
      стильБокс.classList.toggle("on", части.length > 0);
    }
    [сп, фон, фонВкл, рам, рамВкл, отс, меж].forEach(function (n) {
      n.addEventListener("change", итогОформления);
      n.addEventListener("input", итогОформления);
    });
    сп.addEventListener("change", function () { применитьВидСписка(bc); });
    итогОформления();
    setTimeout(function () { применитьВидСписка(bc); }, 0);
    // Уже оформленный блок открыт сразу: прятать то, что человек задал, значит заставить его
    // искать это заново.
    стильБокс.open = стильБокс.classList.contains("on");

    function setMode(m) {
      bc.setAttribute("data-mode", m);
      textWrap.style.display = m === "text" ? "" : "none";
      imgWrap.style.display = m === "image" ? "" : "none";
      if (m === "table") таблицаНужна();
      tableHost.style.display = m === "table" ? "" : "none";
      // Список это про текст, а плашка про всё, кроме картинки: у картинки она рисовала бы
      // пустую коробку вокруг снимка.
      спLabel.style.display = m === "text" ? "" : "none";
      стильБокс.style.display = m === "image" ? "none" : "";
      btnText.classList.toggle("mode-on", m === "text");
      btnImg.classList.toggle("mode-on", m === "image");
      btnTable.classList.toggle("mode-on", m === "table");
    }
    // Смена вида блока это правка документа, и она бывает разрушительной: набранный текст
    // в режиме картинки не читается и при сохранении пропадёт. Пометка ставится в самих
    // обработчиках, а не внутри setMode: setMode зовётся ещё и при построении карточки, и
    // тогда только что открытый документ помечался бы правленым.
    btnText.addEventListener("click", function () { setMode("text"); markDirty(); });
    btnImg.addEventListener("click", function () { setMode("image"); markDirty(); });
    btnTable.addEventListener("click", function () { setMode("table"); markDirty(); });
    setMode(isTable ? "table" : isImage ? "image" : "text");

    var подписьУсл = el("div", "sub-label", "Условие показа блока");
    подписьУсл.appendChild(помощь(
      "Без условия блок видят все. С условием он появится только тогда, когда значение тега или "
      + "отметка клиента совпадёт с заданным. Условие можно проверить, не отправляя ничего на "
      + "планшет: включите «Показать, что увидит клиент при этих значениях» над редактором."));
    bc.appendChild(подписьУсл);
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
        // Пустая таблица не хранится ни с условием, ни без него: это заготовка. Раньше при
        // заданном условии она тоже выбрасывалась, но мимо счёта, и оператор не узнавал,
        // что его блок не сохранился.
        выброшеноПустых++;
        return null;
      }
      var blkT = оформление({ table: t });
      if (cond) blkT.visibleWhen = cond;
      return сПризнаком(blkT);
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
    // Все имена документа, а не только отметки и выборы. Раньше сюда не входили поля ввода,
    // подписи и сканирования, и проверка ругалась на исправное условие словами «такого имени
    // нет, блок не покажется никогда». Оператор либо убирал рабочее условие, либо переставал
    // верить проверке вообще, и тогда настоящие ошибки в том же списке проходили мимо.
    var known = keys.checks.concat(Object.keys(keys.groups), keys.inputs, keys.signs, keys.scans);
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
      // Без учёта регистра, как сравнивает сервер: иначе проверка обвиняет исправное условие,
      // написанное в другом написании, и обещает, что блок «не покажется никогда». Он и правда
      // не покажется клиенту, но в бумагу попадёт, и это ровно наоборот от сказанного.
      var isKey = known.some(function (k) { return тоЖеИмя(k, f); });
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

    /// Имя приводится к тому же виду, что и на сервере (CleanKey): обрезаются края, выбрасывается
    /// всё, кроме букв, цифр, дефиса, подчёркивания и точки. Иначе проверка сравнивает не то, что
    /// в итоге ляжет в документ.
    function имяКакНаСервере(key) {
      return String(key == null ? "" : key).trim().replace(/[^0-9A-Za-zА-Яа-яЁё\-_.]/g, "");
    }

    function noteKey(key, where) {
      // Сравнение без учёта регистра и по очищенному имени, потому что именно так сравнивает
      // сервер. Раньше сличались сырые имена как есть, и проверка молчала про «ААА» и «ааа»,
      // про «имя 1» и «имя1»: на экране разные, а в документе одно и то же. Замер: «Замечаний
      // нет», после сохранения на сервере лежало два одинаковых имени, и в бумаге отметки
      // вставали не на свои места.
      var чистое = имяКакНаСервере(key).toLowerCase();
      if (!чистое) return;
      if (seenKeys[чистое]) {
        problems.push({ level: "error", text: where + ": имя «" + key + "» уже занято (" + seenKeys[чистое] + "). "
          + "Регистр и знаки препинания не считаются: в документе это одно и то же имя, и в бумаге "
          + "отметки встанут не на свои места." });
      } else seenKeys[чистое] = where;
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

    // Правила отметок: пара взаимоисключающих пунктов, каждый из которых обязателен, сама по себе
    // непроходима (обязательность требует отметить оба, правило запрещает). Сервер приводит такое
    // к «выбрать ровно один», но оператор должен знать, что получилось не то, что он задал:
    // обязательность у нового пункта включена по умолчанию, и такая пара выходит сама собой.
    pages.forEach(function (p, pi) {
      (p.checkRules || []).forEach(function (r) {
        if (!r || r.kind !== "exclusive" || !r.keys) return;
        var обязательных = (p.checkboxes || []).filter(function (c) {
          return c && c.required && c.key && r.keys.indexOf(c.key) >= 0;
        });
        // Достаточно ОДНОГО обязательного: правило запрещает отметить больше одного, значит
        // обязательный пункт внутри него делает остальные варианты недостижимыми. Клиент
        // выбирает «Отказываюсь», нажимает «Далее» и видит «Нужно отметить» над пунктом, который
        // он сознательно не выбирал. Раньше проверка молчала, пока обязательных не станет два.
        if (обязательных.length < 1) return;
        problems.push({
          level: "warn",
          text: "Страница " + (pi + 1) + ": " + (обязательных.length > 1
            ? "взаимоисключающие пункты «" + обязательных.map(function (c) { return c.key; }).join("», «")
              + "» помечены обязательными все сразу. Отметить их все нельзя по правилу, а не отметить нельзя по обязательности. "
            : "во взаимоисключающем правиле пункт «" + обязательных[0].key
              + "» помечен обязательным. Тогда остальные варианты клиент выбрать не сможет: он выберет другой, "
              + "нажмёт «Далее» и увидит «Нужно отметить» над пунктом, который сознательно не выбирал. ")
            + "Документ сохранится как «выбрать ровно один»: обязательность у самих пунктов снимется. "
            + "Если задумано другое, снимите обязательность вручную или уберите правило."
        });
      });
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
      document.documentElement.style.overflowAnchor = "";
      stopEdge();
      if (!item) return;
      item.classList.remove("dragging");
      var wasMoved = moved;
      var landed = item.parentNode;
      item = null; moved = false;
      if (!wasMoved) return;
      // Порядок изменился, значит документ изменён. Раньше перетаскивание не помечало его
      // изменённым вовсе: ни точки «не сохранено», ни черновика, ни вопроса при уходе. Оператор
      // расставлял блоки в нужном порядке, ничего больше не трогал, уходил, и порядок молча
      // возвращался к прежнему. Замер: порядок стал [ВТОРОЙ, ПЕРВЫЙ], метки нет, черновика нет,
      // при перезагрузке ничего не спросили и вернулся [ПЕРВЫЙ, ВТОРОЙ].
      markDirty();
      // Порядок изменился: перечитываем документ из DOM. Для страниц ещё и перерисовываем,
      // иначе номера страниц и оглавление разойдутся с тем, что на экране.
      if (list === $("pagesEditor")) { collectDoc(); collapsedPages = {}; renderPages(); }
      else if (list.getAttribute("data-role") === "itemlist") {
        // Полосы вставки пересобираются в обоих списках: и там, откуда унесли, и там, куда
        // положили, иначе в одном из них полосы окажутся подряд.
        normalizeBars(list);
        if (landed && landed !== list && landed.getAttribute("data-role") === "itemlist") normalizeBars(landed);
        // Пункт могли унести на другую страницу: признак «в PDF» пересчитывается у обеих, иначе
        // страница, с которой ушла последняя отметка, так и осталась бы запертой в PDF, а та,
        // куда её принесли, показывала бы снятую галочку, вопреки тому, что напечатает сервер.
        обновитьПризнакPdf(list.closest('[data-role="pagecard"]'));
        if (landed && landed !== list) обновитьПризнакPdf(landed.closest('[data-role="pagecard"]'));
      }
      updatePlaceholders();
    }

    list.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      // Один жест это одно перетаскивание. Список элементов страницы лежит внутри списка
      // страниц, событие всплывает из первого во второй, и оба брались за дело разом: оператор
      // тащил пункт, а вместе с ним ехала и вся его страница. Кто ближе к ручке, тот и берёт.
      if (e.__перетаскиваниеЗанято) return;
      var handle = e.target.closest && e.target.closest(".drag-handle");
      if (!handle || !list.contains(handle)) return;
      var target = handle.closest(itemSelector);
      // Ручка вложенного списка не должна тащить внешний элемент.
      if (!target || target.parentNode !== list) return;
      e.__перетаскиваниеЗанято = true;
      item = target; moved = false;
      item.classList.add("dragging");
      document.body.classList.add("dragging-now");
      // Пока элемент тащат, страница не должна подкручиваться сама. Браузер держит на месте
      // видимое содержимое (scroll anchoring), а перетаскивание меняет высоту как раз выше окна:
      // страница уезжала под неподвижным курсором, и элемент ложился не туда, куда оператор
      // целился, а на соседа. Своё правило оформления для этого не нужно, свойство ставится на
      // время жеста и снимается на отпускании.
      document.documentElement.style.overflowAnchor = "none";
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
    // Карточку страницы запоминаем до удаления: у вынутого узла соседей уже нет.
    var card = node.closest('[data-role="pagecard"]');
    node.remove();
    if (list) normalizeBars(list);
    обновитьПризнакPdf(card);
    updatePlaceholders();
  }

  // Подсказки к признаку «в PDF». Их две, и они меняются местами прямо во время работы, поэтому
  // текст лежит здесь, а не только там, где его однажды поставили.
  var ПОДСКАЗКА_PDF_ЗАПЕРТ = "На этой странице клиент что-то подтверждает, поэтому она обязана быть в PDF: " +
    "иначе в бумаге окажется отметка без того, под чем она стоит.";
  var ПОДСКАЗКА_PDF_СВОБОДЕН = "Снимите, если эта страница нужна только на экране: вступление, пояснение, " +
    "заставка. В записи она останется целиком, в PDF не попадёт.";

  /// Признак «в PDF» на карточке страницы, посчитанный по тому, что на странице стоит СЕЙЧАС.
  /// Раньше он считался только при полной перерисовке списка страниц, а вставка, удаление и
  /// перетаскивание список не перерисовывают, и галочка врала. На странице, куда добавили
  /// отметку, она оставалась снятой и доступной, хотя сервер такую страницу печатает всегда
  /// (DocumentTemplating.NormalizeScreens: HasInteraction значит InPdf = true). После удаления
  /// последнего пункта она, наоборот, оставалась стоящей и выключенной, и вернуть страницу
  /// «только на экран» было уже нельзя.
  function обновитьПризнакPdf(card) {
    if (!card) return;
    var cb = card.querySelector('[data-role="pageinpdf"]');
    if (!cb) return;
    var метка = cb.closest(".pdf-flag");
    var значок = метка ? метка.querySelector(".help-dot") : null;
    // Блок текста клиента ни о чём не спрашивает, всё остальное спрашивает. Считаем по разметке,
    // а не по state.doc: между сборами документа страница меняется прямо в списке. Собственное
    // поле экрана подписи или сканирования лежит вне списка элементов, но в карточке, и тоже
    // считается.
    var взаимодействие = card.querySelectorAll('.page-item:not([data-kind="block"])').length > 0;
    cb.disabled = взаимодействие;
    // Решение оператора возвращается, как только держать галочку больше нечему.
    cb.checked = взаимодействие || cb.getAttribute("data-own") !== "0";
    var текст = взаимодействие ? ПОДСКАЗКА_PDF_ЗАПЕРТ : ПОДСКАЗКА_PDF_СВОБОДЕН;
    if (метка) метка.title = текст;
    if (значок) значок.title = текст;
  }

  function normalizeBars(list) {
    // Вид страницы берётся с самого списка: полосы вставки пересобираются после удаления и
    // перетаскивания, и без него на экране подписи снова предлагались чекбоксы и таблицы. Они
    // добавлялись в документ, уходили на планшет, но в редакторе больше не рисовались: на
    // экране пункта нет, у клиента есть.
    var kind = list.getAttribute("data-pagekind") || "";
    Array.prototype.slice.call(list.querySelectorAll(":scope > .insert-bar")).forEach(function (b) { b.remove(); });
    var nodes = Array.prototype.slice.call(list.children).filter(function (n) { return n.classList.contains("page-item"); });
    list.insertBefore(insertBar(list, kind), list.firstChild);
    nodes.forEach(function (n) { list.insertBefore(insertBar(list, kind), n.nextSibling); });
  }

  // Прокрутка к странице с поправкой на закреплённую шапку. Обычный scrollIntoView ставит
  // карточку вплотную к верху окна, а шапка её закрывает, и первой видимой оказывается уже
  // следующая страница: нажимаешь «2», а на экране «3». Высота шапки считается на месте,
  // потому что при узком окне вкладки переносятся на вторую строку.
  function scrollToCard(card) {
    if (!card) return;
    // Сверху липнут два слоя: общая полоса и шапка документа с закладками и кнопками. Считался
    // только первый, и по нажатию в оглавлении нужная страница уезжала под шапку: первой видимой
    // оказывалась следующая.
    var bar = document.querySelector(".topbar");
    var шапкаДок = document.getElementById("docHeadSticky");
    var видимаШапка = шапкаДок && !шапкаДок.classList.contains("hidden") && шапкаДок.offsetParent !== null;
    var offset = (bar ? bar.offsetHeight : 0) + (видимаШапка ? шапкаДок.offsetHeight : 0) + 12;
    var top = card.getBoundingClientRect().top + window.pageYOffset - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  // Полоса вставки между элементами страницы. Нужна потому, что дотащить новый пункт из конца
  // длинной страницы на нужное место мышью тяжело: проще поставить его сразу туда, где он нужен.
  // Полоса видна всегда, а не только при наведении: иначе о ней просто не догадаться.
  function insertBar(list, pageKind) {
    var bar = el("div", "insert-bar");
    var chip = el("button", "insert-chip"); chip.type = "button";
    chip.appendChild(icon("plus"));
    chip.appendChild(el("span", null, "вставить сюда"));
    bar.appendChild(chip);

    // Новый элемент встаёт сразу ЗА нажатой полосой, и своя полоса появляется уже за ним. Раньше
    // он вставлялся ПЕРЕД полосой: нажатая полоса уезжала за новый элемент, между ним и прежним
    // соседом не оставалось ничего, а в конце списка две полосы вставали подряд. С каждым
    // добавлением разъезд накапливался, и полоса переставала показывать место, куда попадёт
    // элемент, то есть переставала делать то единственное, ради чего она есть.
    function place(node) {
      // Полосу могли вынуть из списка, пока его пересобирали. Тогда элемент идёт в конец: это
      // честнее, чем отказ вставки с ошибкой прямо в руках у оператора.
      list.insertBefore(node, bar.parentNode === list ? bar.nextSibling : null);
      list.insertBefore(insertBar(list, pageKind), node.nextSibling);
      collapse();
      обновитьПризнакPdf(list.closest('[data-role="pagecard"]'));
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
    // Имя ищется без учёта регистра, как везде: иначе прожектор уверенно врёт про условие,
    // написанное в другом написании.
    if (v == null) {
      var своё = Object.keys(прожектор.значения).filter(function (k) { return тоЖеИмя(k, имя); })[0];
      if (своё != null) v = прожектор.значения[своё];
    }
    return v == null ? "" : String(v);
  }

  // Выполняется ли условие при заданных значениях. Считает тем же кодом, что и планшет: своя
  // копия однажды разошлась бы с ним, и прожектор врал бы уверенно.
  function прожекторДержит(cond) {
    if (!cond) return true;
    return condGroups(cond).some(function (g) {
      return condParts(g).every(function (part) {
        // Часовые условия прожектор не считает и объявляет выполненными. Пометку «не» к такой
        // части применять нельзя: «не в этот день недели» превращалось в «не выполнено» и блок
        // гас всегда, вопреки написанному рядом пояснению.
        if (isClockOp(part.op)) return true;
        var ok = прожекторЧасть(part);
        return part.not ? !ok : ok;
      });
    });
  }

  // Почему этот блок не показывается при заданных значениях. Погасить его мало: оператор
  // видит бледный прямоугольник и не понимает, чего не хватает, а условие может быть длинным
  // и стоять свёрнутым. Называем первое несошедшееся сравнение и то, что стоит там сейчас.
  function прожекторПочему(cond) {
    if (!cond) return "";
    var наборы = condGroups(cond);
    for (var i = 0; i < наборы.length; i++) {
      var части = condParts(наборы[i]);
      for (var j = 0; j < части.length; j++) {
        var c = части[j];
        if (isClockOp(c.op)) continue;   // такие части прожектор считает выполненными, см. выше
        var ok = прожекторЧасть(c);
        if (c.not ? !ok : ok) continue;
        var имя = String(c.field || "").trim();
        var как = c.not ? (COND_OPS_NOT[c.op] || ("не " + c.op)) : ((COND_OPS.filter(function (o) { return o[0] === c.op; })[0] || [])[1] || c.op);
        var надо = String(c.value || "").trim();
        var сейчас = имя ? String(прожекторЗначение(имя) || "").trim() : "";
        var хвост = имя
          ? (сейчас.length ? ", а сейчас «" + сейчас + "»" : ", а сейчас пусто")
          : "";
        var текст = "«" + (имя || "условие") + "» должно быть «" + как + (надо.length ? " " + надо : "") + "»" + хвост;
        return наборы.length > 1 ? (текст + " (и другие наборы условий тоже не сошлись)") : текст;
      }
    }
    return "условие не выполнено при этих значениях";
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
        // Пустой край это «без предела», как у промежутка дат и как считают планшет и служба.
        var гр = target.split("..");
        var a = parseFloat(String(гр[0]).replace(",", ".")), b = parseFloat(String(гр[1] || "").replace(",", "."));
        if (!isFinite(a) && !isFinite(b)) return false;
        if (isFinite(a) && n < a) return false;
        if (isFinite(b) && n > b) return false;
        return true;
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
      // Как на планшете и на сервере: «не равно» не выполняется, когда значения нет вовсе.
      case "ne": return val.length > 0 && val !== target;
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
      if (!видна) {
        var почемуСтр = прожекторПочему(page.visibleWhen);
        card.setAttribute("data-spot-why", почемуСтр);
        card.title = "При заданных значениях эту страницу клиент не увидит: " + почемуСтр;
      } else { card.removeAttribute("data-spot-why"); card.removeAttribute("title"); }
      // Элементы страницы гаснут по отдельности: страница может быть видна, а половина её
      // содержимого нет.
      var узлы = card.querySelectorAll('[data-role="itemlist"] > .page-item');
      var виднохоть = false;
      pageOrder(page, page.blocks).forEach(function (it, i) {
        var node = узлы[i];
        if (!node) return;
        var ok = видна && прожекторДержит(it.item.visibleWhen);
        node.classList.toggle("spot-off", !ok);
        // Почему погас: коротко на самой пометке, целиком в подсказке при наведении.
        if (!ok) {
          var почему = видна ? прожекторПочему(it.item.visibleWhen) : "страница целиком не показывается";
          node.setAttribute("data-spot-why", почему);
          node.title = "При заданных значениях этот блок клиент не увидит: " + почему;
        } else { node.removeAttribute("data-spot-why"); node.removeAttribute("title"); }
        if (ok) виднохоть = true;
      });
      // Страница, от которой при этих значениях не осталось ничего, помечается отдельно: клиент
      // увидит пустой экран, и это почти всегда недосмотр.
      if (видна && узлы.length && !виднохоть) card.classList.add("spot-empty");
    });
  }

  /// Имена, для которых панель проверки условий спрашивает значения: теги документа плюс имена
  /// чекбоксов и групп, потому что условие может смотреть и на них. Документ перечитывается с
  /// экрана: тег, дописанный только что, живёт пока в разметке, а не в state.doc.
  function именаПрожектора() {
    collectDoc();
    var имена = previewFields();
    var dk = docKeys();
    dk.checks.forEach(function (k) { if (имена.indexOf(k) < 0) имена.push(k); });
    Object.keys(dk.groups).forEach(function (k) { if (имена.indexOf(k) < 0) имена.push(k); });
    return { имена: имена, ключи: dk };
  }

  /// Пересобрать список полей панели, если состав имён изменился. Раньше он не пересобирался
  /// никогда: тег, дописанный при включённой панели, в ней не появлялся, а на другом документе
  /// панель показывала теги прошлого вместе с его значениями. Пересборка пропускается, пока
  /// оператор набирает прямо в панели: поле под курсором исчезло бы вместе с набранным.
  function обновитьПоляПрожектора() {
    if (!прожектор.вкл) return;
    var box = document.querySelector("#spotlightHost .spotlight");
    if (!box || !box.__refresh) return;
    var где = document.activeElement;
    if (где && box.contains(где)) return;
    var было = Array.prototype.slice.call(box.querySelectorAll(".spotlight-fields label.field-sm"))
      .map(function (l) { return l.childNodes[0].nodeValue; }).join("\n");
    if (именаПрожектора().имена.join("\n") === было) return;
    box.__refresh();
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
    шапка.appendChild(помощь(
      "Проверка условий, не выходя из редактора. Задайте значения тегов так, как их пришлёт "
      + "внешняя система, и включите переключатель: всё, чего клиент при этих значениях не "
      + "увидит, погаснет прямо здесь, а на пометке будет написано, какого значения не хватило. "
      + "Ничего никуда не отправляется. Эти же значения подставятся в предпросмотр."));
    шапка.appendChild(сброс);
    box.appendChild(шапка);

    var поля = el("div", "spotlight-fields");
    box.appendChild(поля);
    var примечание = el("div", "spotlight-note sig-meta");
    box.appendChild(примечание);

    function нарисоватьПоля() {
      поля.innerHTML = "";
      var состав = именаПрожектора();
      var имена = состав.имена, dk = состав.ключи;
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
    // Список страниц пересобирается целиком: узел, на котором стояла панель оформления, сейчас
    // будет выброшен. Не сбросить ссылку значит оставить панель рабочей на вид: нажатие «•»
    // меняло оторванный от страницы узел, документ помечался изменённым, а на экране не менялось
    // ничего.
    rtTarget = null;
    syncRtBar();
    // Панель прожектора живёт над списком страниц и переживает перерисовку: она не часть
    // документа, и пересобирать её на каждую правку значило бы терять заданные значения.
    var host = $("spotlightHost");
    if (host && !host.firstChild) host.appendChild(прожекторПанель());

    var wrap = $("pagesEditor");
    // Поле «текст над полем подписи» живёт в карточке страницы подписи, а карточка собирается
    // заново на каждую перерисовку. Возвращаем поле на его постоянное место до очистки: иначе
    // оно исчезло бы вместе с карточкой, и всё, что читает его по номеру, упало бы на null.
    var паркПодписи = $("docExtra"), полеПодписи = $("signPromptField");
    if (паркПодписи && полеПодписи && полеПодписи.parentNode !== паркПодписи) паркПодписи.appendChild(полеПодписи);
    wrap.innerHTML = "";
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

      // Флаги страницы стоят в её шапке. Раньше они лежали под содержимым, ниже всех блоков, и
      // на длинной странице оператор до них просто не доскроливал.
      var флаги = el("span", "page-flags");
      title.appendChild(флаги);

      var delPage = iconBtn("trash", "Удалить", "btn-danger btn-sm");
      delPage.title = "Удалить страницу";
      delPage.addEventListener("click", function () {
        if (!confirm("Удалить страницу " + (pi + 1) + " целиком?")) return;
        collectDoc(); state.doc.pages.splice(pi, 1);
        // Свёрнутые страницы помнятся по номеру, а номера после удаления сдвигаются: без сдвига
        // свёрнутой оказывалась соседняя страница, а не та, которую сворачивали.
        var сдвинутые = {};
        Object.keys(collapsedPages).forEach(function (k) {
          var n = parseInt(k, 10);
          if (isNaN(n) || n === pi) return;
          сдвинутые[n > pi ? n - 1 : n] = collapsedPages[k];
        });
        collapsedPages = сдвинутые;
        renderPages(); updatePlaceholders();
      });
      // Кнопка удаления стоит в том же ряду, что пометки: так у всего ряда одна высота и один
      // отступ, а не у каждого свой. Раньше она висела отдельно, и ряд выглядел прыгающим.
      флаги.appendChild(delPage); card.appendChild(title);

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

      body.appendChild(sectionLabelHelp("filter", "Условие показа страницы",
        "Без условия страницу видят все. С условием она целиком пропадает у тех, кому не подходит, "
        + "и в счёте шагов её не будет: клиент даже не узнает, что она есть. Условие сравнивает "
        + "значение тега из заказа или отметку, которую клиент поставил раньше."));
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
      // Вид страницы запоминается на списке: полосы вставки пересобираются и при удалении, и
      // при перетаскивании, а вида страницы там взять больше неоткуда.
      items.setAttribute("data-pagekind", kind || "");
      items.appendChild(insertBar(items, kind));
      built.forEach(function (node) { items.appendChild(node); items.appendChild(insertBar(items, kind)); });
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
      var вPdf = el("label", "check-inline pdf-flag head-flag");
      var вPdfCb = el("input"); вPdfCb.type = "checkbox";
      вPdfCb.setAttribute("data-role", "pageinpdf");
      // Решение оператора хранится отдельно от того, что показано: взаимодействие поднимает
      // галочку насильно, и когда взаимодействие уберут со страницы, вернуть надо именно его
      // выбор, а не то, что галочку когда-то подняло.
      вPdfCb.setAttribute("data-own", page.inPdf !== false ? "1" : "0");
      вPdfCb.addEventListener("change", function () {
        if (!вPdfCb.disabled) вPdfCb.setAttribute("data-own", вPdfCb.checked ? "1" : "0");
      });
      вPdf.appendChild(вPdfCb);
      вPdf.appendChild(document.createTextNode(" в PDF"));
      вPdf.appendChild(помощь(ПОДСКАЗКА_PDF_СВОБОДЕН));
      флаги.appendChild(вPdf);
      // Состояние галочки и её подсказку ставит тот же счёт, что работает при вставке, удалении
      // и перетаскивании: два разных счёта одного и того же однажды разошлись бы.
      обновитьПризнакPdf(card);

      // Крупный текст для тех, кто плохо видит. Признак живёт у страницы, но показывается он
      // только у первой: клиент включает крупный текст один раз в начале, и выбор держится до
      // конца работы с этим документом. Ставить такую галочку на каждой странице значило бы
      // обещать оператору то, чего планшет не делает.
      //
      // До этой правки признак был только в хранилище и на планшете, а в редакторе его не было
      // вовсе: включить было негде, а сохранение из редактора его снимало, потому что сборка
      // страницы это поле не читала. Оператор ставил признак, сохранял, и значок пропадал.
      if (pi === 0) {
        var крупно = el("label", "check-inline dyn-anchor head-flag");
        var крупноCb = el("input"); крупноCb.type = "checkbox";
        крупноCb.checked = !!page.bigText;
        крупноCb.setAttribute("data-role", "bigtext");
        крупно.title = "Клиент сможет сам увеличить буквы на планшете значком «Ааа» в правом верхнем углу.";
        крупно.appendChild(крупноCb);
        крупно.appendChild(document.createTextNode(" крупный текст «Ааа»"));
        крупно.appendChild(помощь(
          "Для клиентов, которые плохо видят. На планшете в правом верхнем углу появится значок "
          + "«Ааа»: нажимая его, клиент увеличивает буквы ступенями до двукратного размера. "
          + "Значок показывается только на первой странице, а выбранный размер держится до конца "
          + "работы с документом. На бумагу это не влияет: в PDF текст печатается обычным."));
        флаги.appendChild(крупно);
      }

      if (!kind) {
        var dyn = el("label", "check-inline dyn-anchor head-flag");
        var dynCb = el("input"); dynCb.type = "checkbox"; dynCb.checked = !!page.includeDynamic; dynCb.setAttribute("data-role", "includedynamic");
        dyn.title = "Чекбоксы, присланные внешней системой, встанут именно на этой странице.";
        dyn.appendChild(dynCb); dyn.appendChild(document.createTextNode(" чекбоксы из API"));
        dyn.appendChild(помощь(
          "Внешняя система может прислать в заказе свои пункты для отметки. Здесь вы говорите, "
          + "на какой именно странице они встанут. Без этой отметки присланные пункты не покажутся."));
        флаги.appendChild(dyn);

        var всё = el("label", "check-inline dyn-anchor head-flag");
        var всёCb = el("input"); всёCb.type = "checkbox"; всёCb.checked = !!page.showCheckAll;
        всёCb.setAttribute("data-role", "checkall");
        всё.title = "Показать клиенту кнопку «Отметить всё» над пунктами этой страницы: одним "
          + "нажатием он отметит их все. Имеет смысл, когда пунктов от трёх.";
        всё.appendChild(всёCb);
        всё.appendChild(document.createTextNode(" кнопка «Отметить всё»"));
        всё.appendChild(помощь(
          "Кнопка над пунктами страницы, которая отмечает их разом. Имеет смысл от трёх пунктов: "
          + "на двух она только мешает."));
        флаги.appendChild(всё);

        body.appendChild(rulesPanel(card, page));
      }

      applyCollapsed();
      wrap.appendChild(card);
    });
    makeSortable(wrap, ".page-card");
    renderToc();

    // Signature page: custom content (text / image) on either side of the signature field.
    var signCard = el("div", "page-card sign-page-card");
    var st = el("div", "page-title");
    st.appendChild(icon("pen", "page-icon"));
    st.appendChild(el("span", "page-name", "Страница подписи"));
    st.appendChild(el("span", "page-summary", "клиент видит её последней, перед экраном «Спасибо»"));
    signCard.appendChild(st);
    signCard.appendChild(el("p", "sig-meta", "Здесь можно разместить текст или картинку (реквизиты, печать, пояснение) над полем подписи и под ним. То же самое попадёт в PDF."));

    // Текст над полем подписи относится к этой странице, значит и стоять должен на ней. Поле
    // живёт в статической разметке, поэтому переносим сам узел: так все чтения и записи по его
    // номеру продолжают работать, как работали.
    var подсказкаПодписи = $("signPromptField");
    if (подсказкаПодписи) {
      var хозяин = $("docExtra");
      if (хозяин) хозяин.classList.add("hidden");
      signCard.appendChild(подсказкаПодписи);
    }

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

    // Подсветка прожектора накладывается в самом конце, когда страница подписи и экран
    // «Спасибо» уже стоят в разметке. Раньше это делалось сразу после списка страниц, а
    // прожектор внутри себя перечитывает документ с экрана: списков блоков подписи и прощания
    // в разметке ещё не было, и они вычитывались пустыми, то есть стирались из документа.
    // Здесь же пересобирается и состав полей панели: сюда приходит и открытие другого
    // документа, а его теги не имеют ничего общего с тегами прошлого.
    if (прожектор.вкл) { обновитьПоляПрожектора(); прожекторПрименить(); }
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
    // Правила связывают пункты между собой, поэтому и показывать их есть смысл только там, где
    // пункты есть. Пустая панель с надписью «правил нет» висела под каждой страницей, включая
    // те, где ни одного пункта нет вовсе, и объясняла ровно ничего.
    var коробка = el("details", "rules-box");
    var шапка = el("summary", "rules-head");
    шапка.appendChild(el("span", "rules-name", "Правила отметок"));
    шапка.appendChild(помощь(
      "Правило связывает пункты этой страницы между собой. «Взаимоисключающие»: отметка одного "
      + "снимает остальные, как в списке «да / нет». «Не меньше N»: клиент не пройдёт дальше, "
      + "пока не отметит нужное число пунктов из выбранных. Без правил пункты независимы."));
    var итог = el("span", "rules-sum", "");
    шапка.appendChild(итог);
    коробка.appendChild(шапка);
    var box = el("div", "rules-panel");
    коробка.appendChild(box);
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

    var рисуем = false, раскрывали = false;
    function нарисовать() {
      if (рисуем) return;
      рисуем = true;
      try { нарисоватьТело(); } finally { рисуем = false; }
    }
    function нарисоватьТело() {
      список.innerHTML = "";
      var list = правила();
      // Панель прячется целиком, когда связывать нечего и нечего показывать: ни правил, ни хотя
      // бы двух названных пунктов на странице.
      var пунктов = имена().length;
      var показывать = list.length > 0 || пунктов >= 2;
      коробка.classList.toggle("hidden", !показывать);
      коробка.classList.toggle("on", list.length > 0);
      итог.textContent = list.length
        ? (list.length === 1 ? "одно правило" : list.length + " правила")
        : "нет, пункты не связаны";
      // Раскрываем один раз, при первой отрисовке: панель перерисовывается на любое изменение
      // разметки внутри карточки страницы, и раньше свёрнутая панель раскрывалась обратно от
      // нажатия на любой значок «?» или от сворачивания соседнего блока.
      if (list.length && !раскрывали) { коробка.open = true; раскрывали = true; }
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
        // Верхняя граница поля идёт за числом выбранных пунктов: набрать заведомо непосильное
        // число нельзя даже случайно.
        var поправитьПредел = function () {
          var сколько = поля.querySelectorAll("input:checked").length;
          n.max = String(Math.max(1, сколько));
          if (parseInt(n.value, 10) > сколько && сколько >= 1) n.value = String(сколько);
        };
        поля.addEventListener("change", поправитьПредел);
        поправитьПредел();
      }
      var ok = iconBtn("check", "Добавить правило", "btn-primary");
      ok.addEventListener("click", function () {
        var keys = Array.prototype.slice.call(поля.querySelectorAll("input:checked")).map(function (i) { return i.value; });
        if (keys.length < 2) { toast("Выберите хотя бы два пункта", true); return; }
        // Число «сколько отметить» не может быть больше, чем выбрано пунктов: служба его всё
        // равно уменьшит, а на экране осталось бы прежнее, и оператор ушёл бы уверенный, что
        // правило работает по его числу. Замер: правило по двум пунктам с N=4 сохранялось как
        // N=2, а строка правила так и говорила «не меньше 4» до перезагрузки страницы.
        if (вид === "minchecked" && n) {
          var надо = parseInt(n.value, 10);
          if (!(надо >= 1)) { toast("Сколько отметить: нужно число от 1", true); return; }
          if (надо > keys.length) {
            toast("Отметить нельзя больше, чем выбрано пунктов: вы выбрали " + keys.length, true);
            return;
          }
        }
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

    // Список пунктов на странице меняется по ходу правки, а от него зависит, есть ли смысл
    // показывать панель: пересчитываем на каждое изменение внутри карточки.
    card.addEventListener("input", function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute("data-role") === "cbkey") нарисовать();
    });
    // Имя пункта проставляется и кодом, по тексту подписи, и пункты добавляются кнопкой без
    // полной перерисовки страницы. События input в этих случаях нет, поэтому следим за самой
    // разметкой: панель должна появиться, как только на странице стало два названных пункта.
    if (window.MutationObserver) {
      // Сторож обязан молчать, пока рисуем сами: перерисовка меняет разметку внутри той же
      // карточки, и без этого он будил бы сам себя без конца, намертво вешая вкладку.
      var сторож = new MutationObserver(function () {
        if (рисуем) return;
        сторож.disconnect();
        нарисовать();
        сторож.observe(card, { childList: true, subtree: true });
      });
      сторож.observe(card, { childList: true, subtree: true });
    }
    нарисовать();
    return коробка;
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
    var reqLabel = el("label"); var req = el("input"); req.type = "checkbox"; req.checked = !!g.required; req.setAttribute("data-role", "greq");
    reqLabel.appendChild(req); reqLabel.appendChild(document.createTextNode(" обязательно выбрать")); head.appendChild(reqLabel);
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { removeItem(card); }); head.appendChild(del);
    setTimeout(function () {
      addItemCollapse(card, function () {
        // Заголовок группы это редактор оформленного текста: у него textContent, а не value.
        var поле = card.querySelector('[data-role="gtitle"]');
        var t = поле ? (поле.textContent || "").trim() : "";
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
    document.querySelectorAll('#pagesEditor [data-role="pagecard"]').forEach(function (card, номерКарточки) {
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
      // Признак крупного текста читается только у первой страницы, потому что и рисуется он
      // только у неё. У остальных он остаётся таким, каким пришёл с сервера: документ мог
      // приехать ввозом или из внешней системы с признаком не на первой странице, и стирать его
      // молча нельзя, служба сама переносит его на первую уцелевшую страницу.
      var крупныйТекст = номерКарточки === 0
        ? !!(card.querySelector('[data-role="bigtext"]') || {}).checked
        : !!((state.doc.pages || [])[номерКарточки] || {}).bigText;
      var page = { heading: "", body: "", kind: pageKind || null, headingRuns: headingRuns, headingAlign: headingAlign, blocks: blocks, checkboxes: checkboxes,
        groups: groups, signatures: signatures, scans: scans, inputs: inputs, inPdf: pageInPdf, includeDynamic: includeDynamic,
        bigText: крупныйТекст,
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
  /// Ключ черновика. Обычно берётся открытый документ, но при уходе на другой документ нужен
  /// именно тот, с которого уходят: некоторые пути (создание, копия, ввоз) успевают переставить
  /// state.docId на новый ещё до загрузки, и черновик ушёл бы под чужой ключ.
  function draftKey(ид) {
    var d = ид || state.docId;
    return d ? DRAFT_PREFIX + ":" + d : DRAFT_PREFIX;
  }
  var dirty = false;
  var draftTimer = null;

  // ---------------- Шаг назад ----------------
  // Правку в редакторе нельзя отменить браузером: страница пересобирается кодом, и родная
  // отмена о ней не знает. Держим свою историю снимков документа. Набор букв подряд это один
  // шаг, а не сорок: снимок делается, когда правка на мгновение остановилась.
  var история = [], историяЖдёт = null, историяТихо = false;
  var ИСТОРИЯ_ГЛУБИНА = 50;

  function снимокДокумента() {
    try { collectDoc(); return JSON.stringify(state.doc); } catch (e) { return null; }
  }
  function запомнитьШаг() {
    if (историяТихо) return;
    var снимок = снимокДокумента();
    if (снимок == null) return;
    if (история.length && история[история.length - 1] === снимок) return;
    история.push(снимок);
    if (история.length > ИСТОРИЯ_ГЛУБИНА) история.shift();
    syncUndo();
  }
  // Снимок «до правки»: первый шаг истории это состояние, в которое возвращаться.
  function историяНачать() {
    история = [];
    var снимок = снимокДокумента();
    if (снимок != null) история.push(снимок);
    syncUndo();
  }
  function syncUndo() {
    var b = $("undoDoc");
    if (!b) return;
    b.disabled = история.length < 2;
    b.title = b.disabled
      ? "Отменять пока нечего: с открытия документа правок не было"
      : "Вернуть документ на шаг назад (Ctrl+Z). Шагов в запасе: " + (история.length - 1);
  }
  function шагНазад() {
    // Снимок текущего состояния мог ещё не попасть в запас: он берётся с задержкой, чтобы набор
    // букв подряд не давал снимка на каждую букву. Берём его прямо сейчас, иначе шаг назад
    // отменял и последнюю правку, и предыдущую разом.
    if (историяЖдёт) { clearTimeout(историяЖдёт); историяЖдёт = null; запомнитьШаг(); }
    if (история.length < 2) { toast("Отменять нечего"); return; }
    история.pop();                       // текущее состояние
    var прошлое = история[история.length - 1];
    try { state.doc = JSON.parse(прошлое); } catch (e) { toast("Не удалось вернуть шаг", true); return; }
    историяТихо = true;
    try { renderDoc(); renderLibrary(); } finally { историяТихо = false; }
    dirty = true; syncDirty();
    clearTimeout(draftTimer); draftTimer = setTimeout(function () { saveDraft(); }, 1200);
    if (прожектор.вкл) прожекторПрименить();
    syncUndo();
    toast("Шаг назад");
  }

  function markDirty() {
    if (!dirty) { dirty = true; syncDirty(); }
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () { saveDraft(); }, 1200);
    // Снимок для отмены: с той же задержкой, что и черновик. Набор букв подряд остаётся одним
    // шагом, а не превращается в сорок.
    if (!историяТихо) {
      clearTimeout(историяЖдёт);
      историяЖдёт = setTimeout(function () { историяЖдёт = null; запомнитьШаг(); }, 700);
    }
    // Прожектор показывает итог условий: правка условия должна сразу менять то, что погашено.
    // С задержкой, потому что правка идёт по букве, а пересчёт трогает весь список страниц.
    if (прожектор.вкл) {
      clearTimeout(прожекторТаймер);
      прожекторТаймер = setTimeout(function () {
        // Сначала состав полей, потом подсветка: тег, дописанный только что, обязан появиться
        // в панели, иначе оператор задаёт значения не для всего документа, сам того не зная.
        обновитьПоляПрожектора();
        прожекторПрименить();
      }, 400);
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
    // Точка про несохранённое и имя на своей закладке. Перерисовывается одна закладка, а не
    // весь ряд: дёргать закладки под курсором оператора на каждое нажатие клавиши незачем.
    // Рисует их та же функция, что и полная перерисовка, из той же записи документа.
    отразитьЗаголовокВСписке();
    освежитьСвоюЗакладку();
  }

  function saveDraft(ид) {
    try {
      collectDoc();
      localStorage.setItem(draftKey(ид), JSON.stringify({ at: Date.now(), doc: state.doc }));
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
      // Имя и вид документа в списке пересчитывает сервер при сохранении, по тому же правилу:
      // имя документа это его заголовок. Список перечитывается, а не подправляется здесь по
      // догадке: догадка и была вторым источником, из-за которого закладка переименовывалась
      // при переходе на неё. Не вышло перечитать - рисуем тем, что есть, и молчим: сохранение
      // состоялось, и говорить о нём «не удалось» нельзя.
      return loadLibrary().catch(function () { renderLibrary(); })
        // Сервер рассказывает, что он выбросил при разборе: вложенные условия, части сверх
        // предела. Это меняет смысл документа, и раньше об этом не говорилось вовсе.
        .then(function () { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          // Одно сообщение целиком: предупреждения приклеены к «сохранён», иначе следующее
          // сообщение затёрло бы их раньше, чем оператор успел прочитать.
          var итог = "Документ сохранён";
          if (пустых) итог += ". Условий без выбранного тега: " + пустых + ", они не сохранены, блок будет показан всем";
          if (выброшеноПустых) итог += ". Пустых заготовок не сохранено: " + выброшеноПустых;
          var срезано = (j && j.warnings) || [];
          if (срезано.length) итог += ". Не сохранено: " + срезано.join("; ");
          toast(итог, срезано.length > 0);
          return r;
        });
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
      loadDoc(state.docId, true).then(function () { toast("Загружена свежая версия. Ваши правки можно вернуть из черновика."); });
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
        if (e.target.closest && e.target.closest(".preview-setup, .preview-wrap, .doc-tabs, .spotlight")) return;
        markDirty();
      });
    });
    panel.addEventListener("click", function (e) {
      // Добавление, удаление и перетаскивание тоже меняют документ, а событий ввода не дают.
      if (e.target.closest && e.target.closest(".doc-tabs, .spotlight")) return;
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
      // Запас шагов назад начинается с того, что оператор теперь видит. Без этого первый же
      // «шаг назад» возвращал не к предыдущей правке, а к серверной версии, то есть выбрасывал
      // восстановленный черновик целиком: одно нажатие, и работа снова потеряна.
      историяНачать();
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
      // И поля ввода: тег, использованный только в условии показа поля, иначе не предлагался в
      // предпросмотре, и проверить, появится ли поле, было нечем.
      (p.inputs || []).forEach(function (x) { addCond(x.visibleWhen); });
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
    // Надпись собирается по факту подстановки, а не по факту непустого значения в панели:
    // раньше она перечисляла и те теги, чьё значение предпросмотр подменил на своё, и уверенно
    // выдавала подменённое за набранное оператором.
    var откуда = el("p", "sig-meta pv-from-spot");
    c.appendChild(откуда);
    c.appendChild(el("p", "sig-meta", "Укажите тестовые значения тегов. Документ будет показан так, как его увидит клиент на планшете, включая условия показа блоков и страниц. На планшеты ничего не отправляется."));

    var inputs = {};
    var изПанели = [];
    if (!placeholders.length) c.appendChild(el("p", "sig-meta", "В шаблоне нет тегов - будет показан документ как есть."));
    placeholders.forEach(function (k) {
      // Сперва то, что оператор задал в проверке условий, и только потом вымышленный пример:
      // эти значения он уже набрал, и набирать их второй раз ради того же документа незачем.
      var своё = подобратьЗначение(k, прожектор.значения[k]);
      if (своё) изПанели.push(k);
      // A tag with a fixed set of values gets a dropdown here too, so a preview cannot be run
      // against a value the real system would never send.
      var known = fieldValues(k);
      if (known) {
        var wrap = el("label", "field", k);
        var sel = el("select");
        known.forEach(function (v) { sel.appendChild(new Option(valueLabel(k, v), v)); });
        // Не подошло ни набранное, ни пример: список остаётся на своём первом значении, но в
        // надписи такой тег не назван, потому что оператор его не задавал.
        var хочу = своё || подобратьЗначение(k, previewDefault(k));
        if (хочу) sel.value = хочу;
        wrap.appendChild(sel);
        c.appendChild(wrap); inputs[k] = sel;
      } else {
        var f = labeledInput(k, своё || previewDefault(k));
        c.appendChild(f.wrap); inputs[k] = f.input;
      }
    });
    if (изПанели.length)
      откуда.textContent = "Значения взяты из проверки условий над редактором: "
        + изПанели.join(", ") + ". Их можно поправить здесь.";
    else откуда.remove();

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
      // Код места берётся настоящий, из этой установки. Выдуманный «WS-204» тут стоял до сих
      // пор, и это ровно та жалоба, что была на всю вкладку: человек копирует показанное тело,
      // отправляет и получает «рабочего места с таким кодом нет». Мест ещё не завели, значит так
      // и написано вместо кода, а не подставлена красивая выдумка.
      var первоеМесто = (state.workstations || []).filter(function (w) { return w.externalId; })[0];
      var тело = {
        workstationExternalId: первоеМесто ? первоеМесто.externalId
                                           : "СНАЧАЛА ЗАВЕДИТЕ РАБОЧЕЕ МЕСТО НА ВКЛАДКЕ «МЕСТА»",
        fields: d.fields
      };
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

  /// Набранное оператором значение тега, приведённое к тому, что этот тег принимает. У тега со
  /// своим набором значений сравнение идёт сначала по самому значению, потом по его подписи, и
  /// в обоих случаях без учёта регистра. Не подошло ничего это пусто, а НЕ первое значение из
  /// набора: молчаливая подмена «Ж» на «M» меняет смысл на противоположный, и документ уходит
  /// живому человеку с чужим полом. Пустое поле оператор увидит и поправит, подменённое нет.
  function подобратьЗначение(имя, значение) {
    var v = значение == null ? "" : String(значение).trim();
    if (!v.length) return "";
    var known = fieldValues(имя);
    if (!known) return v;
    var lv = v.toLowerCase();
    for (var i = 0; i < known.length; i++) if (String(known[i]).toLowerCase() === lv) return known[i];
    for (var j = 0; j < known.length; j++)
      if (String(valueLabel(имя, known[j]) || "").trim().toLowerCase() === lv) return known[j];
    return "";
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
      apiSend("/show-document", "POST", { target: sel.value, fields: d.fields, checkboxes: d.checkboxes,
        groups: d.groups, documentCode: кодОткрытогоДокумента() })
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
        if (r.mark && /^#[0-9a-fA-F]{6}$/.test(r.mark)) {
          span.style.backgroundColor = r.mark;
          span.style.padding = "0 2px";
          span.style.borderRadius = "3px";
        }
        // Свой размер в точках сильнее ступени: оператор задал его руками, значит хотел именно его.
        var pt = parseInt(r.sizePt, 10);
        if (pt >= 8 && pt <= 40) { span.className = ""; span.style.fontSize = pt + "pt"; }
        parent.appendChild(span);
      });
    });
  }
  // Плашка, рамка, отступ и межстрочный интервал блока. Ровно то же самое делает планшет:
  // предпросмотр и наблюдение обязаны показывать документ так, как его увидит клиент, иначе
  // оператор проверяет одно, а человек видит другое.
  function previewBox(node, b) {
    if (!b) return;
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

  // Блок рисуется теми же правилами, что и на планшете: черта, таблица, список, картинка или
  // текст. Прежде здесь были только картинка и текст, поэтому нумерованный список показывался
  // сплошным абзацем, таблица не показывалась вовсе, черты не было, а плашка и рамка пропадали.
  function previewBlock(parent, b) {
    if (!b) return;
    if (b.kind === "divider") { parent.appendChild(el("div", "pv-divider")); return; }
    // Разрыв страницы это свойство бумаги: на планшете своих экранов, и рисовать нечего.
    if (b.kind === "pagebreak") return;

    if (b.table && b.table.rows && b.table.rows.length) {
      var wrapT = el("div", "pv-table-wrap");
      var t = el("table", "pv-table");
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
      previewBox(wrapT, b);
      wrapT.appendChild(t); parent.appendChild(wrapT); return;
    }

    if (b.list === "bullet" || b.list === "number") {
      var box = el(b.list === "number" ? "ol" : "ul", "pv-list");
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
        previewRuns(li, куски);
        box.appendChild(li);
      });
      if (!box.childNodes.length) return;
      previewBox(box, b);
      parent.appendChild(box); return;
    }

    // Картинка бывает своя, из хранилища, и присланная внешней системой прямо в заказе.
    if (b.imageUrl && (/^\/media\/[^/\\]+$/.test(b.imageUrl) || /^data:image\/(png|jpeg|bmp);base64,[A-Za-z0-9+/=]+$/.test(b.imageUrl))) {
      var fig = el("div", "pv-image");
      // Слово в слово как на планшете (kiosk.js, appendBlock): при пустом выравнивании ничего
      // не задаём и наследуем «по центру» из правил оформления. Раньше здесь принудительно
      // ставилось «слева», и картинка без выравнивания в предпросмотре стояла слева, а у клиента
      // по центру.
      var ia = (b.align || "").toLowerCase();
      if (ia === "right") fig.style.textAlign = "right";
      else if (ia === "center") fig.style.textAlign = "center";
      // «Слева» и «по обоим краям» для картинки это одно и то же: прижать к левому полю.
      // Раньше ветки для «слева» не было вовсе, и картинка, которой оператор явно задал левое
      // выравнивание, вставала по центру: экран не выполнял заданное.
      else if (ia === "left" || ia === "justify") fig.style.textAlign = "left";
      var wrap = (b.wrap || "").toLowerCase();
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
      return;
    }

    var t2 = el("div", "pv-text");
    var al = (b.align || "").toLowerCase();
    if (al === "center" || al === "right" || al === "justify") t2.style.textAlign = al;
    previewBox(t2, b);
    previewRuns(t2, b.runs || []);
    parent.appendChild(t2);
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
    var вписано = {};  // имя поля ввода -> набранное значение, как на планшете
    pages.forEach(function (p, pi) {
      (p.checkboxes || []).forEach(function (cb, ci) { if (cb && cb.checked) checks["p" + pi + "_c" + ci] = true; });
      (p.groups || []).forEach(function (g) { if (g && g.key) picks[g.key] = g.selected || ""; });
    });

    // Значение имени, на которое ссылается условие. Скрытый пункт считается неотмеченным:
    // так взаимные ссылки разрешаются сами и не зацикливаются. Точно как на планшете.
    function liveValue(key) {
      // Имя ищется без учёта регистра, как на планшете и на сервере: иначе предпросмотр
      // показывает оператору не то, что увидит клиент.
      var своё = Object.keys(picks).filter(function (k) { return тоЖеИмя(k, key); })[0];
      if (своё != null) return picks[своё] || "";
      своё = Object.keys(вписано).filter(function (k) { return тоЖеИмя(k, key); })[0];
      if (своё != null) return вписано[своё] || "";
      var found = "";
      pages.forEach(function (p, pi) {
        (p.checkboxes || []).forEach(function (cb, ci) {
          if (cb && тоЖеИмя(cb.key, key)) found = checks["p" + pi + "_c" + ci] ? "true" : "false";
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
        // Как на планшете: «не равно» не выполняется, когда значения нет вовсе.
        case "ne": return val.length > 0 && val !== target;
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
      (p.inputs || []).forEach(function (inp) {
        if (!inp || !holds(inp.visibleWhen)) return;
        var v = String(вписано[inp.key] == null ? (inp.value || "") : вписано[inp.key]).trim();
        if (inp.required && !v.length) { ok = false; return; }
        if (v.length && плохоеЗначение(inp.type, v)) ok = false;
      });
      return ok;
    }

    // Те же правила, что проверяет планшет: пустое поле не ошибка, а заполненное должно быть
    // похоже на то, что просили.
    function плохоеЗначение(вид, v) {
      var s = String(v || "").trim();
      if (!s.length) return false;
      if (вид === "number") return !/^-?\d+([.,]\d+)?$/.test(s);
      if (вид === "date") return !/^\d{2}[.\-/]\d{2}[.\-/]\d{4}$/.test(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s);
      if (вид === "phone") { var d = s.replace(/\D/g, "").length; return d < 5 || d > 15; }
      return false;
    }

    var c = el("div", "preview-wrap");
    var head = el("div", "pv-head");
    head.appendChild(el("h3", null, "Предпросмотр: так увидит клиент"));
    var stats = el("div", "sig-meta",
      "Страниц показано: " + data.pagesShown + " из " + data.pagesTotal +
      (data.missingPlaceholders && data.missingPlaceholders.length ? " · Не заполнены: " + data.missingPlaceholders.join(", ") : ""));
    head.appendChild(stats);
    head.appendChild(el("div", "pv-hint", "Пункты можно отмечать: условия показа пересчитываются так же, как на планшете."));
    // Что из присланного заказом не попало на экран и почему. Раньше предпросмотр показывал
    // присланные пункты всегда, даже когда ни одна страница не помечена приёмником, а планшет
    // их отбрасывал: оператор смотрел предпросмотр, видел пункты и считал, что настроил верно,
    // а клиент их не видел. Теперь предпросмотр отбрасывает так же и говорит, чего не хватает.
    if (data.dropped && data.dropped.length) {
      var потери = el("div", "pv-dropped");
      потери.appendChild(el("div", "pv-dropped-head", "Не попало на экран клиента:"));
      var сп = el("ul", "pv-dropped-list");
      data.dropped.forEach(function (т) { сп.appendChild(el("li", null, т)); });
      потери.appendChild(сп);
      head.appendChild(потери);
    }
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

    // Поле ввода в предпросмотре настоящее: в него можно печатать, и от набранного тут же
    // пересчитываются условия, как на планшете. Прежде ветки для полей не было вовсе, и поле
    // рисовалось кнопкой «Сканировать код», то есть оператор проверял не тот экран.
    function makeInput(inp) {
      var box = el("div", "pv-input");
      box.appendChild(el("div", "pv-inline-title", (inp.label || "Поле ввода") + (inp.required ? " *" : "")));
      var поле = el("input");
      поле.type = (inp.type === "number") ? "number" : (inp.type === "date") ? "date" : (inp.type === "phone") ? "tel" : "text";
      поле.className = "pv-input-field";
      поле.setAttribute("data-key", inp.key || "");
      if (inp.placeholder) поле.placeholder = inp.placeholder;
      if (вписано[inp.key] == null) вписано[inp.key] = inp.value || "";
      поле.value = вписано[inp.key];
      поле.addEventListener("input", function () {
        вписано[inp.key] = поле.value;
        // Перерисовываем только если от поля что-то зависит: иначе страница дёргалась бы на
        // каждой набранной букве. А раз перерисовали, возвращаем курсор туда, где он стоял:
        // draw() собирает поле заново, и без этого печатать было бы невозможно.
        if (!зависитОт(inp.key)) return;
        var поз = поле.selectionStart;
        draw();
        // Ищем перебором, а не селектором: имя поля задаёт человек, и в нём может оказаться
        // что угодно, включая кавычки, на которых селектор сломался бы.
        var снова = null;
        Array.prototype.slice.call(document.querySelectorAll(".pv-input-field")).some(function (n) {
          if (n.getAttribute("data-key") === (inp.key || "")) { снова = n; return true; }
          return false;
        });
        if (!снова) return;
        снова.focus();
        try { снова.setSelectionRange(поз, поз); } catch (e) { /* у number и date выделения нет */ }
      });
      box.appendChild(поле);
      return box;
    }

    // Есть ли в документе условие на это имя. Тот же вопрос решает планшет перед перерисовкой.
    function зависитОт(key) {
      var есть = false;
      function смотреть(cond) {
        if (!cond || есть) return;
        condGroups(cond).forEach(function (g) {
          condParts(g).forEach(function (c) {
            if (c && String(c.field || "").toLowerCase() === String(key || "").toLowerCase()) есть = true;
          });
        });
      }
      pages.forEach(function (p) {
        смотреть(p.visibleWhen);
        (p.blocks || []).forEach(function (b) { смотреть(b && b.visibleWhen); });
        (p.checkboxes || []).forEach(function (c) { смотреть(c && c.visibleWhen); });
        (p.groups || []).forEach(function (g) { смотреть(g && g.visibleWhen); });
        (p.inputs || []).forEach(function (i) { смотреть(i && i.visibleWhen); });
        (p.signatures || []).forEach(function (x) { смотреть(x && x.visibleWhen); });
        (p.scans || []).forEach(function (x) { смотреть(x && x.visibleWhen); });
      });
      return есть;
    }

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
          if (it.kind === 5) { body.appendChild(makeInput(it.item)); return; }
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
        // Блоки экрана подписи на планшете стоят по центру: поле подписи по центру, и текст
        // вокруг него тоже. Здесь они прижимались влево, и предпросмотр обещал не тот экран.
        var сверху = el("div", "pv-sign-custom"); body.appendChild(сверху);
        shown(doc.signBlocks).forEach(function (b) { previewBlock(сверху, b); });
        body.appendChild(el("div", "pv-prompt", doc.signPrompt || ""));
        body.appendChild(el("div", "pv-pad", "Распишитесь здесь"));
        var снизу = el("div", "pv-sign-custom"); body.appendChild(снизу);
        shown(doc.signBlocksBelow).forEach(function (b) { previewBlock(снизу, b); });
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
    // Обещание должно совпадать с делом: ввезённый документ сразу открывается в редакторе, и
    // прежний закрывается. Раньше здесь было написано «Открытый документ не изменится», а через
    // десять строк тот же обработчик его и менял.
    if (!confirm("Файл будет добавлен в библиотеку новым документом, и редактор откроет его. "
        + "Документ, открытый сейчас, не изменится, но закладка переключится на новый. Продолжить?")) {
      input.value = ""; return;
    }
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
    apiSend("/show-document", "POST", {
      target: state.docTarget, fields: fields,
      // Код открытого документа. Без него уходит документ по умолчанию, а оператор смотрит на
      // редактор с другим текстом и не понимает, что клиент видит не его.
      documentCode: кодОткрытогоДокумента()
    })
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
    // Окно открывается уже заполненным тем, что оператор набрал в проверке условий над
    // редактором. Раньше оно открывалось пустым, а взять оттуда значения предлагала кнопка,
    // которую надо было заметить: оператор набирал данные в панели, жал «Отправить на планшет»
    // и отправлял клиенту документ с пустыми тегами и без блоков, которые держатся на условиях.
    // Вымышленные примеры сюда по-прежнему не подставляются: подписать чужое имя хуже, чем
    // набрать своё. Само окно тоже остаётся: это последняя проверка перед отправкой живому
    // человеку.
    var inputs = {};
    var изПанели = [];
    placeholders.forEach(function (k) {
      var своё = подобратьЗначение(k, прожектор.значения[k]);
      if (своё) изПанели.push(k);
      var known = fieldValues(k);
      if (known) {
        var wrap = el("label", "field", k);
        var sel = el("select");
        sel.appendChild(new Option("не передавать", ""));
        known.forEach(function (v) { sel.appendChild(new Option(valueLabel(k, v), v)); });
        sel.value = своё;
        wrap.appendChild(sel); c.appendChild(wrap); inputs[k] = sel;
      } else {
        var f = labeledInput(k, своё); c.appendChild(f.wrap); inputs[k] = f.input;
      }
    });
    if (изПанели.length)
      c.appendChild(el("p", "sig-meta",
        "Подставлено из проверки условий над редактором: " + изПанели.join(", ")
        + ". Проверьте перед отправкой: это уйдёт живому человеку."));

    var естьИзПроверки = placeholders.some(function (k) {
      return !!подобратьЗначение(k, прожектор.значения[k]);
    });
    if (естьИзПроверки) {
      // Возврат после ручной правки: значения уже подставлены выше, а эта кнопка нужна тому,
      // кто поправил поле и передумал.
      var изПров = iconBtn("copy", "Вернуть значения из проверки условий", "btn-ghost");
      изПров.title = "Вернуть то, что вы задали в проверке условий над редактором. Проверьте перед отправкой: это уйдёт живому человеку.";
      изПров.addEventListener("click", function () {
        var взято = 0;
        placeholders.forEach(function (k) {
          var v = подобратьЗначение(k, прожектор.значения[k]);
          if (!v) return;
          inputs[k].value = v; взято++;
        });
        toast(взято ? ("Подставлено значений: " + взято + ". Проверьте перед отправкой.") : "Нечего подставлять", !взято);
      });
      c.appendChild(изПров);
    }

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

      // Размер экрана, каким его сообщила страница самого планшета. Оператор сегодня не знает,
      // какое железо стоит на рабочем месте, а при разборе жалобы «текст не помещается» это
      // первый вопрос. Планшет на старой странице размеров не присылает: тогда честный ответ
      // «неизвестно», а не нули, потому что ноль означал бы экран нулевой ширины.
      var экран = el("div", "dev-meta dev-screen");
      if (d.screenWidth && d.screenHeight) {
        var плотность = d.screenPixelRatio ? Math.round(d.screenPixelRatio * 100) / 100 : null;
        экран.textContent = "Экран: " + d.screenWidth + "\u00D7" + d.screenHeight + " точек разметки"
          + (плотность ? "   ·   плотность " + плотность
            + "   ·   " + Math.round(d.screenWidth * плотность) + "\u00D7" + Math.round(d.screenHeight * плотность) + " пикселей" : "");
        экран.title = "Размер, в котором планшет рисует страницу, как он сам его сообщил. "
          + "Точки разметки это то, чем меряются размеры шрифта и полей; пикселей на экране "
          + "во столько раз больше, какова плотность.";
      } else {
        экран.textContent = "Экран: неизвестно";
        экран.title = "Планшет не сообщал размер своего экрана. Так выглядит планшет, который "
          + "ещё ни разу не выходил на связь или работает на старой версии страницы.";
      }
      info.appendChild(экран);

      // Which build of the kiosk page the tablet is really running. A tablet whose WebView has not
      // reloaded since an older deploy keeps showing ads and answering nothing else, and this is
      // the only place that difference is visible.
      if (d.online) {
        if (!d.appVersion) {
          var oldPage = el("div", "dev-meta dev-health warn",
            "На планшете открыта старая версия страницы. Новые функции работать не будут: " +
            "обновите страницу на планшете (кнопка «Управление», затем «Обновить страницу»).");
          info.appendChild(oldPage);
        } else if (версияСтраницы && d.appVersion !== версияСтраницы) {
          info.appendChild(el("div", "dev-meta dev-health warn",
            "Версия страницы на планшете: " + d.appVersion + ", на сервере: " + версияСтраницы +
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
        "Последний запуск: " + new Date(r.lastRunUtc).toLocaleString("ru-RU") + ", " + (r.lastResult || "")));
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
      del.addEventListener("click", function () {
        // Картинки тоже ссылались на эту группу: сервер вычистил ссылки, и список картинок надо
        // перечитать, иначе на вкладке «Слайды» останется имя уже несуществующей группы.
        if (confirm("Удалить группу «" + g.name + "»?")) api("/groups/" + g.id, { method: "DELETE" }).then(loadGroups).then(loadDevices).then(loadImages).then(renderImages);
      });
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

    // Повторы кодов, оставшиеся с прежних версий. Завести такое сегодня уже нельзя ни одним
    // путём, но записи, заведённые раньше, лежат как лежали, и молчать о них нельзя: по коду с
    // повтором внешняя система либо получает «на этом месте нет планшета» при работающем
    // планшете, либо документ уходит в чужой кабинет. Сравнение то же, что на сервере: без
    // учёта регистра и без пробелов по краям.
    var поКоду = {};
    state.workstations.forEach(function (w) {
      var к = String(w.externalId || "").trim().toLowerCase();
      if (!к) return;
      (поКоду[к] = поКоду[к] || []).push(w);
    });
    var повторы = Object.keys(поКоду).filter(function (к) { return поКоду[к].length > 1; });
    if (повторы.length) {
      var тревога = el("div", "ws-dup");
      тревога.appendChild(el("div", "ws-dup-head",
        повторы.length === 1 ? "Один код стоит у нескольких мест" : "Несколько кодов стоят у нескольких мест"));
      var сп = el("ul", "ws-dup-list");
      повторы.forEach(function (к) {
        var имена = поКоду[к].map(function (w) { return "«" + (w.name || w.id) + "»"; }).join(", ");
        сп.appendChild(el("li", null, "код " + поКоду[к][0].externalId + ": " + имена));
      });
      тревога.appendChild(сп);
      тревога.appendChild(el("div", "ws-dup-note",
        "Пока код повторяется, заказ по нему уходит первому месту в списке, а остальные для "
        + "внешней системы недостижимы. Оставьте код у того места, где стоит рабочий планшет, "
        + "а остальным задайте свои коды. Удалять место не нужно: достаточно сменить код."));
      wrap.appendChild(тревога);
    }

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
    // Сервер приводит пороги к разумным границам (1..1440 мин, 1..1000 ошибок), иначе опечатка
    // в одну цифру либо выключает сторожа, либо заставляет его звонить непрерывно. Но менять
    // введённое молча нельзя: оператор ушёл бы в уверенности, что порог у него тот, что он набрал.
    // Сравниваем с тем, что оператор набрал руками, а не с тем, что отправили: подстановка
    // запасного числа здесь, на странице, такая же подмена, как и приведение к границе на сервере.
    var поля = [["alertOffline", "offlineMinutes", "порог молчания планшета", 10],
                ["alertErrCount", "errorCount", "число ошибок", 5],
                ["alertErrWindow", "errorWindowMinutes", "окно счёта ошибок", 10]];
    var набрано = {}, послано = { enabled: $("alertEnabled").checked };
    поля.forEach(function (f) {
      набрано[f[1]] = ($(f[0]).value || "").trim();
      послано[f[1]] = parseInt(набрано[f[1]], 10) || f[3];
    });
    apiSend("/alerts/settings", "PUT", послано)
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (принято) {
        return loadAlertSettings().then(function () { return принято; });
      })
      .then(function (принято) {
        var изменено = [];
        поля.forEach(function (f) {
          var стало = принято ? принято[f[1]] : послано[f[1]];
          if (String(стало) !== набрано[f[1]])
            изменено.push(f[2] + ": " + (набрано[f[1]] || "пусто") + " не годится, взято " + стало);
        });
        if (изменено.length) toast("Сохранено, но " + изменено.join("; "), true);
        else toast("Настройки сохранены");
      })
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

  // ==================================================================
  // Вкладка «API»
  // ==================================================================
  // Эту вкладку читает не оператор, а программист чужой системы, и читает он её один раз, перед
  // тем как написать первый запрос. Поэтому здесь два слоя, а не один:
  //
  //   1. Руководство: что делать по шагам, с полными примерами, которые можно скопировать и
  //      выполнить. Оно отвечает на вопрос «я вижу эту систему впервые, с чего начать».
  //   2. Справочник: каждый путь, который обслуживает сервер, с полями запроса, полями ответа,
  //      кодами и точными текстами отказов. Он отвечает на вопрос «что именно вернётся».
  //
  // Справочник собран по обработчикам Program.cs, а не по памяти: там же живут и тексты отказов,
  // и пределы. Набор e2e_v75_apidoc снимает список путей прямо с Program.cs и требует, чтобы
  // каждый был описан здесь: иначе новый метод появлялся бы в сервере, а интегратор узнавал бы о
  // нём из переписки.
  //
  // Статьи справочника свёрнуты: путей девять десятков, и развёрнутыми они превращаются в
  // простыню, по которой нельзя ориентироваться. Разделы руководства раскрыты: их читают
  // подряд. Сверху оглавление и поиск по всей вкладке сразу.

  /// Абзац (или иной узел) с кусками кода: `вот так` становится <code>. Текст пишется как текст,
  /// а не собирается из склеенных узлов на каждое имя поля.
  function апиФраза(текст, тег, класс) {
    var узел = el(тег || "p", класс == null ? "api-desc" : класс);
    String(текст).split("`").forEach(function (часть, i) {
      if (часть === "") return;
      if (i % 2) узел.appendChild(el("code", null, часть));
      else узел.appendChild(document.createTextNode(часть));
    });
    return узел;
  }

  /// Таблица справочника. Ширина всегда по месту: колонки фиксированные, длинное слово
  /// переносится. Иначе таблица с текстом отказа распирала бы вкладку и страница ехала бы вбок.
  function апиТаблица(шапка, строки, класс) {
    var t = el("table", "api-tbl api-tbl-" + шапка.length + (класс ? " " + класс : ""));
    var thead = el("thead"), tr = el("tr");
    // Шапка это простой текст: обратные кавычки в ней не разметка, а видимые знаки. Снимаем их,
    // чтобы описка не превращалась в «ЧТО СКАЖЕТ `DROPPED`» на экране.
    шапка.forEach(function (h) { tr.appendChild(el("th", null, String(h).replace(/`/g, ""))); });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el("tbody");
    строки.forEach(function (r) {
      var row = el("tr");
      r.forEach(function (c) {
        var td = el("td");
        td.appendChild(апиФраза(c, "span", "api-cell"));
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    return t;
  }

  /// Заголовок подраздела внутри статьи или раздела.
  function апиПодзаголовок(текст) { return el("h4", "api-h4", текст); }

  /// Врезка: то, на чём чужие системы спотыкаются чаще всего.
  function апиВрезка(текст, вид) {
    return апиФраза(текст, "div", "api-note" + (вид ? " api-note-" + вид : ""));
  }

  // Значения этой установки, которые встают в образцы вместо заглушек. Заглушка, которую негде
  // взять, это главная жалоба на справочник: человек копирует строку с «DEVICE_ID», получает 404
  // и решает, что сломано API. Поэтому в образец встаёт настоящий планшет, настоящее место и
  // настоящий документ этого сервера, а когда их нет, прямо сказано, где их завести. Тот же
  // приём уже сделан в окне проверки запроса на вкладке «Документ».
  var апиЗначения = {
    "{ПЛАНШЕТ}": "СНАЧАЛА_ЗАВЕДИТЕ_ПЛАНШЕТ_НА_ВКЛАДКЕ_ПЛАНШЕТЫ",
    "{МЕСТО}": "СНАЧАЛА_ЗАВЕДИТЕ_МЕСТО_НА_ВКЛАДКЕ_МЕСТА",
    "{МЕСТО_ID}": "СНАЧАЛА_ЗАВЕДИТЕ_МЕСТО_НА_ВКЛАДКЕ_МЕСТА",
    "{ДОКУМЕНТ}": "СНАЧАЛА_ЗАВЕДИТЕ_ДОКУМЕНТ_НА_ВКЛАДКЕ_ДОКУМЕНТ",
    "{ДОКУМЕНТ_ID}": "СНАЧАЛА_ЗАВЕДИТЕ_ДОКУМЕНТ_НА_ВКЛАДКЕ_ДОКУМЕНТ",
    "{ГРУППА}": "СНАЧАЛА_ЗАВЕДИТЕ_ГРУППУ_НА_ВКЛАДКЕ_ГРУППЫ"
  };

  /// Подстановка в образец: адрес этого сервера и настоящие значения этой установки.
  function апиПодстановка(текст) {
    var т = String(текст).replace(/\{BASE\}/g, window.location.origin);
    Object.keys(апиЗначения).forEach(function (к) { т = т.split(к).join(апиЗначения[к]); });
    return т;
  }

  /// Образец запроса. Адрес и значения подставляются настоящие, чтобы строку можно было
  /// скопировать и выполнить, не редактируя.
  function апиОбразец(текст) {
    return el("pre", "api-code", апиПодстановка(текст));
  }

  /// Ряд действий под образцом: скопировать и, где это уместно, выполнить прямо отсюда.
  function апиДействия(образец, отправка) {
    var ряд = el("div", "api-ep-actions");
    var копия = iconBtn("copy", "Копировать", "btn-ghost btn-sm");
    var текст = апиПодстановка(образец);
    копия.addEventListener("click", function () { copyText(текст); });
    ряд.appendChild(копия);
    if (отправка) {
      var go = iconBtn("send", "Отправить запрос", "btn-primary btn-sm");
      go.addEventListener("click", function () { openApiSend(отправка); });
      ряд.appendChild(go);
    }
    return ряд;
  }

  /// Свёртка: шапка-кнопка и тело. Одна на разделы руководства и на статьи справочника, чтобы
  /// раскрывались они одинаково и поиск умел раскрывать и то и другое.
  function апиСвёртка(префикс, шапка, тело, открыта) {
    var карточка = el("div", префикс);
    var head = el("button", префикс + "-head");
    head.type = "button";
    шапка.forEach(function (n) { head.appendChild(n); });
    var шеврон = el("span", "api-chev");
    шеврон.appendChild(icon("down"));
    head.appendChild(шеврон);
    var body = el("div", префикс + "-body");
    тело.forEach(function (n) { body.appendChild(n); });
    карточка.appendChild(head);
    карточка.appendChild(body);
    карточка.раскрыть = function (да) {
      body.classList.toggle("hidden", !да);
      карточка.classList.toggle("open", !!да);
      head.setAttribute("aria-expanded", да ? "true" : "false");
    };
    head.addEventListener("click", function () { карточка.раскрыть(body.classList.contains("hidden")); });
    карточка.раскрыть(!!открыта);
    return карточка;
  }

  // ---- Отказы, общие для целого контура ----
  // Они одинаковы у каждого пути своего контура, поэтому дописываются к списку отказов каждой
  // статьи, а не пересказываются в ней руками: пересказ разошёлся бы с кодом на первом же
  // изменении.
  var API_ОТКАЗЫ_EXT = [
    ["401", "`{\"error\":\"invalid api key\"}` на неверный, выключенный и отсутствующий ключ. Текст один на все три случая нарочно: по разнице в ответе было бы видно, что ключ угадан верно и просто выключен."],
    ["429", "`{\"error\":\"Слишком много запросов с этого адреса. Повторите через N с.\",\"retryAfterSec\":N}` и заголовок `Retry-After`. Предел 600 запросов в минуту с одного адреса."],
    ["400", "Пустое тело там, где ждут JSON: «Тело запроса пустое, а этот запрос ждёт JSON. Пришлите заголовок Content-Type: application/json и тело запроса, например {\"deviceId\":\"...\"}.»"],
    ["400", "Значение в строке запроса не того вида (`?limit=abc`): «Запрос не разобран. Проверьте, что тело это правильный JSON, а значения в строке запроса нужного вида (например limit это число).»"],
    ["400", "Битый JSON в теле: пустой ответ без текста. Разбор тела к этому моменту уже случился, и объяснить отказ своими словами тут нечем"],
    ["415", "`Content-Type` не `application/json`: пустой ответ без текста"]
  ];
  var API_ОТКАЗЫ_ADMIN = [
    ["401", "Куки входа нет или она не годится. Тело ответа пустое: это отказ платформы, до обработчика запрос не доходит."]
  ];
  var API_ОТКАЗЫ_ПЛАНШЕТ = [
    ["401", "Нет заголовка `Authorization: Bearer` с токеном планшета или токен не годится. Тело ответа пустое."],
    ["429", "`{\"error\":\"Слишком много запросов с этого адреса. Повторите через N с.\",\"retryAfterSec\":N}` и заголовок `Retry-After`."]
  ];

  // ==================================================================
  // Руководство: что делать по шагам
  // ==================================================================
  // Порядок разделов повторяет порядок, в котором чужая система пишет свою первую интеграцию:
  // получить ключ, найти планшет, выбрать документ, собрать данные, разобрать ответ.

  var API_РАЗДЕЛЫ = [
    {
      id: "api-start", заголовок: "1. С чего начать",
      строить: function (х) {
        х.appendChild(апиФраза("В системе два отдельных контура, и путать их не нужно. `/api/ext/*` это то, ради чего API существует: чужая программа показывает клиенту документ, просит отсканировать код, возвращает планшет к рекламе. Доступ по ключу. `/api/admin/*` это внутреннее API самой админки: тот же набор действий плюс всё, что оператор делает руками, от загрузки рекламы до чтения журнала. Доступ по куке входа, ключ там не работает."));
        х.appendChild(апиФраза("Базовый адрес этой установки: `" + window.location.origin + "`. Все примеры ниже уже собраны с ним, их можно копировать как есть."));
        х.appendChild(апиПодзаголовок("Ключ доступа"));
        х.appendChild(апиФраза("Ключ создаётся на вкладке «API-ключи» кнопкой «Создать». Ключ показывается один раз, при создании: на сервере хранится только его SHA-256, и восстановить потерянный нельзя, можно только создать новый. Выглядит он как `sk_` и 30 случайных байт."));
        х.appendChild(апиФраза("Передаётся ключ заголовком `X-Api-Key`. Ни строкой запроса, ни в теле он не принимается: строка запроса попадает в журналы прокси, и ключ оттуда уже не убрать."));
        х.appendChild(апиОбразец('curl -H "X-Api-Key: ВАШ_КЛЮЧ" {BASE}/api/ext/devices'));
        х.appendChild(апиФраза("Это и есть первый запрос, с которого стоит начать: он ничего не меняет и сразу показывает, годится ключ или нет."));
        х.appendChild(апиПодзаголовок("Что будет с плохим ключом"));
        х.appendChild(апиТаблица(["Случай", "Ответ"], [
          ["ключа нет вовсе", "401 `{\"error\":\"invalid api key\"}`"],
          ["ключ неверный", "401 `{\"error\":\"invalid api key\"}`"],
          ["ключ выключен на вкладке «API-ключи»", "401 `{\"error\":\"invalid api key\"}`"],
          ["ключ удалён", "401 `{\"error\":\"invalid api key\"}`"]
        ]));
        х.appendChild(апиФраза("Текст один на все случаи намеренно. Сравнение ключа идёт с постоянным временем, причём выключенный ключ сравнивается наравне с остальными и только потом отбрасывается: иначе по времени ответа было бы видно, что ключ угадан верно и просто выключен."));
        х.appendChild(апиФраза("Выключить ключ, не удаляя, можно там же. Это сделано затем, что «перекрыть доступ на время разбирательства» и «забыть, что такой доступ был» это разные действия: удаление необратимо и требует заново настраивать чужую систему, поэтому доступ чаще оставляли включённым."));
        х.appendChild(апиВрезка("Вошедший в админку администратор проходит по `/api/ext/*` и без ключа, по своей куке. Он проверяет свой же документ из админки, а права у него и так шире, чем у любого ключа. Именно поэтому кнопка «Отправить запрос» на этой вкладке работает без ключа."));
        х.appendChild(апиПодзаголовок("Частота запросов"));
        х.appendChild(апиФраза("Пределы считаются по адресу отправителя, окном в одну минуту: внешнее API 600 запросов, сканирование планшета 60, отправка подписи 60, диагностика планшета 30, активация планшета 20, вход в админку 10. Это сделано не ради экономии, а чтобы поток запросов не занял ту же блокировку хранилища, которая нужна подписанию."));
        х.appendChild(апиФраза("При переборе приходит 429, тело `{\"error\":\"Слишком много запросов с этого адреса. Повторите через N с.\",\"retryAfterSec\":N}` и заголовок `Retry-After`."));
        х.appendChild(апиПодзаголовок("Вид запроса"));
        х.appendChild(апиФраза("Тело только JSON, кодировка UTF-8, заголовок `Content-Type: application/json`."));
        х.appendChild(апиТаблица(["Что не так с самим запросом", "Ответ"], [
          ["тела нет вовсе", "400 с текстом: «Тело запроса пустое, а этот запрос ждёт JSON. Пришлите заголовок Content-Type: application/json и тело запроса, например {\"deviceId\":\"...\"}.»"],
          ["в строке запроса не то значение (`?limit=abc`)", "400 с текстом: «Запрос не разобран. Проверьте, что тело это правильный JSON, а значения в строке запроса нужного вида (например limit это число).»"],
          ["тело не разбирается как JSON", "400 и ПУСТОЕ тело ответа"],
          ["`Content-Type` не `application/json`", "415 и ПУСТОЕ тело ответа"],
          ["такого адреса нет", "404 и пустое тело ответа"]
        ]));
        х.appendChild(апиВрезка("Два случая объяснения не получают, и это стоит знать заранее. Пустое тело и негодное значение в строке запроса система разбирает сама и называет словами. А битый JSON и чужой `Content-Type` отвергает платформа ещё до обработчика: к тому моменту тело уже прочитано разбором параметров, и второй раз его не прочитать, поэтому сказать своими словами нечего. Пустой ответ 400 или 415 читайте как «запрос не разобран»: проверьте JSON и заголовок.", "warn"));
      }
    },
    {
      id: "api-target", заголовок: "2. Как адресовать планшет",
      строить: function (х) {
        х.appendChild(апиФраза("Это место, где чужие системы ошибаются чаще всего, поэтому правило названо прямо: документ всегда показывается ровно на одном планшете, и если выбрать однозначно нельзя, сервер отказывает, а не угадывает. Чужие данные перед чужим человеком не исправишь."));
        х.appendChild(апиФраза("Адресовать можно двумя способами, и в запросе достаточно одного из них. Главный способ это код рабочего места: код задаёте вы сами, он переживает замену планшета и остаётся тем же, когда планшет увезли в ремонт и поставили на его место другой. Номер планшета это запасной путь: он меняется вместе с железом, и заказ, где он записан, однажды перестаёт находить кабинет."));
        х.appendChild(апиТаблица(["Поле", "Что это", "Откуда взять", "Когда удобно"], [
          ["`workstationExternalId`", "код рабочего места, его задаёте вы сами (`KAB-12`, `WS-204`)", "`GET /api/ext/workstations`, поле `externalId`. Своё место заводится `POST /api/ext/workstations`", "почти всегда, это главный способ"],
          ["`deviceId`", "внутренний номер планшета, вид `dev-811a68564e`. Его выдаёт система при активации", "`GET /api/ext/devices`, поле `deviceId`", "запасной путь: когда чужая система хранит номера планшетов у себя и когда на месте несколько планшетов и надо выбрать один"]
        ]));
        х.appendChild(апиФраза("Код рабочего места сравнивается без учёта регистра и окружающих пробелов, поэтому `WS-204`, `ws-204` и ` WS-204 ` это одно и то же место. Раньше сравнение было разным в разных местах, и `ROOM-12` заводил место, но не находил его."));
        х.appendChild(апиПодзаголовок("Что будет в каждом случае"));
        х.appendChild(апиТаблица(["Случай", "Код", "Что придёт"], [
          ["не прислано ни `deviceId`, ни `workstationExternalId`", "400", "`pass deviceId or workstationExternalId`"],
          ["планшета с таким `deviceId` нет", "404", "`device not found`"],
          ["планшет отозван", "404", "`this tablet is revoked`. Отозванный не выбирается и по прямому номеру: раньше документ с данными клиента уезжал на устройство, которое ничего не покажет, а система получала «ок»"],
          ["рабочего места с таким кодом нет", "404", "`workstation not found: WS-204`"],
          ["на месте нет ни одного планшета", "404", "`no tablet is assigned to this workstation`"],
          ["на месте только отозванные", "404", "`the only tablet(s) assigned to this workstation are revoked`"],
          ["прислано и то и другое, но они не сходятся", "409", "`deviceId and workstationExternalId disagree: tablet '...' is not at workstation '...'. Pass one of them, not both.`"],
          ["на месте несколько живых планшетов", "409", "`several tablets are assigned to this workstation; pass deviceId to choose one:` и перечень: имя, номер и «на связи» или «не на связи» по каждому"]
        ], "api-tbl-case"));
        х.appendChild(апиВрезка("Прислать `deviceId` и `workstationExternalId` сразу можно, но они обязаны сходиться. Раньше второе молча отбрасывалось, а это самый опасный вид расхождения: заказ несёт вчерашний номер планшета, который с тех пор перевезли в другой кабинет, и правильный код кабинета. Документ уезжал в чужой кабинет, а в ответе стояло «ок».", "warn"));
        х.appendChild(апиПодзаголовок("Два планшета на одном рабочем месте"));
        х.appendChild(апиФраза("Случай настоящий: планшет заменили, а прежний с места не сняли, либо в кабинете их правда два. Правило одно. На связи ровно один, документ уходит ему без всякого вопроса: остальные сейчас не могут показать вообще ничего, и вопрос «кто это увидит» имеет единственный ответ. На связи несколько или ни одного означает настоящую неоднозначность, и служба отказывает с перечнем, а не угадывает."));
        х.appendChild(апиОбразец('# на месте два планшета, на связи оба\n409 {"error":"several tablets are assigned to this workstation; pass deviceId to choose one:\n         Ресепшн 1 (dev-62d99961c0, на связи), Ресепшн 1-бис (dev-be836e135b, на связи)"}\n\n# на месте два планшета, ни одного на связи\n409 {"error":"several tablets are assigned to this workstation; pass deviceId to choose one:\n         Ресепшн 1 (dev-62d99961c0, не на связи), Ресепшн 1-бис (dev-be836e135b, не на связи)"}'));
        х.appendChild(апиФраза("В тексте отказа перечислены все планшеты этого места, их номера и состояние связи: `deviceId` для повторного запроса берётся прямо оттуда. Теми же словами отказывают `POST /api/ext/scan-request`, `scan-cancel` и `return-slides`: адресата все они разбирают одним и тем же кодом. Если второй планшет на месте лишний, правильнее снять его с места запросом `DELETE /api/ext/devices/{id}/workstation`, чем выбирать между ними в каждом заказе."));
        х.appendChild(апиПодзаголовок("Если планшет не на связи"));
        х.appendChild(апиФраза("Показ документа и сканирование ведут себя по-разному, и это не недосмотр, а разная природа действия."));
        х.appendChild(апиТаблица(["Что делаем", "Планшет выключен", "Почему так"], [
          ["`POST /api/ext/show-document`", "200, но `shown: false` и `deviceOnline: false`, плюс готовое пояснение в `note`. Документ сохранён и появится на экране, как только планшет подключится, но не позже чем через два часа, потом он стирается сам", "документ это состояние: его можно сохранить и показать позже"],
          ["`POST /api/ext/scan-request`", "409 сразу, с текстом «Планшет «...» сейчас не на связи, команда сканирования до него не дойдёт.»", "сканирование это живая команда: она не сохраняется и до выключенного планшета не дойдёт, а ждать до таймаута значило бы вернуть «код не отсканирован» вместо причины"]
        ]));
        х.appendChild(апиВрезка("`ok: true` в ответе показа не значит «клиент видит документ». Это значит «заказ принят и адресат выбран однозначно». Видит ли клиент документ прямо сейчас, говорит поле `shown`.", "warn"));
      }
    },
    {
      id: "api-doc-pick", заголовок: "3. Как выбрать документ",
      строить: function (х) {
        х.appendChild(апиФраза("Документов в системе может быть несколько: согласие на обработку данных, согласие на процедуру, памятка. Каждый адресуется своим кодом, и код задаёт оператор в админке на вкладке «Документ»."));
        х.appendChild(апиТаблица(["Что прислали", "Что покажется"], [
          ["`documentCode` с известным кодом", "этот документ. Ответ вернёт тот же код в поле `document`"],
          ["`documentCode` не прислан или пустой", "документ, помеченный в админке как документ по умолчанию"],
          ["`documentCode` с неизвестным кодом", "400 «Документ с кодом «X» не найден. Доступные коды: ...» с перечнем всех кодов"]
        ]));
        х.appendChild(апиФраза("Молча подставить документ по умолчанию вместо незнакомого кода было бы худшим из решений: внешняя система опечаталась, человек подписал не то, а запись при этом выглядит подлинной."));
        х.appendChild(апиФраза("Какие коды есть прямо сейчас, отвечает `GET /api/ext/documents`: по каждому документу приходят `code`, `name` и `isDefault`. Спрашивать коды у оператора по переписке не нужно, и переименование документа связь не ломает."));
        х.appendChild(апиОбразец('curl -H "X-Api-Key: ВАШ_КЛЮЧ" {BASE}/api/ext/documents'));
        х.appendChild(апиФраза("Ещё один отказ по документу: если в нём нет ни одной страницы, приходит 400 «В документе «...» нет ни одной страницы: показывать нечего.» Планшет иначе остался бы с прежним экраном, а вызывающая сторона решила бы, что отправка сработала."));
      }
    },
    {
      id: "api-fields", заголовок: "4. Что слать в fields",
      строить: function (х) {
        х.appendChild(апиФраза("`fields` это набор «имя тега: значение». Оператор ставит в текст документа `{{имя тега}}`, а сервер подставляет туда присланное значение. По этим же тегам работают условия показа блоков и целых страниц."));
        х.appendChild(апиФраза("Список тегов задан системой и общий на все документы:"));
        var tags = el("div", "api-tags");
        KNOWN_FIELDS.forEach(function (f) { tags.appendChild(el("code", "ph-tag", "{{" + f + "}}")); });
        х.appendChild(tags);
        х.appendChild(апиФраза("Тот же список отдаёт `GET /api/admin/field-schema` вместе с допустимыми значениями: интерфейс читает его оттуда, а не держит свою копию, поэтому список тегов в админке и на сервере разойтись не могут."));
        х.appendChild(апиПодзаголовок("В каком виде слать значения"));
        х.appendChild(апиТаблица(["Тег", "Что принимается", "Что будет при другом значении"], [
          ["`ФИО`, `Адрес регистрации`, `email`, `telephone`, `document`, `text1`..`text10`", "любая строка до 4000 знаков", "длиннее обрезается, и обрезка называется в списке потерь"],
          ["`Пол`", "`M` или `F`. Принимаются также `m`, `М`, `м`, `муж` и `f`, `Ж`, `ж`, `жен`: латинская `M` и русская `М` на глаз неразличимы, и требовать одного написания значило бы собирать ошибки на ровном месте", "значение остаётся как есть, условие на него просто не совпадёт"],
          ["`ДР`, `date`", "`01.01.1990` или `1990-01-01`", "если тег участвует в условии по возрасту или по годовщине, приходит 400 с именем тега"],
          ["`cross-border`, `urine`, `UG`", "только `true` или `false`: настоящий JSON-булев `true`, либо строка `\"true\"` в кавычках, регистр не важен", "400 «Тег «urine» принимает только true или false, получено: 1»"]
        ]));
        х.appendChild(апиФраза("Телефон, адрес электронной почты и номер документа не проверяются никак: они попадают в текст документа как есть, и вид у них тот, который принят у вас. Проверяются только те теги, у которых набор значений задан: пол и три булевых."));
        х.appendChild(апиФраза("Значение можно прислать строкой, настоящим JSON-булевым или числом: разработчик пишет `new { urine = true }`, и такой запрос обязан работать. Без этого весь запрос отклонялся бы ещё до обработчика, документ не появился бы вовсе, а зацепиться было бы не за что. Объект и массив в значении тега подставить некуда, поэтому такое значение пропускается, а остальной запрос остаётся годным."));
        х.appendChild(апиФраза("Имена тегов сравниваются без учёта регистра: `пол`, `Пол` и `ПОЛ` это один и тот же тег и в запросе, и в условии, и в подстановке."));
        х.appendChild(апиПодзаголовок("Неизвестный тег, пустое значение и пропущенное значение"));
        х.appendChild(апиТаблица(["Случай", "Что происходит"], [
          ["прислали тег, которого в документе нет", "он никуда не подставляется и ничего не ломает. Запрос принимается"],
          ["в документе есть `{{тег}}`, а в запросе его нет", "в тексте остаётся `{{тег}}` как есть, чтобы пропуск было видно, и имя тега приходит в ответе в `missingPlaceholders`"],
          ["в документе есть `{{тег}}`, а в запросе он с пустым значением", "подставляется пустота, и в тексте остаётся дыра («Я, , согласен»). В `missingPlaceholders` такой тег НЕ попадает: ключ был прислан. Условие на этот тег гаснет"]
        ]));
        х.appendChild(апиВрезка("Пустая строка и отсутствие ключа это разные вещи. Если значение неизвестно, лучше не присылать ключ вовсе: тогда пропуск виден и в документе, и в ответе.", "warn"));
        х.appendChild(апиПодзаголовок("Условия показа"));
        х.appendChild(апиФраза("Оператор может показывать блок или целую страницу по условию на тег: равно, не равно, пусто, не пусто, одно из. Условий может быть несколько через «и» и несколько наборов через «или», а любую часть можно отрицать. Пример: страницу «Трансграничная передача» показывать, если `cross-border` равно `true`."));
        х.appendChild(апиФраза("Есть условия по возрасту: он считается на сервере из даты рождения, поэтому присылать нужно только `ДР`, а документ сам решит, показывать ли блок для законных представителей. Есть условие по сроку: «до годовщины не больше N дней» считает день и месяц, год не важен, и это случай дня рождения; окно задаётся отдельно до годовщины и после неё."));
        х.appendChild(апиФраза("Блок, который этому клиенту не положен, на планшет не уходит вообще, а не прячется там. В подпись и в PDF попадает только то, что клиент действительно видел."));
      }
    },
    {
      id: "api-checks", заголовок: "5. Пункты для отметки и группы выбора",
      строить: function (х) {
        х.appendChild(апиФраза("Пункты согласия приходят массивом `checkboxes`, а вопросы с выбором одного ответа массивом `groups`. И там и там всё держится на имени: имя задаёт оператор в редакторе документа, а внешняя система по нему адресуется."));
        х.appendChild(апиПодзаголовок("Два разных действия"));
        х.appendChild(апиТаблица(["Что нужно", "Как", "Куда встанет"], [
          ["отметить пункт, который УЖЕ есть в документе", "`{\"key\":\"consent\",\"checked\":true}` с именем из редактора", "на своё место в документе, там, где его поставил оператор"],
          ["прислать СВОЙ пункт, которого в документе нет", "`{\"label\":\"Согласен на рассылку\",\"checked\":false}`", "в конец страницы, помеченной галочкой «Показывать здесь чекбоксы, присланные по API». Если такой страницы нет ни одной, пункт не показывается вовсе: ответ 200, а в `dropped` придёт «пункт «X» не показан: ни одна страница документа не принимает пункты из API. Отметьте нужную страницу в редакторе признаком «чекбоксы из API»»"]
        ]));
        х.appendChild(апиФраза("Галочка «Показывать здесь чекбоксы, присланные по API» нужна потому, что место присланного пункта в шаблоне не задано: оператор его туда не ставил, и сам собой он никуда не встанет. Галочка и говорит, на какой странице ему быть, а внутри страницы он встаёт последним, следом за всем, что оператор расставил сам. Если галочки нет ни на одной странице, присланный пункт не показывается вовсе и называется в `dropped` своим текстом. Прежняя вставка в конец последней страницы убрана намеренно: последней бывает страница подписи, и пункт вставал под ней. Страница с присланным пунктом при этом обязательно попадает в PDF, даже если её пометили «не печатать»: иначе в бумаге остался бы один список отметок без текста, под которым человек расписался."));
        х.appendChild(апиВрезка("Пункт с незнакомым именем считается своим присланным пунктом и дописывается вниз, но только на странице с признаком «чекбоксы из API». Если такой страницы в документе нет, опечатка в `key` это не лишний пункт, а потеря: пункт не покажется, а его текст придёт в `dropped`. Сверяйтесь с именами из редактора и с `dropped` в ответе.", "warn"));
        х.appendChild(апиПодзаголовок("Поля пункта"));
        х.appendChild(апиТаблица(["Поле", "Вид", "Что делает"], [
          ["`key`", "строка", "имя пункта в документе. Косая черта в имени не допускается и снимается при разборе"],
          ["`checked`", "булев", "начальное состояние отметки"],
          ["`required`", "булев", "обязательность. Не прислали, значит НЕ обязателен. Это обратно тому, как ведёт себя пункт, поставленный оператором: он обязателен по умолчанию, потому что оператор ставит пункт затем, чтобы клиент его отметил"],
          ["`label`", "строка до 2000 знаков", "заменяет текст пункта целиком"],
          ["`labelAppend`", "строка до 2000 знаков", "дописывает к тому тексту, который стоит в документе сейчас. Внешняя система не обязана знать формулировку документа"],
          ["`visibleWhen`", "условие", "условие показа, такое же, как в редакторе: `{\"field\":\"Пол\",\"op\":\"eq\",\"value\":\"F\"}`. Части про теги считаются на сервере, части про отметки уезжают на планшет"]
        ], "api-tbl-req"));
        х.appendChild(апиФраза("Дописка присоединяется через пробел, но если она начинается со знака препинания (`, . ; : ! ? )` или закрывающей кавычки), пробел не ставится: получается «НЕТ, не соблюдал», а не «НЕТ , не соблюдал». Если в одном запросе пришли и `label`, и `labelAppend`, дописка присоединяется к присланному тексту."));
        х.appendChild(апиПодзаголовок("Группы выбора"));
        х.appendChild(апиФраза("Группа это набор, где выбрать можно только один вариант, и «ни одного» тоже допустимое состояние."));
        х.appendChild(апиТаблица(["Поле", "Вид", "Что делает"], [
          ["`key`", "строка", "имя группы в документе"],
          ["`selected`", "строка", "имя выбранного варианта. Пустая строка снимает выбор"],
          ["`title`", "строка до 2000 знаков", "заменяет заголовок группы целиком"],
          ["`titleAppend`", "строка до 2000 знаков", "дописывает к заголовку из документа"],
          ["`options`", "массив `{key, label, labelAppend}`", "подписи вариантов. Если прислан непустой список, он и становится набором ответов вместо того, что стоит в документе: складывать два набора значило бы показать клиенту оба сразу"]
        ], "api-tbl-req"));
        х.appendChild(апиФраза("Присланный текст живёт до конца этого показа: он попадает в запись подписи и в PDF, но в сам шаблон не записывается, иначе документ дописывал бы сам к себе при каждом показе. Оформление (жирный, цвет) у присланного текста снимается: внешняя система прислала другую формулировку, а не другой её вид."));
        х.appendChild(апиФраза("Имена чекбоксов и групп живут отдельно от имён тегов: одно имя никогда не значит две вещи. В условии показа можно сослаться и на имя пункта или группы, и тогда условие считается прямо на планшете, пока клиент отмечает. Обязательный пункт, скрытый условием, кнопку «Далее» не блокирует."));
        х.appendChild(апиВрезка("Группы с незнакомым именем в документе не появляется вовсе, и выбор несуществующего варианта превращается в «ничего не выбрано». Молчания тут нет: и то и другое приходит в списке потерь `dropped`, вместе с перечнем имён, которые есть. Иначе клиент подписал бы документ без ответа на вопрос, который ему задали в заказе.", "warn"));
      }
    },
    {
      id: "api-images", заголовок: "6. Картинка вместе с заказом",
      строить: function (х) {
        х.appendChild(апиФраза("Картинку можно не хранить в системе, а прислать вместе с заказом: печать, штрихкод направления, снимок. Оператор ставит в документ блок картинки и задаёт ему имя тега, например `ПЕЧАТЬ`, а запрос присылает поле `images`, где ключ это имя тега, а значение сама картинка строкой BASE64."));
        х.appendChild(апиОбразец('"images": { "ПЕЧАТЬ": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }'));
        х.appendChild(апиТаблица(["Правило", "Значение"], [
          ["приставка `data:image/png;base64,`", "не обязательна, голый BASE64 принимается так же"],
          ["виды", "PNG, JPG и BMP. Вид определяется по первым байтам, а не по написанному в приставке"],
          ["размер одной картинки", "до 2 МБ, считая длину самой строки BASE64"],
          ["картинок в одном запросе", "не больше 8"],
          ["имена тегов", "сравниваются без учёта регистра, как и обычные теги"]
        ]));
        х.appendChild(апиФраза("Разрешены только те виды, которые умеет вложить в себя PDF: иначе клиент увидел бы картинку, а в подписанном документе её бы не оказалось, и запись перестала бы совпадать с подписанным."));
        х.appendChild(апиПодзаголовок("Отказы по картинке"));
        х.appendChild(апиТаблица(["Что не так", "Код", "Текст"], [
          ["картинок больше восьми", "400", "«Слишком много картинок в одном запросе: не больше 8.»"],
          ["пустое имя тега", "400", "«У картинки не задано имя тега: непонятно, куда её ставить.»"],
          ["пустое значение", "400", "«Картинка «ПЕЧАТЬ» пришла пустой.»"],
          ["больше 2 МБ", "400", "«Картинка «ПЕЧАТЬ» слишком большая: не больше двух мегабайт в BASE64.»"],
          ["значение не BASE64", "400", "«Картинка «ПЕЧАТЬ» это не BASE64.»"],
          ["не PNG, JPG и не BMP", "400", "«Картинка «ПЕЧАТЬ» не PNG, не JPG и не BMP. Другие виды нельзя вложить в PDF, и подписанный документ не совпал бы с тем, что видел клиент.»"],
          ["тега с таким именем в документе нет", "200", "запрос принят, но в списке потерь: «картинка «ПЕЧАТЬ» не показана: в документе «CODE» нет такого тега. Есть: ...»"]
        ], "api-tbl-case"));
        х.appendChild(апиФраза("Картинка, выбранная оператором в редакторе, при заданном теге становится запасной: она показывается, когда заказ картинку не принёс. Нет ни присланной, ни запасной, и блока не будет вовсе: пустая рамка посреди документа выглядит поломкой."));
      }
    },
    {
      id: "api-answer", заголовок: "7. Как понять, что запрос доехал не полностью",
      строить: function (х) {
        х.appendChild(апиФраза("Внешней системе нельзя показать предупреждение, как оператору: у неё есть только ответ. Поэтому всё, что не доехало до клиента, названо в ответе словами, а не подразумевается."));
        х.appendChild(апиТаблица(["Поле ответа", "Что означает"], [
          ["`ok`", "заказ принят и адресат выбран однозначно. Это НЕ «клиент видит документ»"],
          ["`deviceId`", "на какой планшет ушёл документ. Полезно, когда адресовались кодом места"],
          ["`document`", "код документа, который в итоге ушёл на планшет"],
          ["`shown`, `deviceOnline`", "был ли планшет на связи прямо сейчас. `false` означает, что документ сохранён и покажется при подключении, но не позже чем через два часа"],
          ["`note`", "готовое к показу оператору пояснение к `shown: false`. При `shown: true` приходит `null`"],
          ["`missingPlaceholders`", "теги, которые документ использует, а вы не передали. Они останутся в тексте как `{{вот так}}` и вернутся в том написании, в каком стоят в документе"],
          ["`emptyPlaceholders`", "теги, которые вы прислали, но с пустым значением. На их месте в тексте останется дыра («Я, , согласен»), а условие на такой тег погаснет. Отдельно от `missingPlaceholders`, потому что там смысл «ключа не было», а пустое значение могли прислать умышленно"],
          ["`placed`", "куда встал каждый присланный пункт: «пункт «Согласен на рассылку» добавлен на страницу «Согласия»». Пустой список, если присланных пунктов не было. Тот же перечень ложится в журнал записью «Заказ добавил в документ «CODE» пунктов: N», чтобы оператор понимал, откуда в документе взялся пункт, которого он не писал"],
          ["`dropped`", "список потерь: что не поместилось в пределы или никуда не встало. Пустой список означает «доехало всё»"]
        ]));
        х.appendChild(апиПодзаголовок("Пределы и что попадает в список потерь"));
        х.appendChild(апиФраза("Данные подписанта хранятся на каждый планшет отдельно и перечитываются на каждое подключение, отправку подписи и возврат с камеры, поэтому они обязаны оставаться небольшими. Пределы взяты заведомо выше любой настоящей формы согласия."));
        х.appendChild(апиТаблица(["Что", "Предел", "Что скажет список потерь"], [
          ["тегов в запросе", "100", "«тегов прислано N, взято 100: лишние не подставлены»"],
          ["длина имени тега", "200 знаков", "обрезается молча"],
          ["длина значения тега", "4000 знаков", "«значение тега «X» обрезано до 4000 знаков»"],
          ["присланных пунктов", "100", "«пункт «X» не показан: пунктов сверх 100 не бывает»"],
          ["надпись пункта, группы или варианта, которые УЖЕ есть в документе", "2000 знаков", "«надпись «X» обрезана до 2000 знаков». Вместо X имя пункта, имя группы или `группа/вариант`"],
          ["текст пункта, ПРИСЛАННОГО заказом", "2000 знаков", "«текст пункта «X» обрезан до 2000 знаков». У пункта, присланного без `key`, имя в этом тексте выходит пустым: именем служит `key`"],
          ["подпись варианта, ПРИСЛАННОГО заказом", "2000 знаков", "«текст варианта «группа/вариант» обрезан до 2000 знаков»"],
          ["групп в запросе и вариантов в группе", "по 100", "лишние просто не берутся"],
          ["картинок в запросе", "8", "отказ 400, а не потеря"],
          ["размер картинки", "2 МБ в BASE64", "отказ 400, а не потеря"]
        ], "api-tbl-case"));
        х.appendChild(апиФраза("Кроме обрезки, в список потерь попадает то, что не встало никуда: «группы «X» в документе «CODE» нет: ни вопрос, ни выбор клиенту не показаны. Есть: ...», «варианта «Y» в группе «X» нет: выбор не применён, клиент увидит вопрос без ответа. Есть: ...», «картинка «ПЕЧАТЬ» не показана: в документе «CODE» нет такого тега. Есть: ...». Туда же попадает присланный пункт, которому некуда встать: «пункт «X» не показан: ни одна страница документа не принимает пункты из API»."));
        х.appendChild(апиФраза("Хвост «Есть: ...» появляется, только когда перечислять есть что: если в документе нет ни одной группы (или ни одного тега картинки), текст обрывается на «нет такого тега», и это не обрезка ответа. На поставляемом документе `main` так и выходит: «группы «transfer» в документе «main» нет: ни вопрос, ни выбор клиенту не показаны», без хвоста."));
        х.appendChild(апиВрезка("Проверять после каждого показа стоит три вещи: `shown` (клиент видит или увидит позже), `dropped` (пустой ли), `missingPlaceholders` (нет ли там тега, который вы собирались прислать). Ответ «ок» с непустым `dropped` означает, что клиент подписывает документ, из которого части он не увидел.", "warn"));
      }
    }
  ];

  // ---- Полные примеры на живые случаи ----
  // Каждый пример это целое тело запроса, а не кусок: его копируют и выполняют. Кнопка
  // «Отправить запрос» отправляет ровно это тело на тот же адрес, куда его прислала бы внешняя
  // система, подставив планшет с этого стенда, если он есть. Так пример проверяется на месте, а
  // не на словах.
  var API_ПРИМЕРЫ = [
    {
      id: "primer-ws",
      заголовок: "Показать согласие клиенту, адресуясь по коду рабочего места",
      текст: "Главный способ и самый частый случай: чужая система знает код кабинета и шлёт согласие туда. Код задаёте вы сами, он переживает замену планшета и не меняется при перенастройке. Ответ вернёт `deviceId` того планшета, который в итоге выбран, и `document` с кодом ушедшего документа. Код места берётся из `GET /api/ext/workstations`, поле `externalId`; в образце ниже уже стоит настоящий код этой установки.",
      метод: "POST", путь: "/api/ext/show-document",
      тело: {
        workstationExternalId: "{МЕСТО}",
        documentCode: "{ДОКУМЕНТ}",
        fields: {
          "ФИО": "Иванова Анна Петровна",
          "ДР": "01.01.1990",
          "Пол": "F",
          "email": "anna@example.by",
          "telephone": "+375291234567",
          "document": "MP1234567",
          "date": "20.08.2026",
          "Адрес регистрации": "г. Минск, ул. Ленина 1"
        }
      }
    },
    {
      id: "primer-device",
      заголовок: "То же самое, но прямо на планшет по его номеру",
      текст: "Запасной путь: чужая система хранит номера планшетов у себя. Номер берётся из `GET /api/ext/devices`, поле `deviceId`, вид номера `dev-811a68564e`; в образце ниже уже стоит настоящий номер этой установки. Помните, чем этот путь хуже: номер живёт вместе с железом, и после замены планшета заказ с прежним номером ответит 404 `device not found`, тогда как тот же заказ по коду места дойдёт.",
      метод: "POST", путь: "/api/ext/show-document",
      тело: {
        deviceId: "{ПЛАНШЕТ}",
        documentCode: "{ДОКУМЕНТ}",
        fields: { "ФИО": "Иванова Анна Петровна", "ДР": "01.01.1990", "Пол": "F" }
      }
    },
    {
      id: "primer-checkbox",
      заголовок: "Заказ со своим пунктом и условием показа",
      текст: "Пункт `consent` уже стоит в документе, ему задаётся только отметка. Пункт про рассылку прислан заказом: он встанет на странице с галочкой «Показывать здесь чекбоксы, присланные по API» и покажется только женщинам. Группа `transfer` отвечает на вопрос документа. Пример рассчитан на документ, в котором оператор всё это завёл: пункт `consent`, группу `transfer` и страницу с признаком «чекбоксы из API». В поставляемом документе `main` нет ни того, ни другого, ни третьего, поэтому на свежей установке пример ответит 200, а в `dropped` придут три строки: «пункт «consent» не показан: ни одна страница документа не принимает пункты из API...», то же про пункт «Согласен на рассылку» и «группы «transfer» в документе «main» нет». Это правильный ответ службы, а не поломка: она называет вслух всё, что не доехало до клиента.",
      метод: "POST", путь: "/api/ext/show-document",
      тело: {
        workstationExternalId: "{МЕСТО}",
        fields: { "ФИО": "Иванова Анна Петровна", "Пол": "F", "cross-border": true },
        checkboxes: [
          { key: "consent", checked: true },
          { label: "Согласен на рассылку", checked: false, required: false,
            visibleWhen: { field: "Пол", op: "eq", value: "F" } }
        ],
        groups: [
          { key: "transfer", selected: "deny", title: "Передача данных за границу",
            options: [{ key: "deny", label: "Запрещаю" }, { key: "allow", label: "Разрешаю" }] }
        ]
      }
    },
    {
      id: "primer-image",
      заголовок: "Заказ с картинкой",
      текст: "В документе стоит блок картинки с именем тега `ПЕЧАТЬ`. Здесь прислана точка 1x1 в PNG: годная картинка минимального размера, на ней видно, что тег сработал. Тега с таким именем в документе может не быть, тогда запрос примут, а в списке потерь будет сказано, что картинке некуда встать: «картинка «ПЕЧАТЬ» не показана: в документе «main» нет такого тега». В поставляемом документе `main` такого тега нет, так и выйдет.",
      метод: "POST", путь: "/api/ext/show-document",
      тело: {
        workstationExternalId: "{МЕСТО}",
        fields: { "ФИО": "Иванова Анна Петровна" },
        images: { "ПЕЧАТЬ": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }
      }
    },
    {
      id: "primer-slides",
      заголовок: "Вернуть планшет к рекламе",
      текст: "Этим заканчивается приём: данные подписанта стираются с планшета, экран возвращается к рекламе. Вызывать стоит всегда, даже если клиент подписал: подпись очищает сессию сама, а вот брошенный заказ иначе провисит до автовозврата.",
      метод: "POST", путь: "/api/ext/return-slides",
      тело: { workstationExternalId: "{МЕСТО}" }
    }
  ];

  /// Пример как строка curl: то же тело, тот же адрес.
  function апиПримерCurl(п) {
    return 'curl -X ' + п.метод + ' -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \''
      + JSON.stringify(п.тело, null, 2) + '\' \\\n  {BASE}' + п.путь;
  }

  API_РАЗДЕЛЫ.push({
    id: "api-samples", заголовок: "8. Полные рабочие примеры",
    строить: function (х) {
      х.appendChild(апиФраза("Примеры целые: их копируют и выполняют, ничего не дописывая, кроме ключа. Планшет, рабочее место и код документа в них уже настоящие, с этой установки: вкладка читает их запросами `GET /api/admin/devices`, `/api/admin/workstations` и `/api/admin/documents` при каждом открытии. Если вместо значения стоит `СНАЧАЛА_ЗАВЕДИТЕ_...`, значит такого здесь ещё нет, и завести его надо на названной вкладке."));
      х.appendChild(апиФраза("Кнопка «Отправить запрос» выполняет пример прямо отсюда, от имени вошедшего администратора. Это настоящая отправка: если на планшете сейчас подписывается человек, документ у него сменится. Тело, которое уйдёт, окно показывает до отправки, и если оно чем-то отличается от образца, окно говорит чем именно."));
      х.appendChild(апиПодзаголовок("Откуда взять то, что вкладка подставить не может"));
      х.appendChild(апиФраза("Эти значения либо секретные, либо зависят от того, что вы сейчас делаете, поэтому в образцах они остаются заглушками. Каждое берётся одним названным запросом."));
      х.appendChild(апиТаблица(["Заглушка в образцах", "Что это", "Откуда взять"], [
        ["`ВАШ_КЛЮЧ`", "ключ внешнего API", "вкладка «API-ключи», кнопка «Создать». Показывается один раз, при создании, и больше нигде: на сервере лежит только его SHA-256"],
        ["`КУКА`", "значение куки `sk_admin`", "заголовок `Set-Cookie` ответа `POST /api/admin/login` с паролем администратора. Её же видно в средствах разработчика браузера"],
        ["`ПАРОЛЬ`", "пароль администратора", "тот, которым вы входите в эту админку"],
        ["`ТОКЕН_ПЛАНШЕТА`", "токен планшета", "ответ `POST /api/kiosk/enroll` по коду активации, поле `token`. Живёт на самом планшете, у сервера его нет"],
        ["`ВЕРСИЯ_ИЗ_GET`", "версия текста документа", "заголовок `X-Doc-Rev` ответа `GET /api/admin/document`, вид `021C49C34054142A`"],
        ["`KEY_ID`", "номер ключа API", "`GET /api/admin/apikeys`, поле `id`, вид `key-929b66d5bd`"],
        ["`IMAGE_ID`", "номер картинки рекламы", "`GET /api/admin/images`, поле `id`, вид `fbd9e00d2525432a9fad437e040c730a`"],
        ["`SCAN_ID`", "номер считанного кода", "`GET /api/admin/scans`, поле `id`"],
        ["`SIGN_ID`", "номер записи подписи", "`GET /api/admin/signatures`, поле `id`"],
        ["`ALERT_ID`", "номер уведомления", "`GET /api/admin/alerts`, поле `alerts[].id`, вид `test:manual`"],
        ["`RULE_ID`", "номер правила расписания", "`GET /api/admin/schedule`, поле `rules[].id`"],
        ["`ИМЯ_ФАЙЛА`", "имя файла подписи внутри страницы", "`GET /api/admin/signatures/{id}`, поле `signatures[].file`"]
      ], "api-tbl-req"));
      х.appendChild(апиФраза("А вот это вкладка подставляет сама, и в образцах ниже стоит настоящее значение этой установки: номер планшета (`GET /api/ext/devices`, поле `deviceId`), код рабочего места (`GET /api/ext/workstations`, поле `externalId`), внутренний номер места (`GET /api/admin/workstations`, поле `id`), код документа (`GET /api/ext/documents`, поле `code`), внутренний номер документа (`GET /api/admin/documents`, поле `id`) и номер группы (`GET /api/admin/groups`, поле `id`)."));
      API_ПРИМЕРЫ.forEach(function (п) {
        var блок = el("div", "api-sample");
        блок.appendChild(el("h4", "api-h4", п.заголовок));
        блок.appendChild(апиФраза(п.текст));
        var образец = апиПримерCurl(п);
        блок.appendChild(апиОбразец(образец));
        блок.appendChild(апиДействия(образец, { метод: п.метод, путь: п.путь, тело: п.тело, заголовок: п.заголовок }));
        х.appendChild(блок);
      });
    }
  });

  API_РАЗДЕЛЫ.push({
    id: "api-mistakes", заголовок: "9. Частые ошибки и что они значат",
    строить: function (х) {
      х.appendChild(апиФраза("Список собран по тому, на чём спотыкаются чужие системы. Слева то, что видит интегратор, справа то, что надо поправить."));
      х.appendChild(апиТаблица(["Что видно", "Отчего это", "Что поправить"], [
        ["401 `invalid api key` на каждый запрос",
         "ключа нет в заголовке, он неверный, выключен или удалён. Текст один на все четыре случая",
         "проверьте заголовок `X-Api-Key` (именно заголовок, не строку запроса) и состояние ключа на вкладке «API-ключи»"],
        ["401 с пустым телом на `/api/admin/*`",
         "админское API не принимает ключ: оно ходит по куке входа",
         "для чужой системы нужен `/api/ext/*`. Админские пути существуют для самой админки"],
        ["400 «Тело запроса пустое, а этот запрос ждёт JSON»",
         "тело не отправлено или отправлено без `Content-Type`",
         "добавьте `Content-Type: application/json` и тело"],
        ["400 «Запрос не разобран»",
         "в строке запроса значение не того вида (`limit=abc`)",
         "проверьте виды значений в строке запроса"],
        ["400 или 415 с пустым телом ответа",
         "тело не разобралось как JSON, либо `Content-Type` не `application/json`. Эти два случая отвергает платформа до обработчика, и объяснить их своими словами нечем",
         "проверьте JSON целиком и заголовок `Content-Type`"],
        ["404 с пустым телом ответа",
         "такого адреса на сервере нет: опечатка в пути или лишняя косая черта",
         "сверьтесь со справочником ниже: там перечислен каждый путь"],
        ["400 `pass deviceId or workstationExternalId`",
         "в теле нет ни номера планшета, ни кода места. Так бывает, когда в шаблоне запроса поле осталось пустым",
         "пришлите одно из двух. Пустая строка не считается заполненным полем"],
        ["404 `workstation not found: WS-204`",
         "места с таким кодом в системе нет. Код сравнивается без учёта регистра и пробелов, значит дело не в написании",
         "заведите место `POST /api/ext/workstations` или возьмите список `GET /api/ext/workstations`"],
        ["409 `several tablets are assigned to this workstation`",
         "на месте несколько живых планшетов и на связи не один. Сервер не угадывает, кому показать документ",
         "пришлите `deviceId` одного из перечисленных в тексте отказа, либо разнесите планшеты по разным местам"],
        ["409 `deviceId and workstationExternalId disagree`",
         "прислали и номер планшета, и код места, а планшет стоит не там",
         "присылайте что-то одно. Обычно верен код места: планшет могли перевезти"],
        ["`ok: true`, а на планшете ничего не изменилось",
         "`shown: false`: планшет не на связи, документ сохранён и покажется при подключении",
         "смотрите `shown` и `note` в ответе, а не только `ok`"],
        ["документ показался, но части текста нет",
         "условие показа не выполнилось: тег не прислан, прислан пустым или в другом виде",
         "сверьтесь с `missingPlaceholders` в ответе и с видом значения (булев только `true` или `false`)"],
        ["в тексте видно `{{ФИО}}`",
         "тег документа не прислан вовсе. Так и задумано: пропуск должен быть виден, а не скрыт",
         "имя тега придёт в `missingPlaceholders` ответа, пришлите его"],
        ["клиент не увидел вопроса, который был в заказе",
         "группы с таким именем в документе нет, либо варианта нет в группе",
         "смотрите `dropped`: там названы и потеря, и имена, которые в документе есть"],
        ["400 «Тег «urine» принимает только true или false, получено: 1»",
         "булев тег прислан числом или словом",
         "пришлите `true`, `false` или те же слова строкой"],
        ["408 `timeout: код не был отсканирован`",
         "клиент не показал код за отведённое время, камера закрыта",
         "повторите запрос, при необходимости увеличьте `timeoutSec` (до 300)"],
        ["409 «На этот планшет пришла другая заявка на сканирование»",
         "две интеграции спорят за один планшет: новая заявка вытеснила вашу",
         "повторите, когда планшет освободится. Это не поломка камеры"],
        ["429 и `Retry-After`",
         "перебор частоты: 600 запросов в минуту с адреса на внешнее API",
         "повторите через `retryAfterSec` секунд, разнесите поток по времени"]
      ], "api-tbl-mistakes"));
    }
  });

  API_РАЗДЕЛЫ.push({
    id: "api-nearby", заголовок: "10. Что есть рядом, помимо запросов",
    строить: function (х) {
      х.appendChild(апиПодзаголовок("Прямая ссылка на наблюдение за экраном"));
      х.appendChild(апиФраза("`" + window.location.origin + "/admin/#watch=WS-204` это не метод API, а ссылка для оператора: она открывает наблюдение за экраном нужного планшета. Внешняя система может дать её оператору рядом со своим заказом, чтобы он не искал планшет в списке. Адресуется код рабочего места, имя планшета или его внутренний номер. Оператор должен быть уже вошедшим в админку."));
      х.appendChild(апиФраза("Окно только для просмотра: оттуда на планшет не уходит ничего, камера у оператора не открывается, запись не ведётся. Картинка не передаётся: документ берётся с сервера один раз, а планшет присылает только то, что меняется."));
      х.appendChild(апиПодзаголовок("Резервная копия шаблона"));
      х.appendChild(апиФраза("На вкладке «Документ» кнопки «Экспорт» и «Импорт» сохраняют все страницы в файл и восстанавливают их обратно. Импорт заводит НОВЫЙ документ, а не затирает открытый: файл шаблона это отдельный документ, а не замена всему. Перед правками полезно сделать экспорт."));
      х.appendChild(апиПодзаголовок("Журнал"));
      х.appendChild(апиФраза("Вкладка «Логи» показывает сбои сервиса и планшетов: ошибки отправки подписи, отказ камеры, сбои сборки PDF, перезапуски сервиса. Записи хранятся на сервере и переживают перезапуск. Планшет сообщает о своих бедах сам, запросом `POST /api/log`."));
      х.appendChild(апиПодзаголовок("Управление планшетами по локальной сети"));
      х.appendChild(апиФраза("Приложение FreeKiosk на планшете принимает команды по своему адресу в локальной сети (по умолчанию порт 8080). Включите управление на вкладке «Планшеты», и на карточке планшета появится кнопка «Управление»: обновить страницу, очистить кэш, перезапустить приложение, перезагрузить планшет, включить или выключить экран, яркость, звуковой сигнал, произнести текст, показать сообщение, снимок экрана."));
      х.appendChild(апиФраза("Сервер сам опрашивает планшеты каждые 5 минут и предупреждает о низком заряде и нехватке места, а при включённом автолечении поднимает зависший планшет: сначала перезапуском приложения, затем перезагрузкой. Если планшет не вернулся и после этого, автолечение останавливается и оператор получает уведомление, что планшет требует осмотра."));
      х.appendChild(апиФраза("Перезагрузка планшета и надёжное выключение экрана работают, когда FreeKiosk назначен владельцем устройства (Device Owner). Это делается один раз при настройке планшета: на чистом устройстве, без добавленных аккаунтов Google, командой `adb shell dpm set-device-owner com.freekiosk/.DeviceAdminReceiver`. В том же режиме FreeKiosk блокирует кнопки «Домой» и «Недавние» и шторку уведомлений, поэтому клиент не может выйти из киоска."));
      х.appendChild(апиФраза("Те же действия умеет расписание: правило на время и дни недели, с оговоркой «не трогать планшет, на котором сейчас открыт документ». Правила живут на вкладке «Планшеты»."));
    }
  });

  // ==================================================================
  // Справочник: каждый путь, который обслуживает сервер
  // ==================================================================
  // Группы совпадают с тем, как пути разложены в Program.cs: сначала внешнее API, потом админское
  // по разделам, потом то, что живёт вне обеих групп. Порядок внутри группы тот же, что в коде,
  // чтобы сверять было по чему.

  // Что верно для каждого пути раздела, независимо от того, какой это путь. Печатается перед
  // статьями группы, поэтому новая группа получает это даром и не может остаться без объяснения.
  var ОБЩЕЕ_ДЛЯ_ГРУППЫ = {
    ext: "Доступ по ключу в заголовке `X-Api-Key`, и `ВАШ_КЛЮЧ` в образцах ниже это он. Ключ заводится на вкладке «API-ключи» кнопкой «Создать» и показывается там один раз, при создании: на сервере лежит только его SHA-256, не записали, заводите новый. Неверный, отсутствующий, выключенный и удалённый ключ дают одинаковое `401` `{\"error\":\"invalid api key\"}`, поэтому по ответу нельзя понять, какой из четырёх случаев ваш. Вошедший в админку администратор проходит и без ключа, поэтому примеры отсюда работают прямо из браузера.",
    admin: "Пути этой группы требуют куку входа `sk_admin`: без неё `401` с пустым телом. Куку выдаёт `POST /api/admin/login` с паролем администратора, её значение стоит в заголовке `Set-Cookie` ответа и подставляется вместо `КУКА` в образцах ниже; её же видно в средствах разработчика браузера. Скопированный дословно образец, в котором `КУКА` не заменена, отвечает `401` с пустым телом. Частота на путях этой группы не ограничена: за ними уже стоит проверка куки. Сам вход в эту группу не входит, куки не требует и ограничен 10 попытками в минуту с адреса. Куки не требуют и `POST /api/admin/logout` с `GET /api/admin/me`: они описаны в группе «Вне обеих групп».",
    планшет: "Доступ по токену планшета в заголовке `Authorization: Bearer`. Токен выдаётся один раз, в ответе `POST /api/kiosk/enroll` по коду активации, и живёт на самом планшете: у сервера лежит только его хэш, поэтому `ТОКЕН_ПЛАНШЕТА` в образцах взять из админки нельзя."
  };

  var API_ГРУППЫ = [
    { id: "ref-ext", заголовок: "Внешнее API: /api/ext", общие: "ext",
      note: "Ограничение 600 запросов в минуту с одного адреса. Адресат везде задаётся одинаково: главный способ это `workstationExternalId`, код рабочего места, а `deviceId` запасной." },
    { id: "ref-adm-devices", заголовок: "Админка: планшеты", общие: "admin",
      note: "Заглушка `DEVICE_ID` в адресах этой группы это поле `id` из `GET /api/admin/devices`, вид номера `dev-24386a4b78`. В образцах ниже стоит настоящий номер планшета этой установки; `СНАЧАЛА_ЗАВЕДИТЕ_ПЛАНШЕТ_НА_ВКЛАДКЕ_ПЛАНШЕТЫ` означает, что планшетов здесь пока нет." },
    { id: "ref-adm-control", заголовок: "Админка: управление планшетами по локальной сети", общие: "admin",
      note: "Каждый вызов идёт с сервера на планшет, поэтому работает, только пока планшеты доступны по сети. Неудача здесь никогда не влияет на подписание: о ней сообщается, и только. Прежде чем хоть один образец ниже доедет до планшета, нужны два шага, и оба делаются здесь же. Первый: включить управление, `PUT /api/admin/kiosk-control/settings` с полем `enabled` в значении `true`. На свежей установке оно выключено, и без него каждая команда отвечает 502 «Управление планшетами выключено в настройках.», а `kiosk/health` отвечает 200 с `reachable:false` и тем же текстом в `error`. Второй: задать адрес планшета в локальной сети, `PUT /api/admin/devices/{id}/control-address`. Адрес `192.168.1.50` в образце это пример, а не адрес вашего планшета; пока адреса нет, команда отвечает 502 «Адрес планшета неизвестен. Укажите его в карточке планшета.»" },
    { id: "ref-adm-catalog", заголовок: "Админка: группы, места, ключи", общие: "admin" },
    { id: "ref-adm-slides", заголовок: "Админка: реклама и плейлист", общие: "admin" },
    { id: "ref-adm-docs", заголовок: "Админка: документы", общие: "admin" },
    { id: "ref-adm-show", заголовок: "Админка: показ и сканирование", общие: "admin" },
    { id: "ref-adm-sign", заголовок: "Админка: подписи", общие: "admin" },
    { id: "ref-adm-schedule", заголовок: "Админка: расписание", общие: "admin" },
    { id: "ref-adm-alerts", заголовок: "Админка: уведомления и журнал", общие: "admin" },
    { id: "ref-open", заголовок: "Вне обеих групп: вход, планшет, проверка живости", общие: "нет",
      note: "Здесь у каждого пути свой доступ, и он назван в статье. `ТОКЕН_ПЛАНШЕТА` в образцах это токен из ответа `POST /api/kiosk/enroll` по коду активации: он живёт на самом планшете, у сервера лежит только его хэш, и взять его из админки нельзя. `ПАРОЛЬ` это пароль администратора, тот же, которым вы входите в эту админку." }
  ];

  // Отказы выбора адресата: они одинаковы у всех путей внешнего API, которые обращаются к
  // одному планшету. Пересказывать их в каждой статье значило бы разойтись с кодом.
  var API_ОТКАЗЫ_АДРЕСАТ = [
    ["400", "`pass deviceId or workstationExternalId`, если не прислано ни то, ни другое"],
    ["404", "`device not found`, если планшета с таким `deviceId` нет"],
    ["404", "`this tablet is revoked`, если планшет отозван"],
    ["404", "`workstation not found: WS-204`, если места с таким кодом нет"],
    ["404", "`no tablet is assigned to this workstation`, если на месте нет планшетов"],
    ["404", "`the only tablet(s) assigned to this workstation are revoked`, если на месте только отозванные"],
    ["409", "`deviceId and workstationExternalId disagree: tablet '...' is not at workstation '...'. Pass one of them, not both.`"],
    ["409", "`several tablets are assigned to this workstation; pass deviceId to choose one:` и перечень имён, номеров и состояния связи"]
  ];
  // Адресат везде один и тот же, и порядок в этой таблице не случаен: код рабочего места идёт
  // первым, потому что это главный способ. Код задаёт сам заказчик, он переживает замену
  // планшета. Номер планшета живёт вместе с железом и потому запасной.
  var API_ЦЕЛЬ_ПОЛЯ = [
    ["`workstationExternalId`", "строка", "код рабочего места, который задали вы сами. Главный способ адресации. Берётся из `GET /api/ext/workstations`, поле `externalId`; своё место заводится запросом `POST /api/ext/workstations`. Сравнивается без учёта регистра и окружающих пробелов. Присланный числом (`\"workstationExternalId\": 1232`) принимается и читается как строка `\"1232\"`: числовые коды кабинетов это обычное дело. `WS-204` в образцах это пример из чужой установки: пока места с таким кодом нет, запрос ответит 404 `workstation not found: WS-204`"],
    ["`deviceId`", "строка", "внутренний номер планшета, вид `dev-811a68564e`. Запасной способ: номер живёт вместе с железом. Берётся из `GET /api/ext/devices`, поле `deviceId`"]
  ];

  // ПРАВИЛО ДЛЯ ТОГО, КТО БУДЕТ ПРАВИТЬ ЭТОТ СПИСОК ПОСЛЕ НАС.
  //
  // Каждая заглушка в образце обязана быть объяснена в той же статье, где стоит. Объяснение
  // состоит из трёх частей: чем является значение, каким запросом его получить (путь и поле), и
  // что ответит служба, если подставить заглушку буквально. Ссылка на другой раздел объяснением
  // не считается: человек открыл статью, а не оглавление. Заглушка без объяснения в статье это
  // ошибка того же веса, что неверный код ответа.
  //
  // Метки `{ПЛАНШЕТ}`, `{МЕСТО}`, `{МЕСТО_ID}`, `{ДОКУМЕНТ}`, `{ДОКУМЕНТ_ID}` и `{ГРУППА}` в
  // поле `s` заменяются настоящими значениями этой установки (см. апиОбновитьЗначения). Ставьте
  // их везде, где значение можно взять с сервера, и не выдумывайте образцовых номеров: выдуманный
  // номер даёт 404, и читатель решает, что сломано API.
  //
  // Поле `о` это настоящий ответ, снятый прогоном, а не сочинённый. Пусто у путей, которые
  // ничего не читают, и у тех, чей ответ это файл.
  var API_ПУТИ = [
    // ---------------------------------------------------------------- внешнее API
    {
      g: "ref-ext", m: "GET", p: "/api/ext/devices", who: "Ключ API",
      d: "Все планшеты системы: состояние связи, группы и рабочее место. С этого запроса удобно начинать: он ничего не меняет и сразу показывает, годится ключ или нет.",
      req: null,
      res: [
        ["`deviceId`", "внутренний номер планшета"],
        ["`name`", "имя, которое видит оператор"],
        ["`status`", "`active` или `revoked`"],
        ["`online`", "на связи ли планшет прямо сейчас"],
        ["`lastSeenUtc`", "когда его видели в последний раз, UTC"],
        ["`lastIp`", "у подключённого планшета адрес его живого соединения, у остальных последний известный"],
        ["`groups`", "имена групп, в которых он состоит"],
        ["`workstation`", "рабочее место: `id`, `externalId`, `name`, `location`, либо `null`"]
      ],
      fail: [],
      о: '[\n  {\n    "deviceId": "dev-bc4c069639",\n    "name": "Ресепшн 1",\n    "status": "active",\n    "online": true,\n    "lastSeenUtc": "2026-08-25T10:57:25.0274887Z",\n    "lastIp": "127.0.0.1",\n    "groups": ["Регистратура"],\n    "workstation": {\n      "id": "ws-3d55b0ab64", "externalId": "KAB-12",\n      "name": "Кабинет 12", "location": "1 этаж"\n    }\n  }\n]',
      s: 'curl -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  {BASE}/api/ext/devices', try: true
    },
    {
      g: "ref-ext", m: "GET", p: "/api/ext/documents", who: "Ключ API",
      d: "Какие документы есть в библиотеке и какими кодами они адресуются. Без этого коды живут в переписке и ломаются при первом же переименовании.",
      req: null,
      res: [
        ["`code`", "код, которым документ адресуется в `documentCode`"],
        ["`name`", "название документа"],
        ["`isDefault`", "показывается ли он, когда код не прислали"]
      ],
      fail: [],
      о: '[\n  { "code": "main", "name": "Согласие на обработку персональных данных", "isDefault": true }\n]',
      s: 'curl -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  {BASE}/api/ext/documents', try: true
    },
    {
      g: "ref-ext", m: "GET", p: "/api/ext/workstations", who: "Ключ API",
      d: "Рабочие места с их кодами. Код это то, чем внешняя система адресует кабинет.",
      req: null,
      res: [["`id`", "внутренний номер места"], ["`externalId`", "код места, заданный вами"],
            ["`name`", "название"], ["`location`", "пояснение, где это"]],
      fail: [],
      о: '[\n  { "id": "ws-3d55b0ab64", "externalId": "KAB-12", "name": "Кабинет 12", "location": "1 этаж" }\n]',
      s: 'curl -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  {BASE}/api/ext/workstations', try: true
    },
    {
      g: "ref-ext", m: "POST", p: "/api/ext/workstations", who: "Ключ API",
      d: "Завести рабочее место. Отсюда и берётся код, которым потом адресуется каждый заказ: `WS-204` в образце ниже это пример, подставьте свой, любую строку, принятую у вас. Что уже заведено, отвечает `GET /api/ext/workstations`. Запрос идемпотентен по коду: повторный запрос с тем же `externalId` возвращает уже существующее место, а не заводит второе. Медсистема обычно шлёт «создай, если нет» на каждый заказ, и без этого копились места с одинаковым кодом, а планшет, привязанный ко второму такому месту, становился недостижим.",
      req: [
        ["`externalId`", "строка", "код места в вашей системе. Необязателен, но без него идемпотентности нет. Код, присланный числом (`\"externalId\": 1232`), принимается и сохраняется своим же написанием, строкой `\"1232\"`: числовые коды кабинетов это обычное дело, и раньше такой запрос отвергался платформой с 400 и пустым телом"],
        ["`name`", "строка", "название. Без него место называется «Рабочее место»"],
        ["`location`", "строка", "пояснение, где это"]
      ],
      res: [["`id`", "внутренний номер, вид `ws-3d55b0ab64`. Им адресуется админское API"], ["`externalId`", "код, которым место адресуется во внешнем API"], ["`name`", "название"], ["`location`", "пояснение"]],
      fail: [],
      о: '{ "id": "ws-3d55b0ab64", "externalId": "WS-204", "name": "Касса 4", "location": "1 этаж" }',
      s: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"externalId":"WS-204","name":"Касса 4","location":"1 этаж"}\' \\\n  {BASE}/api/ext/workstations',
      try: { тело: { externalId: "WS-204", name: "Касса 4", location: "1 этаж" } }
    },
    {
      g: "ref-ext", m: "POST", p: "/api/ext/enrollments", who: "Ключ API",
      d: "Код активации нового планшета. Код вводится на самом планшете один раз, после чего планшет получает свой токен. Можно сразу привязать планшет к месту: код места берётся из `GET /api/ext/workstations`, поле `externalId`, и в образце ниже уже стоит настоящий код этой установки. В отличие от админского `POST /api/admin/devices/enroll`, здесь код места проверяется: на незнакомый приходит 404.",
      req: [
        ["`name`", "строка", "имя будущего планшета"],
        ["`workstationExternalId`", "строка", "код места, к которому его привязать: `GET /api/ext/workstations`, поле `externalId`. Необязателен. Проверяется, и незнакомый код это 404"]
      ],
      res: [["`code`", "код активации, вид `2WXQ-YPNQ`. Его вводят на самом планшете"], ["`expiresUtc`", "до какого момента он годен. Срок жизни 60 минут"]],
      fail: [["404", "«Рабочего места с кодом «...» нет (workstationExternalId). Заведите его запросом POST /api/ext/workstations.»"]],
      о: '{ "code": "2WXQ-YPNQ", "expiresUtc": "2026-08-25T11:49:08.6306909Z" }',
      s: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"Ресепшн 1","workstationExternalId":"{МЕСТО}"}\' \\\n  {BASE}/api/ext/enrollments',
      try: { тело: { name: "Ресепшн 1" } }
    },
    {
      g: "ref-ext", m: "PUT", p: "/api/ext/devices/{id}/workstation", who: "Ключ API",
      d: "Привязать планшет к рабочему месту по коду места. В адресе стоит внутренний номер планшета: он берётся из `GET /api/ext/devices`, поле `deviceId`, вид номера `dev-811a68564e`, и в образце ниже уже стоит настоящий номер этой установки. Код места берётся из `GET /api/ext/workstations`, поле `externalId`. Заглушки, подставленные как есть, отвечают 404: «Планшета «DEVICE_ID» в системе нет (deviceId).» и «Рабочего места с кодом «WS-204» нет (workstationExternalId). Заведите его запросом POST /api/ext/workstations.» Пустой код здесь не принимается намеренно: раньше такой запрос молча отвязывал планшет и отвечал «ок», а внешняя система, забывшая подставить код в шаблон запроса, узнавала об этом только тогда, когда документ переставал находить планшет в кабинете. Отвязка это отдельное, названное вслух действие.",
      req: [["`externalId`", "строка", "код рабочего места из `GET /api/ext/workstations`, поле `externalId`. Пустой не принимается: отвязка это отдельный запрос DELETE"]],
      res: [["`ok`", "`true`"], ["`deviceId`", "номер планшета"], ["`workstationExternalId`", "код места"]],
      fail: [
        ["400", "«Не задан externalId рабочего места. Чтобы отвязать планшет от места, вызовите DELETE /api/ext/devices/{id}/workstation.»"],
        ["404", "«Планшета «...» в системе нет (deviceId).»"],
        ["404", "«Рабочего места с кодом «...» нет (workstationExternalId). Заведите его запросом POST /api/ext/workstations.»"]
      ],
      о: '{ "ok": true, "deviceId": "dev-bc4c069639", "workstationExternalId": "KAB-12" }',
      s: 'curl -X PUT -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"externalId":"{МЕСТО}"}\' \\\n  {BASE}/api/ext/devices/{ПЛАНШЕТ}/workstation'
    },
    {
      g: "ref-ext", m: "DELETE", p: "/api/ext/devices/{id}/workstation", who: "Ключ API",
      d: "Отвязать планшет от рабочего места. Отдельный вызов, а не пустое поле в запросе выше: отвязка должна быть названа вслух, иначе она случается по недосмотру. В адресе внутренний номер планшета из `GET /api/ext/devices`, поле `deviceId`, вид `dev-811a68564e`; в образце ниже стоит настоящий номер этой установки. Заглушка `DEVICE_ID`, подставленная как есть, отвечает 404 «Планшета «DEVICE_ID» в системе нет (deviceId).»",
      req: null,
      res: [["`ok`", "`true`"], ["`deviceId`", "номер планшета"], ["`workstationExternalId`", "`null`: места у планшета больше нет"]],
      fail: [["404", "«Планшета «...» в системе нет (deviceId).»"]],
      о: '{ "ok": true, "deviceId": "dev-bc4c069639", "workstationExternalId": null }',
      s: 'curl -X DELETE -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  {BASE}/api/ext/devices/{ПЛАНШЕТ}/workstation'
    },
    {
      g: "ref-ext", m: "POST", p: "/api/ext/show-document", who: "Ключ API",
      d: "Показать документ на одном планшете с данными подписанта. Это главный запрос всего API. Адресат задаётся кодом рабочего места (главный способ) или номером планшета (запасной), и достаточно одного из двух: оба поля описаны в первых строках таблицы ниже. Присланные пункты (те, у которых `key` не совпал ни с одним пунктом документа) показываются только на странице с признаком «чекбоксы из API». Нет такой страницы, значит пункта не будет, и он назван в `dropped`. Подробный разбор полей в разделах 2 по 7 руководства выше.",
      req: API_ЦЕЛЬ_ПОЛЯ.concat([
        ["`documentCode`", "строка", "код документа из библиотеки. Какие коды есть на этой установке, отвечает `GET /api/ext/documents`, поле `code`. Без кода берётся документ по умолчанию, на незнакомый код придёт 400 с перечнем доступных. `SOGLASIE` в чужих образцах это пример: в поставляемой установке такого кода нет, там один документ `main`"],
        ["`fields`", "объект", "значения тегов. Не больше 100 тегов, имя до 200 знаков, значение до 4000 знаков"],
        ["`checkboxes`", "массив", "пункты согласия: `key`, `label`, `labelAppend`, `required`, `checked`, `visibleWhen`. Не больше 100 присланных пунктов, текст до 2000 знаков"],
        ["`groups`", "массив", "выбор в группах: `key`, `selected`, `title`, `titleAppend`, `options[]`. Не больше 100 групп, по 100 вариантов, текст до 2000 знаков"],
        ["`images`", "объект", "картинки заказа: «имя тега: BASE64». Не больше 8 картинок, до 2 МБ каждая в BASE64"]
      ]),
      res: [
        ["`ok`", "`true`, заказ принят и адресат выбран однозначно"],
        ["`deviceId`", "на какой планшет ушёл документ"],
        ["`document`", "код показанного документа"],
        ["`missingPlaceholders`", "теги документа, которых в запросе не было вовсе"],
        ["`emptyPlaceholders`", "теги документа, которые вы прислали пустыми: в тексте останется дыра, а условие на них погаснет. Показ не отменяется, пустое могли прислать умышленно. Присланный пустым тег, которого в документе нет, не попадает никуда"],
        ["`placed`", "куда встал каждый присланный пункт: «пункт «Согласен на рассылку» добавлен на страницу «Согласия»». Пустой, если присланных пунктов не было"],
        ["`shown`", "виден ли документ прямо сейчас"],
        ["`deviceOnline`", "то же значение: был ли планшет на связи в момент запроса"],
        ["`note`", "пояснение к `shown: false`, готовое к показу оператору. Иначе `null`"],
        ["`dropped`", "список потерь. Пустой означает «доехало всё»"]
      ],
      fail: [
        ["400", "«Тег «urine» принимает только true или false, получено: 1»"],
        ["400", "«Документ с кодом «X» не найден. Доступные коды: ...»"],
        ["400", "«Тег «ДР» используется в условии по возрасту, но значение «...» не похоже на дату рождения. Подойдёт 01.01.1990 или 1990-01-01.»"],
        ["400", "«Тег «date» используется в условии по сроку, но значение «...» не похоже на дату. Подойдёт 01.01.1990 или 1990-01-01.»"],
        ["400", "«В документе «...» нет ни одной страницы: показывать нечего.»"],
        ["400", "«Слишком много картинок в одном запросе: не больше 8.»"],
        ["400", "«У картинки не задано имя тега: непонятно, куда её ставить.»"],
        ["400", "«Картинка «ПЕЧАТЬ» пришла пустой.»"],
        ["400", "«Картинка «ПЕЧАТЬ» слишком большая: не больше двух мегабайт в BASE64.»"],
        ["400", "«Картинка «ПЕЧАТЬ» это не BASE64.»"],
        ["400", "«Картинка «ПЕЧАТЬ» не PNG, не JPG и не BMP. Другие виды нельзя вложить в PDF, и подписанный документ не совпал бы с тем, что видел клиент.»"]
      ].concat(API_ОТКАЗЫ_АДРЕСАТ),
      о: '{\n  "ok": true,\n  "deviceId": "dev-bc4c069639",\n  "document": "main",\n  "missingPlaceholders": [],\n  "placed": [],\n  "emptyPlaceholders": [],\n  "shown": true,\n  "deviceOnline": true,\n  "dropped": [],\n  "note": null\n}',
      s: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"{МЕСТО}","documentCode":"{ДОКУМЕНТ}",\n       "fields":{"ФИО":"Иванова Анна","ДР":"01.01.1990","Пол":"F",\n                 "email":"a@example.by","telephone":"+375291234567",\n                 "document":"MP1234567","date":"20.08.2026",\n                 "cross-border":true,"urine":true,"UG":false,\n                 "Адрес регистрации":"г. Минск, ул. Ленина 1","text1":"доп. текст"},\n       "checkboxes":[{"key":"consent","checked":true},\n                     {"key":"golod","labelAppend":"(с 22:00)"},\n                     {"label":"Согласен на рассылку","checked":false,"required":false}],\n       "groups":[{"key":"transfer","selected":"deny","title":"Передача данных",\n                  "options":[{"key":"deny","label":"Запрещаю"}]}],\n       "images":{"ПЕЧАТЬ":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}}\' \\\n  {BASE}/api/ext/show-document',
      try: { тело: { workstationExternalId: "{МЕСТО}", fields: { "ФИО": "Иванова Анна Петровна", "ДР": "01.01.1990", "Пол": "F" } } }
    },
    {
      g: "ref-ext", m: "POST", p: "/api/ext/scan-request", who: "Ключ API",
      d: "Попросить планшет отсканировать штрихкод или QR и ДОЖДАТЬСЯ результата: на планшете открывается камера, клиент показывает код, код возвращается в этом же ответе и сохраняется в списке. Поддерживаются QR, Data Matrix, EAN-13, EAN-8, Code-128 и ITF (только цифры и только чётное их количество).",
      req: API_ЦЕЛЬ_ПОЛЯ.concat([
        ["`timeoutSec`", "число", "сколько ждать. По умолчанию 60, не меньше 5 и не больше 300. Значение вне предела приводится к нему. Сам планшет не снимает дольше 90 секунд подряд без результата, поэтому ожидание длиннее полутора минут почти наверняка кончится таймаутом, а не кодом"]
      ]),
      res: [["`ok`", "`true`"], ["`deviceId`", "какой планшет сканировал"], ["`code`", "считанное значение"],
            ["`format`", "вид кода: `QR_CODE`, `EAN_13`, `CODE_128` и прочие"],
            ["`scanId`", "номер записи в списке считанных"], ["`createdUtc`", "когда считали, UTC"]],
      fail: [
        ["409", "`{\"error\":\"Планшет «...» сейчас не на связи, команда сканирования до него не дойдёт.\",\"deviceId\":\"...\"}`. Поля `ok` в этом ответе нет. Приходит сразу, а не после таймаута: команда живёт только в момент отправки"],
        ["409", "`{\"ok\":false,\"deviceId\":\"...\",\"error\":\"На этот планшет пришла другая заявка на сканирование, ваша снята. Повторите запрос, когда планшет освободится.\"}`"],
        ["409", "`{\"ok\":false,\"deviceId\":\"...\",\"error\":\"Сканирование отменено.\"}`, если заявку сняли запросом `scan-cancel`"],
        ["408", "`{\"ok\":false,\"deviceId\":\"...\",\"error\":\"timeout: код не был отсканирован\"}`. Камера на планшете закрывается, если её больше никто не ждёт"]
      ].concat(API_ОТКАЗЫ_АДРЕСАТ),
      о: '{\n  "ok": true,\n  "deviceId": "dev-bc4c069639",\n  "code": "4600000000001",\n  "format": "EAN_13",\n  "scanId": "20260825-105725-708-D1D572",\n  "createdUtc": "2026-08-25T10:57:25.7088579Z"\n}',
      s: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"{МЕСТО}","timeoutSec":60}\' \\\n  {BASE}/api/ext/scan-request'
    },
    {
      g: "ref-ext", m: "POST", p: "/api/ext/scan-cancel", who: "Ключ API",
      d: "Отменить сканирование и вернуть планшет к обычному экрану. Ожидающая заявка `scan-request` будится сразу и получает 409: раньше она висела до своего таймаута, все эти минуты считалась живой и не давала закрыть камеру даже чужому таймауту.",
      req: API_ЦЕЛЬ_ПОЛЯ,
      res: [["`ok`", "`true`"], ["`deviceId`", "номер планшета"],
            ["`cancelledWaiter`", "была ли разбужена ожидающая заявка"]],
      fail: [].concat(API_ОТКАЗЫ_АДРЕСАТ),
      о: '{ "ok": true, "deviceId": "dev-bc4c069639", "cancelledWaiter": true }',
      s: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"{МЕСТО}"}\' \\\n  {BASE}/api/ext/scan-cancel',
      try: { тело: { workstationExternalId: "{МЕСТО}" } }
    },
    {
      g: "ref-ext", m: "GET", p: "/api/ext/scans", who: "Ключ API",
      d: "Последние считанные коды, новые сверху. Подходит, если удобнее опрашивать список, а не ждать ответа `scan-request`.",
      req: [["`limit`", "число в строке запроса", "сколько записей вернуть. По умолчанию 50, не меньше 1 и не больше 500"]],
      res: [["`id`", "номер записи"], ["`createdUtc`", "когда считали, UTC"], ["`code`", "значение кода"],
            ["`format`", "вид кода"], ["`deviceId`", "номер планшета"], ["`deviceName`", "имя планшета"],
            ["`workstationId`", "номер места"], ["`workstationName`", "название места"]],
      fail: [],
      о: '[\n  {\n    "id": "20260825-105725-708-D1D572",\n    "createdUtc": "2026-08-25T10:57:25.7088579Z",\n    "code": "4600000000001",\n    "format": "EAN_13",\n    "deviceId": "dev-bc4c069639",\n    "deviceName": "Ресепшн 1",\n    "workstationId": "ws-3d55b0ab64",\n    "workstationName": "Кабинет 12"\n  }\n]',
      s: 'curl -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  "{BASE}/api/ext/scans?limit=20"',
      try: { путь: "/api/ext/scans?limit=20" }
    },
    {
      g: "ref-ext", m: "POST", p: "/api/ext/return-slides", who: "Ключ API",
      d: "Вернуть планшет к рекламе и стереть данные подписанта. Этим заканчивается приём. Отозванный и удалённый планшет адресатом быть не может: на отозванный приходит 404 `this tablet is revoked`, на удалённый и на неизвестный 404 `device not found`. Показывать на них нечего, а запись состояния для планшета, которого в системе нет, завела бы данные о нём заново.",
      req: API_ЦЕЛЬ_ПОЛЯ,
      res: [["`ok`", "`true`"], ["`deviceId`", "номер планшета, который вернулся к рекламе"]],
      fail: [].concat(API_ОТКАЗЫ_АДРЕСАТ),
      о: '{ "ok": true, "deviceId": "dev-bc4c069639" }',
      s: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"{МЕСТО}"}\' \\\n  {BASE}/api/ext/return-slides',
      try: { тело: { workstationExternalId: "{МЕСТО}" } }
    },
    // ---------------------------------------------------------------- админка: планшеты
    {
      g: "ref-adm-devices", m: "GET", p: "/api/admin/devices", who: "Кука админа",
      d: "Список планшетов для админки, по имени. Состояние читается один раз на весь список: при двухстах планшетах чтение на каждый означало бы двести разборов одного и того же файла на каждое событие сети.",
      req: null,
      res: [
        ["`id`, `name`, `status`", "номер, имя, `active` или `revoked`"],
        ["`groupIds`, `groups`", "номера групп и их имена"],
        ["`workstationId`, `workstationName`, `workstation`", "рабочее место: номер, название и объект `externalId`, `name`, `location`"],
        ["`online`, `lastSeenUtc`, `lastIp`", "состояние связи и адрес"],
        ["`controlIp`, `controlPort`", "адрес управления по локальной сети, если задан вручную"],
        ["`health`", "последнее показание планшета: заряд, место, Wi-Fi. `null`, если не опрашивали"],
        ["`appVersion`", "сборка страницы киоска, которую планшет сейчас держит. Пусто у планшета не на связи, потому что сборку сообщает живое соединение, и пусто у планшета на старой странице, которая её не сообщает вовсе. Сверять её есть с чем: `GET /api/admin/page-version` отдаёт сборку, которую этот сервер раздаёт"],
        ["`screenWidth`, `screenHeight`, `screenPixelRatio`", "размер экрана планшета в точках и плотность, как их сообщила его собственная страница. Отдаётся и для планшета не на связи: по этим числам окно наблюдения открывается ещё до первого кадра. `null` у планшета на старой странице, которая размер не сообщает, и это «неизвестно», а не ноль"],
        ["`screen`", "что на экране: `slides` или `document`"],
        ["`enrolledUtc`", "когда планшет активировали"]
      ],
      fail: [],
      о: '[\n  {\n    "id": "dev-bc4c069639",\n    "name": "Ресепшн 1",\n    "status": "active",\n    "groupIds": ["grp-e3917d25a6"],\n    "groups": ["Регистратура"],\n    "workstationId": "ws-3d55b0ab64",\n    "workstationName": "Кабинет 12",\n    "workstation": { "externalId": "KAB-12", "name": "Кабинет 12", "location": "1 этаж" },\n    "online": true,\n    "lastSeenUtc": "2026-08-25T10:57:25.0274887Z",\n    "lastIp": "127.0.0.1",\n    "controlIp": null,\n    "controlPort": null,\n    "health": null,\n    "appVersion": null,\n    "screenWidth": null,\n    "screenHeight": null,\n    "screenPixelRatio": null,\n    "screen": "slides",\n    "enrolledUtc": "2026-08-25T10:57:24.9124359Z"\n  }\n]',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/devices', try: true
    },
    {
      g: "ref-adm-devices", m: "GET", p: "/api/admin/page-version", who: "Кука админа",
      d: "Сборка страницы киоска, которую сейчас отдаёт этот сервер. Админка сверяет с ней то, что планшеты сообщают о себе в поле `appVersion`, и по расхождению говорит «планшет держит старую страницу». Номер живёт ровно в одном месте, в самой странице, поэтому копии разойтись не могут. Кука для образца берётся из заголовка `Set-Cookie` ответа `POST /api/admin/login`; без куки этот путь отвечает 401 с пустым телом.",
      req: null,
      res: [["`version`", "номер сборки, например `7.4`. `null`, если файл страницы прочитать не удалось: тогда админка не обвиняет никого, недоказанное обвинение хуже молчания"]],
      fail: [], о: '{ "version": "7.4" }',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/page-version', try: true
    },
    {
      g: "ref-adm-devices", m: "POST", p: "/api/admin/devices/enroll", who: "Кука админа",
      d: "Код активации нового планшета. То же, что внешнее `POST /api/ext/enrollments`, только место и группы задаются внутренними номерами, а срок жизни кода можно задать. Ни номер места, ни номера групп здесь не проверяются: неизвестный номер принимается с ответом 200 и оставляет планшет без места и без групп. Проверку делает только внешний `POST /api/ext/enrollments`: он адресуется кодом места и на неизвестный код отвечает 404.",
      req: [["`name`", "строка", "имя будущего планшета"],
            ["`workstationId`", "строка", "внутренний номер места, поле `id` из `GET /api/admin/workstations`, вид `ws-3d55b0ab64`. Не проверяется: выдуманный номер принимается, и планшет заводится без места"],
            ["`groupIds`", "массив строк", "номера групп, поле `id` из `GET /api/admin/groups`, вид `grp-e3917d25a6`. Не проверяются: выдуманные номера принимаются и просто не дают имён групп"],
            ["`ttlMinutes`", "число", "срок жизни кода в минутах. По умолчанию 60"]],
      res: [["`code`", "код активации, вид `3HV6-NWKY`. Его вводят на самом планшете"], ["`expiresUtc`", "до какого момента годен"],
            ["`name`, `workstationId`, `groupIds`", "то, что запомнено за кодом"]],
      fail: [["400", "тела нет вовсе или это не JSON: пустой ответ без текста. Пришлите заголовок `Content-Type: application/json` и тело, хотя бы `{}`"]],
      о: '{\n  "code": "3HV6-NWKY",\n  "expiresUtc": "2026-08-25T11:49:08.4780528Z",\n  "name": "Ресепшн 1",\n  "workstationId": "ws-f1370c53dd",\n  "groupIds": ["grp-80917b5781"]\n}',
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"Ресепшн 1","workstationId":"{МЕСТО_ID}","ttlMinutes":60}\' \\\n  {BASE}/api/admin/devices/enroll'
    },
    {
      g: "ref-adm-devices", m: "PUT", p: "/api/admin/devices/{id}", who: "Кука админа",
      d: "Изменить имя планшета, его группы и рабочее место. Все три поля необязательны и работают по одному правилу: прислали, значит меняем, а чего в теле нет, того запрос не касается. Чтобы снять планшет с рабочего места, пришлите `workstationId` пустой строкой или `null`: одно только отсутствие поля местом больше не считается.",
      req: [["`name`", "строка", "новое имя. Нет поля, имя не меняется"],
            ["`groupIds`", "массив строк", "новый состав групп целиком. Пустой массив очищает группы. Нет поля, группы не меняются"],
            ["`workstationId`", "строка", "внутренний номер места (его отдаёт `GET /api/admin/workstations` в поле `id`, вид `ws-3d55b0ab64`, это не тот код, которым адресуется внешнее API). Пустая строка или `null` снимает планшет с места. Нет поля, место не меняется. Номер не проверяется: неизвестный принимается с ответом 200, и в карточке останется номер без названия места"]],
      res: [["`ok`", "`true`"]],
      fail: [["400", "тела нет вовсе или это не JSON: пустой ответ без текста. Пришлите заголовок `Content-Type: application/json` и тело"],
             ["404", "планшета с таким номером нет. Тело пустое"]],
      о: '{ "ok": true }',
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"Ресепшн 2"}\' \\\n  {BASE}/api/admin/devices/{ПЛАНШЕТ}'
    },
    {
      g: "ref-adm-devices", m: "POST", p: "/api/admin/devices/{id}/revoke", who: "Кука админа",
      d: "Отозвать планшет. Это не пометка в списке, а «убрать всё с этого экрана прямо сейчас»: данные подписанта стираются, планшет уходит на экран активации, соединение рвётся. Отозванный планшет перестаёт быть адресатом и во внешнем API. Планшет, бывший на связи, стирает при этом и свой токен и просит новый код активации, поэтому одним `POST /api/admin/devices/{id}/unrevoke` его назад уже не вернуть. Планшет, отозванный отключённым, события не получил, токен сохранил и после возврата подключится сам.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["404", "планшета с таким номером нет. Тело пустое"]],
      о: '{ "ok": true }',
      s: 'curl -X POST -b "sk_admin=КУКА" {BASE}/api/admin/devices/{ПЛАНШЕТ}/revoke'
    },
    {
      g: "ref-adm-devices", m: "POST", p: "/api/admin/devices/{id}/unrevoke", who: "Кука админа",
      d: "Вернуть отозванный планшет в работу. Запись снова становится годной, но вернётся ли сам планшет, зависит от того, был ли он на связи в момент отзыва. Планшет, отозванный ОТКЛЮЧЁННЫМ, сохранил свой токен и подключится сам, как только окажется в сети: замер показывает, что тот же токен снова проходит проверку сразу после этого запроса. Планшет, отозванный НА СВЯЗИ, свой токен уже стёр по команде отзыва: `unrevoke` его не вернёт, ему нужен новый код активации из `POST /api/admin/devices/enroll`, а по новому коду заводится НОВАЯ запись, и прежняя останется в списке пустой. Такую прежнюю запись правильнее удалить через `DELETE /api/admin/devices/{id}`, а не возвращать.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["404", "планшета с таким номером нет. Тело пустое"]],
      о: '{ "ok": true }',
      s: 'curl -X POST -b "sk_admin=КУКА" {BASE}/api/admin/devices/{ПЛАНШЕТ}/unrevoke'
    },
    {
      g: "ref-adm-devices", m: "DELETE", p: "/api/admin/devices/{id}", who: "Кука админа",
      d: "Удалить планшет. Порядок намеренный: сначала очистить экран и оборвать связь, пока планшет ещё числится в системе, потом удалить запись, состояние и снимок сессии. Раньше запись просто исчезала, а на планшете оставался висеть документ с данными клиента, и погасить его было нечем: все команды отбирают адресата по списку планшетов.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["404", "планшета с таким номером нет. Тело пустое"]],
      о: '{ "ok": true }',
      s: 'curl -X DELETE -b "sk_admin=КУКА" {BASE}/api/admin/devices/{ПЛАНШЕТ}'
    },
    {
      g: "ref-adm-devices", m: "POST", p: "/api/admin/devices/{id}/identify", who: "Кука админа",
      d: "Показать номер прямо на экране планшета, чтобы найти его в зале. Номер рисует сам планшет, поэтому на выключенном он не появится, и молчаливое «ок» тут выглядело бы как «планшет жив и слушается».",
      req: null, res: [["`code`", "номер, который сейчас показан на экране планшета, три цифры"]],
      fail: [["404", "планшета с таким номером нет. Тело пустое"],
             ["409", "`{\"error\":\"Планшет «ИМЯ» отозван: он больше не подчиняется серверу и номер на нём не появится.\"}`. Отзыв проверяется первым, поэтому отозванному и одновременно отключённому придёт этот текст, а не текст про связь"],
             ["409", "`{\"error\":\"Планшет «ИМЯ» сейчас не на связи, номер на нём не появится.\"}`"]],
      о: '{ "code": "933" }',
      s: 'curl -X POST -b "sk_admin=КУКА" {BASE}/api/admin/devices/{ПЛАНШЕТ}/identify'
    },
    {
      g: "ref-adm-devices", m: "GET", p: "/api/admin/devices/{id}/screen", who: "Кука админа",
      d: "Что сейчас на экране планшета, в том же виде, в каком это получил он сам. Нужно окну наблюдения: оно рисует документ своим отрисовщиком, а от планшета получает только то, что меняется. Ничего никуда не записывается. Отвечает 200 и по отозванному планшету, показывая, что было бы на его экране; 404 приходит только на удалённый или неизвестный номер.",
      req: null,
      res: [["`mode`", "`slides` или `document`. Приходят всегда все три поля, незанятое равно `null`"],
            ["`document`", "разобранный документ, если он на экране, иначе `null`"],
            ["`slides`", "объект из `images` (массив путей вида `/media/banner.png`) и `intervalSec` (секунды между картинками), если на экране реклама, иначе `null`"]],
      fail: [["404", "`{\"error\":\"Планшет не найден.\"}` на удалённый или неизвестный номер"]],
      о: '{ "mode": "slides", "document": null, "slides": { "images": [], "intervalSec": 8 } }',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/devices/{ПЛАНШЕТ}/screen'
    },

    // ---------------------------------------------------------------- админка: группы, места, ключи
    {
      g: "ref-adm-catalog", m: "GET", p: "/api/admin/groups", who: "Кука админа",
      d: "Группы планшетов. Группой удобно адресовать рекламу и расписание; документ группе не показывается никогда.",
      req: null, res: [["`id`", "номер группы, вид `grp-e3917d25a6`. Это и есть `GROUP_ID` из других образцов"], ["`name`", "название"]], fail: [],
      о: '[\n  { "id": "grp-e3917d25a6", "name": "Регистратура" }\n]',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/groups', try: true
    },
    {
      g: "ref-adm-catalog", m: "POST", p: "/api/admin/groups", who: "Кука админа",
      d: "Завести группу.",
      req: [["`name`", "строка", "название группы"]],
      res: [["`id`", "номер новой группы, вид `grp-e3917d25a6`"], ["`name`", "название"]],
      fail: [["400", "тела нет вовсе или это не JSON: пустой ответ без текста"]],
      о: '{ "id": "grp-e3917d25a6", "name": "Регистратура" }',
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"Регистратура"}\' \\\n  {BASE}/api/admin/groups'
    },
    {
      g: "ref-adm-catalog", m: "PUT", p: "/api/admin/groups/{id}", who: "Кука админа",
      d: "Переименовать группу. В адресе номер группы: `GET /api/admin/groups`, поле `id`, вид `grp-e3917d25a6`. В образце ниже стоит настоящий номер этой установки; заглушка `GROUP_ID`, подставленная как есть, отвечает 404 с пустым телом.",
      req: [["`name`", "строка", "новое название"]], res: [["`ok`", "`true`"]],
      fail: [["404", "группы с таким номером нет. Тело пустое"]],
      о: '{ "ok": true }',
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"Первый этаж"}\' \\\n  {BASE}/api/admin/groups/{ГРУППА}'
    },
    {
      g: "ref-adm-catalog", m: "DELETE", p: "/api/admin/groups/{id}", who: "Кука админа",
      d: "Удалить группу. В адресе номер группы: `GET /api/admin/groups`, поле `id`, вид `grp-e3917d25a6`. Ссылки на неё вычищаются из планшетов и из картинок рекламы, а состав рекламы пересобирается и уходит на планшеты заново: они держат выданный им список и о группах сами не знают.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["404", "группы с таким номером нет. Тело пустое"]],
      о: '{ "ok": true }',
      s: 'curl -X DELETE -b "sk_admin=КУКА" {BASE}/api/admin/groups/{ГРУППА}'
    },
    {
      g: "ref-adm-catalog", m: "GET", p: "/api/admin/workstations", who: "Кука админа",
      d: "Рабочие места целиком, с внутренними номерами. Внешнее API отдаёт то же самое, но адресуется кодом.",
      req: null,
      res: [["`id`", "внутренний номер, вид `ws-3d55b0ab64`. Это и есть `WS_ID` из других образцов"], ["`externalId`", "код места, которым адресуется внешнее API"], ["`name`", "название"], ["`location`", "пояснение"]],
      fail: [],
      о: '[\n  { "id": "ws-3d55b0ab64", "externalId": "KAB-12", "name": "Кабинет 12", "location": "1 этаж" }\n]',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/workstations', try: true
    },
    {
      g: "ref-adm-catalog", m: "POST", p: "/api/admin/workstations", who: "Кука админа",
      d: "Завести рабочее место. Код `KAB-15` в образце ниже это пример: подставьте свой, ещё не занятый. В отличие от внешнего `POST /api/ext/workstations`, здесь нет идемпотентности по коду: оператор видит список и заводит место сознательно, а занятый код отвергается с 400 и названием места, которое его держит. Что уже занято, отвечает `GET /api/admin/workstations`.",
      req: [["`externalId`", "строка", "код места"], ["`name`", "строка", "название"], ["`location`", "строка", "пояснение"]],
      res: [["`id`, `externalId`, `name`, `location`", "заведённое место. `id` это внутренний номер, `externalId` это код для внешнего API"]],
      fail: [["400", "«Код «KAB-12» уже занят рабочим местом «Кабинет 12». Код рабочего места это адрес, по которому внешняя система шлёт документ, и он должен быть один на всю систему. Регистр и пробелы по краям не считаются...» Внешний `POST /api/ext/workstations` на тот же код отвечает иначе: он идемпотентен и возвращает уже заведённое место"]],
      о: '{ "id": "ws-3d55b0ab64", "externalId": "KAB-15", "name": "Касса 4", "location": "" }',
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"externalId":"KAB-15","name":"Касса 4"}\' \\\n  {BASE}/api/admin/workstations'
    },
    {
      g: "ref-adm-catalog", m: "PUT", p: "/api/admin/workstations/{id}", who: "Кука админа",
      d: "Изменить код, название или пояснение рабочего места. В адресе внутренний номер места: `GET /api/admin/workstations`, поле `id`, вид `ws-3d55b0ab64`. Это не тот код, которым адресуется внешнее API. В образце ниже стоит настоящий номер этой установки; заглушка `WS_ID`, подставленная как есть, отвечает 404 с пустым телом.",
      req: [["`externalId`", "строка", "код. Занятый другим местом не принимается"], ["`name`", "строка", "название"], ["`location`", "строка", "пояснение"]],
      res: [["`ok`", "`true`"]],
      fail: [["400", "«Код «KAB-12» уже занят рабочим местом «Кабинет 12». Код рабочего места это адрес, по которому внешняя система шлёт документ, и он должен быть один на всю систему.»"],
             ["404", "места с таким номером нет. Тело пустое"]],
      о: '{ "ok": true }',
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"Касса 5"}\' \\\n  {BASE}/api/admin/workstations/{МЕСТО_ID}'
    },
    {
      g: "ref-adm-catalog", m: "DELETE", p: "/api/admin/workstations/{id}", who: "Кука админа",
      d: "Удалить рабочее место. В адресе внутренний номер места: `GET /api/admin/workstations`, поле `id`, вид `ws-3d55b0ab64`. Планшеты, стоявшие на нём, остаются, но отвязываются: заказ по коду этого места после удаления получит `workstation not found`.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["404", "места с таким номером нет. Тело пустое"]],
      о: '{ "ok": true }',
      s: 'curl -X DELETE -b "sk_admin=КУКА" {BASE}/api/admin/workstations/{МЕСТО_ID}'
    },
    {
      g: "ref-adm-catalog", m: "GET", p: "/api/admin/apikeys", who: "Кука админа",
      d: "Список ключей внешнего API. Самого ключа в списке нет и быть не может: на сервере лежит только его SHA-256.",
      req: null,
      res: [["`id`", "номер ключа, вид `key-929b66d5bd`. Это и есть `KEY_ID` из образцов ниже"], ["`label`", "название, заданное при создании"],
            ["`createdUtc`", "когда создан"], ["`disabled`", "выключен ли"]],
      fail: [],
      о: '[\n  { "id": "key-929b66d5bd", "label": "ERP", "createdUtc": "2026-08-25T10:57:24.8865699Z", "disabled": false }\n]',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/apikeys', try: true
    },
    {
      g: "ref-adm-catalog", m: "POST", p: "/api/admin/apikeys", who: "Кука админа",
      d: "Создать ключ. Открытый ключ возвращается ОДИН раз, в этом ответе: дальше его взять негде.",
      req: [["`label`", "строка", "название ключа, например имя интеграции"]],
      res: [["`id`", "номер ключа, вид `key-929b66d5bd`"], ["`label`", "название"], ["`key`", "сам ключ, `sk_` и 30 случайных байт. Это и есть `ВАШ_КЛЮЧ` из образцов внешнего API. Больше он не покажется нигде"]],
      fail: [],
      о: '{ "id": "key-929b66d5bd", "label": "ERP", "key": "sk_n03QLxZTXFrRXjIqzfgen3nIWXqMA3U9fy3Rt8_t" }',
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"label":"ERP"}\' \\\n  {BASE}/api/admin/apikeys'
    },
    {
      g: "ref-adm-catalog", m: "POST", p: "/api/admin/apikeys/{id}/disable", who: "Кука админа",
      d: "Выключить ключ, не удаляя. В адресе номер ключа: `GET /api/admin/apikeys`, поле `id`, вид `key-929b66d5bd`; подставленная как есть заглушка `KEY_ID` отвечает 404 с пустым телом. «Перекрыть доступ на время разбирательства» и «забыть, что такой доступ был» это разные действия: удаление необратимо и требует заново настраивать чужую систему.",
      req: null, res: [["`ok`", "`true`"], ["`disabled`", "`true`"]],
      fail: [["404", "ключа с таким номером нет. Тело пустое"]],
      s: 'curl -X POST -b "sk_admin=КУКА" {BASE}/api/admin/apikeys/KEY_ID/disable'
    },
    {
      g: "ref-adm-catalog", m: "POST", p: "/api/admin/apikeys/{id}/enable", who: "Кука админа",
      d: "Включить выключенный ключ обратно. Заглушка `KEY_ID` в адресе это номер ключа: `GET /api/admin/apikeys`, поле `id`, вид `key-929b66d5bd`.",
      req: null, res: [["`ok`", "`true`"], ["`disabled`", "`false`"]],
      fail: [["404", "ключа с таким номером нет. Тело пустое"]],
      s: 'curl -X POST -b "sk_admin=КУКА" {BASE}/api/admin/apikeys/KEY_ID/enable'
    },
    {
      g: "ref-adm-catalog", m: "DELETE", p: "/api/admin/apikeys/{id}", who: "Кука админа",
      d: "Удалить ключ навсегда. Заглушка `KEY_ID` в адресе это номер ключа: `GET /api/admin/apikeys`, поле `id`, вид `key-929b66d5bd`. Восстановить удалённый ключ нельзя: у сервера есть только хэш.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["404", "ключа с таким номером нет. Тело пустое"]],
      s: 'curl -X DELETE -b "sk_admin=КУКА" {BASE}/api/admin/apikeys/KEY_ID'
    },

    // ---------------------------------------------------------------- админка: реклама
    {
      g: "ref-adm-slides", m: "GET", p: "/api/admin/images", who: "Кука админа",
      d: "Картинки рекламы со сроками показа, областью показа и признаком «показывается сегодня». Признак считает сервер: у него и часы, и правило, а оператор иначе гадал бы, попадает ли сегодняшний день в заданный срок.",
      req: null,
      res: [["`id`, `originalName`, `uploadedUtc`", "номер (вид `fbd9e00d2525432a9fad437e040c730a`, это и есть `IMAGE_ID` из образцов ниже), имя файла при загрузке, когда загружена"],
            ["`url`", "адрес картинки, `/media/имя`"],
            ["`showFrom`, `showTo`", "срок показа, `гггг-ММ-дд` или пусто"],
            ["`groupIds`, `exceptGroupIds`", "где показывать и где не показывать. Пустые списки означают «везде»"],
            ["`showsToday`", "участвует ли она в рекламе сегодня"]],
      fail: [],
      о: '[\n  {\n    "id": "fbd9e00d2525432a9fad437e040c730a",\n    "originalName": "banner.png",\n    "uploadedUtc": "2026-08-25T10:57:25.0520998Z",\n    "url": "/media/fbd9e00d2525432a9fad437e040c730a.png",\n    "showFrom": "2026-09-01",\n    "showTo": "2026-09-30",\n    "groupIds": [],\n    "exceptGroupIds": [],\n    "showsToday": false\n  }\n]',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/images', try: true
    },
    {
      g: "ref-adm-slides", m: "POST", p: "/api/admin/images", who: "Кука админа",
      d: "Загрузить картинки рекламы. Единственный путь во всём API, который принимает не JSON, а `multipart/form-data`. Предел на файл 8 МБ: реклама уезжает на планшеты целиком и хранится на сервере, поэтому снимку с телефона на двадцать мегабайт здесь не место.",
      т: "Тело обязательно, и это единственный путь во всём API, который ждёт не JSON, а форму `multipart/form-data`. Заголовок `Content-Type` ставит сам `curl` по ключу `-F`.",
      req: [["файлы формы", "multipart", "любое число файлов. Годятся `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, вид определяется по расширению или по `Content-Type`"]],
      о: '{\n  "added": [\n    {\n      "id": "fbd9e00d2525432a9fad437e040c730a",\n      "originalName": "banner.png",\n      "url": "/media/fbd9e00d2525432a9fad437e040c730a.png"\n    }\n  ],\n  "skipped": []\n}',
      res: [["`added`", "что загружено: `id` (он же `IMAGE_ID` в других образцах), `originalName`, `url`"],
            ["`skipped`", "что пропущено и почему: «имя: это не картинка», «имя: N МБ, а больше 8 МБ картинка быть не может»"]],
      fail: [["400", "`{\"error\":\"expected multipart/form-data\"}`, если тело не форма"],
             ["400", "«Ничего не загружено. » и перечень причин, если не подошёл ни один файл. Молча пропустить файл нельзя: оператор увидел бы «Картинки загружены» и не понял, почему их в списке нет"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -F "file=@banner.png" \\\n  {BASE}/api/admin/images'
    },
    {
      g: "ref-adm-slides", m: "DELETE", p: "/api/admin/images/{id}", who: "Кука админа",
      d: "Удалить картинку. В адресе номер картинки: `GET /api/admin/images`, поле `id`, вид `fbd9e00d2525432a9fad437e040c730a`; заглушка `IMAGE_ID`, подставленная как есть, отвечает 404 с пустым телом. Список рекламы пересобирается и уходит на планшеты заново: планшет держит выданный ему список и о том, что файла больше нет, не знает, поэтому показывал бы битую картинку до самой перезагрузки.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["404", "картинки с таким номером нет. Тело пустое"]],
      s: 'curl -X DELETE -b "sk_admin=КУКА" {BASE}/api/admin/images/IMAGE_ID'
    },
    {
      g: "ref-adm-slides", m: "PUT", p: "/api/admin/images/{id}/dates", who: "Кука админа",
      d: "Срок показа картинки: с какого и по какой день она участвует в рекламе. Пустая дата снимает ограничение с этой стороны. Заглушка `IMAGE_ID` в адресе это номер картинки: `GET /api/admin/images`, поле `id`, вид `fbd9e00d2525432a9fad437e040c730a`.",
      req: [["`showFrom`", "строка", "дата начала, `2026-08-21` или `21.08.2026`. Пусто снимает"],
            ["`showTo`", "строка", "дата окончания, тот же вид"]],
      res: [["`ok`", "`true`"], ["`showFrom`, `showTo`", "что сохранено, в виде `гггг-ММ-дд`"]],
      fail: [["400", "«Дата начала показа не разобрана. Подойдёт 2026-08-21 или 21.08.2026.»"],
             ["400", "«Дата окончания показа не разобрана. Подойдёт 2026-08-21 или 21.08.2026.»"],
             ["400", "«Дата окончания раньше даты начала: такая картинка не покажется никогда.»"],
             ["404", "«Картинка не найдена.»"]],
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"showFrom":"2026-09-01","showTo":"2026-09-30"}\' \\\n  {BASE}/api/admin/images/IMAGE_ID/dates'
    },
    {
      g: "ref-adm-slides", m: "PUT", p: "/api/admin/images/{id}/groups", who: "Кука админа",
      d: "Где показывать картинку и где не показывать. Пустые списки означают «везде». Заглушка `IMAGE_ID` в адресе это номер картинки: `GET /api/admin/images`, поле `id`. Номера групп берутся из `GET /api/admin/groups`, поле `id`, вид `grp-e3917d25a6`; в образце ниже стоит настоящий номер группы этой установки.",
      req: [["`groupIds`", "массив строк", "показывать только в этих группах. Номера из `GET /api/admin/groups`, поле `id`"],
            ["`exceptGroupIds`", "массив строк", "не показывать в этих группах. Номера оттуда же"]],
      res: [["`ok`", "`true`"], ["`groupIds`, `exceptGroupIds`", "что сохранено"]],
      fail: [["400", "«Группа указана и в «показывать», и в «кроме»: » и имена спорных групп. Молча выбрать одно из двух значило бы оставить оператора в уверенности, что он задал другое"],
             ["404", "«Картинка не найдена.»"]],
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"groupIds":["{ГРУППА}"],"exceptGroupIds":[]}\' \\\n  {BASE}/api/admin/images/IMAGE_ID/groups'
    },
    {
      g: "ref-adm-slides", m: "GET", p: "/api/admin/playlist", who: "Кука админа",
      d: "Плейлист адресата. Читается оттуда же, куда пишется: для группы и набора это список первого их планшета. Раньше здесь отдавался общий список, и оператор, сохранивший рекламу для группы, при следующем заходе видел чужой набор, а следующее сохранение затирало то, что он только что задал.",
      req: [["`target`", "строка в строке запроса", "`all`, `group:{id}`, `device:{id}` или `devices`"],
            ["`ids`", "строка в строке запроса", "номера планшетов через запятую, когда `target=devices`"]],
      res: [["`target`", "чей плейлист вернули"], ["`imageIds`", "номера картинок по порядку, они же `IMAGE_ID` в образцах"],
            ["`intervalSec`", "сколько секунд держится каждая"], ["`mode`", "`slides` или `document`"]],
      fail: [],
      о: '{\n  "target": "all",\n  "imageIds": ["fbd9e00d2525432a9fad437e040c730a"],\n  "intervalSec": 8,\n  "mode": "slides"\n}',
      s: 'curl -b "sk_admin=КУКА" "{BASE}/api/admin/playlist?target=all"',
      try: { путь: "/api/admin/playlist?target=all" }
    },
    {
      g: "ref-adm-slides", m: "PUT", p: "/api/admin/playlist", who: "Кука админа",
      d: "Сохранить плейлист и показать его. Заглушка `IMAGE_ID` в образце это номер картинки: `GET /api/admin/images`, поле `id`, вид `fbd9e00d2525432a9fad437e040c730a`. Ответ говорит и то и другое отдельно: «Сохранено и отправлено» звучит одинаково и когда реклама поехала на десять планшетов, и когда ни один из них не включён.",
      req: [["`target`", "строка", "`all`, `group:{id}`, `device:{id}` или `devices`. Номер группы из `GET /api/admin/groups`, номер планшета из `GET /api/admin/devices`"],
            ["`imageIds`", "массив строк", "номера картинок по порядку: `GET /api/admin/images`, поле `id`"],
            ["`intervalSec`", "число", "сколько секунд держится каждая, от 1 до 3600. Без поля выйдет 8. Число вне этих границ молча приводится к ближайшей"],
            ["`deviceIds`", "массив строк", "набор планшетов, когда `target` равен `devices`"]],
      res: [["`ok`", "`true`"], ["`shown`", "сколько планшетов получили плейлист прямо сейчас"]],
      fail: [["400", "«Отметьте хотя бы один планшет.», если `target` равен `devices`, а набор пуст"]],
      о: '{ "ok": true, "shown": 1 }',
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"target":"all","imageIds":["IMAGE_ID"],"intervalSec":8}\' \\\n  {BASE}/api/admin/playlist'
    },

    // ---------------------------------------------------------------- админка: документы
    {
      g: "ref-adm-docs", m: "GET", p: "/api/admin/field-schema", who: "Кука админа",
      d: "Какие теги существуют, какие значения они принимают и как эти значения называются для человека. Редактор читает список отсюда, а не держит свою копию: иначе добавленный тег появился бы в одном месте и не появился в другом.",
      req: null,
      res: [["`fields[].name`", "имя тега"],
            ["`fields[].values`", "допустимые значения, если их набор задан (`M`/`F`, `true`/`false`), иначе `null`"],
            ["`fields[].valueLabels`", "как показать значение человеку: `M` это «М (мужской)». На проводе остаётся `M`"]],
      fail: [],
      о: '{\n  "fields": [\n    { "name": "ФИО", "values": null, "valueLabels": null },\n    { "name": "ДР", "values": null, "valueLabels": null },\n    { "name": "Адрес регистрации", "values": null, "valueLabels": null },\n    { "name": "Пол", "values": ["M", "F"],\n      "valueLabels": { "M": "М (мужской)", "F": "Ж (женский)" } }\n  ]\n}',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/field-schema', try: true
    },
    {
      g: "ref-adm-docs", m: "GET", p: "/api/admin/documents", who: "Кука админа",
      d: "Библиотека документов целиком, с внутренними номерами. Внешнее API отдаёт из неё только код, название и признак «по умолчанию».",
      req: null,
      res: [["`id`", "внутренний номер, это и есть `DOC_ID` из образцов ниже. У поставляемого документа он совпадает с кодом и равен `main`"], ["`code`", "код для API, он же `documentCode` в запросах показа"], ["`name`", "название"],
            ["`isDefault`", "показывается ли без кода"], ["`kind`", "`info` у информационного документа, иначе пусто"],
            ["`updatedUtc`", "когда его правили в последний раз"]],
      fail: [],
      о: '[\n  {\n    "id": "main",\n    "code": "main",\n    "name": "Согласие на обработку персональных данных",\n    "isDefault": true,\n    "kind": null,\n    "updatedUtc": "2026-08-25T10:57:25.7255362Z"\n  }\n]',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/documents', try: true
    },
    {
      g: "ref-adm-docs", m: "POST", p: "/api/admin/documents", who: "Кука админа",
      d: "Завести документ или сделать копию существующего. Код `SOGLASIE` в образце ниже это пример: код придумываете вы сами, им документ потом вызывается из внешней системы в поле `documentCode`, и занятый код отвергается с 400. Новый документ начинается чистым: одна пустая страница и введённое название. Раньше новый заводился копией образцового согласия, и человек получал чужой готовый текст и не понимал, откуда он взялся.",
      req: [["`code`", "строка", "код для API. Обязателен"],
            ["`name`", "строка", "название. Без него берётся код"],
            ["`copyOfId`", "строка", "номер документа, с которого сделать копию"]],
      res: [["`id`, `code`, `name`, `isDefault`, `kind`, `updatedUtc`", "заведённый документ"]],
      fail: [["400", "«Больше 50 документов не бывает: список перестанет быть списком.»"],
             ["400", "«Код документа обязателен: по нему документ вызывается из внешней системы.»"],
             ["400", "«Код «X» уже занят другим документом.»"],
             ["400", "«Документ, с которого делается копия, не найден.»"],
             ["400", "«Не удалось создать документ.»"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"code":"SOGLASIE","name":"Согласие на обработку"}\' \\\n  {BASE}/api/admin/documents'
    },
    {
      g: "ref-adm-docs", m: "PUT", p: "/api/admin/documents/{id}", who: "Кука админа",
      d: "Сменить код или название документа. Код `SOGLASIE-2` в образце ниже это пример нового кода, придуманного вами. Заглушка `DOC_ID` в адресе это внутренний номер документа: `GET /api/admin/documents`, поле `id`; в образце ниже стоит настоящий номер этой установки. Поле `code` трогает только запись в библиотеке, версия текста от него не меняется. Поле `name` это заголовок самого документа: оно переписывается внутрь файла документа и меняет его версию `X-Doc-Rev`, поэтому правка, открытая в другом окне до переименования, получит при сохранении 409 «Документ уже изменён в другом окне или другим оператором» и её придётся перечитать. Замер: версия до переименования `021C49C34054142A`, после `CB5F6ECAA311F28B`, сохранение со старой версией отбито 409.",
      req: [["`code`", "строка", "новый код. Меняет только запись в библиотеке"], ["`name`", "строка", "новое название. Оно же заголовок документа, поэтому меняет версию текста"]],
      res: [["`ok`", "`true`"]],
      fail: [["400", "«Документ не найден.»"], ["400", "«Код документа не может быть пустым.»"],
             ["400", "«Код «X» уже занят другим документом.»"]],
      о: '{ "ok": true }',
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"code":"SOGLASIE-2"}\' \\\n  {BASE}/api/admin/documents/{ДОКУМЕНТ_ID}'
    },
    {
      g: "ref-adm-docs", m: "POST", p: "/api/admin/documents/{id}/default", who: "Кука админа",
      d: "Сделать документ основным: именно он покажется, когда запрос пришёл без `documentCode`. В адресе внутренний номер документа: `GET /api/admin/documents`, поле `id`.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["400", "«Документ не найден.»"], ["400", "«Не удалось переставить документ по умолчанию.»"]],
      о: '{ "ok": true }',
      s: 'curl -X POST -b "sk_admin=КУКА" {BASE}/api/admin/documents/{ДОКУМЕНТ_ID}/default'
    },
    {
      g: "ref-adm-docs", m: "DELETE", p: "/api/admin/documents/{id}", who: "Кука админа",
      d: "Удалить документ вместе с его текстом. В адресе внутренний номер документа: `GET /api/admin/documents`, поле `id`. Уже подписанные записи не трогаются: в них лежит снимок того, что подписали.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["400", "«Документ не найден.»"],
             ["400", "«Это документ по умолчанию: он показывается, когда запрос пришёл без кода. Сначала назначьте по умолчанию другой.»"],
             ["400", "«Последний документ удалить нельзя.»"]],
      s: 'curl -X DELETE -b "sk_admin=КУКА" {BASE}/api/admin/documents/{ДОКУМЕНТ_ID}'
    },
    {
      g: "ref-adm-docs", m: "GET", p: "/api/admin/document", who: "Кука админа",
      d: "Текст документа: страницы, блоки, пункты, группы, условия. Без `id` отдаётся документ по умолчанию, так работает всё, написанное до появления библиотеки. Версия документа едет заголовками, а не в теле: тело остаётся самим документом.",
      req: [["`id`", "строка в строке запроса", "номер документа: `GET /api/admin/documents`, поле `id`. Без него документ по умолчанию"]],
      res: [["тело", "документ целиком: `title`, `kind`, `pages[]`, `signPrompt`, `signBlocks`, `thankYou*`, `pdf*` и прочие настройки показа"],
            ["заголовок `X-Doc-Rev`", "версия текста, вид `021C49C34054142A`. Это и есть `ВЕРСИЯ_ИЗ_GET` из образца сохранения ниже. У документа, который ещё ни разу не сохраняли, приходит `new`"],
            ["заголовок `X-Doc-Id`", "номер документа, который отдали"]],
      fail: [["404", "«Документ не найден.»"]],
      о: 'HTTP/1.1 200 OK\nX-Doc-Rev: 021C49C34054142A\nX-Doc-Id: main\nContent-Type: application/json\n\n{ "kind": null, "title": "Согласие на обработку персональных данных", "pages": [ ... ],\n  "signPrompt": "Пожалуйста, поставьте вашу подпись в поле ниже", ... }',
      s: 'curl -i -b "sk_admin=КУКА" "{BASE}/api/admin/document?id={ДОКУМЕНТ_ID}"', try: { путь: "/api/admin/document" }
    },
    {
      g: "ref-adm-docs", m: "PUT", p: "/api/admin/document", who: "Кука админа",
      d: "Сохранить текст документа целиком. `ВЕРСИЯ_ИЗ_GET` в образце это заголовок `X-Doc-Rev` ответа `GET /api/admin/document`, вид `021C49C34054142A`. Сверка версий по желанию отправителя: админка шлёт заголовок `X-Doc-Rev` с версией, от которой правила, а внешняя система и ввоз шаблона ничего не шлют и работают перезаписью. Без сверки две открытые админки молча затирали бы работу друг друга.",
      req: [["`id`", "строка в строке запроса", "какой документ сохранить: `GET /api/admin/documents`, поле `id`. Без него документ по умолчанию"],
            ["заголовок `X-Doc-Rev`", "строка", "версия, от которой правили. Берётся из заголовка `X-Doc-Rev` ответа `GET /api/admin/document`, вид `021C49C34054142A`. Необязателен: без него запрос работает перезаписью"],
            ["тело", "документ", "весь документ целиком, как его отдал `GET /api/admin/document`"]],
      res: [["`ok`", "`true`"],
            ["`warnings`", "замечания разбора: то, что стоит знать, но что смысла документа не меняет. Например имя элемента, совпавшее с тегом API"],
            ["заголовок `X-Doc-Rev`", "новая версия текста"]],
      fail: [["400", "`{\"error\":\"document required\"}`, если тело пустое"],
             ["400", "«Условие сложнее, чем документ умеет хранить, и при сохранении оно изменилось бы само: содержимое показалось бы там, где вы его прятали. Упростите условие. Мешает: ...»"],
             ["400", "«Информационный документ не подписывают и никуда не сохраняют, поэтому поля подписи, сканирование и обязательные пункты на нём работать не будут ... Мешают: ...»"],
             ["400", "«Эти картинки нельзя использовать в документе: их не удастся вложить в PDF. Подойдут PNG, JPG или BMP. Проблемные файлы: ...»"],
             ["404", "«Документ не найден.» или «Документ не найден: ID»"],
             ["409", "«Документ уже изменён в другом окне или другим оператором. Возьмите свежую версию, иначе чужая работа будет затёрта.»"]],
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -H "X-Doc-Rev: ВЕРСИЯ_ИЗ_GET" \\\n  -d @документ.json \\\n  "{BASE}/api/admin/document?id={ДОКУМЕНТ_ID}"'
    },
    {
      g: "ref-adm-docs", m: "POST", p: "/api/admin/document/preview", who: "Кука админа",
      d: "Разобрать документ с тестовыми значениями так, как его увидел бы планшет: теги подставлены, условия применены, присланные пункты вставлены. Ничего не сохраняется и ни один планшет не трогается. Если в теле пришёл документ, разбирается он, а не сохранённый: так предпросматриваются несохранённые правки редактора. Одно расхождение с настоящим показом назовём вслух: присланные пункты здесь показываются всегда, и когда в документе нет ни одной страницы с признаком «чекбоксы из API», предпросмотр заводит под них отдельную страницу. Настоящий `POST /api/ext/show-document` в этом случае пункт не покажет и назовёт его в `dropped`. Замер на поставляемом `main`: предпросмотр отдал четыре страницы вместо трёх, присланный пункт стоял на четвёртой, а показ на планшет тот же пункт отбросил. Правду про показ говорит `dropped`, а не этот путь.",
      req: [["`document`", "документ", "что разбирать. Без него берётся сохранённый по `documentId`"],
            ["`documentId`", "строка", "номер сохранённого документа"],
            ["`fields`", "объект", "значения тегов"],
            ["`checkboxes`", "массив", "пункты, как во внешнем показе"],
            ["`groups`", "массив", "выбор в группах"],
            ["`images`", "объект", "картинки заказа"]],
      т: "Тело JSON, заголовок `Content-Type: application/json`. Пустое тело здесь принимается: без него разбирается сохранённый документ по умолчанию с пустыми значениями тегов.",
      res: [["`document`", "разобранный документ"],
            ["`placeholders`", "все теги, которые документ использует"],
            ["`missingPlaceholders`", "те из них, что не передали"],
            ["`emptyPlaceholders`", "те, что передали пустыми"],
            ["`pagesTotal`", "сколько страниц в документе"],
            ["`pagesShown`", "сколько осталось после условий"]],
      fail: [["400", "«Тег «X» принимает только true или false, получено: ...»"],
             ["400", "«Тег «X» используется в условии по возрасту (или по сроку), но значение «...» не похоже на дату.»"],
             ["400", "отказ по картинке, с именем тега"],
             ["404", "«Документ не найден: ID»"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"fields":{"ФИО":"Иванова Анна","Пол":"F"}}\' \\\n  {BASE}/api/admin/document/preview',
      try: { тело: { fields: { "ФИО": "Иванова Анна Петровна", "Пол": "F" } } }
    },
    {
      g: "ref-adm-docs", m: "POST", p: "/api/admin/document/pdf-layout", who: "Кука админа",
      d: "Где именно окажется каждая строка будущего PDF. Считает это тот же генератор, который потом соберёт настоящий файл, поэтому макет в админке не похож на PDF, а совпадает с ним. Рисовать PDF в браузере для этого не нужно.",
      req: [["`document`", "документ", "что размечать. Без него берётся сохранённый по `documentId`"],
            ["`documentId`", "строка", "номер сохранённого документа"],
            ["`fields`", "объект", "значения тегов: от длины текста зависит, на какой странице окажется подпись"],
            ["`checkboxes`", "массив", "пункты, как во внешнем показе"]],
      res: [["`pageWidth`, `pageHeight`, `pageCount`", "размеры листа и сколько их вышло"],
            ["`items`", "каждая строка с её местом на листе"],
            ["`placements`", "заданные оператором места полей подписи"],
            ["`fields`", "поля подписи документа. Пустое имя это итоговая подпись под документом"]],
      fail: [["400", "«Тег «X» принимает только true или false, получено: ...»"],
             ["400", "«Тег «X» используется в условии по возрасту (или по сроку), но значение «...» не похоже на дату.»"],
             ["404", "«Документ не найден: ID»"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"fields":{"ФИО":"Иванова Анна"}}\' \\\n  {BASE}/api/admin/document/pdf-layout'
    },
    {
      g: "ref-adm-docs", m: "POST", p: "/api/admin/document/import", who: "Кука админа",
      d: "Ввоз файла шаблона. Файл это то, что сохранила кнопка «Экспорт» на вкладке «Документ»: в нём поле `kind` со значением `helix-signtablet-document`, `version`, `document` и `images[]`. Заводит НОВЫЙ документ, а не затирает открытый: с библиотекой затирание означало бы «принёс шаблон от коллеги, потерял свой». Картинки из файла кладутся в медиатеку под теми же именами, на которые ссылается документ, иначе перенесённый шаблон показывал бы пустые рамки вместо печатей. Уже существующий файл не трогается: его могли заменить нарочно.",
      req: [["`code`", "строка в строке запроса", "код нового документа. Без него код сочиняется из названия, а занятый дополняется числом"],
            ["`title`", "строка в строке запроса", "название нового документа. Едет строкой запроса, поэтому русские буквы в нём надо закодировать по правилам URL: `Ввезённый` записывается как `%D0%92%D0%B2%D0%B5%D0%B7%D1%91%D0%BD%D0%BD%D1%8B%D0%B9`. Незакодированное название платформа отвергает 400 с пустым телом ещё до обработчика"],
            ["тело", "файл шаблона", "то, что сохранила кнопка «Экспорт»: `kind`, `version` (1 без картинок, 2 с картинками), `document`, `images[]`"]],
      res: [["`ok`", "`true`"], ["`pages`", "сколько страниц принято"], ["`images`", "сколько картинок восстановлено"],
            ["`id`", "номер заведённого документа"], ["`code`", "его код"]],
      fail: [["400", "пустое тело ответа: русские буквы в `title` или `code` не закодированы по правилам URL. Замер: `?title=Ввезённый` как есть даёт 400 без текста, тот же файл с закодированным названием даёт 200"],
             ["400", "«Это не файл шаблона документа HELIX SignTablet.» Признак вида файла это поле `kind` со значением `helix-signtablet-document`"],
             ["400", "«Версия файла шаблона не поддерживается.»"],
             ["400", "«Условие сложнее, чем документ умеет хранить ...»: правило то же, что при сохранении из редактора"],
             ["400", "«В файле нет ни одной пригодной страницы документа.»"],
             ["400", "отказ заведения документа: занятый код, предел в 50 документов"],
             ["404", "«Документ не найден: ID»"]],
      о: '{ "ok": true, "pages": 3, "images": 0, "id": "b27bedb7c068", "code": "IMPORT" }',
      s: '# Название едет строкой запроса, поэтому «Ввезённый» здесь закодирован по правилам URL:\n# незакодированные русские буквы платформа отвергает 400 с пустым телом.\ncurl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d @шаблон.json \\\n  "{BASE}/api/admin/document/import?code=IMPORT&title=%D0%92%D0%B2%D0%B5%D0%B7%D1%91%D0%BD%D0%BD%D1%8B%D0%B9"'
    },

    // ---------------------------------------------------------------- админка: управление по сети
    {
      g: "ref-adm-control", m: "GET", p: "/api/admin/kiosk-control/settings", who: "Кука админа",
      d: "Настройки управления планшетами по локальной сети. Ключ не отдаётся никогда: вместо него приходит признак «задан или нет», чтобы открытая админка не выставляла напоказ пароль от всего парка.",
      req: null,
      res: [["`enabled`", "включено ли управление"], ["`port`", "порт FreeKiosk, по умолчанию 8080"],
            ["`timeoutSec`", "сколько ждать ответа планшета"],
            ["`autoHeal`, `autoHealAfterMinutes`", "автолечение и через сколько минут молчания начинать"],
            ["`batteryWarnPercent`, `storageWarnPercent`", "пороги предупреждений"],
            ["`apiKeySet`", "задан ли ключ управления. Сам ключ не отдаётся"]],
      fail: [],
      о: '{\n  "enabled": false,\n  "port": 8080,\n  "timeoutSec": 5,\n  "autoHeal": false,\n  "autoHealAfterMinutes": 5,\n  "batteryWarnPercent": 20,\n  "storageWarnPercent": 10,\n  "apiKeySet": false\n}',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/kiosk-control/settings', try: true
    },
    {
      g: "ref-adm-control", m: "PUT", p: "/api/admin/kiosk-control/settings", who: "Кука админа",
      d: "Сохранить настройки. Пустой ключ означает «оставить прежний», а стереть его это отдельная просьба, поле `clearApiKey`. Смена включения, порта или ключа сбрасывает показания планшетов: снятые через прежний адрес, они описывают состояние, которое уже нечем проверить.",
      req: [["`enabled`", "булев", "включить управление"], ["`port`", "число", "порт FreeKiosk"],
            ["`apiKey`", "строка", "ключ управления. Пустой оставляет прежний"],
            ["`clearApiKey`", "булев", "стереть сохранённый ключ"],
            ["`timeoutSec`", "число", "сколько ждать ответа планшета"],
            ["`autoHeal`", "булев", "поднимать зависший планшет"],
            ["`autoHealAfterMinutes`", "число", "через сколько минут молчания начинать"],
            ["`batteryWarnPercent`", "число", "порог предупреждения по заряду"],
            ["`storageWarnPercent`", "число", "порог предупреждения по свободному месту"]],
      res: [["то же, что у `GET`", "сохранённые настройки, снова без самого ключа"]],
      fail: [["400", "`{\"error\":\"settings required\"}`, если тело пустое"],
             ["400", "ключ управления не годится для передачи по HTTP: такой ключ отвергается здесь, а не превращается потом в «планшет не отвечает по сети» на каждой команде"]],
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"enabled":true,"port":8080,"apiKey":"","clearApiKey":false,"timeoutSec":5,\n       "autoHeal":false,"autoHealAfterMinutes":5,"batteryWarnPercent":20,"storageWarnPercent":10}\' \\\n  {BASE}/api/admin/kiosk-control/settings'
    },
    {
      g: "ref-adm-control", m: "PUT", p: "/api/admin/devices/{id}/control-address", who: "Кука админа",
      d: "Где искать этот планшет в локальной сети. В адресе номер планшета: `GET /api/admin/devices`, поле `id`, вид `dev-24386a4b78`; в образце ниже стоит настоящий номер этой установки. Адрес `192.168.1.50` в образце это пример, а не адрес вашего планшета: подставьте свой, иначе команды будут уходить в пустоту. Обычно это тот же адрес, с которого планшет подключился, но когда он ходит через маршрутизатор, виден адрес маршрутизатора, а не планшета. Пустой `ip` снимает переопределение. Прежнее показание забывается: оно снято со старого адреса и о новом ничего не говорит.",
      req: [["`ip`", "строка", "адрес планшета в локальной сети, например `192.168.1.50`. Пустой снимает переопределение"],
            ["`port`", "число", "порт, если он отличается от общего"]],
      res: [["`ok`", "`true`"]],
      fail: [["400", "«Укажите IP-адрес планшета в локальной сети, например 192.168.1.50.»"],
             ["404", "планшета с таким номером нет. Тело пустое"]],
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"ip":"192.168.1.50","port":8080}\' \\\n  {BASE}/api/admin/devices/{ПЛАНШЕТ}/control-address'
    },
    {
      g: "ref-adm-control", m: "POST", p: "/api/admin/devices/{id}/kiosk/{command}", who: "Кука админа",
      d: "Команда планшету по локальной сети. В адресе номер планшета: `GET /api/admin/devices`, поле `id`, вид `dev-24386a4b78`; в образце ниже стоит настоящий номер этой установки. Команды перечислены поимённо и сопоставлены путям FreeKiosk на сервере: свободного пути от клиента здесь нет, поэтому запрос нельзя превратить в произвольный вызов к планшету. Каждая команда пишется в журнал, удалась она или нет.",
      т: "Тела нет: команда стоит в адресе. Ни `-d`, ни заголовка `Content-Type` не надо.",
      req: [["`{command}`", "часть адреса", "`reboot`, `restart-app`, `reload`, `clear-cache`, `screen-on`, `screen-off`, `beep`, `wake`"]],
      res: [["`ok`", "`true`, если планшет принял команду"]],
      fail: [["400", "«Неизвестная команда.»"],
             ["404", "планшета с таким номером нет. Тело пустое"],
             ["502", "`{\"error\":\"Управление планшетами выключено в настройках.\"}` на свежей установке, пока не включили `enabled`"],
             ["502", "`{\"error\":\"Адрес планшета неизвестен. Укажите его в карточке планшета.\"}`, пока не задан `control-address`"],
             ["502", "планшет не ответил: в теле `error` с причиной от сети или от самого FreeKiosk"]],
      s: 'curl -X POST -b "sk_admin=КУКА" {BASE}/api/admin/devices/{ПЛАНШЕТ}/kiosk/reload'
    },
    {
      g: "ref-adm-control", m: "POST", p: "/api/admin/devices/{id}/kiosk/brightness", who: "Кука админа",
      d: "Яркость экрана планшета.",
      req: [["`value`", "число", "0..100. Значение вне предела приводится к нему, по умолчанию 100"]],
      res: [["`ok`", "`true`"], ["`value`", "какое значение ушло на планшет"]],
      fail: [["404", "планшета с таким номером нет. Тело пустое"], ["502", "планшет не ответил: в теле `error`"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"value":80}\' \\\n  {BASE}/api/admin/devices/{ПЛАНШЕТ}/kiosk/brightness'
    },
    {
      g: "ref-adm-control", m: "POST", p: "/api/admin/devices/{id}/kiosk/volume", who: "Кука админа",
      d: "Громкость планшета.",
      req: [["`value`", "число", "0..100. Значение вне предела приводится к нему, по умолчанию 50"]],
      res: [["`ok`", "`true`"], ["`value`", "какое значение ушло на планшет"]],
      fail: [["404", "планшета с таким номером нет. Тело пустое"], ["502", "планшет не ответил: в теле `error`"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"value":50}\' \\\n  {BASE}/api/admin/devices/{ПЛАНШЕТ}/kiosk/volume'
    },
    {
      g: "ref-adm-control", m: "POST", p: "/api/admin/devices/{id}/kiosk/say", who: "Кука админа",
      d: "Произнести текст вслух на планшете, голосом `ru-RU`. Так зовут человека к стойке или находят планшет на слух.",
      req: [["`text`", "строка", "что произнести. От 1 до 500 знаков"]],
      res: [["`ok`", "`true`"]],
      fail: [["400", "«Текст обязателен (до 500 символов).»"],
             ["404", "планшета с таким номером нет. Тело пустое"], ["502", "планшет не ответил: в теле `error`"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"text":"Подойдите к стойке номер четыре"}\' \\\n  {BASE}/api/admin/devices/{ПЛАНШЕТ}/kiosk/say'
    },
    {
      g: "ref-adm-control", m: "POST", p: "/api/admin/devices/{id}/kiosk/toast", who: "Кука админа",
      d: "Показать короткое сообщение поверх экрана планшета.",
      req: [["`text`", "строка", "что показать. От 1 до 200 знаков"]],
      res: [["`ok`", "`true`"]],
      fail: [["400", "«Текст обязателен (до 200 символов).»"],
             ["404", "планшета с таким номером нет. Тело пустое"], ["502", "планшет не ответил: в теле `error`"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"text":"Планшет забирают на обслуживание"}\' \\\n  {BASE}/api/admin/devices/{ПЛАНШЕТ}/kiosk/toast'
    },
    {
      g: "ref-adm-control", m: "GET", p: "/api/admin/devices/{id}/kiosk/health", who: "Кука админа",
      d: "Опросить планшет прямо сейчас. В адресе номер планшета: `GET /api/admin/devices`, поле `id`. Это самое свежее показание, какое есть, поэтому оно заодно ложится на карточку планшета, не дожидаясь следующего обхода. Тем же запросом проверяют, верно ли задан адрес управления. Отвечает 200 даже тогда, когда планшет не отозвался: причина стоит в поле `error`, а `reachable` равно `false`. Отказом 502, в отличие от команд, этот путь не отвечает.",
      req: null,
      res: [["`checkedUtc`", "когда снято"], ["`reachable`", "отозвался ли планшет"],
            ["`error`", "почему не отозвался. На свежей установке это «Управление планшетами выключено в настройках.»"],
            ["`batteryPercent`, `charging`", "заряд и стоит ли на зарядке"],
            ["`wifiSignalPercent`, `wifiSsid`", "качество связи и сеть"],
            ["`storageFreePercent`", "сколько свободного места"]],
      fail: [["404", "планшета с таким номером нет. Тело пустое"]],
      о: '{\n  "checkedUtc": "2026-08-25T10:57:24.9Z",\n  "reachable": false,\n  "error": "Управление планшетами выключено в настройках.",\n  "batteryPercent": null,\n  "charging": null,\n  "wifiSignalPercent": null,\n  "wifiSsid": null,\n  "storageFreePercent": null,\n  "memoryFreePercent": null,\n  "brightnessPercent": null,\n  "screenOn": null,\n  "deviceOwner": null,\n  "appVersion": null,\n  "androidVersion": null,\n  "model": null\n}',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/devices/{ПЛАНШЕТ}/kiosk/health'
    },
    {
      g: "ref-adm-control", m: "GET", p: "/api/admin/devices/{id}/kiosk/screenshot", who: "Кука админа",
      d: "Снимок экрана планшета. В адресе номер планшета: `GET /api/admin/devices`, поле `id`. Отдаётся как изображение, а не как JSON: это единственный ответ такого вида во всём админском API, поэтому в образце стоит `-o snimok.png`.",
      req: null,
      res: [["тело", "картинка, обычно `image/png`"]],
      fail: [["404", "планшета с таким номером нет. Тело пустое"],
             ["502", "планшет не ответил: в теле `error` с причиной"]],
      s: 'curl -b "sk_admin=КУКА" \\\n  -o snimok.png \\\n  {BASE}/api/admin/devices/{ПЛАНШЕТ}/kiosk/screenshot'
    },

    // ---------------------------------------------------------------- админка: расписание
    {
      g: "ref-adm-schedule", m: "GET", p: "/api/admin/schedule/actions", who: "Кука админа",
      d: "Какие действия умеет расписание. Список отдаёт сервер, чтобы интерфейс и исполнитель не могли разойтись в именах.",
      req: null,
      res: [["`key`", "имя действия: `screen-on`, `screen-off`, `wake`, `brightness`, `volume`, `return-slides`, `reload`, `restart-app`, `clear-cache`, `reboot`, `beep`, `toast`, `say`"],
            ["`title`", "как оно называется для человека"],
            ["`needsValue`", "нужно ли число 0..100 (яркость, громкость)"],
            ["`needsText`", "нужен ли текст (сообщение, произнести)"],
            ["`catchUp`", "можно ли выполнить с опозданием, если сервис был выключен в назначенный момент. Включение экрана утром догонять надо, перезагрузку нельзя: опоздавшая на полчаса команда перезагрузит парк посреди рабочего дня"]],
      fail: [],
      о: '[\n  { "key": "screen-on", "title": "Включить экран", "needsValue": false, "needsText": false, "catchUp": true },\n  { "key": "screen-off", "title": "Выключить экран", "needsValue": false, "needsText": false, "catchUp": true }\n]',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/schedule/actions', try: true
    },
    {
      g: "ref-adm-schedule", m: "GET", p: "/api/admin/schedule", who: "Кука админа",
      d: "Правила расписания и часы сервера. Часы здесь потому, что оператор задаёт время по ним, и это должно быть видно, а не подразумеваться: если пояс сервера не тот, в котором живёт оператор, окно открывается со сдвигом, и выглядит это как ошибка на день.",
      req: null,
      res: [["`rules[]`", "`id`, `enabled`, `time` (ЧЧ:ММ), `days` (1 понедельник .. 7 воскресенье, пусто означает каждый день), `action`, `value`, `text`, `target`, `deviceIds`, `skipBusy`, `note`, `lastRunUtc`, `lastResult`, `lastRunLocalDate`"],
            ["`serverDate`, `serverTime`", "дата и время сервера"],
            ["`serverZone`, `serverOffset`", "пояс сервера и его сдвиг"]],
      fail: [],
      о: '{\n  "rules": [],\n  "serverDate": "2026-08-25",\n  "serverTime": "10:57",\n  "serverZone": "Coordinated Universal Time",\n  "serverOffset": "00:00:00"\n}',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/schedule', try: true
    },
    {
      g: "ref-adm-schedule", m: "PUT", p: "/api/admin/schedule", who: "Кука админа",
      d: "Сохранить весь список правил целиком. Частичного изменения нет: список короткий, и целиком его сохранять честнее, чем сводить правки.",
      req: [["тело", "массив правил", "тот же вид, что отдаёт `GET /api/admin/schedule` в поле `rules`"]],
      res: [["`rules`", "сохранённый список, каким он стал"]],
      fail: [],
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'[{"time":"07:30","days":[1,2,3,4,5],"action":"screen-on","target":"all","skipBusy":true}]\' \\\n  {BASE}/api/admin/schedule'
    },
    {
      g: "ref-adm-schedule", m: "POST", p: "/api/admin/schedule/{id}/run", who: "Кука админа",
      d: "Выполнить правило прямо сейчас, не дожидаясь назначенного времени. Так его и проверяют. Заглушка `RULE_ID` в адресе это номер правила: `GET /api/admin/schedule`, поле `rules[].id`; заглушка `RULE_ID`, подставленная как есть, отвечает 404 с пустым телом.",
      req: null,
      res: [["`ok`", "`true`"], ["`result`", "что вышло: по скольким планшетам прошло и что не удалось"]],
      fail: [["404", "правила с таким номером нет. Тело пустое"]],
      s: 'curl -X POST -b "sk_admin=КУКА" {BASE}/api/admin/schedule/RULE_ID/run'
    },

    // ---------------------------------------------------------------- админка: уведомления и журнал
    {
      g: "ref-adm-alerts", m: "GET", p: "/api/admin/alerts", who: "Кука админа",
      d: "Уведомления оператору: планшет пропал со связи, накопились ошибки, дубль кода. У каждого уведомления постоянный номер по его причине, поэтому одна и та же беда не копит записи, а обновляет одну.",
      req: null,
      res: [["`unacknowledged`", "сколько непрочитанных"],
            ["`alerts[]`", "`id`, `kind` (`offline`, `errors`, `duplicate`, `test`), `severity` (`warn` или `error`), `title`, `detail`, `sinceUtc`, `updatedUtc`, `deviceId`, `deviceName`, `acknowledged`. Поле `id` это и есть `ALERT_ID` из образцов ниже, и оно говорящее: `test:manual`, `offline:dev-24386a4b78`"]],
      fail: [],
      о: '{\n  "unacknowledged": 1,\n  "alerts": [\n    {\n      "id": "test:manual",\n      "kind": "test",\n      "severity": "warn",\n      "title": "Тестовое уведомление",\n      "detail": "Проверка: уведомления доходят до оператора. Можно закрыть.",\n      "sinceUtc": "2026-08-25T10:57:26.4537567Z",\n      "updatedUtc": "2026-08-25T10:57:26.4548433Z",\n      "deviceId": null,\n      "deviceName": null,\n      "acknowledged": false\n    }\n  ]\n}',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/alerts', try: true
    },
    {
      g: "ref-adm-alerts", m: "POST", p: "/api/admin/alerts/ack", who: "Кука админа",
      d: "Отметить уведомление прочитанным. Оно не исчезает: пока причина не ушла, запись остаётся, просто перестаёт мигать. Номер уведомления берётся из `GET /api/admin/alerts`, поле `alerts[].id`, и он говорящий: `test:manual` у тестового, `offline:dev-24386a4b78` у пропавшего планшета.",
      т: "Тело необязательно. С телом отмечается одно уведомление, без тела вовсе отмечаются все и ответ тот же 200.",
      req: [["`id`", "строка", "какое отметить: `GET /api/admin/alerts`, поле `alerts[].id`. Без тела отмечаются все"]],
      res: [["`ok`", "`true`"]], fail: [], о: '{ "ok": true }',
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"id":"offline:{ПЛАНШЕТ}"}\' \\\n  {BASE}/api/admin/alerts/ack'
    },
    {
      g: "ref-adm-alerts", m: "GET", p: "/api/admin/alerts/settings", who: "Кука админа",
      d: "Пороги уведомлений.",
      req: null,
      res: [["`enabled`", "включены ли уведомления"],
            ["`offlineMinutes`", "через сколько минут молчания планшет считается пропавшим"],
            ["`errorCount`, `errorWindowMinutes`", "сколько ошибок и за какое время поднимают уведомление"]],
      fail: [],
      о: '{ "enabled": true, "offlineMinutes": 10, "errorCount": 5, "errorWindowMinutes": 10 }',
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/alerts/settings', try: true
    },
    {
      g: "ref-adm-alerts", m: "PUT", p: "/api/admin/alerts/settings", who: "Кука админа",
      d: "Сохранить пороги уведомлений. Числа приводятся к разумным границам: минуты 1..1440, "
         + "число ошибок 1..1000. Опечатка в одну цифру иначе либо выключает сторожа, либо "
         + "заставляет его звонить непрерывно. Взятое значение всегда возвращается в ответе, "
         + "поэтому сверяйте с ним, а не с тем, что отправили.",
      req: [["`enabled`", "булев", "включить уведомления"],
            ["`offlineMinutes`", "число", "порог молчания планшета, 1..1440"],
            ["`errorCount`", "число", "сколько ошибок поднимают уведомление, 1..1000"],
            ["`errorWindowMinutes`", "число", "за какое время они считаются, 1..1440"]],
      res: [["то же, что у `GET`", "пороги, которые взяты на самом деле, уже приведённые к границам"]],
      fail: [["400", "`{\"error\":\"settings required\"}`, если тело пустое"]],
      s: 'curl -X PUT -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"enabled":true,"offlineMinutes":10,"errorCount":5,"errorWindowMinutes":10}\' \\\n  {BASE}/api/admin/alerts/settings'
    },
    {
      g: "ref-adm-alerts", m: "POST", p: "/api/admin/alerts/test", who: "Кука админа",
      d: "Безобидное тестовое уведомление: проверить, доходят ли уведомления до оператора. Номер у него постоянный, поэтому повторные нажатия обновляют одну запись, а не копят их.",
      req: null, res: [["`ok`", "`true`"]], fail: [],
      s: 'curl -X POST -b "sk_admin=КУКА" {BASE}/api/admin/alerts/test',
      try: { тело: null }
    },
    {
      g: "ref-adm-alerts", m: "DELETE", p: "/api/admin/alerts/{id}", who: "Кука админа",
      d: "Закрыть уведомление руками. Заглушка `ALERT_ID` в адресе это номер уведомления: `GET /api/admin/alerts`, поле `alerts[].id`, вид `test:manual`. Если причина не ушла, оно поднимется снова при следующем обходе.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["404", "уведомления с таким номером нет. Тело пустое"]],
      s: 'curl -X DELETE -b "sk_admin=КУКА" {BASE}/api/admin/alerts/ALERT_ID'
    },
    {
      g: "ref-adm-alerts", m: "GET", p: "/api/admin/logs", who: "Кука админа",
      d: "Журнал сбоев сервиса и планшетов. `total` это сколько записей подошло под отбор, а не сколько их всего: иначе при выбранном уровне оператор читал бы «Показано 12 из 1843» как «остальное от меня спрятали».",
      req: [["`level`", "строка в строке запроса", "`error`, `warn` или `info`"],
            ["`q`", "строка в строке запроса", "поиск по тексту, источнику и имени планшета"],
            ["`limit`", "число в строке запроса", "сколько вернуть. По умолчанию 300"]],
      res: [["`total`", "сколько записей подошло под отбор"],
            ["`entries[]`", "`id`, `utc`, `level`, `source`, `message`, `detail`, `deviceId`, `deviceName`"]],
      fail: [],
      о: '{\n  "total": 1,\n  "entries": [\n    {\n      "id": 1,\n      "utc": "2026-08-25T10:49:07.175026Z",\n      "level": "info",\n      "source": "service",\n      "message": "Сервис запущен",\n      "detail": null,\n      "deviceId": null,\n      "deviceName": null\n    }\n  ]\n}',
      s: 'curl -b "sk_admin=КУКА" "{BASE}/api/admin/logs?level=error&limit=50"',
      try: { путь: "/api/admin/logs?limit=20" }
    },
    {
      g: "ref-adm-alerts", m: "DELETE", p: "/api/admin/logs", who: "Кука админа",
      d: "Очистить журнал и оба его файла. Действие необратимое.",
      req: null, res: [["`ok`", "`true`"]], fail: [],
      s: 'curl -X DELETE -b "sk_admin=КУКА" {BASE}/api/admin/logs'
    },

    // ---------------------------------------------------------------- админка: показ и сканирование
    {
      g: "ref-adm-show", m: "POST", p: "/api/admin/show-document", who: "Кука админа",
      d: "То же, что внешнее `POST /api/ext/show-document`, только адресат задан строкой `device:{id}`, и всегда ровно один планшет: данные подписанта не должны попасть больше никуда. Номер планшета берётся из `GET /api/admin/devices`, поле `id`, вид `dev-24386a4b78`; в образце ниже стоит настоящий номер этой установки. Кодом рабочего места этот путь не адресуется: место понимает только внешнее API. Помощник «Отправить запрос» на вкладке «Документ» шлёт ровно то же тело, что внешняя система.",
      req: [["`target`", "строка", "`device:{id}` или просто номер планшета: `GET /api/admin/devices`, поле `id`"],
            ["`documentCode`", "строка", "код документа: `GET /api/admin/documents`, поле `code`. Без него документ по умолчанию"],
            ["`fields`", "объект", "значения тегов"],
            ["`checkboxes`", "массив", "пункты согласия"],
            ["`groups`", "массив", "выбор в группах"],
            ["`images`", "объект", "картинки заказа"]],
      res: [["`ok`", "`true`"], ["`document`", "код показанного документа"],
            ["`missingPlaceholders`", "теги документа, которых в запросе не было вовсе"],
            ["`emptyPlaceholders`", "теги, которые прислали пустыми: в тексте останется дыра, а условие на них погаснет"],
            ["`placed`", "куда встал каждый присланный пункт. Пустой, если пунктов не присылали"],
            ["`dropped`", "список потерь. Пустой означает «доехало всё»"]],
      fail: [["400", "«Планшет «X» отозван: показывать на нём ничего нельзя. Верните его в работу на вкладке «Планшеты» или выберите другой.»"],
             ["400", "«Документ показывается только на один планшет. Выберите планшет.»"],
             ["400", "«Тег «X» принимает только true или false, получено: ...»"],
             ["400", "«Документ с кодом «X» не найден. Доступные коды: ...»"],
             ["400", "«Тег «X» используется в условии по возрасту (или по сроку), но значение «...» не похоже на дату.»"],
             ["400", "«В документе «...» нет ни одной страницы: показывать нечего. Добавьте страницу на вкладке «Документ».»"],
             ["400", "отказ по картинке, с именем тега"],
             ["400", "тела нет вовсе или это не JSON: пустой ответ без текста"]],
      о: '{\n  "ok": true,\n  "document": "main",\n  "missingPlaceholders": [],\n  "emptyPlaceholders": [],\n  "dropped": [],\n  "placed": []\n}',
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"target":"device:{ПЛАНШЕТ}","fields":{"ФИО":"Иванова Анна"}}\' \\\n  {BASE}/api/admin/show-document'
    },
    {
      g: "ref-adm-show", m: "POST", p: "/api/admin/show-slides", who: "Кука админа",
      d: "Вернуть один планшет к рекламе. У каждой причины отказа свой текст: «Возврат к рекламе выполняется для одного планшета» в ответ на выбранный планшет читается как поломка формы, а оператор в этот момент пытается убрать с экрана документ с данными клиента и должен понимать, что происходит.",
      req: [["`target`", "строка", "`device:{id}` или просто номер планшета: `GET /api/admin/devices`, поле `id`"]],
      res: [["`ok`", "`true`"]], о: '{ "ok": true }',
      fail: [["400", "«Планшет «X» отозван: его экран уже очищен, возвращать к рекламе нечего.»"],
             ["400", "«Планшета «X» в системе нет: он удалён, а его экран очищен при удалении.»"],
             ["400", "«Возврат к рекламе выполняется для одного планшета. Выберите планшет.»"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"target":"device:{ПЛАНШЕТ}"}\' \\\n  {BASE}/api/admin/show-slides'
    },
    {
      g: "ref-adm-show", m: "POST", p: "/api/admin/scan/start", who: "Кука админа",
      d: "Открыть камеру на одном планшете. Номер планшета берётся из `GET /api/admin/devices`, поле `id`; в образце ниже стоит настоящий номер этой установки. В отличие от внешнего `scan-request`, ответа с кодом здесь нет: считанное придёт в список сканирований и живьём в админку.",
      req: [["`target`", "строка", "`device:{id}` или просто номер планшета: `GET /api/admin/devices`, поле `id`"]],
      res: [["`ok`", "`true`"], ["`deviceId`", "на каком планшете открыта камера"]],
      о: '{ "ok": true, "deviceId": "dev-bc4c069639" }',
      fail: [["400", "«Выберите планшет для сканирования.» Отозванный планшет сюда тоже не проходит"],
             ["409", "«Планшет «X» сейчас не на связи, команда сканирования до него не дойдёт. Проверьте, что планшет включён, есть Wi-Fi и открыта страница киоска.»"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"target":"device:{ПЛАНШЕТ}"}\' \\\n  {BASE}/api/admin/scan/start'
    },
    {
      g: "ref-adm-show", m: "POST", p: "/api/admin/scan/stop", who: "Кука админа",
      d: "Закрыть камеру на планшете. Номер планшета берётся из `GET /api/admin/devices`, поле `id`.",
      req: [["`target`", "строка", "`device:{id}` или просто номер планшета: `GET /api/admin/devices`, поле `id`"]],
      res: [["`ok`", "`true`"], ["`deviceId`", "на каком планшете закрыта камера"]],
      о: '{ "ok": true, "deviceId": "dev-bc4c069639" }',
      fail: [["400", "«Выберите планшет.»"]],
      s: 'curl -X POST -b "sk_admin=КУКА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"target":"device:{ПЛАНШЕТ}"}\' \\\n  {BASE}/api/admin/scan/stop'
    },
    {
      g: "ref-adm-show", m: "GET", p: "/api/admin/scans", who: "Кука админа",
      d: "Считанные коды, новые сверху. То же, что внешнее `GET /api/ext/scans`, но с другими пределами.",
      req: [["`limit`", "число в строке запроса", "сколько вернуть. По умолчанию 200, не меньше 1 и не больше 1000"]],
      res: [["`id`, `createdUtc`, `code`, `format`", "запись сканирования. `id` это и есть `SCAN_ID` из образца удаления ниже, вид `20260825-105725-708-D1D572`"],
            ["`deviceId`, `deviceName`, `workstationId`, `workstationName`", "где считали"]],
      fail: [],
      о: '[\n  {\n    "id": "20260825-105725-708-D1D572",\n    "createdUtc": "2026-08-25T10:57:25.7088579Z",\n    "code": "4600000000001",\n    "format": "EAN_13",\n    "deviceId": "dev-bc4c069639",\n    "deviceName": "Ресепшн 1",\n    "workstationId": "ws-3d55b0ab64",\n    "workstationName": "Кабинет 12"\n  }\n]',
      s: 'curl -b "sk_admin=КУКА" "{BASE}/api/admin/scans?limit=20"',
      try: { путь: "/api/admin/scans?limit=20" }
    },
    {
      g: "ref-adm-show", m: "DELETE", p: "/api/admin/scans/{id}", who: "Кука админа",
      d: "Удалить одну запись сканирования. Заглушка `SCAN_ID` в адресе это номер записи: `GET /api/admin/scans`, поле `id`, вид `20260825-105725-708-D1D572`; заглушка `SCAN_ID`, подставленная как есть, отвечает 404 с пустым телом.",
      req: null, res: [["`ok`", "`true`"]],
      fail: [["404", "записи с таким номером нет. Тело пустое"]],
      s: 'curl -X DELETE -b "sk_admin=КУКА" {BASE}/api/admin/scans/SCAN_ID'
    },

    // ---------------------------------------------------------------- админка: подписи
    {
      g: "ref-adm-sign", m: "GET", p: "/api/admin/signatures", who: "Кука админа",
      d: "Список подписей, новые сверху. Список ограничен намеренно: после года работы в архиве десятки тысяч записей, и отдать их все значило бы остановить всякую другую работу с хранилищем.",
      req: [["`limit`", "число в строке запроса", "сколько вернуть. По умолчанию 200, не меньше 1 и не больше 1000"]],
      res: [["`id`, `createdUtc`", "номер записи (он же `SIGN_ID` в образцах ниже, вид `20260825-105726-271-9C07E7`) и когда подписали"],
            ["`documentTitle`, `documentCode`, `documentName`", "что подписали. По коду через год видно, что именно"],
            ["`deviceId`, `deviceName`, `workstationName`", "где подписали"],
            ["`checkedCount`, `totalCount`", "сколько пунктов отмечено из скольких"]],
      fail: [],
      о: '[\n  {\n    "id": "20260825-105726-271-9C07E7",\n    "createdUtc": "2026-08-25T10:57:26.2718179Z",\n    "documentTitle": "Согласие на обработку персональных данных",\n    "documentCode": "main",\n    "documentName": "Согласие на обработку персональных данных",\n    "deviceId": "dev-bc4c069639",\n    "deviceName": "Ресепшн 1",\n    "workstationName": "Кабинет 12",\n    "checkedCount": 1,\n    "totalCount": 1\n  }\n]',
      s: 'curl -b "sk_admin=КУКА" "{BASE}/api/admin/signatures?limit=20"',
      try: { путь: "/api/admin/signatures?limit=20" }
    },
    {
      g: "ref-adm-sign", m: "GET", p: "/api/admin/signatures/{id}", who: "Кука админа",
      d: "Вся запись подписи целиком: отмеченные пункты, выбор в группах, вписанные значения, отсканированные коды, данные подписанта и снимок документа, который человек видел. Заглушка `SIGN_ID` в адресе это номер записи: `GET /api/admin/signatures`, поле `id`, вид `20260825-105726-271-9C07E7`.",
      req: null,
      о: '{\n  "id": "20260825-105726-271-9C07E7",\n  "createdUtc": "2026-08-25T10:57:26.2718179Z",\n  "documentTitle": "Согласие на обработку персональных данных",\n  "documentCode": "main",\n  "documentName": "Согласие на обработку персональных данных",\n  "deviceId": "dev-bc4c069639",\n  "deviceName": "Ресепшн 1",\n  "workstationId": "ws-3d55b0ab64",\n  "workstationName": "Кабинет 12",\n  "items": [\n    { "key": "", "label": "Согласен на обработку", "checked": true,\n      "checkedFromApi": null, "changedBySigner": false, "api": false,\n      "apiText": false, "labelBefore": null }\n  ],\n  "groups": [], "signatures": [], "scans": [], "inputs": [],\n  "fields": null,\n  "submissionId": "proba-1"\n}',
      res: [["`items[]`", "пункты: надпись и отмечен ли"],
            ["`groups[]`", "выбор в группах вместе со всеми вариантами, из которых выбирали"],
            ["`signatures[]`", "подписи, поставленные внутри страниц: имя, надпись, имя файла"],
            ["`scans[]`, `inputs[]`", "коды и вписанное клиентом"],
            ["`fields`", "данные подписанта, которые документ действительно использовал"],
            ["`submissionId`", "номер отправки, по которому распознаётся повтор"]],
      fail: [["404", "записи с таким номером нет. Тело пустое"]],
      s: 'curl -b "sk_admin=КУКА" {BASE}/api/admin/signatures/SIGN_ID'
    },
    {
      g: "ref-adm-sign", m: "GET", p: "/api/admin/signatures/{id}/image", who: "Кука админа",
      d: "Итоговая подпись под документом, картинкой PNG. Заглушка `SIGN_ID` в адресе это номер записи: `GET /api/admin/signatures`, поле `id`, вид `20260825-105726-271-9C07E7`. Ответ это файл, а не JSON, поэтому в образце стоит `-o`.",
      req: null, res: [["тело", "`image/png`"]],
      fail: [["404", "записи или картинки нет. Тело пустое"]],
      s: 'curl -b "sk_admin=КУКА" \\\n  -o podpis.png \\\n  {BASE}/api/admin/signatures/SIGN_ID/image'
    },
    {
      g: "ref-adm-sign", m: "GET", p: "/api/admin/signatures/{id}/image/{file}", who: "Кука админа",
      d: "Подпись, поставленная внутри страницы. В адресе две заглушки, и обе берутся из записи: `SIGN_ID` это `GET /api/admin/signatures`, поле `id`, а `ИМЯ_ФАЙЛА` это `GET /api/admin/signatures/{id}`, поле `signatures[].file`. Имя файла проверяется по самой записи, поэтому произвольный путь сюда не подставить.",
      req: [["`{file}`", "часть адреса", "имя файла из поля `signatures[].file` записи `GET /api/admin/signatures/{id}`"]],
      res: [["тело", "`image/png`"]],
      fail: [["404", "записи нет, либо такого файла в ней нет. Тело пустое"]],
      s: 'curl -b "sk_admin=КУКА" \\\n  -o podpis-sign1.png \\\n  {BASE}/api/admin/signatures/SIGN_ID/image/ИМЯ_ФАЙЛА'
    },
    {
      g: "ref-adm-sign", m: "GET", p: "/api/admin/signatures/{id}/pdf", who: "Кука админа",
      d: "Готовый PDF подписанного документа. Заглушка `SIGN_ID` в адресе это номер записи: `GET /api/admin/signatures`, поле `id`, вид `20260825-105726-271-9C07E7`. Если PDF не собрался при подписании, он собирается сейчас из той же записи, документа и картинки подписи: разовый сбой не должен оставлять подписанную запись навсегда без бумаги.",
      req: null, res: [["тело", "`application/pdf`, имя файла это номер записи"]],
      fail: [["404", "записи нет, либо PDF не удалось собрать даже сейчас. Тело пустое"]],
      s: 'curl -b "sk_admin=КУКА" \\\n  -o podpis.pdf \\\n  {BASE}/api/admin/signatures/SIGN_ID/pdf'
    },

    // ---------------------------------------------------------------- вне обеих групп
    {
      g: "ref-open", m: "GET", p: "/healthz", who: "Кто угодно",
      d: "Проверка живости для наблюдения за сервисом (systemd, внешний монитор). Без ключа, без куки и без ограничения частоты: монитор опрашивает её постоянно, и ограничивать его значило бы получать ложные тревоги.",
      req: null, res: [["`status`", "`ok`"]], fail: [], о: '{ "status": "ok" }',
      s: 'curl {BASE}/healthz', try: true
    },
    {
      g: "ref-open", m: "POST", p: "/api/kiosk/enroll", who: "Кто угодно",
      d: "Активация планшета по коду. Код одноразовый: погашенный второй раз не сработает. В ответе приходит токен, который планшет хранит у себя и присылает дальше заголовком `Authorization: Bearer`.",
      req: [["`code`", "строка", "код активации из `POST /api/ext/enrollments`, из `POST /api/admin/devices/enroll` или из админки, вид `3HV6-NWKY`"]],
      res: [["`deviceId`", "номер планшета, вид `dev-24386a4b78`"], ["`name`", "имя, заданное при создании кода"],
            ["`token`", "токен планшета. Это и есть `ТОКЕН_ПЛАНШЕТА` в образцах ниже. Показывается один раз: у сервера остаётся только его хэш"]],
      о: '{ "deviceId": "dev-2f4b1ae310", "name": "Ресепшн 1", "token": "dev-2f4b1ae310.T8O..." }',
      fail: [["400", "`{\"error\":\"invalid or expired code\"}`"],
             ["429", "«Слишком много запросов с этого адреса. Повторите через N с.» Предел 20 в минуту"]],
      s: 'curl -X POST -H "Content-Type: application/json" \\\n  -d \'{"code":"123456"}\' \\\n  {BASE}/api/kiosk/enroll'
    },
    {
      g: "ref-open", m: "POST", p: "/api/sign", who: "Токен планшета",
      d: "Отправка подписи. Шлёт её сам планшет своим токеном: `ТОКЕН_ПЛАНШЕТА` в образце это поле `token` из ответа `POST /api/kiosk/enroll`, оно показывается один раз и живёт на планшете. Чужой системе тут делать нечего. Подпись имеет смысл только пока на этом планшете открыт документ: отправка вне этого окна была бы записана без данных подписанта и с сырыми `{{тегами}}` в PDF, что выглядит как годное согласие, а стоит ничего.",
      req: [["`signature`", "строка", "итоговая подпись, PNG в виде data URL. До 3 МБ строкой и до 2 МБ после разбора"],
            ["`items`", "массив", "отмеченные пункты. Не больше 200, надпись до 2000 знаков"],
            ["`signatures`", "массив", "подписи внутри страниц. Берутся первые 40, каждая проверяется как итоговая"],
            ["`scans`", "массив", "коды, считанные внутри документа. Не больше 40, код до 512 знаков"],
            ["`groups`", "массив", "выбор в группах. Не больше 200, тексты до 2000 знаков"],
            ["`inputs`", "массив", "вписанное клиентом. Не больше 200, тексты до 2000 знаков"],
            ["`submissionId`", "строка до 128 знаков", "номер отправки: по нему распознаётся повтор после потери ответа"],
            ["`sessionId`", "строка", "имя показа, к которому относится подпись"]],
      res: [["`id`", "номер записи подписи"],
            ["`duplicate`", "`true`, если это повтор и запись уже была"]],
      fail: [["400", "`signature required`, `signature image too large`, `invalid signature image`, `invalid submissionId`, `invalid items`, `invalid scans`, `invalid groups`, `invalid inputs`, `device required`"],
             ["409", "`no document is being signed on this tablet`"],
             ["409", "`stale submission: another document is open`, если повтор пришёл, когда на планшете уже другой документ"],
             ["409", "«На планшет уже отправлен другой документ, эта подпись к нему не относится. Отправьте документ на планшет заново.»"]],
      s: '# Шлёт сам планшет, своим токеном\ncurl -X POST -H "Authorization: Bearer ТОКЕН_ПЛАНШЕТА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"signature":"data:image/png;base64,...","items":[]}\' \\\n  {BASE}/api/sign'
    },
    {
      g: "ref-open", m: "POST", p: "/api/scan", who: "Токен планшета",
      d: "Считанный код от планшета. Шлёт его сам планшет своим токеном: `ТОКЕН_ПЛАНШЕТА` в образце это поле `token` из ответа `POST /api/kiosk/enroll`. Здесь же код передаётся тому, кто ждёт его в `POST /api/ext/scan-request` прямо сейчас.",
      req: [["`code`", "строка", "значение кода. Обязательно, до 512 знаков"],
            ["`format`", "строка", "вид кода: `QR_CODE`, `EAN_13` и прочие"]],
      res: [["`id`", "номер записи сканирования"]],
      fail: [["400", "`{\"error\":\"code required\"}`"], ["400", "`{\"error\":\"code too long\"}`"],
             ["429", "«Слишком много запросов с этого адреса. Повторите через N с.» Предел 60 в минуту"]],
      s: '# Шлёт сам планшет, своим токеном\ncurl -X POST -H "Authorization: Bearer ТОКЕН_ПЛАНШЕТА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"code":"4600000000001","format":"EAN_13"}\' \\\n  {BASE}/api/scan'
    },
    {
      g: "ref-open", m: "POST", p: "/api/log", who: "Токен планшета",
      d: "Планшет сообщает о своей беде: ошибка на экране, отказ камеры, неудачная отправка. Шлёт он это своим токеном: `ТОКЕН_ПЛАНШЕТА` в образце это поле `token` из ответа `POST /api/kiosk/enroll`. Записи ложатся на вкладку «Логи», и оператор видит беду парка там, а не обходит планшеты по одному. Диагностика ограничена отдельно, чтобы планшет, застрявший в петле ошибок, не съел предел, от которого зависит отправка подписи.",
      req: [["`message`", "строка", "что случилось. Обязательно"],
            ["`level`", "строка", "`error`, `warn` или `info`. Всё прочее приводится к `error`"],
            ["`detail`", "строка", "подробности: стек, обстоятельства"]],
      res: [["`ok`", "`true`"]],
      fail: [["400", "`{\"error\":\"message required\"}`"],
             ["429", "«Слишком много запросов с этого адреса. Повторите через N с.» Предел 30 в минуту"]],
      s: '# Шлёт сам планшет, своим токеном\ncurl -X POST -H "Authorization: Bearer ТОКЕН_ПЛАНШЕТА" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"level":"error","message":"Камера не открылась"}\' \\\n  {BASE}/api/log'
    },
    {
      g: "ref-open", m: "POST", p: "/api/admin/login", who: "Кто угодно",
      d: "Вход в админку по паролю. Ставит куку `sk_admin` на 30 дней: `HttpOnly`, `SameSite=Lax`, `Secure` на HTTPS. Значение куки это не случайный номер сессии, а производная от пароля, поэтому вход переживает перезапуск сервиса без серверного хранилища сессий, а смена пароля разом гасит все входы.",
      req: [["`password`", "строка", "пароль администратора: тот, которым вы входите в эту админку. Это и есть `ПАРОЛЬ` в образце"]],
      res: [["`ok`", "`true`"], ["кука `sk_admin`", "ставится заголовком `Set-Cookie`. Её значение и есть `КУКА` в образцах админской группы: смотрите `-i` в curl или средства разработчика браузера"]],
      о: 'HTTP/1.1 200 OK\nSet-Cookie: sk_admin=9DE2CA54EA81648DE3DC37193A58FD59B7344E294CA510FF897E6311C67E7FBE;\n            max-age=2592000; path=/; httponly; samesite=lax\nContent-Type: application/json\n\n{ "ok": true }',
      fail: [["401", "`{\"ok\":false,\"error\":\"wrong password\"}`"],
             ["429", "«Слишком много запросов с этого адреса. Повторите через N с.» Предел 10 в минуту: это единственный админский путь с ограничением частоты, потому что пароль можно подбирать"]],
      s: 'curl -i -X POST -H "Content-Type: application/json" \\\n  -d \'{"password":"ПАРОЛЬ"}\' \\\n  {BASE}/api/admin/login'
    },
    {
      g: "ref-open", m: "POST", p: "/api/admin/logout", who: "Кто угодно",
      d: "Выход: кука удаляется. Ограничения частоты нет, проверять нечего.",
      req: null, res: [["`ok`", "`true`"]], fail: [],
      s: 'curl -X POST {BASE}/api/admin/logout'
    },
    {
      g: "ref-open", m: "GET", p: "/api/admin/me", who: "Кто угодно",
      d: "Вошли вы или нет. Отвечает всегда 200: это проверка состояния, а не защищённый путь.",
      req: null, res: [["`authenticated`", "`true` у вошедшего администратора, иначе `false`"]],
      fail: [], о: '{ "authenticated": false }',
      s: 'curl {BASE}/api/admin/me', try: true
    },
    {
      g: "ref-open", m: "WS", p: "/hub/kiosk", who: "Токен планшета или кука админа",
      d: "Живой канал SignalR. Планшет получает по нему команды показа, возврата к рекламе и сканирования, а админка узнаёт о событиях без перезагрузки страницы: «список планшетов изменился», «пришла новая подпись», «считан код», «изменились уведомления», «на планшет отправлен документ», а окно наблюдения ещё и состояние экрана планшета. Это не метод REST: обычным запросом его не позвать.",
      req: [["`access_token`", "строка в строке запроса", "токен планшета из ответа `POST /api/kiosk/enroll`, поле `token`. Единственное место, где токен принимается строкой запроса: рукопожатие WebSocket не умеет слать заголовки. Везде остальном это запрещено, чтобы токены не оседали в журналах прокси"]],
      res: [["события к планшету", "`ShowDocument`, `ShowSlides`, `StartScan`, `StopScan`, `Identify`, `Revoked`"],
            ["события к админке", "изменения списка планшетов, подписи, коды, уведомления, состояние экрана"]],
      fail: [["401", "нет токена планшета и нет куки админа. Подписаться на события админки может только администратор"]],
      s: '# Не REST: подключение SignalR из чужого кода\n# JS: new signalR.HubConnectionBuilder().withUrl("{BASE}/hub/kiosk").build()'
    }
  ];

  // ==================================================================
  // Сборка вкладки
  // ==================================================================
  // Все свёртки вкладки лежат одним списком: по нему работают и поиск, и кнопки «Развернуть всё»
  // и «Свернуть всё». Иначе поиск знал бы про статьи справочника и не знал про разделы
  // руководства, и слово, написанное в руководстве, вкладка бы «не находила».
  var апиКарточки = [];

  /// Строка, по которой ищут: метод, адрес, описание, все поля и все отказы сразу. Ищут по тому,
  /// что человек помнит, а помнит он то имя поля, из-за которого и полез сюда.
  function апиСтрокаПоиска() {
    var куски = Array.prototype.slice.call(arguments);
    return куски.join(" ").toLowerCase().replace(/`/g, "");
  }

  /// Статья справочника: метод, адрес, кто может звать, описание, поля, отказы, образец.
  function апиСтатья(ep, общие) {
    var м = ep.m.toLowerCase();
    var шапка = [
      el("span", "api-method api-" + м, ep.m),
      el("span", "api-path", ep.p),
      el("span", "api-who", ep.who)
    ];
    var тело = [];
    тело.push(апиФраза(ep.d));
    // Чем этот путь пускает и откуда это взять. Одной строкой в КАЖДОЙ статье: `КУКА` стоит в
    // семи десятках образцов, `ВАШ_КЛЮЧ` в полутора десятках, и человек, открывший одну статью,
    // не должен идти за объяснением в другой раздел. Ссылка объяснением не считается.
    var доступ = ep.who === "Ключ API"
      ? "Доступ: ключ в заголовке `X-Api-Key`. `ВАШ_КЛЮЧ` в образце это ключ с вкладки «API-ключи», кнопка «Создать»: он показывается один раз, при создании. Неверный, выключенный и отсутствующий дают одинаковое 401 `{\"error\":\"invalid api key\"}`. Вошедший администратор проходит и без ключа."
      : ep.who === "Кука админа"
        ? "Доступ: кука входа. `КУКА` в образце это значение куки `sk_admin` из заголовка `Set-Cookie` ответа `POST /api/admin/login` с паролем администратора. Скопированный дословно образец, где `КУКА` не заменена, отвечает 401 с пустым телом."
        : ep.who === "Токен планшета"
          ? "Доступ: токен планшета в заголовке `Authorization: Bearer`. `ТОКЕН_ПЛАНШЕТА` в образце это поле `token` из ответа `POST /api/kiosk/enroll` по коду активации: он живёт на самом планшете, у сервера только его хэш."
          : ep.who === "Кто угодно"
            ? "Доступ: свободный. Ни ключа, ни куки, ни токена этот путь не требует."
            : "Доступ: токен планшета в заголовке `Authorization: Bearer` (`POST /api/kiosk/enroll`, поле `token`) либо кука админа `sk_admin` из `POST /api/admin/login`.";
    тело.push(апиФраза(доступ, "p", "api-desc api-access"));
    тело.push(апиПодзаголовок("Что слать"));
    // Нужно ли тело, сказано в каждой статье и первой строкой. У чтения показан curl без тела,
    // и по одному образцу не видно, надо ли слать JSON: догадываться тут не о чем, поэтому
    // правило написано словами. Чтение идёт без тела, действие с телом JSON.
    тело.push(апиФраза(ep.т || (ep.m === "GET"
      ? ("Тело не нужно: это чтение. Ни `-d`, ни заголовка `Content-Type` не надо"
        + (ep.req && ep.req.length ? ", а параметры идут строкой запроса." : "."))
      : (ep.req && ep.req.length
        ? "Тело обязательно, и только JSON: заголовок `Content-Type: application/json`. Поля перечислены ниже."
        : "Тела нет: всё, что нужно, есть в адресе. Ни `-d`, ни заголовка `Content-Type` не надо.")),
      "p", "api-desc api-body-need"));
    if (ep.req && ep.req.length) тело.push(апиТаблица(["Поле", "Вид", "Что это"], ep.req, "api-tbl-req"));
    тело.push(апиПодзаголовок("Что придёт"));
    тело.push(апиТаблица(["Поле ответа", "Что означает"], ep.res && ep.res.length
      ? ep.res : [["`ok`", "`true`"]], "api-tbl-res"));
    // Настоящий ответ, снятый прогоном на свежей установке с одним планшетом. Таблица говорит,
    // что означает поле, но по ней не видно ответа целиком: где массив, где объект, что придёт
    // пустым. Интегратор разбирает ответ, а не таблицу.
    if (ep.о) {
      тело.push(апиФраза("Так выглядит настоящий ответ (снят на свежей установке с одним планшетом):", "p", "api-desc"));
      тело.push(апиОбразец(ep.о));
    }
    var отказы = (ep.fail || []).concat(общие || []);
    тело.push(апиПодзаголовок("Отказы"));
    тело.push(апиТаблица(["Код", "Тело ответа и причина"], отказы.length
      ? отказы : [["нет", "своих отказов у этого пути нет"]], "api-tbl-fail"));
    тело.push(апиПодзаголовок("Образец"));
    тело.push(апиОбразец(ep.s));
    // Кнопка отправки стоит там, где запрос ничего не портит: чтение, показ документа, возврат
    // к рекламе, предпросмотр, тестовое уведомление. У удаления и отзыва её нет нарочно:
    // «попробовать» удаление означает удалить.
    var отправка = null;
    if (ep.try) {
      отправка = {
        метод: ep.m,
        путь: (ep.try && ep.try.путь) || ep.p,
        тело: ep.try && ep.try.тело !== undefined ? ep.try.тело : null,
        заголовок: ep.m + " " + ep.p
      };
    }
    тело.push(апиДействия(ep.s, отправка));

    var карточка = апиСвёртка("api-ep", шапка, тело, false);
    карточка.поиск = апиСтрокаПоиска(ep.m, ep.p, ep.who, ep.d,
      JSON.stringify(ep.req || []), JSON.stringify(ep.res || []), JSON.stringify(отказы), ep.s, ep.о || "");
    карточка.вид = "путь";
    апиКарточки.push(карточка);
    return карточка;
  }

  /// Раздел руководства: свёртка, раскрытая по умолчанию.
  function апиРаздел(р) {
    var тело = el("div");
    р.строить(тело);
    var узлы = Array.prototype.slice.call(тело.childNodes);
    // Текст снимается здесь, до сборки свёртки: appendChild переносит узлы, и после сборки
    // временный ящик пуст. Из-за этого поиск не находил ни слова из руководства.
    var текст = тело.textContent || "";
    var карточка = апиСвёртка("api-sec", [el("span", "api-sec-title", р.заголовок)], узлы, true);
    карточка.id = р.id;
    карточка.поиск = апиСтрокаПоиска(р.заголовок, текст);
    карточка.вид = "раздел";
    апиКарточки.push(карточка);
    return карточка;
  }

  /// Оглавление: ссылки на разделы руководства и на группы справочника. Именно ссылки, а не
  /// адреса с решёткой: решётка в адресе переключает вкладки админки, и переход по оглавлению
  /// уводил бы со вкладки «API» вовсе.
  function апиОглавление(пункты) {
    var nav = el("nav", "api-nav");
    пункты.forEach(function (п) {
      var a = el("a", "api-nav-link" + (п.вид === "ref" ? " api-nav-ref" : ""), п.заголовок);
      a.href = "#";
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var цель = document.getElementById(п.id);
        if (!цель) return;
        if (цель.раскрыть) цель.раскрыть(true);
        цель.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      nav.appendChild(a);
    });
    return nav;
  }

  // Снимок значений, с которыми вкладка нарисована сейчас. Нужен, чтобы не перерисовывать её
  // второй раз, когда с сервера пришло ровно то же самое.
  var апиСнимокЗначений = "";

  /// Перечитать планшеты, места, документы и группы и подставить их в образцы. Из того, что
  /// помнит админка, брать нельзя: вкладку могли открыть до того, как завели планшет, и тогда
  /// образец звал бы место, которого нет, а читатель получил бы 404 и решил, что сломано API.
  function апиОбновитьЗначения() {
    return Promise.all([
      apiJson("/devices").catch(function () { return null; }),
      apiJson("/workstations").catch(function () { return null; }),
      apiJson("/documents").catch(function () { return null; }),
      apiJson("/groups").catch(function () { return null; })
    ]).then(function (п) {
      if (п[0]) апиСтенд.devices = п[0];
      if (п[2]) апиСтенд.docs = п[2];
      var планшеты = (п[0] || state.devices || []).filter(function (d) { return d && d.status !== "revoked"; });
      var места = п[1] || state.workstations || [];
      var доки = п[2] || (typeof docList !== "undefined" && docList ? docList : []);
      var группы = п[3] || state.groups || [];
      // Место берётся то, на котором стоит планшет: образец, собранный из места без планшета,
      // ответил бы «no tablet is assigned to this workstation», и это выглядело бы поломкой.
      var сПланшетом = планшеты.filter(function (d) { return d.workstation && d.workstation.externalId; })[0];
      var любоеМесто = места.filter(function (w) { return w.externalId; })[0];
      var док = доки.filter(function (d) { return d.isDefault; })[0] || доки[0];
      if (планшеты[0]) апиЗначения["{ПЛАНШЕТ}"] = планшеты[0].id;
      if (сПланшетом) апиЗначения["{МЕСТО}"] = сПланшетом.workstation.externalId;
      else if (любоеМесто) апиЗначения["{МЕСТО}"] = любоеМесто.externalId;
      if (сПланшетом && сПланшетом.workstationId) апиЗначения["{МЕСТО_ID}"] = сПланшетом.workstationId;
      else if (любоеМесто) апиЗначения["{МЕСТО_ID}"] = любоеМесто.id;
      if (док) {
        апиЗначения["{ДОКУМЕНТ}"] = док.code;
        апиЗначения["{ДОКУМЕНТ_ID}"] = док.id || док.code;
      }
      if (группы[0]) апиЗначения["{ГРУППА}"] = группы[0].id;
      return JSON.stringify(апиЗначения);
    }).catch(function () { return апиСнимокЗначений; });
  }

  function renderApiDocs() {
    апиНарисовать();
    апиОбновитьЗначения().then(function (снимок) {
      if (снимок === апиСнимокЗначений) return;
      апиСнимокЗначений = снимок;
      апиНарисовать();
    });
  }

  function апиНарисовать() {
    var base = window.location.origin;
    var baseEl = $("apiBaseUrl"); if (baseEl) baseEl.textContent = base;
    var wrap = $("apiDocsList"); if (!wrap) return;
    wrap.innerHTML = "";
    апиКарточки = [];

    var пункты = API_РАЗДЕЛЫ.map(function (р) { return { id: р.id, заголовок: р.заголовок, вид: "guide" }; })
      .concat(API_ГРУППЫ.map(function (г) { return { id: г.id, заголовок: г.заголовок, вид: "ref" }; }));
    wrap.appendChild(апиОглавление(пункты));

    API_РАЗДЕЛЫ.forEach(function (р) { wrap.appendChild(апиРаздел(р)); });

    API_ГРУППЫ.forEach(function (г) {
      var раздел = el("section", "api-group");
      раздел.id = г.id;
      раздел.appendChild(el("h3", "api-group-head", г.заголовок));
      // Общее для всего раздела печатается из признака группы, а не переписывается в каждую
      // заметку руками. Семь групп из десяти стояли без заметки вовсе, и слово «КУКА» из
      // образцов не было объяснено ни в одной: дословно скопированный образец отвечал 401, и
      // понять почему было негде.
      if (ОБЩЕЕ_ДЛЯ_ГРУППЫ[г.общие]) раздел.appendChild(апиФраза(ОБЩЕЕ_ДЛЯ_ГРУППЫ[г.общие], "p", "api-desc api-group-note"));
      if (г.note) раздел.appendChild(апиФраза(г.note, "p", "api-desc api-group-note"));
      var общие = г.общие === "ext" ? API_ОТКАЗЫ_EXT
        : г.общие === "admin" ? API_ОТКАЗЫ_ADMIN
          : г.общие === "планшет" ? API_ОТКАЗЫ_ПЛАНШЕТ : [];
      var своих = 0;
      API_ПУТИ.forEach(function (ep) {
        if (ep.g !== г.id) return;
        раздел.appendChild(апиСтатья(ep, общие));
        своих++;
      });
      раздел.дано = своих;
      wrap.appendChild(раздел);
    });

    апиПрименитьПоиск();
  }

  /// Отбор по строке поиска. Раскрывать найденное обязательно: иначе поиск оставлял бы на экране
  /// свёрнутые шапки, и найденное слово нигде не было бы видно.
  function апиПрименитьПоиск() {
    var поле = $("apiSearch");
    var q = ((поле && поле.value) || "").trim().toLowerCase();
    var слова = q ? q.split(/\s+/) : [];
    var видно = 0, всего = 0;
    апиКарточки.forEach(function (к) {
      var подходит = слова.every(function (с) { return к.поиск.indexOf(с) >= 0; });
      к.classList.toggle("hidden", !подходит);
      if (к.вид === "путь") { всего++; if (подходит) видно++; }
      if (слова.length) к.раскрыть(подходит);
      else к.раскрыть(к.вид === "раздел");
    });
    // Группа без единой подходящей статьи только мешает: заголовок без содержимого читается как
    // «здесь ничего нет», хотя это просто отбор.
    Array.prototype.forEach.call(document.querySelectorAll("#apiDocsList .api-group"), function (г) {
      var есть = г.querySelector(".api-ep:not(.hidden)");
      г.classList.toggle("hidden", !есть);
    });
    var счёт = $("apiFound");
    if (счёт) счёт.textContent = слова.length
      ? ("Найдено путей: " + видно + " из " + всего)
      : ("Путей описано: " + всего);
  }

  function апиРаскрытьВсе(да) {
    апиКарточки.forEach(function (к) { if (!к.classList.contains("hidden")) к.раскрыть(да); });
  }

  (function () {
    var поле = $("apiSearch");
    if (поле) поле.addEventListener("input", апиПрименитьПоиск);
    var р = $("apiExpandAll"); if (р) р.addEventListener("click", function () { апиРаскрытьВсе(true); });
    var с = $("apiCollapseAll"); if (с) с.addEventListener("click", function () { апиРаскрытьВсе(false); });
  })();

  // ==================================================================
  // «Отправить запрос»: выполнить пример прямо со вкладки
  // ==================================================================
  // Отправка настоящая: тот же адрес, то же тело, тот же разбор на сервере. Смысл именно в этом,
  // иначе пример проверялся бы на словах. Поэтому цель подставляется от этой установки, а перед
  // отправкой на планшет, где идёт подписание, задаётся вопрос: оборвать живого клиента посреди
  // документа хуже, чем спросить один раз.
  //
  // От имени вошедшего администратора: он проходит по /api/ext/* и без ключа. Поле для ключа
  // всё равно есть, чтобы можно было проверить именно тот ключ, который отдали интегратору.

  // Планшеты и документы этой установки, снятые прямо перед открытием окна. Из того, что помнит
  // вкладка, брать нельзя: вкладку могли открыть час назад, а планшет завести минуту назад, и
  // тогда пример уходил бы с образцовым WS-204 и получал «workstation not found».
  var апиСтенд = { devices: null, docs: null };
  function апиПланшеты() {
    return (апиСтенд.devices || state.devices || []).filter(function (d) { return d && d.status !== "revoked"; });
  }

  /// Подставить в тело примера планшет и документ этой установки. Метки `{МЕСТО}`, `{ПЛАНШЕТ}`
  /// и `{ДОКУМЕНТ}` в образце уже показаны настоящими значениями, и то же самое должно уйти по
  /// кнопке: иначе глаз читает одно, а на сервер идёт другое. Старые заглушки `WS-204` и
  /// `DEVICE_ID` понимаются тоже: их ещё носят тела, написанные до появления меток.
  function апиПодставитьЦель(тело, заметки) {
    if (!тело || typeof тело !== "object") return тело;
    var копия = JSON.parse(JSON.stringify(тело));
    var сказать = function (т) { if (заметки) заметки.push(т); };
    var живые = апиПланшеты();
    var сМестом = живые.filter(function (d) { return d.workstation && d.workstation.externalId; })[0];
    var любой = живые[0];
    var этоМесто = функцияМетки("{МЕСТО}", "WS-204");
    var этоПланшет = функцияМетки("{ПЛАНШЕТ}", "DEVICE_ID");
    if (этоМесто(копия.workstationExternalId)) {
      if (сМестом) {
        копия.workstationExternalId = сМестом.workstation.externalId;
        сказать("код места взят с этой установки: «" + сМестом.workstation.externalId + "»");
      } else if (любой) {
        delete копия.workstationExternalId;
        копия.deviceId = любой.id;
        сказать("рабочих мест с кодом здесь нет, поэтому адресуемся прямо планшетом «" + любой.name + "»");
      } else {
        сказать("ни одного планшета и ни одного рабочего места здесь нет: сервер ответит отказом, и это правильный ответ");
      }
    }
    if (этоПланшет(копия.deviceId) && любой) {
      копия.deviceId = любой.id;
      сказать("номер планшета взят с этой установки: планшет «" + любой.name + "»");
    }
    if ((копия.target === "device:{ПЛАНШЕТ}" || копия.target === "device:DEVICE_ID") && любой) {
      копия.target = "device:" + любой.id;
      сказать("адресат взят с этой установки: планшет «" + любой.name + "»");
    }
    var библиотека = апиСтенд.docs || (typeof docList !== "undefined" && docList ? docList : []);
    if (копия.documentCode === "{ДОКУМЕНТ}") {
      var свой = библиотека.filter(function (d) { return d.isDefault; })[0] || библиотека[0];
      if (свой) { копия.documentCode = свой.code; сказать("код документа взят с этой установки: «" + свой.code + "»"); }
      else { delete копия.documentCode; сказать("документов здесь нет, запрос уйдёт без кода документа"); }
    }
    if (копия.documentCode && !библиотека.some(function (d) { return d.code === копия.documentCode; })) {
      var поумолч = библиотека.filter(function (d) { return d.isDefault; })[0] || библиотека[0];
      if (поумолч) {
        копия.documentCode = поумолч.code;
        сказать("кода документа «" + тело.documentCode + "» здесь нет, взят «" + поумолч.code + "»");
      } else {
        delete копия.documentCode;
        сказать("кода документа «" + тело.documentCode + "» здесь нет, запрос уйдёт без кода");
      }
    }
    return копия;
  }

  /// Сравнение значения с меткой образца и со старой заглушкой того же смысла.
  function функцияМетки(метка, заглушка) {
    return function (v) { return v === метка || v === заглушка; };
  }

  /// Планшеты, которых коснётся это тело. Правило то же, что на сервере: отозванные не в счёт.
  function апиКогоЗатронет(тело) {
    if (!тело || typeof тело !== "object") return [];
    var поПланшету = String(тело.deviceId || String(тело.target || "").replace(/^device:/, "")).trim().toLowerCase();
    var поМесту = String(тело.workstationExternalId || "").trim().toLowerCase();
    var живые = апиПланшеты();
    if (поПланшету) return живые.filter(function (d) { return String(d.id || "").toLowerCase() === поПланшету; });
    if (поМесту) return живые.filter(function (d) {
      return d.workstation && String(d.workstation.externalId || "").toLowerCase() === поМесту;
    });
    return [];
  }

  function openApiSend(опции) {
    // Список планшетов и библиотека перечитываются перед каждым открытием. Отказ чтения не
    // повод не открывать окно: подстановка это удобство, а не условие отправки.
    апиОбновитьЗначения().then(function () { апиОкноОтправки(опции); });
  }

  function апиОкноОтправки(опции) {
    var c = el("div", "apitest");
    c.appendChild(el("h3", null, "Отправить запрос: " + (опции.заголовок || опции.путь)));
    c.appendChild(апиФраза("Запрос уйдёт на этот сервер так же, как его прислала бы внешняя система. Это настоящая отправка, а не показ: то, что она изменит, изменится.", "p", "sig-meta"));

    // Адрес и метод: адрес правится руками, потому что в нём может стоять {id}, а номер знает
    // только тот, кто смотрит на список.
    var ряд = el("div", "filter-bar");
    ряд.appendChild(el("span", "api-method api-" + опции.метод.toLowerCase(), опции.метод));
    var адрес = el("input", "filter-search");
    адрес.type = "text";
    адрес.value = опции.путь;
    ряд.appendChild(адрес);
    c.appendChild(ряд);

    var заметки = [];
    var тело0 = апиПодставитьЦель(опции.тело, заметки);
    if (заметки.length) c.appendChild(апиФраза("Пример подогнан под эту установку: " + заметки.join("; ") + ".", "div", "api-target"));
    var поле = null;
    if (тело0 !== null && тело0 !== undefined) {
      поле = el("textarea", "api-input");
      поле.rows = 12;
      поле.spellcheck = false;
      поле.value = JSON.stringify(тело0, null, 2);
      c.appendChild(поле);
    }

    var ключЛабел = el("label", "field", "Ключ API (необязательно: вошедший администратор проходит и без него)");
    var ключ = el("input"); ключ.type = "text"; ключ.placeholder = "sk_...";
    ключЛабел.appendChild(ключ); c.appendChild(ключЛабел);

    var цельНадпись = el("div", "api-target");
    c.appendChild(цельНадпись);
    function обновитьЦель() {
      var т = null;
      if (поле) { try { т = JSON.parse(поле.value); } catch (e) { т = null; } }
      if (поле && т === null) { цельНадпись.className = "api-target warn"; цельНадпись.textContent = "Тело запроса пока не разобрано как JSON."; return; }
      if (!поле) {
        цельНадпись.className = "api-target";
        цельНадпись.textContent = "Запрос без тела: уйдёт по адресу выше как есть. Ни один планшет он не затронет.";
        return;
      }
      var кого = апиКогоЗатронет(т);
      if (!кого.length) {
        цельНадпись.className = "api-target";
        цельНадпись.textContent = "Планшету этот запрос не адресуется, либо планшет по нему не найден: тогда сервер ответит отказом, как ответил бы внешней системе.";
        return;
      }
      var занят = кого.filter(function (d) { return d.screen === "document"; })[0];
      цельНадпись.className = "api-target " + (занят ? "busy" : "ok");
      цельНадпись.textContent = занят
        ? "На планшете «" + занят.name + "» сейчас идёт подписание. Отправка прервёт его."
        : "Затронет: " + кого.map(function (d) { return d.name + (d.online ? "" : " (не на связи)"); }).join(", ") + ".";
    }
    if (поле) поле.addEventListener("input", обновитьЦель);
    обновитьЦель();

    var ответ = el("pre", "api-code"); ответ.style.display = "none";
    c.appendChild(ответ);

    var actions = el("div", "modal-actions");
    var close = el("button", "btn btn-ghost", "Закрыть");
    close.addEventListener("click", closeModal);
    actions.appendChild(close);
    var go = iconBtn("send", "Отправить запрос", "btn-primary");
    actions.appendChild(go);
    c.appendChild(actions);
    openModal(c, true);

    go.addEventListener("click", function () {
      var т;
      if (поле) {
        try { т = JSON.parse(поле.value); }
        catch (e) {
          ответ.style.display = "";
          ответ.textContent = "Это не JSON: " + (e && e.message ? e.message : e);
          return;
        }
      }
      var занят = апиКогоЗатронет(т).filter(function (d) { return d.screen === "document"; })[0];
      if (занят && !confirm("На планшете «" + занят.name + "» сейчас идёт подписание.\n\nОтправка прервёт его. Продолжить?")) return;
      go.classList.add("btn-wait");
      var headers = {};
      if (поле) headers["Content-Type"] = "application/json";
      if ((ключ.value || "").trim()) headers["X-Api-Key"] = ключ.value.trim();
      fetch(адрес.value, {
        method: опции.метод === "WS" ? "GET" : опции.метод,
        credentials: "same-origin", headers: headers,
        body: поле ? JSON.stringify(т) : undefined
      }).then(function (r) {
        return r.text().then(function (t) {
          var красиво = t;
          try { красиво = JSON.stringify(JSON.parse(t), null, 2); } catch (e) { /* не JSON */ }
          ответ.style.display = "";
          ответ.textContent = "HTTP " + r.status + "\n" + (красиво || "(пустое тело ответа)");
          toast(r.ok ? "Запрос выполнен: HTTP " + r.status : "Сервер отказал: HTTP " + r.status, !r.ok);
        });
      }).catch(function (e) {
        ответ.style.display = "";
        ответ.textContent = "Запрос не ушёл: " + (e && e.message ? e.message : e);
      }).then(function () { go.classList.remove("btn-wait"); });
    });
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
  // Второй знак означает «это отказ, а не сообщение об успехе». Он передавался в восьми местах
  // и молча отбрасывался: «Не удалось открыть документ» выглядело точно так же, как
  // «Сохранено», и гасло через две с половиной секунды.
  function toast(msg, ошибка) {
    if (!toastEl) { toastEl = el("div"); toastEl.className = "toast"; document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.toggle("toast-bad", !!ошибка);
    toastEl.style.opacity = "1";
    // Отказ висит дольше: его надо успеть прочитать и понять, что делать дальше.
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = "0"; }, ошибка ? 6000 : 2400);
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
    // Адресуется рабочее место, а не планшет: код места задаёт сам заказчик, он переживает
    // замену планшета и не меняется при перенастройке. Номер планшета берётся только тогда,
    // когда места у него нет.
    if (dev && dev.workstation && dev.workstation.externalId) цель = '"workstationExternalId": "' + dev.workstation.externalId + '"';
    else if (dev) цель = '"deviceId": "' + dev.id + '"';
    else {
      // Планшет не выбран. Выдуманный код вроде «WS-204» тут ставить нельзя: оператор нажмёт
      // «Отправить запрос», получит «рабочего места с таким кодом нет» и решит, что сломано
      // API. Подставляется настоящий код этой установки, а если мест ещё не заведено, так и
      // пишется прямо в заготовке.
      var первое = (state.workstations || []).filter(function (w) { return w.externalId; })[0];
      цель = первое
        ? '"workstationExternalId": "' + первое.externalId + '"'
        : '"workstationExternalId": "СНАЧАЛА ЗАВЕДИТЕ РАБОЧЕЕ МЕСТО НА ВКЛАДКЕ «МЕСТА»"';
    }

    var поля = {};
    previewFields().forEach(function (k) { поля[k] = previewDefault(k); });
    var keys = docKeys();
    var тело = {};
    // Код документа обязателен, и это не украшение заготовки. Без него служба берёт документ,
    // назначенный основным, а не тот, который сейчас правят: оператор проверял вторую анкету,
    // а на планшет уходила первая, и понять это по ответу «ok» было нельзя. Замер на службе:
    // тело без documentCode дало «"document":"main"» при открытом документе VTOROY.
    var своя = запись(state.docId);
    if (своя && своя.code) тело.documentCode = своя.code;
    тело.fields = поля;
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

    // Планшеты, на которые уйдёт этот запрос. По номеру планшета он всегда один, по коду
    // рабочего места их может оказаться несколько, и тогда сервер откажет: документ уходит
    // только на один планшет. Списанные не считаются, как и на сервере.
    function найтиПланшеты(тело) {
      var поПланшету = String((тело && тело.deviceId) || "").trim().toLowerCase();
      var поМесту = String((тело && тело.workstationExternalId) || "").trim().toLowerCase();
      var живые = (state.devices || []).filter(function (d) { return d.status !== "revoked"; });
      if (поПланшету) {
        return живые.filter(function (d) { return String(d.id || "").toLowerCase() === поПланшету; });
      }
      if (поМесту) {
        return живые.filter(function (d) {
          return d.workstation && String(d.workstation.externalId || "").toLowerCase() === поМесту;
        });
      }
      return [];
    }

    function обновитьЦель() {
      var тело1 = null;
      try { тело1 = JSON.parse(поле.value); } catch (e) { /* ещё не дописан */ }
      if (!тело1) { цельНадпись.className = "api-target"; цельНадпись.textContent = "Запрос пока не разобран."; return; }
      var найдены = найтиПланшеты(тело1);
      if (!найдены.length) {
        цельНадпись.className = "api-target warn";
        цельНадпись.textContent = "Планшет по этому запросу не найден. Сервер ответит ошибкой, как ответил бы внешней системе.";
        return;
      }
      if (найдены.length > 1) {
        // Правило то же, что на сервере: если на связи ровно один, он и получит документ,
        // остальные сейчас всё равно ничего показать не могут. Иначе отказ, и лучше сказать об
        // этом здесь, чем показать ошибку после нажатия.
        var наСвязи = найдены.filter(function (x) { return x.online; });
        if (наСвязи.length !== 1) {
          цельНадпись.className = "api-target warn";
          цельНадпись.textContent = "На этом рабочем месте несколько планшетов, и сервер откажет: "
            + "документ уходит только на один. Укажите в запросе deviceId одного из них: "
            + найдены.map(function (x) {
                return x.name + " (" + x.id + ", " + (x.online ? "на связи" : "не на связи") + ")";
              }).join(", ") + ".";
          return;
        }
        найдены = наСвязи;
      }
      var d = найдены[0];
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
      // Ищем адресата тем же способом, что и надпись про цель под полем запроса. Раньше здесь
      // звалась функция с другим именем, которой в файле нет вовсе: кнопка падала на этой строке
      // и молча не делала ничего. По запросу может подойти и несколько планшетов, поэтому
      // спрашиваем, если подписание идёт хотя бы на одном.
      var d = найтиПланшеты(тело1).filter(function (x) { return x.screen === "document"; })[0];
      if (d &&
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
  var watch = { deviceId: null, name: "", doc: null, mode: "", state: null, node: null,
    solo: false, искомое: "", опрос: null, ждём: null,
    // Форма экрана планшета, по которой построена сцена, и размер сцены, выбранный оператором.
    //
    // Про размер своего экрана планшет рассказывает двумя путями: отдельным сообщением, которое
    // служба помнит в карточке (оно есть ещё до первого кадра и переживает разрыв связи), и в
    // каждом кадре наблюдения. Путей два, а правда одна, поэтому последнее услышанное по любому
    // из них кладётся сюда, и сцена строится по нему. Без этого поворот планшета, случившийся
    // пока клиент ничего не трогает, не доезжал до окна вовсе: нового кадра нет, а карточку
    // никто не спрашивал.
    форма: null, режим: "fit", экран: null };

  // ---- Форма экрана планшета и размер сцены ----
  //
  // Сцена наблюдения это копия экрана планшета: её размер в точках равен настоящему экрану, а к
  // окну оператора она подгоняется одним множителем. Ничего не переверстывается, поэтому
  // переносы строк, кегль и расположение у оператора те же, что у клиента.
  //
  // Пропорция, в которой окно открывается, пока настоящий размер неизвестен. Это не выдуманный
  // размер конкретного планшета: числа нигде не показываются, а оператору прямо говорится
  // словами, что размер экрана неизвестен. Нужны они только затем, чтобы окно не открылось
  // квадратом или полосой.
  var ФОРМА_ПОКА_НЕИЗВЕСТНО = { w: 800, h: 1280 };
  var СЦЕНА_НАИМЕНЬШАЯ = 220;      // уже этого на сцене уже ничего не разобрать
  var СЦЕНА_ШАГ = 1.25;            // ступень «крупнее» и «мельче»
  var СЦЕНА_ХРАНИЛИЩЕ = "sk_watch_scene_v1";

  /// Форма экрана планшета из того, что о нём известно. Принимает и кадр наблюдения ({w,h}), и
  /// карточку планшета ({screenWidth,screenHeight}). Пусто это «неизвестно», а не ноль.
  function формаЭкрана(источник) {
    var w = источник && (источник.w != null ? источник.w : источник.screenWidth);
    var h = источник && (источник.h != null ? источник.h : источник.screenHeight);
    if (w > 0 && h > 0) return { w: Math.round(w), h: Math.round(h), известна: true };
    return { w: ФОРМА_ПОКА_НЕИЗВЕСТНО.w, h: ФОРМА_ПОКА_НЕИЗВЕСТНО.h, известна: false };
  }

  /// Имя, под которым размер сцены помнится в браузере оператора. У планшета 800 на 1334 и у
  /// планшета 1200 на 800 это разные окна, и одна запомненная величина им обоим не годится.
  /// Форма «неизвестно» помечена отдельно: за ней не стоит настоящий планшет, и делить память с
  /// настоящим экраном того же размера ей нельзя.
  function ключФормы(ф) { return ф ? ((ф.известна ? "" : "?") + ф.w + "x" + ф.h) : ""; }

  function размерыИзПамяти() {
    try {
      var v = JSON.parse(localStorage.getItem(СЦЕНА_ХРАНИЛИЩЕ) || "{}");
      return (v && typeof v === "object") ? v : {};
    } catch (e) { return {}; }        // хранилище закрыто настройками браузера
  }

  function запомнитьРазмер(ключ, знач) {
    if (!ключ) return;
    var все = размерыИзПамяти();
    все[ключ] = знач;
    try { localStorage.setItem(СЦЕНА_ХРАНИЛИЩЕ, JSON.stringify(все)); } catch (e) { /* закрыто */ }
  }

  /// Что запомнено для этой формы: число это ширина сцены в точках экрана оператора, "fit" это
  /// «уместить целиком». Ничего не запомнено значит «уместить целиком».
  function размерИзПамяти(ключ) {
    var v = размерыИзПамяти()[ключ];
    return (typeof v === "number" && isFinite(v) && v >= СЦЕНА_НАИМЕНЬШАЯ) ? v : "fit";
  }

  /// Сколько места отдано сцене и какая ширина умещает её целиком. Больше этой ширины сцену
  /// растягивать нельзя: обрезанная копия обманывает оператора молча.
  function местоПодСцену() {
    var сцена = watch.node;
    if (!сцена || !watch.форма) return null;
    var рамка = сцена.parentNode, площадка = рамка && рамка.parentNode;
    if (!рамка || !площадка) return null;
    var с = window.getComputedStyle(площадка);
    var w = площадка.clientWidth - (parseFloat(с.paddingLeft) || 0) - (parseFloat(с.paddingRight) || 0);
    var h = площадка.clientHeight - (parseFloat(с.paddingTop) || 0) - (parseFloat(с.paddingBottom) || 0);
    if (!(w > 0) || !(h > 0)) return null;
    var ф = watch.форма;
    return { рамка: рамка, сцена: сцена, ф: ф,
      целиком: Math.max(СЦЕНА_НАИМЕНЬШАЯ, Math.min(w, h * ф.w / ф.h)) };
  }

  /// Размеры текста на планшете заданы долями ширины его окна (vw). Внутри окна оператора те же
  /// доли считались бы от чужой ширины и давали бы чужие переносы, поэтому подставляем их числом
  /// от настоящей ширины планшета. Формулы взяты слово в слово из kiosk.css, и выбранный клиентом
  /// размер текста (--doc-scale) тоже учтён: оператор обязан видеть тот же документ, что клиент.
  function размерыТекста(сцена, ф) {
    var м = (watch.state && watch.state.textScale > 0) ? watch.state.textScale : 1;
    var зажать = function (мин, доля, макс) { return Math.min(Math.max(ф.w * доля, мин), макс); };
    var п = function (имя, знач) { сцена.style.setProperty(имя, знач.toFixed(2) + "px"); };
    п("--wt-base", 16 * м);                                   // .doc-frame: calc(1rem * var(--doc-scale))
    п("--wt-text", зажать(16.32, 0.022, 20) * м);             // --doc-text-base: clamp(1.02rem, 2.2vw, 1.25rem)
    п("--wt-h1", зажать(20.8, 0.032, 32) * м);                // .doc-header h1: clamp(1.3rem, 3.2vw, 2rem)
    п("--wt-h2", зажать(18.4, 0.026, 25.6) * м);              // .doc-body h2: clamp(1.15rem, 2.6vw, 1.6rem)
    п("--wt-thanks", зажать(22.4, 0.03, 32) * м);             // .thankyou h2: clamp(1.4rem, 3vw, 2rem)
    п("--wt-btn", зажать(16, 0.022, 19.2));                   // .btn: clamp(1rem, 2.2vw, 1.2rem), без множителя
    п("--wt-pad", Math.min(Math.max(ф.w * 0.03, 16), 40));    // .doc-frame padding: clamp(16px, 3vw, 40px)
    п("--wt-box", Math.min(30 * м, 46));                      // .check input: min(30px * scale, 46px)
    п("--wt-ink", Math.min(ф.h * 0.55, 520));                 // .sign-wrap: height: min(55vh, 520px)
    п("--wt-ink-page", Math.min(ф.h * 0.52, 460));            // .screen-sign .page-sign-wrap
    п("--wt-scan", Math.min(ф.w * 0.78, 560));                // .scan-window: width: min(78vw, 560px)
  }

  /// Пересобрать сцену под текущую форму экрана и выбранный оператором размер. Вёрстку это не
  /// трогает: меняется только один множитель.
  function перестроитьСцену() {
    var м = местоПодСцену();
    if (!м) return;
    var хочу = watch.режим === "fit" ? м.целиком : watch.режим;
    var ширина = Math.max(СЦЕНА_НАИМЕНЬШАЯ, Math.min(хочу, м.целиком));
    var k = ширина / м.ф.w;
    м.сцена.style.width = м.ф.w + "px";
    м.сцена.style.height = м.ф.h + "px";
    м.сцена.style.transformOrigin = "top left";
    м.сцена.style.transform = "scale(" + k.toFixed(5) + ")";
    м.рамка.style.width = Math.round(м.ф.w * k) + "px";
    м.рамка.style.height = Math.round(м.ф.h * k) + "px";
    размерыТекста(м.сцена, м.ф);
    подписатьМасштаб(k);
  }

  /// Насколько сцена уменьшена, оператору говорится подсказкой на значках масштаба, а не строкой
  /// в шапке: шапка тут для планшета, а не для чисел про окно.
  function подписатьМасштаб(k) {
    var поле = document.querySelector(".watch-zoom");
    if (!поле) return;
    var процент = Math.round(k * 100) + "%";
    var уместить = поле.querySelector('[data-zoom="fit"]');
    if (уместить) уместить.title = "Уместить целиком. Сейчас " + процент + " от настоящего размера экрана планшета";
  }

  /// Ступень «крупнее» или «мельче». Пропорция при этом не меняется: меняется одна ширина, а
  /// высота идёт за ней сама, потому что форма экрана планшета задана и не пересчитывается.
  function ступеньМасштаба(во) {
    var м = местоПодСцену();
    if (!м) return;
    var сейчас = м.рамка.getBoundingClientRect().width;
    if (!(сейчас > 0)) return;
    поставитьРазмер(Math.round(сейчас * во));
  }

  /// Запомнить выбранный размер и показать его. Размер помнится для этой формы экрана: у другого
  /// планшета своя форма и свой запомненный размер.
  function поставитьРазмер(режим) {
    var м = местоПодСцену();
    if (м && typeof режим === "number") {
      режим = Math.max(СЦЕНА_НАИМЕНЬШАЯ, Math.min(режим, Math.floor(м.целиком)));
      // Дошли до края окна: это и есть «уместить целиком», так и запоминаем. Иначе на другом
      // мониторе окно открылось бы по числу, снятому с прежнего, и часть экрана пропала бы.
      if (режим >= Math.floor(м.целиком)) режим = "fit";
    }
    watch.режим = режим;
    запомнитьРазмер(ключФормы(watch.форма), режим);
    перестроитьСцену();
  }

  /// Форма экрана могла смениться: планшет повернули, оператор перешёл к другому планшету, или
  /// размер наконец приехал вместо «неизвестно». Сцена тогда строится заново и берёт размер,
  /// запомненный именно для этой формы.
  function принятьФорму(источник) {
    var ф = формаЭкрана(источник);
    var было = watch.форма;
    if (было && было.w === ф.w && было.h === ф.h && было.известна === ф.известна) return false;
    watch.форма = ф;
    watch.режим = размерИзПамяти(ключФормы(ф));
    var знак = document.querySelector(".watch-unknown");
    if (знак) знак.classList.toggle("hidden", ф.известна);
    перестроитьСцену();
    return true;
  }

  /// Значок масштаба. Ссылка, а не кнопка: кнопок в окне наблюдения нет ни одной, и заводить их
  /// здесь нельзя. Ни одна из них ничего не делает с планшетом, они меняют только размер картинки
  /// у самого оператора.
  function значокМасштаба(знак, роль, подпись, действие) {
    var a = el("a", "watch-zoom-act");
    a.href = "#";
    a.textContent = знак;
    a.title = подпись;
    a.setAttribute("data-zoom", роль);
    a.setAttribute("aria-label", подпись);
    a.addEventListener("click", function (e) { e.preventDefault(); действие(); });
    return a;
  }


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
    var цель = String(искомое || "").trim();
    if (watch.solo) {
      // То же окно за тем же планшетом: перестраивать нечего.
      if (watch.искомое === цель) return;
      // Оператор перешёл к другому планшету, и у того может быть совсем другая форма экрана.
      // Прежнее наблюдение снимается целиком: в одном окне не должно смешаться двух планшетов,
      // и запомненный размер новому планшету достаётся его собственный, а не чужой.
      watchСнятьСоло();
    }
    watch.искомое = цель;
    watch.solo = true;
    document.body.classList.add("watch-solo");
    // Панели закрываются и в разметке, а не только правилом оформления: иначе в окне остаётся
    // открытой вкладка, которая просто не видна, и она продолжает подгружать свои данные.
    document.querySelectorAll(".panel").forEach(function (p) { p.classList.add("hidden"); });
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });

    var корень = el("div", "watch watch-solo-page");
    var шапка = el("div", "watch-head");
    // В шапке только то, что про сам планшет: как он называется, где стоит и есть ли с ним
    // связь. Ни имени системы, ни её версии, ни описания того, что такое наблюдение, здесь
    // больше нет: окно открывают, чтобы смотреть на экран, а не читать про него.
    var заголовок = el("h3", "watch-name", "Экран планшета");
    шапка.appendChild(заголовок);
    var местоМетка = el("span", "watch-place hidden");
    шапка.appendChild(местоМетка);
    var метка = el("span", "watch-live", "поиск планшета…");
    шапка.appendChild(метка);
    // Планшет на старой странице размера своего экрана не сообщает. Выдумывать за него нельзя,
    // поэтому сцена берёт обычную долю сторон, а оператору это говорится прямо. Как только
    // планшет размер пришлёт, надпись уходит, а сцена перестраивается сама.
    var неизвестно = el("span", "watch-unknown hidden", "размер экрана планшета неизвестен");
    неизвестно.title = "Планшет работает на старой странице и не сообщает размер своего экрана. "
      + "Пропорция окна взята обычная для планшета. Как только размер придёт, окно перестроится само.";
    шапка.appendChild(неизвестно);
    // Расхождение с планшетом. Ширина букв считается системой, а системы у планшета (Android) и
    // у оператора (Windows, Linux) разные: одна и та же строка одного кегля тем же шрифтом
    // выходит на процент шире или уже, и заголовок, который у клиента не влез в строку, у
    // оператора влезает. text-rendering: geometricPrecision это убирает, но полагаться на то, что
    // убрало везде, нельзя. Поэтому наблюдение сверяет высоту нарисованного с той, что прислал
    // планшет, и при расхождении говорит об этом прямо. Молчать здесь нельзя: оператор принимает
    // решения по тому, что видит, считая, что видит экран клиента.
    var разница = el("span", "watch-raznica hidden", "");
    шапка.appendChild(разница);
    // Масштаб сцены. Значки, а не кнопки: кнопка в окне наблюдения читается как действие над
    // планшетом, а таких здесь нет ни одного. Пропорция экрана не меняется никогда, меняется
    // только множитель, которым сцена подогнана к окну.
    var масштаб = el("div", "watch-zoom");
    масштаб.appendChild(значокМасштаба("−", "мельче", "Мельче", function () { ступеньМасштаба(1 / СЦЕНА_ШАГ); }));
    масштаб.appendChild(значокМасштаба("⤢", "fit", "Уместить целиком", function () { поставитьРазмер("fit"); }));
    масштаб.appendChild(значокМасштаба("+", "крупнее", "Крупнее", function () { ступеньМасштаба(СЦЕНА_ШАГ); }));
    шапка.appendChild(масштаб);
    // Выход из наблюдения. Кнопки «закрыть окно» тут нет и быть не может: скрипт вправе закрыть
    // только то окно, которое сам и открыл. Но ссылку #watch= часто открывают обычной вкладкой,
    // и тогда вкладок админки нет, панели скрыты, и выйти отсюда нечем, кроме правки адреса
    // руками. Возврат в список планшетов работает в любом окне и ничего не закрывает.
    // Это ссылка, а не кнопка, и намеренно: кнопок, которые что-то делают, в окне наблюдения
    // нет ни одной, и заводить их здесь нельзя. Возврат ничего не меняет ни на планшете, ни в
    // документе, он лишь уводит самого оператора обратно в админку. Адрес в ней настоящий,
    // поэтому даже без скрипта ссылка ведёт туда, куда обещает.
    var назад = el("a", "watch-back");
    назад.href = "#devices";
    назад.setAttribute("data-role", "watchback");
    назад.appendChild(el("span", null, "\u2190 К списку планшетов"));
    назад.title = "Выйти из наблюдения и вернуться в админку. Окно останется открытым";
    назад.addEventListener("click", function (e) { e.preventDefault(); watchSoloStop(); });
    шапка.appendChild(назад);
    корень.appendChild(шапка);

    // Площадка занимает всё, что осталось от окна, и держит сцену по центру. Сцена внутри имеет
    // пропорцию настоящего экрана планшета, поэтому пустого места вокруг остаётся ровно
    // столько, сколько нужно, чтобы не обрезать её по другой стороне.
    var площадка = el("div", "watch-stage");
    var рамка = el("div", "watch-frame");
    watch.node = el("div", "watch-screen");
    рамка.appendChild(watch.node);
    площадка.appendChild(рамка);
    корень.appendChild(площадка);

    // Своей кнопки закрытия тут нет. Окно наблюдения это отдельное окно браузера, и закрывается
    // оно так же, как любое другое: крестиком. Скрипт вправе закрыть только то окно, которое сам
    // и открыл, а ссылку часто открывают руками; тогда кнопка либо не работала бы вовсе, либо
    // молча уводила оператора на список планшетов, чего он не просил.

    var место = document.querySelector(".content");
    if (место) место.appendChild(корень);
    // Сцена получает пропорцию сразу, ещё до первого кадра: пока про планшет ничего не известно,
    // это обычная доля сторон планшета, и об этом сказано словами. Прежде окно до первого кадра
    // было прямоугольником произвольной высоты и на глазах у оператора перескакивало.
    watch.форма = null;
    принятьФорму(watch.экран);
    watchSay("Ищем планшет…");

    var q = String(искомое || "").trim().toLowerCase();
    var идёт = false;
    function попытка() {
      if (!watch.solo) return;                    // из наблюдения уже вышли
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
        // Имя планшета и его рабочее место: по ним оператор понимает, за кем смотрит. Больше в
        // шапке ничего про планшет и не нужно.
        заголовок.textContent = dev.name || dev.id;
        var где = (dev.workstation && (dev.workstation.name || dev.workstation.externalId)) || dev.workstationName || "";
        var этаж = (dev.workstation && dev.workstation.location) || "";
        местоМетка.textContent = где ? (где + (этаж ? ", " + этаж : "")) : "";
        местоМетка.classList.toggle("hidden", !где);
        // Размер экрана известен из карточки ещё до первого кадра: сцена берёт настоящую
        // пропорцию планшета сразу, а не после того, как планшет о себе расскажет.
        watch.экран = (dev.screenWidth > 0 && dev.screenHeight > 0)
          ? { w: dev.screenWidth, h: dev.screenHeight } : null;
        принятьФорму(watch.экран);
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
    watch.ждём = setInterval(function () {
      if (!watch.solo) { clearInterval(watch.ждём); watch.ждём = null; return; }
      if (!hub || hub.state !== "Connected") return;
      clearInterval(watch.ждём); watch.ждём = null;
      попытка();
      // Опрос гасится, как только планшет найден: раньше он шёл вечно и каждые три секунды
      // тянул список планшетов, хотя выходил по первой же строке.
      watch.опрос = setInterval(function () {
        if (watch.node && watch.state) { clearInterval(watch.опрос); watch.опрос = null; return; }
        попытка();
      }, СОЛО_ОПРОС);
    }, 200);
  }

  /// Выйти из наблюдения обратно в админку, не закрывая окна. Планшету при этом говорится, что
  /// за ним больше не смотрят: иначе он продолжал бы рассказывать о себе в пустоту и тратить
  /// батарею.
  function watchSoloStop() {
    if (!watch.solo) return;
    watchСнятьСоло();
    openTab("devices", true);
  }

  /// Убрать наблюдение, не решая, куда после этого идти оператору. Этим же снятием пользуется
  /// переход к другому планшету: там уходить в список планшетов не надо, надо тут же построить
  /// окно заново.
  function watchСнятьСоло() {
    watchStop();
    if (watch.опрос) { clearInterval(watch.опрос); watch.опрос = null; }
    if (watch.ждём) { clearInterval(watch.ждём); watch.ждём = null; }
    watch.solo = false;
    watch.искомое = "";
    // Форма экрана и запомненный для неё размер живут вместе со сценой: следующее наблюдение
    // может быть за другим планшетом, и прежняя форма ему не годится.
    watch.форма = null; watch.экран = null; watch.режим = "fit";
    document.body.classList.remove("watch-solo");
    var страница = document.querySelector(".watch-solo-page");
    if (страница) страница.remove();
  }

  // Наблюдение открывается отдельным окном браузера, а не поверх админки: оператору обычно надо
  // и смотреть за клиентом, и продолжать работать в админке, а окно поверх этого не даёт. Внутри
  // того окна открывается та же самая админка по ссылке #watch=, поэтому вход, права и вид
  // остаются ровно теми же.
  function openWatchWindow(idOrCode, name) {
    var код = String(idOrCode || "").trim();
    if (!код) { toast("Планшет не выбран"); return; }
    var w = window.open("/admin/#watch=" + encodeURIComponent(код), "sk-watch-" + код,
      размерыОкнаНаблюдения(код) + ",menubar=no,toolbar=no,location=no");
    if (!w) { toast("Браузер заблокировал новое окно. Разрешите всплывающие окна для этого адреса", true); return; }
    try { w.focus(); } catch (e) { /* окно уже на переднем плане */ }
  }

  /// Само окно браузера открывается в пропорции экрана планшета и того размера, который оператор
  /// уже выбрал для планшета такой же формы. Иначе окно каждый раз открывалось бы одним и тем же
  /// прямоугольником 1200 на 980, вокруг вертикального планшета оставались бы широкие пустые
  /// поля, а оператору пришлось бы тянуть угол окна при каждом открытии.
  ///
  /// Размер экрана планшета берётся из карточки: служба помнит его и для отключённого планшета,
  /// поэтому пропорция известна ещё до первого кадра. Про планшет, который размера не сообщал,
  /// ничего не выдумывается: берётся обычная доля сторон планшета, а в самом окне об этом
  /// сказано словами.
  function размерыОкнаНаблюдения(код) {
    var q = String(код).toLowerCase();
    var d = (state.devices || []).filter(function (x) {
      return String(x.id || "").toLowerCase() === q
        || String(x.name || "").toLowerCase() === q
        || (x.workstation && String(x.workstation.externalId || "").toLowerCase() === q);
    })[0];
    var ф = формаЭкрана(d && d.screenWidth > 0 ? { w: d.screenWidth, h: d.screenHeight } : null);
    var запомнено = размерИзПамяти(ключФормы(ф));
    // Сколько места есть на мониторе оператора под само окно. Оконная рама и адресная строка
    // сюда не входят, поэтому под них оставляется запас: без него окно вылезало бы за нижний
    // край экрана и часть сцены пряталась бы под панелью задач.
    var экранW = (window.screen && window.screen.availWidth) || 1280;
    var экранH = (window.screen && window.screen.availHeight) || 900;
    var ШАПКА = 46, ПОЛЯ = 16, РАМА = 78;
    var местоW = Math.max(320, экранW - 40);
    var местоH = Math.max(320, экранH - 40 - РАМА - ШАПКА - ПОЛЯ);
    var ширина = typeof запомнено === "number" ? запомнено : Math.min(местоW - ПОЛЯ, местоH * ф.w / ф.h);
    ширина = Math.max(СЦЕНА_НАИМЕНЬШАЯ, Math.min(ширина, местоW - ПОЛЯ, местоH * ф.w / ф.h));
    return "width=" + Math.round(ширина + ПОЛЯ)
      + ",height=" + Math.round(ширина * ф.h / ф.w + ШАПКА + ПОЛЯ + РАМА);
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
      // Планшет доложил о себе службе: это и есть весть о повороте. Кадра наблюдения при
      // повороте может не быть вовсе (клиент ничего не трогает), поэтому сцена перестраивается
      // отсюда.
      if (d && d.screenWidth > 0 && d.screenHeight > 0) {
        watch.экран = { w: d.screenWidth, h: d.screenHeight };
        принятьФорму(watch.экран);
      }
    }).catch(function () { /* список не прочитался, метку не трогаем */ });
  }

  // Окно оператора меняют мышью: пересчитываем масштаб, но не вёрстку. Пропорция сцены при этом
  // не меняется никогда: она принадлежит планшету, а не окну.
  window.addEventListener("resize", function () {
    if (watch.node) перестроитьСцену();
  });

  function watchSay(text) {
    if (!watch.node) return;
    watch.node.innerHTML = "";
    // Вид сцены сбрасывается вместе с содержимым: иначе объяснение словами оставалось бы на
    // чёрном фоне рекламы или камеры, будто планшет всё ещё показывает их.
    watch.node.className = "watch-screen wt-mode-note";
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
    // Кадр рассказывает и о размере экрана: он самый свежий из двух путей ровно в тот миг,
    // когда пришёл.
    if (st && st.screen && st.screen.w > 0 && st.screen.h > 0) watch.экран = { w: st.screen.w, h: st.screen.h };
    watchRender();
  }

  function watchRender() {
    if (!watch.node) return;
    var st = watch.state;
    var mode = (st && st.mode) || watch.mode || "slides";
    // Форма экрана берётся из последнего, что планшет о себе сказал любым из двух путей.
    принятьФорму(watch.экран);
    перестроитьСцену();     // кегль зависит ещё и от выбранного клиентом размера текста

    if (mode === "scan") {
      // Экран сканирования, как его видит клиент, но без камеры: у оператора она не включается
      // и разрешения не спрашивает. Место под окно камеры остаётся то же, иначе всё, что ниже,
      // стояло бы у оператора не там, где у клиента.
      watch.node.innerHTML = "";
      var scЭкран = el("div", "wt-scan");
      scЭкран.appendChild(el("div", "wt-scan-title", "Поднесите код к камере"));
      var окноКамеры = el("div", "wt-scan-window");
      окноКамеры.appendChild(el("div", "wt-scan-off", "камера планшета"));
      scЭкран.appendChild(окноКамеры);
      if (st && st.scanCode) {
        var готово = el("div", "wt-scan-result");
        готово.appendChild(el("div", "wt-scan-ok", "Код считан"));
        готово.appendChild(el("div", "watch-code wt-scan-code", st.scanCode));
        scЭкран.appendChild(готово);
      }
      watch.node.appendChild(scЭкран);
      watch.node.className = "watch-screen wt-mode-scan";
      return;
    }
    if (mode === "slides") {
      // Показываем сам слайд, а не надпись про рекламу: оператору важно видеть, что на экране
      // идёт именно то, что он поставил. Картинка берётся из медиатеки, планшет её не шлёт.
      // Слайд занимает весь экран планшета, как и у клиента, и номера слайда рядом нет: на
      // планшете его тоже нет, а окно наблюдения показывает экран, а не сведения о нём.
      watch.node.innerHTML = "";
      var sl = el("div", "wt-slides");
      if (st && st.slide) {
        var im = el("img", "wt-slide"); im.src = st.slide;
        sl.appendChild(im);
      } else {
        // Ровно то, что видит клиент, когда показывать нечего (index.html, #slidesEmpty).
        sl.appendChild(el("div", "wt-slides-empty", "Планшет готов к работе"));
      }
      watch.node.appendChild(sl);
      watch.node.className = "watch-screen wt-mode-slides";
      return;
    }
    if (mode !== "document" || !watch.doc) { watchSay("Документ загружается…"); return; }

    var doc = watch.doc, pages = doc.pages || [];
    watch.node.innerHTML = "";
    watch.node.className = "watch-screen wt-mode-doc";

    // Экран документа собирается теми же частями, что на планшете: шапка с названием и шагом,
    // содержимое между шапкой и нижней панелью, и сама нижняя панель. Прежде содержимое
    // начиналось прямо от верха, шаг и название стояли одной строкой и в обратном порядке, а
    // нижней панели не было вовсе: из-за этого одно и то же место у клиента и у оператора
    // оказывалось на разной высоте.
    var кадр = el("div", "wt-frame");
    var type = (st && st.type) || "page";
    var шапка = el("div", "wt-head");
    var h1 = el("h1", "wt-doc-title");
    // На экране прощания планшет стирает название документа: в нём могут стоять данные клиента.
    h1.textContent = type === "thankyou" ? "" : (doc.title || "");
    шапка.appendChild(h1);
    шапка.appendChild(el("div", "wt-progress",
      (type !== "thankyou" && st && st.step) ? ("Шаг " + st.step + " из " + st.steps) : ""));
    // Значок «Размер текста» так, как его видит клиент. Это копия, а не кнопки: нажать здесь
    // нельзя ничего. Нужен он и глазами, и геометрией: под него шапка на планшете расширяется до
    // 112 точек, и без этого у оператора области под содержимое на сорок пять точек больше.
    if (st && st.bigText) {
      кадр.classList.add("wt-has-bigtext");
      var размер = el("div", "wt-bigtext");
      размер.appendChild(el("div", "wt-bigtext-cap", "Размер текста"));
      var ряд = el("div", "wt-bigtext-row");
      var шаг = (st.bigStep || 0), всего = (st.bigSteps || 5);
      ряд.appendChild(el("span", "wt-bigtext-btn" + (шаг <= 0 ? " wt-off" : ""), "А−"));
      ряд.appendChild(el("span", "wt-bigtext-btn" + (шаг >= всего - 1 ? " wt-off" : ""), "А+"));
      размер.appendChild(ряд);
      шапка.appendChild(размер);
    }
    кадр.appendChild(шапка);

    // Тело экрана устроено как на планшете: сама область (.doc-body) это колонка, а всё
    // содержимое лежит в одном обычном блоке внутри неё. Разница не косметическая: в колонке
    // отступы соседей не схлопываются, а в обычном блоке схлопываются, и без этого блока
    // содержимое у оператора расходилось с планшетом на десятки точек по высоте.
    var body = el("div", "wt-body");
    // Условия показа считаются по тому, что планшет рассказал о себе: отметки, выбор,
    // вписанное, подписи и коды. Без этого оператор видел блок, пункт или поле, которых у
    // клиента на экране нет.
    var держит = наблюдениеУсловия(doc, st);
    if (type === "thankyou") {
      var сп = el("div", "wt-thanks pv-body");
      сп.appendChild(el("div", "wt-thanks-mark"));
      var th = el("h2", "wt-thanks-title");
      var ta = (doc.thankYouAlign || "").toLowerCase();
      if (ta === "center" || ta === "right" || ta === "justify") th.style.textAlign = ta;
      previewRuns(th, labelRuns(doc.thankYouRuns, doc.thankYouText || "Спасибо!"));
      сп.appendChild(th);
      // Блоки благодарности показываются все, и это не забытый отбор. К этому времени планшет
      // уже стёр ответы клиента (kiosk.js, renderThankYou: doc.checks обнуляется, а config
      // остаётся без страниц), поэтому и сам он рисует их без разбора условий. Отбор здесь
      // показал бы оператору меньше, чем видит клиент. Условия по тегам решены сервером, и
      // такие блоки сюда не доехали вовсе.
      (doc.thankYouBlocks || []).forEach(function (b) { previewBlock(сп, b); });
      body.appendChild(сп);
    } else if (type === "signature") {
      // Экран подписи на планшете стоит по середине высоты: клиент подписывает на весу, и
      // тянуться к краю неудобно. Здесь так же, иначе поле подписи у оператора висело бы вверху.
      var экранП = el("div", "wt-sign-screen pv-body");
      var свСверху = el("div", "wt-sign-custom"); экранП.appendChild(свСверху);
      видимыеБлоки(doc.signBlocks, держит).forEach(function (b) { previewBlock(свСверху, b); });
      экранП.appendChild(el("div", "wt-sign-prompt", doc.signPrompt || "Распишитесь"));
      экранП.appendChild(watchInk(st && st.finalInk, "Клиент ещё не расписался"));
      var свСнизу = el("div", "wt-sign-custom"); экранП.appendChild(свСнизу);
      видимыеБлоки(doc.signBlocksBelow, держит).forEach(function (b) { previewBlock(свСнизу, b); });
      body.appendChild(экранП);
    } else {
      var pi = st && st.pageIndex != null ? st.pageIndex : 0;
      var page = pages[pi];
      if (!page) { watchSay("Страница не найдена."); return; }
      // Страница-подпись и страница-сканирование это отдельные экраны и на планшете: место под
      // перо и под камеру там занимает столько, сколько нужно (kiosk.js, renderPage).
      var вид = String(page.kind || "").toLowerCase();
      var лист = el("div", "wt-page pv-body"
        + (вид === "signature" ? " wt-page-sign" : вид === "scan" ? " wt-page-scan" : ""));
      watchPage(лист, page, pi, st, держит);
      body.appendChild(лист);
    }
    кадр.appendChild(body);
    кадр.appendChild(watchFoot(doc, st, type));
    watch.node.appendChild(кадр);
    // Куда клиент отлистал страницу. Сцена обрезана по краю, как экран планшета, и без этого
    // оператор всегда видел верх страницы: клиент листал вниз и отмечал пункты там, а у
    // оператора они оставались за краем. Прокручиваем на то же место, что и у клиента.
    // Сначала пробуем точку в точку: сцена собрана в размер планшета, и высоты почти совпадают.
    // Если содержимое всё же разошлось (иные шрифты у оператора), переходим на долю от
    // прокручиваемой высоты: место в тексте важнее точного числа точек.
    if (!(st && st.scroll)) сказатьПроРазницу(0, 0, 0, 0);
    повторитьПрокрутку(body, st && st.scroll);
  }

  /// Повторить положение прокрутки планшета в сцене наблюдения.
  /// Сказать оператору, что нарисованное не совпало с планшетом. Числа настоящие, из состояния
  /// планшета и из своего же дерева, без округлений в большую сторону.
  function сказатьПроРазницу(своёВсего, своёОкно, чужоеВсего, чужоеОкно) {
    var знак = document.querySelector(".watch-raznica");
    if (!знак) return;
    var поВысоте = (чужоеВсего > 0) ? Math.round(чужоеВсего - своёВсего) : 0;
    var поОкну = (чужоеОкно > 0) ? Math.round(чужоеОкно - своёОкно) : 0;
    // Порог не косметический: до двадцати четырёх точек ни один пункт не переходит границу окна
    // целиком, а ниже этого числа шумели бы округления самих браузеров.
    var важно = Math.abs(поВысоте) > 24 || Math.abs(поОкну) > 8;
    знак.classList.toggle("hidden", !важно);
    if (!важно) { знак.textContent = ""; знак.title = ""; return; }
    знак.textContent = "у клиента иначе: " + (поВысоте > 0 ? "+" : "") + поВысоте + " точек содержимого";
    знак.title = "Содержимое страницы у клиента " + чужоеВсего + " точек, здесь " + своёВсего + "."
      + " Окно у клиента " + чужоеОкно + " точек, здесь " + своёОкно + "."
      + " Значит переносы строк разошлись, и нижние пункты у вас и у клиента стоят не на одном месте."
      + " Прокрутка при этом повторяется долей, а не числом точек, чтобы место в тексте совпадало.";
  }

  function повторитьПрокрутку(body, прокрутка) {
    if (!body || !прокрутка) return;
    // Отложено до следующего кадра: до вставки в страницу у элемента нет ни высоты, ни
    // прокручиваемой области, и присвоение scrollTop не даёт ничего.
    requestAnimationFrame(function () {
      сказатьПроРазницу(body.scrollHeight, body.clientHeight, прокрутка.h || 0, прокрутка.view || 0);
      var своё = body.scrollHeight - body.clientHeight;
      if (!(своё > 0)) return;                       // содержимое умещается целиком, листать нечего
      var чужое = (прокрутка.h || 0) - (прокрутка.view || 0);
      var верх = прокрутка.top || 0;
      // Расхождение высот больше пятой части значит, что точное число точек соврёт: берём долю.
      if (чужое > 0 && Math.abs(чужое - своё) > своё * 0.2) верх = Math.round(своё * (верх / чужое));
      body.scrollTop = Math.max(0, Math.min(своё, верх));
    });
  }

  /// Нижняя панель планшета. Это копия, а не кнопки: нажать здесь нельзя ничего, и на планшет
  /// отсюда не уходит ничего. Нужна она и глазами, и геометрией: на планшете содержимое лежит
  /// между шапкой и этой панелью, и без неё всё съезжает вверх.
  function watchFoot(doc, st, type) {
    var низ = el("div", "wt-foot");
    // На экране прощания планшет очищает панель целиком (kiosk.js, renderThankYou).
    if (type === "thankyou") { низ.classList.add("wt-foot-empty"); return низ; }
    var шаг = (st && st.step) || 1;
    низ.appendChild(кнопкаНаПланшете("Назад", "wt-btn-ghost" + (шаг > 1 ? "" : " wt-btn-off")));
    var сколькоНеХватает = ((st && st.missing) || []).length;
    var подсказка = el("div", "wt-note");
    if (type === "signature") подсказка.textContent = (st && st.finalInk) ? "" : "Поставьте подпись в поле выше";
    // Надписи про обязательные пункты в подвале больше нет ни здесь, ни на планшете: нажатие
    // «Далее» красит сам пункт рамкой и пишет под ним, чего не хватает, прямо там, куда надо
    // смотреть. Строка в подвале повторяла то же самое и стояла далеко от пункта.
    else подсказка.textContent = "";
    низ.appendChild(подсказка);
    // Кнопка «Ниже есть ещё» с экрана клиента. Оператор обязан видеть то же, что клиент, вплоть
    // до того, подсказывает ли сейчас планшет пролистать вниз: иначе оператор считает, что
    // человек всё видит, а тот сидит перед подсказкой и не понимает, чего от него хотят.
    var прокрутка = (st && st.scroll) || null;
    if (прокрутка && (прокрутка.h - прокрутка.top - прокрутка.view) > 24) {
      var ниже = el("div", "wt-scroll-down");
      ниже.appendChild(el("span", null, "Пролистайте ниже"));
      ниже.appendChild(el("span", "wt-scroll-down-arrow"));
      низ.appendChild(ниже);
    }
    if (type === "signature") {
      низ.appendChild(кнопкаНаПланшете("Очистить", "wt-btn-ghost"));
      низ.appendChild(кнопкаНаПланшете("ПОДПИСАТЬ", "wt-btn-sign" + ((st && st.finalInk) ? "" : " wt-btn-wait")));
    } else {
      // Последняя страница информационного документа заканчивает его, а не ведёт дальше:
      // планшет пишет на кнопке «Готово» (kiosk.js, renderPage). Дальше у такого документа
      // только экран прощания, поэтому «последняя» это когда шагов больше не осталось.
      var инфо = String((doc && doc.kind) || "").toLowerCase() === "info";
      var последняя = инфо && st && st.step && st.steps && st.step === st.steps;
      низ.appendChild(кнопкаНаПланшете(последняя ? "Готово" : "Далее",
        "wt-btn-primary" + (сколькоНеХватает ? " wt-btn-wait" : "")));
    }
    return низ;
  }

  /// Кнопка, как она выглядит на планшете. Именно выглядит: это не кнопка, а её изображение.
  /// Настоящей кнопке в окне наблюдения места нет, её прочли бы как действие над планшетом.
  function кнопкаНаПланшете(текст, вид) {
    var н = el("div", "wt-btn " + вид, текст);
    н.setAttribute("aria-hidden", "true");
    return н;
  }

  /// Блоки, которые клиент действительно видит: тот же отбор, что делает планшет (kiosk.js,
  /// visible()). Блок без условия проходит всегда.
  function видимыеБлоки(список, держит) {
    return (список || []).filter(function (b) { return b && держит(b.visibleWhen); });
  }

  // Условия, которые считает планшет, наблюдение обязано считать так же. Планшет присылает всё
  // нужное: отметки, выбор, вписанное, подписи и коды. Раньше эти условия здесь не считались
  // вовсе, и оператор видел блок, пункт или поле, которых у клиента на экране нет, а после
  // нового показа наблюдение продолжало показывать блок, открытый отметкой прошлого клиента.
  function наблюдениеУсловия(doc, st) {
    var checks = (st && st.checks) || {};
    var picks = (st && st.picks) || {};
    var inputs = (st && st.inputs) || {};
    var signs = (st && st.signs) || {};
    var codes = (st && st.codes) || {};
    var pages = (doc && doc.pages) || [];
    // Виден ли сам элемент. Значение скрытого элемента считается пустым: клиент его не видит,
    // планшет его не отправляет, и сервер тоже считает пустым.
    //
    // Раньше этой проверки здесь не было, и значение бралось как есть. Цепочка «пункт А
    // открывает пункт Б, Б открывает блок В» после снятия отметки с А оставляла В на экране
    // оператора, хотя у клиента его уже нет. Замер: у клиента 6 меток, у оператора 12, лишними
    // оказались блоки, открытые через снятые условия. Окно наблюдения при этом обещает и в
    // подписи кнопки, и здесь в пояснении, что показывает ровно клиентский экран.
    //
    // Сторож вПути защищает от ссылок по кругу, как на планшете: условие может ссылаться на
    // элемент, чьё условие ссылается обратно.
    var вПути = {};
    function виднаЛиЧасть(имя, своё, страница) {
      if (вПути[имя]) return false;
      вПути[имя] = true;
      try { return держит(страница) && держит(своё); }
      finally { delete вПути[имя]; }
    }
    function значение(key) {
      var found = "", нашли = false;
      // Порядок тот же, что на планшете и на сервере: отметки, выбор, вписанное, подписи, коды.
      // Последнее и побеждает, если одно имя досталось двум элементам.
      pages.forEach(function (p, i) {
        (p.checkboxes || []).forEach(function (cb, ci) {
          if (!cb || !тоЖеИмя(cb.key, key)) return;
          нашли = true;
          found = (виднаЛиЧасть("c" + i + "_" + ci, cb.visibleWhen, p.visibleWhen)
            && checks["p" + i + "_c" + ci]) ? "true" : "false";
        });
        (p.groups || []).forEach(function (g, gi) {
          if (!g || !тоЖеИмя(g.key, key)) return;
          нашли = true;
          found = виднаЛиЧасть("g" + i + "_" + gi, g.visibleWhen, p.visibleWhen) ? (picks[g.key] || "") : "";
        });
        (p.inputs || []).forEach(function (inp, ii) {
          if (!inp || !тоЖеИмя(inp.key, key)) return;
          нашли = true;
          found = виднаЛиЧасть("i" + i + "_" + ii, inp.visibleWhen, p.visibleWhen)
            ? String(inputs[inp.key] != null ? inputs[inp.key] : (inp.value || "")) : "";
        });
        (p.signatures || []).forEach(function (sg, si) {
          if (!sg || !тоЖеИмя(sg.key, key)) return;
          нашли = true;
          found = (виднаЛиЧасть("s" + i + "_" + si, sg.visibleWhen, p.visibleWhen)
            && signs[sg.key]) ? "подписано" : "";
        });
        (p.scans || []).forEach(function (sc, ni) {
          if (!sc || !тоЖеИмя(sc.key, key)) return;
          нашли = true;
          var код = codes[sc.key];
          found = (виднаЛиЧасть("n" + i + "_" + ni, sc.visibleWhen, p.visibleWhen) && код)
            ? (код.code || "") : "";
        });
      });
      if (!нашли) {
        if (Object.prototype.hasOwnProperty.call(picks, key)) return picks[key] || "";
        if (Object.prototype.hasOwnProperty.call(inputs, key)) return inputs[key] || "";
      }
      return found;
    }
    function частьДержит(c) {
      var ok = часть(c);
      return c.not ? !ok : ok;
    }
    function часть(c) {
      // Условия по часам сервера и счёт отметок наблюдение не пересчитывает: часов службы у него
      // нет, а перечень имён у счёта отметок разбирается отдельно. Считаем их выполненными, как
      // это делает прожектор в редакторе.
      // Условия по часам СЛУЖБЫ наблюдение не пересчитывает: своих часов службы у него нет.
      // Возраст и годовщину планшет считает сам, по вписанной клиентом дате, и наблюдение
      // обязано считать так же. Раньше «до годовщины» здесь считалось выполненным ВСЕГДА, а
      // возраст проваливался в сравнение строк («2020-01-11» против «18») и не выполнялся
      // никогда: оператор видел не то в обе стороны.
      if (c.op === "dow" || c.op === "daterange" || c.op === "timerange") return true;
      // Счёт тот же, что на планшете, вплоть до мелочей: три года у годовщины (иначе окно у
      // края года давало бы разный ответ), 29 февраля в невисокосный год празднуется 28-го,
      // и «5x» числом не считается.
      if (c.op === "agelt" || c.op === "agege") {
        var лет = возрастЛетДляНаблюдения(значение(c.field));
        var порог = целоеДляНаблюдения(c.value);
        if (лет === null || порог === null) return false;
        return c.op === "agelt" ? лет < порог : лет >= порог;
      }
      if (c.op === "annivwithin") {
        var дни = дниДоГодовщиныДляНаблюдения(значение(c.field));
        if (!дни) return false;
        // Окно задаётся как «до/после» или одним числом в обе стороны. Сам день попадает в оба.
        var окно = String(c.value || "").split("/");
        var до = целоеДляНаблюдения(окно[0]);
        var после = окно.length > 1 ? целоеДляНаблюдения(окно[1]) : до;
        if (до === null || до < 0 || после === null || после < 0) return false;
        return дни.some(function (d) { return d >= 0 ? d <= до : (-d) <= после; });
      }
      if (c.op === "minchecked") {
        var надо = parseInt(c.value, 10);
        if (!(надо >= 1)) return false;
        var есть = String(c.field || "").split(",").map(function (x) { return x.trim(); })
          .filter(function (x) { return x.length; })
          .filter(function (k) { return String(значение(k) || "").trim().toLowerCase() === "true"; }).length;
        return есть >= надо;
      }
      var val = String(значение(c.field) || "").trim().toLowerCase();
      var target = String(c.value || "").trim().toLowerCase();
      if (c.op === "numlt" || c.op === "numge" || c.op === "numin") {
        var n = parseFloat(val.replace(",", "."));
        if (!isFinite(n)) return false;
        if (c.op === "numin") {
          // Пустой край это «без предела»: считаем так же, как планшет и служба.
          var гр = target.split("..");
          var a = parseFloat(String(гр[0]).replace(",", ".")), b = parseFloat(String(гр[1] || "").replace(",", "."));
          if (!isFinite(a) && !isFinite(b)) return false;
          if (isFinite(a) && n < a) return false;
          if (isFinite(b) && n > b) return false;
          return true;
        }
        var lim = parseFloat(target.replace(",", "."));
        if (!isFinite(lim)) return false;
        return c.op === "numlt" ? n < lim : n >= lim;
      }
      switch (c.op) {
        // Как на планшете: «не равно» не выполняется, когда значения нет вовсе.
        case "ne": return val.length > 0 && val !== target;
        case "empty": return val.length === 0;
        case "notempty": return val.length > 0;
        case "in": return target.split(",").map(function (x) { return x.trim(); })
          .filter(function (x) { return x.length; }).indexOf(val) >= 0;
        default: return val === target;
      }
    }
    // Названа отдельно, чтобы её могла звать проверка видимости элемента выше: она объявлена
    // раньше, а зовётся позже, когда держит уже есть.
    function держит(cond) {
      if (!cond) return true;
      var наборы = condGroups(cond);
      for (var i = 0; i < наборы.length; i++) {
        var части = condParts(наборы[i]), ok = true;
        for (var j = 0; j < части.length; j++) if (!частьДержит(части[j])) { ok = false; break; }
        if (ok) return true;
      }
      return false;
    }
    return держит;
  }

  // Страница рисуется теми же кирпичиками, что и предпросмотр, но без единого обработчика:
  // отметки здесь только показываются, нажать на них нельзя. Порядок и сборка ровно те же, что
  // на планшете (kiosk.js, renderPage): идущие подряд пункты собираются в один блок с тесным
  // отступом, а над ними, когда так задано и пунктов много, стоит «Отметить всё». Прежде
  // пункты шли вперемешку с абзацами и одинаковыми отступами, и список у оператора выглядел
  // длиннее, чем у клиента.
  function watchPage(body, page, pi, st, держит) {
    var checks = (st && st.checks) || {};
    var picks = (st && st.picks) || {};
    var codes = (st && st.codes) || {};
    var signs = (st && st.signs) || {};
    var inputs = (st && st.inputs) || {};

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

    // Коробка под подряд идущие пункты. Прерывается любым другим элементом, ровно как на
    // планшете: коробка там собирается заново после каждого абзаца, группы или поля.
    var коробка = null;
    function коробкаПунктов() {
      if (!коробка) { коробка = el("div", "wt-checks"); body.appendChild(коробка); }
      return коробка;
    }
    // «Отметить всё» показывается только когда так задано документом и видимых пунктов не
    // меньше трёх: над двумя такая строка смотрелась бы насмешкой (kiosk.js, makeCheckAll).
    var видимыхПунктов = (page.checkboxes || []).filter(function (cb) {
      return cb && держит(cb.visibleWhen);
    });
    var всеОтмечены = видимыхПунктов.length > 0 && видимыхПунктов.every(function (cb) {
      return checks["p" + pi + "_c" + (page.checkboxes || []).indexOf(cb)];
    });
    var поставленаКнопкаВсё = false;

    pageOrder(page, blocks).forEach(function (it) {
      // Ровно как на планшете (kiosk.js, pageItems): элемент, чьё условие не выполнено, клиент
      // не видит, и в наблюдении его быть не должно.
      if (!держит(it.item.visibleWhen)) return;
      if (it.kind === 1) {
        if (page.showCheckAll && !поставленаКнопкаВсё && видимыхПунктов.length >= 3) {
          поставленаКнопкаВсё = true;
          body.appendChild(кнопкаНаПланшете(всеОтмечены ? "Снять все отметки" : "Отметить всё",
            "wt-btn-ghost wt-check-all"));
        }
        var key = "p" + pi + "_c" + it.index;
        коробкаПунктов().appendChild(watchCheck(it.item.labelRuns, it.item.label, !!checks[key],
          it.item.required, краснаяПометка(st, key)));
        return;
      }
      коробка = null;
      if (it.kind === 0) { previewBlock(body, it.item); return; }
      if (it.kind === 2) {
        var g = it.item;
        var пометкаГруппы = краснаяПометка(st, g.key || "");
        var box = el("div", "pv-group" + (пометкаГруппы ? " wt-miss" : ""));
        if (g.title || (g.titleRuns || []).length) {
          var gt = el("div", "pv-group-title");
          previewRuns(gt, labelRuns(g.titleRuns, g.title));
          if (g.required) gt.appendChild(el("span", "req", " *"));
          box.appendChild(gt);
        }
        var opts = el("div", "pv-group-options");
        (g.options || []).forEach(function (o) {
          opts.appendChild(watchCheck(o.labelRuns, o.label || o.key, (picks[g.key] || "") === o.key, false));
        });
        box.appendChild(opts);
        if (пометкаГруппы && пометкаГруппы.text) box.appendChild(el("div", "wt-miss-note", пометкаГруппы.text));
        body.appendChild(box);
        return;
      }
      if (it.kind === 5) {
        // Поле ввода. Прежде этой ветки не было, и поле попадало в общий хвост, где всё
        // считается сканированием: оператор видел выдуманное «Сканирование кода» и надпись
        // «Код ещё не считан» вместо того, что клиент вписал.
        var inp = it.item;
        var iw = el("div", "pv-inline-input");
        iw.appendChild(el("div", "pv-inline-title", (inp.label || "Поле ввода") + (inp.required ? " *" : "")));
        var знач = (inputs[inp.key] != null && String(inputs[inp.key]).length) ? String(inputs[inp.key]) : "";
        iw.appendChild(el("div", знач ? "watch-value" : "sig-meta", знач || "Клиент ещё не вписал"));
        body.appendChild(iw);
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
      // Планшет присылает про каждый код целые сведения: { code, format, label } (kiosk.js,
      // doc.codes). Раньше сюда уходил весь этот объект, и оператор вместо считанного кода
      // читал «[object Object]». Строку тоже принимаем: её шлёт планшет, который не успел
      // перечитать страницу после обновления службы.
      var код = codes[sc.key];
      var текстКода = !код ? "" : (typeof код === "string" ? код : (код.code || ""));
      cw.appendChild(el("div", текстКода ? "watch-code" : "sig-meta", текстКода || "Код ещё не считан"));
      body.appendChild(cw);
    });
  }

  /// Что сейчас покрашено красным на экране клиента, по ключу. Планшет присылает именно
  /// покрашенное, а не «чего не хватает вообще»: краснеет оно только после нажатия «Далее», и
  /// подсветка у оператора обязана загораться и гаснуть в те же мгновения, что у клиента.
  function краснаяПометка(st, ключ) {
    var спис = (st && st.miss) || [];
    for (var i = 0; i < спис.length; i++) if (спис[i] && спис[i].key === ключ) return спис[i];
    return null;
  }

  // Пункт согласия так, как он выглядит у клиента, включая красную подсветку «не отмечено» и
  // надпись под ней теми же словами. Прежде подсветки здесь не было вовсе: планшет о ней не
  // сообщал, и оператор видел спокойный пункт там, где у клиента горела красная рамка.
  function watchCheck(runs, plain, on, required, пометка) {
    var row = el("div", "watch-check" + (on ? " on" : "") + (пометка ? " wt-miss" : ""));
    row.appendChild(el("span", "watch-box", on ? "✓" : ""));
    row.appendChild(labelNode("watch-label", runs, plain, required));
    if (пометка && пометка.text) row.appendChild(el("div", "wt-miss-note", пометка.text));
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
    // Версия страницы перечитывается при каждом восстановлении связи. Связь рвётся как раз тогда,
    // когда службу перезапускают, то есть при выкате новой версии. Раньше номер читался один раз
    // за загрузку админки, и открытая с утра вкладка после выката сравнивала свежую версию,
    // сообщённую планшетами, со своим вчерашним числом и писала «обновите страницу на планшете»
    // на карточках исправного парка. Замер: три карточки из четырёх обвинены зря.
    conn.onreconnected(function () {
      узнатьВерсиюСтраницы();
      reg(); loadDevices(); loadAlerts(); if (watch.deviceId) watchStart();
    });
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
    // Версия страницы планшетов читается один раз за загрузку админки, из самой страницы.
    узнатьВерсиюСтраницы();
    var safe = function (fn) { return function () { return fn().catch(function (e) { console.error(e); }); }; };
    // Библиотека читается раньше документа: она говорит, какой документ открывать. Раньше
    // документ читался первым и всегда без указания, то есть основной, и перезагрузка страницы
    // уводила оператора из того документа, который он правил.
    var открытьРабочий = function () { return loadDoc(state.docId || undefined); };
    Promise.all([safe(loadFieldSchema)().then(safe(loadLibrary)).then(safe(открытьРабочий)),
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
