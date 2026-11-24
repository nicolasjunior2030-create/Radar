// =====================================================================
// RADAR EMPRESARIAL BRASIL — Edge Function: generate-site
// Gera sites com a API oficial da Anthropic, em etapas curtas (cabem no
// limite de tempo das Edge Functions) e com resposta em streaming:
//   stage "brief"    → pesquisa na web + briefing com fontes verificadas
//   stage "html"     → cria o HTML completo a partir do briefing
//   stage "edit"     → aplica uma alteração pedida em texto
//   stage "continue" → continua um HTML interrompido (limite de tempo)
// Secrets: ANTHROPIC_API_KEY, ALLOWED_EMAILS
// Opcionais: ANTHROPIC_MODEL (padrão claude-sonnet-5-5),
//            FUNCTION_TIME_BUDGET_MS (padrão 135000; plano pago: até 380000)
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

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2026-10-21';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const PHOTO_TOKEN = '{{FOTO}}';

// ---------- Telefone (mesma regra do app) ----------
const VALID_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export function normalizeBrazilPhone(raw: string): { ok: boolean; number?: string; display?: string; kind?: string } {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d || /^0?(800|300|303|500|900)/.test(d)) return { ok: false };
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  else if (d.startsWith('0')) {
    d = d.replace(/^0+/, '');
    if (d.length === 12 || d.length === 13) d = d.slice(2);
  }
  if (d.length !== 10 && d.length !== 11) return { ok: false };
  if (!VALID_DDD.has(Number(d.slice(0, 2)))) return { ok: false };
  const local = d.slice(2);
  if (local.length === 9 && local[0] !== '9') return { ok: false };
  if (local.length === 8 && !/^[2-5]/.test(local)) return { ok: false };
  const kind = local.length === 9 ? 'celular' : 'fixo';
  const display = local.length === 9
    ? `(${d.slice(0, 2)}) ${local.slice(0, 5)}-${local.slice(5)}`
    : `(${d.slice(0, 2)}) ${local.slice(0, 4)}-${local.slice(4)}`;
  return { ok: true, number: `55${d}`, display, kind };
}

// ---------- Prompts ----------
export const BRIEF_SYSTEM = `Você é estrategista de marca e pesquisador. Sua tarefa é preparar o briefing de um site institucional para a empresa brasileira indicada.

PESQUISA
- Use a busca na web para encontrar informações verificáveis sobre ESTA empresa: site oficial, Instagram, Facebook, perfis em plataformas de delivery, notícias.
- Só use um resultado se tiver certeza razoável de que é a mesma empresa (mesmo nome e, quando conhecida, mesma cidade). Na dúvida, descarte.
- Os "dados confirmados pelo sistema" (Google Places ou OpenStreetMap), quando houver, são confiáveis e têm prioridade.
- Faça no máximo 3 buscas, de forma objetiva.

VERDADE
- Nunca invente: telefone, endereço, e-mail, CNPJ, preços, avaliações, depoimentos, números (anos de mercado, clientes atendidos), prêmios, nomes de pessoas, serviços ou produtos.
- Todo fato, serviço, produto e dado de contato precisa de fonte: a URL exata da página de onde veio, ou o nome da fonte dos dados confirmados pelo sistema ("Google Places" ou "OpenStreetMap").
- Se não encontrou algo, deixe de fora e cite em "nao_encontrado".

IDENTIDADE VISUAL
- Identifique o segmento e escolha uma identidade visual adequada a ele (e à marca, se encontrou referências reais dela): paleta em hexadecimal com contraste acessível, duas fontes do Google Fonts, estilo e tom de voz.
- Escolha as seções que fazem sentido para o negócio.

RESPOSTA
Responda SOMENTE com um objeto JSON válido, sem markdown e sem nenhum texto antes ou depois, exatamente neste formato:
{
  "empresa": {"nome": "", "segmento": "", "cidade": null, "estado": null},
  "fatos": [{"fato": "", "fonte": ""}],
  "servicos": [{"nome": "", "fonte": ""}],
  "produtos": [{"nome": "", "fonte": ""}],
  "contato": {
    "telefone": {"valor": "", "fonte": ""} ou null,
    "email": {"valor": "", "fonte": ""} ou null,
    "endereco": {"valor": "", "fonte": ""} ou null,
    "instagram": {"valor": "", "fonte": ""} ou null,
    "facebook": {"valor": "", "fonte": ""} ou null,
    "horarios": {"valor": "", "fonte": ""} ou null,
    "site_atual": {"valor": "", "fonte": ""} ou null
  },
  "identidade": {
    "estilo": "", "tom_de_voz": "",
    "paleta": {"primaria": "#RRGGBB", "secundaria": "#RRGGBB", "destaque": "#RRGGBB", "fundo": "#RRGGBB", "texto": "#RRGGBB"},
    "fonte_titulos": "", "fonte_texto": ""
  },
  "secoes": ["inicio", "apresentacao", "servicos", "produtos", "galeria", "contato"],
  "servicos_genericos_sugeridos": ["exemplos típicos do segmento, que o site mostrará como sugestões editáveis"],
  "imagens": [{"secao": "", "descricao": "foto ideal para esta seção"}],
  "nao_encontrado": [""]
}`;

export const HTML_SYSTEM = `Você é web designer e desenvolvedor front-end sênior. Crie o site institucional descrito no briefing.

ENTREGA
- Um único documento HTML5 completo, do <!DOCTYPE html> ao </html>, com CSS em <style> e no máximo um <script> curto (menu do celular). Sem frameworks e sem bibliotecas; apenas Google Fonts via <link>.
- Português do Brasil. Página única com menu fixo e âncoras para as seções do briefing ("secoes"), mais rodapé.
- Responsivo (pensado primeiro no celular), semântico e acessível: header, nav, main, section, footer; um único h1; contraste AA; foco visível; alt em todas as imagens; meta viewport; <title> e meta description.
- Visual profissional e moderno, fiel à identidade do briefing (paleta, fontes, estilo, tom). Capriche em hierarquia, espaçamento, ícones e ilustrações SVG inline, gradientes sutis e detalhes.
- Todo o conteúdo deve aparecer sem JavaScript. Animações só em CSS e desligadas em prefers-reduced-motion.
- Seja enxuto: CSS organizado, sem repetição; o arquivo inteiro com no máximo umas 800 linhas.

VERDADE ACIMA DE TUDO
- Use como fatos SOMENTE o que está no briefing. Nunca invente telefone, endereço, e-mail, CNPJ, preços, avaliações, depoimentos, números (anos de mercado, clientes atendidos), prêmios, equipe ou certificações.
- Não crie depoimentos, estrelas de avaliação nem contadores.
- Onde faltar informação, escreva textos honestos e genéricos sobre o tipo de serviço (sem afirmar nada específico sobre a empresa) ou use marcadores editáveis entre colchetes, como [Conte aqui a história da empresa]. Itens de "servicos_genericos_sugeridos" entram como exemplos, deixando claro que podem ser editados.
- Contato: mostre apenas os dados presentes no briefing. Se existir "whatsapp.url", inclua o botão "Falar no WhatsApp" (no topo e flutuante) usando exatamente essa URL. Se não existir, não crie nenhum botão ou link de WhatsApp.
- Links externos com target="_blank" rel="noopener".

IMAGENS
- Não use nenhuma URL de imagem externa.
- Ilustrações e ícones: SVG inline desenhados por você, coerentes com o segmento.
- Fotos reais (fachada, produtos, ambiente, galeria): <img src="${PHOTO_TOKEN}" data-rb-image="descrição da foto ideal" alt="descrição">, com object-fit: cover. O dono vai trocar depois.

Responda somente com o HTML, sem markdown e sem comentários antes ou depois.`;

export const EDIT_SYSTEM = `Você é desenvolvedor front-end sênior e vai editar um site existente.
- Aplique SOMENTE a alteração pedida; mantenha todo o resto do documento como está.
- Continue respeitando: nada de fatos inventados (telefone, endereço, e-mail, preços, avaliações, depoimentos, números), nada de imagens externas (fotos usam src="${PHOTO_TOKEN}" ou as URLs que já existem no documento), links externos com target="_blank" rel="noopener", conteúdo visível sem JavaScript.
- Responda somente com o documento HTML completo atualizado, do <!DOCTYPE html> ao </html>, sem markdown e sem comentários.`;

// ---------- Validação ----------
export type GenInput = {
  stage: 'brief' | 'html' | 'edit' | 'continue';
  mode: 'html' | 'edit';
  companyName: string;
  companyId: string | null;
  webSearch: boolean;
  brief: any;
  html: string;
  instruction: string;
  partial: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HTML = 400000;

export function validateGenerate(body: any): GenInput {
  const stage = body.stage;
  if (!['brief', 'html', 'edit', 'continue'].includes(stage)) throw new HttpError(400, 'Etapa inválida.');
  const mode = body.mode === 'edit' ? 'edit' : 'html';
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v : '').slice(0, max);
  const input: GenInput = {
    stage, mode,
    companyName: str(body.company_name, 200).replace(/\s+/g, ' ').trim(),
    companyId: typeof body.company_id === 'string' && UUID_RE.test(body.company_id) ? body.company_id : null,
    webSearch: body.web_search !== false,
    brief: body.brief && typeof body.brief === 'object' && !Array.isArray(body.brief) ? body.brief : null,
    html: str(body.html, MAX_HTML + 1),
    instruction: str(body.instruction, 1001).trim(),
    partial: str(body.partial, MAX_HTML + 1),
  };
  if (stage === 'brief' && (input.companyName.length < 2 || input.companyName.length > 120)) {
    throw new HttpError(400, 'Digite o nome da empresa (2 a 120 caracteres).');
  }
  if (input.brief && JSON.stringify(input.brief).length > 40000) throw new HttpError(413, 'Briefing grande demais.');
  if ((stage === 'html' || (stage === 'continue' && mode === 'html')) && !input.brief) {
    throw new HttpError(400, 'Briefing ausente.');
  }
  if (stage === 'edit' || (stage === 'continue' && mode === 'edit')) {
    if (input.html.length < 100 || input.html.length > MAX_HTML) throw new HttpError(400, 'HTML atual ausente ou grande demais.');
    if (input.instruction.length < 3 || input.instruction.length > 1000) {
      throw new HttpError(400, 'Descreva a alteração (3 a 1000 caracteres).');
    }
  }
  if (stage === 'continue' && (input.partial.length < 20 || input.partial.length > MAX_HTML)) {
    throw new HttpError(400, 'Trecho parcial inválido.');
  }
  return input;
}

// ---------- Briefing: só fica o que tem fonte verificável ----------
function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

// Dados vindos do Radar: Google Places (cache de 30 dias) ou OpenStreetMap.
export function factsUsable(facts: any): boolean {
  if (!facts) return false;
  if (facts.source === 'google_places') return !facts.expired;
  return facts.source === 'osm';
}
export const factsSourceLabel = (facts: any) => (facts?.source === 'osm' ? 'OpenStreetMap' : 'Google Places');

export type SanitizeCtx = { searchUrls: string[]; facts: any | null; companyName: string };

export function sanitizeBrief(raw: any, ctx: SanitizeCtx) {
  const hosts = new Set(ctx.searchUrls.map(hostOf).filter(Boolean));
  const factsOk = factsUsable(ctx.facts);
  const factsLabel = factsSourceLabel(ctx.facts);
  let discarded = 0;
  const avisos: string[] = [];
  const clamp = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

  const source = (f: unknown): string | null => {
    const s = clamp(f, 500);
    if (!s) return null;
    if (/google\s*places/i.test(s)) return factsOk && factsLabel === 'Google Places' ? factsLabel : null;
    if (/openstreetmap|^osm$/i.test(s)) return factsOk && factsLabel === 'OpenStreetMap' ? factsLabel : null;
    if (/^https?:\/\//i.test(s) && hosts.has(hostOf(s))) return s;
    return null;
  };
  const list = (arr: unknown, key: string, max: number, maxLen: number) => {
    const out: any[] = [];
    for (const item of Array.isArray(arr) ? arr : []) {
      const value = clamp(item?.[key], maxLen);
      const fonte = source(item?.fonte);
      if (!value) continue;
      if (!fonte) { discarded++; continue; }
      if (out.length < max) out.push({ [key]: value, fonte });
    }
    return out;
  };

  const contato: Record<string, any> = {};
  const rawContato = raw?.contato && typeof raw.contato === 'object' ? raw.contato : {};
  for (const k of ['telefone', 'email', 'endereco', 'instagram', 'facebook', 'horarios', 'site_atual']) {
    const item = rawContato[k];
    const valor = clamp(item?.valor, 200);
    if (!valor) continue;
    const fonte = source(item?.fonte);
    if (!fonte) { discarded++; continue; }
    if (k === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor)) continue;
    if (k === 'site_atual' && !/^https?:\/\//i.test(valor)) continue;
    contato[k] = { valor, fonte };
  }
  if (factsOk) {
    if (ctx.facts.phone) contato.telefone = { valor: String(ctx.facts.phone), fonte: factsLabel };
    if (ctx.facts.address) contato.endereco = { valor: String(ctx.facts.address), fonte: factsLabel };
    if (ctx.facts.website) contato.site_atual = { valor: String(ctx.facts.website), fonte: factsLabel };
  } else if (ctx.facts?.expired) {
    avisos.push('Os dados do Google para esta empresa expiraram (cache de 30 dias). Abra a empresa no Radar para atualizá-los.');
  }

  let whatsapp: any = null;
  if (contato.telefone) {
    const n = normalizeBrazilPhone(contato.telefone.valor);
    if (n.ok && n.kind === 'celular') {
      whatsapp = { numero: n.number, exibicao: n.display, url: `https://wa.me/${n.number}`, fonte: contato.telefone.fonte };
    } else if (n.ok) {
      avisos.push('O telefone encontrado é fixo: o botão de WhatsApp não foi incluído. Confirme com a empresa se ela usa WhatsApp Business.');
    }
  }

  const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : undefined);
  const font = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9 ]{2,40}$/.test(v.trim()) ? v.trim() : undefined);
  const id = raw?.identidade || {};
  const pal = id.paleta || {};
  const allowedSections = ['inicio', 'apresentacao', 'servicos', 'produtos', 'galeria', 'contato'];
  const secoes = (Array.isArray(raw?.secoes) ? raw.secoes : []).map((s: unknown) => String(s)).filter((s: string) => allowedSections.includes(s));
  for (const must of ['inicio', 'apresentacao', 'contato']) if (!secoes.includes(must)) secoes.push(must);

  const fatos = list(raw?.fatos, 'fato', 15, 300);
  const servicos = list(raw?.servicos, 'nome', 12, 100);
  const produtos = list(raw?.produtos, 'nome', 12, 100);
  if (discarded) avisos.push(`${discarded} informação(ões) sugerida(s) pela IA foram descartadas por não terem fonte verificável.`);

  const brief = {
    empresa: {
      nome: clamp(raw?.empresa?.nome, 120) || ctx.companyName,
      segmento: clamp(raw?.empresa?.segmento, 80),
      cidade: clamp(raw?.empresa?.cidade, 80) || (factsOk ? clamp(ctx.facts.city, 80) : '') || null,
      estado: clamp(raw?.empresa?.estado, 30) || (factsOk ? clamp(ctx.facts.state, 30) : '') || null,
    },
    fatos,
    servicos,
    produtos,
    contato,
    whatsapp,
    identidade: {
      estilo: clamp(id.estilo, 200),
      tom_de_voz: clamp(id.tom_de_voz, 120),
      paleta: { primaria: hex(pal.primaria), secundaria: hex(pal.secundaria), destaque: hex(pal.destaque),
                fundo: hex(pal.fundo), texto: hex(pal.texto) },
      fonte_titulos: font(id.fonte_titulos),
      fonte_texto: font(id.fonte_texto),
    },
    secoes: allowedSections.filter((s) => secoes.includes(s)),
    servicos_genericos_sugeridos: (Array.isArray(raw?.servicos_genericos_sugeridos) ? raw.servicos_genericos_sugeridos : [])
      .map((s: unknown) => clamp(s, 80)).filter(Boolean).slice(0, 8),
    imagens: (Array.isArray(raw?.imagens) ? raw.imagens : [])
      .map((i: any) => ({ secao: clamp(i?.secao, 40), descricao: clamp(i?.descricao, 160) }))
      .filter((i: any) => i.descricao).slice(0, 10),
    nao_encontrado: (Array.isArray(raw?.nao_encontrado) ? raw.nao_encontrado : [])
      .map((s: unknown) => clamp(s, 120)).filter(Boolean).slice(0, 10),
    avisos,
  };
  return { brief, discarded };
}

// Revalida o briefing recebido do navegador antes de usar (o WhatsApp é recalculado).
export function reviewBrief(brief: any) {
  const copy = JSON.parse(JSON.stringify(brief || {}));
  const tel = copy?.contato?.telefone?.valor;
  const n = tel ? normalizeBrazilPhone(String(tel)) : { ok: false };
  copy.whatsapp = n.ok && (n as any).kind === 'celular'
    ? { numero: (n as any).number, exibicao: (n as any).display, url: `https://wa.me/${(n as any).number}`,
        fonte: copy.contato.telefone.fonte }
    : null;
  return copy;
}

export function extractJson(text: string): any | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

// ---------- Montagem da chamada à Anthropic ----------
export function supportsEffort(model: string): boolean {
  return /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model);
}

export function buildRequest(input: GenInput, model: string, facts: any | null) {
  const base: Record<string, unknown> = { model, stream: true };
  if (input.stage === 'brief') {
    const lines = [`EMPRESA: ${input.companyName}`];
    if (factsUsable(facts)) {
      lines.push(`DADOS CONFIRMADOS PELO SISTEMA (${factsSourceLabel(facts)}):`);
      if (facts.name) lines.push(`- Nome no Google: ${facts.name}`);
      if (facts.category) lines.push(`- Categoria: ${facts.category}`);
      if (facts.address) lines.push(`- Endereço: ${facts.address}`);
      if (facts.city || facts.state) lines.push(`- Cidade/UF: ${[facts.city, facts.state].filter(Boolean).join(' / ')}`);
      if (facts.phone) lines.push(`- Telefone: ${facts.phone}`);
      if (facts.website) lines.push(`- Site atual: ${facts.website}`);
    } else {
      lines.push('Não há dados confirmados pelo sistema; dependa só da pesquisa.');
    }
    lines.push(input.webSearch ? 'Pesquise e prepare o briefing.' : 'Sem pesquisa na web nesta vez: prepare o briefing só com os dados acima.');
    const req: Record<string, unknown> = {
      ...base,
      max_tokens: 8000,
      system: BRIEF_SYSTEM,
      messages: [{ role: 'user', content: lines.join('\n') }],
    };
    if (input.webSearch) {
      const loc: Record<string, string> = { type: 'approximate', country: 'BR', timezone: 'America/Sao_Paulo' };
      if (facts?.city) loc.city = String(facts.city).slice(0, 80);
      req.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4, user_location: loc }];
    }
    if (supportsEffort(model)) req.output_config = { effort: 'medium' };
    return req;
  }

  const briefText = input.brief ? JSON.stringify(reviewBrief(input.brief), null, 1) : 'não disponível';
  let system = HTML_SYSTEM;
  let content = '';
  if (input.stage === 'html') {
    content = `BRIEFING VERIFICADO (JSON):\n${briefText}\n\nCrie agora o site completo.`;
  } else if (input.stage === 'edit') {
    system = EDIT_SYSTEM;
    content = `PEDIDO DE ALTERAÇÃO:\n${input.instruction}\n\nFATOS VERIFICADOS (briefing):\n${briefText}\n\nHTML ATUAL:\n${input.html}`;
  } else {
    const context = input.mode === 'edit'
      ? `PEDIDO DE ALTERAÇÃO:\n${input.instruction}\n\nHTML ORIGINAL (antes da alteração):\n${input.html}`
      : `BRIEFING VERIFICADO (JSON):\n${briefText}`;
    if (input.mode === 'edit') system = EDIT_SYSTEM;
    content = `${context}\n\nVocê estava escrevendo o documento HTML abaixo e a resposta foi interrompida. ` +
      'Continue EXATAMENTE a partir do último caractere: não repita nada do que já está escrito, não use markdown, ' +
      'não comente. Termine o documento com </html>.\n\nHTML JÁ ESCRITO ATÉ AGORA:\n' + input.partial;
  }
  const req: Record<string, unknown> = {
    ...base,
    max_tokens: 32000,
    system,
    messages: [{ role: 'user', content }],
  };
  if (supportsEffort(model)) req.output_config = { effort: 'low' };
  return req;
}

export function anthropicError(status: number, data: any): string {
  const type = data?.error?.type || '';
  const msg = String(data?.error?.message || `HTTP ${status}`);
  if (status === 401 || type === 'authentication_error') return 'Chave da Anthropic inválida. Confira o secret ANTHROPIC_API_KEY.';
  if (status === 403 || type === 'permission_error') return `A chave da Anthropic não tem permissão: ${msg}`;
  if (status === 404 || type === 'not_found_error') return `Modelo não encontrado (${msg}). Ajuste o secret ANTHROPIC_MODEL.`;
  if (status === 429 || type === 'rate_limit_error') return 'Limite de uso da API da Anthropic atingido. Aguarde um pouco e tente de novo.';
  if (status === 529 || type === 'overloaded_error') return 'A API da Anthropic está sobrecarregada no momento. Tente novamente em instantes.';
  if (/credit balance/i.test(msg)) return 'Saldo de créditos da Anthropic insuficiente. Adicione créditos no Claude Console.';
  return `API da Anthropic: ${msg}`;
}

// Lê os eventos SSE da resposta da Anthropic.
export async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<any> {
  const reader = body.getReader();
  const stop = () => { reader.cancel().catch(() => {}); };
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop);
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let match: RegExpMatchArray | null;
      while ((match = buf.match(/\r?\n\r?\n/)) && match.index !== undefined) {
        const raw = buf.slice(0, match.index);
        buf = buf.slice(match.index + match[0].length);
        const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        try { yield JSON.parse(data); } catch { /* evento ilegível: ignora */ }
      }
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

// ---------- Handler ----------
export async function handler(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  const startedAt = Date.now();
  let ctx: Ctx;
  let input: GenInput;
  let facts: any = null;
  const apiKey = env('ANTHROPIC_API_KEY');
  const model = env('ANTHROPIC_MODEL') || DEFAULT_MODEL;
  const budget = (globalThis as any).__RADAR_TEST_BUDGET__ ||
    Math.min(Math.max(Number(env('FUNCTION_TIME_BUDGET_MS')) || 135000, 30000), 390000);
  const abort = new AbortController();
  let upstream: Response;
  try {
    ctx = await requireUser(req);
    input = validateGenerate(await readJson(req, 1200000));
    if (!apiKey) throw new HttpError(503, 'API da Anthropic não configurada: defina o secret ANTHROPIC_API_KEY no Supabase.');
    if (input.stage === 'brief' && input.companyId) facts = await rpc(ctx, 'get_company_facts', { p_company_id: input.companyId });
    try {
      upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify(buildRequest(input, model, facts)),
        signal: abort.signal,
      });
    } catch {
      throw new HttpError(502, 'Não foi possível alcançar a API da Anthropic.');
    }
    if (!upstream.ok || !upstream.body) {
      const data = await upstream.json().catch(() => ({}));
      throw new HttpError(upstream.status === 401 ? 502 : upstream.status >= 500 ? 502 : 400, anthropicError(upstream.status, data));
    }
  } catch (err) {
    return errorResponse(err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { closed = true; }
      };
      const keepAlive = setInterval(() => {
        if (!closed) { try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { closed = true; } }
      }, 15000);
      const timer = setTimeout(() => abort.abort(), Math.max(0, budget - (Date.now() - startedAt)));

      (async () => {
        let text = '';
        let stopReason = '';
        let timedOut = false;
        const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
        const sources = new Map<string, { url: string; title: string }>();
        const blocks = new Map<number, { type: string; json: string }>();
        const isBrief = input.stage === 'brief';
        let pending = '';
        const flush = () => { if (pending) { send({ type: 'delta', text: pending }); pending = ''; } };
        const onText = (t: string) => {
          if (!t) return;
          text += t;
          if (isBrief) return;
          pending += t;
          if (pending.length >= 400) flush();
        };

        try {
          for await (const ev of sseEvents(upstream.body!, abort.signal)) {
            if (ev.type === 'message_start') {
              usage.input_tokens += ev.message?.usage?.input_tokens || 0;
            } else if (ev.type === 'content_block_start') {
              const b = ev.content_block || {};
              blocks.set(ev.index, { type: b.type, json: '' });
              if (b.type === 'text' && b.text) onText(b.text);
              if (b.type === 'server_tool_use' && b.input && b.input.query) {
                send({ type: 'search', query: String(b.input.query).slice(0, 200) });
                blocks.set(ev.index, { type: 'server_tool_use_done', json: '' });
              }
              if (b.type === 'web_search_tool_result') {
                usage.web_searches++;
                if (Array.isArray(b.content)) {
                  const items = b.content.filter((r: any) => r?.type === 'web_search_result' && r.url)
                    .map((r: any) => ({ url: String(r.url), title: String(r.title || r.url).slice(0, 200) }));
                  items.forEach((it: any) => { if (sources.size < 40) sources.set(it.url, it); });
                  send({ type: 'results', items: items.slice(0, 8) });
                } else {
                  send({ type: 'search_error', code: String(b.content?.error_code || 'erro') });
                }
              }
            } else if (ev.type === 'content_block_delta') {
              const d = ev.delta || {};
              if (d.type === 'text_delta') onText(d.text || '');
              else if (d.type === 'input_json_delta') {
                const b = blocks.get(ev.index);
                if (b) b.json += d.partial_json || '';
              }
            } else if (ev.type === 'content_block_stop') {
              const b = blocks.get(ev.index);
              if (b && b.type === 'server_tool_use') {
                try {
                  const q = JSON.parse(b.json || '{}').query;
                  if (q) send({ type: 'search', query: String(q).slice(0, 200) });
                } catch { /* consulta ilegível */ }
              }
            } else if (ev.type === 'message_delta') {
              stopReason = ev.delta?.stop_reason || stopReason;
              if (typeof ev.usage?.output_tokens === 'number') usage.output_tokens = ev.usage.output_tokens;
            } else if (ev.type === 'error') {
              throw new Error(anthropicError(ev.error?.type === 'overloaded_error' ? 529 : 500, { error: ev.error }));
            }
          }
        } catch (e) {
          if (!abort.signal.aborted) throw e;
        }
        timedOut = abort.signal.aborted;
        flush();

        if (stopReason === 'refusal') throw new Error('A IA recusou gerar este conteúdo. Revise o nome ou o pedido.');
        if (stopReason === 'model_context_window_exceeded') throw new Error('O conteúdo ficou grande demais para a IA processar.');

        if (isBrief) {
          if (timedOut) throw new Error('A pesquisa demorou mais que o limite de tempo. Tente novamente ou gere sem pesquisa na web.');
          const raw = extractJson(text);
          if (!raw) throw new Error('A IA não devolveu um briefing válido. Tente novamente.');
          const { brief } = sanitizeBrief(raw, { searchUrls: [...sources.keys()], facts, companyName: input.companyName });
          send({ type: 'brief', brief, sources: [...sources.values()] });
        }
        send({ type: 'done', stop_reason: timedOut ? 'time_budget' : stopReason || 'end_turn', usage, model });
      })()
        .catch((e) => send({ type: 'error', message: e instanceof Error ? e.message : String(e) }))
        .finally(() => {
          clearInterval(keepAlive);
          clearTimeout(timer);
          if (!closed) { closed = true; try { controller.close(); } catch { /* já fechado */ } }
        });
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { ...CORS_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  });
}

serve(handler);
