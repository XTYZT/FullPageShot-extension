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

  load();
  fillVersion();
});
