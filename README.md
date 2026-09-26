<p align="center">
  <img src="icons/icon-128.png" alt="FullPageShot" width="96" height="96">
</p>

# FullPageShot

One-keypress **full-page screenshots of your current Chrome tab** — a self-hosted
Manifest V3 extension built on the Chrome DevTools Protocol (`chrome.debugger`).
No third-party extension code, no analytics, no remote executable code, no screenshot
uploads: the whole program is a handful of files you can read end-to-end.

Captures the **live tab** you're looking at — logged-in session, current DOM,
dynamic content — as a single full-height PNG, triggered by a keyboard shortcut
**or** the toolbar button.

## Why this exists

Chrome has no native single-hotkey or toolbar button for a full-page (scrolling)
screenshot — only the multi-step DevTools "Capture full size screenshot" command.
Third-party extensions add a button but require broad, opaque, auto-updating access
to every page you visit. This extension gives you the button and the hotkey while
keeping the trust boundary at ~two files you can read end-to-end.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode** (top-right).
2. Click **Load unpacked** and select this folder.
3. The shortcut suggests **⌘⇧Y** (macOS) / **Ctrl+Shift+Y**. Confirm or rebind at
   `chrome://extensions/shortcuts`.
4. Optional: pin the toolbar icon — clicking it does the same as the hotkey.

Capture any page → the PNG lands in your Downloads folder with a name built from the
site, page, date, and time (e.g. `swissnex.org-sanfrancisco-2026-09-23-1435.png`;
Chrome adds ` (2)` for same-minute repeats). You can change where captures are saved
in [Settings](#settings). A badge flashes `…` while working, then `✓`
(`⚠` if the page was downscaled or something timed out, `busy` if a capture is
already running).

## Keyboard shortcut

Default: **`Ctrl+Shift+Y`** (Windows / Linux) or **`⌘⇧Y` / `Command+Shift+Y`** (macOS).

FullPageShot *suggests* this shortcut, but Chrome only auto-assigns a suggested shortcut
when the combination is free, so it may start out unset. To set or change it:

1. Open `chrome://extensions/shortcuts`.
2. Find **FullPageShot**, the row **"Capture the full page"**.
3. Click the field and press your combination (`⌘⇧Y` on macOS, `Ctrl+Shift+Y` on
   Windows/Linux, or any combo you prefer).

If the shortcut doesn't work, another extension most likely already uses that combination,
so Chrome left FullPageShot's unset. On a fresh install FullPageShot detects this and opens its
Settings, which show the current shortcut (or **Not set**) and a button that takes you straight
to `chrome://extensions/shortcuts`.

The toolbar button does the same thing, so the extension works even with no shortcut set.

## Settings

Open the settings from `chrome://extensions` (the extension's **Details** page, then
**Extension options**) or by right-clicking the toolbar icon and choosing **Options**.

**Capture mode:**

- **Faithful (default)** — captures the page the way it looks. Carousels and sliders stay
  on the slide that is showing, so the image matches what you see on screen.
- **Everything** — expands large carousels and sliders so more of their off-screen items are
  laid out in the image. Good for archiving as much of a page's content as possible in one
  capture, even though it looks wider than the live page.

**Save location:**

- **Downloads folder (default)** — save straight to Downloads with an automatic name.
- **Downloads subfolder** — always save into a subfolder of Downloads (for example,
  `Screenshots` → `Downloads/Screenshots`), no prompt. The path is relative to Downloads and
  cannot point outside it.
- **Ask every time** — show the Save As dialog on each capture so you choose the folder and name.

**After capture:**

- **Copy file path to clipboard** — after saving, put the screenshot's full file path on the
  clipboard, so you can paste it into a terminal, an editor, or a coding agent. Off by default.

All settings are stored with `chrome.storage.sync` (local to your Chrome profile; never sent
anywhere).

## How it works

Over a short-lived `chrome.debugger` (CDP) session on the active tab, in an
**isolated JavaScript world** (its globals are separate; DOM changes remain visible
to the page):

1. **Promote lazy media** — copy `data-src`/`data-srcset` → `src`/`srcset` so images
   load without needing to be scrolled into view (reaches carousel slides too), then
   wait for load + `decode()` + `document.fonts.ready`.
2. **Un-clip page-level scroll containers** — release body-scroll and inner-scroll
   layouts (an `html`/`body` or full-height app-shell `<div>` with its own scrollbar)
   so their content flows into the document and the true full height can be captured.
   In **Faithful** mode (default) only genuinely vertical scrollers are released, so
   horizontal carousels stay on their current slide; **Everything** mode also releases
   horizontal scrollers so their slides fan out (see [Settings](#settings)).
3. **Settle** — wait until the page height stops growing, so async/late-loading
   sections are included.
4. **Reveal scroll-triggered content** — inject a removable `img{opacity:1!important}`
   override and `finish()` any running reveal animations, so below-the-fold fade-ins
   aren't captured mid-animation at `opacity:0`.
5. **Hide off-screen overlays** — `position:fixed` elements parked entirely outside the
   viewport (search popins, drawers) are temporarily `visibility:hidden` so they aren't
   painted mid-canvas. Sticky elements and visible headers / cookie bars are left alone.
6. **Capture** at native Retina resolution via `Page.captureScreenshot` with
   `captureBeyondViewport` (no position mutation). Very tall pages downscale to fit one
   complete PNG.
7. **Restore** recorded attributes, styles, and document scroll position on a
   best-effort basis, then detach. A watchdog attempts cleanup after an interruption;
   page scripts, animations, and resource loads may have lasting effects.

## Permissions & security

- `debugger` — required to drive CDP and capture beyond the viewport. Powerful, but
  the code exercising it is **yours**: no analytics, no remote executable code, no
  screenshot uploads. (Preparing a capture can load images and other resources the
  page itself requests.) Keep this folder somewhere only you can write.
- `downloads` — to save the PNG.
- `storage` — to remember your settings (see [Settings](#settings)). Local to your Chrome
  profile; nothing is sent anywhere.
- `offscreen` + `clipboardWrite` — only used, and only when you enable **Copy file path to
  clipboard**, to write the saved file's path to the clipboard from a hidden document (a
  service worker has no clipboard of its own).

All three (`storage`, `offscreen`, `clipboardWrite`) show no install warning. Still **no host
permissions, no network, no remote code**. The `chrome.debugger` API shows a brief "started
debugging this browser" banner during each capture; it auto-dismisses on detach.

## Known limitations

Full-page capture that renders the DOM (this extension, and Chrome's own DevTools
command) has inherent limits on some page types:

- **Virtualized / infinite-scroll feeds** (e.g. image-search feeds) — content that
  only exists in the DOM while scrolled can't be captured whole by any tool.
- **Editor/preview shells** — viewport-height editors may populate content only after
  interaction; capture the published page instead.
- **Cross-origin iframes** — lazy content inside them isn't reached (same-origin
  frames and open shadow roots could be added later).

Inner-scroll web-apps and body-scroll layouts — where a `<div>` or the body scrolls
instead of the document — are handled as of v2.1 by the un-clip step. JS lazy-loaders
and horizontal carousels are handled as of v2.

## Status

**v2.4.0** (current). Expands the **Settings** page: a **save location** (Downloads, a
Downloads subfolder, or Ask every time), an optional **copy file path to clipboard**, and
smarter automatic file names (site + page + date + time). v2.3.0 added the **capture mode**
(Faithful by default, or Everything), so horizontal carousels stay on their live slide unless
you opt in to fanning them out. v2.2.1 hardened capture cancellation and page-restore. v2.1 added scroll-container
un-clipping that fixes "viewport-only" captures on body-scroll / inner-scroll pages, plus a
settle step, with overlay-hiding narrowed to `position:fixed`. Verified on public websites and
authenticated web apps.

## License

GPL-3.0-or-later. Copyright (C) 2026 Reimagined Multimedia KLG. See [`LICENSE`](LICENSE).

If you build on this, your version stays open too, that's the point.

## Made by

[re:imagined agency](https://reimagined.agency): privacy-first tools, Swiss-made.
