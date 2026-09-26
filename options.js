// FullPageShot — options page logic.
// Persists settings to chrome.storage.sync so the service worker can read them at capture
// time. Renders correctly even outside the extension (chrome.* absent), so the page can be
// previewed/screenshotted standalone.

const DEFAULTS = {
  captureMode: "faithful",   // "faithful" | "everything"
  saveLocation: "downloads", // "downloads" | "subfolder" | "ask"
  saveSubfolder: "",
  copyPath: false
};
const VALID = {
  captureMode: new Set(["faithful", "everything"]),
  saveLocation: new Set(["downloads", "subfolder", "ask"])
};
const touched = new Set(); // setting keys the user changed; a late initial read won't stomp them
let sfLastSaved = null;    // last subfolder value loaded/persisted (baseline for dedupe)

const hasStorage = (() => {
  try { return !!(chrome && chrome.storage && chrome.storage.sync); } catch (_) { return false; }
})();

function radios(name) {
  return Array.prototype.slice.call(document.querySelectorAll('input[name="' + name + '"]'));
}
const subfolderInput = () => document.getElementById("saveSubfolder");
const copyPathBox = () => document.getElementById("copyPath");

function applyRadio(name, value) {
  const v = VALID[name].has(value) ? value : DEFAULTS[name];
  for (const r of radios(name)) r.checked = (r.value === v);
}
function applyCopyPath(on) { const b = copyPathBox(); if (b) b.checked = !!on; }
function applySubfolder(v) {
  const el = subfolderInput();
  const val = typeof v === "string" ? v : "";
  // Populate unless the user has actually EDITED the field; a mere focus must not block the load
  // (otherwise focusing before the read lands, then blurring, could erase the saved value).
  if (el && !touched.has("saveSubfolder")) { el.value = val; sfLastSaved = val; }
}

function showSaved() {
  const el = document.getElementById("saved");
  if (!el) return;
  el.classList.add("show");
  clearTimeout(showSaved._t);
  showSaved._t = setTimeout(() => el.classList.remove("show"), 1400);
}

function save(patch) {
  if (!hasStorage) return;
  try {
    chrome.storage.sync.set(patch, () => { if (!chrome.runtime.lastError) showSaved(); });
  } catch (_) {}
}

function load() {
  if (!hasStorage) {
    applyRadio("captureMode", DEFAULTS.captureMode);
    applyRadio("saveLocation", DEFAULTS.saveLocation);
    applySubfolder(DEFAULTS.saveSubfolder);
    applyCopyPath(DEFAULTS.copyPath);
    return;
  }
  try {
    chrome.storage.sync.get(DEFAULTS, (res) => {
      const r = res || DEFAULTS;
      if (!touched.has("captureMode"))  applyRadio("captureMode", r.captureMode);
      if (!touched.has("saveLocation")) applyRadio("saveLocation", r.saveLocation);
      if (!touched.has("saveSubfolder")) applySubfolder(r.saveSubfolder);
      if (!touched.has("copyPath"))     applyCopyPath(r.copyPath);
    });
  } catch (_) {}
}

function fillVersion() {
  const el = document.getElementById("version");
  if (!el) return;
  try { el.textContent = "v" + chrome.runtime.getManifest().version; }
  catch (_) { el.textContent = ""; }
}

// Keyboard shortcut status. Chrome only applies the manifest's suggested key when it is free at
// install time (another extension may already own it), so show the live binding and offer a fix.
// Outside the extension, `?shortcut=` (empty = unset) drives the card for previews.
function renderShortcut(shortcut) {
  const card = document.getElementById("shortcutCard");
  const name = document.getElementById("shortcutName");
  const desc = document.getElementById("shortcutDesc");
  const btn = document.getElementById("shortcutBtn");
  if (!card || !name || !desc || !btn) return;
  name.textContent = "";
  if (shortcut) {
    card.classList.remove("unset");
    name.append("Capture shortcut ");
    const k = document.createElement("kbd");
    k.textContent = shortcut;
    name.append(k);
    desc.textContent = "Press it on any page to capture it. The toolbar button does the same.";
    btn.textContent = "Change shortcut";
  } else {
    card.classList.add("unset");
    name.append("No shortcut set ");
    const b = document.createElement("span");
    b.className = "badge-warn";
    b.textContent = "Not set";
    name.append(b);
    desc.textContent = "Chrome could not assign the suggested shortcut, usually because another extension already uses it. Choose a key combination to capture with the keyboard. The toolbar button works either way.";
    btn.textContent = "Set shortcut";
  }
}

function loadShortcut() {
  let cmds = null;
  try { cmds = chrome.commands; } catch (_) {}
  if (!cmds) {
    const q = new URLSearchParams(location.search);
    renderShortcut(q.has("shortcut") ? q.get("shortcut") : "\u2318\u21e7Y");
    return;
  }
  try {
    cmds.getAll((list) => {
      const c = (list || []).find((x) => x.name === "capture-full-page");
      renderShortcut(c ? c.shortcut : "");
    });
  } catch (_) {}
}

function openShortcutSettings() {
  // chrome:// URLs can't be opened from a plain link; tabs.create needs no permission.
  try { chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); } catch (_) {}
}

document.addEventListener("DOMContentLoaded", () => {
  for (const r of radios("captureMode")) {
    r.addEventListener("change", () => { if (r.checked) { touched.add("captureMode"); save({ captureMode: r.value }); } });
  }
  for (const r of radios("saveLocation")) {
    r.addEventListener("change", () => { if (r.checked) { touched.add("saveLocation"); save({ saveLocation: r.value }); } });
  }

  const sf = subfolderInput();
  if (sf) {
    // Typing in the subfolder field implies choosing that option.
    const selectSubfolder = () => {
      const r = radios("saveLocation").find((x) => x.value === "subfolder");
      if (r && !r.checked) { r.checked = true; touched.add("saveLocation"); save({ saveLocation: "subfolder" }); }
    };
    let sfTimer = null;
    const persistSubfolder = () => {
      clearTimeout(sfTimer); sfTimer = null;
      if (!touched.has("saveSubfolder")) return; // never edited: nothing to persist
      if (sf.value === sfLastSaved) return;      // unchanged since last write: dedupe
      sfLastSaved = sf.value;
      save({ saveSubfolder: sf.value });
    };
    sf.addEventListener("focus", selectSubfolder);
    sf.addEventListener("input", () => {
      touched.add("saveSubfolder");
      selectSubfolder();
      // Debounce writes so fast typing can't exceed chrome.storage.sync's write quota (120/min).
      clearTimeout(sfTimer);
      sfTimer = setTimeout(persistSubfolder, 500);
    });
    // `change` (Enter or commit-on-blur-after-edit) flushes; dirty-guarded + deduped so a blur
    // without edits can't overwrite the saved folder. No unconditional blur handler.
    sf.addEventListener("change", persistSubfolder);
  }

  const box = copyPathBox();
  if (box) {
    box.addEventListener("change", () => { touched.add("copyPath"); save({ copyPath: box.checked }); });
  }

  const scBtn = document.getElementById("shortcutBtn");
  if (scBtn) scBtn.addEventListener("click", openShortcutSettings);
  // Re-read when the user comes back from chrome://extensions/shortcuts.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadShortcut(); });
  window.addEventListener("focus", loadShortcut);

  load();
  loadShortcut();
  fillVersion();
});
