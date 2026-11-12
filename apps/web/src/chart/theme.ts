export type ThemeName = 'dark' | 'light';

export interface ChartTheme {
  background: string;
  text: string;
  grid: string;
  border: string;
  up: string;
  down: string;
  upVolume: string;
  downVolume: string;
  /** Màu đặc (đã trộn với nền) của cột volume khi bật volume gộp: cột spot vẽ phía sau không được lộ qua. */
  upVolumeSolid: string;
  downVolumeSolid: string;
  crosshair: string;
}

// Bảng màu gần giống TradingView.
export const THEMES: Record<ThemeName, ChartTheme> = {
  dark: {
    background: '#131722',
    text: '#d1d4dc',
    grid: '#1e222d',
    border: '#2a2e39',
    up: '#26a69a',
    down: '#ef5350',
    upVolume: 'rgba(38,166,154,0.45)',
    downVolume: 'rgba(239,83,80,0.45)',
    upVolumeSolid: 'rgb(28,87,88)',
    downVolumeSolid: 'rgb(118,50,55)',
    crosshair: '#758696',
  },
  light: {
    background: '#ffffff',
    text: '#131722',
    grid: '#f0f3fa',
    border: '#e0e3eb',
    up: '#089981',
    down: '#f23645',
    upVolume: 'rgba(8,153,129,0.4)',
    downVolume: 'rgba(242,54,69,0.4)',
    upVolumeSolid: 'rgb(156,214,205)',
    downVolumeSolid: 'rgb(250,175,181)',
    crosshair: '#9598a1',
  },
};
