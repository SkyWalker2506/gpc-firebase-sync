// Golf Paper Craft — Firebase Sync Status Pill
// Injects a small status indicator into the editor-shell topbar.
// Depends on window.GPC_FIREBASE_READY being resolved by firebase-sync.js.
// Load as <script defer src="..."> (NOT type=module — must run after DOM + sync module).

(function () {
  'use strict';

  var STYLE = [
    '#gpc-fb-pill {',
    '  display: inline-flex; align-items: center; gap: 5px;',
    '  font-size: 11px; font-family: inherit;',
    '  padding: 3px 8px; border-radius: 10px;',
    '  background: rgba(255,255,255,0.07);',
    '  border: 1px solid rgba(255,255,255,0.12);',
    '  color: #b0bec5; cursor: default; user-select: none;',
    '  transition: background 0.2s, color 0.2s;',
    '  margin-left: 6px; white-space: nowrap;',
    '}',
    '#gpc-fb-pill.synced  { color: #69f0ae; border-color: #69f0ae44; }',
    '#gpc-fb-pill.syncing { color: #ffd740; border-color: #ffd74044; }',
    '#gpc-fb-pill.offline { color: #ff5252; border-color: #ff525244; }',
    '#gpc-fb-pill .fb-dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex-shrink:0; }',
    '#gpc-fb-sync-btn { background:none; border:none; cursor:pointer; font-size:11px; padding:0 2px; color:inherit; line-height:1; }',
  ].join('\n');

  function _injectStyle() {
    var el = document.createElement('style');
    el.textContent = STYLE;
    document.head.appendChild(el);
  }

  function _createPill() {
    var pill = document.createElement('span');
    pill.id = 'gpc-fb-pill';
    pill.innerHTML = '<span class="fb-dot"></span><span class="fb-label">Cloud</span><button id="gpc-fb-sync-btn" title="Sync now">↻</button>';
    return pill;
  }

  function _setState(pill, state) {
    pill.classList.remove('synced', 'syncing', 'offline');
    var label = pill.querySelector('.fb-label');
    if (state === 'online') {
      pill.classList.add('synced');
      label.textContent = 'Synced';
    } else if (state === 'syncing') {
      pill.classList.add('syncing');
      label.textContent = 'Syncing…';
    } else {
      pill.classList.add('offline');
      label.textContent = 'Offline';
    }
  }

  function _mountPill(gpcFb) {
    _injectStyle();
    var pill = _createPill();

    // Append into topbar; fall back to fixed overlay
    var topbar = document.getElementById('editor-shell-topbar') ||
                 document.querySelector('.shell-topbar');
    if (topbar) {
      topbar.appendChild(pill);
    } else {
      pill.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:9999;';
      document.body.appendChild(pill);
    }

    // Initial state
    _setState(pill, gpcFb.syncStatus.state);

    // Subscribe to future changes
    gpcFb.onStatusChange(function (status) {
      _setState(pill, status.state);
    });

    // Manual sync button
    document.getElementById('gpc-fb-sync-btn').addEventListener('click', function () {
      var keys = window.GPC_FIREBASE_KEYS || [];
      keys.reduce(function (p, k) {
        return p.then(function () {
          return gpcFb.pullState(k).then(function (val) {
            if (val !== null) {
              // Dispatch storage event so editors react to pulled values
              try {
                window.dispatchEvent(new StorageEvent('storage', {
                  key: k,
                  newValue: JSON.stringify(val),
                  storageArea: localStorage,
                }));
              } catch (_) {}
            }
          });
        });
      }, Promise.resolve());
    });
  }

  function _init() {
    var ready = window.GPC_FIREBASE_READY;
    if (!ready) return;
    ready.then(function (gpcFb) {
      _mountPill(gpcFb);
    }).catch(function (e) {
      console.warn('[GPC_FB_PILL] init failed', e);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
