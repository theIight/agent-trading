import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { SnapshotApp } from './components/SnapshotApp.tsx';
import { parseSnapshotParams } from './snapshotMode.ts';
import './styles.css';

// `?snapshot=<id>&tf=<tf>`: chỉ chart kết quả (server chụp gửi Telegram).
const snapshot = parseSnapshotParams(window.location.search);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {snapshot ? <SnapshotApp params={snapshot} /> : <App />}
  </StrictMode>,
);
