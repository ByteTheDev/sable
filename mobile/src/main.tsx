import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { conn } from './lib/conn';
import { applyEvent, getState, setState } from './lib/store';
import { nav } from './lib/nav';
import './styles.css';

// For checks over DevTools (web builds made with VITE_SABLE_DEBUG=1 only).
if (import.meta.env.VITE_SABLE_DEBUG) (window as unknown as { sable: unknown }).sable = { getState, setState, applyEvent, conn, nav };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
