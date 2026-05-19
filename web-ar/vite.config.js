import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootAssetsDir = path.resolve(__dirname, '../assets');

function serveRootAssets() {
  return {
    name: 'serve-root-assets',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        const urlPath = decodeURIComponent((req.url || '').split('?')[0]);
        const filePath = path.resolve(rootAssetsDir, `.${urlPath}`);

        if (!filePath.startsWith(rootAssetsDir) || !existsSync(filePath)) {
          next();
          return;
        }

        const stat = statSync(filePath);
        if (!stat.isFile()) {
          next();
          return;
        }

        createReadStream(filePath).pipe(res);
      });
    }
  };
}

export default defineConfig({
  plugins: [serveRootAssets()],
  server: {
    port: 3001,
    host: '0.0.0.0',
    open: false
  },
  preview: {
    port: 4173,
    host: '0.0.0.0',
    allowedHosts: true
  },
  build: {
    target: 'esnext'
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web']
  }
});
