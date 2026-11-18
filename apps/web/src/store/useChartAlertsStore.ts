import { create } from 'zustand';
import type { ChartAlert } from '@wca/shared';
import { createChartAlert, deleteChartAlert, fetchChartAlerts } from '../api/client.ts';
import { playAlertSound } from '../chart/sound.ts';

interface ChartAlertsState {
  currentSymbol: string | null;
  alerts: ChartAlert[];
  loading: boolean;
  error: string | null;
  dialogPrice: number | null;
  toast: { text: string; error?: boolean } | null;

  setToast: (toast: { text: string; error?: boolean } | null) => void;
  openDialog: (price: number) => void;
  closeDialog: () => void;
  loadAlerts: (symbol: string) => Promise<void>;
  addAlert: (data: {
    symbol: string;
    price: number;
    type: 'once' | 'every';
    color: string;
    opacity: number;
    note?: string;
  }) => Promise<ChartAlert>;
  removeAlert: (id: string) => Promise<void>;
  onTriggered: (alert: ChartAlert, triggerPrice: number) => void;
}

export const useChartAlertsStore = create<ChartAlertsState>((set, get) => ({
  currentSymbol: null,
  alerts: [],
  loading: false,
  error: null,
  dialogPrice: null,
  toast: null,

  setToast: toast => set({ toast }),
  openDialog: price => set({ dialogPrice: price }),
  closeDialog: () => set({ dialogPrice: null }),

  loadAlerts: async (symbol: string) => {
    set({ currentSymbol: symbol, loading: true, error: null });
    try {
      const alerts = await fetchChartAlerts(symbol);
      if (get().currentSymbol === symbol) {
        set({ alerts, loading: false });
      }
    } catch (err) {
      if (get().currentSymbol === symbol) {
        set({ error: (err as Error).message, loading: false });
      }
    }
  },

  addAlert: async data => {
    const alert = await createChartAlert(data);
    if (get().currentSymbol === data.symbol.toUpperCase()) {
      set(s => ({
        alerts: [alert, ...s.alerts.filter(a => a.id !== alert.id)],
      }));
    }
    return alert;
  },

  removeAlert: async (id: string) => {
    await deleteChartAlert(id);
    set(s => ({
      alerts: s.alerts.filter(a => a.id !== id),
    }));
  },

  onTriggered: (alert: ChartAlert, triggerPrice: number) => {
    playAlertSound();
    const typeLabel = alert.type === 'once' ? 'Chỉ 1 lần' : 'Mỗi lần';
    set({
      toast: {
        text: `🔔 Alert ${alert.symbol}: Giá đã chạm ${alert.price} (${typeLabel}, giá khớp: ${triggerPrice})`,
      },
    });

    if (alert.type === 'once') {
      // Bỏ alert 'once' khỏi danh sách active trên chart
      set(s => ({
        alerts: s.alerts.filter(a => a.id !== alert.id),
      }));
    } else {
      // Cập nhật alert 'every'
      set(s => ({
        alerts: s.alerts.map(a => (a.id === alert.id ? alert : a)),
      }));
    }
  },
}));
