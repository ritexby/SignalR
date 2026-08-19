/* Admin panel: manage images/playlist, the signing document, view signatures,
   and target a specific tablet or all tablets. */
(function () {
  "use strict";

  var state = {
    target: "all",
    images: [],
    playlist: [],   // ordered image ids selected for the current target
    interval: 6,
    doc: null,
    devices: []
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------------- API helper ----------------
  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    return fetch("/api/admin" + path, opts).then(function (r) {
      if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
      return r;
    });
  }
  function apiJson(path, opts) { return api(path, opts).then(function (r) { return r.json(); }); }

  // ---------------- Auth ----------------
  function showLogin() { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); }
  function showApp() { $("login").classList.add("hidden"); $("app").classList.remove("hidden"); }

  function checkAuth() {
    fetch("/api/admin/me", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.authenticated) { showApp(); init(); } else { showLogin(); } })
      .catch(showLogin);
  }

  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    $("loginError").textContent = "";
    fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password: $("password").value })
    }).then(function (r) {
      if (r.ok) { $("password").value = ""; showApp(); init(); }
      else { $("loginError").textContent = "Неверный пароль"; }
    }).catch(function () { $("loginError").textContent = "Ошибка соединения"; });
  });

  $("logout").addEventListener("click", function () {
    api("/logout", { method: "POST" }).finally(showLogin);
  });

  // ---------------- Tabs ----------------
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      var name = tab.getAttribute("data-tab");
      document.querySelectorAll(".panel").forEach(function (p) {
        p.classList.toggle("hidden", p.getAttribute("data-panel") !== name);
      });
      if (name === "signatures") loadSignatures();
      if (name === "devices") loadDevices();
    });
  });

  // ---------------- Target selector ----------------
  $("targetSelect").addEventListener("change", function () {
    state.target = $("targetSelect").value;
    loadPlaylist();
  });

  function renderTargetOptions() {
    var sel = $("targetSelect");
    var current = state.target;
    sel.innerHTML = "";
    var optAll = document.createElement("option");
    optAll.value = "all"; optAll.textContent = "Все планшеты";
    sel.appendChild(optAll);
    state.devices.forEach(function (d) {
      var o = document.createElement("option");
      o.value = d.id;
      o.textContent = (d.online ? "🟢 " : "⚪ ") + d.name;
      sel.appendChild(o);
    });
    // keep selection if it still exists
    var exists = current === "all" || state.devices.some(function (d) { return d.id === current; });
    sel.value = exists ? current : "all";
    state.target = sel.value;
  }

  // ---------------- Images / slides ----------------
  function loadImages() {
    return apiJson("/images").then(function (imgs) { state.images = imgs; });
  }

  function loadPlaylist() {
    return apiJson("/playlist?target=" + encodeURIComponent(state.target)).then(function (p) {
      state.playlist = p.imageIds || [];
      state.interval = p.intervalSec || 6;
      $("intervalInput").value = state.interval;
      renderImages();
    });
  }

  function renderImages() {
    var grid = $("imageGrid");
    grid.innerHTML = "";
    if (!state.images.length) {
      grid.innerHTML = '<div class="empty-note">Пока нет загруженных картинок. Нажмите «Загрузить картинки».</div>';
      return;
    }
    state.images.forEach(function (img) {
      var pos = state.playlist.indexOf(img.id);
      var card = document.createElement("div");
      card.className = "card" + (pos >= 0 ? " selected" : "");

      var order = document.createElement("div");
      order.className = "order";
      order.textContent = pos >= 0 ? (pos + 1) : "";
      card.appendChild(order);

      var del = document.createElement("button");
      del.className = "del"; del.textContent = "×"; del.title = "Удалить";
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!confirm("Удалить эту картинку?")) return;
        api("/images/" + img.id, { method: "DELETE" }).then(function () {
          var i = state.playlist.indexOf(img.id);
          if (i >= 0) state.playlist.splice(i, 1);
          return loadImages();
        }).then(renderImages);
      });
      card.appendChild(del);

      var im = document.createElement("img");
      im.src = img.url; im.alt = img.originalName || "";
      card.appendChild(im);

      var name = document.createElement("div");
      name.className = "name"; name.textContent = img.originalName || img.id;
      card.appendChild(name);

      card.addEventListener("click", function () {
        var i = state.playlist.indexOf(img.id);
        if (i >= 0) state.playlist.splice(i, 1);
        else state.playlist.push(img.id);
        renderImages();
      });

      grid.appendChild(card);
    });
  }

  $("imageUpload").addEventListener("change", function () {
    var input = $("imageUpload");
    if (!input.files.length) return;
    var fd = new FormData();
    Array.prototype.forEach.call(input.files, function (f) { fd.append("files", f); });
    api("/images", { method: "POST", body: fd })
      .then(loadImages).then(renderImages)
      .then(function () { input.value = ""; toast("Картинки загружены"); });
  });

  $("saveSlides").addEventListener("click", function () {
    var interval = parseInt($("intervalInput").value, 10) || 6;
    api("/playlist", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: state.target, imageIds: state.playlist, intervalSec: interval })
    }).then(function () { toast("Сохранено и отправлено на планшет"); });
  });

  // ---------------- Document editor ----------------
  function loadDoc() {
    return apiJson("/document").then(function (d) { state.doc = d; renderDoc(); });
  }

  function renderDoc() {
    var d = state.doc;
    $("docTitle").value = d.title || "";
    $("signPrompt").value = d.signPrompt || "";
    $("thankYou").value = d.thankYouText || "";
    renderPages();
  }

  function renderPages() {
    var wrap = $("pagesEditor");
    wrap.innerHTML = "";
    (state.doc.pages || []).forEach(function (page, pi) {
      var card = document.createElement("div");
      card.className = "page-card";

      var title = document.createElement("div");
      title.className = "page-title";
      var strong = document.createElement("strong");
      strong.textContent = "Страница " + (pi + 1);
      title.appendChild(strong);
      var delPage = document.createElement("button");
      delPage.className = "btn btn-danger"; delPage.textContent = "Удалить страницу";
      delPage.addEventListener("click", function () {
        collectDoc();
        state.doc.pages.splice(pi, 1);
        renderPages();
      });
      title.appendChild(delPage);
      card.appendChild(title);

      var head = fieldInput("Заголовок", page.heading || "", "heading");
      card.appendChild(head);

      var body = document.createElement("label");
      body.className = "field";
      body.textContent = "Текст";
      var ta = document.createElement("textarea");
      ta.rows = 4; ta.value = page.body || ""; ta.setAttribute("data-role", "body");
      body.appendChild(ta);
      card.appendChild(body);

      var cbTitle = document.createElement("div");
      cbTitle.className = "field"; cbTitle.textContent = "Чекбоксы";
      card.appendChild(cbTitle);

      var cbList = document.createElement("div");
      cbList.className = "cb-list"; cbList.setAttribute("data-role", "cblist");
      (page.checkboxes || []).forEach(function (cb) { cbList.appendChild(checkboxRow(cb)); });
      card.appendChild(cbList);

      var addCb = document.createElement("button");
      addCb.className = "btn btn-ghost"; addCb.textContent = "+ Чекбокс";
      addCb.addEventListener("click", function () {
        cbList.appendChild(checkboxRow({ label: "", required: true }));
      });
      card.appendChild(addCb);

      wrap.appendChild(card);
    });
  }

  function fieldInput(labelText, value, role) {
    var label = document.createElement("label");
    label.className = "field"; label.textContent = labelText;
    var input = document.createElement("input");
    input.type = "text"; input.value = value; input.setAttribute("data-role", role);
    label.appendChild(input);
    return label;
  }

  function checkboxRow(cb) {
    var row = document.createElement("div");
    row.className = "cb-row"; row.setAttribute("data-role", "cbrow");
    var label = document.createElement("input");
    label.type = "text"; label.placeholder = "Текст пункта"; label.value = cb.label || "";
    label.setAttribute("data-role", "cblabel");
    row.appendChild(label);
    var reqLabel = document.createElement("label");
    var req = document.createElement("input");
    req.type = "checkbox"; req.checked = cb.required !== false; req.setAttribute("data-role", "cbreq");
    reqLabel.appendChild(req);
    reqLabel.appendChild(document.createTextNode(" обязательный"));
    row.appendChild(reqLabel);
    var del = document.createElement("button");
    del.className = "btn btn-danger"; del.textContent = "×";
    del.addEventListener("click", function () { row.remove(); });
    row.appendChild(del);
    return row;
  }

  function collectDoc() {
    state.doc.title = $("docTitle").value;
    state.doc.signPrompt = $("signPrompt").value;
    state.doc.thankYouText = $("thankYou").value;
    var pages = [];
    document.querySelectorAll("#pagesEditor .page-card").forEach(function (card) {
      var heading = card.querySelector('[data-role="heading"]').value;
      var body = card.querySelector('[data-role="body"]').value;
      var checkboxes = [];
      card.querySelectorAll('[data-role="cbrow"]').forEach(function (row) {
        var label = row.querySelector('[data-role="cblabel"]').value;
        var required = row.querySelector('[data-role="cbreq"]').checked;
        if (label.trim()) checkboxes.push({ label: label, required: required });
      });
      pages.push({ heading: heading, body: body, checkboxes: checkboxes });
    });
    state.doc.pages = pages;
  }

  $("addPage").addEventListener("click", function () {
    collectDoc();
    state.doc.pages.push({ heading: "Новая страница", body: "", checkboxes: [] });
    renderPages();
  });

  $("saveDocument").addEventListener("click", function () {
    collectDoc();
    api("/document", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.doc)
    }).then(function () { toast("Документ сохранён"); });
  });

  $("showDocument").addEventListener("click", function () {
    collectDoc();
    api("/document", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.doc)
    }).then(function () {
      return api("/show-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: state.target })
      });
    }).then(function () { toast("Документ показан на планшете"); });
  });

  $("showSlides").addEventListener("click", function () {
    api("/show-slides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: state.target })
    }).then(function () { toast("Реклама возвращена"); });
  });

  // ---------------- Signatures ----------------
  function loadSignatures() {
    apiJson("/signatures").then(function (list) {
      var wrap = $("signaturesList");
      wrap.innerHTML = "";
      if (!list.length) { wrap.innerHTML = '<div class="empty-note">Пока нет подписей.</div>'; return; }
      list.forEach(function (s) {
        var item = document.createElement("div");
        item.className = "sig-item";
        var when = document.createElement("div"); when.className = "when";
        when.textContent = new Date(s.createdUtc).toLocaleString("ru-RU");
        var meta = document.createElement("div"); meta.className = "meta";
        meta.textContent = (s.deviceName || s.deviceId || "—") + " · " + (s.documentTitle || "");
        var col = document.createElement("div");
        col.appendChild(when); col.appendChild(meta);
        item.appendChild(col);
        var badge = document.createElement("div"); badge.className = "badge";
        badge.textContent = "отмечено " + s.checkedCount + " из " + s.totalCount;
        item.appendChild(badge);
        item.addEventListener("click", function () { openSignature(s.id); });
        wrap.appendChild(item);
      });
    });
  }

  function openSignature(id) {
    apiJson("/signatures/" + id).then(function (rec) {
      var c = $("modalContent");
      c.innerHTML = "";
      var h = document.createElement("h3"); h.textContent = rec.documentTitle || "Подпись"; c.appendChild(h);
      var meta = document.createElement("div"); meta.className = "sig-meta";
      meta.textContent = new Date(rec.createdUtc).toLocaleString("ru-RU") +
        " · " + (rec.deviceName || rec.deviceId || "—");
      c.appendChild(meta);

      var list = document.createElement("div"); list.className = "item-list";
      (rec.items || []).forEach(function (it) {
        var row = document.createElement("div");
        row.className = "item " + (it.checked ? "on" : "off");
        var tick = document.createElement("span"); tick.className = "tick";
        tick.textContent = it.checked ? "✓" : "✕";
        row.appendChild(tick);
        var label = document.createElement("span"); label.textContent = it.label;
        row.appendChild(label);
        list.appendChild(row);
      });
      if (!(rec.items || []).length) {
        var none = document.createElement("div"); none.className = "empty-note"; none.textContent = "Без чекбоксов";
        list.appendChild(none);
      }
      c.appendChild(list);

      var img = document.createElement("img");
      img.className = "sig-image";
      img.src = "/api/admin/signatures/" + id + "/image";
      img.alt = "Подпись";
      c.appendChild(img);

      $("modal").classList.remove("hidden");
    });
  }

  $("modalClose").addEventListener("click", function () { $("modal").classList.add("hidden"); });
  $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) $("modal").classList.add("hidden"); });
  $("reloadSignatures").addEventListener("click", loadSignatures);

  // ---------------- Devices ----------------
  function loadDevices() {
    return apiJson("/devices").then(function (list) {
      state.devices = list;
      renderTargetOptions();
      renderDevices();
    });
  }

  function renderDevices() {
    var wrap = $("devicesList");
    wrap.innerHTML = "";
    if (!state.devices.length) {
      wrap.innerHTML = '<div class="empty-note">Планшеты ещё не подключались.</div>';
      return;
    }
    state.devices.forEach(function (d) {
      var item = document.createElement("div");
      item.className = "dev-item";
      var dot = document.createElement("div"); dot.className = "dot" + (d.online ? " online" : "");
      item.appendChild(dot);
      var input = document.createElement("input");
      input.className = "grow"; input.value = d.name;
      item.appendChild(input);
      var idSpan = document.createElement("span"); idSpan.className = "id"; idSpan.textContent = d.id;
      item.appendChild(idSpan);
      var save = document.createElement("button");
      save.className = "btn btn-ghost"; save.textContent = "Переименовать";
      save.addEventListener("click", function () {
        api("/devices/" + d.id, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: input.value })
        }).then(loadDevices).then(function () { toast("Сохранено"); });
      });
      item.appendChild(save);
      wrap.appendChild(item);
    });
  }

  $("reloadDevices").addEventListener("click", loadDevices);

  // ---------------- Toast ----------------
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#111827;color:#fff;padding:12px 20px;border-radius:10px;font-size:.95rem;z-index:100;box-shadow:0 6px 20px rgba(0,0,0,.2);transition:opacity .2s;";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = "0"; }, 2200);
  }

  // ---------------- Realtime (admin) ----------------
  function connectHub() {
    var conn = new signalR.HubConnectionBuilder()
      .withUrl("/hub/kiosk")
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Warning)
      .build();
    conn.on("SignatureReceived", function () {
      toast("Получена новая подпись");
      loadSignatures();
    });
    conn.on("DevicesChanged", function () { loadDevices(); });
    function reg() { conn.invoke("RegisterAdmin").catch(function () {}); }
    conn.onreconnected(reg);
    conn.start().then(reg).catch(function () { setTimeout(connectHub, 4000); });
  }

  // ---------------- Init ----------------
  function init() {
    Promise.all([loadDevices(), loadImages(), loadDoc()])
      .then(function () { return loadPlaylist(); })
      .then(function () { loadSignatures(); connectHub(); })
      .catch(function (e) { console.error(e); });
  }

  checkAuth();
})();
