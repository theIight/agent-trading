import type { AnalysisSubmissionInput } from './analysis.ts';

/**
 * Bản nộp MẪU (định dạng) cho agent không thấy được JSON schema của tool (vd agy/Gemini nạp schema lười).
 * Mọi giá trị chỉ minh hoạ — agent phải thay bằng dữ liệu thật từ get_klines / get_features.
 * Test đảm bảo mẫu luôn hợp lệ với `analysisSubmissionSchema`.
 */
export const SUBMISSION_EXAMPLE: AnalysisSubmissionInput = {
  symbol: 'BTCUSDT',
  primaryTf: '4h',
  schematic: 'DISTRIBUTION',
  currentPhase: 'D',
  bias: 'BEARISH',
  confidence: 0.65,
  summary:
    '1D đang Phase B của phân phối sau BC; 4H đã có UTAD rồi SOW phá Ice với volume lớn, nhịp hồi LPSY volume cạn. 5m xác nhận cung chiếm ưu thế. Ưu tiên short khi hồi về Ice.',
  topDown: [
    { tf: '1d', role: 'HTF', bias: 'BEARISH', phase: 'B', schematic: 'DISTRIBUTION', note: 'BC + AR xác định range, ST in B volume giảm, chưa phá đáy range.' },
    { tf: '4h', role: 'PRIMARY', bias: 'BEARISH', phase: 'D', schematic: 'DISTRIBUTION', note: 'UTAD quét đỉnh rồi SOW đóng cửa dưới Ice, LPSY hồi yếu.' },
    { tf: '5m', role: 'LTF', bias: 'BEARISH', phase: null, schematic: 'UNCLEAR', note: 'Cấu trúc LH/LL, nhịp hồi volume thấp, xác nhận cung.' },
  ],
  events: [
    { type: 'BC', tf: '1d', time: 1789948800, price: 87385.1, confidence: 0.7, note: 'Volume 2.1× trung bình, spread rộng, đóng cửa rời đỉnh.' },
    { type: 'UTAD', tf: '4h', time: 1790164800, price: 82100, confidence: 0.6, note: 'Quét đỉnh range rồi đóng cửa lại trong range.' },
    { type: 'SOW', tf: '4h', time: 1790222400, price: 75200, confidence: 0.6, note: 'Phá Ice với spread rộng, volume tăng.' },
  ],
  ranges: [{ tf: '4h', start: 1789430400, end: 1790222400, top: 82100, bottom: 75160, label: 'TR phân phối 4H', creek: 80800, ice: 75160 }],
  phases: [{ tf: '4h', phase: 'D', start: 1790164800, end: 1790222400 }],
  levels: [
    { kind: 'ICE', price: 75160, tf: '4h', note: 'Đáy range đã bị phá' },
    { kind: 'INVALIDATION', price: 76450, tf: '4h', note: 'Đóng cửa trên mức này thì kịch bản giảm sai' },
  ],
  scenarios: [
    {
      name: 'Markdown sau LPSY',
      probability: 0.65,
      bias: 'BEARISH',
      path: [{ time: 1790222400, price: 74000 }, { time: 1790280000, price: 75100 }, { time: 1790424000, price: 71000 }],
      trigger: 'LPSY volume thấp tại Ice',
      invalidation: 76450,
      note: 'Mục tiêu theo nguyên nhân – kết quả của range.',
    },
    {
      name: 'Hồi lại vào range',
      probability: 0.35,
      bias: 'BULLISH',
      path: [{ time: 1790222400, price: 74000 }, { time: 1790352000, price: 78000 }],
      trigger: 'Đóng cửa 4H trên 76.5k',
      invalidation: 73300,
      note: '',
    },
  ],
  tradePlan: {
    decision: 'WAIT_FOR_SETUP',
    reason: 'Giá sát đáy climax, không đuổi short; chờ hồi về Ice để short LPSY.',
    reconsiderWhen: '',
    setups: [
      {
        name: 'Short LPSY retest Ice',
        direction: 'SHORT',
        entryType: 'LIMIT',
        tf: '5m',
        trigger: 'LPSY',
        triggerNote: 'Nến hồi vào vùng với volume thấp, spread hẹp, đóng cửa nửa dưới.',
        entryLow: 74800,
        entryHigh: 75300,
        stopLoss: 75850,
        takeProfits: [73350, 72000, 70500],
        validUntil: 1790424000,
        scenario: 'Markdown sau LPSY',
        confidence: 0.6,
        rationale: 'Ice bị phá với volume lớn; retest từ dưới với cung cạn là LPSY.',
        refinedEntry: {
          tf: '1m',
          trigger: 'CHOCH',
          condition: 'UT 1m trong vùng entry rồi CHoCH xuống, volume giảm.',
          stopRule: 'Trên đỉnh UT 1m + 0.3 ATR(1m)',
          estStopDistance: 150,
        },
      },
    ],
  },
  tfConflicts: [],
};
