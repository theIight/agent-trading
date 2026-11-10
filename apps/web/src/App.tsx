import { useEffect, useState } from 'react';
import { subscribeSse } from './api/client.ts';
import { chartRegistry } from './chart/chartRegistry.ts';
import { AnalysisPanel } from './components/AnalysisPanel.tsx';
import { ChartView } from './components/ChartView.tsx';
import { Toolbar } from './components/Toolbar.tsx';
import { useAnalysisStore } from './store/useAnalysisStore.ts';
import { useAppStore } from './store/useAppStore.ts';

export function App() {
  const [status, setStatus] = useState('');
  const theme = useAppStore(s => s.theme);
  const onGlobalEvent = useAnalysisStore(s => s.onGlobalEvent);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Kết quả từ mọi nguồn (kể cả Claude Code tương tác) đẩy về qua SSE chung.
  useEffect(() => subscribeSse('/api/events', onGlobalEvent), [onGlobalEvent]);

  return (
    <div className="app">
      <Toolbar status={status} />
      <main className="main">
        <ChartView onStatus={setStatus} onReady={chartRegistry.set} />
        <AnalysisPanel />
      </main>
    </div>
  );
}
