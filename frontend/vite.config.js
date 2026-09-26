import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "FIREWATCH_");
  const proxy = {
    "/api": {
      target: env.FIREWATCH_API_URL || "http://127.0.0.1:8001",
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api/, ""),
      // Server-side only. Never expose a service bearer token via a VITE_ variable.
      headers: env.FIREWATCH_API_TOKEN
        ? { Authorization: `Bearer ${env.FIREWATCH_API_TOKEN}` }
        : {},
      timeout: 300000,
      proxyTimeout: 300000,
    },
  };
  return { server: { proxy }, preview: { proxy } };
});
