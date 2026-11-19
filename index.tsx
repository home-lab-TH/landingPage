import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './src/App.tsx';
import './src/styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable app: register the network-first service worker (never caches /api). Silent on failure.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
