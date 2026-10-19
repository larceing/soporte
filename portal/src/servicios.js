// Catálogo de servicios que el gestor da a Sindri como artículos (por horas). Cada trabajo va al
// primer servicio cuyas palabras aparecen en el título de su incidencia o en su concepto; si
// ninguno encaja, a «Resolución de incidencias» o «Desarrollos a medida» según el tipo, y las horas
// sin incidencia a «Hora de soporte». Para afinar, se añaden palabras o servicios aquí.

const SERVICIOS = [
  { sku: 'SOP-BI-GW', name: 'Power BI: gateway, credenciales y conexiones', palabras: ['gateway', 'puerta de enlace', 'credencial', 'conmutaci'] },
  { sku: 'SOP-BI-REC', name: 'Power BI: recargas y errores de datos', palabras: ['recarga', 'refresh', 'actualización programada'] },
  { sku: 'SOP-BI-WS', name: 'Power BI: áreas de trabajo y publicación', palabras: ['espacio de trabajo', 'espacios de trabajo', 'workspace', 'publicaci'] },
  { sku: 'SOP-FABRIC', name: 'Microsoft Fabric: Lakehouse y Dataflows', palabras: ['fabric', 'lakehouse', 'dataflow'] },
  { sku: 'SOP-ERP-MIG', name: 'Migración de ERP y datos', palabras: ['migraci', 'a3erp', 'copia bd', 'copia de la base'] },
  { sku: 'SOP-BI-MOD', name: 'Modelado de datos para BI', palabras: ['modelo de datos', 'modelado', 'esquema'] },
  { sku: 'SOP-BI-INF', name: 'Power BI: informes, medidas y formato', palabras: ['informe', 'power bi', 'formato condicional', 'medida', 'dax', 'cálculo', 'calculo', 'objetivos'] },
  { sku: 'SOP-IA-PRU', name: 'IA: pruebas de campo y demostraciones', palabras: ['prueba de campo'] },
  { sku: 'SOP-IA-ANA', name: 'IA: análisis y diseño de asistentes', palabras: ['lin-ai: análisis', 'asistente ia', 'plan del asistente'] },
  { sku: 'SOP-IA-DES', name: 'IA: desarrollo e integración', palabras: [' ia', 'ia:', 'lin-ai', 'openai', 'gpt', 'inteligencia artificial'] },
  { sku: 'SOP-AZURE', name: 'Azure: infraestructura y almacenamiento', palabras: ['azure', 'file share', 'blob'] },
  { sku: 'SOP-CICD', name: 'Despliegues y automatización (CI/CD)', palabras: ['github', 'despliegue', 'deploy', 'pipeline', 'preview'] },
  { sku: 'SOP-GWS', name: 'Google Workspace y Apps Script', palabras: ['apps script', 'clasp', 'appgestion', 'google sheets', 'google drive', 'gmail'] },
  { sku: 'SOP-M365', name: 'Microsoft 365 y Teams', palabras: ['teams', 'sharepoint', 'outlook', 'office', 'microsoft 365', 'onedrive'] },
  { sku: 'SOP-ARQ', name: 'Análisis y arquitectura de soluciones', palabras: ['arquitectura', 'análisis de', 'analisis de', 'buscador'] },
  { sku: 'SOP-SEG', name: 'Ciberseguridad y consultas de seguridad', palabras: ['seguridad', 'smishing', 'phishing', 'virus', 'malware', 'contraseña'] },
  { sku: 'SOP-USR', name: 'Soporte a usuarios y puestos de trabajo', palabras: ['soporte usuario', 'pantalla', 'impresora', 'portátil', 'portatil', 'equipo', 'puesto'] },
  { sku: 'SOP-RED', name: 'Redes, VPN y comunicaciones', palabras: ['red ', 'wifi', 'vpn', 'router', 'firewall', 'dns'] },
  { sku: 'SOP-FORM', name: 'Formación y documentación', palabras: ['formación', 'formacion', 'manual', 'documentación', 'documentacion', 'curso'] },
  { sku: 'SOP-MANT', name: 'Mantenimiento y actualizaciones', palabras: ['mantenimiento', 'actualización', 'actualizacion', 'versión', 'version'] },
  { sku: 'SOP-DES', name: 'Desarrollos a medida', palabras: ['módulo', 'modulo', 'desarrollo', 'creación', 'creacion', 'automatiz'] },
  { sku: 'SOP-INC', name: 'Resolución de incidencias', palabras: [] },
  { sku: 'HORA', name: 'Hora de soporte', palabras: [] }
];
const CARGO = { sku: 'SOP-CARGO', name: 'Gastos repercutidos y licencias' };

const normal = s => ` ${String(s || '').toLowerCase()} `;

/** El servicio de un trabajo por horas, a partir del texto de su incidencia y su tipo. */
function servicioDe(texto, tipoIncidencia) {
  const t = normal(texto);
  const hallado = SERVICIOS.find(s => s.palabras.some(p => t.includes(p)));
  if (hallado) return hallado;
  if (!tipoIncidencia) return SERVICIOS.find(s => s.sku === 'HORA');
  return SERVICIOS.find(s => s.sku === (/^pet/i.test(tipoIncidencia) ? 'SOP-DES' : 'SOP-INC'));
}

module.exports = { SERVICIOS, CARGO, servicioDe };
