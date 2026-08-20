/* Admin panel: slides, signing document, signatures, and fleet management -
   devices (enrollment codes, revoke, identify), groups, workstations, API keys. */
(function () {
  "use strict";

  // Kept in step with the version badge and with APP_VERSION in kiosk.js. A tablet reports the
  // build of the page it is running, so a WebView still on an older page can be spotted rather
  // than silently ignoring anything added since.
  var APP_VERSION = "4.7";

  var state = {
    slidesTarget: "all",   // recipient for advertising slides (all / group / device)
    docTarget: "",         // recipient for the document: exactly ONE device, or "" if none yet
    scanTarget: "",        // tablet used for barcode / QR scanning
    images: [], playlist: [], interval: 6,
    doc: null,
    devices: [], groups: [], workstations: [], apikeys: [], scans: [], logs: [], alerts: []
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
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      var name = tab.getAttribute("data-tab");
      document.querySelectorAll(".panel").forEach(function (p) { p.classList.toggle("hidden", p.getAttribute("data-panel") !== name); });
      if (name === "signatures") loadSignatures();
      if (name === "devices") { loadDevices(); loadKioskControl(); }
      if (name === "groups") loadGroups();
      if (name === "workstations") loadWorkstations();
      if (name === "apikeys") loadKeys();
      if (name === "apidocs") renderApiDocs();
      if (name === "scan") loadScans();
      if (name === "logs") loadLogs();
      if (name === "alerts") { loadAlerts().then(renderAlerts); loadAlertSettings(); }
      // The log tab polls while it is open; stop polling when the operator leaves it.
      if (name !== "logs") stopLogPolling();
    });
  });

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
    // Keep the scan target fresh too: it used to be refilled only when the scan tab was loaded, so
    // a deleted tablet stayed selectable and "start scanning" silently did nothing.
    if ($("scanTarget")) state.scanTarget = fillDeviceSelect($("scanTarget"), state.scanTarget);
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
    // Reset the file input on BOTH paths: after a failed upload the input still held the same
    // files, so re-picking them fired no change event and the button looked dead.
    api("/images", { method: "POST", body: fd }).then(loadImages).then(renderImages)
      .then(function () { toast("Картинки загружены"); })
      .catch(function () { /* reported by api() */ })
      .then(function () { input.value = ""; });
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
  var COND_OPS = [["eq", "равно"], ["ne", "не равно"], ["empty", "пусто"], ["notempty", "не пусто"], ["in", "одно из (через запятую)"]];
  // Tags that only ever carry a fixed set of values. Offering them as a list removes the guesswork
  // (was it "M" or "муж"? "да" or "yes"?) and the typo that silently makes a condition never match.
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
      s.fields.forEach(function (f) { if (f.values && f.values.length) FIELD_VALUES[f.name] = f.values; });
    }).catch(function (e) { console.error(e); });
  }
  var OTHER_OPTION = "\u0000other";   // cannot collide with a real tag or value

  function loadDoc() { return apiJson("/document").then(function (d) { state.doc = d; renderDoc(); }); }
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
  function tbBtn(label, title, fn, italicLabel) {
    var b = el("button", "rt-btn", label); b.type = "button"; b.title = title || "";
    if (italicLabel) b.style.fontStyle = "italic";
    b.addEventListener("mousedown", function (e) { e.preventDefault(); });
    b.addEventListener("click", function (e) { e.preventDefault(); fn(); });
    return b;
  }
  function richEditor(labelText, runs, role) {
    var wrap = el("div", "rt-field");
    if (labelText) wrap.appendChild(el("div", "rt-label", labelText));
    var ed = el("div", "rt-editor"); ed.contentEditable = "true"; ed.setAttribute("data-role", role); ed.innerHTML = runsToHtml(runs);
    var bar = el("div", "rt-toolbar");
    bar.appendChild(tbBtn("Ж", "Жирный", function () { if (insideEditor(ed)) { document.execCommand("bold", false, null); ed.dispatchEvent(new Event("input", { bubbles: true })); } }));
    bar.appendChild(tbBtn("К", "Курсив", function () { if (insideEditor(ed)) { document.execCommand("italic", false, null); ed.dispatchEvent(new Event("input", { bubbles: true })); } }, true));
    bar.appendChild(tbBtn("A", "Обычный размер", function () { wrapSelection(ed, function (s) { s.className = "rt-n"; }, "size"); }));
    bar.appendChild(tbBtn("A+", "Крупный", function () { wrapSelection(ed, function (s) { s.className = "rt-l"; }, "size"); }));
    bar.appendChild(tbBtn("A++", "Огромный", function () { wrapSelection(ed, function (s) { s.className = "rt-h"; }, "size"); }));
    RT_COLORS.forEach(function (c) {
      var sw = el("button", "rt-swatch"); sw.type = "button"; sw.style.background = c; sw.title = "Цвет " + c;
      sw.addEventListener("mousedown", function (e) { e.preventDefault(); });
      sw.addEventListener("click", function (e) { e.preventDefault(); wrapSelection(ed, function (s) { s.style.color = c; }, "color"); });
      bar.appendChild(sw);
    });
    bar.appendChild(tbBtn("○", "Цвет по умолчанию", function () { wrapSelection(ed, function (s) { s.style.color = "inherit"; }, "color"); }));
    var tsel = el("select", "rt-tag"); tsel.appendChild(new Option("+ тег", ""));
    KNOWN_FIELDS.forEach(function (f) { tsel.appendChild(new Option(f, f)); });
    tsel.addEventListener("change", function () { if (tsel.value) { insertTag(ed, tsel.value); tsel.value = ""; } });
    bar.appendChild(tsel);
    wrap.appendChild(bar); wrap.appendChild(ed);
    return wrap;
  }

  // ---------- condition editor (show block / page only when a field matches) ----------
  function conditionEditor(cond, role) {
    var box = el("div", "cond-box"); box.setAttribute("data-role", role);
    var mode = el("select", "cond-mode");
    mode.appendChild(new Option("Показывать всегда", "")); mode.appendChild(new Option("Показывать по условию", "cond"));
    var fields = el("div", "cond-fields");

    // The tag is a real dropdown, not a text box with suggestions: a datalist only offers what
    // still matches what is typed, so once a tag was chosen the list looked empty and the operator
    // had to clear the box by hand before choosing another one.
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
      var gg = document.createElement("optgroup"); gg.label = "Группы вариантов";
      groupNames.forEach(function (k) { gg.appendChild(new Option(k, k)); });
      fld.appendChild(gg);
    }
    fld.appendChild(new Option("другой тег...", OTHER_OPTION));
    // Kept for a tag outside the known list, so nothing that used to work stops working.
    var fldOther = el("input", "cond-field-other"); fldOther.type = "text";
    fldOther.placeholder = "свой тег"; fldOther.setAttribute("data-role", "cfield");

    var op = el("select", "cond-op"); op.setAttribute("data-role", "cop");
    COND_OPS.forEach(function (o) { op.appendChild(new Option(o[1], o[0])); });

    // The value is a dropdown when the tag has a fixed set, and a text box otherwise.
    var valSel = el("select", "cond-val-sel"); valSel.setAttribute("data-role", "cvalsel");
    var val = el("input", "cond-val"); val.type = "text"; val.placeholder = "значение"; val.setAttribute("data-role", "cval");

    fields.appendChild(fld); fields.appendChild(fldOther); fields.appendChild(op);
    fields.appendChild(valSel); fields.appendChild(val);

    function currentField() { return fld.value === OTHER_OPTION ? fldOther.value.trim() : fld.value; }

    /// Rebuild the value control for the tag in hand, keeping whatever value is already set.
    function syncValues(keep) {
      var f = currentField();
      var dk = docKeys();
      var known = FIELD_VALUES[f];
      if (dk.checks.indexOf(f) >= 0) known = ["true", "false"];
      else if (Object.prototype.hasOwnProperty.call(dk.groups, f)) known = dk.groups[f].slice();
      // "одно из" takes a comma separated list, so a single-choice dropdown would not express it.
      var listable = known && op.value !== "in";
      valSel.innerHTML = "";
      if (listable) {
        known.forEach(function (v) { valSel.appendChild(new Option(v, v)); });
        valSel.appendChild(new Option("другое...", OTHER_OPTION));
        if (keep && known.indexOf(keep) < 0) { valSel.value = OTHER_OPTION; val.value = keep; }
        else { valSel.value = keep || known[0]; val.value = ""; }
      } else if (keep != null) {
        val.value = keep;
      }
      valSel.style.display = listable ? "" : "none";
      val.style.display = (!listable || valSel.value === OTHER_OPTION) ? "" : "none";
    }

    function sync() {
      fields.style.display = mode.value === "cond" ? "" : "none";
      fldOther.style.display = fld.value === OTHER_OPTION ? "" : "none";
      var needsValue = op.value !== "empty" && op.value !== "notempty";
      valSel.style.display = needsValue && valSel.options.length ? "" : "none";
      val.style.display = needsValue && (!valSel.options.length || valSel.value === OTHER_OPTION) ? "" : "none";
    }

    mode.addEventListener("change", sync);
    fld.addEventListener("change", function () { syncValues(null); sync(); });
    fldOther.addEventListener("input", function () { syncValues(val.value); sync(); });
    op.addEventListener("change", function () { syncValues(readValue()); sync(); });
    valSel.addEventListener("change", sync);

    function readValue() { return valSel.options.length && valSel.value !== OTHER_OPTION ? valSel.value : val.value; }

    if (cond && cond.field) {
      mode.value = "cond";
      if (KNOWN_FIELDS.indexOf(cond.field) >= 0) fld.value = cond.field;
      else { fld.value = OTHER_OPTION; fldOther.value = cond.field; }
      op.value = cond.op || "eq";
      syncValues(cond.value || "");
    } else {
      syncValues(null);
    }
    sync();
    box.appendChild(mode); box.appendChild(fields);
    return box;
  }
  function readCondition(box) {
    if (!box) return null;
    var mode = box.querySelector(".cond-mode"); if (!mode || mode.value !== "cond") return null;
    var sel = box.querySelector('[data-role="cfieldsel"]');
    var other = box.querySelector('[data-role="cfield"]');
    var field = (sel && sel.value && sel.value !== OTHER_OPTION ? sel.value : (other ? other.value : "")).trim();
    if (!field) return null;
    var op = box.querySelector('[data-role="cop"]').value || "eq";
    var valSel = box.querySelector('[data-role="cvalsel"]');
    var valInput = box.querySelector('[data-role="cval"]');
    var value = (valSel && valSel.options.length && valSel.value !== OTHER_OPTION)
      ? valSel.value
      : (valInput ? valInput.value : "");
    return { field: field, op: op, value: (value || "").trim() };
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
  function updatePlaceholders() {
    var wrap = $("docPlaceholders"); if (!wrap) return; wrap.innerHTML = "";
    var ph = scanPlaceholders();
    if (!ph.length) { wrap.appendChild(el("span", "ph-empty", "Плейсхолдеры не используются.")); return; }
    wrap.appendChild(el("span", "ph-label", "Поля для передачи по API:"));
    ph.forEach(function (k) { wrap.appendChild(el("code", "ph-tag", "{{" + k + "}}")); });
  }

  function blockCard(b) {
    b = b || {};
    var bc = el("div", "block-card"); bc.setAttribute("data-role", "blockcard");
    var isImage = !!b.imageUrl;

    var modeBar = el("div", "block-mode");
    var btnText = el("button", "btn btn-ghost btn-sm", "Текст"); btnText.type = "button";
    var btnImg = el("button", "btn btn-ghost btn-sm", "Картинка"); btnImg.type = "button";
    modeBar.appendChild(btnText); modeBar.appendChild(btnImg);
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

    bc.appendChild(el("div", "field-sm", "Условие показа блока"));
    bc.appendChild(conditionEditor(b.visibleWhen, "blockcond"));
    var del = el("button", "btn btn-danger btn-sm", "Удалить блок");
    del.addEventListener("click", function () { bc.remove(); updatePlaceholders(); });
    bc.appendChild(del);
    return bc;
  }

  // Read all block cards inside a container into an array of blocks (text or image).
  function collectBlocks(container) {
    var out = [];
    if (!container) return out;
    container.querySelectorAll('[data-role="blockcard"]').forEach(function (bc) {
      var cond = readCondition(bc.querySelector('[data-role="blockcond"]'));
      if (bc.getAttribute("data-mode") === "image") {
        var url = bc.getAttribute("data-imgurl");
        if (!url) return;
        var w = parseInt((bc.querySelector('[data-role="blockimgw"]') || {}).value, 10) || 100;
        var blk = { imageUrl: url, imageWidth: w }; if (cond) blk.visibleWhen = cond; out.push(blk);
      } else {
        var ed = bc.querySelector('[data-role="blockbody"]');
        var runs = ed ? editorToRuns(ed) : [];
        var hasText = runs.some(function (r) { return (r.text || "").trim().length; });
        if (hasText || cond) { var blk2 = { runs: runs }; if (cond) blk2.visibleWhen = cond; out.push(blk2); }
      }
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
  function renderPages() {
    var wrap = $("pagesEditor"); wrap.innerHTML = "";
    (state.doc.pages || []).forEach(function (page, pi) {
      var card = el("div", "page-card"); card.setAttribute("data-role", "pagecard");
      var title = el("div", "page-title");
      title.appendChild(el("strong", null, "Страница " + (pi + 1)));
      var delPage = el("button", "btn btn-danger", "Удалить страницу");
      delPage.addEventListener("click", function () { collectDoc(); state.doc.pages.splice(pi, 1); renderPages(); updatePlaceholders(); });
      title.appendChild(delPage); card.appendChild(title);

      card.appendChild(el("div", "field-sm", "Условие показа страницы"));
      card.appendChild(conditionEditor(page.visibleWhen, "pagecond"));

      card.appendChild(richEditor("Заголовок", headingRunsOf(page), "heading"));

      card.appendChild(el("div", "field", "Блоки текста"));
      var blist = el("div", "block-list"); blist.setAttribute("data-role", "blocklist");
      var blocks = blocksOf(page); if (!blocks.length) blocks = [{ runs: [] }];
      blocks.forEach(function (b) { blist.appendChild(blockCard(b)); });
      card.appendChild(blist);
      var addB = el("button", "btn btn-ghost", "+ Блок текста");
      addB.addEventListener("click", function () { blist.appendChild(blockCard({ runs: [] })); });
      card.appendChild(addB);

      card.appendChild(el("div", "field", "Чекбоксы"));
      var cbList = el("div", "cb-list"); cbList.setAttribute("data-role", "cblist");
      (page.checkboxes || []).forEach(function (cb) { cbList.appendChild(checkboxRow(cb)); }); card.appendChild(cbList);
      var addCb = el("button", "btn btn-ghost", "+ Чекбокс");
      addCb.addEventListener("click", function () { cbList.appendChild(checkboxRow({ label: "", required: true })); });
      card.appendChild(addCb);

      card.appendChild(el("div", "field", "Группы вариантов (выбрать можно один)"));
      var grpList = el("div", "cb-list"); grpList.setAttribute("data-role", "grouplist");
      (page.groups || []).forEach(function (g) { grpList.appendChild(groupCard(g)); }); card.appendChild(grpList);
      var addGrp = el("button", "btn btn-ghost", "+ Группа вариантов");
      addGrp.addEventListener("click", function () { grpList.appendChild(groupCard({ options: [{ key: "", label: "" }, { key: "", label: "" }] })); });
      card.appendChild(addGrp);

      var dyn = el("label", "check-inline dyn-anchor");
      var dynCb = el("input"); dynCb.type = "checkbox"; dynCb.checked = !!page.includeDynamic; dynCb.setAttribute("data-role", "includedynamic");
      dyn.appendChild(dynCb); dyn.appendChild(document.createTextNode(" Показывать здесь чекбоксы, присланные по API"));
      card.appendChild(dyn);

      wrap.appendChild(card);
    });

    // Signature page: custom content (text / image) on either side of the signature field.
    var signCard = el("div", "page-card sign-page-card");
    var st = el("div", "page-title"); st.appendChild(el("strong", null, "Страница подписи")); signCard.appendChild(st);
    signCard.appendChild(el("p", "sig-meta", "Здесь можно разместить текст или картинку (реквизиты, печать, пояснение) над полем подписи и под ним. То же самое попадёт в PDF."));

    signCard.appendChild(el("div", "field", "Над полем подписи"));
    var sblist = el("div", "block-list"); sblist.setAttribute("data-role", "signblocklist");
    (state.doc.signBlocks || []).forEach(function (b) { sblist.appendChild(blockCard(b)); });
    signCard.appendChild(sblist);
    var addSb = el("button", "btn btn-ghost", "+ Блок над подписью");
    addSb.addEventListener("click", function () { sblist.appendChild(blockCard({ runs: [] })); });
    signCard.appendChild(addSb);

    signCard.appendChild(el("div", "sign-divider", "Поле подписи"));

    signCard.appendChild(el("div", "field", "Под полем подписи"));
    var sblistBelow = el("div", "block-list"); sblistBelow.setAttribute("data-role", "signblocklistbelow");
    (state.doc.signBlocksBelow || []).forEach(function (b) { sblistBelow.appendChild(blockCard(b)); });
    signCard.appendChild(sblistBelow);
    var addSbBelow = el("button", "btn btn-ghost", "+ Блок под подписью");
    addSbBelow.addEventListener("click", function () { sblistBelow.appendChild(blockCard({ runs: [] })); });
    signCard.appendChild(addSbBelow);
    wrap.appendChild(signCard);
  }
  function checkboxRow(cb) {
    var box = el("div", "cb-item"); box.setAttribute("data-role", "cbrow");
    var row = el("div", "cb-row");
    var label = el("input"); label.type = "text"; label.placeholder = "Текст пункта"; label.value = cb.label || ""; label.setAttribute("data-role", "cblabel"); row.appendChild(label);
    // Имя, по которому внешняя система адресует именно этот пункт. Без имени пункт остаётся
    // обычным чекбоксом из шаблона, как раньше.
    var key = el("input", "cb-key"); key.type = "text"; key.placeholder = "имя для API"; key.value = cb.key || ""; key.setAttribute("data-role", "cbkey"); row.appendChild(key);
    var reqLabel = el("label"); var req = el("input"); req.type = "checkbox"; req.checked = cb.required !== false; req.setAttribute("data-role", "cbreq");
    reqLabel.appendChild(req); reqLabel.appendChild(document.createTextNode(" обязательный")); row.appendChild(reqLabel);
    var chkLabel = el("label"); var chk = el("input"); chk.type = "checkbox"; chk.checked = !!cb.checked; chk.setAttribute("data-role", "cbchecked");
    chkLabel.appendChild(chk); chkLabel.appendChild(document.createTextNode(" отмечен")); row.appendChild(chkLabel);
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { box.remove(); updatePlaceholders(); }); row.appendChild(del);
    box.appendChild(row);
    box.appendChild(conditionEditor(cb.visibleWhen, "cbcond"));
    return box;
  }

  // --- группа вариантов: выбрать можно один, «ни одного» тоже состояние ---
  function groupCard(g) {
    var card = el("div", "group-card"); card.setAttribute("data-role", "grouprow");
    var head = el("div", "cb-row");
    var title = el("input"); title.type = "text"; title.placeholder = "Заголовок группы"; title.value = g.title || ""; title.setAttribute("data-role", "gtitle"); head.appendChild(title);
    var key = el("input", "cb-key"); key.type = "text"; key.placeholder = "имя для API"; key.value = g.key || ""; key.setAttribute("data-role", "gkey"); head.appendChild(key);
    var reqLabel = el("label"); var req = el("input"); req.type = "checkbox"; req.checked = !!g.required; req.setAttribute("data-role", "greq");
    reqLabel.appendChild(req); reqLabel.appendChild(document.createTextNode(" обязательно выбрать")); head.appendChild(reqLabel);
    var del = el("button", "btn btn-danger", "×"); del.addEventListener("click", function () { card.remove(); updatePlaceholders(); }); head.appendChild(del);
    card.appendChild(head);

    var opts = el("div", "opt-list"); opts.setAttribute("data-role", "optlist");
    (g.options || []).forEach(function (o) { opts.appendChild(optionRow(o)); });
    card.appendChild(opts);
    var addOpt = el("button", "btn btn-ghost btn-sm", "+ Вариант");
    addOpt.addEventListener("click", function () { opts.appendChild(optionRow({ key: "", label: "" })); });
    card.appendChild(addOpt);
    card.appendChild(conditionEditor(g.visibleWhen, "gcond"));
    return card;
  }

  function optionRow(o) {
    var row = el("div", "cb-row"); row.setAttribute("data-role", "optrow");
    var label = el("input"); label.type = "text"; label.placeholder = "Текст варианта"; label.value = o.label || ""; label.setAttribute("data-role", "olabel"); row.appendChild(label);
    var key = el("input", "cb-key"); key.type = "text"; key.placeholder = "имя для API"; key.value = o.key || ""; key.setAttribute("data-role", "okey"); row.appendChild(key);
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
      var blocks = collectBlocks(card);
      var checkboxes = [];
      card.querySelectorAll('[data-role="cbrow"]').forEach(function (r) {
        var lab = r.querySelector('[data-role="cblabel"]').value;
        var req = r.querySelector('[data-role="cbreq"]').checked;
        var chk = !!(r.querySelector('[data-role="cbchecked"]') || {}).checked;
        var key = (r.querySelector('[data-role="cbkey"]') || {}).value || "";
        if (!lab.trim()) return;
        var item = { key: key.trim(), label: lab, required: req, checked: chk };
        var cond = readCondition(r.querySelector('[data-role="cbcond"]'));
        if (cond) item.visibleWhen = cond;
        checkboxes.push(item);
      });
      var groups = [];
      card.querySelectorAll('[data-role="grouprow"]').forEach(function (r) {
        var options = [];
        r.querySelectorAll('[data-role="optrow"]').forEach(function (o) {
          var okey = (o.querySelector('[data-role="okey"]').value || "").trim();
          var olabel = o.querySelector('[data-role="olabel"]').value || "";
          if (okey) options.push({ key: okey, label: olabel });
        });
        var gkey = (r.querySelector('[data-role="gkey"]').value || "").trim();
        // Группа без имени или без вариантов не может быть ни показана, ни адресована по API.
        if (!gkey || !options.length) return;
        var grp = {
          key: gkey,
          title: r.querySelector('[data-role="gtitle"]').value || "",
          required: r.querySelector('[data-role="greq"]').checked,
          options: options
        };
        var gcond = readCondition(r.querySelector('[data-role="gcond"]'));
        if (gcond) grp.visibleWhen = gcond;
        groups.push(grp);
      });
      var page = { heading: "", body: "", headingRuns: headingRuns, blocks: blocks, checkboxes: checkboxes, groups: groups, includeDynamic: includeDynamic };
      if (pageCond) page.visibleWhen = pageCond;
      pages.push(page);
    });
    state.doc.pages = pages;
    state.doc.signBlocks = collectBlocks(document.querySelector('[data-role="signblocklist"]'));
    state.doc.signBlocksBelow = collectBlocks(document.querySelector('[data-role="signblocklistbelow"]'));
  }
  $("addPage").addEventListener("click", function () { collectDoc(); state.doc.pages.push({ headingRuns: [{ text: "Новая страница" }], blocks: [], checkboxes: [], includeDynamic: false }); renderPages(); });
  $("saveDocument").addEventListener("click", function () { collectDoc(); apiSend("/document", "PUT", state.doc).then(function () { toast("Документ сохранён"); }); });

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
    (state.doc.pages || []).forEach(function (p) {
      if (p.visibleWhen && p.visibleWhen.field) add(p.visibleWhen.field);
      (p.blocks || []).forEach(function (b) { if (b.visibleWhen && b.visibleWhen.field) add(b.visibleWhen.field); });
    });
    (state.doc.signBlocks || []).forEach(function (b) { if (b.visibleWhen && b.visibleWhen.field) add(b.visibleWhen.field); });
    (state.doc.signBlocksBelow || []).forEach(function (b) { if (b.visibleWhen && b.visibleWhen.field) add(b.visibleWhen.field); });
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
      var known = FIELD_VALUES[k];
      if (known) {
        var wrap = el("label", "field", k);
        var sel = el("select");
        known.forEach(function (v) { sel.appendChild(new Option(v, v)); });
        sel.value = known.indexOf(previewDefault(k)) >= 0 ? previewDefault(k) : known[0];
        wrap.appendChild(sel);
        c.appendChild(wrap); inputs[k] = sel;
      } else {
        var f = labeledInput(k, previewDefault(k));
        c.appendChild(f.wrap); inputs[k] = f.input;
      }
    });

    var cbLabel = el("label", "field", "Чекбоксы из API (по одному в строке, «+» в начале - отмечен)");
    var cbArea = el("textarea"); cbArea.rows = 3; cbArea.placeholder = "+Согласен на рассылку\nДополнительное согласие";
    cbLabel.appendChild(cbArea); c.appendChild(cbLabel);

    var go = el("button", "btn btn-primary", "Показать предпросмотр");
    go.addEventListener("click", function () {
      var fields = {}; placeholders.forEach(function (k) { fields[k] = inputs[k].value; });
      var checkboxes = (cbArea.value || "").split("\n").map(function (line) {
        var t = line.trim(); if (!t) return null;
        var checked = t.charAt(0) === "+";
        return { label: checked ? t.slice(1).trim() : t, checked: checked, required: false };
      }).filter(Boolean);
      runPreview(fields, checkboxes);
    });
    c.appendChild(go);
    openModal(c);
    if (placeholders.length && inputs[placeholders[0]]) inputs[placeholders[0]].focus();
  }

  // Sensible sample values so the operator can preview without typing everything.
  function previewDefault(tag) {
    var map = {
      "ФИО": "Иванова Анна Петровна", "ДР": "01.01.1990", "Адрес регистрации": "г. Минск, ул. Ленина 1",
      "Пол": "F", "email": "anna@example.by", "telephone": "+375291234567",
      "document": "MP1234567", "date": new Date().toLocaleDateString("ru-RU"),
      "cross-border": "true", "urine": "true", "UG": "true"
    };
    return map[tag] || (/^text\d+$/.test(tag) ? "Текст из внешней системы" : "");
  }

  function runPreview(fields, checkboxes) {
    apiSend("/document/preview", "POST", { document: state.doc, fields: fields, checkboxes: checkboxes })
      .then(function (r) { return r.json(); })
      .then(function (data) { renderPreview(data, fields, checkboxes); })
      .catch(function () { /* already reported by api() */ });
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

  function renderPreview(data, fields, checkboxes) {
    var doc = (data && data.document) || { pages: [] };
    var pages = doc.pages || [];
    var screens = pages.map(function (_, i) { return { type: "page", index: i }; });
    screens.push({ type: "signature" });
    var idx = 0;

    var c = el("div", "preview-wrap");
    var head = el("div", "pv-head");
    head.appendChild(el("h3", null, "Предпросмотр: так увидит клиент"));
    var stats = el("div", "sig-meta",
      "Страниц показано: " + data.pagesShown + " из " + data.pagesTotal +
      (data.missingPlaceholders && data.missingPlaceholders.length ? " · Не заполнены: " + data.missingPlaceholders.join(", ") : ""));
    head.appendChild(stats);
    c.appendChild(head);

    var frame = el("div", "pv-frame");
    var title = el("div", "pv-title"); frame.appendChild(title);
    var progress = el("div", "pv-progress"); frame.appendChild(progress);
    var body = el("div", "pv-body"); frame.appendChild(body);
    var footer = el("div", "pv-footer"); frame.appendChild(footer);
    c.appendChild(frame);

    var back = el("button", "btn btn-ghost", "Назад");
    var next = el("button", "btn btn-primary", "Далее");
    footer.appendChild(back); footer.appendChild(next);
    back.addEventListener("click", function () { if (idx > 0) { idx--; draw(); } });
    next.addEventListener("click", function () { if (idx < screens.length - 1) { idx++; draw(); } });

    function draw() {
      var s = screens[idx];
      title.textContent = doc.title || "";
      progress.textContent = "Шаг " + (idx + 1) + " из " + screens.length;
      body.innerHTML = "";
      if (s.type === "page") {
        var p = pages[s.index];
        var h = el("h2", "pv-heading"); previewRuns(h, p.headingRuns || []); body.appendChild(h);
        (p.blocks || []).forEach(function (b) { previewBlock(body, b); });
        (p.checkboxes || []).forEach(function (cb) {
          var row = el("div", "pv-check" + (cb.checked ? " on" : ""));
          row.appendChild(el("span", "pv-box", cb.checked ? "✓" : ""));
          row.appendChild(el("span", null, (cb.label || "") + (cb.required ? " *" : "")));
          body.appendChild(row);
        });
        // Группы показываются целиком, вместе с невыбранными вариантами: оператор должен видеть,
        // из чего клиент будет выбирать, а не только присланный выбор.
        (page.groups || []).forEach(function (g) {
          body.appendChild(el("div", "pv-group-title", (g.title || g.key || "") + (g.required ? " *" : "")));
          (g.options || []).forEach(function (o) {
            var chosen = g.selected && o.key === g.selected;
            var row = el("div", "pv-check" + (chosen ? " on" : ""));
            row.appendChild(el("span", "pv-box", chosen ? "✓" : ""));
            row.appendChild(el("span", null, o.label || o.key || ""));
            body.appendChild(row);
          });
          if (!g.selected) body.appendChild(el("div", "sig-meta", "Вариант не выбран."));
        });
      } else {
        (doc.signBlocks || []).forEach(function (b) { previewBlock(body, b); });
        body.appendChild(el("div", "pv-signline", "Поле подписи"));
        (doc.signBlocksBelow || []).forEach(function (b) { previewBlock(body, b); });
        body.appendChild(el("div", "pv-prompt", doc.signPrompt || ""));
        body.appendChild(el("div", "pv-pad", "поле подписи"));
      }
      back.disabled = idx === 0;
      next.disabled = idx === screens.length - 1;
    }
    draw();

    var again = el("button", "btn btn-ghost", "Изменить значения");
    again.addEventListener("click", function () { closeModal(); openPreviewSetup(previewFields()); });
    c.appendChild(again);
    openModal(c);
  }

  // ---- Backup: export all pages to a file, import them back ----
  // Export saves what is currently in the editor, so unsaved edits are included in the backup.
  $("exportDoc").addEventListener("click", function () {
    collectDoc();
    apiSend("/document", "PUT", state.doc).then(function () {
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
    var btn = el("button", "btn btn-primary", "Отправить на планшет");
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

      var actions = el("div", "dev-actions");
      var bId = el("button", "btn btn-ghost btn-sm", "Опознать");
      bId.title = "Показать номер на экране планшета";
      bId.addEventListener("click", function () {
        apiSend("/devices/" + d.id + "/identify", "POST", {}).then(function (r) { return r.json(); })
          .then(function (j) { toast("На планшете «" + d.name + "» показан номер " + j.code); });
      });
      actions.appendChild(bId);
      // Only offered when tablet control is switched on: otherwise every button in the modal would
      // answer "управление выключено" and the operator would be left guessing where the switch is.
      if (kc.enabled) {
        var bCtl = el("button", "btn btn-ghost btn-sm", "Управление");
        bCtl.title = "Перезагрузка, перезапуск приложения, очистка кэша, экран, снимок экрана";
        bCtl.addEventListener("click", function () { openControl(d); });
        actions.appendChild(bCtl);
      }
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
    var wsSel = labeledSelect("Рабочее место", [{ v: "", t: "- не привязывать -" }].concat(state.workstations.map(function (w) { return { v: w.id, t: wsOptionLabel(w) }; })));
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
      var copy = el("button", "btn btn-ghost btn-sm", "Копировать");
      copy.addEventListener("click", function () { copyText(s.code || ""); });
      actions.appendChild(copy);
      var del = el("button", "btn btn-danger btn-sm", "Удалить");
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
      desc: "Показать документ на планшете с данными подписанта. Плейсхолдеры {{тег}} в шаблоне (текст задаётся в админке) заполняются из fields. Поддерживаемые теги: ФИО, ДР, Адрес регистрации, Пол (M/F), email, telephone, document, date, cross-border, urine, UG (true/false), text1..text10. Булевы теги принимают только true или false, в любом виде: настоящий JSON-булев true, либо строку true в кавычках, регистр не важен. Другое значение возвращает ошибку с именем тега, а не молчаливо скрытый блок. По этим же тегам работают условия показа блоков и страниц (см. раздел «Условия показа»). Массив checkboxes добавляет пункты согласия: checked - начальное состояние (можно прислать отмеченным или пустым), required - обязателен. Цель: deviceId или workstationExternalId (если на месте несколько планшетов - ответ 409, укажите deviceId). В ответе missingPlaceholders - какие теги не переданы.",
      sample: 'curl -X POST -H "X-Api-Key: ВАШ_КЛЮЧ" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"workstationExternalId":"WS-204",\n       "fields":{"ФИО":"Иванова Анна","ДР":"01.01.1990","Пол":"F",\n                 "email":"a@example.by","telephone":"+375291234567",\n                 "document":"MP1234567","date":"20.08.2026",\n                 "cross-border":true,"urine":true,"UG":false,\n                 "Адрес регистрации":"г. Минск, ул. Ленина 1","text1":"доп. текст"},\n       "checkboxes":[{"key":"consent","checked":true},\n                     {"label":"Согласен на рассылку","checked":false,"required":false}],\n       "groups":[{"key":"transfer","selected":"deny"}]}\' \\\n  {BASE}/api/ext/show-document'
    },
    {
      method: "POST", path: "/api/ext/scan-request",
      desc: "Запросить сканирование ШК/QR и ДОЖДАТЬСЯ результата: на планшете открывается камера, клиент показывает код, код возвращается в ответе и сохраняется. Поддерживаются QR, EAN-13, EAN-8, Code-128. Цель: deviceId или workstationExternalId. timeoutSec - сколько ждать (по умолчанию 60, максимум 300). Ответ: { ok, code, format, scanId, createdUtc }. Если код не показали за отведённое время - 408 и камера на планшете закрывается.",
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
  function init() {
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
  }

  checkAuth();
})();
