// FullPageShot — options page logic.
// Persists the capture mode to chrome.storage.sync so the service worker can read it
// at capture time. Renders correctly even outside the extension (chrome.* absent),
// so the page can be previewed/screenshotted standalone.

const DEFAULT_MODE = "faithful";
const VALID = new Set(["faithful", "everything"]);
let touched = false; // set once the user changes a selection, so a late initial read can't stomp it

const hasStorage = (() => {
  try { return !!(chrome && chrome.storage && chrome.storage.sync); } catch (_) { return false; }
})();

function radios() {
  return Array.prototype.slice.call(document.querySelectorAll('input[name="captureMode"]'));
}

function select(mode) {
  const m = VALID.has(mode) ? mode : DEFAULT_MODE;
  for (const r of radios()) r.checked = (r.value === m);
}

function showSaved() {
  const el = document.getElementById("saved");
  if (!el) return;
  el.classList.add("show");
  clearTimeout(showSaved._t);
  showSaved._t = setTimeout(() => el.classList.remove("show"), 1400);
}

function load() {
  if (!hasStorage) { select(DEFAULT_MODE); return; }
  try {
    chrome.storage.sync.get({ captureMode: DEFAULT_MODE }, (res) => {
      if (touched) return; // the user already picked; don't overwrite their choice
      select(res && res.captureMode);
    });
  } catch (_) { select(DEFAULT_MODE); }
}

function save(mode) {
  if (!hasStorage) return;
  try {
    chrome.storage.sync.set({ captureMode: mode }, () => {
      if (!chrome.runtime.lastError) showSaved();
    });
  } catch (_) {}
}

function fillVersion() {
  const el = document.getElementById("version");
  if (!el) return;
  try {
    const v = chrome.runtime.getManifest().version;
    el.textContent = "v" + v;
  } catch (_) { el.textContent = ""; }
}

document.addEventListener("DOMContentLoaded", () => {
  for (const r of radios()) {
    r.addEventListener("change", () => { if (r.checked) { touched = true; save(r.value); } });
  }
  load();
  fillVersion();
});
