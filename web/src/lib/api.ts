// Cliente da API local. Erros sempre trazem mensagem + orientação em português.
export class ApiError extends Error {
  status: number;
  hint: string;
  code: string;
  constructor(status: number, message: string, hint = '', code = '') {
    super(message);
    this.status = status;
    this.hint = hint;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, url: string, body?: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body instanceof FormData || body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'Sem conexão com o servidor do GDR Orbit.', 'Verifique se o GDR Orbit está rodando no computador (npm start) e recarregue a página.');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) onUnauthorized?.();
    throw new ApiError(res.status, data?.error ?? `Erro ${res.status}`, data?.hint ?? '', data?.code ?? '');
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string, opts?: { signal?: AbortSignal }) => request<T>('GET', url, undefined, opts),
  post: <T = any>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  patch: <T = any>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T = any>(url: string) => request<T>('DELETE', url),
};

/** Envio de arquivo com progresso (XHR permite acompanhar o upload). */
export function uploadFile(url: string, file: File, onProgress: (f: number) => void): { promise: Promise<any>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<any>((resolve, reject) => {
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* resposta vazia */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error ?? 'Falha no envio.', data?.hint ?? 'Tente novamente.'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'O envio foi interrompido.', 'Verifique se o GDR Orbit está rodando e tente novamente.'));
    xhr.onabort = () => reject(new ApiError(0, 'Envio cancelado.', ''));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

export const media = {
  proxy: (id: string) => `/api/assets/${id}/media/proxy`,
  original: (id: string) => `/api/assets/${id}/media/original`,
  poster: (id: string) => `/api/assets/${id}/media/poster`,
  filmstrip: (id: string) => `/api/assets/${id}/media/filmstrip`,
  waveform: (id: string) => `/api/assets/${id}/media/waveform`,
};
