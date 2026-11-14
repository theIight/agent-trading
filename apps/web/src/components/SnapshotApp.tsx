import { useEffect, useRef, useState } from 'react';
import { fetchAnalysis } from '../api/client.ts';
import type { ChartController } from '../chart/ChartController.ts';
import { markSnapshot, snapshotRange, type SnapshotParams } from '../snapshotMode.ts';
import { useAnalysisStore } from '../store/useAnalysisStore.ts';
import { useAppStore } from '../store/useAppStore.ts';
import { ChartView } from './ChartView.tsx';

// Trang chỉ có chart + kết quả phân tích (không toolbar / panel), theme tối — để server chụp gửi Telegram.

export function SnapshotApp({ params }: { params: SnapshotParams }) {
  const [symbol, setSymbol] = useState<string | null>(null);
  const ctrlRef = useRef<ChartController | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
    let alive = true;
    fetchAnalysis(params.id)
      .then(rec => {
        if (!alive) return;
        if (!rec.result) throw new Error(`Phân tích chưa có kết quả (${rec.status})`);
        const app = useAppStore.getState();
        if (app.theme !== 'dark') app.toggleTheme();
        app.setSymbol(rec.symbol);
        app.setTf(params.tf);
        const layers = { ...useAnalysisStore.getState().layers };
        for (const k of params.hide) layers[k] = false;
        useAnalysisStore.setState({ layers });
        useAnalysisStore.getState().setCurrent(rec.result);
        setSymbol(rec.symbol);
      })
      .catch((err: Error) => markSnapshot('error', err.message));
    return () => {
      alive = false;
    };
  }, [params]);

  // Sẵn sàng khi chart đã có nến đúng symbol/khung; chờ thêm vài frame cho overlay vẽ xong.
  useEffect(() => {
    if (!symbol) return;
    let done = false;
    const timer = setInterval(() => {
      if (done) return;
      const err = document.querySelector('.chart-error');
      if (err) {
        done = true;
        clearInterval(timer);
        markSnapshot('error', err.textContent ?? 'Lỗi tải dữ liệu');
        return;
      }
      const c = ctrlRef.current;
      if (c && c.getSymbol() === symbol && c.getTimeframe() === params.tf && c.getCandles().length) {
        done = true;
        clearInterval(timer);
        // Bố cục cố định: chart vừa tự cuộn về nến cuối (scrollToRealTime) → đặt lại khung nhìn 120 nến ở 60% trái.
        c.chart.timeScale().setVisibleLogicalRange(snapshotRange(c.getCandles().length - 1));
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => markSnapshot('ready'), 300)));
      }
    }, 100);
    return () => clearInterval(timer);
  }, [symbol, params.tf]);

  return (
    <div className="app snapshot">
      <main className="main">
        {symbol && (
          <ChartView
            snapshot
            onStatus={() => {}}
            onReady={c => {
              ctrlRef.current = c;
            }}
          />
        )}
      </main>
    </div>
  );
}
