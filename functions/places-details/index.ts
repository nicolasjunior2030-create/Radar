// =====================================================================
// RADAR EMPRESARIAL BRASIL — Edge Function: places-details
// "Ver detalhes": busca os dados atuais na fonte de cada empresa
//   • Google Places (atualiza o cache de 30 dias) — precisa da chave;
//   • OpenStreetMap (grátis) — horários e contatos mais recentes.
// Secrets: ALLOWED_EMAILS; GOOGLE_PLACES_API_KEY (só para empresas do Google)
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

export const DETAILS_FIELD_MASK = [
  'id', 'displayName', 'formattedAddress', 'nationalPhoneNumber', 'internationalPhoneNumber', 'websiteUri',
  'rating', 'userRatingCount', 'primaryTypeDisplayName', 'googleMapsUri', 'businessStatus',
  'addressComponents', 'regularOpeningHours',
].join(',');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateIds(body: any): string[] {
  const ids = body?.company_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20) {
    throw new HttpError(400, 'Envie de 1 a 20 empresas em company_ids.');
  }
  const unique = [...new Set(ids.map((x: unknown) => String(x)))];
  if (!unique.every((x) => UUID_RE.test(x))) throw new HttpError(400, 'Identificador de empresa inválido.');
  return unique;
}

async function fetchDetails(apiKey: string, placeId: string): Promise<any> {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=pt-BR&regionCode=BR`;
  const res = await fetch(url, { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': DETAILS_FIELD_MASK } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 404) throw new HttpError(404, 'Empresa não encontrada no Google (pode ter sido removida).');
    throw new HttpError(502, 'Google Places: ' + googleError(data, res.status));
  }
  return data;
}

async function refreshGoogle(rows: any[], items: any[], errors: any[]) {
  if (!rows.length) return;
  const apiKey = env('GOOGLE_PLACES_API_KEY');
  if (!apiKey) {
    rows.forEach((row) => errors.push({ id: row.id,
      error: 'Google Places não configurado: os dados mostrados são os salvos na última busca.' }));
    return;
  }
  await Promise.all(rows.map(async (row) => {
    try {
      const data = await fetchDetails(apiKey, row.source_id);
      const company = mapPlace({ ...data, id: data.id || row.source_id });
      const hours = Array.isArray(data?.regularOpeningHours?.weekdayDescriptions)
        ? data.regularOpeningHours.weekdayDescriptions.map((x: unknown) => String(x)).slice(0, 7)
        : [];
      items.push({ ...company, id: row.id, opening_hours: hours });
    } catch (e) {
      errors.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }));
}

export function osmDetailsQL(refs: Array<{ type: string; id: string }>): string {
  return `[out:json][timeout:25];\n(\n${refs.map((r) => `  ${r.type}(${r.id});`).join('\n')}\n);\nout tags;`;
}

async function refreshOsm(rows: any[], items: any[], errors: any[]) {
  const valid = rows.filter((row) => osmRef(row.source_id));
  rows.filter((row) => !osmRef(row.source_id)).forEach((row) => errors.push({ id: row.id, error: 'Identificador do OpenStreetMap inválido.' }));
  if (!valid.length) return;
  let data: any;
  try {
    data = await overpass(osmDetailsQL(valid.map((row) => osmRef(row.source_id)!)), { perServerMs: 20000, totalMs: 50000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    valid.forEach((row) => errors.push({ id: row.id, error: `${msg} Os dados mostrados são os salvos na última busca.` }));
    return;
  }
  const byRef = new Map<string, any>(data.elements.map((el: any) => [`${el.type}/${el.id}`, el]));
  for (const row of valid) {
    const el = byRef.get(row.source_id);
    if (!el?.tags?.name) {
      errors.push({ id: row.id, error: 'Empresa não encontrada no OpenStreetMap (pode ter sido removida ou renomeada).' });
      continue;
    }
    const company = mapOsm(el, { city: row.city || '', uf: row.state || '' });
    items.push({ ...company, id: row.id, opening_hours: osmHours(el.tags.opening_hours) });
  }
}

export async function handler(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const ctx = await requireUser(req);
    const ids = validateIds(await readJson(req, 10000));
    const rows: any[] = (await rpc(ctx, 'get_companies_for_refresh', { p_ids: ids })) || [];
    const items: any[] = [];
    const errors: any[] = [];

    rows.filter((r) => r.source === 'manual').forEach((row) =>
      errors.push({ id: row.id, error: 'Contato manual: não há dados de uma fonte para atualizar.' }));
    await Promise.all([
      refreshGoogle(rows.filter((r) => r.source === 'google_places'), items, errors),
      refreshOsm(rows.filter((r) => r.source === 'osm'), items, errors),
    ]);

    if (items.length) {
      await rpc(ctx, 'update_company_content', {
        p_items: items.map((c) => ({ id: c.id, ...toDbItem(c) })),
      });
    }
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    missing.forEach((id) => errors.push({ id, error: 'Empresa não encontrada.' }));
    const sources = new Set(items.map((x) => x.source));
    return json(200, {
      items,
      errors,
      attribution: [sources.has('google_places') ? 'Google Maps' : '', sources.has('osm') ? OSM_ATTRIBUTION : '']
        .filter(Boolean).join(' · '),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

serve(handler);
