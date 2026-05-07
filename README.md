# gpc-firebase-sync

Reusable Firebase Firestore + Storage sync layer for editor projects.

## Usage

```html
<script type="module" src="./lib/firebase-sync/firebase-sync.js"></script>
<script src="./lib/firebase-sync/firebase-status-pill.js" defer></script>
```

```js
await window.GPC_FIREBASE_READY;
window.GPC_FIREBASE.pushState('my_key', { value: 42 });
const v = await window.GPC_FIREBASE.pullState('my_key');
window.GPC_FIREBASE.watchState('my_key', val => console.log('changed', val));
```

Set namespace via `window.GPC_FIREBASE_NAMESPACE = 'my-project'` before loading.
