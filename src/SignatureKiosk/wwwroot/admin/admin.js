/* Admin panel: slides, signing document, signatures, and fleet management -
   devices (enrollment codes, revoke, identify), groups, workstations, API keys. */
(function () {
  "use strict";

  var state = {
    slidesTarget: "all",   // recipient for advertising slides (all / group / device)
    docTarget: "",         // recipient for the document: exactly ONE device, or "" if none yet
    images: [], playlist: [], interval: 6,
    doc: null,
    devices: [], groups: [], workstations: [], apikeys: []
  };

  // Client-side filter for the devices list.
  var devFilter = { q: "", status: "", groupId: "", wsId: "" };

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // ---------------- API ----------------
  function api(path, opts) {
    opts = opts || {}; opts.credentials = "same-origin";
    return fetch("/api/admin" + path, opts).then(function (r) {
      if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
      return r;
    });
  }
  function apiJson(path, opts) { return api(path, opts).then(function (r) { return r.json(); }); }
  function apiSend(path, method, body) {
    return api(path, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  // ---------------- Auth ----------------
  function showLogin() { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); }
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
  $("logout").addEventListener("click", function () { api("/logout", { method: "POST" }).finally(showLogin); });

  // ---------------- Tabs ----------------
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      var name = tab.getAttribute("data-tab");
      document.querySelectorAll(".panel").forEach(function (p) { p.classList.toggle("hidden", p.getAttribute("data-panel") !== name); });
      if (name === "signatures") loadSignatures();
      if (name === "devices") loadDevices();
      if (name === "groups") loadGroups();
      if (name === "workstations") loadWorkstations();
      if (name === "apikeys") loadKeys();
      if (name === "apidocs") renderApiDocs();
    });
  });

  // ---------------- Modal ----------------
  function openModal(node) { var c = $("modalContent"); c.innerHTML = ""; c.appendChild(node); $("modal").classList.remove("hidden"); }
  function closeModal() { $("modal").classList.add("hidden"); }
  $("modalClose").addEventListener("click", closeModal);
  $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) closeModal(); });

  // ---------------- Target selectors (independent: slides vs document) ----------------
  $("slidesTarget").addEventListener("change", function () { state.slidesTarget = this.value; loadPlaylist(); });
  $("docTarget").addEventListener("change", function () { state.docTarget = this.value; });

  function targetExists(t) {
    return t === "all"
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
    sel.value = targetExists(current) ? current : "all";
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
    state.docTarget = fillDeviceSelect($("docTarget"), state.docTarget);
  }

  // ---------------- Images / slides ----------------
  function loadImages() { return apiJson("/images").then(function (imgs) { state.images = imgs; }); }
  function loadPlaylist() {
    return apiJson("/playlist?target=" + encodeURIComponent(state.slidesTarget)).then(function (p) {
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
    api("/images", { method: "POST", body: fd }).then(loadImages).then(renderImages)
      .then(function () { input.value = ""; toast("Картинки загружены"); });
  });
  $("saveSlides").addEventListener("click", function () {
    var interval = parseInt($("intervalInput").value, 10) || 6;
    apiSend("/playlist", "PUT", { target: state.slidesTarget, imageIds: state.playlist, intervalSec: interval })
      .then(function () { toast("Сохранено и отправлено (" + targetLabel(state.slidesTarget) + ")"); });
  });

  function targetLabel(t) {
    if (t === "all") return "все планшеты";
    if (t.indexOf("group:") === 0) { var g = state.groups.find(function (x) { return "group:" + x.id === t; }); return "группа " + (g ? g.name : ""); }
    var d = state.devices.find(function (x) { return "device:" + x.id === t; }); return d ? d.name : "планшет";
  }

  // ---------------- Document editor ----------------
  function loadDoc() { return apiJson("/document").then(function (d) { state.doc = d; renderDoc(); }); }
  function renderDoc() {
    $("docTitle").value = state.doc.title || ""; $("signPrompt").value = state.doc.signPrompt || ""; $("thankYou").value = state.doc.thankYouText || "";
    $("idleReturn").value = state.doc.idleReturnSec != null ? state.doc.idleReturnSec : 180;
    renderPages();
    updatePlaceholders();
  }

  function scanPlaceholders() {
    var texts = [$("docTitle").value, $("signPrompt").value, $("thankYou").value];
    document.querySelectorAll('#pagesEditor [data-role="heading"], #pagesEditor [data-role="body"], #pagesEditor [data-role="cblabel"]')
      .forEach(function (i) { texts.push(i.value); });
    var re = /\{\{\s*(.+?)\s*\}\}/g, seen = [], known = {};
    texts.forEach(function (t) {
      if (!t) return; var m;
      while ((m = re.exec(t))) { var k = m[1].trim(), lk = k.toLowerCase(); if (k && !known[lk]) { known[lk] = 1; seen.push(k); } }
    });
    return seen;
  }
  function updatePlaceholders() {
    var wrap = $("docPlaceholders"); if (!wrap) return; wrap.innerHTML = "";
    var ph = scanPlaceholders();
    if (!ph.length) { wrap.appendChild(el("span", "ph-empty", "Плейсхолдеры не используются.")); return; }
    wrap.appendChild(el("span", "ph-label", "Поля для передачи по API:"));
    ph.forEach(function (k) { wrap.appendChild(el("code", "ph-tag", "{{" + k + "}}")); });
  }
  function renderPages() {
    var wrap = $("pagesEditor"); wrap.innerHTML = "";
    (state.doc.pages || []).forEach(function (page, pi) {
      var card = el("div", "page-card");
      var title = el("div", "page-title");
      title.appendChild(el("strong", null, "Страница " + (pi + 1)));
      var delPage = el("button", "btn btn-danger", "Удалить страницу");
      delPage.addEventListener("click", function () { collectDoc(); state.doc.pages.splice(pi, 1); renderPages(); updatePlaceholders(); });
      title.appendChild(delPage); card.appendChild(title);
      card.appendChild(fieldInput("Заголовок", page.heading || "", "heading"));
      var body = el("label", "field"); body.textContent = "Текст";
      var ta = el("textarea"); ta.rows = 4; ta.value = page.body || ""; ta.setAttribute("data-role", "body"); body.appendChild(ta); card.appendChild(body);
      card.appendChild(el("div", "field", "Чекбоксы"));
      var cbList = el("div", "cb-list"); cbList.setAttribute("data-role", "cblist");
      (page.checkboxes || []).forEach(function (cb) { cbList.appendChild(checkboxRow(cb)); }); card.appendChild(cbList);
      var addCb = el("button", "btn btn-ghost", "+ Чекбокс");
      addCb.addEventListener("click", function () { cbList.appendChild(checkboxRow({ label: "", required: true })); });
      card.appendChild(addCb);

      var dyn = el("label", "check-inline dyn-anchor");
      var dynCb = el("input"); dynCb.type = "checkbox"; dynCb.checked = !!page.includeDynamic; dynCb.setAttribute("data-role", "includedynamic");
      dyn.appendChild(dynCb); dyn.appendChild(document.createTextNode(" Показывать здесь чекбоксы, присланные по API"));
      card.appendChild(dyn);

      wrap.appendChild(card);
    });
  }
  function fieldInput(labelText, value, role) {
    var label = el("label", "field", labelText); var input = el("input"); input.type = "text"; input.value = value; input.setAttribute("data-role", role); label.appendChild(input); return label;
  }
  function checkboxRow(cb) {
    var row = el("div", "cb-row"); row.setAttribute("data-role", "cbrow");
    var label = el("input"); label.type = "text"; label.placeholder = "Текст пункта"; label.value = cb.label || ""; label.setAttribute("data-role", "cblabel"); row.appendChild(label);
    var reqLabel = el("label"); var req = el("input"); req.type = "checkbox"; req.checked = cb.required !== false; req.setAttribute("data-role", "cbreq");
    reqLabel.appendChild(req); reqLabel.appendChild(document.createTextNode(" обязательный")); row.appendChild(reqLabel);
    var chkLabel = el("label"); var chk = el("input"); chk.type = "checkbox"; chk.checked = !!cb.checked; chk.setAttribute("data-role", "cbchecked");
    chkLabel.appendChild(chk); chkLabel.appendChild(document.createTextNode(" отмечен")); row.appendChild(chkLabel);
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { row.remove(); updatePlaceholders(); }); row.appendChild(del);
    return row;
  }
  function collectDoc() {
    state.doc.title = $("docTitle").value; state.doc.signPrompt = $("signPrompt").value; state.doc.thankYouText = $("thankYou").value;
    state.doc.idleReturnSec = parseInt($("idleReturn").value, 10) || 0;
    var pages = [];
    document.querySelectorAll("#pagesEditor .page-card").forEach(function (card) {
      var heading = card.querySelector('[data-role="heading"]').value;
      var body = card.querySelector('[data-role="body"]').value;
      var includeDynamic = !!(card.querySelector('[data-role="includedynamic"]') || {}).checked;
      var checkboxes = [];
      card.querySelectorAll('[data-role="cbrow"]').forEach(function (r) {
        var lab = r.querySelector('[data-role="cblabel"]').value;
        var req = r.querySelector('[data-role="cbreq"]').checked;
        var chk = !!(r.querySelector('[data-role="cbchecked"]') || {}).checked;
        if (lab.trim()) checkboxes.push({ label: lab, required: req, checked: chk });
      });
      pages.push({ heading: heading, body: body, checkboxes: checkboxes, includeDynamic: includeDynamic });
    });
    state.doc.pages = pages;
  }
  $("addPage").addEventListener("click", function () { collectDoc(); state.doc.pages.push({ heading: "Новая страница", body: "", checkboxes: [], includeDynamic: false }); renderPages(); });
  $("saveDocument").addEventListener("click", function () { collectDoc(); apiSend("/document", "PUT", state.doc).then(function () { toast("Документ сохранён"); }); });

  function doShowDocument(fields) {
    apiSend("/show-document", "POST", { target: state.docTarget, fields: fields })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        toast("Документ показан (" + targetLabel(state.docTarget) + ")");
        if (j && j.missingPlaceholders && j.missingPlaceholders.length)
          setTimeout(function () { toast("Не заполнены: " + j.missingPlaceholders.join(", ")); }, 1500);
      });
  }
  function openFieldsModal(placeholders) {
    var c = el("div");
    c.appendChild(el("h3", null, "Данные для документа"));
    c.appendChild(el("p", "sig-meta", "Значения подставятся в плейсхолдеры и отправятся на: " + targetLabel(state.docTarget)));
    var inputs = {};
    placeholders.forEach(function (k) { var f = labeledInput(k, ""); c.appendChild(f.wrap); inputs[k] = f.input; });
    var btn = el("button", "btn btn-primary", "Показать документ");
    btn.addEventListener("click", function () {
      var fields = {}; placeholders.forEach(function (k) { fields[k] = inputs[k].value; });
      closeModal(); doShowDocument(fields);
    });
    c.appendChild(btn);
    openModal(c);
    if (inputs[placeholders[0]]) inputs[placeholders[0]].focus();
  }
  $("showDocument").addEventListener("click", function () {
    if (!/^device:/.test(state.docTarget)) { toast("Выберите планшет. Документ показывается только на один планшет."); return; }
    collectDoc();
    var placeholders = scanPlaceholders();
    apiSend("/document", "PUT", state.doc).then(function () {
      if (placeholders.length) openFieldsModal(placeholders);
      else doShowDocument(null);
    });
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
    apiJson("/signatures").then(function (list) {
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
      dl.className = "btn btn-ghost"; dl.textContent = "Скачать PDF";
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
        var wsParts = [];
        if (ws.name) wsParts.push(ws.name);
        if (ws.externalId) wsParts.push("ID: " + ws.externalId);
        if (ws.location) wsParts.push("Описание: " + ws.location);
        info.appendChild(el("div", "dev-meta", "Рабочее место: " + (wsParts.length ? wsParts.join("   ·   ") : "-")));
      } else {
        info.appendChild(el("div", "dev-meta", "Рабочее место: не привязано"));
      }

      // Group(s) the tablet belongs to.
      var groupsText = (d.groups && d.groups.length) ? d.groups.join(", ") : "без группы";
      info.appendChild(el("div", "dev-meta", "Группа: " + groupsText));

      info.appendChild(el("div", "dev-meta", d.online
        ? "Связь: на связи сейчас"
        : "Последняя связь: " + (d.lastSeenUtc ? new Date(d.lastSeenUtc).toLocaleString("ru-RU") : "-")));
      info.appendChild(el("div", "dev-meta", (d.online ? "Текущий IP: " : "Последний IP: ") + (d.lastIp || "-")));
      item.appendChild(info);

      var actions = el("div", "dev-actions");
      var bId = el("button", "btn btn-ghost btn-sm", "Опознать");
      bId.title = "Показать номер на экране планшета";
      bId.addEventListener("click", function () {
        apiSend("/devices/" + d.id + "/identify", "POST", {}).then(function (r) { return r.json(); })
          .then(function (j) { toast("На планшете «" + d.name + "» показан номер " + j.code); });
      });
      actions.appendChild(bId);
      var bEdit = el("button", "btn btn-ghost btn-sm", "Изменить"); bEdit.addEventListener("click", function () { editDevice(d); }); actions.appendChild(bEdit);
      if (d.status === "revoked") {
        var bUn = el("button", "btn btn-ghost btn-sm", "Разблокировать");
        bUn.addEventListener("click", function () { apiSend("/devices/" + d.id + "/unrevoke", "POST", {}).then(loadDevices).then(function () { toast("Разблокирован"); }); });
        actions.appendChild(bUn);
      } else {
        var bRev = el("button", "btn btn-danger btn-sm", "Заблокировать");
        bRev.addEventListener("click", function () { if (confirm("Заблокировать планшет «" + d.name + "»? Он потеряет доступ.")) apiSend("/devices/" + d.id + "/revoke", "POST", {}).then(loadDevices).then(function () { toast("Заблокирован"); }); });
        actions.appendChild(bRev);
      }
      var bDel = el("button", "btn btn-danger btn-sm", "Удалить");
      bDel.addEventListener("click", function () { if (confirm("Удалить планшет «" + d.name + "» полностью?")) api("/devices/" + d.id, { method: "DELETE" }).then(loadDevices).then(function () { toast("Удалён"); }); });
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
    var wsSel = labeledSelect("Рабочее место", [{ v: "", t: "- не привязывать -" }].concat(state.workstations.map(function (w) { return { v: w.id, t: w.name + (w.externalId ? " (" + w.externalId + ")" : "") }; })));
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
    var btn = el("button", "btn btn-primary", "Сгенерировать код");
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
    var wsSel = labeledSelect("Рабочее место", [{ v: "", t: "- не привязывать -" }].concat(state.workstations.map(function (w) { return { v: w.id, t: w.name + (w.externalId ? " (" + w.externalId + ")" : "") }; })));
    wsSel.select.value = d.workstationId || ""; form.appendChild(wsSel.wrap);
    var groupsBox = el("div", "field"); groupsBox.appendChild(document.createTextNode("Группы (применятся при след. подключении)"));
    var gWrap = el("div", "check-group");
    state.groups.forEach(function (g) {
      var l = el("label", "check-inline"); var cb = el("input"); cb.type = "checkbox"; cb.value = g.id; cb.checked = (d.groupIds || []).indexOf(g.id) >= 0; l.appendChild(cb); l.appendChild(document.createTextNode(" " + g.name)); gWrap.appendChild(l);
    });
    if (!state.groups.length) gWrap.appendChild(el("span", "sig-meta", "нет групп"));
    groupsBox.appendChild(gWrap); form.appendChild(groupsBox);
    var save = el("button", "btn btn-primary", "Сохранить");
    save.addEventListener("click", function () {
      var groupIds = Array.prototype.slice.call(gWrap.querySelectorAll("input:checked")).map(function (c) { return c.value; });
      apiSend("/devices/" + d.id, "PUT", { name: name.input.value, workstationId: wsSel.select.value || "", groupIds: groupIds })
        .then(function () { closeModal(); return loadDevices(); }).then(function () { toast("Сохранено"); });
    });
    form.appendChild(save);
    openModal(form);
  }

  // ---------------- Groups ----------------
  function loadGroups() { return apiJson("/groups").then(function (list) { state.groups = list; renderGroups(); renderTargetOptions(); populateDeviceFilters(); }); }
  function renderGroups() {
    var wrap = $("groupsList"); wrap.innerHTML = "";
    if (!state.groups.length) { wrap.innerHTML = '<div class="empty-note">Групп пока нет.</div>'; return; }
    state.groups.forEach(function (g) {
      var row = el("div", "simple-row");
      var inp = el("input"); inp.value = g.name; inp.className = "grow"; row.appendChild(inp);
      var save = el("button", "btn btn-ghost btn-sm", "Переименовать");
      save.addEventListener("click", function () { apiSend("/groups/" + g.id, "PUT", { name: inp.value }).then(loadGroups).then(function () { toast("Сохранено"); }); });
      row.appendChild(save);
      var del = el("button", "btn btn-danger btn-sm", "Удалить");
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
      var save = el("button", "btn btn-ghost btn-sm", "Сохранить");
      save.addEventListener("click", function () { apiSend("/workstations/" + w.id, "PUT", { externalId: ext.value, name: name.value, location: loc.value }).then(loadWorkstations).then(function () { toast("Сохранено"); }); });
      row.appendChild(save);
      var del = el("button", "btn btn-danger btn-sm", "Удалить");
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
      var del = el("button", "btn btn-danger btn-sm", "Удалить");
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
      desc: "Показать документ на планшете с данными подписанта. Плейсхолдеры {{ФИО}} и т.п. в шаблоне (текст задаётся в админке) заполняются из fields. Массив checkboxes добавляет пункты согласия: checked - начальное состояние, required - обязателен. Цель: deviceId или workstationExternalId. В ответе missingPlaceholders - какие поля не переданы.",
      sample: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"WS-204",\n       "fields":{"ФИО":"Иванов Иван","ДР":"01.01.1990","Адрес регистрации":"г. Минск, ул. Ленина 1"},\n       "checkboxes":[{"label":"Согласен на рассылку","checked":false,"required":false}]}\' \\\n  {BASE}/api/ext/show-document'
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
    API_ENDPOINTS.forEach(function (ep) {
      var card = el("div", "api-ep");
      var head = el("div", "api-ep-head");
      var m = ep.method.toLowerCase();
      head.appendChild(el("span", "api-method api-" + m, ep.method));
      head.appendChild(el("span", "api-path", ep.path));
      var copy = el("button", "btn btn-ghost btn-sm api-copy", "Копировать");
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
  function connectHub() {
    var conn = new signalR.HubConnectionBuilder()
      .withUrl("/hub/kiosk")
      .withAutomaticReconnect([0, 2000, 5000, 10000, 15000, 30000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();
    conn.on("SignatureReceived", function () { toast("Получена новая подпись"); loadSignatures(); });
    conn.on("DevicesChanged", function () { loadDevices(); });
    function reg() { conn.invoke("RegisterAdmin").catch(function () {}); }
    conn.onreconnected(function () { reg(); loadDevices(); });
    conn.onclose(function () { setTimeout(connectHub, 4000); });
    conn.start().then(reg).catch(function () { setTimeout(connectHub, 4000); });
  }

  // ---------------- Init ----------------
  function init() {
    Promise.all([loadGroups(), loadWorkstations(), loadImages(), loadDoc(), loadDevices()])
      .then(function () { renderTargetOptions(); return loadPlaylist(); })
      .then(function () { loadSignatures(); connectHub(); })
      .catch(function (e) { console.error(e); });
  }

  checkAuth();
})();
