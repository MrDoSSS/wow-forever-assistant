// Source HTTP client for the ForeverMaster archive.
// Not an arbitrary model page-reading tool. Allow 20 seconds per operation and at most
// two attempts for temporary network errors; never retry 4xx or unknown formats.

export interface HttpRequest {
  url: string;
  headers?: Record<string, string>;
  maxBytes: number;
  timeoutMs?: number;
  attempts?: number;
}

export type HttpResult =
  | { status: 'ok'; httpStatus: number; etag: string | null; lastModified: string | null; body: Uint8Array }
  | { status: 'not_modified'; httpStatus: 304; etag: string | null; lastModified: string | null }
  | { status: 'error'; code: 'http_status' | 'too_large' | 'network' | 'timeout'; httpStatus: number | null; detail: string };

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

class TooLarge extends Error {}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new TooLarge(`declared ${declared}`);
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLarge(`read ${total}`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function httpGet(request: HttpRequest, fetcher: Fetcher = fetch): Promise<HttpResult> {
  const attempts = request.attempts ?? 2;
  let last: HttpResult = { status: 'error', code: 'network', httpStatus: null, detail: 'not attempted' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 20_000);
    try {
      const response = await fetcher(request.url, {
        headers: request.headers ?? {},
        redirect: 'follow',
        signal: controller.signal,
      });
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      if (response.status === 304) return { status: 'not_modified', httpStatus: 304, etag, lastModified };
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        const result: HttpResult = { status: 'error', code: 'http_status', httpStatus: response.status, detail: response.statusText };
        if (response.status < 500) return result;
        last = result;
        continue;
      }
      const body = await readLimited(response, request.maxBytes);
      return { status: 'ok', httpStatus: response.status, etag, lastModified, body };
    } catch (error) {
      if (error instanceof TooLarge) return { status: 'error', code: 'too_large', httpStatus: null, detail: error.message };
      last = controller.signal.aborted
        ? { status: 'error', code: 'timeout', httpStatus: null, detail: 'timeout' }
        : { status: 'error', code: 'network', httpStatus: null, detail: String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}
