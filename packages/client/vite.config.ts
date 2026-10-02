import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  define: {
    __MASTER_URL__: JSON.stringify(process.env.MASTER_URL ?? ''),
    __NODE_URL__: JSON.stringify(process.env.NODE_URL ?? 'http://localhost:7770'),
  },
});
