import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTENT_TYPES_BY_EXTENSION = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
};

export function contentTypeFor(filePath) {
  return CONTENT_TYPES_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function startStaticServer(directory, port = 0, { host = '127.0.0.1', log = false } = {}) {
  const rootDirectory = path.resolve(directory);
  const server = createServer(async (request, response) => {
    const send = (statusCode, body, headers = {}) => {
      response.writeHead(statusCode, { 'Cache-Control': 'no-store', ...headers });
      response.end(request.method === 'HEAD' ? undefined : body);
      if (log) console.log(`${statusCode} ${request.method} ${request.url}`);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, 'Only GET and HEAD are supported', { 'Content-Type': 'text/plain; charset=utf-8' });
    let requestPath;
    try {
      requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      return send(400, 'Bad request path', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (requestPath.endsWith('/')) requestPath += 'index.html';
    const filePath = path.resolve(rootDirectory, `.${requestPath}`);
    if (filePath !== rootDirectory && !filePath.startsWith(rootDirectory + path.sep)) return send(404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    try {
      const fileStatus = await stat(filePath);
      if (!fileStatus.isFile()) return send(404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      const body = await readFile(filePath);
      return send(200, body, { 'Content-Type': contentTypeFor(filePath), 'Content-Length': body.length });
    } catch {
      return send(404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actualPort = server.address().port;
      resolve({
        url: `http://${host}:${actualPort}/`,
        port: actualPort,
        rootDirectory,
        close: () => new Promise((resolveClose) => {
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        }),
      });
    });
  });
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = path.resolve(process.argv[2] || path.join(projectRoot, 'dist'));
  const port = Number(process.argv[3] || 0);
  try {
    const directoryStatus = await stat(directory);
    if (!directoryStatus.isDirectory()) throw new Error('not a folder');
  } catch {
    console.error(`Cannot serve ${directory}: the folder does not exist. Run "npm run build" first to create dist/.`);
    process.exit(1);
  }
  const server = await startStaticServer(directory, port, { log: process.env.QUIET !== '1' });
  console.log(`Serving ${directory} at ${server.url} (press Ctrl+C to stop)`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
