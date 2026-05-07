// Golf Paper Craft — Firebase Sync
// ES module. Exposes window.GPC_FIREBASE for cross-device/cross-tab sync of
// the four editor localStorage keys. localStorage is always the primary read
// source; Firestore is the sync backend. On first load, any local data that
// doesn't exist in Firestore yet is migrated automatically.
//
// Usage (in HTML): <script type="module" src="./lib/firebase-sync/firebase-sync.js?v=1"></script>
// Then in any other script: await window.GPC_FIREBASE_READY  (Promise)
//                            window.GPC_FIREBASE.pullState(key)
//                            window.GPC_FIREBASE.pushState(key, value)
//                            window.GPC_FIREBASE.watchState(key, callback)

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCmyZzmRd1XhSxz_bArNcGHiJPTMCrtfwM',
  authDomain: 'vocab-418e1.firebaseapp.com',
  projectId: 'vocab-418e1',
  storageBucket: 'vocab-418e1.firebasestorage.app',
  messagingSenderId: '387847607962',
  appId: '1:387847607962:web:95f7ec61d9cf14f07c7123',
};

const COLLECTION = 'golf-paper-craft';
// Timestamp mirror key prefix — stores updatedAt of the last known Firestore
// value so we can skip stale echoes from watchState.
const TS_PREFIX = 'gpc_fb_ts_';

const app = initializeApp(firebaseConfig, 'gpc-sync');
const db = getFirestore(app);

// ── Status ────────────────────────────────────────────────────────────────
const _statusListeners = [];
const syncStatus = {
  state: navigator.onLine ? 'online' : 'offline',
  pendingKeys: new Set(),
};
function _setStatus(state) {
  if (syncStatus.state === state) return;
  syncStatus.state = state;
  _statusListeners.forEach((fn) => { try { fn(syncStatus); } catch (_) {} });
}
window.addEventListener('online', () => {
  if (syncStatus.pendingKeys.size === 0) _setStatus('online');
});
window.addEventListener('offline', () => _setStatus('offline'));

// ── Helpers ───────────────────────────────────────────────────────────────
function _localTs(key) {
  return Number(localStorage.getItem(TS_PREFIX + key) || 0);
}
function _storeLocalTs(key, ts) {
  localStorage.setItem(TS_PREFIX + key, String(ts));
}
function _localValue(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
}
function _docRef(key) {
  return doc(db, COLLECTION, key);
}

// ── Core API ──────────────────────────────────────────────────────────────

/**
 * Pull value. Firestore wins if its updatedAt is newer than our local mirror
 * timestamp, otherwise local wins. Falls back to local on any network error.
 */
async function pullState(key) {
  try {
    const snap = await getDoc(_docRef(key));
    if (snap.exists()) {
      const { value, updatedAt } = snap.data();
      const localTs = _localTs(key);
      if (updatedAt > localTs) {
        // Firestore is newer — mirror to local using original setItem to avoid
        // re-triggering the interceptor.
        const orig = _origSetItem || localStorage.setItem.bind(localStorage);
        orig(key, JSON.stringify(value));
        _storeLocalTs(key, updatedAt);
        return value;
      }
    }
  } catch (e) {
    console.warn('[GPC_FIREBASE] pullState failed for', key, e);
  }
  return _localValue(key);
}

/**
 * Push value to both Firestore and localStorage.
 * Uses setDoc with merge:true so partial keys aren't wiped.
 */
async function pushState(key, value) {
  const updatedAt = Date.now();
  // Write local immediately (optimistic) using original setItem to avoid
  // recursive intercept.
  const orig = _origSetItem || localStorage.setItem.bind(localStorage);
  orig(key, JSON.stringify(value));
  _storeLocalTs(key, updatedAt);
  // Mark pending
  syncStatus.pendingKeys.add(key);
  _setStatus('syncing');
  try {
    await setDoc(_docRef(key), { value, updatedAt }, { merge: true });
    syncStatus.pendingKeys.delete(key);
    if (syncStatus.pendingKeys.size === 0) _setStatus(navigator.onLine ? 'online' : 'offline');
  } catch (e) {
    console.warn('[GPC_FIREBASE] pushState failed (kept local) for', key, e);
    syncStatus.pendingKeys.delete(key);
    if (syncStatus.pendingKeys.size === 0) _setStatus(navigator.onLine ? 'online' : 'offline');
  }
}

/**
 * Subscribe to live Firestore changes for key.
 * callback(value) is called only when the remote updatedAt is strictly
 * newer than our local mirror (avoids echoing our own pushState writes).
 * Returns an unsubscribe function.
 */
function watchState(key, callback) {
  return onSnapshot(_docRef(key), (snap) => {
    if (!snap.exists()) return;
    const { value, updatedAt } = snap.data();
    const localTs = _localTs(key);
    if (updatedAt > localTs) {
      const orig = _origSetItem || localStorage.setItem.bind(localStorage);
      orig(key, JSON.stringify(value));
      _storeLocalTs(key, updatedAt);
      try { callback(value); } catch (e) { console.warn('[GPC_FIREBASE] watchState callback error', e); }
    }
  }, (err) => {
    console.warn('[GPC_FIREBASE] watchState listener error for', key, err);
  });
}

/**
 * One-time migration: if localStorage has data for key and Firestore has no
 * doc yet, push the local value up. Safe to call on every page load.
 */
async function migrateFromLocalStorage(keys) {
  for (const key of keys) {
    const local = _localValue(key);
    if (!local) continue;
    try {
      const snap = await getDoc(_docRef(key));
      if (!snap.exists()) {
        console.log('[GPC_FIREBASE] migrating', key, 'to Firestore');
        await pushState(key, local);
      }
    } catch (e) {
      console.warn('[GPC_FIREBASE] migration failed for', key, e);
    }
  }
}

// ── localStorage interceptor ──────────────────────────────────────────────
// Wraps localStorage.setItem so that writes to any watched key are
// automatically mirrored to Firestore without touching each editor's code.
const _interceptedKeys = new Set();
const _interceptDebounce = {};
let _origSetItem = null;
let _interceptInstalled = false;

function interceptLocalStorage(keys) {
  keys.forEach((k) => _interceptedKeys.add(k));
  if (_interceptInstalled) return;
  _interceptInstalled = true;
  _origSetItem = localStorage.setItem.bind(localStorage);

  Object.defineProperty(localStorage, 'setItem', {
    value: function (key, value) {
      _origSetItem(key, value);
      if (_interceptedKeys.has(key)) {
        // Debounce to coalesce rapid saves (e.g. typing in an editor field)
        clearTimeout(_interceptDebounce[key]);
        _interceptDebounce[key] = setTimeout(() => {
          try {
            const parsed = JSON.parse(value);
            // Push to Firestore (uses _origSetItem internally so no recursion)
            pushState(key, parsed);
          } catch (_) {}
        }, 300);
      }
    },
    writable: true,
    configurable: true,
  });
}

// ── Export ────────────────────────────────────────────────────────────────
const GPC_FIREBASE = {
  pullState,
  pushState,
  watchState,
  syncStatus,
  onStatusChange(fn) { _statusListeners.push(fn); },
  migrateFromLocalStorage,
  interceptLocalStorage,
};
window.GPC_FIREBASE = GPC_FIREBASE;

// Well-known editor keys (gpc_editor_v1 = level designer canvas key)
const GPC_FIREBASE_KEYS = [
  'gpc_editor_v1',
  'gpc_course_overrides',
  'gpc_ui_overrides',
  'gpc_asset_overrides',
];
window.GPC_FIREBASE_KEYS = GPC_FIREBASE_KEYS;

// Resolve the ready promise so callers can `await window.GPC_FIREBASE_READY`
let _resolveReady;
window.GPC_FIREBASE_READY = new Promise((res) => { _resolveReady = res; });

// Install interceptor so all future localStorage.setItem calls on watched keys
// are automatically mirrored to Firestore.
interceptLocalStorage(GPC_FIREBASE_KEYS);

// Start live listeners for all keys. When a remote change arrives, dispatch
// a storage event so editor JS picks it up automatically (same mechanism as
// cross-tab localStorage events, but now works cross-device too).
GPC_FIREBASE_KEYS.forEach((key) => {
  watchState(key, (value) => {
    // value is already mirrored to localStorage inside watchState.
    // Dispatch storage event so in-page consumers (editors) react.
    try {
      window.dispatchEvent(new StorageEvent('storage', {
        key,
        newValue: JSON.stringify(value),
        storageArea: localStorage,
      }));
    } catch (_) {}
  });
});

// Auto-migrate on load, then resolve ready
migrateFromLocalStorage(GPC_FIREBASE_KEYS).finally(() => _resolveReady(GPC_FIREBASE));
