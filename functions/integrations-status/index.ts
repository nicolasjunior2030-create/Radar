// =====================================================================
// RADAR EMPRESARIAL BRASIL — Edge Function: integrations-status
// Testa DE VERDADE as integrações do backend (sem custo):
//  • Google Places: busca "somente IDs" (SKU gratuito do Google)
//  • OpenStreetMap: status dos servidores Overpass (grátis, sem chave)
//  • Anthropic: lista de modelos (não consome tokens)
// Secrets lidos: GOOGLE_PLACES_API_KEY, ANTHROPIC_API_KEY, ANTHROPIC_MODEL,
//                ALLOWED_EMAILS, OVERPASS_URL (opcional)
// =====================================================================
// ---------------------------------------------------------------------
// Código comum (copiado em cada função para que cada uma seja um único
// arquivo — mais fácil de colar no editor do Supabase pelo tablet).
// ---------------------------------------------------------------------

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function env(name: string): string {
  try {
    const d = (globalThis as any).Deno;
    return String(d?.env?.get(name) ?? '').trim();
  } catch {
    return '';
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json(405, { error: 'Método não permitido. Use POST.' });
  return null;
}

export async function readJson(req: Request, maxChars: number): Promise<any> {
  const text = await req.text();
  if (text.length > maxChars) throw new HttpError(413, 'Requisição grande demais.');
  if (!text.trim()) return {};
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON inválido.');
  return value;
}

// Chave pública do projeto (publishable ou anon) para falar com Auth/REST.
export function projectKey(req: Request): string {
  const fromRequest = req.headers.get('apikey') || '';
  if (fromRequest) return fromRequest;
  const single = env('SUPABASE_PUBLISHABLE_KEY');
  if (single) return single;
  const many = env('SUPABASE_PUBLISHABLE_KEYS');
  if (many) {
    try {
      const parsed = JSON.parse(many);
      const value = parsed.default || Object.values(parsed)[0];
      if (value) return String(value);
    } catch { /* formato inesperado: segue para a chave legada */ }
  }
  return env('SUPABASE_ANON_KEY');
}

export type Ctx = { url: string; key: string; auth: string; user: { id: string; email: string } };

// Valida a sessão do usuário e a lista de e-mails autorizados (ALLOWED_EMAILS).
export async function requireUser(req: Request): Promise<Ctx> {
  const auth = req.headers.get('authorization') || '';
  if (!/^bearer\s+\S+/i.test(auth)) throw new HttpError(401, 'Sessão ausente. Faça login novamente.');
  const url = env('SUPABASE_URL').replace(/\/+$/, '');
  if (!url) throw new HttpError(500, 'SUPABASE_URL indisponível no ambiente da função.');
  const key = projectKey(req);
  if (!key) throw new HttpError(500, 'Chave pública do projeto indisponível (apikey).');

  let res: Response;
  try {
    res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: auth } });
  } catch {
    throw new HttpError(502, 'Não foi possível validar a sessão no Supabase Auth.');
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
  if (!res.ok) throw new HttpError(502, `Falha ao validar a sessão (HTTP ${res.status}).`);
  const user = await res.json().catch(() => null);
  if (!user?.id) throw new HttpError(401, 'Sessão inválida. Faça login novamente.');

  const allowed = env('ALLOWED_EMAILS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) {
    throw new HttpError(403, 'Integrações bloqueadas: defina o secret ALLOWED_EMAILS com o seu e-mail no Supabase.');
  }
  if (!allowed.includes(String(user.email || '').toLowerCase())) {
    throw new HttpError(403, 'Este usuário não está autorizado a usar as integrações (ALLOWED_EMAILS).');
  }
  return { url, key, auth, user: { id: String(user.id), email: String(user.email || '') } };
}

// Chama uma função SQL (RPC) COM a sessão do usuário: o RLS sempre vale.
export async function rpc(ctx: Ctx, fn: string, args: Record<string, unknown>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${ctx.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: ctx.key, Authorization: ctx.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new HttpError(502, 'Banco de dados indisponível.');
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).message || text;
    } catch { /* texto puro */ }
    if (/could not find the function/i.test(message)) {
      message = `função ${fn} não existe no banco — rode o schema.sql no SQL Editor do Supabase`;
    }
    throw new HttpError(res.status >= 500 ? 502 : 400, `Banco de dados: ${message}`);
  }
  return text ? JSON.parse(text) : null;
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json(err.status, { error: err.message });
  console.error(err);
  return json(500, { error: 'Erro interno: ' + (err instanceof Error ? err.message : String(err)) });
}

export function serve(handler: (req: Request) => Promise<Response>): void {
  const d = (globalThis as any).Deno;
  if (d && typeof d.serve === 'function' && !(globalThis as any).__RADAR_TEST__) d.serve(handler);
}

// ---------- Google Places ----------
export type Company = {
  source: string; source_id: string; name: string; phone: string; address: string; city: string;
  state: string; country: string; category: string; website: string; rating: number | null;
  rating_count: number | null; maps_url: string; business_status: string;
};

function addressPart(p: any, type: string, short: boolean): string {
  const c = (p?.addressComponents || []).find((x: any) => (x?.types || []).includes(type));
  if (!c) return '';
  return String((short ? c.shortText : c.longText) || c.longText || c.shortText || '');
}

export function mapPlace(p: any): Company {
  return {
    source: 'google_places',
    source_id: String(p?.id || ''),
    name: String(p?.displayName?.text || ''),
    phone: String(p?.nationalPhoneNumber || p?.internationalPhoneNumber || ''),
    address: String(p?.formattedAddress || ''),
    city: addressPart(p, 'administrative_area_level_2', false) || addressPart(p, 'locality', false),
    state: addressPart(p, 'administrative_area_level_1', true),
    country: addressPart(p, 'country', true),
    category: String(p?.primaryTypeDisplayName?.text || ''),
    website: String(p?.websiteUri || ''),
    rating: typeof p?.rating === 'number' ? p.rating : null,
    rating_count: typeof p?.userRatingCount === 'number' ? p.userRatingCount : null,
    maps_url: String(p?.googleMapsUri || ''),
    business_status: String(p?.businessStatus || ''),
  };
}

export function toDbItem(c: Company): Record<string, unknown> {
  return {
    source_id: c.source_id, name: c.name, phone: c.phone, address: c.address, city: c.city,
    state: c.state, category: c.category, website: c.website, rating: c.rating,
    rating_count: c.rating_count, maps_url: c.maps_url, business_status: c.business_status,
  };
}

export function googleError(data: any, status: number): string {
  const msg = String(data?.error?.message || `HTTP ${status}`);
  if (/api key not valid|API_KEY_INVALID/i.test(msg)) return 'chave inválida. Confira o secret GOOGLE_PLACES_API_KEY.';
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) return 'a "Places API (New)" não está ativada no seu projeto do Google Cloud.';
  if (/billing/i.test(msg)) return 'ative o faturamento (billing) no Google Cloud para usar a Places API.';
  if (/referer|referrer|not authorized|PERMISSION_DENIED/i.test(msg)) return `acesso negado pela chave (${msg}). Remova restrições de "sites" da chave; use restrição por API.`;
  if (status === 429) return 'limite de consultas atingido. Tente novamente em instantes.';
  return msg;
}

export const ANTHROPIC_VERSION = '2026-10-21';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

async function checkPlaces(): Promise<Record<string, unknown>> {
  const key = env('GOOGLE_PLACES_API_KEY');
  if (!key) return { configured: false, ok: false, message: 'Secret GOOGLE_PLACES_API_KEY não definido.' };
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
      body: JSON.stringify({ textQuery: 'padaria em São Paulo, Brasil', pageSize: 1, regionCode: 'BR' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { configured: true, ok: false, message: googleError(data, res.status) };
    return { configured: true, ok: true, message: 'Chave válida. Busca de teste respondeu.' };
  } catch {
    return { configured: true, ok: false, message: 'Não foi possível alcançar o Google.' };
  }
}

const OVERPASS_STATUS = [
  'https://overpass-api.de/api/status',
  'https://overpass.private.coffee/api/status',
  'https://maps.mail.ru/osm/tools/overpass/api/status',
];

async function checkOsm(): Promise<Record<string, unknown>> {
  const custom = env('OVERPASS_URL');
  const urls = custom ? [custom.replace(/\/interpreter\/?$/, '/status'), ...OVERPASS_STATUS] : OVERPASS_STATUS;
  try {
    await Promise.any(urls.map(async (url) => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'RadarEmpresarialBrasil/1.0 (uso pessoal)' },
        signal: AbortSignal.timeout(10000),
      });
      await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }));
    return { configured: true, ok: true, message: 'Servidores do OpenStreetMap respondendo. Busca grátis disponível.' };
  } catch {
    return { configured: true, ok: false,
      message: 'Os servidores gratuitos do OpenStreetMap não responderam agora. Tente de novo em alguns minutos.' };
  }
}

async function checkAnthropic(): Promise<Record<string, unknown>> {
  const key = env('ANTHROPIC_API_KEY');
  const model = env('ANTHROPIC_MODEL') || DEFAULT_MODEL;
  if (!key) return { configured: false, ok: false, model, message: 'Secret ANTHROPIC_API_KEY não definido.' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = res.status === 401 ? 'Chave inválida. Confira o secret ANTHROPIC_API_KEY.'
        : String(data?.error?.message || `HTTP ${res.status}`);
      return { configured: true, ok: false, model, message: msg };
    }
    const list: any[] = Array.isArray(data?.data) ? data.data : [];
    const found = list.find((m) => m?.id === model);
    if (!found) {
      return { configured: true, ok: false, model,
        message: `Chave válida, mas o modelo "${model}" não está disponível. Ajuste o secret ANTHROPIC_MODEL.` };
    }
    return { configured: true, ok: true, model, model_name: found.display_name || model,
      message: 'Chave válida e modelo disponível.' };
  } catch {
    return { configured: true, ok: false, model, message: 'Não foi possível alcançar a API da Anthropic.' };
  }
}

export async function handler(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const ctx = await requireUser(req);
    const [places, osm, anthropic] = await Promise.all([checkPlaces(), checkOsm(), checkAnthropic()]);
    const budget = Number(env('FUNCTION_TIME_BUDGET_MS')) || 135000;
    return json(200, {
      checked_at: new Date().toISOString(),
      user: { email: ctx.user.email },
      allowlist: { ok: true },
      places,
      osm,
      search_source: places.ok ? 'google_places' : 'osm',
      anthropic,
      time_budget_ms: budget,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

serve(handler);
