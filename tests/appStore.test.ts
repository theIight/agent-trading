import { describe, expect, it } from 'vitest';
import { useAppStore } from '../apps/web/src/store/useAppStore.ts';

describe('useAppStore panelOpen', () => {
  it('hỗ trợ togglePanel và setPanelOpen', () => {
    // Đặt trạng thái ban đầu là true
    useAppStore.getState().setPanelOpen(true);
    expect(useAppStore.getState().panelOpen).toBe(true);

    // Toggle sang false
    useAppStore.getState().togglePanel();
    expect(useAppStore.getState().panelOpen).toBe(false);

    // Toggle lại sang true
    useAppStore.getState().togglePanel();
    expect(useAppStore.getState().panelOpen).toBe(true);

    // setPanelOpen trực tiếp
    useAppStore.getState().setPanelOpen(false);
    expect(useAppStore.getState().panelOpen).toBe(false);

    // Khôi phục mặc định
    useAppStore.getState().setPanelOpen(true);
  });
});
