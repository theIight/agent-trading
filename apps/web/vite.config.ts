import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': apiTarget },
  },
  // Dùng khi chạy bằng pm2 (`vite preview` phục vụ bản build): giữ cổng 5173 và proxy như dev.
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': apiTarget },
  },
});
