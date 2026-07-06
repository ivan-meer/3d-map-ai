import path from 'path';
import { defineConfig, loadEnv } from 'vite';


export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const geminiApiKey = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || '';
    const googleMapsPlatformKey = process.env.GOOGLE_MAPS_PLATFORM_KEY || env.GOOGLE_MAPS_PLATFORM_KEY || '';
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        proxy: {
          '/api/proxy': {
            target: 'https://generativelanguage.googleapis.com',
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api\/proxy/, ''),
            configure: (proxy) => {
              proxy.on('proxyReq', (proxyReq) => {
                const apiKey = process.env.GEMINI_API_KEY || geminiApiKey || '';
                proxyReq.setHeader('x-goog-api-key', apiKey);
                try {
                  const url = new URL(proxyReq.path, 'https://generativelanguage.googleapis.com');
                  url.searchParams.set('key', apiKey);
                  proxyReq.path = url.pathname + url.search;
                } catch (e) {
                  console.error('Proxy url rewrite error:', e);
                }
              });
            },
          },
        },
      },
      plugins: [],
      define: {
        'process.env.API_KEY': JSON.stringify(geminiApiKey),
        'process.env.GEMINI_API_KEY': JSON.stringify(geminiApiKey),
        'process.env.GOOGLE_MAPS_PLATFORM_KEY': JSON.stringify(googleMapsPlatformKey)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
