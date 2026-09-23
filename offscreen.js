// FullPageShot — offscreen clipboard helper.
// The service worker has no DOM or clipboard access, so it asks this hidden document to copy
// text (the saved screenshot's file path). Uses a textarea + execCommand("copy"), which works
// from an offscreen document without requiring focus or a user gesture.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "fps-copy-text" || msg.target !== "offscreen") return; // not ours
  let ok = false, error = "";
  try {
    const ta = document.getElementById("sink");
    ta.value = typeof msg.text === "string" ? msg.text : "";
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    ok = document.execCommand("copy");
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }
  try { const ta = document.getElementById("sink"); ta.value = ""; } catch (_) {}
  sendResponse({ ok: !!ok, error });
  return true;
});
