/**
 * The one place that talks to the API. Two kinds of caller:
 *   customer → `Authorization: Bearer <JWT>` (token kept in localStorage)
 *   admin    → `x-admin-key: <key>`         (key kept in sessionStorage, gone when the tab closes)
 */

const TOKEN_KEY = 'neobank.token';
const ADMIN_KEY = 'neobank.adminKey';

function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null; // storage can be blocked (private mode)
  }
}

function write(storage: Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // ignore: the app still works for this page view
  }
}

export const getToken = () => read(localStorage, TOKEN_KEY);
export const setToken = (token: string | null) => write(localStorage, TOKEN_KEY, token);
export const getAdminKey = () => read(sessionStorage, ADMIN_KEY);
export const setAdminKey = (key: string | null) => write(sessionStorage, ADMIN_KEY, key);

/** The API's error shape: `{ error: { code, message, details } }`, plus anything else in the body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** The full response body, e.g. a failed transfer also returns `transaction`. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Sent as Idempotency-Key; reuse the same value when retrying the same action. */
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined>;
  as?: 'customer' | 'admin' | 'public';
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return `/api/v1${path}${params.size ? `?${params}` : ''}`;
}

function authHeaders(as: RequestOptions['as']): Record<string, string> {
  if (as === 'customer') {
    const token = getToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  if (as === 'admin') return { 'x-admin-key': getAdminKey() ?? '' };
  return {};
}

/** Customer session expired: forget the token and go to the login page. */
function handleUnauthorized(as: RequestOptions['as']) {
  if (as === 'customer') {
    setToken(null);
    if (window.location.pathname !== '/login') window.location.assign('/login');
  }
  if (as === 'admin') {
    setAdminKey(null);
    window.dispatchEvent(new Event('neobank:admin-logout'));
  }
}

export async function request<T>(
  path: string,
  { method = 'GET', body, idempotencyKey, query, as = 'customer' }: RequestOptions = {},
): Promise<T> {
  const response = await fetch(buildUrl(path, query), {
    method,
    headers: {
      ...authHeaders(as),
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(idempotencyKey && { 'idempotency-key': idempotencyKey }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized(as);
    const error = payload?.error ?? {};
    throw new ApiError(response.status, error.code ?? 'UNKNOWN', error.message ?? response.statusText, error.details, payload);
  }
  return payload as T;
}

/** Downloads a file (CSV/PDF) that needs the auth header, so a plain <a href> will not do. */
export async function downloadFile(path: string, query: RequestOptions['query'], filename: string): Promise<void> {
  const response = await fetch(buildUrl(path, query), { headers: authHeaders('customer') });
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized('customer');
    const payload = await response.json().catch(() => null);
    throw new ApiError(response.status, payload?.error?.code ?? 'UNKNOWN', payload?.error?.message ?? 'Download failed');
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
