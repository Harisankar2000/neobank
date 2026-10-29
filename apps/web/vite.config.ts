import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    // In development the API runs separately; the proxy avoids CORS entirely.
    proxy: { '/api': 'http://localhost:3100', '/docs': 'http://localhost:3100' },
  },
});
