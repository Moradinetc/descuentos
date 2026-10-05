"use strict";
const API = '/api/descuentos';
const SIN = 'Sin descuento';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtF = f => f ? f.split('-').reverse().join('/') : '—';
const fmt$ = n => n == null ? '' : '$' + Number(n).toLocaleString('es-MX', {minimumFractionDigits:2, maximumFractionDigits:2});

let CFG = null;
let CLAVE = '';
try { CLAVE = localStorage.getItem('desc_app_key') || ''; } catch (e) {}

const estado = {
  busqueda: { texto:'', descuento:'', offset:0, limit:100, total:0, productos:[] },
  seleccion: new Map(),     // id → producto
  descBarra: null,
  cambios: new Map(),       // id → { p, nuevo, origen }
  resultados: new Map(),    // id → resultado del servidor
  filtro: 'todos',
  bitacora: [],
};

// ---------- descargas ----------
// El archivo va completo dentro del enlace (data:), sin URL temporal blob:, para que
// funcione aunque una extensión de Chrome intercepte las descargas. Si es muy grande, usa blob:.
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function descargarXlsx(wb, nombre) {
  try {
    const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64', compression: true });
    const a = document.createElement('a');
    a.download = nombre;
    a.rel = 'noopener';
    a.style.display = 'none';
    let url = null;
    if (b64.length < 1500000) {
      a.href = 'data:' + MIME_XLSX + ';base64,' + b64;
    } else {
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      url = URL.createObjectURL(new Blob([bytes], { type: MIME_XLSX }));
      a.href = url;
    }
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); if (url) URL.revokeObjectURL(url); }, 300000);
    toast('Descargando ' + nombre);
  } catch (e) {
    toast('No se pudo generar el archivo: ' + e.message, 6000);
  }
}

// ---------- API ----------
async function api(body) {
  const r = await fetch(API, { method:'POST', headers:{'Content-Type':'application/json','x-app-key':CLAVE}, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch (e) { throw new Error('Respuesta inválida del servidor (' + r.status + ')'); }
  if (r.status === 401) { pedirClave('La clave no es correcta.'); throw new Error('Clave de acceso incorrecta'); }
  if (!r.ok || j.error) throw new Error(j.error || ('Error ' + r.status));
  return j;
}

function toast(t, ms = 3500) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = t;
  document.body.appendChild(d); setTimeout(() => d.remove(), ms);
}

function pedirClave(err) {
  $('#errClave').textContent = err || '';
  if (!$('#dlgClave').open) $('#dlgClave').showModal();
  setTimeout(() => $('#inClave').focus(), 50);
}
$('#btnClave').onclick = () => {
  CLAVE = $('#inClave').value.trim();
  try { localStorage.setItem('desc_app_key', CLAVE); } catch (e) {}
  $('#dlgClave').close();
  iniciar();
};
$('#inClave').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnClave').click(); });

// ---------- lógica de descuento (igual a la del servidor) ----------
function planear(p, nuevo) {
  const m = CFG.mapeo[nuevo];
  if (!m) return { estado:'error', tipo:'error', msg:`"${nuevo}" no es un descuento válido` };
  const actual = p.actual;
  const tagsG = p.tags.filter(t => CFG.tagsGestionadas.includes(t));
  const posG = p.pos.filter(c => CFG.posGestionadas.includes(c));
  const etiquetasOk = tagsG.length === 1 && tagsG[0] === m.tag && posG.length === 1 && posG[0] === m.pos;
  if (actual === nuevo) {
    if (etiquetasOk && !p.actualVacio) return { estado:'sin_cambio', tipo:'sin_cambio', anterior: p.anterior };
    return { estado:'ok', tipo:'corregir', anterior: p.anterior, msg:'Ya tiene ese descuento; se corrigen etiqueta y categoría POS' };
  }
  if (!CFG.opcionesAnterior.includes(actual)) {
    return { estado:'error', tipo:'error', msg:`Odoo no acepta "${actual}" en Descuento anterior. Agrega esa opción al campo en Odoo.` };
  }
  return { estado:'ok', tipo: nuevo === SIN ? 'quitar' : (actual === SIN ? 'activar' : 'cambiar'), anterior: actual };
}
const NOMBRE_TIPO = { activar:'Activar', cambiar:'Cambiar', quitar:'Quitar', corregir:'Corregir etiquetas', sin_cambio:'Sin cambio', error:'Error', verificado:'Aplicado ✓' };

function etq(d) { return `<span class="etq ${d === SIN ? 'sin' : ''}">${esc(d)}</span>`; }

// Normaliza lo que venga del Excel a una opción de Odoo
function normDesc(v) {
  if (v == null) return '';
  if (typeof v === 'number') {
    if (v === 0) return SIN;
    const n = v > 0 && v <= 1 ? Math.round(v * 100) : Math.round(v);
    return n + '%';
  }
  const s = String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (/^(sin( desc(uento)?)?|quitar|quitar descuento|ninguno|no|0|0 ?%|n\/a|-|s\/d)$/.test(s)) return SIN;
  if (/^2 ?x ?1$|^desc(uento)? 2 ?x ?1$/.test(s)) return '2x1';
  if (/(2 ?do|2°|2º|segundo|2a|2da) ?(al|a)? ?50/.test(s)) return '2do al 50%';
  const m = s.match(/^(?:desc(?:uento)?\s*)?(\d+(?:[.,]\d+)?)\s*(%)?$/);
  if (m) {
    let n = parseFloat(m[1].replace(',', '.'));
    if (!m[2] && n > 0 && n <= 1) n = n * 100;
    return Math.round(n) + '%';
  }
  return String(v).trim();
}
function descValido(d) {
  return CFG.opciones.find(o => o.toLowerCase() === String(d).toLowerCase()) || null;
}

// ---------- inicio ----------
async function iniciar() {
  try {
    const g = await fetch(API, { headers:{'x-app-key':CLAVE} });
    if (g.status === 401) { pedirClave(CLAVE ? 'La clave no es correcta.' : ''); return; }
    CFG = await api({ accion:'config' });
    $('#punto').className = 'punto ok';
    $('#txtCon').textContent = 'Conectado a Odoo';
    $('#fecha').value = $('#fecha').value || CFG.hoy;
    try { $('#usuario').value = localStorage.getItem('desc_usuario') || ''; } catch (e) {}
    $('#fDesc').innerHTML = '<option value="">Cualquier descuento</option>' + CFG.opciones.map(o => `<option>${esc(o)}</option>`).join('');
    pintarSelectorBarra();
    if (CFG.avisos.length) {
      $('#avisosCfg').innerHTML = `<div class="aviso warn"><b>Revisar configuración en Odoo</b><a class='ayuda' href='manual.html#errores' target='_blank' rel='noopener' title='Qué significa este aviso' aria-label='Qué significa este aviso'>?</a><ul>${CFG.avisos.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>`;
    }
  } catch (e) {
    $('#punto').className = 'punto err';
    $('#txtCon').textContent = 'Sin conexión';
    $('#avisosCfg').innerHTML = `<div class="aviso err"><b>No se pudo conectar con Odoo.</b><a class='ayuda' href='manual.html#errores' target='_blank' rel='noopener' title='Qué hacer' aria-label='Qué hacer'>?</a> ${esc(e.message)}</div>`;
  }
}

// ---------- pestañas ----------
document.querySelectorAll('.pestanas button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.pestanas button').forEach(x => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('.vista').forEach(v => v.classList.toggle('activa', v.id === b.dataset.v));
});

// ---------- búsqueda y selección ----------
async function buscar(offset = 0) {
  if (!CFG) return toast('Todavía no hay conexión con Odoo');
  const b = estado.busqueda;
  b.texto = $('#q').value.trim(); b.descuento = $('#fDesc').value; b.offset = offset;
  if (!b.texto && !b.descuento) return toast('Escribe una referencia o nombre, o elige un descuento');
  $('#tbRes').innerHTML = '<tr><td colspan="8" class="vacio">Buscando…</td></tr>';
  try {
    const r = await api({ accion:'buscar', texto:b.texto, descuento:b.descuento, offset, limit:b.limit });
    b.total = r.total; b.productos = r.productos;
    pintarResultados();
  } catch (e) {
    $('#tbRes').innerHTML = `<tr><td colspan="8" class="vacio msg">${esc(e.message)}</td></tr>`;
  }
}
$('#btnBuscar').onclick = () => buscar(0);
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter') buscar(0); });
$('#fDesc').onchange = () => buscar(0);

function pintarResultados() {
  const b = estado.busqueda;
  if (!b.productos.length) {
    $('#tbRes').innerHTML = '<tr><td colspan="8" class="vacio">No hay productos con ese criterio.</td></tr>';
  } else {
    $('#tbRes').innerHTML = b.productos.map(p => {
      const s = estado.seleccion.has(p.id), enCambios = estado.cambios.has(p.id);
      return `<tr class="${s ? 'sel' : ''}" data-id="${p.id}">
        <td><input type="checkbox" ${s ? 'checked' : ''} aria-label="Seleccionar ${esc(p.ref)}"></td>
        <td class="ref">${esc(p.ref || '—')}${enCambios ? ' <span class="pill p-cambiar" title="Ya está en la lista de cambios">en lista</span>' : ''}</td>
        <td class="nom" title="${esc(p.nombre)}">${esc(p.nombre)}</td>
        <td class="num">${fmt$(p.precio)}</td>
        <td>${etq(p.actual)}</td>
        <td>${p.anterior ? esc(p.anterior) : '<span class="sub">—</span>'}</td>
        <td class="fecha">${fmtF(p.activacion)}</td>
        <td class="fecha">${fmtF(p.desactivacion)}</td></tr>`;
    }).join('');
  }
  const ini = b.total ? b.offset + 1 : 0, fin = b.offset + b.productos.length;
  $('#infoBusq').textContent = `${b.total.toLocaleString('es-MX')} productos · mostrando ${ini}–${fin}`;
  $('#paginacion').innerHTML = (b.offset > 0 ? `<button class="btn chico" id="pAnt">Anteriores</button>` : '') +
    (fin < b.total ? `<button class="btn chico" id="pSig">Siguientes ${b.limit}</button>` : '');
  if ($('#pAnt')) $('#pAnt').onclick = () => buscar(Math.max(0, b.offset - b.limit));
  if ($('#pSig')) $('#pSig').onclick = () => buscar(b.offset + b.limit);
  $('#chkPagina').checked = b.productos.length > 0 && b.productos.every(p => estado.seleccion.has(p.id));
  pintarBarra();
}

$('#tbRes').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const id = Number(tr.dataset.id);
  const p = estado.busqueda.productos.find(x => x.id === id);
  if (e.target.tagName !== 'INPUT') { const c = tr.querySelector('input'); c.checked = !c.checked; }
  if (tr.querySelector('input').checked) estado.seleccion.set(id, p); else estado.seleccion.delete(id);
  tr.classList.toggle('sel', estado.seleccion.has(id));
  $('#chkPagina').checked = estado.busqueda.productos.every(x => estado.seleccion.has(x.id));
  pintarBarra();
});
$('#chkPagina').onchange = e => {
  for (const p of estado.busqueda.productos) e.target.checked ? estado.seleccion.set(p.id, p) : estado.seleccion.delete(p.id);
  pintarResultados();
};
$('#btnLimpiarSel').onclick = () => { estado.seleccion.clear(); pintarResultados(); };
$('#btnTodos').onclick = async () => {
  const b = estado.busqueda;
  if (b.total > 3000) return toast('Son más de 3,000 productos; afina la búsqueda o usa el Excel');
  $('#btnTodos').textContent = 'Cargando…';
  try {
    for (let off = 0; off < b.total; off += 500) {
      const r = await api({ accion:'buscar', texto:b.texto, descuento:b.descuento, offset:off, limit:500 });
      r.productos.forEach(p => estado.seleccion.set(p.id, p));
    }
  } catch (e) { toast(e.message); }
  $('#btnTodos').textContent = 'Seleccionar todos los resultados';
  pintarResultados();
};

function pintarSelectorBarra() {
  $('#selDescBarra').innerHTML = CFG.opciones.map(o =>
    `<button class="${o === SIN ? 'sin' : ''}" aria-pressed="${estado.descBarra === o}" data-d="${esc(o)}">${o === SIN ? 'Quitar descuento' : esc(o)}</button>`).join('');
}
$('#selDescBarra').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  estado.descBarra = b.dataset.d; pintarSelectorBarra(); pintarBarra();
});
function pintarBarra() {
  const n = estado.seleccion.size;
  $('#barraSel').hidden = n === 0;
  $('#nSel').textContent = `${n.toLocaleString('es-MX')} seleccionado${n === 1 ? '' : 's'}`;
  $('#btnTodos').hidden = !(estado.busqueda.total > estado.busqueda.productos.length);
  $('#btnAgregarSel').disabled = !estado.descBarra || n === 0;
  $('#btnAgregarSel').textContent = estado.descBarra
    ? (estado.descBarra === SIN ? `Quitar descuento a ${n}` : `Poner ${estado.descBarra} a ${n}`) : 'Agregar a cambios';
  $('#hintSel').hidden = !!estado.descBarra;
}
$('#btnAgregarSel').onclick = () => {
  let n = 0;
  for (const p of estado.seleccion.values()) { agregarCambio(p, estado.descBarra, 'Selección'); n++; }
  estado.seleccion.clear();
  pintarResultados(); pintarCambios();
  toast(`${n} producto${n === 1 ? '' : 's'} agregado${n === 1 ? '' : 's'} a la lista`);
};

// ---------- Excel ----------
const drop = $('#drop');
['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('encima'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('encima'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) leerExcel(f); });
$('#archivo').onchange = e => { const f = e.target.files[0]; if (f) leerExcel(f); e.target.value = ''; };

$('#btnPlantilla').onclick = () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['Referencia interna','Descuento'],['CAP0082PN','50%'],['GK0192','40%'],['E4324BL','2x1'],['TO0037BS','Sin descuento']]);
  ws['!cols'] = [{wch:22},{wch:16}];
  const op = XLSX.utils.aoa_to_sheet([['Descuentos válidos'], ...(CFG ? CFG.opciones : []).map(o => [o])]);
  op['!cols'] = [{wch:22}];
  XLSX.utils.book_append_sheet(wb, ws, 'Descuentos');
  XLSX.utils.book_append_sheet(wb, op, 'Opciones válidas');
  descargarXlsx(wb, 'plantilla_descuentos.xlsx');
};

async function leerExcel(file) {
  if (!CFG) return toast('Todavía no hay conexión con Odoo');
  const cont = $('#resExcel');
  cont.innerHTML = '<p class="sub">Leyendo archivo…</p>';
  let filas;
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type:'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const txt = XLSX.utils.sheet_to_json(ws, { header:1, raw:false, defval:'' });
    const raw = XLSX.utils.sheet_to_json(ws, { header:1, raw:true, defval:'' });
    filas = interpretar(txt, raw);
  } catch (e) {
    cont.innerHTML = `<div class="aviso err">No se pudo leer el archivo: ${esc(e.message)}</div>`; return;
  }
  if (!filas.length) { cont.innerHTML = '<div class="aviso err">El archivo no tiene filas con referencia.</div>'; return; }

  // 1. validar descuento
  for (const f of filas) {
    const d = descValido(normDesc(f.descRaw));
    if (f.descRaw === '' || f.descRaw == null) f.error = 'Falta el descuento';
    else if (!d) f.error = `"${f.descRaw}" no es un descuento existente (${CFG.opciones.join(', ')})`;
    else f.nuevo = d;
  }
  // 2. referencias repetidas
  const porRef = new Map();
  for (const f of filas) { const k = f.ref.toUpperCase(); (porRef.get(k) || porRef.set(k, []).get(k)).push(f); }
  for (const lista of porRef.values()) {
    if (lista.length < 2) continue;
    const ds = new Set(lista.filter(f => f.nuevo).map(f => f.nuevo));
    if (ds.size > 1) lista.forEach(f => { if (!f.error) f.error = `Referencia repetida con descuentos distintos (${[...ds].join(' / ')})`; });
    else lista.slice(1).forEach(f => { if (!f.error) { f.duplicada = true; } });
  }
  // 3. buscar en Odoo
  cont.innerHTML = `<p class="sub">Buscando ${porRef.size.toLocaleString('es-MX')} referencias en Odoo…</p>`;
  const refs = [...new Set(filas.filter(f => !f.duplicada).map(f => f.ref))];
  const res = {};
  try {
    for (let i = 0; i < refs.length; i += 1000) {
      const r = await api({ accion:'resolver', refs: refs.slice(i, i + 1000) });
      Object.assign(res, r.resultado);
    }
  } catch (e) { cont.innerHTML = `<div class="aviso err">${esc(e.message)}</div>`; return; }
  const resU = new Map(Object.entries(res).map(([k, v]) => [k.toUpperCase(), v]));
  for (const f of filas) {
    if (f.duplicada) continue;
    const ps = resU.get(f.ref.toUpperCase()) || [];
    if (!ps.length) { if (!f.error) f.error = 'No existe en Odoo (o está archivado)'; continue; }
    if (ps.length > 1) { if (!f.error) f.error = `La referencia está en ${ps.length} productos distintos`; continue; }
    f.p = ps[0];
  }
  // 4. variantes del mismo producto con descuentos distintos
  const porTmpl = new Map();
  for (const f of filas) if (f.p && !f.error) (porTmpl.get(f.p.id) || porTmpl.set(f.p.id, []).get(f.p.id)).push(f);
  for (const lista of porTmpl.values()) {
    const ds = new Set(lista.map(f => f.nuevo));
    if (ds.size > 1) lista.forEach(f => f.error = `Varias referencias son el mismo producto (${f.p.ref || f.p.nombre}) con descuentos distintos`);
    else lista.slice(1).forEach(f => f.duplicada = true);
  }
  // 5. plan
  for (const f of filas) if (f.p && !f.error && !f.duplicada) f.plan = planear(f.p, f.nuevo);
  pintarExcel(filas, file.name);
}

function interpretar(txt, raw) {
  const rx = { ref:/ref|c[oó]d|sku|clave|default|art[ií]culo|modelo/i, desc:/desc|promo|%|oferta/i };
  let iRef = 0, iDesc = 1, inicio = 0;
  const h = (txt[0] || []).map(String);
  const r = h.findIndex(x => rx.ref.test(x)), d = h.findIndex(x => rx.desc.test(x));
  if (r >= 0 && d >= 0) { iRef = r; iDesc = d; inicio = 1; }
  else if (h.length && !descValido(normDesc(raw[0] && raw[0][1]))) inicio = 1; // primera fila parece encabezado
  const filas = [];
  for (let i = inicio; i < txt.length; i++) {
    const ref = String(txt[i][iRef] ?? '').trim();
    if (!ref) continue;
    let descRaw = raw[i][iDesc];
    if (typeof descRaw === 'string') descRaw = descRaw.trim();
    // si la celda tiene formato de porcentaje, SheetJS da 0.4; el texto formateado da "40%"
    const t = String(txt[i][iDesc] ?? '').trim();
    if (typeof descRaw === 'number' && /%$/.test(t)) descRaw = t;
    filas.push({ fila: i + 1, ref, descRaw });
  }
  return filas;
}

function pintarExcel(filas, nombre) {
  const validas = filas.filter(f => f.plan && f.plan.estado !== 'error');
  const errores = filas.filter(f => f.error || (f.plan && f.plan.estado === 'error'));
  const sinCambio = validas.filter(f => f.plan.estado === 'sin_cambio');
  const aplicables = validas.filter(f => f.plan.estado === 'ok');
  const dup = filas.filter(f => f.duplicada).length;
  const cont = $('#resExcel');
  cont.innerHTML = `
    <div class="fila"><b>${esc(nombre)}</b><span class="sub">${filas.length.toLocaleString('es-MX')} filas leídas</span></div>
    <div class="resumen">
      <div><b class="num">${aplicables.length}</b><span>con cambio</span></div>
      <div><b class="num">${sinCambio.length}</b><span>ya tienen ese descuento</span></div>
      <div><b class="num" style="color:${errores.length ? 'var(--err)' : 'inherit'}">${errores.length}</b><span>con error</span></div>
      <div><b class="num">${dup}</b><span>repetidas (se ignoran)</span></div>
    </div>
    ${errores.length ? `<div><div class="fila" style="margin-bottom:6px"><b>Filas con error</b><a class='ayuda' href='manual.html#excel-validaciones' target='_blank' rel='noopener' title='Por qué una fila tiene error' aria-label='Por qué una fila tiene error'>?</a><button class="btn chico" id="btnErrXlsx">Descargar errores</button></div>
    <div class="tabla-wrap" style="max-height:30vh"><table><thead><tr><th>Fila</th><th>Referencia</th><th>Descuento</th><th>Problema</th></tr></thead><tbody>
    ${errores.map(f => `<tr><td class="num">${f.fila}</td><td class="ref">${esc(f.ref)}</td><td>${esc(f.descRaw)}</td><td class="msg">${esc(f.error || f.plan.msg)}</td></tr>`).join('')}
    </tbody></table></div></div>` : '<div class="aviso" style="background:var(--ok-bg);color:var(--ok)">Todas las referencias existen y los descuentos son válidos.</div>'}
    <div class="fila"><button class="btn prim" id="btnAgregarExcel" ${aplicables.length ? '' : 'disabled'}>Agregar ${aplicables.length} a cambios</button>
    ${errores.length ? '<span class="sub">Las filas con error no se agregan.</span>' : ''}</div>`;
  if ($('#btnAgregarExcel')) $('#btnAgregarExcel').onclick = () => {
    aplicables.forEach(f => agregarCambio(f.p, f.nuevo, 'Excel fila ' + f.fila));
    pintarCambios(); toast(`${aplicables.length} productos agregados a la lista`);
    $('#btnAgregarExcel').disabled = true; $('#btnAgregarExcel').textContent = 'Agregados';
  };
  if ($('#btnErrXlsx')) $('#btnErrXlsx').onclick = () => {
    const ws = XLSX.utils.aoa_to_sheet([['Fila','Referencia interna','Descuento','Problema'], ...errores.map(f => [f.fila, f.ref, f.descRaw, f.error || f.plan.msg])]);
    ws['!cols'] = [{wch:6},{wch:22},{wch:14},{wch:70}];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Errores');
    descargarXlsx(wb, 'errores_descuentos.xlsx');
  };
}

// ---------- lista de cambios ----------
function agregarCambio(p, nuevo, origen) {
  estado.resultados.delete(p.id);
  estado.cambios.set(p.id, { p, nuevo, origen, plan: planear(p, nuevo) });
}

function filaEstado(c) {
  const r = estado.resultados.get(c.p.id);
  if (r) return r.estado === 'verificado' ? 'verificado' : (r.estado === 'sin_cambio' ? 'sin_cambio' : 'error');
  return c.plan.estado === 'error' ? 'error' : c.plan.tipo;
}

function pintarCambios() {
  const lista = [...estado.cambios.values()];
  const cuenta = {};
  lista.forEach(c => { const k = filaEstado(c); cuenta[k] = (cuenta[k] || 0) + 1; });
  const pendientes = lista.filter(c => !estado.resultados.has(c.p.id) && c.plan.estado === 'ok');
  $('#cuentaCambios').textContent = lista.length ? `${lista.length.toLocaleString('es-MX')} productos` : 'Vacío';
  $('#btnVaciar').hidden = !lista.length;
  $('#btnAplicar').disabled = !pendientes.length;
  $('#btnAplicar').textContent = pendientes.length ? `Aplicar ${pendientes.length.toLocaleString('es-MX')} en Odoo` : 'Aplicar en Odoo';
  $('#grpBitacora').hidden = !estado.bitacora.length;

  const orden = ['todos','activar','cambiar','quitar','corregir','sin_cambio','error','verificado'];
  $('#filtrosEstado').innerHTML = lista.length ? orden.filter(k => k === 'todos' || cuenta[k]).map(k =>
    `<button aria-pressed="${estado.filtro === k}" data-f="${k}">${k === 'todos' ? 'Todos' : NOMBRE_TIPO[k]} <span class="num">${k === 'todos' ? lista.length : cuenta[k]}</span></button>`).join('') : '';
  if (estado.filtro !== 'todos' && !cuenta[estado.filtro]) estado.filtro = 'todos';

  const vis = lista.filter(c => estado.filtro === 'todos' || filaEstado(c) === estado.filtro);
  if (!lista.length) { $('#tbCambios').innerHTML = '<tr><td colspan="6" class="vacio">Agrega productos desde la búsqueda o sube un Excel.</td></tr>'; return; }
  const MAX = 800;
  $('#tbCambios').innerHTML = vis.slice(0, MAX).map(c => {
    const r = estado.resultados.get(c.p.id), k = filaEstado(c);
    const msg = (r && r.msg) || (c.plan.estado === 'error' || c.plan.tipo === 'corregir' ? c.plan.msg : '');
    const ant = c.plan.tipo === 'sin_cambio' || c.plan.tipo === 'corregir' ? (c.p.anterior || '—') : (c.plan.anterior || '—');
    return `<tr data-id="${c.p.id}">
      <td class="ref">${esc(c.p.ref || '—')}</td>
      <td class="nom" title="${esc(c.p.nombre)}">${esc(c.p.nombre)}<div class="msg gris">${esc(c.origen)}</div></td>
      <td style="white-space:nowrap">${etq(c.p.actual)}<span class="flecha">→</span>${etq(c.nuevo)}</td>
      <td>${esc(ant)}</td>
      <td><span class="pill p-${k}">${NOMBRE_TIPO[k]}</span>${msg ? `<div class="msg ${k === 'corregir' ? 'gris' : ''}">${esc(msg)}</div>` : ''}</td>
      <td><button class="x" title="Quitar de la lista" aria-label="Quitar ${esc(c.p.ref)} de la lista">×</button></td></tr>`;
  }).join('') + (vis.length > MAX ? `<tr><td colspan="6" class="vacio">Mostrando ${MAX} de ${vis.length}. Usa los filtros para ver el resto.</td></tr>` : '');
}
$('#filtrosEstado').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; estado.filtro = b.dataset.f; pintarCambios(); });
$('#tbCambios').addEventListener('click', e => {
  if (!e.target.classList.contains('x')) return;
  const id = Number(e.target.closest('tr').dataset.id);
  estado.cambios.delete(id); estado.resultados.delete(id); pintarCambios(); if (estado.busqueda.productos.length) pintarResultados();
});
$('#btnVaciar').onclick = () => { if (!confirm('¿Vaciar toda la lista de cambios?')) return; estado.cambios.clear(); estado.resultados.clear(); pintarCambios(); if (estado.busqueda.productos.length) pintarResultados(); };
$('#usuario').onchange = () => { try { localStorage.setItem('desc_usuario', $('#usuario').value.trim()); } catch (e) {} };

// ---------- aplicar ----------
$('#btnAplicar').onclick = () => {
  const pend = [...estado.cambios.values()].filter(c => !estado.resultados.has(c.p.id) && c.plan.estado === 'ok');
  if (!$('#usuario').value.trim()) { $('#usuario').focus(); return toast('Escribe tu nombre en "Aplicado por"'); }
  if (!$('#fecha').value) { $('#fecha').focus(); return toast('Elige la fecha de aplicación'); }
  const cuenta = {}; pend.forEach(c => cuenta[c.plan.tipo] = (cuenta[c.plan.tipo] || 0) + 1);
  const errores = [...estado.cambios.values()].filter(c => c.plan.estado === 'error').length;
  $('#resumenConf').innerHTML = `<table>${Object.entries(cuenta).map(([k, n]) => `<tr><td>${NOMBRE_TIPO[k]}</td><td class="num">${n}</td></tr>`).join('')}
    <tr><td style="border-top:1px solid var(--linea);padding-top:6px">Total a escribir</td><td class="num" style="border-top:1px solid var(--linea);padding-top:6px">${pend.length}</td></tr></table>`;
  $('#notaConf').textContent = `Fecha ${fmtF($('#fecha').value)}: se usa como activación al poner o cambiar descuento y como desactivación al quitarlo.` +
    (errores ? ` ${errores} con error no se tocan.` : '');
  $('#dlgConfirmar').showModal();
};
$('#btnCancelarConf').onclick = () => $('#dlgConfirmar').close();
$('#btnSiConf').onclick = async () => {
  $('#dlgConfirmar').close();
  const pend = [...estado.cambios.values()].filter(c => !estado.resultados.has(c.p.id) && c.plan.estado === 'ok');
  const fecha = $('#fecha').value, usuario = $('#usuario').value.trim();
  const barra = $('#progreso'); barra.hidden = false;
  $('#btnAplicar').disabled = true; $('#btnAplicar').textContent = 'Aplicando…';
  let hechos = 0, ok = 0, mal = 0;
  const LOTE = 150;
  for (let i = 0; i < pend.length; i += LOTE) {
    const lote = pend.slice(i, i + LOTE);
    try {
      const r = await api({ accion:'aplicar', fecha, cambios: lote.map(c => ({ id: c.p.id, nuevo: c.nuevo })) });
      for (const c of lote) {
        const res = r.resultados[c.p.id] || { estado:'error', msg:'Sin respuesta para este producto' };
        estado.resultados.set(c.p.id, res);
        if (res.estado === 'verificado') { ok++; if (res.despues) c.p = res.despues; } else if (res.estado !== 'sin_cambio') mal++;
        estado.bitacora.push([fecha, usuario, c.p.ref, c.p.nombre, res.antes || '', c.nuevo, NOMBRE_TIPO[res.tipo] || res.tipo || '', res.estado === 'verificado' ? 'Aplicado y verificado' : (res.estado === 'sin_cambio' ? 'Sin cambio' : 'Error'), res.msg || '', c.origen, new Date().toLocaleString('es-MX')]);
      }
    } catch (e) {
      for (const c of lote) { estado.resultados.set(c.p.id, { estado:'error', msg:e.message }); mal++; }
    }
    hechos += lote.length;
    barra.firstElementChild.style.width = (hechos / pend.length * 100) + '%';
    pintarCambios();
  }
  setTimeout(() => { barra.hidden = true; barra.firstElementChild.style.width = 0; }, 800);
  pintarCambios();
  toast(mal ? `${ok} aplicados y verificados · ${mal} con error (filtra “Error” para verlos)` : `${ok} productos actualizados y verificados en Odoo`, 6000);
};

$('#btnBitacora').onclick = () => {
  const ws = XLSX.utils.aoa_to_sheet([['Fecha aplicación','Aplicado por','Referencia','Producto','Descuento antes','Descuento nuevo','Acción','Resultado','Mensaje','Origen','Registrado'], ...estado.bitacora]);
  ws['!cols'] = [{wch:14},{wch:18},{wch:18},{wch:36},{wch:14},{wch:14},{wch:16},{wch:20},{wch:50},{wch:16},{wch:20}];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Bitácora');
  descargarXlsx(wb, 'bitacora_descuentos.xlsx');
};

iniciar();
