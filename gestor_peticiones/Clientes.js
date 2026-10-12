function clientesListar() {
  const sh = clientesHoja_();

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  return values
    .slice(1)
    .filter(r => r[0])
    .filter(r => clientesEsActivo_(r[6]))
    .map(r => ({
      empresa: String(r[0] || ''),
      tarifaHora: Number(r[1] || 0),
      telefonoWhatsapp: String(r[2] || ''),
      email: String(r[3] || ''),
      contacto: String(r[4] || ''),
      notas: String(r[5] || ''),
      activo: clientesEsActivo_(r[6])
    }))
    .sort((a, b) => a.empresa.localeCompare(b.empresa));
}

function clientesGuardar(datos) {
  datos = datos || {};

  const empresa = String(datos.empresa || '').trim();
  if (!empresa) throw new Error('Debes indicar el nombre de la empresa.');

  const sh = clientesHoja_();

  const values = sh.getDataRange().getValues();
  const buscada = empresa.toLowerCase();

  const row = [
    empresa,
    Number(datos.tarifaHora || 0),
    datos.telefonoWhatsapp || '',
    datos.email || '',
    datos.contacto || '',
    datos.notas || '',
    'TRUE'
  ];

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim().toLowerCase() === buscada) {
      sh.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return clientesListar();
    }
  }

  sh.appendRow(row);
  return clientesListar();
}

function clientesTarifaHora_(empresa) {
  const cliente = clientesBuscarPorEmpresa_(empresa);
  if (cliente && Number(cliente.tarifaHora || 0) > 0) {
    return Number(cliente.tarifaHora || 0);
  }

  return Number(configGet_('TARIFA_HORA') || 0);
}

function clientesBuscarPorEmpresa_(empresa) {
  const sh = clientesHoja_();

  const values = sh.getDataRange().getValues();
  const buscada = String(empresa || '').trim().toLowerCase();
  if (!buscada) return null;

  for (let i = 1; i < values.length; i++) {
    const emp = String(values[i][0] || '').trim();

    if (emp.toLowerCase() === buscada && clientesEsActivo_(values[i][6])) {
      return {
        empresa: emp,
        tarifaHora: Number(values[i][1] || 0),
        telefonoWhatsapp: String(values[i][2] || ''),
        email: String(values[i][3] || ''),
        contacto: String(values[i][4] || ''),
        notas: String(values[i][5] || '')
      };
    }
  }

  return null;
}

function clientesEsActivo_(valor) {
  const v = String(valor === undefined ? 'TRUE' : valor).trim().toLowerCase();
  return valor === true || v === 'true' || v === 'si' || v === 'sí' || v === '1' || v === '';
}

function clientesHoja_() {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEETS.clientes);
  if (!sh) sh = ss.insertSheet(SHEETS.clientes);
  asegurarClientes_();
  return sh;
}
