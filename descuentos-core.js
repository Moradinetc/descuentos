// Descuentos en Odoo — etcétera accesorios
// Variables de entorno (Vercel › Settings › Environment Variables): ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY, APP_KEY
//
// Acciones (POST JSON { accion, ... }):
//   config    → opciones válidas de descuento, mapeo etiqueta/categoría POS y avisos
//   buscar    → productos por referencia/nombre y filtro de descuento actual
//   resolver  → referencias internas (Excel) → plantillas de producto
//   aplicar   → escribe los cambios en product.template y verifica releyendo

const base = () => (process.env.ODOO_URL || 'https://etcetera.xmarts.net')
  .replace(/\/odoo\/?$/, '').replace(/\/+$/, '');
const DB = () => process.env.ODOO_DB;
const USER = () => process.env.ODOO_USER;
const KEY = () => process.env.ODOO_API_KEY || process.env.ODOO_KEY || process.env.ODOO_PASSWORD;

const MODELO = 'product.template';
const SIN = 'Sin descuento';

// Mapeo descuento → etiqueta (product.tag) y categoría POS (pos.category).
// IDs leídos de Odoo el 2026-10-05; `config` verifica que sigan existiendo con ese nombre.
const MAPEO = {
  'Sin descuento': { tag: 8,  tagNombre: 'Sin descuento',  pos: 6, posNombre: 'Sin descuento' },
  '20%':           { tag: 24, tagNombre: 'Descuento 20%',  pos: 2, posNombre: 'Descuento 20%' },
  '30%':           { tag: 28, tagNombre: '30%',            pos: 8, posNombre: 'Descuento 30%' },
  '40%':           { tag: 27, tagNombre: 'Descuento 40%',  pos: 4, posNombre: 'Descuento 40%' },
  '50%':           { tag: 26, tagNombre: 'Descuento 50%',  pos: 5, posNombre: 'Descuento 50%' },
  '2x1':           { tag: 25, tagNombre: 'Descuento 2x1',  pos: 3, posNombre: 'Descuento 2x1' },
  '2do al 50%':    { tag: 30, tagNombre: '2do al 50%',     pos: 9, posNombre: 'Descuento 2do al 50%' },
};
// Categoría padre "Con descuento" (id 1): algunos productos la traen sola; se limpia al cambiar.
const POS_PADRE = 1;
const TAGS_GESTIONADAS = [...new Set(Object.values(MAPEO).map(m => m.tag))];
const POS_GESTIONADAS = [...new Set(Object.values(MAPEO).map(m => m.pos).concat(POS_PADRE))];

const CAMPOS = ['id', 'default_code', 'name', 'list_price', 'active',
  'x_descuento_ident', 'x_descuento_anterior', 'x_activacion_descuento', 'x_desactivacion_descuento',
  'product_tag_ids', 'pos_categ_ids'];

let uidCache = null;
let selCache = null;

async function rpc(service, method, args) {
  const r = await fetch(base() + '/jsonrpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
  });
  if (!r.ok) throw new Error('Odoo HTTP ' + r.status);
  const j = await r.json();
  if (j.error) {
    const msg = (j.error.data && j.error.data.message) || j.error.message || 'Error de Odoo';
    throw new Error('Odoo: ' + msg);
  }
  return j.result;
}

async function uid() {
  if (uidCache) return uidCache;
  if (!DB() || !USER() || !KEY()) throw new Error('Faltan variables ODOO_DB, ODOO_USER u ODOO_API_KEY en Vercel (Settings › Environment Variables)');
  const u = await rpc('common', 'login', [DB(), USER(), KEY()]);
  if (!u) throw new Error('Odoo rechazó el usuario o la API key');
  uidCache = u;
  return u;
}

async function call(model, method, args = [], kwargs = {}) {
  const u = await uid();
  return rpc('object', 'execute_kw', [DB(), u, KEY(), model, method, args, kwargs]);
}

const searchRead = (model, domain, fields, opts = {}) =>
  call(model, 'search_read', [domain], Object.assign({ fields, context: { active_test: true } }, opts));

const trozos = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const hoy = () => new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10); // hora Pacífico aprox.

// Opciones de selección reales de los dos campos (por si agregan opciones en Odoo)
async function selecciones() {
  if (selCache) return selCache;
  const f = await call(MODELO, 'fields_get', [['x_descuento_ident', 'x_descuento_anterior']], { attributes: ['selection', 'string'] });
  const val = k => ((f[k] && f[k].selection) || []).map(s => s[0]);
  selCache = { actual: val('x_descuento_ident'), anterior: val('x_descuento_anterior') };
  return selCache;
}

function limpiarProducto(p) {
  return {
    id: p.id,
    ref: p.default_code || '',
    nombre: p.name,
    precio: p.list_price,
    actual: p.x_descuento_ident || SIN,
    actualVacio: !p.x_descuento_ident,
    anterior: p.x_descuento_anterior || '',
    activacion: p.x_activacion_descuento || '',
    desactivacion: p.x_desactivacion_descuento || '',
    tags: p.product_tag_ids || [],
    pos: p.pos_categ_ids || [],
  };
}

// Misma lógica que usa la página para la vista previa. El servidor recalcula siempre con los datos vivos.
function planear(p, nuevo, fecha, sel) {
  const m = MAPEO[nuevo];
  if (!m) return { estado: 'error', msg: `"${nuevo}" no tiene etiqueta/categoría configurada` };
  if (!sel.actual.includes(nuevo)) return { estado: 'error', msg: `"${nuevo}" no es una opción de Descuento actual en Odoo` };
  const actual = p.actual;
  const tagsG = p.tags.filter(t => TAGS_GESTIONADAS.includes(t));
  const posG = p.pos.filter(c => POS_GESTIONADAS.includes(c));
  const etiquetasOk = tagsG.length === 1 && tagsG[0] === m.tag && posG.length === 1 && posG[0] === m.pos;
  const cmdsTags = TAGS_GESTIONADAS.filter(t => t !== m.tag).map(t => [3, t]).concat([[4, m.tag]]);
  const cmdsPos = POS_GESTIONADAS.filter(c => c !== m.pos).map(c => [3, c]).concat([[4, m.pos]]);

  if (actual === nuevo) {
    const vals = { product_tag_ids: cmdsTags, pos_categ_ids: cmdsPos };
    if (p.actualVacio) vals.x_descuento_ident = nuevo;
    if (etiquetasOk && !p.actualVacio) return { estado: 'sin_cambio', tipo: 'sin_cambio' };
    return { estado: 'ok', tipo: 'corregir', vals, clave: 'corregir|' + nuevo + '|' + (p.actualVacio ? 'v' : '') };
  }
  if (!sel.anterior.includes(actual)) {
    return { estado: 'error', msg: `Odoo no acepta "${actual}" en Descuento anterior (falta esa opción en el campo)` };
  }
  const vals = {
    product_tag_ids: cmdsTags,
    pos_categ_ids: cmdsPos,
    x_descuento_ident: nuevo,
    x_descuento_anterior: actual,
  };
  let tipo;
  if (nuevo === SIN) {
    tipo = 'quitar';
    vals.x_desactivacion_descuento = fecha;
  } else {
    tipo = actual === SIN ? 'activar' : 'cambiar';
    vals.x_activacion_descuento = fecha;
    vals.x_desactivacion_descuento = false;
  }
  return { estado: 'ok', tipo, vals, clave: [tipo, nuevo, actual].join('|') };
}

// ---------- acciones ----------

async function accionConfig() {
  const sel = await selecciones();
  const [tags, pos] = await Promise.all([
    call('product.tag', 'read', [TAGS_GESTIONADAS, ['name']]),
    call('pos.category', 'read', [POS_GESTIONADAS, ['name']]),
  ]);
  const tagN = Object.fromEntries(tags.map(t => [t.id, t.name]));
  const posN = Object.fromEntries(pos.map(c => [c.id, c.name]));
  const avisos = [];
  for (const [d, m] of Object.entries(MAPEO)) {
    if (!tagN[m.tag]) avisos.push(`La etiqueta id ${m.tag} (${m.tagNombre}) ya no existe en Odoo`);
    else if (tagN[m.tag] !== m.tagNombre) avisos.push(`La etiqueta id ${m.tag} se llama "${tagN[m.tag]}" (se esperaba "${m.tagNombre}")`);
    if (!posN[m.pos]) avisos.push(`La categoría POS id ${m.pos} (${m.posNombre}) ya no existe en Odoo`);
    else if (posN[m.pos] !== m.posNombre) avisos.push(`La categoría POS id ${m.pos} se llama "${posN[m.pos]}" (se esperaba "${m.posNombre}")`);
    if (!sel.actual.includes(d)) avisos.push(`"${d}" no está en las opciones de Descuento actual`);
  }
  for (const d of sel.actual) {
    if (!MAPEO[d]) avisos.push(`"${d}" existe en Odoo pero la app no tiene etiqueta/categoría para él`);
    if (!sel.anterior.includes(d)) avisos.push(`"${d}" no existe en Descuento anterior: los productos que hoy lo tengan no se podrán cambiar ni quitar`);
  }
  return {
    opciones: sel.actual.filter(d => MAPEO[d]),
    opcionesAnterior: sel.anterior,
    mapeo: MAPEO,
    tagsGestionadas: TAGS_GESTIONADAS,
    posGestionadas: POS_GESTIONADAS,
    nombresTags: tagN,
    nombresPos: posN,
    hoy: hoy(),
    avisos,
  };
}

async function accionBuscar(b) {
  const texto = String(b.texto || '').trim();
  const domain = [];
  if (texto) {
    const partes = texto.split(/\s+/).filter(Boolean).slice(0, 5);
    for (const t of partes) domain.push('|', ['default_code', 'ilike', t], ['name', 'ilike', t]);
  }
  if (b.descuento) {
    if (b.descuento === SIN) domain.push('|', ['x_descuento_ident', '=', SIN], ['x_descuento_ident', '=', false]);
    else domain.push(['x_descuento_ident', '=', b.descuento]);
  }
  const limit = Math.min(Number(b.limit) || 100, 500);
  const offset = Math.max(Number(b.offset) || 0, 0);
  const [total, rows] = await Promise.all([
    call(MODELO, 'search_count', [domain]),
    searchRead(MODELO, domain, CAMPOS, { limit, offset, order: 'default_code asc, id asc' }),
  ]);
  return { total, offset, limit, productos: rows.map(limpiarProducto) };
}

async function accionResolver(b) {
  const refs = [...new Set((b.refs || []).map(r => String(r).trim()).filter(Boolean))];
  if (refs.length > 5000) throw new Error('Máximo 5,000 referencias por archivo');
  const porRef = {}; // ref → Map(id → producto)
  const add = (ref, p) => { (porRef[ref] = porRef[ref] || new Map()).set(p.id, p); };
  const upper = new Map(refs.map(r => [r.toUpperCase(), r]));

  for (const lote of trozos(refs, 400)) {
    const plant = await searchRead(MODELO, [['default_code', 'in', lote]], CAMPOS);
    for (const p of plant) add(upper.get(String(p.default_code).toUpperCase()) || p.default_code, limpiarProducto(p));
  }
  // Variantes: referencias que no están en la plantilla
  const faltan = refs.filter(r => !porRef[r]);
  for (const lote of trozos(faltan, 400)) {
    const vars = await searchRead('product.product', [['default_code', 'in', lote]], ['default_code', 'product_tmpl_id']);
    if (!vars.length) continue;
    const tmplIds = [...new Set(vars.map(v => v.product_tmpl_id[0]))];
    const plant = await call(MODELO, 'read', [tmplIds, CAMPOS]);
    const byId = Object.fromEntries(plant.map(p => [p.id, limpiarProducto(p)]));
    for (const v of vars) {
      const p = byId[v.product_tmpl_id[0]];
      if (p) add(upper.get(String(v.default_code).toUpperCase()) || v.default_code, Object.assign({}, p, { porVariante: true }));
    }
  }
  // Coincidencias sin distinguir mayúsculas que el "in" exacto no encontró
  const sinMatch = refs.filter(r => !porRef[r]);
  for (const lote of trozos(sinMatch, 40)) {
    const domain = [];
    lote.forEach((r, i) => { if (i) domain.unshift('|'); domain.push(['default_code', '=ilike', r]); });
    const plant = await searchRead(MODELO, domain, CAMPOS);
    for (const p of plant) {
      const r = upper.get(String(p.default_code).toUpperCase());
      if (r) add(r, limpiarProducto(p));
    }
  }
  const resultado = {};
  for (const r of refs) resultado[r] = porRef[r] ? [...porRef[r].values()] : [];
  return { resultado };
}

async function accionAplicar(b) {
  const cambios = Array.isArray(b.cambios) ? b.cambios : [];
  if (!cambios.length) throw new Error('No hay cambios que aplicar');
  if (cambios.length > 300) throw new Error('Máximo 300 productos por llamada');
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(b.fecha || '') ? b.fecha : hoy();
  const sel = await selecciones();

  const ids = [...new Set(cambios.map(c => Number(c.id)).filter(Boolean))];
  const nuevoPorId = {};
  for (const c of cambios) nuevoPorId[Number(c.id)] = String(c.nuevo);

  const vivos = (await call(MODELO, 'read', [ids, CAMPOS])).map(limpiarProducto);
  const vivoPorId = Object.fromEntries(vivos.map(p => [p.id, p]));
  const resultados = {};
  const grupos = {};

  for (const id of ids) {
    const p = vivoPorId[id];
    if (!p) { resultados[id] = { estado: 'error', msg: 'El producto ya no existe o está archivado' }; continue; }
    const plan = planear(p, nuevoPorId[id], fecha, sel);
    resultados[id] = { estado: plan.estado, tipo: plan.tipo, msg: plan.msg, antes: p.actual, nuevo: nuevoPorId[id], ref: p.ref };
    if (plan.estado === 'ok') {
      (grupos[plan.clave] = grupos[plan.clave] || { vals: plan.vals, ids: [] }).ids.push(id);
    }
  }

  for (const g of Object.values(grupos)) {
    for (const lote of trozos(g.ids, 100)) {
      try {
        await call(MODELO, 'write', [lote, g.vals]);
        lote.forEach(id => { resultados[id].estado = 'escrito'; });
      } catch (e) {
        // si el lote falla, intenta uno por uno para aislar el producto problemático
        for (const id of lote) {
          try { await call(MODELO, 'write', [[id], g.vals]); resultados[id].estado = 'escrito'; }
          catch (e2) { resultados[id].estado = 'error'; resultados[id].msg = e2.message; }
        }
      }
    }
  }

  // Verificación: relee lo escrito
  const escritos = ids.filter(id => resultados[id].estado === 'escrito');
  if (escritos.length) {
    const despues = (await call(MODELO, 'read', [escritos, CAMPOS])).map(limpiarProducto);
    for (const p of despues) {
      const r = resultados[p.id];
      const m = MAPEO[r.nuevo];
      const okTag = p.tags.includes(m.tag) && p.tags.filter(t => TAGS_GESTIONADAS.includes(t)).length === 1;
      const okPos = p.pos.includes(m.pos) && p.pos.filter(c => POS_GESTIONADAS.includes(c)).length === 1;
      const okDesc = p.actual === r.nuevo;
      if (okTag && okPos && okDesc) r.estado = 'verificado';
      else { r.estado = 'error'; r.msg = 'Se escribió pero la relectura no coincide (revisar en Odoo)'; }
      r.despues = p;
    }
  }
  return { fecha, resultados };
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-app-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const res = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });

  try {
    const appKey = process.env.APP_KEY;
    const enviada = (event.headers && (event.headers['x-app-key'] || event.headers['X-App-Key'])) || '';
    if (appKey && enviada !== appKey) return res(401, { error: 'Clave de acceso incorrecta' });

    if (event.httpMethod === 'GET') return res(200, { ok: true, servicio: 'descuentos', requiereClave: !!appKey });
    if (event.httpMethod !== 'POST') return res(405, { error: 'Método no permitido' });

    let b = {};
    try { b = JSON.parse(event.body || '{}'); } catch { return res(400, { error: 'JSON inválido' }); }

    switch (b.accion) {
      case 'config': return res(200, await accionConfig());
      case 'buscar': return res(200, await accionBuscar(b));
      case 'resolver': return res(200, await accionResolver(b));
      case 'aplicar': return res(200, await accionAplicar(b));
      default: return res(400, { error: 'Acción desconocida' });
    }
  } catch (e) {
    return res(500, { error: e.message || String(e) });
  }
};

// Exportado para pruebas locales
exports._planear = planear;
exports._MAPEO = MAPEO;
