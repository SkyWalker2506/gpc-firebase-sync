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
    '#gpc-fb-sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }',
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

  function _doMount(gpcFb) {
    // Guard: if pill already mounted, skip.
    if (document.getElementById('gpc-fb-pill')) return;
    _injectStyle();
    var pill = _createPill();

    // Prefer the rendered .es-topbar (inserted by EditorShell.mount()) so we
    // survive the host.innerHTML='' wipe that EditorShell does. Fall back to
    // #editor-shell-topbar or a fixed overlay.
    var target = document.querySelector('.es-topbar') ||
                 document.getElementById('editor-shell-topbar') ||
                 document.querySelector('.shell-topbar');
    if (target) {
      target.appendChild(pill);
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
    var btn = document.getElementById('gpc-fb-sync-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        if (!gpcFb.syncNow) return;
        btn.disabled = true;
        gpcFb.syncNow().finally(function () {
          btn.disabled = false;
        });
      });
    }
  }

  function _mountPill(gpcFb) {
    // If .es-topbar already exists (EditorShell already mounted), insert now.
    if (document.querySelector('.es-topbar')) {
      _doMount(gpcFb);
      return;
    }
    // Otherwise watch for EditorShell to call mount() which creates .es-topbar.
    // MutationObserver fires synchronously after appendChild, before next paint.
    var obs = new MutationObserver(function () {
      if (document.querySelector('.es-topbar') && !document.getElementById('gpc-fb-pill')) {
        _doMount(gpcFb);
        // Keep observing in case EditorShell re-mounts (remount clears innerHTML)
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // Fallback: if .es-topbar never appears within 15s, attach as overlay
    setTimeout(function () {
      if (!document.getElementById('gpc-fb-pill')) {
        obs.disconnect();
        _doMount(gpcFb);
      }
    }, 15000);
  }

  function _init() {
    var ready = window.GPC_FIREBASE_READY;
    if (!ready) {
      // firebase-sync.js may still be fetching its CDN dependencies (type=module
      // can resolve after defer scripts). Retry until the promise appears.
      var _retries = 0;
      var _retry = setInterval(function () {
        _retries++;
        if (window.GPC_FIREBASE_READY) {
          clearInterval(_retry);
          _init();
        } else if (_retries > 60) {
          clearInterval(_retry);
          console.warn('[GPC_FB_PILL] GPC_FIREBASE_READY never resolved');
        }
      }, 200);
      return;
    }
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
