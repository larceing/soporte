let incidencias = [];
let catalogo = { tipos: [], estados: [], prioridades: [] };
let serviciosSindri = null;
let cronometro = null;
let cronoIntervalo = null;
let detalleActual = null;
let detalleTab = 'seguimiento';
let confirmacionPendiente = null;

const incFiltros = { estado: 'abiertas', q: '', tipo: '', prioridad: '', orden: 'actualizada' };
const PESO_PRIORIDAD = { immediate: 5, urgent: 4, high: 3, normal: 2, low: 1, none: 0 };

/* Núcleo */

async function api(metodo, ruta, cuerpo) {
  let respuesta;
  try {
    respuesta = await fetch('api' + ruta, {
      method: metodo,
      headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
  } catch (e) {
    throw new Error('No hay conexión con el servidor. Comprueba la red y vuelve a intentarlo.');
  }

  if (respuesta.status === 401) {
    location.href = 'login';
    throw new Error('Sesión caducada.');
  }

  const datos = await respuesta.json().catch(function() { return null; });
  if (!respuesta.ok) {
    throw new Error((datos && datos.error) || 'Ha ocurrido un error (' + respuesta.status + ').');
  }
  return datos;
}

function esc(valor) {
  return String(valor == null ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function coreMensaje(id, texto, tipo) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!texto) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = texto;
  el.className = 'message ' + (tipo || 'error');
}

function coreError(err) {
  coreMensaje('mensajeGlobal', err.message || String(err), 'error');
  window.scrollTo(0, 0);
}

function coreMostrarVista(vista) {
  coreMensaje('mensajeGlobal', '');

  document.querySelectorAll('.view').forEach(function(seccion) {
    seccion.classList.toggle('hidden', seccion.id !== vista);
  });

  document.querySelectorAll('[data-nav]').forEach(function(boton) {
    boton.classList.toggle('is-active', boton.dataset.nav.split(' ').indexOf(vista) !== -1);
  });

  window.scrollTo(0, 0);

  const cargar = {
    inicio: coreCargar,
    incidencias: coreCargar,
    sesiones: sesionesCargar,
    correo: correoCargar,
    ajustes: ajustesCargar
  }[vista];

  if (cargar) cargar().catch(coreError);
}

async function coreSalir() {
  const r = await fetch('api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const datos = await r.json().catch(function() { return {}; });
  // Con Keycloak, cerrar también su sesión (si no, se volvería a entrar solo).
  location.href = datos.salir || 'login';
}

async function coreCargar() {
  const resultados = await Promise.all([api('GET', '/incidencias'), api('GET', '/cronometro')]);
  incidencias = resultados[0];
  cronometro = resultados[1];

  inicioPintar();
  incPintar();
}

// Diálogo de confirmación común: devuelve una promesa con true o false.
function coreConfirmar(titulo, texto, boton) {
  document.getElementById('confirmarTitulo').textContent = titulo;
  document.getElementById('confirmarTexto').textContent = texto;
  document.getElementById('confirmarBoton').textContent = boton || 'Aceptar';
  document.getElementById('dialogoConfirmar').classList.remove('hidden');

  return new Promise(function(resolver) { confirmacionPendiente = resolver; });
}

function coreConfirmarCerrar(respuesta) {
  document.getElementById('dialogoConfirmar').classList.add('hidden');
  if (confirmacionPendiente) confirmacionPendiente(respuesta);
  confirmacionPendiente = null;
}

/* Formato */

function fmtDuracion(minutos) {
  const m = Number(minutos) || 0;
  if (!m) return '—';
  const h = Math.floor(Math.abs(m) / 60);
  return (m < 0 ? '−' : '') + (h ? h + ' h ' : '') + (Math.abs(m) % 60) + ' min';
}

function fmtFecha(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtFechaHora(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function fmtReloj(segundos) {
  const s = Math.max(0, Math.floor(segundos));
  const dos = function(n) { return String(n).padStart(2, '0'); };
  return dos(Math.floor(s / 3600)) + ':' + dos(Math.floor(s / 60) % 60) + ':' + dos(s % 60);
}

function fmtBytes(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function vencida(inc) {
  return inc.abierta && inc.limite && inc.limite < hoyIso();
}

function badgeEstado(inc) {
  const clase = !inc.abierta ? 'badge-ok'
    : inc.estado === 'assigned' ? 'badge-run'
    : inc.estado === 'feedback' ? 'badge-neutral'
    : 'badge-pend';
  return '<span class="badge ' + clase + '">' + esc(inc.estadoTexto) + '</span>';
}

function badgesExtra(inc) {
  let html = '';
  if (inc.abierta && (inc.prioridad === 'high' || inc.prioridad === 'urgent' || inc.prioridad === 'immediate')) {
    html += '<span class="badge badge-danger">' + esc(inc.prioridadTexto) + '</span>';
  }
  if (inc.limite && inc.abierta) {
    html += '<span class="badge ' + (vencida(inc) ? 'badge-danger' : 'badge-neutral') + '">' +
      (vencida(inc) ? 'Vencida ' : 'Límite ') + fmtDia(inc.limite) + '</span>';
  }
  return html;
}

function opciones(lista, seleccionado, conTodos) {
  return (conTodos ? '<option value="">' + conTodos + '</option>' : '') + lista.map(function(o) {
    const valor = o.nombre || o;
    return '<option value="' + esc(valor) + '"' + (valor === seleccionado ? ' selected' : '') + '>' + esc(o.texto || o) + '</option>';
  }).join('');
}

function elegibles(lista, actual) {
  return lista.filter(function(o) { return o.elegible || o.nombre === actual; });
}

/* Listas */

function itemIncidencia(inc) {
  return '<button type="button" class="pet" onclick="detalleAbrir(' + inc.id + ')">' +
    '<span class="pet-main">' +
      '<span class="pet-title">' + esc(inc.titulo) + '</span>' +
      '<span class="pet-sub pet-code">' + esc(inc.codigo) + ' · #' + inc.id + '</span>' +
    '</span>' +
    '<span class="pet-meta">' + esc(inc.tipo) + ' · ' + fmtFecha(inc.actualizada) +
      (badgesExtra(inc) ? '<span class="pet-tags">' + badgesExtra(inc) + '</span>' : '') + '</span>' +
    '<span class="pet-amount">' + fmtDuracion(inc.minutos) + '</span>' +
    '<span class="pet-badge">' + badgeEstado(inc) + '</span>' +
  '</button>';
}

function listaHtml(lista, vacio) {
  if (!lista.length) return '<div class="empty">' + vacio + '</div>';
  return lista.map(itemIncidencia).join('');
}

function incFiltrar(estado) {
  incFiltros.estado = estado;
  incPintar();
}

function incLeerFiltros() {
  incFiltros.q = document.getElementById('incBuscar').value.trim().toLowerCase();
  incFiltros.tipo = document.getElementById('incTipo').value;
  incFiltros.prioridad = document.getElementById('incPrioridad').value;
  incFiltros.orden = document.getElementById('incOrden').value;
  incPintar();
}

function incLimpiarFiltros() {
  ['incBuscar', 'incTipo', 'incPrioridad'].forEach(function(id) { document.getElementById(id).value = ''; });
  document.getElementById('incOrden').value = 'actualizada';
  incFiltros.estado = 'todas';
  incLeerFiltros();
}

function incPintar() {
  document.querySelectorAll('[data-filtro]').forEach(function(chip) {
    chip.classList.toggle('is-active', chip.dataset.filtro === incFiltros.estado);
  });

  const lista = incidencias.filter(function(inc) {
    const e = incFiltros.estado;
    if (e === 'abiertas' && !inc.abierta) return false;
    if (e === 'cerradas' && inc.abierta) return false;
    if (e === 'vencidas' && !vencida(inc)) return false;
    if (['new', 'assigned', 'feedback'].indexOf(e) !== -1 && inc.estado !== e) return false;
    if (incFiltros.tipo && inc.tipo !== incFiltros.tipo) return false;
    if (incFiltros.prioridad && inc.prioridad !== incFiltros.prioridad) return false;
    if (incFiltros.q && (inc.titulo + ' ' + inc.codigo + ' #' + inc.id).toLowerCase().indexOf(incFiltros.q) === -1) return false;
    return true;
  });

  const por = incFiltros.orden;
  lista.sort(function(a, b) {
    if (por === 'prioridad') return (PESO_PRIORIDAD[b.prioridad] - PESO_PRIORIDAD[a.prioridad]) || String(b.actualizada).localeCompare(a.actualizada);
    if (por === 'limite') return String(a.limite || '9999').localeCompare(b.limite || '9999');
    if (por === 'tiempo') return b.minutos - a.minutos;
    if (por === 'creada') return String(b.creada).localeCompare(a.creada);
    return String(b.actualizada).localeCompare(a.actualizada);
  });

  const minutos = lista.reduce(function(s, i) { return s + i.minutos; }, 0);
  document.getElementById('incResumen').textContent = lista.length + (lista.length === 1 ? ' incidencia' : ' incidencias') +
    ' · ' + fmtDuracion(minutos) + ' registrados';
  document.getElementById('incLista').innerHTML = listaHtml(lista, 'No hay incidencias con estos filtros.');
}

/* Inicio */

function inicioPintar() {
  document.getElementById('inicioFecha').textContent = new Date().toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long'
  });

  cronoPintar();

  const abiertas = incidencias.filter(function(inc) { return inc.abierta; });
  const esperando = abiertas.filter(function(inc) { return inc.estado === 'feedback'; });
  const vencidas = abiertas.filter(vencida);
  const ir = function(filtro) { return ' onclick="incFiltros.estado=\'' + filtro + '\'; coreMostrarVista(\'incidencias\')"'; };

  document.getElementById('inicioResumen').innerHTML =
    '<div class="stats">' +
      '<button type="button" class="stat stat-btn"' + ir('abiertas') + '><div class="stat-label">Abiertas</div><div class="stat-value">' + abiertas.length + '</div></button>' +
      '<button type="button" class="stat stat-btn"' + ir('feedback') + '><div class="stat-label">Esperando al cliente</div><div class="stat-value">' + esperando.length + '</div></button>' +
      '<button type="button" class="stat stat-btn' + (vencidas.length ? ' stat-alerta' : '') + '"' + ir('vencidas') + '><div class="stat-label">Vencidas</div><div class="stat-value">' + vencidas.length + '</div></button>' +
    '</div>';

  // Primero lo urgente y lo que vence antes.
  abiertas.sort(function(a, b) {
    return (PESO_PRIORIDAD[b.prioridad] - PESO_PRIORIDAD[a.prioridad]) ||
      String(a.limite || '9999').localeCompare(b.limite || '9999') ||
      String(b.actualizada).localeCompare(a.actualizada);
  });
  document.getElementById('inicioLista').innerHTML = listaHtml(abiertas.slice(0, 8), 'No hay incidencias abiertas.');
}

/* Cronómetro */

function cronoPintar() {
  const caja = document.getElementById('inicioCronometro');
  clearInterval(cronoIntervalo);

  if (!cronometro) {
    caja.innerHTML =
      '<div class="idle-card">' +
        '<div><div class="idle-label">Cronómetro</div><div class="idle-title">Sin trabajo en curso</div></div>' +
        '<button type="button" class="btn btn-primary btn-xl" onclick="coreMostrarVista(\'nueva\')">Nueva incidencia</button>' +
      '</div>';
    return;
  }

  caja.innerHTML =
    '<div class="run-card">' +
      '<div class="run-top"><span class="run-dot"></span><span class="run-label">En curso</span></div>' +
      '<div class="run-timer" id="cronoReloj">00:00:00</div>' +
      '<div class="run-text">' +
        '<button type="button" class="run-title run-link" onclick="detalleAbrir(' + cronometro.incidenciaId + ')">' + esc(cronometro.titulo) + '</button>' +
        '<div class="run-sub">Incidencia #' + cronometro.incidenciaId + ' · desde ' + fmtFechaHora(cronometro.inicio) + '</div>' +
      '</div>' +
      '<button type="button" class="btn btn-run btn-xl" onclick="cronoAbrirDialogo()">Parar</button>' +
    '</div>';

  const tic = function() {
    const reloj = document.getElementById('cronoReloj');
    if (reloj) reloj.textContent = fmtReloj((Date.now() - new Date(cronometro.inicio).getTime()) / 1000);
  };
  tic();
  cronoIntervalo = setInterval(tic, 1000);
}

async function cronoIniciar(incidenciaId) {
  try {
    cronometro = await api('POST', '/cronometro/iniciar', { incidenciaId: incidenciaId });
    coreMostrarVista('inicio');
  } catch (err) {
    coreError(err);
  }
}

function cronoAbrirDialogo() {
  document.getElementById('pararTexto').value = '';
  coreMensaje('mensajeParar', '');
  document.getElementById('dialogoParar').classList.remove('hidden');
  document.getElementById('pararTexto').focus();
}

function cronoCerrarDialogo() {
  document.getElementById('dialogoParar').classList.add('hidden');
}

async function cronoParar() {
  const boton = document.getElementById('pararBoton');
  boton.disabled = true;

  try {
    const resultado = await api('POST', '/cronometro/parar', { texto: document.getElementById('pararTexto').value });
    cronometro = null;
    cronoCerrarDialogo();
    detalleTab = 'sesiones';
    detalleAbrir(resultado.incidencia.id, resultado.incidencia);
    if (resultado.recortado) {
      coreMensaje('mensajeGlobal', 'El cronómetro llevaba más de 24 horas en marcha. Se han guardado 24 horas; revisa la sesión.', 'info');
    }
  } catch (err) {
    // Si el servidor ha detenido el cronómetro por su cuenta, reflejarlo.
    cronometro = await api('GET', '/cronometro').catch(function() { return cronometro; });
    if (!cronometro) {
      cronoCerrarDialogo();
      coreMostrarVista('inicio');
      coreError(err);
    } else {
      coreMensaje('mensajeParar', err.message, 'error');
    }
  }
  boton.disabled = false;
}

async function cronoDescartar() {
  const si = await coreConfirmar('Descartar cronómetro',
    'Se detendrá el cronómetro sin guardar el tiempo. Esta acción no se puede deshacer.', 'Descartar');
  if (!si) return;

  try {
    await api('POST', '/cronometro/descartar', {});
    cronometro = null;
    cronoCerrarDialogo();
    coreMostrarVista('inicio');
  } catch (err) {
    coreError(err);
  }
}

/* Nueva */

function nuevaPreparar() {
  document.getElementById('nuevaTipo').innerHTML = opciones(catalogo.tipos, 'Incidencia');
  document.getElementById('nuevaPrioridad').innerHTML = opciones(elegibles(catalogo.prioridades), 'normal');
  clientesCargar().then(function() {
    document.getElementById('nuevaCliente').innerHTML = opcionesCliente(null);
  }).catch(function() {});
}

// Los clientes que ves (los tuyos y los que te compartan): a quién se cobra cada incidencia.
let clientesLista = null;
async function clientesCargar() {
  clientesLista = await api('GET', '/clientes');
  return clientesLista;
}

function opcionesCliente(elegido) {
  const lista = clientesLista || [];
  let html = '<option value="">El mío por defecto</option>';
  // Uno que no ves (en una incidencia que te comparten) se queda tal cual.
  if (elegido && !lista.some(function(c) { return Number(c.id) === Number(elegido); })) {
    html += '<option value="' + esc(elegido) + '" selected>El que eligió quien te la comparte</option>';
  }
  lista.forEach(function(c) {
    html += '<option value="' + esc(c.id) + '"' + (Number(c.id) === Number(elegido) ? ' selected' : '') + '>' +
      esc(c.nombre) + (c.deOtro ? ' (compartido)' : '') + '</option>';
  });
  return html;
}

async function nuevaCrear(empezar) {
  coreMensaje('mensajeNueva', '');

  try {
    if (empezar && cronometro) {
      throw new Error('Ya hay un cronómetro en marcha. Páralo o usa "Solo crear".');
    }

    const inc = await api('POST', '/incidencias', {
      tipo: document.getElementById('nuevaTipo').value,
      prioridad: document.getElementById('nuevaPrioridad').value,
      limite: document.getElementById('nuevaLimite').value,
      titulo: document.getElementById('nuevaTitulo').value,
      descripcion: document.getElementById('nuevaDescripcion').value,
      clienteId: document.getElementById('nuevaCliente').value || null
    });

    ['nuevaTitulo', 'nuevaDescripcion', 'nuevaLimite'].forEach(function(id) { document.getElementById(id).value = ''; });

    if (empezar) {
      await cronoIniciar(inc.id);
    } else {
      detalleTab = 'seguimiento';
      detalleAbrir(inc.id, inc);
    }
  } catch (err) {
    coreMensaje('mensajeNueva', err.message, 'error');
  }
}

/* Ficha */

async function detalleAbrir(id, datos) {
  coreMostrarVista('detalle');
  if (!datos) document.getElementById('detalleContenido').innerHTML = '<div class="empty">Cargando...</div>';

  try {
    detallePintar(datos || await api('GET', '/incidencias/' + id));
  } catch (err) {
    document.getElementById('detalleContenido').innerHTML =
      '<div class="empty">No se ha podido abrir la incidencia.</div>' +
      '<div class="actions"><button type="button" class="btn btn-secondary" onclick="coreMostrarVista(\'incidencias\')">Volver a la lista</button></div>';
    coreError(err);
  }
}

function detalleCambiarTab(tab) {
  detalleTab = tab;
  detallePintar(detalleActual);
}

function detallePintar(inc) {
  detalleActual = inc;
  serviciosCargar();
  if (!clientesLista) clientesCargar().then(function() {
    const campo = document.getElementById('segCliente');
    if (campo && detalleActual) campo.innerHTML = opcionesCliente(detalleActual.clienteId);
  }).catch(function() {});
  const enCurso = cronometro && Number(cronometro.incidenciaId) === Number(inc.id);
  const pestanas = [
    ['seguimiento', 'Seguimiento'],
    ['notas', 'Documentación' + (inc.notas.length ? ' (' + inc.notas.length + ')' : '')],
    ['sesiones', 'Sesiones' + (inc.sesiones.length ? ' (' + inc.sesiones.length + ')' : '')],
    ['ficheros', 'Ficheros' + (inc.adjuntos.length ? ' (' + inc.adjuntos.length + ')' : '')],
    ['historial', 'Historial']
  ];

  let accion;
  if (enCurso) {
    accion = '<button type="button" class="btn btn-run" onclick="cronoAbrirDialogo()">Parar cronómetro</button>';
  } else if (!inc.abierta) {
    accion = '<button type="button" class="btn btn-secondary" onclick="detalleReabrir()">Reabrir</button>';
  } else if (cronometro) {
    accion = '<button type="button" class="btn btn-secondary" disabled>Cronómetro ocupado en otra incidencia</button>';
  } else {
    accion = '<button type="button" class="btn btn-primary" onclick="cronoIniciar(' + inc.id + ')">Empezar cronómetro</button>';
  }

  document.getElementById('detalleContenido').innerHTML =
    '<header class="view-head">' +
      '<div class="det-head">' +
        '<button type="button" class="link-btn" onclick="coreMostrarVista(\'incidencias\')">← Incidencias</button>' +
        '<span class="pet-code">' + esc(inc.codigo) + ' · #' + inc.id + '</span>' +
        badgeEstado(inc) + '<span class="badge badge-neutral">' + esc(inc.tipo) + '</span>' + badgesExtra(inc) +
      '</div>' +
      '<h2>' + esc(inc.titulo) + '</h2>' +
      '<p>Abierta el ' + fmtFecha(inc.creada) + ' · Última actividad ' + fmtFechaHora(inc.actualizada) +
        ' · Tiempo registrado: ' + fmtDuracion(inc.minutos) + '</p>' +
    '</header>' +

    '<div class="det-actions">' + accion +
      '<button type="button" class="btn btn-secondary" onclick="correoAbrir(detalleActual)">Enviar correo</button>' +
    '</div>' +

    '<div class="seg seg-wide" role="tablist">' + pestanas.map(function(p) {
      return '<button type="button" role="tab" class="' + (detalleTab === p[0] ? 'is-active' : '') +
        '" onclick="detalleCambiarTab(\'' + p[0] + '\')">' + p[1] + '</button>';
    }).join('') + '</div>' +

    '<div id="mensajeDetalle" class="message hidden"></div>' +
    ({ seguimiento: tabSeguimiento, notas: tabNotas, sesiones: tabSesiones, ficheros: tabFicheros, historial: tabHistorial }[detalleTab] || tabSeguimiento)(inc);
}

function tabSeguimiento(inc) {
  return '<div class="panel">' +
    '<div class="grid grid-3">' +
      '<div class="field"><label for="segEstado">Estado</label><select id="segEstado">' + opciones(elegibles(catalogo.estados, inc.estado), inc.estado) + '</select></div>' +
      '<div class="field"><label for="segPrioridad">Prioridad</label><select id="segPrioridad">' + opciones(elegibles(catalogo.prioridades, inc.prioridad), inc.prioridad) + '</select></div>' +
      '<div class="field"><label for="segLimite">Fecha límite</label><input id="segLimite" type="date" value="' + esc(inc.limite) + '"></div>' +
      '<div class="field"><label for="segTipo">Tipo</label><select id="segTipo">' + opciones(catalogo.tipos, inc.tipo) + '</select></div>' +
      '<div class="field"><label for="segCliente">Se cobra a</label><select id="segCliente">' + opcionesCliente(inc.clienteId) + '</select></div>' +
      '<div class="field field-full"><label for="segServicioBuscar">Servicio para Sindri</label>' +
        '<div class="servicio-elegir">' +
          '<input id="segServicioBuscar" type="search" autocomplete="off" placeholder="Buscar: docker, sage incidencias, power bi…" aria-label="Buscar servicio" oninput="servicioFiltrar()">' +
          '<select id="segServicio" aria-label="Servicio para Sindri">' + opcionesServicio(inc) + '</select>' +
        '</div>' +
        '<div id="segServicioCuenta" class="servicio-cuenta">' + esc(textoCuenta('')) + '</div>' +
      '</div>' +
      '<div class="field field-full"><label for="segTitulo">Título</label><input id="segTitulo" type="text" maxlength="120" value="' + esc(inc.titulo) + '"></div>' +
      '<div class="field field-full"><label for="segDescripcion">Descripción</label><textarea id="segDescripcion" class="alto">' + esc(inc.descripcion) + '</textarea></div>' +
    '</div>' +
    '<div class="actions"><button type="button" class="btn btn-primary" onclick="detalleGuardar()">Guardar cambios</button></div>' +
  '</div>';
}

function notaHtml(nota) {
  return '<div class="note">' +
    '<div class="note-head">' +
      (nota.minutos ? '<span class="note-time">' + fmtDuracion(nota.minutos) + '</span>' : '<span class="badge badge-neutral">Nota</span>') +
      '<span>' + fmtFechaHora(nota.fecha) + '</span>' +
      '<span>' + esc(nota.autor) + '</span>' +
    '</div>' +
    (nota.texto ? '<p class="note-text">' + esc(nota.texto) + '</p>' : '') +
  '</div>';
}

function tabNotas(inc) {
  return '<div class="panel"><h3>Añadir nota</h3>' +
      '<div class="grid">' +
        '<div class="field field-full"><label for="notaTexto">Nota</label><textarea id="notaTexto"></textarea></div>' +
        '<div class="field"><label for="notaMinutos">Minutos dedicados (opcional)</label>' +
          '<input id="notaMinutos" type="number" min="0" max="1440" step="1" inputmode="numeric"' + (inc.abierta ? '' : ' disabled placeholder="Reabre la incidencia para registrar tiempo"') + '></div>' +
      '</div>' +
      '<div class="actions"><button type="button" class="btn btn-primary" onclick="detalleNota()">Guardar nota</button></div>' +
    '</div>' +
    '<div class="panel"><h3>Documentación</h3>' +
      (inc.notas.length ? inc.notas.slice().reverse().map(notaHtml).join('') : '<div class="empty">Todavía no hay notas.</div>') +
    '</div>';
}

function tabSesiones(inc) {
  if (!inc.sesiones.length) {
    return '<div class="panel"><div class="empty">Todavía no hay sesiones de trabajo. Usa el cronómetro o añade una nota con minutos.</div>' +
      botonSesionNueva(inc) + '</div>';
  }

  const total = inc.sesiones.reduce(function(s, t) { return s + Number(t.importe); }, 0);
  const horas = inc.sesiones.reduce(function(s, t) { return s + Number(t.horas); }, 0);
  const filas = inc.sesiones.map(function(t) {
    return '<tr>' +
      '<td>' + fmtDia(t.dia) + (t.inicio && t.fin ? '<div class="muted">' + esc(fmtTramo(t.inicio, t.fin)) + '</div>' : '') + '</td>' +
      '<td>' + fmtDuracion(t.minutos) + '</td>' +
      '<td>' + esc(t.horas) + ' h</td>' +
      '<td style="text-align:right;white-space:nowrap">' + fmtDinero(t.importe) + '</td>' +
      '<td>' + badgeSituacion(t.situacion) + '</td>' +
      '<td>' + (sesionEditable(t) ? '<button type="button" class="btn btn-secondary btn-sm" onclick="sesionAbrir(' + t.id + ')">Corregir</button>' : '') + '</td>' +
    '</tr>';
  }).join('');

  return '<div class="panel">' +
    '<div class="cobro-summary">' +
      '<div><span>Horas facturables</span><strong>' + horas + ' h</strong></div>' +
      '<div><span>Importe</span><strong>' + fmtDinero(total) + '</strong></div>' +
    '</div>' +
    '<div class="cobro-tabla-wrap"><table class="cobro-tabla">' +
      '<thead><tr><th>Fecha</th><th>Tiempo real</th><th>Facturable</th><th style="text-align:right">Importe</th><th>Facturación</th><th></th></tr></thead>' +
      '<tbody>' + filas + '</tbody>' +
    '</table></div>' +
    botonSesionNueva(inc) +
  '</div>';
}

function botonSesionNueva(inc) {
  return inc.abierta
    ? '<div class="actions"><button type="button" class="btn btn-secondary" onclick="sesionNueva()">Añadir sesión con horas</button></div>'
    : '';
}

/* Corregir o apuntar una sesión de trabajo con su hora de inicio y de fin */

let sesionEditando = null;

// Solo las sesiones propias que aún no están cobradas, facturadas ni en un pedido de Sindri.
function sesionEditable(t) {
  return t.tipo === 'TIEMPO' && !t.deOtro && (t.situacion.clave === 'PENDIENTE' || t.situacion.clave === 'NO_COBRAR');
}

// Un instante ISO en el formato de <input type="datetime-local">, en la hora del navegador.
function aCampoFecha(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const dos = function(n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()) + 'T' + dos(d.getHours()) + ':' + dos(d.getMinutes());
}

function deCampoFecha(valor) {
  const d = valor ? new Date(valor) : null;
  return d && !isNaN(d.getTime()) ? d.toISOString() : '';
}

function fmtHora(iso) {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

// '09:45 – 14:30', o con el día de fin si acaba otro día.
function fmtTramo(inicio, fin) {
  const otroDia = new Date(inicio).toDateString() !== new Date(fin).toDateString();
  return fmtHora(inicio) + ' – ' + (otroDia ? fmtFechaHora(fin) : fmtHora(fin));
}

// lista: de dónde sale la sesión (la ficha de la incidencia o la pantalla de Horas).
function sesionAbrir(id, lista) {
  const t = (lista || (detalleActual && detalleActual.sesiones) || []).find(function(x) { return x.id === id; });
  if (!t) return;
  sesionEditando = { id: t.id, desdeHoras: Boolean(lista) };
  document.getElementById('dialogoSesionTitulo').textContent = 'Corregir sesión';
  document.getElementById('dialogoSesionAyuda').textContent = 'El tiempo, las horas facturables y el importe se recalculan solos.';
  sesionDialogo(t.inicio, t.fin, t.detalle);
}

function sesionNueva() {
  sesionEditando = { id: null, incidenciaId: detalleActual.id };
  document.getElementById('dialogoSesionTitulo').textContent = 'Añadir sesión';
  document.getElementById('dialogoSesionAyuda').textContent = 'Para el tiempo que trabajaste sin cronómetro. Se guarda también como nota.';
  const ahora = new Date();
  sesionDialogo(new Date(ahora.getTime() - 3600000).toISOString(), ahora.toISOString(), '');
}

function sesionDialogo(inicio, fin, texto) {
  document.getElementById('sesInicio').value = aCampoFecha(inicio);
  document.getElementById('sesFin').value = aCampoFecha(fin);
  document.getElementById('sesTexto').value = texto || '';
  coreMensaje('mensajeSesion', '');
  sesionDuracionPintar();
  document.getElementById('dialogoSesion').classList.remove('hidden');
  document.getElementById('sesInicio').focus();
}

function sesionDuracionPintar() {
  const a = deCampoFecha(document.getElementById('sesInicio').value);
  const b = deCampoFecha(document.getElementById('sesFin').value);
  const minutos = a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : 0;
  document.getElementById('sesDuracion').textContent = minutos > 0 ? 'Duración: ' + fmtDuracion(minutos) : '';
}

function sesionCerrar() {
  document.getElementById('dialogoSesion').classList.add('hidden');
  sesionEditando = null;
}

async function sesionGuardar() {
  const boton = document.getElementById('sesionBoton');
  const datos = {
    inicio: deCampoFecha(document.getElementById('sesInicio').value),
    fin: deCampoFecha(document.getElementById('sesFin').value),
    texto: document.getElementById('sesTexto').value
  };
  const editando = sesionEditando;
  boton.disabled = true;

  try {
    let inc = null;
    if (editando.id) {
      inc = (await api('PUT', '/trabajos/' + editando.id, datos)).incidencia;
    } else {
      inc = await api('POST', '/incidencias/' + editando.incidenciaId + '/notas', datos);
    }
    sesionCerrar();
    if (editando.desdeHoras) {
      await sesionesCargar();
    } else if (inc) {
      detalleTab = 'sesiones';
      detallePintar(inc);
      coreMensaje('mensajeDetalle', editando.id ? 'Sesión corregida.' : 'Sesión añadida.', 'ok');
    }
  } catch (err) {
    coreMensaje('mensajeSesion', err.message, 'error');
  }
  boton.disabled = false;
}

function tabFicheros(inc) {
  return '<div class="panel">' +
    (inc.adjuntos.length
      ? inc.adjuntos.map(function(a) {
          return '<div class="note"><div class="note-head">' +
            '<a class="fact-link" style="margin:0" href="api/incidencias/' + inc.id + '/adjuntos/' + a.id + '">' + esc(a.nombre) + '</a>' +
            '<span>' + fmtBytes(a.bytes) + '</span><span>' + fmtFechaHora(a.fecha) + '</span>' +
          '</div></div>';
        }).join('')
      : '<div class="empty">Sin ficheros.</div>') +
    '<div class="grid" style="margin-top:12px">' +
      '<div class="field field-full"><label for="adjuntoFichero">Adjuntar fichero (máximo 10 MB)</label>' +
      '<input id="adjuntoFichero" type="file" style="padding:13px 14px"></div>' +
    '</div>' +
    '<div class="actions"><button type="button" id="adjuntoBoton" class="btn btn-secondary" onclick="detalleAdjuntar()">Subir fichero</button></div>' +
  '</div>';
}

function tabHistorial(inc) {
  if (!inc.cambios.length) return '<div class="panel"><div class="empty">Sin cambios registrados.</div></div>';

  return '<div class="panel">' + inc.cambios.slice().reverse().map(function(c) {
    return '<div class="note"><div class="note-head">' +
      '<span class="note-time">' + esc(c.campo) + '</span>' +
      '<span>' + fmtFechaHora(c.fecha) + '</span>' +
    '</div><p class="note-text">' + (c.antes ? esc(c.antes) + ' → ' : '') + esc(c.despues) + '</p></div>';
  }).join('') + '</div>';
}

// Cuántas sesiones de la incidencia ya no se pueden tocar.
function sesionesCerradas(inc) {
  return inc.sesiones.filter(function(t) { return ['COBRADO', 'FACTURADO', 'SINDRI'].indexOf(t.situacion.clave) !== -1; }).length;
}

async function confirmarReapertura(inc) {
  const n = sesionesCerradas(inc);
  if (!n) return true;

  return coreConfirmar('Reabrir incidencia',
    'Esta incidencia tiene ' + n + (n === 1 ? ' sesión ya en un pedido o cobrada, que no cambia.' : ' sesiones ya en un pedido o cobradas, que no cambian.') +
    ' El tiempo que registres a partir de ahora será trabajo nuevo, pendiente de facturar.', 'Reabrir');
}

async function detalleReabrir() {
  if (!(await confirmarReapertura(detalleActual))) return;

  try {
    detallePintar(await api('PATCH', '/incidencias/' + detalleActual.id, { estado: 'assigned' }));
  } catch (err) {
    coreMensaje('mensajeDetalle', err.message, 'error');
  }
}

// El artículo de Sindri con que se factura: vacío es el que se deduce del título. Con un texto
// de búsqueda solo salen los que tienen todas sus palabras (en el nombre, la referencia, el área
// o las otras palabras de la tecnología), sin mirar tildes ni mayúsculas; el elegido sale siempre.
function sinTildes(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function opcionesServicio(inc, buscar) {
  const lista = (serviciosSindri && serviciosSindri.servicios) || [];
  const nombre = function(sku) { const s = lista.find(function(x) { return x.sku === sku; }); return s ? s.name : sku; };
  const elegido = inc.servicio || '';
  const palabras = sinTildes(buscar).split(/\s+/).filter(Boolean);
  const encaja = function(s) {
    if (!palabras.length || s.sku === elegido) return true;
    const texto = sinTildes(s.name + ' ' + s.sku + ' ' + (s.area || '') + ' ' + (s.alias || ''));
    return palabras.every(function(p) { return texto.indexOf(p) >= 0; });
  };
  const otras = lista.filter(encaja);
  if (elegido && !lista.some(function(s) { return s.sku === elegido; })) otras.unshift({ sku: elegido, name: elegido });
  const opcion = function(s) {
    return '<option value="' + esc(s.sku) + '"' + (s.sku === elegido ? ' selected' : '') + '>' + esc(s.name) + '</option>';
  };
  // Agrupados por área, en el orden en que llegan (sin área, sueltos arriba).
  let html = '<option value="">Automático: ' + esc(nombre(inc.servicioAuto)) + '</option>';
  let area = null;
  otras.forEach(function(s) {
    if ((s.area || null) !== area) {
      if (area) html += '</optgroup>';
      area = s.area || null;
      if (area) html += '<optgroup label="' + esc(area) + '">';
    }
    html += opcion(s);
  });
  opcionesServicio.cuenta = { vistos: otras.length, total: lista.length };
  return html + (area ? '</optgroup>' : '');
}

// Al escribir en el buscador se rehace la lista y se abre como cuadro para elegir con un clic;
// sin texto vuelve a ser un desplegable. El servicio elegido no se pierde al filtrar.
function servicioFiltrar() {
  const campo = document.getElementById('segServicio');
  const buscar = document.getElementById('segServicioBuscar');
  if (!campo || !buscar || !detalleActual) return;
  const inc = Object.assign({}, detalleActual, { servicio: campo.value });
  campo.innerHTML = opcionesServicio(inc, buscar.value);
  const vistos = opcionesServicio.cuenta ? opcionesServicio.cuenta.vistos : 0;
  campo.size = buscar.value.trim() ? Math.max(2, Math.min(10, vistos + 1 + campo.querySelectorAll('optgroup').length)) : 1;
  const caja = document.getElementById('segServicioCuenta');
  if (caja) caja.textContent = textoCuenta(buscar.value);
}

function textoCuenta(buscar) {
  const c = opcionesServicio.cuenta;
  if (!c || !c.total) return '';
  if (!String(buscar || '').trim()) return c.total + ' servicios. Escribe para buscar por nombre, tecnología o área.';
  return c.vistos ? c.vistos + ' de ' + c.total + ' servicios' : 'Ningún servicio con esas palabras';
}

async function serviciosCargar() {
  if (serviciosSindri) return;
  try {
    serviciosSindri = await api('GET', '/sindri/servicios');
    if (document.getElementById('segServicio') && detalleActual) servicioFiltrar();
  } catch (err) {
    // Sin la lista se elige igual el automático.
  }
}

async function detalleGuardar() {
  const inc = detalleActual;
  const estado = document.getElementById('segEstado').value;
  const abre = !inc.abierta && estado !== 'resolved' && estado !== 'closed';

  if (abre && !(await confirmarReapertura(inc))) return;

  try {
    detallePintar(await api('PATCH', '/incidencias/' + inc.id, {
      estado: estado,
      prioridad: document.getElementById('segPrioridad').value,
      limite: document.getElementById('segLimite').value,
      tipo: document.getElementById('segTipo').value,
      servicio: document.getElementById('segServicio').value,
      ...((document.getElementById('segCliente').value || null) != (inc.clienteId || null)
        ? { clienteId: document.getElementById('segCliente').value || null } : {}),
      titulo: document.getElementById('segTitulo').value,
      descripcion: document.getElementById('segDescripcion').value
    }));
    coreMensaje('mensajeDetalle', 'Cambios guardados.', 'ok');
  } catch (err) {
    coreMensaje('mensajeDetalle', err.message, 'error');
  }
}

async function detalleNota() {
  try {
    detallePintar(await api('POST', '/incidencias/' + detalleActual.id + '/notas', {
      texto: document.getElementById('notaTexto').value,
      minutos: document.getElementById('notaMinutos').value
    }));
    coreMensaje('mensajeDetalle', 'Nota guardada.', 'ok');
  } catch (err) {
    coreMensaje('mensajeDetalle', err.message, 'error');
  }
}

function leerBase64(fichero) {
  return new Promise(function(resolver, rechazar) {
    const lector = new FileReader();
    lector.onload = function() { resolver(String(lector.result).split(',')[1] || ''); };
    lector.onerror = function() { rechazar(new Error('No se ha podido leer el fichero.')); };
    lector.readAsDataURL(fichero);
  });
}

async function detalleAdjuntar() {
  const fichero = document.getElementById('adjuntoFichero').files[0];
  const boton = document.getElementById('adjuntoBoton');

  try {
    if (!fichero) throw new Error('Elige un fichero.');
    if (!fichero.size) throw new Error('El fichero está vacío.');
    if (fichero.size > 10 * 1024 * 1024) throw new Error('El fichero supera los 10 MB.');

    boton.disabled = true;
    coreMensaje('mensajeDetalle', 'Subiendo...', 'info');
    detallePintar(await api('POST', '/incidencias/' + detalleActual.id + '/adjuntos', {
      nombre: fichero.name,
      contenido: await leerBase64(fichero)
    }));
    coreMensaje('mensajeDetalle', 'Fichero subido.', 'ok');
  } catch (err) {
    boton.disabled = false;
    coreMensaje('mensajeDetalle', err.message, 'error');
  }
}

/* Arranque */

// Chip DEV de la plantilla común: solo en el entorno de pruebas.
if (location.hostname.indexOf('dev.') === 0) document.querySelector('.chip-dev').hidden = false;

(async function() {
  try {
    catalogo = await api('GET', '/catalogo');
    document.getElementById('incTipo').innerHTML = opciones(catalogo.tipos, '', 'Todos los tipos');
    document.getElementById('incPrioridad').innerHTML = opciones(elegibles(catalogo.prioridades), '', 'Todas las prioridades');
    nuevaPreparar();
  } catch (err) {
    coreError(err);
  }
  coreMostrarVista('inicio');
  // Enlace directo a una incidencia (lo usa la tarea que tiene en el gestor de tareas).
  const enlace = /^#incidencia-(\d+)$/.exec(location.hash);
  if (enlace) detalleAbrir(enlace[1]);
})();
