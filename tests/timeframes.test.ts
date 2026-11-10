import { describe, expect, it } from 'vitest';
import { buildTfPlan, sortTopDown } from '@wca/shared';

describe('timeframes', () => {
  it('sắp top-down từ khung lớn đến khung nhỏ', () => {
    expect(sortTopDown(['5m', '1d', '4h', '1w', '1m'])).toEqual(['1w', '1d', '4h', '5m', '1m']);
  });

  it('gán vai trò HTF/PRIMARY/LTF theo khung chính', () => {
    const r = buildTfPlan('4h', ['5m', '1d']);
    expect(r).toEqual({
      ok: true,
      plan: [
        { tf: '1d', role: 'HTF' },
        { tf: '4h', role: 'PRIMARY' },
        { tf: '5m', role: 'LTF' },
      ],
    });
  });

  it('cho phép không có khung phụ', () => {
    expect(buildTfPlan('1h', [])).toEqual({ ok: true, plan: [{ tf: '1h', role: 'PRIMARY' }] });
  });

  it('từ chối khung không hỗ trợ, trùng lặp, quá số lượng', () => {
    expect(buildTfPlan('2h', []).ok).toBe(false);
    expect(buildTfPlan('4h', ['3m']).ok).toBe(false);
    expect(buildTfPlan('4h', ['4h']).ok).toBe(false);
    expect(buildTfPlan('4h', ['1m', '5m', '1d', '1w']).ok).toBe(false);
    expect(buildTfPlan('4h', ['1m', '5m', '1d']).ok).toBe(true);
  });
});
