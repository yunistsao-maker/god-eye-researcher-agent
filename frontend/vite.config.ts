/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

// Live mode against the gateways from `npm run dev`:
//   VITE_AGENTS_GW_ORIGIN=https://<agents-gateway-host>  -> proxies /research/*
//   VITE_TOOLS_GW_ORIGIN=https://<tools-gateway-host>    -> proxies /mcp
// Leave config.json's agentsBaseUrl empty and toolsMcpUrl "/mcp" so the browser calls the dev server.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  const proxy: Record<string, ProxyOptions> = {};
  if (env.VITE_AGENTS_GW_ORIGIN) proxy['/research'] = { target: env.VITE_AGENTS_GW_ORIGIN, changeOrigin: true, secure: true };
  if (env.VITE_TOOLS_GW_ORIGIN) proxy['/mcp'] = { target: env.VITE_TOOLS_GW_ORIGIN, changeOrigin: true, secure: true };

  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
    build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
