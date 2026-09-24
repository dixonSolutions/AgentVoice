// AgentVoice site: install tabs and copy buttons. The page works without it:
// with JS off the install methods are stacked sections and there are no copy buttons.
(function () {
  'use strict';

  // Tabs (WAI-ARIA tabs pattern, manual activation with arrow-key roving focus).
  document.querySelectorAll('[data-tabs]').forEach(function (root) {
    var panels = Array.prototype.slice.call(root.querySelectorAll(':scope > .tab-panel'));
    if (panels.length < 2) return;
    var list = document.createElement('div');
    list.className = 'tablist';
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Install method');
    var tabs = panels.map(function (panel, i) {
      var title = panel.querySelector('.tab-title');
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.id = panel.id + '-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panel.id);
      tab.textContent = title ? title.childNodes[0].textContent.trim() : 'Tab ' + (i + 1);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.tabIndex = 0;
      list.appendChild(tab);
      return tab;
    });

    function select(index, focus) {
      tabs.forEach(function (tab, i) {
        var on = i === index;
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
        panels[i].hidden = !on;
      });
      if (focus) tabs[index].focus();
    }

    list.addEventListener('click', function (e) {
      var i = tabs.indexOf(e.target.closest('[role="tab"]'));
      if (i >= 0) {
        select(i, false);
        if (history.replaceState) history.replaceState(null, '', '#' + panels[i].id);
      }
    });
    list.addEventListener('keydown', function (e) {
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next !== null) { e.preventDefault(); select(next, true); }
    });

    root.insertBefore(list, panels[0]);
    root.classList.add('is-enhanced');

    function fromHash() {
      var i = panels.findIndex(function (p) { return '#' + p.id === location.hash; });
      if (i >= 0) select(i, false);
      return i;
    }
    if (fromHash() < 0) {
      var ua = navigator.userAgent || '';
      // Only a hint: default to npm, but open apt/dnf for Linux distros that say so.
      var guess = /Fedora|Red Hat/i.test(ua) ? 2 : /Ubuntu|Debian/i.test(ua) ? 1 : 0;
      select(guess, false);
    }
    window.addEventListener('hashchange', fromHash);
  });

  // Copy-to-clipboard buttons on every code block.
  if (!navigator.clipboard || !window.isSecureContext) return;
  document.querySelectorAll('.code').forEach(function (block) {
    var code = block.querySelector('code');
    if (!code) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy command to clipboard');
    var status = document.createElement('span');
    status.className = 'visually-hidden';
    status.setAttribute('role', 'status');
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(code.textContent.replace(/\s+$/, '')).then(function () {
        btn.textContent = 'Copied';
        btn.dataset.state = 'done';
        status.textContent = 'Copied to clipboard';
        setTimeout(function () {
          btn.textContent = 'Copy';
          delete btn.dataset.state;
          status.textContent = '';
        }, 1800);
      }, function () {
        btn.textContent = 'Press Ctrl+C';
      });
    });
    block.classList.add('has-copy');
    block.appendChild(btn);
    block.appendChild(status);
  });
})();
