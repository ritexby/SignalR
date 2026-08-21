/* Admin panel: slides, signing document, signatures, and fleet management -
   devices (enrollment codes, revoke, identify), groups, workstations, API keys. */
(function () {
  "use strict";

  // Kept in step with the version badge and with APP_VERSION in kiosk.js. A tablet reports the
  // build of the page it is running, so a WebView still on an older page can be spotted rather
  // than silently ignoring anything added since.
  var APP_VERSION = "5.2";

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
  function openModal(node) { var c = $("modalContent"); releaseModalUrls(); c.innerHTML = ""; c.appendChild(node); $("modal").classList.remove("hidden"); }
  function closeModal() { releaseModalUrls(); $("modalContent").innerHTML = ""; $("modal").classList.add("hidden"); }
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
      card.addEventListener("click", function () {
        var i = state.playlist.indexOf(img.id);
        if (i >= 0) state.playlist.splice(i, 1); else state.playlist.push(img.id);
        renderImages();
      });
      grid.appendChild(card);
    });
  }
  $("imageUpload").addEventListener("change", function () {
    var input = $("imageUpload"); if (!input.files.length) return;
    var fd = new FormData();
    Array.prototype.forEach.call(input.files, function (f) { fd.append("files", f); });
    // Reset the file input on BOTH paths: after a failed upload the input still held the same
    // files, so re-picking them fired no change event and the button looked dead.
    api("/images", { method: "POST", body: fd }).then(loadImages).then(renderImages)
      .then(function () { toast("Картинки загружены"); })
      .catch(function () { /* reported by api() */ })
      .then(function () { input.value = ""; });
  });
  $("saveSlides").addEventListener("click", function () {
    var interval = parseInt($("intervalInput").value, 10) || 6;
    var ids = state.slidesTarget === "devices" && slidesPicker ? slidesPicker.ids() : null;
    if (state.slidesTarget === "devices" && (!ids || !ids.length)) { toast("Отметьте хотя бы один планшет."); return; }
    apiSend("/playlist", "PUT", { target: state.slidesTarget, imageIds: state.playlist, intervalSec: interval, deviceIds: ids })
      .then(function () { toast("Сохранено и отправлено (" + targetLabel(state.slidesTarget, ids) + ")"); });
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
  // Возраст считается из даты рождения: внешняя система присылает только ДР, а документу нужно
  // знать, младше ли человек четырнадцати, чтобы показать блок для законных представителей.
  // Две операции, а не четыре: «младше N» и «N и старше» делят людей ровно надвое.
  var COND_OPS = [["eq", "равно"], ["ne", "не равно"], ["empty", "пусто"], ["notempty", "не пусто"],
    ["in", "одно из (через запятую)"], ["agelt", "возраст меньше, лет"], ["agege", "возраст от, лет"]];
  var AGE_OPS = ["agelt", "agege"];
  function isAgeOp(op) { return AGE_OPS.indexOf(op) >= 0; }
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

  function loadDoc() {
    return apiJson("/document").then(function (d) {
      state.doc = d; renderDoc(); docLoaded = true;
      // Черновик предлагается, только когда открыта вкладка документа: окно поверх «Слайдов»
      // перекрывало бы вкладки и мешало тому, кто про документ сейчас и не думает.
      if (document.querySelector('[data-panel="document"]:not(.hidden)')) maybeOfferDraft();
    });
  }

  var docLoaded = false;
  var draftOffered = false;

  function maybeOfferDraft() {
    if (draftOffered || !docLoaded) return;
    draftOffered = true;
    offerDraft();
  }
  function renderDoc() {
    $("docTitle").value = state.doc.title || ""; $("signPrompt").value = state.doc.signPrompt || ""; $("thankYou").value = state.doc.thankYouText || "";
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
      if (last && !!last.bold === !!f.bold && !!last.italic === !!f.italic && (last.color || null) === color && (last.size || null) === size) last.text += text;
      else runs.push({ text: text, bold: !!f.bold, italic: !!f.italic, color: color, size: size });
      atStart = false;
    }
    function nl(f) { push("\n", f); atStart = true; }
    function derive(elm, f) {
      var g = { bold: f.bold, italic: f.italic, color: f.color, size: f.size }, t = elm.tagName;
      if (t === "B" || t === "STRONG") g.bold = true;
      if (t === "I" || t === "EM") g.italic = true;
      var st = elm.style;
      if (st) {
        if (st.fontWeight === "bold" || parseInt(st.fontWeight, 10) >= 600) g.bold = true;
        if (st.fontStyle === "italic") g.italic = true;
        if (st.color) { if (st.color === "inherit") g.color = null; else { var hx = rgbToHex(st.color); if (hx) g.color = hx; } }
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
    })(root, { bold: false, italic: false, color: null, size: null });
    return runs.map(function (r) { return { text: r.text, bold: r.bold || undefined, italic: r.italic || undefined, color: r.color || undefined, size: r.size || undefined }; });
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
    document.body.appendChild(bar);
    return bar;
  }

  function placeRtBar() {
    if (!rtBar || !rtTarget || rtBar.classList.contains("hidden")) return;
    var r = rtTarget.getBoundingClientRect();
    var barH = rtBar.offsetHeight || 40;
    var top = document.querySelector(".topbar");
    var minTop = (top ? top.offsetHeight : 0) + 6;
    // Панель стоит над полем. Если поле уехало под шапку, панель остаётся у шапки, чтобы не
    // исчезнуть вместе с началом длинного блока.
    var y = r.top - barH - 6;
    if (y < minTop) y = Math.min(minTop, Math.max(minTop, r.bottom - barH - 6));
    if (r.bottom < minTop || r.top > window.innerHeight - 20) { rtBar.classList.add("hidden"); return; }
    var x = Math.max(8, Math.min(r.left, window.innerWidth - rtBar.offsetWidth - 8));
    rtBar.style.top = Math.round(y) + "px";
    rtBar.style.left = Math.round(x) + "px";
  }

  function showRtBar(ed) {
    if (!rtBar) rtBar = buildRtBar();
    rtTarget = ed;
    rtBar.classList.remove("hidden");
    placeRtBar();
  }

  function hideRtBar() {
    if (rtBar) rtBar.classList.add("hidden");
    rtTarget = null;
  }

  // Панель показывается по фокусу в поле и прячется, когда фокус ушёл и из поля, и из неё.
  document.addEventListener("focusin", function (e) {
    var ed = e.target.closest ? e.target.closest(".rt-editor") : null;
    if (ed) { showRtBar(ed); return; }
    if (rtBar && rtBar.contains(e.target)) return;
    hideRtBar();
  });
  window.addEventListener("scroll", function () { placeRtBar(); }, true);
  window.addEventListener("resize", function () { placeRtBar(); });

  function richEditor(labelText, runs, role) {
    var wrap = el("div", "rt-field");
    if (labelText) wrap.appendChild(el("div", "rt-label", labelText));
    var ed = el("div", "rt-editor"); ed.contentEditable = "true"; ed.setAttribute("data-role", role); ed.innerHTML = runsToHtml(runs);
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

    // Условие можно составить из нескольких: показывать, только если выполнены все сразу
    // («Пол равно F и UG равно true»). Список плоский, без скобок: так его можно прочитать
    // одной строкой, и оператору не приходится держать в голове приоритеты.
    var addAnd = iconBtn("plus", "и ещё условие", "btn-ghost btn-sm cond-add");
    addAnd.addEventListener("click", function () {
      addRow(null);
      badge.textContent = describe();
      var last = rows.lastElementChild;
      var sel = last && last.querySelector("select");
      if (sel) sel.focus();
    });
    fields.appendChild(addAnd);

    // Одна строка условия: тег, сравнение, значение. Строки после первой соединяются словом «и».
    function condRow(part) {
      var row = el("div", "cond-row"); row.setAttribute("data-role", "crow");
      var joiner = el("span", "cond-and", "и");
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

      var op = el("select", "cond-op"); op.setAttribute("data-role", "cop");
      COND_OPS.forEach(function (o) { op.appendChild(new Option(o[1], o[0])); });

      // Значение выбирается списком, если у тега фиксированный набор, иначе вводится текстом.
      var valSel = el("select", "cond-val-sel"); valSel.setAttribute("data-role", "cvalsel");
      var val = el("input", "cond-val"); val.type = "text"; val.placeholder = "значение"; val.setAttribute("data-role", "cval");

      row.appendChild(fld); row.appendChild(fldOther); row.appendChild(op);
      row.appendChild(valSel); row.appendChild(val);

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
        // У возраста значение это число лет: список значений тега тут ни при чём.
        if (isAgeOp(op.value)) known = null;
        // «одно из» принимает список через запятую, одним выбором его не выразить.
        var listable = known && op.value !== "in";
        valSel.innerHTML = "";
        if (listable) {
          known.forEach(function (v) { valSel.appendChild(new Option(valueLabel(f, v), v)); });
          valSel.appendChild(new Option("другое...", OTHER_OPTION));
          if (keep && known.indexOf(keep) < 0) { valSel.value = OTHER_OPTION; val.value = keep; }
          else { valSel.value = keep || known[0]; val.value = ""; }
        } else if (keep != null) {
          val.value = keep;
        }
        valSel.style.display = listable ? "" : "none";
        val.style.display = (!listable || valSel.value === OTHER_OPTION) ? "" : "none";
      }

      function syncRow() {
        fldOther.style.display = fld.value === OTHER_OPTION ? "" : "none";
        // Возраст вводится числом, а не текстом: так в поле не окажется «четырнадцать».
        if (isAgeOp(op.value)) {
          val.type = "number"; val.min = "0"; val.max = "130"; val.placeholder = "лет";
          val.classList.add("cond-age");
        } else {
          val.type = "text"; val.removeAttribute("min"); val.removeAttribute("max");
          val.placeholder = "значение"; val.classList.remove("cond-age");
        }
        var needsValue = op.value !== "empty" && op.value !== "notempty";
        valSel.style.display = needsValue && valSel.options.length ? "" : "none";
        val.style.display = needsValue && (!valSel.options.length || valSel.value === OTHER_OPTION) ? "" : "none";
      }

      fld.addEventListener("change", function () { syncValues(null); syncRow(); });
      fldOther.addEventListener("input", function () { syncValues(val.value); syncRow(); });
      op.addEventListener("change", function () { syncValues(readRowValue(row)); syncRow(); });
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
        syncValues(part.value || "");
      } else {
        syncValues(null);
      }
      syncRow();

      [fld, fldOther, op, val, valSel].forEach(function (e) {
        e.addEventListener("change", function () { badge.textContent = describe(); });
        e.addEventListener("input", function () { badge.textContent = describe(); });
      });
      return row;
    }

    function addRow(part) { rows.appendChild(condRow(part)); renumber(); }

    // Слово «и» и кнопка удаления нужны только у строк после первой: первая строка это само
    // условие, без неё остальные не имеют смысла.
    function renumber() {
      var list = rows.querySelectorAll('[data-role="crow"]');
      if (!list.length) { addRow(null); return; }
      for (var i = 0; i < list.length; i++) {
        list[i].classList.toggle("cond-extra", i > 0);
        var drop = list[i].querySelector(".cond-drop");
        if (drop) drop.style.display = i > 0 ? "" : "none";
      }
    }

    addRow(cond || null);
    ((cond && cond.and) || []).forEach(function (extra) { addRow(extra); });

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
    function describePart(c) {
      var opName = "";
      COND_OPS.forEach(function (o) { if (o[0] === c.op) opName = o[1]; });
      if (c.op === "empty" || c.op === "notempty") return "«" + c.field + "» " + opName;
      if (c.op === "agelt") return "возраст по «" + c.field + "» меньше " + (c.value || "?") + " лет";
      if (c.op === "agege") return "возраст по «" + c.field + "» от " + (c.value || "?") + " лет";
      return "«" + c.field + "» " + opName + " " + (valueLabel(c.field, c.value) || "(пусто)");
    }
    function describe() {
      var c = readCondition(box);
      if (!c) return "+ условие показа";
      var parts = [describePart(c)];
      (c.and || []).forEach(function (extra) { parts.push(describePart(extra)); });
      return "только если " + parts.join(" и ");
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

  // Части составного условия: само условие и всё, что присоединено через «и».
  function condParts(cond) {
    var out = [];
    if (cond && cond.field) out.push(cond);
    ((cond && cond.and) || []).forEach(function (extra) { if (extra && extra.field) out.push(extra); });
    return out;
  }

  function readRowValue(row) {
    var valSel = row.querySelector('[data-role="cvalsel"]');
    var valInput = row.querySelector('[data-role="cval"]');
    return (valSel && valSel.options.length && valSel.value !== OTHER_OPTION)
      ? valSel.value
      : (valInput ? valInput.value : "");
  }

  function readRow(row) {
    var sel = row.querySelector('[data-role="cfieldsel"]');
    var other = row.querySelector('[data-role="cfield"]');
    var field = (sel && sel.value && sel.value !== OTHER_OPTION ? sel.value : (other ? other.value : "")).trim();
    if (!field) return null;
    var op = row.querySelector('[data-role="cop"]');
    return { field: field, op: (op && op.value) || "eq", value: (readRowValue(row) || "").trim() };
  }

  function readCondition(box) {
    if (!box) return null;
    var mode = box.querySelector(".cond-mode"); if (!mode || mode.value !== "cond") return null;
    var parts = [];
    box.querySelectorAll('[data-role="crow"]').forEach(function (row) {
      var part = readRow(row);
      if (part) parts.push(part);
    });
    if (!parts.length) return null;
    var head = parts[0];
    if (parts.length > 1) head.and = parts.slice(1);
    return head;
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
    items.sort(function (a, b) { return (a.ord - b.ord) || (a.kind - b.kind) || (a.index - b.index); });
    return items;
  }

  function headingRunsOf(page) { return (page.headingRuns && page.headingRuns.length) ? page.headingRuns : (page.heading ? [{ text: page.heading }] : []); }
  function blocksOf(page) { return (page.blocks && page.blocks.length) ? page.blocks : (page.body ? [{ runs: [{ text: page.body }] }] : []); }

  function scanPlaceholders() {
    var texts = [$("docTitle").value, $("signPrompt").value, $("thankYou").value];
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

  function blockCard(b) {
    b = b || {};
    var bc = el("div", "block-card page-item"); bc.setAttribute("data-role", "blockcard");
    bc.setAttribute("data-kind", "block");
    var isImage = !!b.imageUrl;

    var modeBar = el("div", "block-mode");
    var handle = el("span", "drag-handle");
    handle.appendChild(icon("grip"));
    handle.title = "Перетащите, чтобы изменить порядок блоков";
    modeBar.appendChild(handle);
    var seg = el("div", "seg");
    var btnText = iconBtn("text", "Текст", "btn-sm"); btnText.type = "button";
    var btnImg = iconBtn("image", "Картинка", "btn-sm"); btnImg.type = "button";
    seg.appendChild(btnText); seg.appendChild(btnImg);
    modeBar.appendChild(seg);
    bc.appendChild(modeBar);

    var textWrap = richEditor("", b.runs || [], "blockbody");
    bc.appendChild(textWrap);

    var imgWrap = el("div", "block-image");
    var img = el("img", "block-image-preview");
    if (b.imageUrl) { img.src = b.imageUrl; } else { img.style.display = "none"; }
    img.style.width = (b.imageWidth || 100) + "%";
    if (b.imageUrl) bc.setAttribute("data-imgurl", b.imageUrl);
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
    imgWrap.appendChild(img); imgWrap.appendChild(pick); imgWrap.appendChild(wLabel);
    bc.appendChild(imgWrap);

    function setMode(m) {
      bc.setAttribute("data-mode", m);
      textWrap.style.display = m === "text" ? "" : "none";
      imgWrap.style.display = m === "image" ? "" : "none";
      btnText.classList.toggle("mode-on", m === "text");
      btnImg.classList.toggle("mode-on", m === "image");
    }
    btnText.addEventListener("click", function () { setMode("text"); });
    btnImg.addEventListener("click", function () { setMode("image"); });
    setMode(isImage ? "image" : "text");

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
    if (bc.getAttribute("data-mode") === "image") {
      var url = bc.getAttribute("data-imgurl");
      if (!url) return null;
      var w = parseInt((bc.querySelector('[data-role="blockimgw"]') || {}).value, 10) || 100;
      var blk = { imageUrl: url, imageWidth: w }; if (cond) blk.visibleWhen = cond; return blk;
    }
    var ed = bc.querySelector('[data-role="blockbody"]');
    var runs = ed ? editorToRuns(ed) : [];
    var hasText = runs.some(function (r) { return (r.text || "").trim().length; });
    if (!hasText && !cond) return null;
    var blk2 = { runs: runs }; if (cond) blk2.visibleWhen = cond; return blk2;
  }

  function readCheckboxRow(r) {
    var lab = r.querySelector('[data-role="cblabel"]').value;
    if (!lab.trim()) return null;
    var item = {
      key: ((r.querySelector('[data-role="cbkey"]') || {}).value || "").trim(),
      label: lab,
      required: r.querySelector('[data-role="cbreq"]').checked,
      checked: !!(r.querySelector('[data-role="cbchecked"]') || {}).checked
    };
    var cond = readCondition(r.querySelector('[data-role="cbcond"]'));
    if (cond) item.visibleWhen = cond;
    return item;
  }

  function readGroupRow(r) {
    var options = [], used = [];
    r.querySelectorAll('[data-role="optrow"]').forEach(function (o, i) {
      var okey = (o.querySelector('[data-role="okey"]').value || "").trim();
      var olabel = o.querySelector('[data-role="olabel"]').value || "";
      // Вариант с текстом, но без имени, раньше молча пропадал, и проверка потом сообщала, что
      // вариантов нет, хотя оператор видел их на экране. Теперь имя достраивается здесь же.
      if (!okey && olabel.trim()) okey = uniqueKey(slugKey(olabel) || ("opt" + (i + 1)), used);
      if (!okey) return;
      used.push(okey);
      options.push({ key: okey, label: olabel });
    });
    var gkey = (r.querySelector('[data-role="gkey"]').value || "").trim();
    var gtitle = r.querySelector('[data-role="gtitle"]').value || "";
    // То же самое для имени самой группы: заголовок есть, значит группа нужна.
    if (!gkey && gtitle.trim()) gkey = slugKey(gtitle);
    // Совсем пустую заготовку выбрасываем, а недоделанную оставляем: молча стирать работу
    // оператора нельзя, о недостающем имени и вариантах ему скажет проверка документа.
    if (!gkey && !options.length && !gtitle.trim()) return null;
    var grp = { key: gkey, title: gtitle, required: r.querySelector('[data-role="greq"]').checked, options: options };
    var gcond = readCondition(r.querySelector('[data-role="gcond"]'));
    if (gcond) grp.visibleWhen = gcond;
    return grp;
  }

  function collectBlocks(container) {
    var out = [];
    if (!container) return out;
    container.querySelectorAll('[data-role="blockcard"]').forEach(function (bc) {
      var blk = readBlockCard(bc);
      if (blk) out.push(blk);
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
      // Условие может состоять из нескольких, соединённых через «и»: проверять надо каждое,
      // иначе ошибка во второй части осталась бы незамеченной до показа клиенту.
      condParts(cond).forEach(function (part, i) {
        checkOnePart(part, i === 0 ? where : where + ", условие " + (i + 1));
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

      if (!blocks.length && !(page.checkboxes || []).length && !(page.groups || []).length && !page.includeDynamic)
        problems.push({ level: "warn", text: where + ": на странице ничего нет." });
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

  $("checkDoc").addEventListener("click", function () {
    collectDoc();
    var problems = validateDoc();
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

    function itemsOf() {
      return Array.prototype.slice.call(list.children).filter(function (n) {
        return n.matches && n.matches(itemSelector);
      });
    }

    // Список, над которым сейчас курсор. Для элементов страницы это может быть другая страница:
    // перенести пункт со страницы 4 на страницу 2 иначе можно было только удалив и набрав
    // заново. Для самих страниц список всегда один.
    function listUnder(e) {
      if (list.getAttribute("data-role") !== "itemlist") return list;
      var under = document.elementFromPoint(e.clientX, e.clientY);
      var other = under && under.closest ? under.closest('[data-role="itemlist"]') : null;
      return other || list;
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
        window.scrollBy(0, шаг);
      }, 16);
    }
    function stopEdge() { if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; } }

    function onMove(e) {
      if (!item) return;
      moved = true;
      var y = e.clientY;
      edgeScroll(y);
      var target = listUnder(e);
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
  function insertBar(list, afterNode) {
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
      var opts = [
        ["Блок текста", function () { place(blockCard({ runs: [] })); }],
        ["Чекбокс", function () { place(checkboxRow({ label: "", required: true })); }],
        ["Двойные зависимые чекбоксы", function () { place(groupCard({ options: [{ key: "", label: "" }, { key: "", label: "" }] })); }]
      ];
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
    addTop.addEventListener("click", function () { addPage(); });
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

    // Экран подписи и «Спасибо» клиент тоже видит, поэтому в оглавлении они есть.
    var fixed = el("div", "toc-list");
    [["pen", "Подпись"], ["tick", "Спасибо"]].forEach(function (pair) {
      var row = el("div", "toc-fixed");
      row.appendChild(icon(pair[0]));
      row.appendChild(el("span", null, pair[1]));
      fixed.appendChild(row);
    });
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

  function renderPages() {
    var wrap = $("pagesEditor"); wrap.innerHTML = "";
    (state.doc.pages || []).forEach(function (page, pi) {
      var card = el("div", "page-card"); card.setAttribute("data-role", "pagecard");
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

      var name = el("span", "page-name", "Страница " + (pi + 1));
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

      body.appendChild(richEditor("Заголовок", headingRunsOf(page), "heading"));

      // Один список на всю страницу: текст, чекбоксы и выбор одного варианта стоят вперемешку,
      // в том порядке, в каком их читает клиент. Пункт должен идти сразу за своим абзацем, а не
      // в общей куче внизу страницы.
      body.appendChild(sectionLabel("layout", "Содержимое страницы (порядок такой же, как увидит клиент)"));
      var items = el("div", "item-list"); items.setAttribute("data-role", "itemlist");
      var blocks = blocksOf(page);
      if (!blocks.length && !(page.checkboxes || []).length && !(page.groups || []).length) blocks = [{ runs: [] }];
      var built = pageOrder(page, blocks).map(function (it) {
        return it.kind === 0 ? blockCard(it.item)
          : it.kind === 1 ? checkboxRow(it.item)
            : groupCard(it.item);
      });
      items.appendChild(insertBar(items, null));
      built.forEach(function (node) { items.appendChild(node); items.appendChild(insertBar(items, node)); });
      makeSortable(items, ".page-item");
      body.appendChild(items);

      var dyn = el("label", "check-inline dyn-anchor");
      var dynCb = el("input"); dynCb.type = "checkbox"; dynCb.checked = !!page.includeDynamic; dynCb.setAttribute("data-role", "includedynamic");
      dyn.appendChild(dynCb); dyn.appendChild(document.createTextNode(" Показывать здесь чекбоксы, присланные по API"));
      body.appendChild(dyn);

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
      var base = slugKey(source.value);
      keyInput.value = base ? uniqueKey(base, taken) : "";
    });
  }

  function checkboxRow(cb) {
    var box = el("div", "cb-item page-item"); box.setAttribute("data-role", "cbrow");
    box.setAttribute("data-kind", "checkbox");
    var row = el("div", "cb-row");
    var handle = el("span", "drag-handle");
    handle.appendChild(icon("grip"));
    handle.title = "Перетащите, чтобы изменить порядок";
    row.appendChild(handle);
    var label = el("input"); label.type = "text"; label.placeholder = "Текст пункта"; label.value = cb.label || ""; label.setAttribute("data-role", "cblabel"); row.appendChild(label);
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
    var title = el("input"); title.type = "text"; title.placeholder = "Общий заголовок"; title.value = g.title || ""; title.setAttribute("data-role", "gtitle"); head.appendChild(title);
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
    (g.options || []).forEach(function (o) { opts.appendChild(optionRow(o)); });
    card.appendChild(opts);
    var addOpt = iconBtn("plus", "Вариант", "btn-ghost btn-sm");
    addOpt.addEventListener("click", function () { opts.appendChild(optionRow({ key: "", label: "" })); });
    card.appendChild(addOpt);
    card.appendChild(conditionEditor(g.visibleWhen, "gcond"));
    return card;
  }

  function optionRow(o) {
    var row = el("div", "cb-row"); row.setAttribute("data-role", "optrow");
    var label = el("input"); label.type = "text"; label.placeholder = "Текст варианта"; label.value = o.label || ""; label.setAttribute("data-role", "olabel"); row.appendChild(label);
    var key = el("input", "cb-key"); key.type = "text"; key.placeholder = "имя для API"; key.value = o.key || ""; key.setAttribute("data-role", "okey"); row.appendChild(key);
    linkAutoKey(label, key, function () {
      var list = row.closest('[data-role="optlist"]');
      return list ? Array.prototype.slice.call(list.querySelectorAll('[data-role="okey"]')) : [];
    });
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { row.remove(); updatePlaceholders(); }); row.appendChild(del);
    return row;
  }
  function collectDoc() {
    state.doc.title = $("docTitle").value; state.doc.signPrompt = $("signPrompt").value; state.doc.thankYouText = $("thankYou").value;
    state.doc.idleReturnSec = parseInt($("idleReturn").value, 10) || 0;
    var pages = [];
    document.querySelectorAll('#pagesEditor [data-role="pagecard"]').forEach(function (card) {
      var hEd = card.querySelector('[data-role="heading"]');
      var headingRuns = hEd ? editorToRuns(hEd) : [];
      var pageCond = readCondition(card.querySelector('[data-role="pagecond"]'));
      var includeDynamic = !!(card.querySelector('[data-role="includedynamic"]') || {}).checked;

      // Блоки текста, чекбоксы и группы лежат в одном списке в том порядке, в каком их
      // расставил оператор. Номер берётся прямо из положения в списке, поэтому на планшете
      // страница выглядит ровно так, как в редакторе.
      var blocks = [], checkboxes = [], groups = [], ord = 0;
      card.querySelectorAll('[data-role="itemlist"] > .page-item').forEach(function (node) {
        var kind = node.getAttribute("data-kind");
        var got = kind === "block" ? readBlockCard(node)
          : kind === "checkbox" ? readCheckboxRow(node)
            : kind === "group" ? readGroupRow(node) : null;
        if (!got) return;
        got.ord = ord++;
        if (kind === "block") blocks.push(got);
        else if (kind === "checkbox") checkboxes.push(got);
        else groups.push(got);
      });
      var page = { heading: "", body: "", headingRuns: headingRuns, blocks: blocks, checkboxes: checkboxes, groups: groups, includeDynamic: includeDynamic };
      if (pageCond) page.visibleWhen = pageCond;
      pages.push(page);
    });
    state.doc.pages = pages;
    state.doc.signBlocks = collectBlocks(document.querySelector('[data-role="signblocklist"]'));
    state.doc.signBlocksBelow = collectBlocks(document.querySelector('[data-role="signblocklistbelow"]'));
  }
  // Новая страница встаёт в конец и сразу показывается: иначе после нажатия непонятно,
  // добавилось ли что-нибудь, особенно если кнопку нажали из оглавления.
  function addPage() {
    collectDoc();
    state.doc.pages.push({ headingRuns: [{ text: "Новая страница" }], blocks: [], checkboxes: [], groups: [], includeDynamic: false });
    renderPages();
    var cards = document.querySelectorAll('#pagesEditor [data-role="pagecard"]');
    scrollToCard(cards[cards.length - 1]);
  }
  $("addPage").addEventListener("click", addPage);
  $("saveDocument").addEventListener("click", function () { saveDoc().then(function () { toast("Документ сохранён"); }); });

  // ---- Защита несохранённого ----
  // Документ пишется на сервер только по кнопке. Закрытая вкладка, обновление страницы или
  // упавший браузер до этого момента уносили с собой всю работу, и ничто об этом не
  // предупреждало. Теперь правки видно в шапке, браузер спрашивает при уходе, а черновик
  // лежит в самом браузере и предлагается к восстановлению.
  var DRAFT_KEY = "sk_doc_draft";
  var dirty = false;
  var draftTimer = null;

  function markDirty() {
    if (!dirty) { dirty = true; syncDirty(); }
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 1200);
  }

  function syncDirty() {
    var btn = $("saveDocument");
    if (btn) {
      btn.classList.toggle("btn-primary", dirty);
      btn.classList.toggle("btn-ghost", !dirty);
      btn.title = dirty ? "Есть несохранённые изменения" : "Изменений нет";
    }
    var mark = $("docDirty");
    if (mark) mark.classList.toggle("hidden", !dirty);
  }

  function saveDraft() {
    try {
      collectDoc();
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Date.now(), doc: state.doc }));
    } catch (e) { /* приватный режим или переполнение: черновик просто не сохранится */ }
  }

  function dropDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* нечего убирать */ }
  }

  function saveDoc() {
    collectDoc();
    return apiSend("/document", "PUT", state.doc).then(function (r) {
      dirty = false; syncDirty(); dropDraft();
      return r;
    });
  }

  // Любая правка внутри вкладки документа считается изменением: перечислять поля по одному
  // значило бы однажды забыть новое и снова терять работу молча.
  (function () {
    var panel = document.querySelector('[data-panel="document"]');
    if (!panel) return;
    ["input", "change"].forEach(function (ev) {
      panel.addEventListener(ev, function (e) {
        if (e.target.closest && e.target.closest(".preview-setup, .preview-wrap")) return;
        markDirty();
      });
    });
    panel.addEventListener("click", function (e) {
      // Добавление, удаление и перетаскивание тоже меняют документ, а событий ввода не дают.
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
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return; }
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
    function addCond(c) { condParts(c).forEach(function (part) { add(part.field); }); }
    (state.doc.pages || []).forEach(function (p) {
      addCond(p.visibleWhen);
      (p.blocks || []).forEach(function (b) { addCond(b.visibleWhen); });
      (p.checkboxes || []).forEach(function (c) { addCond(c.visibleWhen); });
      (p.groups || []).forEach(function (g) { addCond(g.visibleWhen); });
    });
    (state.doc.signBlocks || []).forEach(function (b) { addCond(b.visibleWhen); });
    (state.doc.signBlocksBelow || []).forEach(function (b) { addCond(b.visibleWhen); });
    // Условие на чекбокс задаёт клиент на планшете, а не внешняя система: спрашивать для него
    // тестовое значение бессмысленно и только путало бы оператора.
    return out.filter(function (name) { return !isDocKey(name); });
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
      var im = el("img"); im.src = b.imageUrl;
      im.style.width = Math.min(Math.max(parseInt(b.imageWidth, 10) || 100, 10), 100) + "%";
      fig.appendChild(im); parent.appendChild(fig);
    } else {
      var t = el("div", "pv-text");
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
    function partHolds(c) {
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
      var parts = condParts(cond);
      for (var i = 0; i < parts.length; i++) if (!partHolds(parts[i])) return false;
      return true;
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
      label.appendChild(el("span", null, (cb.label || "") + (cb.required ? " *" : "")));
      return label;
    }

    // Группа: выбрать можно один вариант, повторное нажатие снимает выбор. Это чекбоксы, а не
    // радиокнопки, потому что «не выбрано» тоже состояние. Так же устроено на планшете.
    function makeGroup(g) {
      var box = el("div", "pv-group");
      if (g.title) box.appendChild(el("div", "pv-group-title", g.title + (g.required ? " *" : "")));
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
        label.appendChild(el("span", null, o.label || o.key || ""));
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
        var h = el("h2", "pv-heading"); previewRuns(h, p.headingRuns || []); body.appendChild(h);
        // Порядок ровно тот же, что покажет планшет: иначе предпросмотр обещал бы одно, а
        // клиент видел другое, и проверять по нему было бы нечего.
        pageOrder(p).forEach(function (it) {
          if (!holds(it.item.visibleWhen)) return;
          if (it.kind === 0) { previewBlock(body, it.item); return; }
          if (it.kind === 1) { body.appendChild(makeCheck(it.item, s.index, it.index)); return; }
          body.appendChild(makeGroup(it.item));
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
  $("exportDoc").addEventListener("click", function () {
    saveDoc().then(function () {
      var payload = { kind: "helix-signtablet-document", version: 1, exportedUtc: new Date().toISOString(), document: state.doc };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
      a.href = url;
      a.download = "signtablet-document-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast("Файл с шаблоном сохранён");
    });
  });

  $("importDoc").addEventListener("click", function () { $("importDocFile").click(); });
  $("importDocFile").addEventListener("change", function () {
    var input = this, file = input.files && input.files[0];
    if (!file) return;
    if (!confirm("Импорт заменит все текущие страницы документа на страницы из файла. Продолжить?")) { input.value = ""; return; }
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
          return loadDoc().then(function () { toast("Импортировано страниц: " + (j && j.pages != null ? j.pages : "")); });
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

  function loadSchedule() {
    return apiJson("/schedule/actions").then(function (list) { schActions = list || []; })
      .then(function () { return apiJson("/schedule"); })
      .then(function (data) {
        var t = $("schServerTime");
        if (t) t.textContent = "сейчас " + (data.serverTime || "-");
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
      desc: "Показать документ на планшете с данными подписанта. Плейсхолдеры {{тег}} в шаблоне (текст задаётся в админке) заполняются из fields. Поддерживаемые теги: ФИО, ДР, Адрес регистрации, Пол (M/F), email, telephone, document, date, cross-border, urine, UG (true/false), text1..text10. Булевы теги принимают только true или false, в любом виде: настоящий JSON-булев true, либо строку true в кавычках, регистр не важен. Другое значение возвращает ошибку с именем тега, а не молчаливо скрытый блок. По этим же тегам работают условия показа блоков и страниц (см. раздел «Условия показа»). Есть условия по возрасту: он считается из даты рождения на сервере, поэтому присылать нужно только ДР, а документ сам решит, показывать ли блок для законных представителей (например «возраст меньше 14 лет»). Дата принимается как 01.01.1990 или 1990-01-01; если её не удалось разобрать, приходит ошибка с именем тега, а не молча скрытый блок. Имена тегов сравниваются без учёта регистра: пол, Пол и ПОЛ это один и тот же тег. Массив checkboxes задаёт пункты согласия: если key совпадает с именем чекбокса в документе, задаётся его начальное состояние прямо на своём месте; если такого имени в документе нет, пункт добавляется в конец страницы, помеченной как приёмник, и тогда нужен label. Массив groups задаёт выбор в двойных зависимых чекбоксах: key - имя группы в документе, selected - имя выбранного варианта, пустая строка означает, что не выбрано ничего. Цель: deviceId или workstationExternalId (если на месте несколько планшетов - ответ 409, укажите deviceId: показать документ не на том экране хуже, чем вернуть ошибку). В ответе missingPlaceholders - какие теги не переданы.",
      sample: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"WS-204",\n       "fields":{"ФИО":"Иванова Анна","ДР":"01.01.1990","Пол":"F",\n                 "email":"a@example.by","telephone":"+375291234567",\n                 "document":"MP1234567","date":"20.08.2026",\n                 "cross-border":true,"urine":true,"UG":false,\n                 "Адрес регистрации":"г. Минск, ул. Ленина 1","text1":"доп. текст"},\n       "checkboxes":[{"key":"consent","checked":true},\n                     {"label":"Согласен на рассылку","checked":false,"required":false}],\n       "groups":[{"key":"transfer","selected":"deny"}]}\' \\\n  {BASE}/api/ext/show-document'
    },
    {
      method: "POST", path: "/api/ext/scan-request",
      desc: "Запросить сканирование ШК/QR и ДОЖДАТЬСЯ результата: на планшете открывается камера, клиент показывает код, код возвращается в ответе и сохраняется. Поддерживаются QR, EAN-13, EAN-8, Code-128. Цель: deviceId или workstationExternalId. timeoutSec - сколько ждать (по умолчанию 60, максимум 300). Ответ: { ok, code, format, scanId, createdUtc }. Если код не показали за отведённое время - 408 и камера на планшете закрывается. Если планшет не на связи - сразу 409 с объяснением, а не ожидание до таймаута: команда сканирования живёт только в момент отправки и до выключенного планшета не дойдёт.",
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

  function connectHub() {
    stopHub();
    var conn = new signalR.HubConnectionBuilder()
      .withUrl("/hub/kiosk")
      .withAutomaticReconnect([0, 2000, 5000, 10000, 15000, 30000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();
    hub = conn;
    function reconnectLater() { if (hub === conn) { hubRetry = setTimeout(connectHub, 4000); } }
    conn.on("SignatureReceived", function () { toast("Получена новая подпись"); loadSignatures(); });
    conn.on("ScanReceived", function (s) {
      toast("Считан код: " + ((s && s.code) || ""));
      if (!document.querySelector('[data-panel="scan"]').classList.contains("hidden")) loadScans();
    });
    conn.on("DevicesChanged", function () { loadDevices(); });
    conn.on("AlertsChanged", function () { loadAlerts(); });
    function reg() { conn.invoke("RegisterAdmin").catch(function () {}); }
    conn.onreconnected(function () { reg(); loadDevices(); loadAlerts(); });
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
