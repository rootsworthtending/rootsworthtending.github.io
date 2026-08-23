(function () {
  var dlg = document.getElementById('leaving');
  if (!dlg) return;
  var box = dlg.querySelector('.leaving-box');
  var hostEl = dlg.querySelector('[data-leaving-host]');
  var urlEl = dlg.querySelector('[data-leaving-url]');
  var goEl = dlg.querySelector('[data-leaving-go]');
  var copyEl = dlg.querySelector('[data-leaving-copy]');
  var copied = dlg.querySelector('.leaving-copied');
  var lastFocus = null, currentUrl = '';

  function hostOf(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return u; } }

  function open(url, trigger) {
    currentUrl = url;
    lastFocus = trigger || document.activeElement;
    var host = hostOf(url);
    hostEl.textContent = host;
    urlEl.textContent = url;
    goEl.href = url;
    goEl.textContent = 'Continue to ' + host;
    copied.textContent = '';
    dlg.hidden = false;
    document.body.style.overflow = 'hidden';
    goEl.focus();
    document.addEventListener('keydown', onKey, true);
  }
  function close() {
    dlg.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey, true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      var f = box.querySelectorAll('a[href], button:not([disabled])');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function selectUrl() {
    var r = document.createRange(); r.selectNodeContents(urlEl);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('.verify a[href^="http"]') : null;
    if (!a) return;
    if (a.host === location.host) return;
    e.preventDefault();
    open(a.href, a);
  });
  goEl.addEventListener('click', function () { setTimeout(close, 0); });
  copyEl.addEventListener('click', function () {
    var ok = function () { copied.textContent = 'Link copied.'; };
    var no = function () { copied.textContent = 'Press Ctrl+C to copy the highlighted link.'; selectUrl(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(currentUrl).then(ok, no);
    else no();
  });
  dlg.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) { e.preventDefault(); close(); }
  });
})();
