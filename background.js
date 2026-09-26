// FullPageShot — Copyright (C) 2026 Reimagined Multimedia KLG. Made by re:imagined agency (reimagined.agency).
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
//
// Full-Page Shot — self-hosted, no remote code.
// Captures the ENTIRE scrolling height of the CURRENT live tab (session, scroll,
// dynamic DOM all preserved) as one PNG, via chrome.debugger (CDP).
// Triggered by the keyboard shortcut (manifest "commands") OR the toolbar button.
//
// v2.1 pipeline:
//   attach -> isolated world -> in-page: promote lazy resources,
//     UN-CLIP page-level scroll containers (body-scroll / inner-scroll app shells),
//     wait for load/fonts, settle until document height is stable,
//   restore-on-failure watchdog -> scroll top -> hide off-screen fixed overlays ->
//   measure (cssContentSize + zoom + dpr) -> size/scale gate (native Retina;
//   downscale-to-fit) -> navigation guard -> Page.captureScreenshot(captureBeyondViewport)
//   -> validate PNG IHDR (retry once) -> cleanup (CAS restore) -> detach -> download.
//
// No position mutation of fixed/sticky elements (that leaked hidden overlays in v1.1).

const PROTO = "1.3";
const MAX_PIXELS = 40_000_000; // output-pixel safety cap (RGBA memory guard)
const MAX_DIM = 60_000;        // PNG output dimension guard (per Chromium page limit)

let capturing = false;               // global mutex
const detachedTabs = new Set();      // tabIds whose debugger session dropped mid-capture

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) detachedTabs.add(source.tabId);
});

// ---------- badge ----------
function flash(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1600);
}

// ---------- CDP helpers ----------
async function evalInPage(target, contextId, expression, awaitPromise) {
  const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    contextId,
    awaitPromise: !!awaitPromise,
    returnByValue: true
  });
  if (res && res.exceptionDetails) {
    const ex = res.exceptionDetails.exception;
    throw new Error("in-page: " + ((ex && ex.description) || res.exceptionDetails.text || "eval error"));
  }
  return res && res.result ? res.result.value : undefined;
}

async function capture(target, clip) {
  const params = {
    format: "png",
    fromSurface: true,
    optimizeForSpeed: true,
    captureBeyondViewport: true
  };
  if (clip) params.clip = clip;
  const r = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", params);
  return r.data; // base64 PNG
}

// ---------- PNG IHDR validation ----------
function pngSize(b64) {
  try {
    const bin = atob(b64.substring(0, 64)); // sig(8)+len(4)+"IHDR"(4)+w(4)+h(4) => need first 24 bytes
    const b = (i) => bin.charCodeAt(i);
    const w = ((b(16) << 24) | (b(17) << 16) | (b(18) << 8) | b(19)) >>> 0;
    const h = ((b(20) << 24) | (b(21) << 16) | (b(22) << 8) | b(23)) >>> 0;
    return { w, h };
  } catch (_) {
    return { w: 0, h: 0 };
  }
}

function withinTol(dim, expW, expH) {
  const tw = Math.max(4, Math.ceil(expW * 0.01));
  const th = Math.max(4, Math.ceil(expH * 0.01));
  return dim.w > 0 && dim.h > 0 &&
         dim.w <= MAX_DIM && dim.h <= MAX_DIM &&
         Math.abs(dim.w - expW) <= tw && Math.abs(dim.h - expH) <= th;
}

function computeOutputScale(w, h, dpr) {
  return Math.min(dpr, Math.sqrt(MAX_PIXELS / (w * h)), MAX_DIM / w, MAX_DIM / h);
}

function slug(host) {
  return ((host || "").replace(/[\[\]:]/g, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "")) || "page";
}

// Slugify a URL pathname into a short filename-safe fragment (empty for the site root).
function slugPath(pathname) {
  return (pathname || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// Local (not UTC) date + HH MM stamp for readable, sortable file names.
function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}` // HHMM (4 digits)
  };
}

// ---------- in-page script (runs in an isolated world; only touches page globals) ----------
// Defined as a normal function and stringified; it must reference ONLY page APIs + its opts arg.
async function inPageMain(opts) {
  const DEADLINE = opts.deadlineMs;
  const PRESCROLL_MS = opts.prescrollMs;
  const MAX_PROMO = opts.maxPromotions;
  const WATCHDOG_MS = opts.watchdogMs;
  const SETTLE_QUIET = opts.settleQuietMs;

  // Idempotent: undo any prior run first.
  try { if (globalThis.__fps && globalThis.__fps.cleanup) globalThis.__fps.cleanup(); } catch (_) {}

  const log = [];                       // CAS restore records
  const scrollRecords = [];             // inner-scroller positions to restore on cleanup
  let cleaned = false;                  // cleanup is one-shot (prevents double-restore)
  const ac = new AbortController();
  const signal = ac.signal;
  const pending = new Set();
  let observer = null;
  let watchdog = null;
  let revealStyle = null;
  const diag = { promoted: 0, loaded: 0, failed: 0, timedOut: false, fontTimeout: false, revealed: 0, unclipped: 0, hiddenOverlays: 0, settledH: 0, w: 0, h: 0, dpr: 1 };

  const savedX = window.scrollX, savedY = window.scrollY;
  const savedScrollTop = (document.scrollingElement || document.documentElement || {}).scrollTop || 0;

  function setAttr(el, key, val) {
    log.push({ el, kind: "attr", key, had: el.hasAttribute(key), prev: el.getAttribute(key), injected: val });
    el.setAttribute(key, val);
  }
  function setStyleProp(el, key, val, prio) {
    const rec = {
      el, kind: "prop", key,
      hadStyleAttr: el.hasAttribute("style"),
      prev: el.style.getPropertyValue(key),
      prevPriority: el.style.getPropertyPriority(key)
    };
    el.style.setProperty(key, val, prio || "");
    rec.injected = el.style.getPropertyValue(key);           // serialized value the browser stored
    rec.injectedPriority = el.style.getPropertyPriority(key); // and the priority it stored
    log.push(rec);
  }

  function trackImg(img) {
    try {
      if (!(img.currentSrc || img.getAttribute("src") || img.getAttribute("srcset"))) return;
      if (img.complete && img.naturalWidth > 0) { diag.loaded++; return; }
      pending.add(img);
      const done = (ok) => { pending.delete(img); if (ok) diag.loaded++; else diag.failed++; };
      img.addEventListener("load", () => done(true), { once: true, signal });
      img.addEventListener("error", () => done(false), { once: true, signal });
      if (img.complete) done(img.naturalWidth > 0); // recheck after attaching
    } catch (_) {}
  }
  function preloadUrl(url) {
    try {
      const im = new Image();
      pending.add(im);
      const done = () => pending.delete(im);
      im.addEventListener("load", done, { once: true, signal });
      im.addEventListener("error", done, { once: true, signal });
      im.src = url;
      if (im.complete) done();
    } catch (_) {}
  }

  function promoteImg(img) {
    if (diag.promoted >= MAX_PROMO) return;
    let did = false;
    for (const a of ["data-src", "data-lazy-src", "data-original"]) {
      const v = img.getAttribute(a);
      if (v) { setAttr(img, "src", v); did = true; break; }
    }
    for (const a of ["data-srcset", "data-lazy-srcset"]) {
      const v = img.getAttribute(a);
      if (v) { setAttr(img, "srcset", v); did = true; break; }
    }
    const ds = img.getAttribute("data-sizes");
    if (ds) setAttr(img, "sizes", ds === "auto" ? Math.max(img.getBoundingClientRect().width, 1) + "px" : ds);
    else if (img.getAttribute("sizes") === "auto") setAttr(img, "sizes", Math.max(img.getBoundingClientRect().width, 1) + "px");
    if (img.getAttribute("loading") === "lazy") setAttr(img, "loading", "eager");
    if (did) diag.promoted++;
    trackImg(img);
  }
  function promoteSource(src) {
    const v = src.getAttribute("data-srcset") || src.getAttribute("data-lazy-srcset");
    if (v) { setAttr(src, "srcset", v); diag.promoted++; }
  }
  function promoteVideo(v) {
    const p = v.getAttribute("data-poster");
    if (p) setAttr(v, "poster", p);
  }
  function promoteBg(el) {
    const v = el.getAttribute("data-bg") || el.getAttribute("data-background") || el.getAttribute("data-background-image");
    if (!v) return;
    const t = v.trim();
    if (!/^(https?:|\/|data:|url\(|image-set\()/i.test(t)) return; // only plausible image values
    const val = /^(url\(|image-set\()/i.test(t) ? v : 'url("' + v.replace(/"/g, '\\"') + '")';
    setStyleProp(el, "background-image", val, "important");
    diag.promoted++;
    const m = /url\((['"]?)(.*?)\1\)/i.exec(val);
    if (m && m[2]) preloadUrl(m[2]);
  }

  function promoteAll(root) {
    try {
      root.querySelectorAll("source[data-srcset],source[data-lazy-srcset]").forEach(promoteSource);
      root.querySelectorAll("img").forEach((img) => {
        if (img.hasAttribute("data-src") || img.hasAttribute("data-lazy-src") || img.hasAttribute("data-original") ||
            img.hasAttribute("data-srcset") || img.hasAttribute("data-lazy-srcset") ||
            img.getAttribute("loading") === "lazy" || img.getAttribute("sizes") === "auto") {
          promoteImg(img);
        } else {
          trackImg(img); // still wait for already-loading images
        }
      });
      root.querySelectorAll("video[data-poster]").forEach(promoteVideo);
      root.querySelectorAll("[data-bg],[data-background],[data-background-image]").forEach(promoteBg);
    } catch (_) {}
  }

  // Release page-level scroll containers so their clipped content flows into the document
  // and the full height becomes measurable + capturable. Handles the dominant "viewport-only"
  // failure class: body-scroll layouts (html/body height:100% + overflow) and inner-scroll app
  // shells (a 100vh <div> scrolls, not the document). Reversible via the CAS log.
  // Small widgets (chat boxes, carousels, code blocks) are excluded by the page-level heuristic.
  function unclipScrollers() {
    try {
      const vh = window.innerHeight, vw = window.innerWidth;
      if (!vh || !vw) return;
      // "everything" releases page-level scrollers on EITHER axis (horizontal carousels fan out
      // to show every slide). "faithful" (default) releases only genuinely VERTICAL page scrollers
      // so a full-page shot expands body-scroll / inner-scroll app shells downward, while horizontal
      // carousels stay clipped and keep the slide they were showing on screen.
      const everything = !!(opts && opts.captureMode === "everything");
      const cands = [];
      if (document.scrollingElement) cands.push(document.scrollingElement);
      if (document.documentElement) cands.push(document.documentElement);
      if (document.body) cands.push(document.body);
      document.querySelectorAll("body *").forEach((el) => cands.push(el));
      const seen = new Set();
      const targets = [];
      // Pass 1: select eligible page-level scrollers and record their scroll offsets BEFORE any
      // mutation (un-clipping one scroller can reset another's offset).
      for (const el of cands) {
        if (!el || el.nodeType !== 1 || seen.has(el)) continue;
        seen.add(el);
        try {
          const s = getComputedStyle(el);
          const clips = /(auto|scroll|hidden|clip)/.test(s.overflowY) || /(auto|scroll|hidden|clip)/.test(s.overflowX) || /(auto|scroll|hidden|clip)/.test(s.overflow);
          if (!clips) continue;
          const vOver = el.scrollHeight > el.clientHeight + 40; // clipped content below the fold
          const hOver = el.scrollWidth  > el.clientWidth  + 40; // horizontal scroller (carousel/slider)
          // faithful: vertical overflow only, and NOT a horizontal scroller (leave carousels alone).
          // everything: any real overflow on either axis.
          if (everything ? (!vOver && !hOver) : (!vOver || hOver)) continue;
          const isDoc = (el === document.documentElement || el === document.body || el === document.scrollingElement);
          const r = el.getBoundingClientRect();
          const pageLevel = isDoc || (r.width >= vw * 0.6 && el.clientHeight >= vh * 0.5);
          if (!pageLevel) continue;
          scrollRecords.push({ el, left: el.scrollLeft, top: el.scrollTop });
          targets.push(el);
        } catch (_) {}
      }
      // Pass 2: un-clip the selected scrollers.
      for (const el of targets) {
        try {
          setStyleProp(el, "overflow", "visible", "important");
          setStyleProp(el, "overflow-x", "visible", "important");
          setStyleProp(el, "overflow-y", "visible", "important");
          setStyleProp(el, "height", "auto", "important");
          setStyleProp(el, "max-height", "none", "important");
          setStyleProp(el, "min-height", "0", "important");
          diag.unclipped++;
        } catch (_) {}
      }
      try { void document.documentElement.offsetHeight; } catch (_) {} // force reflow
    } catch (_) {}
  }

  // Force reveal of scroll-triggered content (static-CSS opacity:0 -> !important override;
  // WAAPI 0->1 reveal animations -> finish() to their visible end state).
  function injectReveal() {
    try {
      revealStyle = document.createElement("style");
      revealStyle.textContent = "img,picture,video{opacity:1!important}";
      (document.head || document.documentElement).appendChild(revealStyle);
    } catch (_) {}
  }
  function finishAnims() {
    try {
      const anims = document.getAnimations ? document.getAnimations() : [];
      for (const a of anims) { try { a.finish(); diag.revealed++; } catch (_) {} } // infinite anims throw -> left running
    } catch (_) {}
  }
  // Hide fixed overlays that are entirely OFF-SCREEN at scrollTop 0 (parked popins, drawers,
  // off-canvas menus). captureBeyondViewport would otherwise paint them mid-canvas.
  // ONLY position:fixed — sticky elements flow with content (a below-the-fold sticky heading is
  // real content, not an overlay). Visible fixed headers / cookie bars / chat bubbles are left alone.
  function hideOffscreenFixed() {
    try {
      const vh = window.innerHeight;
      document.querySelectorAll("body *").forEach((el) => {
        const c = getComputedStyle(el);
        if (c.position === "fixed" &&
            c.visibility !== "hidden" && c.display !== "none" && c.opacity !== "0") {
          const r = el.getBoundingClientRect();
          if (r.width > 1 && r.height > 1 && (r.bottom <= 1 || r.top >= vh - 1)) {
            setStyleProp(el, "visibility", "hidden", "important");
            diag.hiddenOverlays++;
          }
        }
      });
    } catch (_) {}
  }

  function cleanup() {
    if (cleaned) return;            // one-shot: never re-run (prevents a double / post-restore mutation)
    cleaned = true;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    try { if (observer) observer.disconnect(); } catch (_) {}
    try { ac.abort(); } catch (_) {}   // signals the pipeline to stop at its next await/guard
    try { if (revealStyle && revealStyle.parentNode) revealStyle.parentNode.removeChild(revealStyle); } catch (_) {}
    for (let i = log.length - 1; i >= 0; i--) {
      const r = log[i];
      try {
        if (r.kind === "attr") {
          if (r.el.getAttribute(r.key) === r.injected) {
            if (r.had) r.el.setAttribute(r.key, r.prev); else r.el.removeAttribute(r.key);
          }
        } else {
          // restore only if BOTH the value AND the priority we injected are still in place
          if (r.el.style.getPropertyValue(r.key) === r.injected &&
              r.el.style.getPropertyPriority(r.key) === r.injectedPriority) {
            if (r.prev) r.el.style.setProperty(r.key, r.prev, r.prevPriority);
            else r.el.style.removeProperty(r.key);
            if (!r.hadStyleAttr && r.el.getAttribute("style") === "") r.el.removeAttribute("style");
          }
        }
      } catch (_) {}
    }
    log.length = 0;
    // Restore scroll positions: inner scrollers first (now re-clipped), then window/document.
    for (let i = scrollRecords.length - 1; i >= 0; i--) {
      const s = scrollRecords[i];
      try { if (s.el && s.el.isConnected) { s.el.scrollLeft = s.left; s.el.scrollTop = s.top; } } catch (_) {}
    }
    scrollRecords.length = 0;
    try { window.scrollTo(savedX, savedY); } catch (_) {}
    try { const se = document.scrollingElement || document.documentElement; if (se) se.scrollTop = savedScrollTop; } catch (_) {}
    try { if (globalThis.__fps && globalThis.__fps.cleanup === cleanup) delete globalThis.__fps; } catch (_) { globalThis.__fps = undefined; }
  }

  // Arm watchdog BEFORE any mutation, publish controller.
  watchdog = setTimeout(() => { cleanup(); }, WATCHDOG_MS);
  globalThis.__fps = { cleanup };

  // Observe late-inserted / late-attributed lazy content.
  try {
    observer = new MutationObserver((muts) => {
      if (signal.aborted) return;
      for (const m of muts) {
        if (m.type === "childList") {
          m.addedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            promoteAll(n);
            if (n.matches && n.matches("img")) promoteImg(n);
          });
        } else if (m.type === "attributes" && m.target && m.target.tagName === "IMG") {
          promoteImg(m.target);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["data-src", "data-srcset"]
    });
  } catch (_) {}

  // Initial promotion pass + reveal-override for static opacity:0 lazy/reveal styles.
  promoteAll(document);
  injectReveal();

  const t0 = Date.now();
  const remaining = () => Math.max(0, DEADLINE - (Date.now() - t0));

  // Un-clip page-level scroll containers FIRST, so the document becomes the scroller and the
  // full content height is exposed (also makes the pre-scroll below actually move the page).
  unclipScrollers();

  const docH = () => Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0
  );

  // Bounded courtesy pre-scroll (for unknown IntersectionObserver / content-visibility loaders).
  try {
    const vh = window.innerHeight;
    const step = Math.max(200, Math.floor(vh * 0.9));
    const ps0 = Date.now();
    let y = 0;
    while (y < docH() - vh && (Date.now() - ps0) < PRESCROLL_MS && !signal.aborted) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
      y += step;
    }
  } catch (_) {}
  if (signal.aborted) { diag.aborted = true; return diag; }

  // Wait for images within the shared deadline.
  while (pending.size > 0 && remaining() > 0 && !signal.aborted) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (signal.aborted) { diag.aborted = true; return diag; }
  if (pending.size > 0) diag.timedOut = true;

  // Settle: wait for the document height to stop growing (deferred/async content, e.g. late
  // section hydration in SPAs). Re-promote on growth. Bounded by the shared deadline.
  try {
    let last = docH(), stableFor = 0;
    while (remaining() > 0 && stableFor < SETTLE_QUIET && !signal.aborted) {
      await new Promise((r) => setTimeout(r, 150));
      if (signal.aborted) break;   // cleanup ran during the await: don't re-promote/mutate after a restore
      const now = docH();
      if (now > last + 1) { last = now; stableFor = 0; promoteAll(document); }
      else stableFor += 150;
    }
    // absorb any images promoted during settle
    const t1 = Date.now();
    while (pending.size > 0 && remaining() > 0 && (Date.now() - t1) < 2000 && !signal.aborted) {
      await new Promise((r) => setTimeout(r, 100));
    }
    diag.settledH = last;
  } catch (_) {}
  if (signal.aborted) { diag.aborted = true; return diag; }

  // Fonts (bounded).
  try {
    const fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    await Promise.race([
      fontsReady.catch(() => {}),
      new Promise((r) => setTimeout(() => { diag.fontTimeout = true; r(); }, remaining()))
    ]);
  } catch (_) {}
  if (signal.aborted) { diag.aborted = true; return diag; }

  // Best-effort decode of everything currently in the DOM (bounded by the deadline).
  try {
    const decodeAll = Promise.all(Array.prototype.slice.call(document.images).map((i) => (i.decode ? i.decode() : Promise.resolve()).catch(() => {})));
    await Promise.race([decodeAll, new Promise((r) => setTimeout(r, Math.min(remaining(), 3000)))]);
  } catch (_) {}

  if (signal.aborted) { diag.aborted = true; return diag; }

  // Reveal scroll-triggered animations (WAAPI opacity 0->1) created during promotion/pre-scroll.
  // A stylesheet override can't beat a *running* Web Animation, so finish() them; the injected
  // img{opacity:1!important} style then wins for any that had no animation. Skipped if aborted
  // (cleanup would otherwise fight in-flight mutations).
  finishAnims();

  // Scroll to top (instant) and let two frames settle. Bounded so a background/dead tab (where
  // rAF never fires) can't hang the pipeline, and abort-aware so cleanup can proceed.
  try { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); } catch (_) { window.scrollTo(0, 0); }
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    try { signal.addEventListener("abort", finish, { once: true }); } catch (_) {}
    const t = setTimeout(finish, 1000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); finish(); }));
  });
  if (signal.aborted) { diag.aborted = true; return diag; }

  // Hide overlays parked off-screen (search popins, drawers) so they aren't painted mid-canvas.
  hideOffscreenFixed();

  diag.w = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  diag.h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  diag.dpr = window.devicePixelRatio || 1;
  return diag;
}

function inPageMainSource(opts) {
  return "(" + inPageMain.toString() + ")(" + JSON.stringify(opts) + ")";
}

// Returns 1 only when an active preparation existed and was cleaned; 0 if none was live
// (e.g. the watchdog already restored the page and removed __fps). The caller treats 0 as
// "not acknowledged" so it never downloads a capture of an already-restored page.
const CLEANUP_EXPR = "(function(){ if (globalThis.__fps && globalThis.__fps.cleanup) { globalThis.__fps.cleanup(); return 1; } return 0; })()";

// ---------- privileged-page guard ----------
function isRestrictedUrl(url) {
  return /^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url || "") ||
         (url || "").startsWith("https://chromewebstore.google.com");
}

// ---------- copy-path-to-clipboard (optional) ----------
// Resolve the absolute path the download was actually written to. chrome.downloads.download
// resolves once the download STARTS; the final on-disk filename (incl. any "(1)" dedup) is read
// back via onChanged / search. Bounded so it never hangs the pipeline.
function getDownloadFilename(id, maxMs) {
  return new Promise((resolve) => {
    let done = false, poll = null, deadline = null;
    function finish(path) {
      if (done) return; done = true;
      try { chrome.downloads.onChanged.removeListener(onCh); } catch (_) {}
      if (poll) clearInterval(poll);
      if (deadline) clearTimeout(deadline);
      resolve(path || "");
    }
    // Only trust the filename once the download is actually COMPLETE (a filename can appear while
    // still in_progress, and the file may not exist yet or may later fail).
    const check = () => {
      try {
        chrome.downloads.search({ id }, (its) => {
          const it = its && its[0];
          if (!it) return;
          if (it.state === "complete") finish(it.filename || "");
          else if (it.state === "interrupted") finish("");
        });
      } catch (_) {}
    };
    const onCh = (delta) => {
      if (!delta || delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") check();      // read back the final filename
      else if (delta.state.current === "interrupted") finish("");
    };
    chrome.downloads.onChanged.addListener(onCh);
    check(); // immediate: catches already-complete AND already-interrupted
    // Poll below the ~30s service-worker idle timeout: this both detects completion if an event is
    // missed AND keeps the worker alive (each API call resets the idle timer) while a Save As
    // dialog is open — without it a long dialog could suspend the worker and drop the pending copy.
    poll = setInterval(check, 25000);
    deadline = setTimeout(() => finish(""), maxMs || 8000); // hard upper bound
  });
}

let offscreenReady = null;
async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
  } catch (_) {}
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Copy the saved screenshot's file path to the clipboard."
    }).catch((e) => {
      // A concurrent create can race to "already exists" — treat that as success.
      if (!/single offscreen|already/i.test(String(e && e.message))) throw e;
    }).finally(() => { offscreenReady = null; });
  }
  await offscreenReady;
}

async function copyTextToClipboard(text) {
  await ensureOffscreen();
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "fps-copy-text", target: "offscreen", text });
  } catch (_) {
    // The offscreen listener may not be ready on the very first copy — brief wait + one retry.
    await new Promise((r) => setTimeout(r, 150));
    res = await chrome.runtime.sendMessage({ type: "fps-copy-text", target: "offscreen", text });
  }
  if (!res || !res.ok) throw new Error("clipboard copy failed" + (res && res.error ? ": " + res.error : ""));
}

// Windows reserved device names — Chrome's portable filename validator rejects these on ALL
// platforms (checking the part before the first dot), so a host like con.com or a subfolder
// "CON" would make the download silently fail. We neutralize them with an underscore prefix.
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)$/i; // reserved base (before first dot)
const RESERVED_FULL = /^(desktop\.ini|thumbs\.db)$/i;                   // reserved full component

// Make one path component safe for chrome.downloads: strip illegal chars, trim leading/trailing
// dots+spaces AFTER truncation (truncation can recreate a trailing dot), avoid splitting a
// surrogate pair at the cut, and neutralize reserved names. "" if nothing usable remains.
function safeComponent(seg, maxLen) {
  let s = (seg || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/^[.\s]+/, "").replace(/[.\s]+$/g, "");
  if (maxLen) s = s.slice(0, maxLen).replace(/[\uD800-\uDBFF]$/, "").replace(/[.\s]+$/g, ""); // no lone high surrogate / trailing dot
  if (!s || s === "." || s === "..") return "";
  if (RESERVED_NAME.test(s.split(".")[0]) || RESERVED_FULL.test(s)) s = "_" + s;
  return s;
}

// Sanitize a user-supplied Downloads subfolder into a safe relative path (no absolute paths,
// no "..", no illegal/reserved components). Returns "" if nothing usable remains.
function sanitizeSubfolder(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\\/g, "/").split("/")
    .map((seg) => safeComponent(seg, 50))
    .filter(Boolean)
    .slice(0, 8) // depth guard
    .join("/");
}

// ---------- main ----------
async function captureActiveTab(tabArg) {
  if (capturing) { flash("busy", "#555555"); return; }
  capturing = true;

  const target = {};
  let attached = false;
  let restored = false;
  let contextId = null;

  try {
    let tab = tabArg;
    if (!tab) { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); tab = t; }
    if (!tab || tab.id == null) { flash("err", "#b00000"); return; }
    if (tab.url && isRestrictedUrl(tab.url)) { flash("n/a", "#b00000"); return; }

    target.tabId = tab.id;
    detachedTabs.delete(tab.id);

    // Read the user's capture mode (options page) BEFORE attaching, and bound it with a hard
    // timeout so a slow/throttled storage read can never stall a capture with the debugger
    // attached. Default faithful on timeout or error.
    let captureMode = "faithful";
    let copyPath = false;
    let saveLocation = "downloads"; // "downloads" | "subfolder" | "ask"
    let saveSubfolder = "";
    try {
      const st = await Promise.race([
        chrome.storage.sync.get({ captureMode: "faithful", copyPath: false, saveLocation: "downloads", saveSubfolder: "" }),
        new Promise((r) => setTimeout(() => r(null), 400))
      ]);
      if (st) {
        if (st.captureMode === "everything") captureMode = "everything";
        if (st.copyPath === true) copyPath = true;
        if (st.saveLocation === "ask" || st.saveLocation === "subfolder") saveLocation = st.saveLocation;
        if (typeof st.saveSubfolder === "string") saveSubfolder = st.saveSubfolder;
      }
    } catch (_) {}
    const saveAs = (saveLocation === "ask"); // show the Save As dialog per capture

    try {
      await chrome.debugger.attach(target, PROTO);
      attached = true;
    } catch (e) {
      flash("n/a", "#b00000"); // restricted page or already-attached
      console.warn("[FullPageShot] attach failed:", e);
      return;
    }

    flash("...", "#555555");
    await chrome.debugger.sendCommand(target, "Page.enable");

    const tree = await chrome.debugger.sendCommand(target, "Page.getFrameTree");
    const frameId = tree.frameTree.frame.id;
    const loaderId = tree.frameTree.frame.loaderId;

    const iso = await chrome.debugger.sendCommand(target, "Page.createIsolatedWorld", { frameId, worldName: "fps" });
    contextId = iso.executionContextId;

    // Hostname + scheme via CDP (Tab.url is unreliable without host perms).
    const loc = await evalInPage(target, contextId, "({h:location.hostname,p:location.protocol,path:location.pathname})", false);
    if (loc && /^(chrome|chrome-extension|devtools|about|view-source):/i.test(loc.p || "")) { flash("n/a", "#b00000"); return; }

    // Promote lazy content, un-clip scroll containers, wait, settle (also scrolls to top).
    const diag = await evalInPage(target, contextId, inPageMainSource({
      deadlineMs: 15000, prescrollMs: 3000, maxPromotions: 2000, watchdogMs: 45000, settleQuietMs: 450,
      captureMode
    }), true);
    if (detachedTabs.has(tab.id)) { console.warn("[FullPageShot] detached during wait"); return; }
    console.log("[FullPageShot] diagnostics:", diag);
    // Preparation aborted (watchdog fired and already restored the page) — don't capture a
    // half-restored/un-prepared page. The `finally` still runs a best-effort cleanup + detach.
    if (diag && diag.aborted) { flash("err", "#b00000"); console.warn("[FullPageShot] preparation aborted; not capturing"); return; }

    // Measure.
    const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
    const css = metrics.cssContentSize || metrics.contentSize;
    const zoom = (metrics.cssVisualViewport && metrics.cssVisualViewport.zoom) || 1;
    const dpr = (diag && diag.dpr) || 1;
    const w = Math.ceil(css.width), h = Math.ceil(css.height);

    // Size/scale gate: native Retina when it fits, else downscale-to-fit.
    let outputScale = computeOutputScale(w, h, dpr);
    let clip = null;
    let downscaled = false;
    if (outputScale < dpr - 1e-6) {
      downscaled = true;
      clip = { x: 0, y: 0, width: Math.ceil(w * zoom), height: Math.ceil(h * zoom), scale: outputScale / dpr };
    }

    // Navigation guard immediately before capture.
    const tree2 = await chrome.debugger.sendCommand(target, "Page.getFrameTree");
    if (tree2.frameTree.frame.id !== frameId || tree2.frameTree.frame.loaderId !== loaderId) {
      flash("err", "#b00000"); console.warn("[FullPageShot] navigation during capture; aborting"); return;
    }
    if (detachedTabs.has(tab.id)) return;

    // Capture (attached) + validate IHDR + one retry with fresh measurements.
    let data = await capture(target, clip);
    let dim = pngSize(data);
    if (!withinTol(dim, Math.round(w * outputScale), Math.round(h * outputScale))) {
      console.warn("[FullPageShot] IHDR mismatch", dim, "expected~", Math.round(w * outputScale), Math.round(h * outputScale), "- retrying");
      const m2 = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
      const c2 = m2.cssContentSize || m2.contentSize;
      const z2 = (m2.cssVisualViewport && m2.cssVisualViewport.zoom) || 1;
      const w2 = Math.ceil(c2.width), h2 = Math.ceil(c2.height);
      const os2 = computeOutputScale(w2, h2, dpr);
      downscaled = os2 < dpr - 1e-6;
      const clip2 = { x: 0, y: 0, width: Math.ceil(w2 * z2), height: Math.ceil(h2 * z2), scale: os2 / dpr };
      data = await capture(target, clip2);
      dim = pngSize(data);
      if (!withinTol(dim, Math.round(w2 * os2), Math.round(h2 * os2))) {
        flash("err", "#b00000"); console.warn("[FullPageShot] IHDR mismatch after retry; aborting", dim); return;
      }
    }

    // Restore the page, then detach, THEN download. Only mark restored on a confirmed ack; if
    // cleanup fails, let it propagate so the `finally` retries cleanup before detaching (and we
    // don't download a capture whose page couldn't be restored).
    const ack = await evalInPage(target, contextId, CLEANUP_EXPR, false);
    if (ack !== 1) throw new Error("cleanup did not acknowledge");
    restored = true;
    try { await chrome.debugger.detach(target); } catch (_) {}
    attached = false;

    // Smart name: site + page path + local date + HHMM. Chrome auto-dedupes same-minute repeats
    // with " (2)". e.g. swissnex-org-sanfrancisco-2026-09-23-1435.png
    const host = slug(loc && loc.h);
    const pathPart = slugPath(loc && loc.path);
    const { date, time } = stampNow();
    const base = safeComponent([host, pathPart, date, time].filter(Boolean).join("-"), 100) || ("page-" + date + "-" + time);
    const sub = (saveLocation === "subfolder") ? sanitizeSubfolder(saveSubfolder) : "";
    const filename = (sub ? sub + "/" : "") + `${base}.png`;

    let downloadId;
    try {
      downloadId = await chrome.downloads.download({ url: "data:image/png;base64," + data, filename, saveAs });
    } catch (e) {
      // A canceled Save As dialog is a user choice, not an error — bail quietly.
      if (/cancel/i.test(String(e && e.message))) { console.log("[FullPageShot] save canceled"); return; }
      throw e;
    }
    if (downloadId == null) { console.warn("[FullPageShot] download did not start (canceled?)"); return; }

    // When we need the final path (copy) or the Save As dialog is in play, wait for the download to
    // actually complete before badging/copying. A prompt can appear even in non-Ask modes if the
    // user has Chrome's global "Ask where to save each file" on, so give a generous (bounded)
    // window whenever we wait. "" => interrupted / canceled / timed out: don't claim success.
    let finalPath = "";
    if (copyPath || saveAs) {
      finalPath = await getDownloadFilename(downloadId, 240000);
      if (!finalPath) { console.log("[FullPageShot] download canceled or not completed"); return; }
    }

    // Optional: copy the saved file's absolute path (best-effort; already saved either way).
    // Fully awaited (no detached race), so a newer capture can't interleave and overwrite it.
    if (copyPath && finalPath) {
      try { await copyTextToClipboard(finalPath); }
      catch (e) { console.warn("[FullPageShot] copy path failed:", e); }
    }

    const partial = diag && (diag.timedOut || diag.failed > 0 || diag.fontTimeout);
    flash(downscaled || partial ? "⚠" : "✓", downscaled || partial ? "#b8860b" : "#0a8a0a");
  } catch (err) {
    console.error("[FullPageShot] capture failed:", err);
    flash("err", "#b00000");
  } finally {
    if (attached) {
      if (!restored && contextId != null) {
        try { await evalInPage(target, contextId, CLEANUP_EXPR, false); } catch (_) {}
      }
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
    capturing = false;
  }
}

// Hotkey and toolbar button both call the same function. (The worker is kept alive during a long
// Save As wait by getDownloadFilename's periodic downloads.search, not by returning this promise.)
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "capture-full-page") return captureActiveTab();
});
chrome.action.onClicked.addListener((tab) => captureActiveTab(tab));

// Chrome applies the manifest's suggested_key only if the combo is free at install time; when
// another extension already owns it, the command is silently left unbound (shortcut === "").
// On a fresh install, detect that and open Settings, which shows the status and a fix button.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  try {
    const cmds = await chrome.commands.getAll();
    const cmd = cmds.find((c) => c.name === "capture-full-page");
    if (cmd && !cmd.shortcut) chrome.runtime.openOptionsPage();
  } catch (err) {
    console.error("[FullPageShot] shortcut check failed:", err);
  }
});
