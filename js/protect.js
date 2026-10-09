// Deterrents only: they stop casual saving (right-click, dragging, the usual inspect/save shortcuts).
// Anything a browser displays can still be captured by someone determined, so keep full-resolution originals off the site.
(() => {
  const editable = t => t instanceof Element && t.closest('input,textarea,select,[contenteditable]');
  addEventListener('contextmenu', e => { if (!editable(e.target)) e.preventDefault(); });
  addEventListener('dragstart', e => { if (e.target instanceof Element && e.target.closest('img,canvas,video')) e.preventDefault(); });
  addEventListener('keydown', e => {
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (k === 'f12'
      || (mod && e.shiftKey && /^[ijc]$/.test(k))   // devtools / inspect element
      || (mod && /^[us]$/.test(k))                  // view source / save page
      || (e.metaKey && e.altKey && /^[iujc]$/.test(k))) e.preventDefault(); // macOS devtools / view source
  });
})();
