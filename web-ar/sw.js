/*
 * Minimal service worker for the Arabic Supertonic web app.
 *
 * Its only job is to make the page installable as a PWA on Android. We avoid
 * caching the (very large) ONNX model files here so users always get the
 * canonical assets from the network; once they're cached by the browser's
 * HTTP cache, subsequent loads will still be fast.
 */

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
    // No-op: fall through to the network. The presence of a fetch handler
    // is enough for the browser to consider the app installable.
});
