import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Log requests
app.use((req, res, next) => {
  console.log(`[Server] ${req.method} ${req.url}`);
  next();
});

// Proxy route for Gemini API
app.use('/api/proxy/*', async (req, res) => {
  try {
    const rawPath = req.originalUrl.replace(/^\/api\/proxy/, '');
    const targetUrl = `https://generativelanguage.googleapis.com${rawPath}`;
    const apiKey = process.env.GEMINI_API_KEY || '';

    if (!apiKey) {
      console.warn('[Server] GEMINI_API_KEY environment variable is not defined!');
    }

    const url = new URL(targetUrl);
    url.searchParams.set('key', apiKey);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      // Remove host, referer, origin to avoid CORS/permission errors
      // Exclude accept-encoding to prevent receiving gzip/deflate compressed streams we cannot parse/pipe as-is
      // Exclude content-length to allow fetch to automatically compute the length of our buffered request body
      if (
        lowerKey !== 'host' &&
        lowerKey !== 'referer' &&
        lowerKey !== 'origin' &&
        lowerKey !== 'accept-encoding' &&
        lowerKey !== 'content-length'
      ) {
        if (value) {
          headers.set(key, String(value));
        }
      }
    }
    headers.set('x-goog-api-key', apiKey);

    const fetchOptions: RequestInit = {
      method: req.method,
      headers: headers,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Buffer request body in memory to prevent streaming body duplex issues
      const bodyBuffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', (err) => reject(err));
      });
      fetchOptions.body = bodyBuffer;
    }

    const response = await fetch(url.toString(), fetchOptions);

    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey !== 'transfer-encoding' &&
        lowerKey !== 'content-encoding' &&
        lowerKey !== 'content-length'
      ) {
        res.setHeader(key, value);
      }
    });

    // Explicitly set headers to prevent reverse proxies (e.g. Nginx, Cloud Run) from buffering stream chunks
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const chunkStr = decoder.decode(value, { stream: true });
          console.log(`[Server] Proxying chunk (${value.length} bytes):`, chunkStr);
          res.write(value);
          if ((res as any).flush) {
            (res as any).flush();
          }
        }
        // Ensure that text/event-stream responses end with a double newline
        // so that the client-side parser matches and parses the last event.
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream')) {
          console.log('[Server] Stream ended. Appending double newline.');
          res.write('\n\n');
        }
      } catch (err) {
        console.error('[Server] Stream reading error:', err);
      } finally {
        reader.releaseLock();
        res.end();
      }
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Server proxy error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy failed', details: String(error) });
    }
  }
});

// Serve static files from dist
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback all routes to index.html for client SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
