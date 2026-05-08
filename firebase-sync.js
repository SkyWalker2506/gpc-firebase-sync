// Golf Paper Craft — Firebase Sync
// ES module. Exposes window.GPC_FIREBASE for cross-device/cross-tab sync of
// the four editor localStorage keys. localStorage is always the primary read
// source; Firestore is the sync backend. On first load, any local data that
// doesn't exist in Firestore yet is migrated automatically.
//
// Usage (in HTML): <script type="module" src="./lib/firebase-sync/firebase-sync.js?v=2"></script>
// Then in any other script: await window.GPC_FIREBASE_READY  (Promise)
//                            window.GPC_FIREBASE.pullState(key)
//                            window.GPC_FIREBASE.pushState(key, value)
//                            window.GPC_FIREBASE.watchState(key, callback)
//                            window.GPC_FIREBASE.syncNow()

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

// Capture original setItem BEFORE any interceptor is installed.
// This guarantees _origSetItem is always valid regardless of call order.
const _origSetItem = localStorage.setItem.bind(localStorage);

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
  _origSetItem(TS_PREFIX + key, String(ts));
}
function _localValue(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
}
function _docRef(key) {
  return doc(db, COLLECTION, key);
}

// ── Echo prevention — track the most-recent ts we pushed per key ──────────
// Using a simple Map<key, lastPushedTs> (no expiry) is more robust than a
// time-expiring Set: Firestore snapshot round-trips can exceed 2s on slow
// connections, causing the old 2s window to expire before the echo arrives.
// We keep the guard alive until a NEWER snapshot (from another tab/device)
// arrives, at which point we clear it so future remote writes aren't blocked.
const _ownPushTs = new Map(); // key -> lastPushedTs (number)
function _markOwnPush(key, ts) {
  _ownPushTs.set(key, ts);
}
function _isOwnEcho(key, ts) {
  const last = _ownPushTs.get(key);
  if (last === undefined) return false;
  if (ts === last) return true;
  // ts > last means a genuinely newer remote write — clear our guard
  if (ts > last) _ownPushTs.delete(key);
  return false;
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
        _origSetItem(key, JSON.stringify(value));
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
  _origSetItem(key, JSON.stringify(value));
  _storeLocalTs(key, updatedAt);
  // Mark this ts as our own so watchState won't echo it back.
  _markOwnPush(key, updatedAt);
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

// ── Sanitizer hooks ───────────────────────────────────────────────────────
// Consumers can register a sanitizer fn(value) -> sanitizedValue per key.
// watchState will apply the sanitizer before writing to localStorage and
// push the clean value back to Firestore if the sanitizer made changes.
const _sanitizers = new Map();
function registerSanitizer(key, fn) {
  _sanitizers.set(key, fn);
}

/**
 * Subscribe to live Firestore changes for key.
 * callback(value) is called only when the remote updatedAt is strictly
 * newer than our local mirror AND is not an echo of our own push.
 * Returns an unsubscribe function.
 */
function watchState(key, callback) {
  return onSnapshot(_docRef(key), (snap) => {
    if (!snap.exists()) return;
    const { value, updatedAt } = snap.data();
    const localTs = _localTs(key);
    if (updatedAt > localTs && !_isOwnEcho(key, updatedAt)) {
      const sanitized = _sanitizers.has(key) ? _sanitizers.get(key)(value) : value;
      _origSetItem(key, JSON.stringify(sanitized));
      _storeLocalTs(key, updatedAt);
      try { callback(sanitized); } catch (e) { console.warn('[GPC_FIREBASE] watchState callback error', e); }
      // If the sanitizer mutated the value, push the clean version back so
      // Firestore doesn't keep serving the stale data to other clients.
      if (sanitized !== value) {
        (async () => { try { await pushState(key, sanitized); } catch (_) {} })();
      }
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

/**
 * Pull all watched keys from Firestore, apply to localStorage, dispatch
 * storage events so in-page editors react. Sets status to syncing/online.
 * Exposed on GPC_FIREBASE so the status pill button can call it.
 */
async function syncNow() {
  const keys = window.GPC_FIREBASE_KEYS || [];
  _setStatus('syncing');
  for (const k of keys) {
    try {
      const val = await pullState(k);
      if (val !== null) {
        try {
          window.dispatchEvent(new StorageEvent('storage', {
            key: k,
            newValue: JSON.stringify(val),
            storageArea: localStorage,
          }));
        } catch (_) {}
      }
    } catch (_) {}
  }
  _setStatus(navigator.onLine ? 'online' : 'offline');
}

// ── localStorage interceptor ──────────────────────────────────────────────
// Wraps localStorage.setItem so that writes to any watched key are
// automatically mirrored to Firestore without touching each editor's code.
const _interceptedKeys = new Set();
const _interceptDebounce = {};
let _interceptInstalled = false;

function interceptLocalStorage(keys) {
  keys.forEach((k) => _interceptedKeys.add(k));
  if (_interceptInstalled) return;
  _interceptInstalled = true;

  Object.defineProperty(localStorage, 'setItem', {
    value: function (key, value) {
      _origSetItem(key, value);
      if (_interceptedKeys.has(key)) {
        // Debounce to coalesce rapid saves (e.g. typing in an editor field)
        clearTimeout(_interceptDebounce[key]);
        _interceptDebounce[key] = setTimeout(() => {
          try {
            const parsed = JSON.parse(value);
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
  syncNow,
  syncStatus,
  onStatusChange(fn) { _statusListeners.push(fn); },
  migrateFromLocalStorage,
  interceptLocalStorage,
  registerSanitizer,
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

// Start live listeners for all keys. Store unsubscribe fns so they can be
// cleaned up on page unload to prevent memory leaks.
const _unsubscribers = GPC_FIREBASE_KEYS.map((key) =>
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
  })
);

// Clean up Firestore listeners on page unload to prevent memory leaks.
window.addEventListener('beforeunload', () => {
  _unsubscribers.forEach((unsub) => { try { unsub(); } catch (_) {} });
});

// Auto-migrate on load, then resolve ready
migrateFromLocalStorage(GPC_FIREBASE_KEYS).finally(() => _resolveReady(GPC_FIREBASE));
