// =====================================================================
// RADAR EMPRESARIAL BRASIL — Edge Function: places-search
// Busca real de empresas:
//   • Google Places (Text Search New), quando GOOGLE_PLACES_API_KEY existe;
//   • OpenStreetMap (Overpass, grátis e sem chave) quando não existe ou
//     quando o Google falha.
// Secrets: ALLOWED_EMAILS (obrigatório), GOOGLE_PLACES_API_KEY (opcional),
//          OVERPASS_URL (opcional: servidor Overpass preferido)
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
// ---------------------------------------------------------------------
// OpenStreetMap (Overpass API): fonte GRATUITA de empresas, sem chave.
// Dados © colaboradores do OpenStreetMap, licença ODbL: a atribuição
// aparece no app junto dos resultados.
// ---------------------------------------------------------------------

export const OSM_ATTRIBUTION = '© colaboradores do OpenStreetMap (ODbL)';
export const OSM_UA = 'RadarEmpresarialBrasil/1.0 (uso pessoal)';
export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export function overpassUrls(): string[] {
  const custom = env('OVERPASS_URL');
  return custom ? [custom, ...OVERPASS_URLS.filter((u) => u !== custom)] : OVERPASS_URLS;
}

// Por padrão a consulta ao Overpass é feita pelo NAVEGADOR do usuário (o
// endereço de internet dele não é limitado como o dos servidores de nuvem).
// A função devolve "need_overpass" com a consulta; o app executa e reenvia
// a resposta em "osm_data". Com o secret OSM_SERVER_FETCH=1 a própria
// função consulta o Overpass.
export const serverFetchEnabled = () => env('OSM_SERVER_FETCH') === '1';

// Resposta do Overpass enviada pelo app: só o formato esperado passa.
export function validateOsmData(v: unknown): { elements: any[] } | null {
  if (v === undefined || v === null) return null;
  const els = (v as any)?.elements;
  if (typeof v !== 'object' || !Array.isArray(els)) throw new HttpError(400, 'Dados do OpenStreetMap inválidos.');
  if (els.length > 6000) throw new HttpError(413, 'Resposta do OpenStreetMap grande demais.');
  const elements = els
    .filter((e: any) => e && ['node', 'way', 'relation', 'area', 'count'].includes(e.type) && /^\d{1,15}$/.test(String(e.id)))
    .map((e: any) => ({
      type: String(e.type),
      id: Number(e.id),
      tags: Object.fromEntries(Object.entries(e.tags && typeof e.tags === 'object' ? e.tags : {}).slice(0, 80)
        .map(([k, val]) => [String(k).slice(0, 60), String(val).slice(0, 300)])),
    }));
  return { elements };
}

// Executa a consulta tentando os servidores públicos em sequência.
export async function overpass(ql: string, { perServerMs = 45000, totalMs = 120000 } = {}): Promise<any> {
  const started = Date.now();
  const problems: string[] = [];
  for (const url of overpassUrls()) {
    const left = totalMs - (Date.now() - started);
    if (left < 5000) break;
    let res: Response;
    let text = '';
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
          'User-Agent': OSM_UA,
        },
        body: 'data=' + encodeURIComponent(ql),
        signal: AbortSignal.timeout(Math.min(perServerMs, left)),
      });
      text = await res.text();
    } catch {
      problems.push('sem resposta');
      continue;
    }
    if (res.status === 400) throw new HttpError(502, 'O OpenStreetMap recusou a consulta do Radar (HTTP 400).');
    if (!res.ok) {
      problems.push(res.status === 429 ? 'limite de consultas' : `ocupado (HTTP ${res.status})`);
      continue;
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      problems.push('resposta inválida');
      continue;
    }
    if (typeof data?.remark === 'string' && /runtime error|timed out|out of memory|rate_limited/i.test(data.remark)) {
      problems.push('consulta demorou demais');
      continue;
    }
    if (!Array.isArray(data?.elements)) data.elements = [];
    return data;
  }
  const why = problems.length ? ` (${[...new Set(problems)].join(', ')})` : '';
  throw new HttpError(503, `Os servidores gratuitos do OpenStreetMap estão sobrecarregados agora${why}. Tente de novo em alguns minutos.`);
}

// ---------- Texto sem acento / regex tolerante a acentos ----------
export const foldText = (s: string) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
export const textTokens = (s: string) => foldText(s).split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8);

const LOOSE: Record<string, string> = {
  a: 'aáàâãäAÁÀÂÃÄ', e: 'eéèêëEÉÈÊË', i: 'iíìîïIÍÌÎÏ', o: 'oóòôõöOÓÒÔÕÖ', u: 'uúùûüUÚÙÛÜ', c: 'cçCÇ',
};
// "sao" -> "s(a|á|...)(o|ó|...)": casa com e sem acento no servidor Overpass.
export const looseWord = (w: string) => [...w].map((ch) => (LOOSE[ch] ? `(${[...LOOSE[ch]].join('|')})` : ch)).join('');
export const looseRegex = (text: string, joiner: string) => textTokens(text).map(looseWord).join(joiner);

// ---------- Filtros no formato do Overpass, avaliados também aqui ----------
export type Tags = Record<string, string>;
const SEL_RE = /\[(!)?(~)?"([^"]*)"(?:(=|!=|~|!~)"([^"]*)"(,i)?)?\]/g;
const RE_CACHE = new Map<string, RegExp>();
const re = (src: string, ci: boolean) => {
  const k = (ci ? 'i:' : 's:') + src;
  let r = RE_CACHE.get(k);
  if (!r) { r = new RegExp(src, ci ? 'i' : ''); RE_CACHE.set(k, r); }
  return r;
};

export function matchSelector(tags: Tags, sel: string): boolean {
  for (const m of sel.matchAll(SEL_RE)) {
    const [, neg, keyRe, key, op, val = '', ci] = m;
    if (keyRe) {
      const ok = Object.entries(tags).some(([k, v]) => re(key, false).test(k) && re(val, Boolean(ci)).test(String(v)));
      if (!ok) return false;
      continue;
    }
    const has = Object.prototype.hasOwnProperty.call(tags, key);
    const v = has ? String(tags[key]) : '';
    let ok: boolean;
    if (!op) ok = neg ? !has : has;
    else if (op === '=') ok = has && v === val;
    else if (op === '!=') ok = !has || v !== val;
    else if (op === '~') ok = has && re(val, Boolean(ci)).test(v);
    else ok = !(has && re(val, Boolean(ci)).test(v));
    if (!ok) return false;
  }
  return true;
}

// ---------- Leitura das tags ----------
const PHONE_KEYS = ['phone', 'contact:phone', 'mobile', 'contact:mobile', 'contact:whatsapp'];
const SITE_KEYS = ['website', 'contact:website', 'url'];
export const PHONE_FILTER = '[~"^(phone|contact:phone|mobile|contact:mobile|contact:whatsapp)$"~"[0-9]"]';
export const NO_SITE_FILTER = '[!"website"][!"contact:website"][!"url"]';

const first = (v: unknown) => String(v ?? '').split(';')[0].trim();
export const hasPhoneTag = (t: Tags) => PHONE_KEYS.some((k) => /[0-9]/.test(String(t[k] ?? '')));
export const hasSiteTag = (t: Tags) => SITE_KEYS.some((k) => String(t[k] ?? '').trim() !== '');

export function osmPhone(t: Tags): string {
  for (const k of PHONE_KEYS) {
    const v = first(t[k]);
    if (/[0-9]/.test(v)) return v.slice(0, 40);
  }
  return '';
}

export function osmWebsite(t: Tags): string {
  for (const k of SITE_KEYS) {
    let v = first(t[k]);
    if (!v) continue;
    if (!/^https?:\/\//i.test(v) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(v)) v = 'https://' + v;
    if (/^https?:\/\//i.test(v)) return v.slice(0, 500);
  }
  return '';
}

export function osmAddress(t: Tags): string {
  const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ');
  if (!street) return '';
  const bairro = t['addr:suburb'] || t['addr:neighbourhood'] || t['addr:district'] || '';
  return [street, bairro, t['addr:city'] || '', t['addr:postcode'] || ''].filter(Boolean).join(' - ').slice(0, 500);
}

const OSM_LABELS: Record<string, string> = {
  'amenity=restaurant': 'Restaurante', 'amenity=fast_food': 'Lanchonete', 'amenity=cafe': 'Cafeteria', 'amenity=bar': 'Bar',
  'amenity=pub': 'Bar', 'amenity=biergarten': 'Bar', 'amenity=ice_cream': 'Sorveteria', 'amenity=food_court': 'Praça de alimentação',
  'amenity=pharmacy': 'Farmácia', 'amenity=dentist': 'Dentista', 'amenity=doctors': 'Consultório médico', 'amenity=clinic': 'Clínica',
  'amenity=veterinary': 'Clínica veterinária', 'amenity=car_wash': 'Lava-jato', 'amenity=car_rental': 'Locadora de veículos',
  'amenity=driving_school': 'Autoescola', 'amenity=language_school': 'Escola de idiomas', 'amenity=music_school': 'Escola de música',
  'amenity=dancing_school': 'Escola de dança', 'amenity=prep_school': 'Curso preparatório', 'amenity=kindergarten': 'Educação infantil',
  'amenity=childcare': 'Creche', 'amenity=nightclub': 'Casa noturna', 'amenity=internet_cafe': 'Lan house',
  'amenity=events_venue': 'Espaço de eventos', 'amenity=studio': 'Estúdio', 'amenity=coworking_space': 'Coworking',
  'amenity=fuel': 'Posto de combustível', 'amenity=vehicle_inspection': 'Vistoria veicular', 'amenity=gym': 'Academia',
  'shop=bakery': 'Padaria', 'shop=pastry': 'Confeitaria', 'shop=confectionery': 'Doceria', 'shop=chocolate': 'Chocolates',
  'shop=hairdresser': 'Salão de beleza', 'shop=barber': 'Barbearia', 'shop=beauty': 'Estética e beleza', 'shop=cosmetics': 'Cosméticos',
  'shop=clothes': 'Loja de roupas', 'shop=boutique': 'Boutique', 'shop=fashion': 'Moda', 'shop=shoes': 'Calçados',
  'shop=fashion_accessories': 'Acessórios', 'shop=bag': 'Bolsas', 'shop=supermarket': 'Supermercado',
  'shop=convenience': 'Mercadinho', 'shop=general': 'Mercearia', 'shop=greengrocer': 'Hortifrúti', 'shop=butcher': 'Açougue',
  'shop=seafood': 'Peixaria', 'shop=deli': 'Delicatessen', 'shop=frozen_food': 'Congelados', 'shop=wholesale': 'Atacado',
  'shop=pet': 'Pet shop', 'shop=pet_grooming': 'Banho e tosa', 'shop=car_repair': 'Oficina mecânica',
  'shop=motorcycle_repair': 'Oficina de motos', 'shop=tyres': 'Borracharia', 'shop=car_parts': 'Autopeças',
  'shop=car': 'Veículos', 'shop=motorcycle': 'Motos', 'shop=bicycle': 'Bicicletas', 'shop=hardware': 'Material de construção',
  'shop=doityourself': 'Material de construção', 'shop=trade': 'Material de construção', 'shop=paint': 'Tintas',
  'shop=tiles': 'Pisos e revestimentos', 'shop=glaziery': 'Vidraçaria', 'shop=furniture': 'Móveis', 'shop=electronics': 'Eletrônicos',
  'shop=mobile_phone': 'Celulares', 'shop=computer': 'Informática', 'shop=optician': 'Ótica', 'shop=florist': 'Floricultura',
  'shop=stationery': 'Papelaria', 'shop=books': 'Livraria', 'shop=gift': 'Presentes', 'shop=jewelry': 'Joalheria',
  'shop=toys': 'Brinquedos', 'shop=sports': 'Artigos esportivos', 'shop=tattoo': 'Estúdio de tatuagem', 'shop=piercing': 'Piercing',
  'shop=laundry': 'Lavanderia', 'shop=dry_cleaning': 'Lavanderia', 'shop=copyshop': 'Gráfica e copiadora', 'shop=photo': 'Fotografia',
  'shop=chemist': 'Drogaria', 'shop=variety_store': 'Variedades', 'shop=department_store': 'Loja de departamentos',
  'shop=alcohol': 'Bebidas', 'shop=beverages': 'Bebidas', 'shop=water': 'Água mineral', 'shop=gas': 'Gás',
  'shop=ice_cream': 'Sorveteria', 'shop=locksmith': 'Chaveiro', 'shop=tailor': 'Costura e ajustes', 'shop=fabric': 'Tecidos',
  'shop=perfumery': 'Perfumaria', 'shop=nutrition_supplements': 'Suplementos', 'shop=agrarian': 'Agropecuária',
  'shop=kiosk': 'Quiosque', 'shop=newsagent': 'Banca de revistas', 'shop=lottery': 'Lotérica', 'shop=travel_agency': 'Agência de viagens',
  'shop=funeral_directors': 'Funerária', 'shop=frame': 'Molduras', 'shop=houseware': 'Utilidades domésticas',
  'shop=craft': 'Artesanato', 'shop=musical_instrument': 'Instrumentos musicais', 'shop=garden_centre': 'Jardinagem',
  'craft=electrician': 'Eletricista', 'craft=plumber': 'Encanador', 'craft=carpenter': 'Marcenaria', 'craft=dressmaker': 'Costureira',
  'craft=tailor': 'Alfaiataria', 'craft=photographer': 'Fotógrafo', 'craft=printer': 'Gráfica', 'craft=mechanic': 'Mecânica',
  'craft=electronics_repair': 'Assistência técnica', 'craft=builder': 'Construção', 'craft=painter': 'Pintura', 'craft=locksmith': 'Chaveiro',
  'craft=shoemaker': 'Sapateiro', 'craft=caterer': 'Buffet', 'craft=confectionery': 'Doceria', 'craft=metal_construction': 'Serralheria',
  'office=lawyer': 'Advocacia', 'office=accountant': 'Contabilidade', 'office=tax_advisor': 'Consultoria tributária',
  'office=estate_agent': 'Imobiliária', 'office=insurance': 'Seguros', 'office=architect': 'Arquitetura', 'office=it': 'Tecnologia',
  'office=company': 'Empresa', 'office=travel_agent': 'Agência de viagens', 'office=consulting': 'Consultoria',
  'office=educational_institution': 'Ensino', 'office=engineer': 'Engenharia', 'office=advertising_agency': 'Publicidade',
  'office=construction_company': 'Construtora', 'office=employment_agency': 'Agência de empregos',
  'healthcare=dentist': 'Dentista', 'healthcare=clinic': 'Clínica', 'healthcare=doctor': 'Consultório médico',
  'healthcare=physiotherapist': 'Fisioterapia', 'healthcare=psychotherapist': 'Psicologia', 'healthcare=laboratory': 'Laboratório',
  'healthcare=optometrist': 'Optometria', 'healthcare=nutrition_counselling': 'Nutrição', 'healthcare=pharmacy': 'Farmácia',
  'healthcare=speech_therapist': 'Fonoaudiologia', 'healthcare=alternative': 'Terapias alternativas',
  'tourism=hotel': 'Hotel', 'tourism=guest_house': 'Pousada', 'tourism=hostel': 'Hostel', 'tourism=motel': 'Motel',
  'tourism=apartment': 'Hospedagem', 'tourism=chalet': 'Chalé',
  'leisure=fitness_centre': 'Academia', 'leisure=sports_centre': 'Centro esportivo', 'leisure=dance': 'Dança',
};
const KEY_FALLBACK: Record<string, string> = {
  amenity: 'Estabelecimento', shop: 'Loja', craft: 'Serviços', office: 'Escritório', healthcare: 'Saúde',
  tourism: 'Hospedagem', leisure: 'Esporte e lazer',
};

export function osmCategory(t: Tags): string {
  if (/pizza/i.test(t.cuisine || '')) return 'Pizzaria';
  if (t.shop === 'hairdresser' && (/barber/i.test(t.hairdresser || '') || /barb/i.test(t.name || ''))) return 'Barbearia';
  for (const k of Object.keys(KEY_FALLBACK)) {
    const v = first(t[k]);
    if (v) return OSM_LABELS[`${k}=${v}`] || KEY_FALLBACK[k];
  }
  return 'Estabelecimento';
}

// Mantém só as tags úteis (o cache fica pequeno).
const KEEP_TAG = /^(name|shop|amenity|craft|office|healthcare|tourism|leisure|cuisine|hairdresser|sport|brand|opening_hours|phone|mobile|website|url|contact:(phone|mobile|whatsapp|website|instagram|facebook)|addr:(street|housenumber|suburb|neighbourhood|district|city|postcode))$/;
export function compactElement(el: any): { type: string; id: number; tags: Tags } {
  const tags: Tags = {};
  for (const [k, v] of Object.entries(el?.tags || {})) if (KEEP_TAG.test(k)) tags[k] = String(v).slice(0, 300);
  return { type: String(el?.type || ''), id: Number(el?.id), tags };
}

export function osmRef(sourceId: string): { type: string; id: string } | null {
  const m = /^(node|way|relation)\/(\d{1,15})$/.exec(String(sourceId || ''));
  return m ? { type: m[1], id: m[2] } : null;
}

export function mapOsm(el: any, ctx: { city?: string; uf?: string } = {}): Company {
  const t: Tags = el?.tags || {};
  return {
    source: 'osm',
    source_id: `${el?.type}/${el?.id}`,
    name: String(t.name || '').trim().slice(0, 300),
    phone: osmPhone(t),
    address: osmAddress(t),
    city: String(t['addr:city'] || ctx.city || '').slice(0, 120),
    state: String(ctx.uf || ''),
    country: 'BR',
    category: osmCategory(t),
    website: osmWebsite(t),
    rating: null,
    rating_count: null,
    maps_url: `https://www.openstreetmap.org/${el?.type}/${el?.id}`,
    business_status: '',
  };
}

const DAYS: Record<string, string> = { Mo: 'seg', Tu: 'ter', We: 'qua', Th: 'qui', Fr: 'sex', Sa: 'sáb', Su: 'dom', PH: 'feriados' };
export function osmHours(raw: unknown): string[] {
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s === '24/7') return ['Aberto 24 horas'];
  return s.split(';').map((p) => p.trim()).filter(Boolean).slice(0, 7).map((p) => p
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (d) => DAYS[d])
    .replace(/\boff\b/gi, 'fechado')
    .replace(/,(?=\S)/g, ', ')
    .replace(/-/g, '–'));
}

export const UF_NAMES: Record<string, string> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul',
  MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí',
  RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

// Campos pedidos ao Google (telefone e site => SKU "Text Search Enterprise").
export const SEARCH_FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.nationalPhoneNumber',
  'places.internationalPhoneNumber', 'places.websiteUri', 'places.rating', 'places.userRatingCount',
  'places.primaryTypeDisplayName', 'places.googleMapsUri', 'places.businessStatus',
  'places.addressComponents', 'nextPageToken',
].join(',');

export type SearchInput = {
  nome: string; categoria: string; segmento: string; cidade: string; uf: string;
  semSite: boolean; comTelefone: boolean; pageToken: string;
  osmStage: '' | 'city' | 'filtered'; osmData: { elements: any[] } | null;
};

function cleanText(v: unknown, max: number, label: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${label} inválido.`);
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new HttpError(400, `${label}: máximo de ${max} caracteres.`);
  if (/[<>{}\\]/.test(s)) throw new HttpError(400, `${label} contém caracteres não permitidos.`);
  return s;
}

export function validateSearch(body: any): SearchInput {
  const input: SearchInput = {
    nome: cleanText(body.nome, 120, 'Nome'),
    categoria: cleanText(body.categoria, 60, 'Categoria'),
    segmento: cleanText(body.segmento, 80, 'Segmento'),
    cidade: cleanText(body.cidade, 80, 'Cidade'),
    uf: cleanText(body.uf, 2, 'Estado').toUpperCase(),
    semSite: body.semSite === true,
    comTelefone: body.comTelefone === true,
    pageToken: typeof body.pageToken === 'string' ? body.pageToken.trim().slice(0, 4000) : '',
    osmStage: body.osm_stage === 'city' || body.osm_stage === 'filtered' ? body.osm_stage : '',
    osmData: validateOsmData(body.osm_data),
  };
  if (input.osmData && !input.osmStage) throw new HttpError(400, 'Etapa do OpenStreetMap ausente.');
  if (input.uf && !UF_NAMES[input.uf]) throw new HttpError(400, 'Estado inválido.');
  // "Parnamirim RN" / "Parnamirim/RN": separa a UF digitada junto com a cidade.
  const m = /^(.*\S)[\s/,-]+([A-Za-z]{2})$/.exec(input.cidade);
  if (m && UF_NAMES[m[2].toUpperCase()] && (!input.uf || input.uf === m[2].toUpperCase())) {
    input.cidade = m[1].replace(/[\s/,-]+$/, '');
    input.uf = m[2].toUpperCase();
  }
  if (!input.nome && !input.categoria && !input.segmento && !input.cidade) {
    throw new HttpError(400, 'Informe pelo menos nome, categoria, segmento ou cidade.');
  }
  return input;
}

export function buildTextQuery(i: SearchInput): string {
  const what = [i.nome, i.categoria, i.segmento].filter(Boolean).join(' ') || 'empresas';
  const where = [i.cidade, i.uf ? UF_NAMES[i.uf] : ''].filter(Boolean).join(', ');
  return where ? `${what} em ${where}, Brasil` : `${what}, Brasil`;
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function filterCompanies(list: Company[], i: SearchInput) {
  const removed = { closed: 0, website: 0, phone: 0, outside: 0, invalid: 0 };
  const kept = list.filter((c) => {
    if (!c.source_id || !c.name) { removed.invalid++; return false; }
    if (c.business_status === 'CLOSED_PERMANENTLY') { removed.closed++; return false; }
    if (c.country && c.country.toUpperCase() !== 'BR') { removed.outside++; return false; }
    if (i.uf && c.state && c.state.toUpperCase() !== i.uf) { removed.outside++; return false; }
    if (i.cidade && c.city && fold(c.city) !== fold(i.cidade)) { removed.outside++; return false; }
    if (i.semSite && c.website) { removed.website++; return false; }
    if (i.comTelefone && !c.phone) { removed.phone++; return false; }
    return true;
  });
  return { kept, removed };
}

// =====================================================================
//  OpenStreetMap
// =====================================================================
const AM = (values: string) => `["amenity"~"^(${values})$"]`;

// "Empresa" no OpenStreetMap: comércio, serviços, escritórios, saúde, hospedagem...
export const OSM_BUSINESS = [
  '["shop"]["shop"!~"^(vacant|no|disused)$"]',
  '["craft"]',
  '["office"]["office"!~"^(government|ngo|association|religion|political_party|diplomatic|union|quango)$"]',
  '["healthcare"]["healthcare"!~"^(hospital|blood_donation)$"]',
  AM('restaurant|fast_food|cafe|bar|pub|biergarten|ice_cream|food_court|pharmacy|dentist|doctors|clinic|veterinary|car_wash|car_rental|driving_school|language_school|music_school|dancing_school|prep_school|kindergarten|childcare|nightclub|internet_cafe|events_venue|studio|coworking_space|fuel|vehicle_inspection|gym'),
  '["tourism"~"^(hotel|guest_house|hostel|motel|apartment|chalet)$"]',
  '["leisure"~"^(fitness_centre|sports_centre|dance)$"]',
];

// Categorias do formulário -> filtros do OpenStreetMap.
export const OSM_CATEGORIES: Record<string, string[]> = {
  'Restaurante': [AM('restaurant')],
  'Lanchonete': [AM('fast_food'), '["amenity"="cafe"]["name"~"lanch",i]'],
  'Padaria': ['["shop"~"^(bakery|pastry)$"]'],
  'Pizzaria': [AM('restaurant|fast_food') + '["cuisine"~"pizza",i]', AM('restaurant|fast_food') + '["name"~"pizz",i]'],
  'Cafeteria': [AM('cafe')],
  'Salão de beleza': ['["shop"~"^(hairdresser|beauty|cosmetics)$"]'],
  'Barbearia': ['["shop"="hairdresser"]["hairdresser"~"barber",i]', '["shop"="hairdresser"]["name"~"barb",i]', '["shop"="barber"]'],
  'Clínica estética': ['["shop"="beauty"]', AM('clinic|doctors') + '["name"~"est(e|é|E|É)tic",i]', '["healthcare"]["name"~"est(e|é|E|É)tic",i]'],
  'Academia': ['["leisure"="fitness_centre"]', '["leisure"="sports_centre"]["sport"~"fitness|crossfit|martial|boxing",i]', AM('gym')],
  'Pet shop': ['["shop"~"^(pet|pet_grooming)$"]'],
  'Clínica veterinária': [AM('veterinary')],
  'Oficina mecânica': ['["shop"~"^(car_repair|motorcycle_repair|tyres)$"]', '["craft"="mechanic"]'],
  'Loja de roupas': ['["shop"~"^(clothes|boutique|fashion|shoes|fashion_accessories|bag)$"]'],
  'Mercado': ['["shop"~"^(supermarket|convenience|greengrocer|butcher|general|wholesale|frozen_food|deli|seafood)$"]'],
  'Farmácia': [AM('pharmacy'), '["shop"="chemist"]', '["healthcare"="pharmacy"]'],
  'Imobiliária': ['["office"="estate_agent"]'],
  'Escritório de contabilidade': ['["office"~"^(accountant|tax_advisor)$"]'],
  'Advocacia': ['["office"="lawyer"]'],
  'Dentista': [AM('dentist'), '["healthcare"="dentist"]'],
  'Construção e reformas': [
    '["shop"~"^(hardware|doityourself|trade|paint|tiles|bathroom_furnishing|glaziery|flooring)$"]',
    '["craft"~"^(builder|carpenter|electrician|plumber|painter|tiler|roofer|glaziery|plasterer|metal_construction|stonemason)$"]',
    '["office"="construction_company"]',
  ],
  'Autoescola': [AM('driving_school')],
  'Hotel e pousada': ['["tourism"~"^(hotel|guest_house|hostel|motel|chalet|apartment)$"]'],
};

// Termos livres comuns (já sem acento) -> filtros. O nome também é pesquisado.
export const OSM_TERMS: Array<[RegExp, string[]]> = [
  [/^(restaurantes?|comida caseira|almoco)$/, OSM_CATEGORIES['Restaurante']],
  [/^(lanchonetes?|lanches?|hamburgueria|hamburguer|burger|cachorro quente|pastelaria|pastel)$/, [AM('fast_food')]],
  [/^(marmitarias?|marmitas?|quentinhas?|self service|self-service|comida a quilo)$/, [AM('restaurant|fast_food')]],
  [/^(acai|acaiteria|sorveterias?|sorvetes?|gelateria|picole)$/, [AM('ice_cream'), '["shop"="ice_cream"]']],
  [/^(tatuagem|tattoo|estudio de tatuagem|piercing)$/, ['["shop"~"^(tattoo|piercing)$"]']],
  [/^(doceria|confeitaria|bolos?|doces|brigadeiro|chocolateria)$/, ['["shop"~"^(confectionery|pastry|chocolate)$"]', '["craft"="confectionery"]']],
  [/^(acougues?|carnes)$/, ['["shop"="butcher"]']],
  [/^(hortifruti|sacolao|frutas|verduras)$/, ['["shop"="greengrocer"]']],
  [/^(oticas?|opticas?)$/, ['["shop"="optician"]']],
  [/^(floriculturas?|flores)$/, ['["shop"="florist"]']],
  [/^(papelarias?)$/, ['["shop"="stationery"]']],
  [/^(lava ?jato|lava-jato|lava rapido|lava-rapido|estetica automotiva)$/, [AM('car_wash')]],
  [/^(bar|bares|boteco|botecos|choperia|cervejaria|petiscaria)$/, [AM('bar|pub|biergarten')]],
  [/^(churrascarias?|churrasco|espetinhos?|steakhouse)$/, [AM('restaurant') + '["cuisine"~"barbecue|churrasco|steak",i]', AM('restaurant|fast_food') + '["name"~"churras|espet",i]']],
  [/^(sushi|japones|japonesa|comida japonesa|temakeria)$/, [AM('restaurant|fast_food') + '["cuisine"~"sushi|japanese",i]']],
  [/^(pizzas?|pizzarias?)$/, OSM_CATEGORIES['Pizzaria']],
  [/^(cabeleireir[oa]s?|salao|saloes|salao de beleza|cabelo)$/, ['["shop"~"^(hairdresser|beauty)$"]']],
  [/^(barbearias?|barbeiro)$/, OSM_CATEGORIES['Barbearia']],
  [/^(manicure|unhas|esmalteria|estetica|depilacao|sobrancelha)$/, ['["shop"="beauty"]']],
  [/^(costureiras?|costura|atelie|alfaiate|alfaiataria)$/, ['["craft"~"^(dressmaker|tailor)$"]', '["shop"="tailor"]']],
  [/^(eletricistas?)$/, ['["craft"="electrician"]']],
  [/^(encanador|encanadores|hidraulica)$/, ['["craft"="plumber"]']],
  [/^(chaveiros?)$/, ['["shop"="locksmith"]', '["craft"="locksmith"]']],
  [/^(borracharias?|pneus)$/, ['["shop"="tyres"]']],
  [/^(lavanderias?)$/, ['["shop"~"^(laundry|dry_cleaning)$"]']],
  [/^(escolas?|cursos?|idiomas|ingles|reforco|aulas)$/, [AM('language_school|music_school|dancing_school|prep_school|driving_school'), '["office"="educational_institution"]']],
  [/^(creches?|bercario|educacao infantil)$/, [AM('kindergarten|childcare')]],
  [/^(fisioterapia|psicolog[oa]s?|clinicas?|consultorios?|medic[oa]s?|nutricionistas?|fonoaudiolog[oa]s?|saude)$/, [AM('clinic|doctors'), '["healthcare"]']],
  [/^(moveis|movel|marcenarias?|marceneiro)$/, ['["shop"="furniture"]', '["craft"="carpenter"]']],
  [/^(celulares?|assistencia tecnica|informatica|eletronicos|conserto de celular)$/, ['["shop"~"^(mobile_phone|computer|electronics)$"]', '["craft"="electronics_repair"]']],
  [/^(graficas?|copiadora|impressao|xerox)$/, ['["shop"="copyshop"]', '["craft"="printer"]']],
  [/^(fotograf[oa]s?|fotografia|estudio fotografico)$/, ['["shop"="photo"]', '["craft"="photographer"]']],
  [/^(pet|pets|petshop|pet shop|banho e tosa)$/, OSM_CATEGORIES['Pet shop']],
  [/^(academias?|crossfit|musculacao|pilates|fitness)$/, OSM_CATEGORIES['Academia']],
  [/^(mercados?|mercadinhos?|supermercados?|mercearia|conveniencia)$/, OSM_CATEGORIES['Mercado']],
  [/^(farmacias?|drogarias?)$/, OSM_CATEGORIES['Farmácia']],
  [/^(padarias?|panificadora)$/, OSM_CATEGORIES['Padaria']],
  [/^(pousadas?|hoteis|hotel|hospedagem|hostel)$/, OSM_CATEGORIES['Hotel e pousada']],
  [/^(dentistas?|odontologia|odontologica|clinica odontologica)$/, OSM_CATEGORIES['Dentista']],
  [/^(oficinas?|mecanica|mecanico|auto center|autopecas)$/, ['["shop"~"^(car_repair|motorcycle_repair|tyres|car_parts)$"]', '["craft"="mechanic"]']],
  [/^(lojas?|comercio)$/, [OSM_BUSINESS[0]]],
  [/^(roupas?|moda|boutique|confeccao)$/, OSM_CATEGORIES['Loja de roupas']],
  [/^(cafe|cafes|cafeterias?)$/, OSM_CATEGORIES['Cafeteria']],
  [/^(veterinari[oa]s?|clinica veterinaria)$/, OSM_CATEGORIES['Clínica veterinária']],
  [/^(advogad[oa]s?|advocacia|escritorio de advocacia)$/, OSM_CATEGORIES['Advocacia']],
  [/^(contador|contadores|contabilidade)$/, OSM_CATEGORIES['Escritório de contabilidade']],
  [/^(imobiliarias?|corretor de imoveis)$/, OSM_CATEGORIES['Imobiliária']],
  [/^(autoescolas?|auto escola|cfc)$/, OSM_CATEGORIES['Autoescola']],
  [/^(material de construcao|construcao|reformas?|vidracaria|serralheria)$/, OSM_CATEGORIES['Construção e reformas']],
];

export type OsmGroup = { sel: string; name?: string };
export type OsmPlan = { groups: OsmGroup[]; nameFilters: string[] };

const findTerm = (text: string) => {
  const f = foldText(text);
  return f ? OSM_TERMS.find(([re]) => re.test(f))?.[1] : undefined;
};

// Traduz o formulário em grupos de filtros (OU) + filtros de nome (E).
export function planOsm(i: SearchInput): OsmPlan {
  const nameFilters: string[] = [];
  let groups: OsmGroup[];
  if (i.categoria) {
    const sels = OSM_CATEGORIES[i.categoria] || findTerm(i.categoria);
    if (sels) groups = sels.map((sel) => ({ sel }));
    else { groups = OSM_BUSINESS.map((sel) => ({ sel })); nameFilters.push(i.categoria); }
    if (i.segmento) nameFilters.push(i.segmento);
  } else if (i.segmento) {
    const sels = findTerm(i.segmento);
    if (sels) groups = [...sels.map((sel) => ({ sel })), ...OSM_BUSINESS.map((sel) => ({ sel, name: i.segmento }))];
    else { groups = OSM_BUSINESS.map((sel) => ({ sel })); nameFilters.push(i.segmento); }
  } else {
    groups = OSM_BUSINESS.map((sel) => ({ sel }));
  }
  if (i.nome) nameFilters.push(i.nome);
  return { groups, nameFilters };
}

const nameHas = (foldedName: string, text: string) => textTokens(text).every((tk) => foldedName.includes(tk));

export function matchesPlan(tags: Tags, plan: OsmPlan): boolean {
  if (!tags.name) return false;
  const nm = foldText(tags.name);
  if (!plan.nameFilters.every((t) => nameHas(nm, t))) return false;
  return plan.groups.some((g) => matchSelector(tags, g.sel) && (!g.name || nameHas(nm, g.name)));
}

export const osmCacheKey = (i: SearchInput) => `${i.uf || 'BR'}|${textTokens(i.cidade).join(' ')}`;

function areaQL(i: SearchInput): string {
  const scope = i.uf
    ? `rel["boundary"="administrative"]["admin_level"="4"]["ISO3166-2"="BR-${i.uf}"];`
    : 'rel["boundary"="administrative"]["admin_level"="2"]["ISO3166-1"="BR"];';
  const city = '^' + looseRegex(i.cidade, '[^A-Za-z0-9]+') + '$';
  return `${scope}\nmap_to_area->.uf;\n` +
    `rel["boundary"="administrative"]["admin_level"="8"]["name"~"${city}",i](area.uf);\n` +
    'map_to_area->.city;\n.city out tags;';
}

export const OSM_CITY_LIMIT = 3000;

// Todas as empresas com nome da cidade (vai para o cache de 7 dias).
export function cityQL(i: SearchInput): string {
  const lines = OSM_BUSINESS.map((s) => `  nwr(area.city)["name"]${s};`).join('\n');
  return `[out:json][timeout:40];\n${areaQL(i)}\n(\n${lines}\n)->.all;\n.all out count;\n.all out tags ${OSM_CITY_LIMIT};`;
}

// Cidade grande demais para o cache: filtra tudo no servidor do Overpass.
export function filteredQL(i: SearchInput, plan: OsmPlan, limit = 400): string {
  const byName = (text: string) => textTokens(text).map((tk) => `["name"~"${looseWord(tk)}",i]`).join('');
  const common = '["name"]' + plan.nameFilters.map(byName).join('') +
    (i.semSite ? NO_SITE_FILTER : '') + (i.comTelefone ? PHONE_FILTER : '');
  const lines = plan.groups.map((g) => `  nwr(area.city)${g.sel}${common}${g.name ? byName(g.name) : ''};`).join('\n');
  return `[out:json][timeout:40];\n${areaQL(i)}\n(\n${lines}\n);\nout tags ${limit};`;
}

const PAGE = 40;

function osmWhat(i: SearchInput): string {
  return [i.nome, i.categoria, i.segmento].filter(Boolean).join(' ') || 'Empresas';
}

function notFound(i: SearchInput): HttpError {
  return new HttpError(404, `Cidade "${i.cidade}" não encontrada no OpenStreetMap` +
    (i.uf ? ` em ${UF_NAMES[i.uf]}` : '') + '. Confira o nome e o estado (ex.: Parnamirim, RN).');
}

// Dados de uma etapa: os enviados pelo app (consulta feita no navegador) ou,
// com OSM_SERVER_FETCH=1, consultados aqui. null = o app precisa consultar.
async function osmStep(i: SearchInput, stage: 'city' | 'filtered', ql: string) {
  if (i.osmData && i.osmStage === stage) return i.osmData;
  if (serverFetchEnabled()) return overpass(ql);
  return null;
}

export async function searchOsm(ctx: Ctx, i: SearchInput, warning = '') {
  if (!i.cidade) throw new HttpError(400, 'Para buscar no OpenStreetMap (gratuito), informe a cidade.');
  const plan = planOsm(i);
  const key = osmCacheKey(i);
  const offset = /^osm:(\d{1,5})$/.test(i.pageToken) ? Number(i.pageToken.slice(4)) : 0;

  let cache: any = null;
  try { cache = await rpc(ctx, 'get_osm_cache', { p_key: key }); } catch { cache = null; }
  let cityName = cache?.city_name || '';
  let elements: any[] | null = cache && !cache.truncated ? cache.elements : null;
  let fromCache = Boolean(elements);
  let truncated = Boolean(cache?.truncated);
  const removed = { closed: 0, website: 0, phone: 0, outside: 0, invalid: 0 };
  let matched: any[];

  if (!elements && !truncated) {
    const data = await osmStep(i, 'city', cityQL(i));
    if (!data) return { source: 'osm', need_overpass: { stage: 'city', ql: cityQL(i) }, warning };
    const areas = data.elements.filter((e: any) => e.type === 'area');
    if (!areas.length) throw notFound(i);
    cityName = areas.length === 1 ? String(areas[0].tags?.name || i.cidade) : i.cidade;
    const count = Number(data.elements.find((e: any) => e.type === 'count')?.tags?.total || 0);
    const list = data.elements.filter((e: any) => ['node', 'way', 'relation'].includes(e.type)).map(compactElement);
    truncated = count > OSM_CITY_LIMIT || list.length >= OSM_CITY_LIMIT;
    elements = truncated ? null : list;
    try {
      await rpc(ctx, 'put_osm_cache', { p_key: key, p_city_name: cityName, p_uf: i.uf || null,
        p_truncated: truncated, p_elements: truncated ? [] : list });
    } catch (e) {
      console.error('cache OSM não salvo', e);
    }
  }

  if (elements) {
    const base = elements.filter((el) => matchesPlan(el.tags || {}, plan));
    matched = base.filter((el) => {
      const t = el.tags || {};
      if (i.semSite && hasSiteTag(t)) { removed.website++; return false; }
      if (i.comTelefone && !hasPhoneTag(t)) { removed.phone++; return false; }
      return true;
    });
  } else {
    const data = await osmStep(i, 'filtered', filteredQL(i, plan));
    if (!data) return { source: 'osm', need_overpass: { stage: 'filtered', ql: filteredQL(i, plan) }, warning };
    const areas = data.elements.filter((e: any) => e.type === 'area');
    if (!areas.length) throw notFound(i);
    if (!cityName) cityName = areas.length === 1 ? String(areas[0].tags?.name || i.cidade) : i.cidade;
    matched = data.elements.filter((e: any) => e.type !== 'area' && e.tags?.name).map(compactElement);
  }

  const companies = matched
    .map((el) => mapOsm(el, { city: cityName, uf: i.uf }))
    .filter((c) => c.name)
    .sort((a, b) => (Number(Boolean(b.phone)) - Number(Boolean(a.phone))) || a.name.localeCompare(b.name, 'pt-BR'));
  const page = companies.slice(offset, offset + PAGE);
  const query = `${osmWhat(i)} em ${cityName || i.cidade}${i.uf ? ` - ${i.uf}` : ''}`;
  const saved = page.length
    ? await rpc(ctx, 'upsert_found_companies', { p_items: page.map(toDbItem), p_query: query + ' (OpenStreetMap)', p_source: 'osm' })
    : { items: [] };
  const byId = new Map<string, any>((saved?.items || []).map((x: any) => [x.source_id, x]));
  const results = page.map((c) => {
    const db = byId.get(c.source_id);
    return { ...c, id: db?.id ?? null, saved: Boolean(db?.saved), contact_status: db?.contact_status ?? null };
  });
  const next = offset + PAGE < companies.length ? `osm:${offset + PAGE}` : null;
  return {
    source: 'osm',
    query,
    results,
    nextPageToken: next,
    stats: { returned: companies.length, kept: page.length, removed, city_total: elements ? elements.length : null },
    cached: fromCache,
    attribution: OSM_ATTRIBUTION,
    warning: warning || (truncated ? 'Cidade grande: a busca foi feita direto no OpenStreetMap, sem cache.' : ''),
  };
}

// =====================================================================
//  Google Places
// =====================================================================
async function searchGoogle(ctx: Ctx, input: SearchInput, apiKey: string) {
  const textQuery = buildTextQuery(input);
  const body: Record<string, unknown> = { textQuery, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 20 };
  if (input.pageToken) body.pageToken = input.pageToken;

  let res: Response;
  try {
    res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': SEARCH_FIELD_MASK },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, 'Google Places indisponível no momento.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, 'Google Places: ' + googleError(data, res.status));

  const mapped = (Array.isArray(data.places) ? data.places : []).map(mapPlace);
  const { kept, removed } = filterCompanies(mapped, input);
  const saved = await rpc(ctx, 'upsert_found_companies', { p_items: kept.map(toDbItem), p_query: textQuery, p_source: 'google_places' });
  const byId = new Map<string, any>((saved?.items || []).map((x: any) => [x.source_id, x]));
  const results = kept.map((c) => {
    const db = byId.get(c.source_id);
    return { ...c, id: db?.id ?? null, saved: Boolean(db?.saved), contact_status: db?.contact_status ?? null };
  });
  return {
    source: 'google_places',
    query: textQuery,
    results,
    nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : null,
    stats: { returned: mapped.length, kept: kept.length, removed },
    attribution: 'Google Maps',
  };
}

export async function handler(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const ctx = await requireUser(req);
    const input = validateSearch(await readJson(req, 4000000));
    const apiKey = env('GOOGLE_PLACES_API_KEY');
    if (input.osmStage || input.pageToken.startsWith('osm:') || !apiKey) return json(200, await searchOsm(ctx, input));
    try {
      return json(200, await searchGoogle(ctx, input, apiKey));
    } catch (err) {
      // Google falhou (chave, faturamento, cota...): usa a fonte gratuita se houver cidade.
      if (!(err instanceof HttpError) || err.status < 500 || !input.cidade || input.pageToken) throw err;
      return json(200, await searchOsm(ctx, { ...input, pageToken: '' },
        `${err.message} Mostrando resultados gratuitos do OpenStreetMap.`));
    }
  } catch (err) {
    return errorResponse(err);
  }
}

serve(handler);
