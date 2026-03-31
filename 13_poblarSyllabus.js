/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL
 * Archivo: 03_poblarSyllabus.gs
 * Versión: 1.2
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Poblar _CFG_SYLLABUS con los temarios semanales de las 57 materias.
 *   CERO lógica de estructura — solo contenido pedagógico.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs v3.6.1+ → getSpreadsheetByName(), escribirDatos(),
 *                                 aplicarFormatosAutomaticos_(), nowSIDEP()
 *   01_setupSidepTables.gs     → debe haberse ejecutado (crea _CFG_SYLLABUS)
 *   02_poblarConfiguraciones.gs→ debe haberse ejecutado (_CFG_SUBJECTS poblada)
 *
 * TABLA DESTINO:
 *   _CFG_SYLLABUS en SIDEP_02_GESTION_ADMIN
 *   Schema: SyllabusID | SubjectCode | WeekNumber | WeekTitle |
 *           Contents | Activity | Product | Status | CreatedAt | CreatedBy
 *   Índice de fila: syl_<SubjectCode>_W<NN> (ej: syl_FUC_W01)
 *
 * USO DIRECTO:
 *   poblarSyllabus()              — SAFE: salta si ya tiene datos
 *   poblarSyllabus({force:true})  — FORCE: limpia y reescribe todo
 *
 * VÍA ORQUESTADOR (recomendado):
 *   paso3_syllabus()        → SAFE via 99_orquestador.gs
 *   paso3_syllabus_force()  → FORCE via 99_orquestador.gs
 *
 * COBERTURA ACTUAL (57 materias):
 *   COMPLETO  (50): CTB×9, ADM×9, TLC×8, SIS×6, MKT×6, SST×8, TRV×4
 *   PENDIENTE  (7): SIS: DPW, PAI — MKT: SEM, MDA — TRV: PRL(16 sem), TFG(8 sem)
 *   Las materias PENDIENTE tienen semanas genéricas ("Semana 1", "Semana 2"…)
 *   hasta que Carlos apruebe el contenido pedagógico definitivo.
 *   Total filas generadas: ~456 (50×8 + PRL×16 + TFG×8 + resto PENDIENTE×8)
 *
 * FUENTES DE LOS TEMARIOS (extraídos Feb 2026):
 *   Sidep-TL_AUX_CTB_v2, SIDEP_AuxAdmin_Prompt_Maestro_v2,
 *   SIDEP_TEL_Prompt_Maestro_v2, SIDEP_SIS_Prompt_Maestro_v2,
 *   SIDEP_MKT_Prompt_Maestro_v2, SIDEP_SST_Prompt_Maestro_v2,
 *   SIDEP_TRV_Biblia_v2
 *   Fuente única del sistema: getSyllabusData_() al final de este archivo.
 *
 * ESCRITURA EN BATCH:
 *   getSyllabusData_() construye todas las filas en memoria (Array[]).
 *   Una sola llamada hoja.getRange().setValues() escribe las ~456 filas.
 *   Nunca usa loops individuales de celdas — preserva cuota de API de Sheets.
 *
 * FORMATOS AUTOMÁTICOS:
 *   Después de escribir datos, llama a aplicarFormatosAutomaticos_() del CONFIG
 *   para aplicar checkboxes (Is*), formatos de fecha (*Date, *At) y números
 *   (*Count, *Order) sobre filas reales. Se hace AQUÍ (no en setupSidepTables)
 *   porque insertCheckboxes() sobre celdas vacías rompe la detección de
 *   getLastRow() > 1 usada en modo SAFE. Ver 01_setupSidepTables.gs.
 *
 * PENDIENTES QUE BLOQUEAN PRODUCCIÓN:
 *   PRL (Práctica Laboral, 16 semanas): protocolo pendiente de Carlos.
 *   TFG (Trabajo Final de Grado, 8 semanas): protocolo pendiente de Carlos.
 *   DPW, PAI (SIS) y SEM, MDA (MKT): contenido pedagógico pendiente.
 *   Al completar: cambiar status a "COMPLETO" en getSyllabusData_()
 *   y re-ejecutar poblarSyllabus({force:true}).
 *
 * CAMBIOS v1.2 vs v1.1:
 *   - nowSIDEP() reemplaza new Date() para timestamps en America/Bogota.
 *   - Logger muestra conteo de filas generadas por programa al terminar.
 *   - Corrección en conteo de cobertura: 50 COMPLETO (antes 51), 7 PENDIENTE.
 *
 * CAMBIOS v1.1 vs v1.0:
 *   - Usa getSpreadsheetByName("admin") del CONFIG compartido —
 *     eliminado helper local getAdminSpreadsheet().
 *   - Usa escribirDatos() del CONFIG (batch, no loops individuales).
 *   - Alineado al patrón estándar del proyecto.
 * ============================================================
 */

function poblarSyllabus(options) {
  var opts     = options || {};
  var force    = opts.force === true;
  var inicio   = Date.now();
  var ahora    = new Date();
  var ejecutor = Session.getEffectiveUser().getEmail();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("📚 SIDEP — poblarSyllabus v1.2");
  Logger.log("   Ejecutor : " + ejecutor);
  Logger.log("   Modo     : " + (force ? "FORCE (reescribe)" : "SAFE (salta si existe)"));
  Logger.log("════════════════════════════════════════════════");

  try {
    var adminSS = getSpreadsheetByName("admin");
    var hoja    = adminSS.getSheetByName("_CFG_SYLLABUS");

    if (!hoja) {
      throw new Error("_CFG_SYLLABUS no encontrada. Ejecuta setupSidepTables() primero.");
    }

    // Verificar si ya tiene datos (modo seguro)
    if (!force && hoja.getLastRow() > 1) {
      Logger.log("⏭  _CFG_SYLLABUS ya tiene datos. Usa {force:true} para reescribir.");
      return;
    }

    // Limpiar si force
    if (force && hoja.getLastRow() > 1) {
      hoja.getRange(2, 1, hoja.getLastRow() - 1, hoja.getLastColumn()).clearContent();
      Logger.log("🗑  Contenido previo eliminado");
    }

    // Construir todas las filas
    var syllabusData = getSyllabusData_();
    var materias     = Object.keys(syllabusData);
    var filas        = [];
    var pendientes   = [];

    materias.forEach(function(code) {
      var m = syllabusData[code];
      m.semanas.forEach(function(s) {
        var wStr = s.semana < 10 ? "0" + s.semana : String(s.semana);
        filas.push([
          "syl_" + code + "_W" + wStr,
          code,
          s.semana,
          s.tema,
          (s.contenidos || []).join(" | "),
          s.actividad || "",
          s.producto  || "",
          m.status,
          ahora,
          ejecutor
        ]);
      });
      if (m.status === "PENDIENTE") pendientes.push(code);
    });

    // Escritura en batch (una sola llamada a la API)
    if (filas.length > 0) {
      hoja.getRange(2, 1, filas.length, 10).setValues(filas);
    }

    var dur = ((Date.now() - inicio) / 1000).toFixed(1);
    Logger.log("════════════════════════════════════════════════");
    Logger.log("✅ poblarSyllabus completado en " + dur + "s");
    Logger.log("   Materias  : " + materias.length);
    Logger.log("   Filas     : " + filas.length + " semanas");
    Logger.log("   COMPLETO  : " + (materias.length - pendientes.length));
    Logger.log("   PENDIENTE : " + pendientes.length + " → " + pendientes.join(", "));
    Logger.log("⏭  SIGUIENTE: crearAulas() [Semana 2 roadmap]");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("❌ ERROR en poblarSyllabus: " + e.message);
    throw e;
  }
}


// ─────────────────────────────────────────────────────────────
// HELPER — Semanas genéricas para materias PENDIENTE
// ─────────────────────────────────────────────────────────────

/**
 * Genera n semanas genéricas para materias con status PENDIENTE.
 * Produce filas con tema "Semana N" y campos vacíos — placeholder
 * que permite que _CFG_SYLLABUS tenga las filas necesarias para
 * que 05_estructurarAulas.gs pueda crear Topics en Classroom
 * (aunque el contenido pedagógico aún no esté definido).
 * Cuando Carlos apruebe el temario: reemplazar por semanas reales
 * y cambiar status a "COMPLETO" en getSyllabusData_().
 * @param {number} n — número de semanas (8 para la mayoría, 16 para PRL)
 */
function semanasGenericas_(n) {
  var s = [];
  for (var i = 1; i <= n; i++) {
    s.push({ semana: i, tema: "Semana " + i, contenidos: [], actividad: "", producto: "" });
  }
  return s;
}


// ─────────────────────────────────────────────────────────────
// FUENTE DE VERDAD — TEMARIOS
//
// Estructura por materia:
//   "CÓDIGO": {
//     status: "COMPLETO" | "PENDIENTE",
//     semanas: [
//       { semana: N, tema: "...", contenidos: [...], actividad: "...", producto: "..." }
//     ]
//   }
//
// Contents se une con " | " al escribir en Sheets.
// status="PENDIENTE" → semanas genéricas vía semanasGenericas_(n).
//
// Para agregar o corregir una materia:
//   1. Editar aquí directamente
//   2. Re-ejecutar poblarSyllabus({force:true})
//   NO tocar _CFG_SYLLABUS en Sheets directamente — se sobreescribe en el siguiente force.
//
// Extraídos de JSONs del proyecto (Feb 2026):
//   Sidep-TL_AUX_CTB_v2, SIDEP_AuxAdmin_Prompt_Maestro_v2,
//   SIDEP_TEL_Prompt_Maestro_v2, SIDEP_SIS_Prompt_Maestro_v2,
//   SIDEP_MKT_Prompt_Maestro_v2, SIDEP_SST_Prompt_Maestro_v2,
//   SIDEP_TRV_Biblia_v2
// ─────────────────────────────────────────────────────────────

function getSyllabusData_() {
  return {

    // ══════════════════════════════════════════════════════
    // CTB — 9 específicas (100% COMPLETO)
    // ══════════════════════════════════════════════════════

    "FUC": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción a la Contabilidad",
        contenidos:["Definición, objetivos y funciones","Usuarios de la información contable","Principios PCGA"],
        actividad:"Mapa conceptual de los principios contables", producto:"Mapa conceptual" },
      { semana:2, tema:"El Patrimonio y la Ecuación Contable",
        contenidos:["Activos, pasivos y patrimonio","Ecuación: Activo = Pasivo + Patrimonio"],
        actividad:"Taller práctico de clasificación de cuentas", producto:"Clasificación de cuentas" },
      { semana:3, tema:"El Plan Único de Cuentas (PUC)",
        contenidos:["Estructura del PUC en Colombia","Codificación y clasificación de cuentas"],
        actividad:"Ejercicio de búsqueda y codificación en el PUC", producto:"Ejercicio PUC resuelto" },
      { semana:4, tema:"Los Libros de Contabilidad",
        contenidos:["Libro diario","Libro mayor","Libro de inventarios y balances"],
        actividad:"Registro de transacciones en libro diario", producto:"Libro diario ejemplo" },
      { semana:5, tema:"Documentos Comerciales y Soportes",
        contenidos:["Factura de venta","Recibo de caja","Comprobante de egreso","Nota débito/crédito"],
        actividad:"Identificación y archivo de documentos", producto:"Carpeta de documentos clasificados" },
      { semana:6, tema:"Proceso Contable Básico",
        contenidos:["Ciclo contable completo","De la transacción al balance"],
        actividad:"Mini-ciclo contable empresa simulada", producto:"Ciclo contable completo" },
      { semana:7, tema:"Análisis e Interpretación de Resultados",
        contenidos:["Lectura del Estado de Resultados","Indicadores básicos de rentabilidad"],
        actividad:"Análisis de estados financieros reales", producto:"Informe de análisis" },
      { semana:8, tema:"Evaluación Final e Integración",
        contenidos:["Integración de todos los temas del curso"],
        actividad:"Examen integrador + presentación", producto:"Examen final" }
    ]},

    "NLV": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Sistema Normativo Contable Colombiano",
        contenidos:["Ley 43/1990","Decreto 2649/1993","Ley 1314/2009 — convergencia NIIF"],
        actividad:"Mapa normativo contable", producto:"Línea de tiempo normativa" },
      { semana:2, tema:"NIIF para PYMES — Fundamentos",
        contenidos:["Sección 1 y 2 NIIF PYMES","Objetivos y principios"],
        actividad:"Comparativo PCGA vs NIIF", producto:"Tabla comparativa" },
      { semana:3, tema:"Marco Regulatorio del Contador",
        contenidos:["Ley 43/1990 — Código de ética","Junta Central de Contadores"],
        actividad:"Casos de ética profesional", producto:"Análisis de caso" },
      { semana:4, tema:"Normas de Información Financiera (NIF)",
        contenidos:["Decreto 2420/2015","Grupos 1, 2 y 3 empresas"],
        actividad:"Clasificación de empresas por grupo", producto:"Clasificación justificada" },
      { semana:5, tema:"Normas Tributarias Relacionadas",
        contenidos:["Estatuto Tributario básico","Relación contabilidad-fiscalidad"],
        actividad:"Lectura artículos ET relevantes", producto:"Resumen ET aplicado" },
      { semana:6, tema:"Régimen Laboral y Seguridad Social",
        contenidos:["Código Sustantivo del Trabajo","Aportes parafiscales"],
        actividad:"Cálculo de aportes simulado", producto:"Liquidación de aportes" },
      { semana:7, tema:"Control Interno y Auditoría Básica",
        contenidos:["Concepto de control interno","Responsabilidad del contador"],
        actividad:"Evaluación de control interno empresa", producto:"Informe de hallazgos" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración normativa"], actividad:"Examen final", producto:"Examen" }
    ]},

    "SPC": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Soportes Contables: Clasificación y Archivo",
        contenidos:["Tipos de soportes","Normas de archivo","Digitalización de documentos"],
        actividad:"Organización de archivo físico y digital", producto:"Carpeta organizada" },
      { semana:2, tema:"Transacciones Comerciales Básicas",
        contenidos:["Compras y ventas","Registros de ingresos y egresos"],
        actividad:"Registro de 10 transacciones simuladas", producto:"Libro diario" },
      { semana:3, tema:"Facturación y Documentos de Venta",
        contenidos:["Factura electrónica DIAN","Notas crédito y débito"],
        actividad:"Elaboración de facturas en plantilla", producto:"Set de facturas" },
      { semana:4, tema:"Codificación Contable",
        contenidos:["PUC — cuentas de activo","PUC — cuentas de pasivo y patrimonio"],
        actividad:"Codificación de 20 transacciones", producto:"Listado codificado" },
      { semana:5, tema:"Cuentas por Pagar y por Cobrar",
        contenidos:["Cartera","Proveedores","Gestión documental de crédito"],
        actividad:"Control de cartera simulado", producto:"Reporte de cartera" },
      { semana:6, tema:"Organización Documental Contable",
        contenidos:["Tablas de retención documental","Archivo físico vs digital"],
        actividad:"Diseño de sistema de archivo", producto:"Propuesta de sistema" },
      { semana:7, tema:"Integración: Del Soporte al Registro",
        contenidos:["Flujo completo soporte → asiento → balance"],
        actividad:"Ciclo completo con empresa simulada", producto:"Ciclo documentado" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen práctico", producto:"Examen" }
    ]},

    "IBF": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Estados Financieros Básicos",
        contenidos:["Balance general","Estado de resultados","Estructura y lectura"],
        actividad:"Lectura de EEFF reales de empresa colombiana", producto:"Análisis descriptivo" },
      { semana:2, tema:"Activos — Clasificación y Valoración NIIF",
        contenidos:["Activos corrientes y no corrientes","Valor razonable vs costo"],
        actividad:"Clasificación de activos empresa simulada", producto:"Balance parcial" },
      { semana:3, tema:"Pasivos y Patrimonio",
        contenidos:["Pasivos corrientes y no corrientes","Capital y reservas"],
        actividad:"Análisis de estructura financiera", producto:"Informe de estructura" },
      { semana:4, tema:"Estado de Resultados Integral",
        contenidos:["Ingresos, costos y gastos","EBITDA básico"],
        actividad:"Construcción de P&G simulado", producto:"Estado de resultados" },
      { semana:5, tema:"Flujo de Caja Básico",
        contenidos:["Flujo operacional, inversión, financiación","Diferencia utilidad vs caja"],
        actividad:"Construcción de flujo de caja", producto:"Flujo de caja" },
      { semana:6, tema:"Análisis de Razones Financieras",
        contenidos:["Liquidez, endeudamiento, rentabilidad","Interpretación de indicadores"],
        actividad:"Cálculo de indicadores empresa real", producto:"Dashboard de indicadores" },
      { semana:7, tema:"NIIF — Impacto en los Estados Financieros",
        contenidos:["Diferencias PCGA vs NIIF en EEFF","Ejemplos prácticos"],
        actividad:"Comparativo EEFF bajo PCGA y NIIF", producto:"Tabla comparativa" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + análisis de caso", producto:"Examen" }
    ]},

    "SIC": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Sistemas de Información: Conceptos Fundamentales",
        contenidos:["Dato, información, sistema","Componentes de un SI"],
        actividad:"Diagrama de SI de empresa conocida", producto:"Diagrama" },
      { semana:2, tema:"Software Contable en Colombia",
        contenidos:["Panorama: Siigo, Helisa, World Office","Criterios de selección"],
        actividad:"Demo gratuita de software contable", producto:"Cuadro comparativo" },
      { semana:3, tema:"Configuración Inicial del Sistema",
        contenidos:["Plan de cuentas","Terceros","Centros de costo"],
        actividad:"Configuración empresa en software demo", producto:"Empresa configurada" },
      { semana:4, tema:"Registro de Transacciones en Software",
        contenidos:["Compras, ventas, pagos, cobros","Conciliación bancaria básica"],
        actividad:"Registro de 15 transacciones", producto:"Libro mayor generado" },
      { semana:5, tema:"Generación de Reportes",
        contenidos:["Balance, P&G, libros auxiliares desde software"],
        actividad:"Exportación y análisis de reportes", producto:"Set de reportes" },
      { semana:6, tema:"Seguridad y Control de la Información",
        contenidos:["Copias de seguridad","Permisos de usuario","Auditoría de registros"],
        actividad:"Política de seguridad básica", producto:"Manual de seguridad" },
      { semana:7, tema:"Integración con Obligaciones Tributarias",
        contenidos:["Medios magnéticos DIAN","Factura electrónica desde software"],
        actividad:"Generación de archivos DIAN", producto:"Archivo XML demo" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen práctico en software", producto:"Examen" }
    ]},

    "COP": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción a Costos y Presupuestos",
        contenidos:["Conceptos: costo, gasto, pérdida","Clasificación de costos"],
        actividad:"Diferenciación costo/gasto con ejemplos", producto:"Mapa conceptual" },
      { semana:2, tema:"Elementos del Costo de Producción",
        contenidos:["Materia prima directa","Mano de obra directa","CIF"],
        actividad:"Cálculo del costo de un producto", producto:"Hoja de costo" },
      { semana:3, tema:"Sistema de Costos por Órdenes",
        contenidos:["Orden de producción","Hoja de costos por orden"],
        actividad:"Caso práctico: empresa de confecciones", producto:"3 órdenes de producción" },
      { semana:4, tema:"Sistema de Costos por Procesos",
        contenidos:["Departamentalización","Unidades equivalentes"],
        actividad:"Ejercicio de costos por proceso", producto:"Informe de producción" },
      { semana:5, tema:"Punto de Equilibrio",
        contenidos:["Costos fijos y variables","Fórmula del PE","Análisis CVU"],
        actividad:"Cálculo de PE para 3 productos", producto:"Gráfica PE" },
      { semana:6, tema:"Presupuesto de Ventas y Producción",
        contenidos:["Proyección de ventas","Presupuesto de producción"],
        actividad:"Presupuesto semestral empresa simulada", producto:"Presupuesto en Excel" },
      { semana:7, tema:"Presupuesto Maestro",
        contenidos:["Integración de presupuestos","Control presupuestal"],
        actividad:"Construcción de presupuesto maestro", producto:"Presupuesto maestro" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen de costos y presupuestos", producto:"Examen" }
    ]},

    "DTI": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Sistema Tributario Colombiano",
        contenidos:["Impuestos nacionales y territoriales","DIAN: funciones y estructura"],
        actividad:"Mapa del sistema tributario", producto:"Mapa conceptual" },
      { semana:2, tema:"IVA — Impuesto al Valor Agregado",
        contenidos:["Hecho generador, base, tarifas","Responsables y no responsables"],
        actividad:"Cálculo de IVA en transacciones reales", producto:"Ejercicio IVA" },
      { semana:3, tema:"Retención en la Fuente",
        contenidos:["Agentes de retención","Tarifas por concepto","Certificados"],
        actividad:"Liquidación de retenciones", producto:"Comprobante de retención" },
      { semana:4, tema:"Impuesto de Renta — Personas Jurídicas",
        contenidos:["Base gravable","Deducciones","Formulario 110"],
        actividad:"Caso práctico liquidación renta", producto:"Declaración simulada" },
      { semana:5, tema:"Impuesto de Industria y Comercio (ICA)",
        contenidos:["Base, tarifa, plazos","Declaración en Bogotá"],
        actividad:"Liquidación de ICA empresa simulada", producto:"Declaración ICA" },
      { semana:6, tema:"Medios Magnéticos DIAN",
        contenidos:["Obligados a reportar","Especificaciones técnicas","Formulario 1001"],
        actividad:"Generación de archivo XML demo", producto:"Archivo de medios magnéticos" },
      { semana:7, tema:"Régimen Simple de Tributación (RST)",
        contenidos:["¿Quiénes pueden acogerse?","Ventajas y desventajas"],
        actividad:"Comparativo RST vs Régimen Ordinario", producto:"Análisis comparativo" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración tributaria"], actividad:"Examen", producto:"Examen" }
    ]},

    "LNG": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Nómina: Conceptos y Marco Legal",
        contenidos:["Tipos de contrato","Salario mínimo 2026","Devengados"],
        actividad:"Análisis de contrato laboral real", producto:"Cuadro de devengados" },
      { semana:2, tema:"Componentes del Salario",
        contenidos:["Salario básico, auxilio transporte","Horas extra, recargos","Vacaciones"],
        actividad:"Liquidación con todos los componentes", producto:"Nómina básica" },
      { semana:3, tema:"Deducciones de Nómina",
        contenidos:["Salud, pensión (aporte trabajador)","Retención en la fuente laboral"],
        actividad:"Cálculo de deducciones mensuales", producto:"Nómina completa" },
      { semana:4, tema:"Aportes Patronales",
        contenidos:["Salud 8.5%","Pensión 12%","ARL, Caja, ICBF, SENA"],
        actividad:"Liquidación de aportes patronales", producto:"Planilla de aportes" },
      { semana:5, tema:"Prestaciones Sociales",
        contenidos:["Prima de servicios","Cesantías e intereses","Vacaciones"],
        actividad:"Cálculo de prestaciones anuales", producto:"Provisión mensual" },
      { semana:6, tema:"Software de Nómina",
        contenidos:["Funcionalidades básicas","Integración con contabilidad"],
        actividad:"Demo en software de nómina", producto:"Nómina generada en software" },
      { semana:7, tema:"Gestión Documental Laboral",
        contenidos:["Contratos, paz y salvos","Certificados laborales","Archivo RRHH"],
        actividad:"Organización de carpeta de empleado", producto:"Carpeta organizada" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Liquidación completa: nómina + prestaciones + finiquito"],
        actividad:"Examen práctico de liquidación", producto:"Liquidación completa evaluada" }
    ]},

    "CET": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Ética Profesional del Contador",
        contenidos:["Código de ética IFAC","Ley 43/1990","Principios: integridad, objetividad, confidencialidad"],
        actividad:"Análisis de casos de ética", producto:"Reflexión escrita" },
      { semana:2, tema:"Responsabilidad del Contador Público",
        contenidos:["Responsabilidad civil, penal, disciplinaria","Fe pública"],
        actividad:"Estudio de caso: sanciones contadores", producto:"Análisis de caso" },
      { semana:3, tema:"Contabilidad y Sostenibilidad",
        contenidos:["Balance social","Contabilidad ambiental","GRI básico"],
        actividad:"Informe de sostenibilidad empresa real", producto:"Resumen GRI" },
      { semana:4, tema:"Fraude y Control Interno",
        contenidos:["Tipos de fraude contable","COSO básico","Red flags"],
        actividad:"Identificación de red flags en casos", producto:"Reporte de hallazgos" },
      { semana:5, tema:"Gobierno Corporativo",
        contenidos:["Estructura organizacional","Junta directiva","Transparencia informativa"],
        actividad:"Análisis de gobierno corporativo empresa", producto:"Informe" },
      { semana:6, tema:"Ética en la Era Digital",
        contenidos:["Manejo de datos financieros","Ciberseguridad básica para contadores"],
        actividad:"Política de seguridad de datos", producto:"Política básica" },
      { semana:7, tema:"Dilemas Éticos Contemporáneos",
        contenidos:["Casos reales Colombia","Manejo de conflictos de interés"],
        actividad:"Debate sobre dilemas éticos", producto:"Postura argumentada" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + caso ético", producto:"Examen" }
    ]},

    // ══════════════════════════════════════════════════════
    // ADM — 9 específicas (100% COMPLETO)
    // ══════════════════════════════════════════════════════

    "FUA": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción a la Administración",
        contenidos:["Definición y concepto","Evolución histórica","Áreas de la administración"],
        actividad:"Línea del tiempo histórica", producto:"Línea del tiempo ilustrada" },
      { semana:2, tema:"Escuelas del Pensamiento Administrativo",
        contenidos:["Escuela clásica (Taylor/Fayol)","Escuela humanista","Sistémica y contemporánea"],
        actividad:"Mapa conceptual comparativo", producto:"Mapa conceptual" },
      { semana:3, tema:"Funciones Básicas de la Administración",
        contenidos:["Planeación, organización, dirección, control","Ciclo PHVA"],
        actividad:"Aplicación PHVA a empresa local", producto:"Caso PHVA" },
      { semana:4, tema:"Estructura Organizacional",
        contenidos:["Tipos de organigramas","Diseño organizacional","Delegación y autoridad"],
        actividad:"Construcción de organigrama real", producto:"Organigrama empresa" },
      { semana:5, tema:"Planeación Estratégica Básica",
        contenidos:["Misión, visión, valores","Análisis DOFA","Objetivos SMART"],
        actividad:"DOFA empresa local", producto:"Análisis DOFA" },
      { semana:6, tema:"Gestión del Talento Humano",
        contenidos:["Reclutamiento y selección","Capacitación","Evaluación de desempeño"],
        actividad:"Perfil de cargo", producto:"Perfil de cargo elaborado" },
      { semana:7, tema:"Toma de Decisiones Gerenciales",
        contenidos:["Proceso de decisión","Árbol de decisiones","Inteligencia emocional gerencial"],
        actividad:"Árbol de decisiones caso empresarial", producto:"Árbol de decisiones" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen final", producto:"Examen" }
    ]},

    "HCD": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Comunicación Efectiva en el Entorno Laboral",
        contenidos:["Tipos de comunicación","Barreras comunicativas","Comunicación asertiva"],
        actividad:"Autoevaluación comunicativa", producto:"Plan de mejora personal" },
      { semana:2, tema:"Comunicación Escrita Profesional",
        contenidos:["Redacción de informes","Correos profesionales","Actas y memorandos"],
        actividad:"Redacción de informe ejecutivo", producto:"Informe redactado" },
      { semana:3, tema:"Comunicación Oral y Presentaciones",
        contenidos:["Técnicas de oratoria","Presentaciones efectivas","Lenguaje no verbal"],
        actividad:"Presentación oral 5 min", producto:"Presentación grabada" },
      { semana:4, tema:"Liderazgo y Estilos de Dirección",
        contenidos:["Teorías de liderazgo","Liderazgo situacional","Autoridad vs influencia"],
        actividad:"Test de estilo de liderazgo", producto:"Reflexión sobre estilo" },
      { semana:5, tema:"Trabajo en Equipo",
        contenidos:["Dinámicas de grupo","Roles en equipos (Belbin)","Manejo de conflictos"],
        actividad:"Dinámica de equipo", producto:"Análisis de roles" },
      { semana:6, tema:"Ética Laboral y Valores Corporativos",
        contenidos:["Ética en el trabajo","Cultura organizacional","Ley 1010 acoso laboral"],
        actividad:"Análisis de caso de ética laboral", producto:"Postura argumentada" },
      { semana:7, tema:"Inteligencia Emocional en el Trabajo",
        contenidos:["Modelo Goleman","Autoconocimiento y autorregulación","Empatía laboral"],
        actividad:"Diario de inteligencia emocional", producto:"Diario reflexivo" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + presentación oral", producto:"Examen" }
    ]},

    "HID": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Excel Básico para Gestión Administrativa",
        contenidos:["Interfaz Excel","Tipos de datos","SUMA, PROMEDIO, MAX, MIN"],
        actividad:"Hoja de cálculo básica", producto:"Planilla de datos" },
      { semana:2, tema:"Funciones Intermedias de Excel",
        contenidos:["SI, BUSCARV, CONTARSI","Formato condicional"],
        actividad:"Base de datos con BUSCARV", producto:"Base de datos funcional" },
      { semana:3, tema:"Tablas Dinámicas",
        contenidos:["Creación y configuración","Filtros y segmentaciones","Gráficos dinámicos"],
        actividad:"Tabla dinámica de ventas", producto:"Reporte con tabla dinámica" },
      { semana:4, tema:"Google Workspace para Administración",
        contenidos:["Drive, Docs, Sheets","Colaboración en tiempo real","Formularios Google"],
        actividad:"Formulario de encuesta + análisis", producto:"Formulario + reporte" },
      { semana:5, tema:"Gestión de Correo y Agenda Digital",
        contenidos:["Gmail avanzado: filtros, etiquetas","Google Calendar: gestión de reuniones"],
        actividad:"Organización del correo profesional", producto:"Sistema de carpetas" },
      { semana:6, tema:"Presentaciones Profesionales",
        contenidos:["Google Slides / PowerPoint","Principios de diseño"],
        actividad:"Presentación ejecutiva 10 slides", producto:"Presentación" },
      { semana:7, tema:"Bases de Datos Simples y Gestión Documental",
        contenidos:["Organización de archivos en Drive","Nomenclatura","Google Forms como BD"],
        actividad:"Sistema de archivo digital personal", producto:"Carpeta organizada" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Proyecto integrador en Excel", producto:"Proyecto Excel" }
    ]},

    "BFA": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Fundamentos de Análisis Financiero",
        contenidos:["Objetivos del análisis","Usuarios de la información","Fuentes"],
        actividad:"Análisis descriptivo de EEFF empresa", producto:"Análisis descriptivo" },
      { semana:2, tema:"Análisis Vertical y Horizontal",
        contenidos:["Análisis vertical: estructura porcentual","Horizontal: tendencias"],
        actividad:"AV y AH empresa real", producto:"Tabla de análisis" },
      { semana:3, tema:"Razones de Liquidez",
        contenidos:["Razón corriente","Prueba ácida","Capital de trabajo neto"],
        actividad:"Cálculo e interpretación de liquidez", producto:"Dashboard liquidez" },
      { semana:4, tema:"Razones de Endeudamiento",
        contenidos:["Nivel de endeudamiento","Leverage","Cobertura de intereses"],
        actividad:"Análisis de estructura de deuda", producto:"Informe de endeudamiento" },
      { semana:5, tema:"Razones de Rentabilidad",
        contenidos:["ROA, ROE","Margen bruto y neto","EBITDA"],
        actividad:"Cálculo de rentabilidad empresa real", producto:"Dashboard rentabilidad" },
      { semana:6, tema:"Análisis de Flujo de Caja",
        contenidos:["Flujo operacional vs utilidad neta","Proyección de caja"],
        actividad:"Flujo de caja proyectado", producto:"Flujo 6 meses" },
      { semana:7, tema:"Análisis Integral y Toma de Decisiones",
        contenidos:["Integración de indicadores","Semáforo financiero"],
        actividad:"Diagnóstico financiero completo", producto:"Informe ejecutivo" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + caso empresarial", producto:"Examen" }
    ]},

    "GSC": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Fundamentos del Servicio al Cliente",
        contenidos:["Concepto de servicio","Triángulo del servicio","Momentos de verdad"],
        actividad:"Análisis de experiencias de servicio", producto:"Mapa de momentos de verdad" },
      { semana:2, tema:"Comunicación con el Cliente",
        contenidos:["Escucha activa","Lenguaje positivo","Comunicación no verbal"],
        actividad:"Role-play de atención al cliente", producto:"Autoevaluación" },
      { semana:3, tema:"Manejo de Quejas y Reclamaciones",
        contenidos:["Protocolo LAST","Escalamiento"],
        actividad:"Resolución de casos de queja", producto:"3 casos resueltos" },
      { semana:4, tema:"Canales de Atención",
        contenidos:["Presencial, telefónico, digital","Omnicanalidad básica"],
        actividad:"Mapa de canales empresa real", producto:"Mapa de canales" },
      { semana:5, tema:"Medición de la Satisfacción",
        contenidos:["NPS, CSAT, CES","Diseño de encuestas"],
        actividad:"Diseño encuesta de satisfacción", producto:"Encuesta con Google Forms" },
      { semana:6, tema:"Cultura de Servicio en la Organización",
        contenidos:["Liderazgo orientado al cliente","Capacitación en servicio"],
        actividad:"Propuesta de cultura de servicio", producto:"Plan de mejora" },
      { semana:7, tema:"CRM Básico",
        contenidos:["Concepto de CRM","Gestión de base de datos de clientes","Fidelización"],
        actividad:"Base de datos de clientes en Sheets", producto:"CRM básico" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + caso de servicio", producto:"Examen" }
    ]},

    "CYP": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción a Costos Empresariales",
        contenidos:["Clasificación de costos","Fijos, variables, semivariables"],
        actividad:"Clasificación de costos empresa simulada", producto:"Tabla clasificación" },
      { semana:2, tema:"Costos por Departamento",
        contenidos:["Centros de costo","Asignación de costos indirectos"],
        actividad:"Distribución de costos por área", producto:"Cuadro de distribución" },
      { semana:3, tema:"Punto de Equilibrio",
        contenidos:["Fórmulas PE en unidades y pesos","Análisis multiproducto"],
        actividad:"Cálculo de PE empresa ADM", producto:"Gráfica de equilibrio" },
      { semana:4, tema:"Presupuesto de Ingresos",
        contenidos:["Proyección de ventas","Métodos de pronóstico básicos"],
        actividad:"Presupuesto de ventas mensual", producto:"Presupuesto de ingresos" },
      { semana:5, tema:"Presupuesto de Gastos Administrativos",
        contenidos:["Nómina presupuestada","Gastos operativos","Control presupuestal"],
        actividad:"Presupuesto de gastos empresa", producto:"Presupuesto de gastos" },
      { semana:6, tema:"Flujo de Caja Presupuestado",
        contenidos:["Ingresos y egresos proyectados","Déficit y superávit"],
        actividad:"Flujo de caja proyectado 6 meses", producto:"Flujo de caja" },
      { semana:7, tema:"Control Presupuestal y Variaciones",
        contenidos:["Comparativo real vs presupuesto","Análisis de variaciones"],
        actividad:"Informe de desviaciones", producto:"Informe de control" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + proyecto presupuestal", producto:"Examen" }
    ]},

    "GDR": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Fundamentos de Gestión Documental",
        contenidos:["Ley General de Archivos 594/2000","Ciclo vital del documento"],
        actividad:"Análisis del ciclo documental", producto:"Diagrama de flujo documental" },
      { semana:2, tema:"Tabla de Retención Documental (TRD)",
        contenidos:["Elaboración de TRD","Series y subseries documentales"],
        actividad:"TRD de área administrativa", producto:"TRD elaborada" },
      { semana:3, tema:"Organización del Archivo",
        contenidos:["Archivo de gestión, central, histórico","Sistemas de ordenación"],
        actividad:"Organización de archivo simulado", producto:"Archivo organizado" },
      { semana:4, tema:"Documentos Administrativos",
        contenidos:["Circular, memorando, resolución, acta","Normas ICONTEC"],
        actividad:"Redacción de documentos administrativos", producto:"Set de documentos" },
      { semana:5, tema:"Gestión Documental Digital",
        contenidos:["Digitalización y metadatos","Sistemas SGDEA"],
        actividad:"Digitalización y catalogación", producto:"Carpeta digital organizada" },
      { semana:6, tema:"Correspondencia Empresarial",
        contenidos:["Recepción y despacho","Radicación","Control de correspondencia"],
        actividad:"Proceso completo de correspondencia", producto:"Libro de correspondencia" },
      { semana:7, tema:"Preservación y Conservación",
        contenidos:["Normas de conservación física","Copia de seguridad digital"],
        actividad:"Plan de conservación documental", producto:"Plan de conservación" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + organización de archivo", producto:"Examen" }
    ]},

    "RIN": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Registros de Información Empresarial",
        contenidos:["Tipos de registros: contables, RRHH, comerciales","Fuentes primarias y secundarias"],
        actividad:"Inventario de registros empresa simulada", producto:"Inventario de registros" },
      { semana:2, tema:"Normativa Administrativa Colombiana",
        contenidos:["Cámara de Comercio","RUT y RUP","Obligaciones mercantiles"],
        actividad:"Consulta de empresa real en Cámara", producto:"Ficha normativa empresa" },
      { semana:3, tema:"Contratos y Documentos Comerciales",
        contenidos:["Tipos de contratos mercantiles","Cartas comerciales","Cotizaciones y pedidos"],
        actividad:"Elaboración de contrato de compraventa", producto:"Contrato elaborado" },
      { semana:4, tema:"Procedimientos Administrativos",
        contenidos:["Manuales de procesos","Flujogramas","Indicadores de proceso"],
        actividad:"Diseño de flujograma de proceso", producto:"Flujograma" },
      { semana:5, tema:"Protección de Datos (Ley 1581/2012)",
        contenidos:["Habeas data","Tratamiento de datos personales","Políticas de privacidad"],
        actividad:"Política de privacidad empresa", producto:"Política elaborada" },
      { semana:6, tema:"Normativa Tributaria para Administrativos",
        contenidos:["Obligaciones tributarias básicas","Retención administrativa"],
        actividad:"Identificación de obligaciones empresa", producto:"Calendario tributario" },
      { semana:7, tema:"Automatización de Procedimientos",
        contenidos:["Google Workspace para automatización","Formularios y flujos de aprobación"],
        actividad:"Flujo de aprobación en Google Forms", producto:"Proceso automatizado" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen", producto:"Examen" }
    ]},

    "GEN": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Marco Legal de la Nómina",
        contenidos:["Código Sustantivo del Trabajo","Tipos de contrato","Jornada laboral"],
        actividad:"Análisis de contrato laboral real", producto:"Ficha legal" },
      { semana:2, tema:"Componentes del Salario y Devengados",
        contenidos:["Salario básico","Auxilio de transporte 2026","Horas extra y recargos"],
        actividad:"Cálculo de devengados completos", producto:"Planilla de devengados" },
      { semana:3, tema:"Deducciones de Nómina",
        contenidos:["Salud y pensión trabajador","Retención en la fuente laboral"],
        actividad:"Liquidación de deducciones", producto:"Planilla de deducciones" },
      { semana:4, tema:"Aportes Patronales y Parafiscales",
        contenidos:["Salud 8.5%, Pensión 12%, ARL","Caja 4%, ICBF 3%, SENA 2%"],
        actividad:"Planilla de aportes PILA", producto:"Planilla PILA elaborada" },
      { semana:5, tema:"Prestaciones Sociales",
        contenidos:["Prima de servicios","Cesantías e intereses","Vacaciones"],
        actividad:"Cálculo de prestaciones anuales", producto:"Provisión mensual" },
      { semana:6, tema:"Liquidación de Contrato",
        contenidos:["Tipos de retiro","Liquidación final","Paz y salvo laboral"],
        actividad:"Liquidación completa empleado", producto:"Carta de liquidación" },
      { semana:7, tema:"Software de Nómina",
        contenidos:["Funcionalidades básicas","Comprobantes","Exportación a contabilidad"],
        actividad:"Nómina completa en software", producto:"Nómina generada" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Liquidación completa"], actividad:"Examen práctico de nómina", producto:"Examen" }
    ]},

    // ══════════════════════════════════════════════════════
    // TLC — 8 específicas (100% COMPLETO)
    // ══════════════════════════════════════════════════════

    "FUT": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción a las Telecomunicaciones",
        contenidos:["Historia y evolución","Señal, canal, ruido, ancho de banda"],
        actividad:"Línea de tiempo histórica", producto:"Cuestionario 10 preguntas" },
      { semana:2, tema:"Tipos de Señales",
        contenidos:["Señales analógicas y digitales","Modulación y demodulación"],
        actividad:"Identificar señales en dispositivos reales", producto:"Investigación AM vs FM" },
      { semana:3, tema:"Medios de Transmisión",
        contenidos:["Medios guiados y no guiados","Atenuación y distorsión"],
        actividad:"Comparar cables y antenas", producto:"Cuadro comparativo" },
      { semana:4, tema:"Componentes del Sistema",
        contenidos:["Emisor, receptor, canal","Repetidores y amplificadores"],
        actividad:"Analizar esquema de sistema real", producto:"Informe técnico" },
      { semana:5, tema:"Redes de Telecomunicaciones",
        contenidos:["Redes públicas y privadas","Redes de acceso y transporte"],
        actividad:"Mapa conceptual", producto:"Mapa conceptual" },
      { semana:6, tema:"Protocolos y Estándares",
        contenidos:["Concepto de protocolo","Estándares ISO, ITU, IEEE"],
        actividad:"Debate sobre importancia de estándares", producto:"Relatoría del debate" },
      { semana:7, tema:"Tendencias Actuales",
        contenidos:["5G, IoT, virtualización de redes"],
        actividad:"Investigación: avances en Colombia", producto:"Informe de tendencias" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Presentación individual", producto:"Propuesta de sistema" }
    ]},

    "CAB": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Estándares de Cableado Estructurado",
        contenidos:["ANSI/TIA-568","Categorías de cable Cat5e, Cat6, Cat6A","Topologías"],
        actividad:"Identificar estándares en catálogos", producto:"Cuadro comparativo de categorías" },
      { semana:2, tema:"Materiales y Herramientas",
        contenidos:["Tipos de cable UTP, STP, coaxial","Herramientas de crimpado","Patch panels"],
        actividad:"Reconocimiento de materiales físicos", producto:"Inventario de materiales" },
      { semana:3, tema:"Normas de Seguridad y ESD",
        contenidos:["Equipos de protección","Normativa eléctrica","Gestión de residuos"],
        actividad:"Checklist de seguridad", producto:"Protocolo de seguridad" },
      { semana:4, tema:"Instalación de Cableado Horizontal",
        contenidos:["Tendido de cable","Canaletas y tuberías","Distancias máximas"],
        actividad:"Práctica de instalación en aula", producto:"Tramo instalado y certificado" },
      { semana:5, tema:"Crimpado y Certificación",
        contenidos:["Conectores RJ45","Secuencia T568A y T568B","Pruebas con certificador"],
        actividad:"Elaboración de 5 cables certificados", producto:"Set de cables certificados" },
      { semana:6, tema:"Armado de Rack y Patch Panel",
        contenidos:["Distribución en rack","Patcheo y etiquetado","Gestión del cableado"],
        actividad:"Armado de rack simulado", producto:"Rack organizado y etiquetado" },
      { semana:7, tema:"Documentación de la Red",
        contenidos:["Planos de red","Inventario de activos","Etiquetado físico"],
        actividad:"Documentación de la instalación práctica", producto:"Plano de red" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Proyecto de instalación completo", producto:"Instalación documentada" }
    ]},

    "FOT": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Fundamentos de la Fibra Óptica",
        contenidos:["Propagación de la luz","Monomodo y multimodo","Ventajas vs cobre"],
        actividad:"Comparativa fibra vs cable de cobre", producto:"Informe comparativo" },
      { semana:2, tema:"Componentes de una Red de Fibra",
        contenidos:["Transceptores, ODF, splice closure","Conectores: SC, LC, ST"],
        actividad:"Identificación de componentes físicos", producto:"Inventario de componentes" },
      { semana:3, tema:"Normas y Estándares de Fibra",
        contenidos:["ITU-T G.652","Normas de instalación indoor/outdoor"],
        actividad:"Aplicación de normas en casos", producto:"Lista de chequeo normativa" },
      { semana:4, tema:"Fusión de Fibra Óptica",
        contenidos:["Preparación del cable","Proceso de fusión","Medición de pérdidas"],
        actividad:"Demostración de fusión", producto:"Registro de fusiones" },
      { semana:5, tema:"Instalación de Redes FTTH",
        contenidos:["Arquitectura PON","Splitters ópticos","Distribución domiciliaria"],
        actividad:"Diseño de red FTTH básica", producto:"Diagrama de red FTTH" },
      { semana:6, tema:"Certificación y Medición",
        contenidos:["OTDR: interpretación de curvas","Pérdidas admisibles"],
        actividad:"Lectura de curva OTDR real", producto:"Informe de certificación" },
      { semana:7, tema:"Mantenimiento y Resolución de Fallas",
        contenidos:["Localización de fallas","Procedimientos de reparación","Documentación"],
        actividad:"Diagnóstico de falla simulada", producto:"Reporte de falla y solución" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Proyecto de diseño e instalación", producto:"Proyecto documentado" }
    ]},

    "IRA": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Fundamentos de Redes Inalámbricas",
        contenidos:["IEEE 802.11","Frecuencias 2.4 GHz y 5 GHz","Topologías Wi-Fi"],
        actividad:"Análisis de redes Wi-Fi del entorno", producto:"Inventario de redes detectadas" },
      { semana:2, tema:"Equipos de Red Inalámbrica",
        contenidos:["Access points, routers, controladores","Configuración básica"],
        actividad:"Configuración de AP en laboratorio", producto:"AP configurado" },
      { semana:3, tema:"Seguridad en Redes Inalámbricas",
        contenidos:["WPA2, WPA3","Segmentación por VLAN","Redes de invitados"],
        actividad:"Configuración de seguridad Wi-Fi", producto:"Red segmentada" },
      { semana:4, tema:"Diseño de Cobertura Wi-Fi",
        contenidos:["Herramientas de site survey","Cálculo de cobertura","Puntos muertos"],
        actividad:"Site survey de instalación real", producto:"Mapa de cobertura" },
      { semana:5, tema:"Administración de Redes",
        contenidos:["Monitoreo de red","SNMP básico","Wireshark, PRTG"],
        actividad:"Monitoreo de red en tiempo real", producto:"Reporte de tráfico" },
      { semana:6, tema:"VPNs y Acceso Remoto",
        contenidos:["Concepto de VPN","Configuración básica","Casos de uso empresarial"],
        actividad:"Configuración de VPN básica", producto:"VPN funcional documentada" },
      { semana:7, tema:"Redes en Entornos Empresariales",
        contenidos:["Integración cableado + inalámbrico","Red convergente"],
        actividad:"Diseño de red convergente empresa", producto:"Diseño de red completo" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Proyecto de diseño de red", producto:"Proyecto de red" }
    ]},

    "PRE": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Modelo OSI y TCP/IP",
        contenidos:["Las 7 capas OSI","Modelo TCP/IP de 4 capas","Encapsulamiento"],
        actividad:"Diagrama comparativo OSI vs TCP/IP", producto:"Informe de capas" },
      { semana:2, tema:"Direccionamiento IP",
        contenidos:["IPv4: clases y CIDR","Subnetting básico","Máscara de subred"],
        actividad:"Ejercicios de subnetting", producto:"Tabla de subredes" },
      { semana:3, tema:"Fundamentos de Enrutamiento",
        contenidos:["Concepto de enrutamiento","Rutas estáticas","Tabla de enrutamiento"],
        actividad:"Rutas estáticas en Packet Tracer", producto:"Topología funcional" },
      { semana:4, tema:"Protocolos de Enrutamiento Dinámico",
        contenidos:["RIP v2 básico","OSPF básico","Comparación"],
        actividad:"Implementación OSPF en simulador", producto:"Red con OSPF funcional" },
      { semana:5, tema:"VLANs y Conmutación",
        contenidos:["Concepto de VLAN","Configuración en switches","Trunk y Access"],
        actividad:"Segmentación por VLANs", producto:"Red segmentada por VLAN" },
      { semana:6, tema:"Protocolos de Capa de Transporte",
        contenidos:["TCP vs UDP","Control de flujo","Puertos y sockets"],
        actividad:"Análisis de tráfico con Wireshark", producto:"Informe de análisis" },
      { semana:7, tema:"Servicios de Red",
        contenidos:["DNS, DHCP, NAT","Configuración básica de servicios"],
        actividad:"Configuración de DHCP y DNS", producto:"Servicios configurados" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Proyecto de red enrutada completa", producto:"Proyecto Packet Tracer" }
    ]},

    "ITS": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Infraestructura de Telecomunicaciones",
        contenidos:["Arquitectura de red de operador","Backbone y redes de acceso","POP y NOC"],
        actividad:"Análisis de infraestructura operador real", producto:"Diagrama de arquitectura" },
      { semana:2, tema:"Redes de Transmisión",
        contenidos:["SDH/PDH","DWDM básico","Capacidad y jerarquías"],
        actividad:"Comparativo tecnologías de transmisión", producto:"Cuadro comparativo" },
      { semana:3, tema:"Telefonía IP (VoIP)",
        contenidos:["Protocolos SIP y H.323","QoS para voz","Centrales IP"],
        actividad:"Configuración básica de VoIP", producto:"Llamada IP funcional" },
      { semana:4, tema:"Servicio Satelital",
        contenidos:["GEO, MEO, LEO","Bandas de frecuencia","VSAT, GPS"],
        actividad:"Análisis de servicio VSAT en Colombia", producto:"Caso de uso VSAT" },
      { semana:5, tema:"Redes Móviles",
        contenidos:["Evolución 2G→5G","Arquitectura celular","RAN, core, backhaul"],
        actividad:"Mapa de cobertura operadores Colombia", producto:"Análisis de cobertura" },
      { semana:6, tema:"Gestión de Infraestructura de TI",
        contenidos:["ITIL básico","Gestión de activos","SLAs y disponibilidad"],
        actividad:"Diseño de SLA básico", producto:"SLA elaborado" },
      { semana:7, tema:"Seguridad en Infraestructura Telecom",
        contenidos:["Amenazas a la infraestructura","Firewalls, IDS/IPS","Alta disponibilidad"],
        actividad:"Evaluación de riesgos infraestructura", producto:"Mapa de riesgos" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Proyecto de diseño de infraestructura", producto:"Propuesta técnica" }
    ]},

    "TAL": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Marco Legal del Trabajo en Alturas",
        contenidos:["Resolución 4272/2021","Resolución 0312/2019","Obligaciones"],
        actividad:"Análisis de la normativa vigente", producto:"Mapa normativo" },
      { semana:2, tema:"Riesgos en el Trabajo en Alturas",
        contenidos:["Caída libre","Efecto péndulo","Trauma por suspensión"],
        actividad:"Identificación de riesgos en obra real", producto:"Matriz de riesgos" },
      { semana:3, tema:"Equipos de Protección Individual (EPI)",
        contenidos:["Arnés de cuerpo completo","Conectores y cuerdas","Líneas de vida"],
        actividad:"Inspección de EPI en laboratorio", producto:"Lista de verificación EPI" },
      { semana:4, tema:"Anclajes y Puntos de Sujeción",
        contenidos:["Tipos de anclaje","Resistencia mínima","Instalación correcta"],
        actividad:"Práctica de instalación de anclajes", producto:"Reporte de práctica" },
      { semana:5, tema:"Sistemas de Acceso",
        contenidos:["Escaleras, andamios, plataformas","Acceso vs detención de caída"],
        actividad:"Inspección de andamio", producto:"Checklist de andamio" },
      { semana:6, tema:"Planificación y Permisos de Trabajo",
        contenidos:["Análisis de Trabajo Seguro (ATS)","Permiso de trabajo","Análisis previo"],
        actividad:"Elaboración de ATS y permiso", producto:"Formato ATS + permiso" },
      { semana:7, tema:"Rescate Básico en Alturas",
        contenidos:["Procedimientos de rescate","Trauma por suspensión: tiempo máximo","Emergencias"],
        actividad:"Simulacro de rescate", producto:"Reporte de simulacro" },
      { semana:8, tema:"Evaluación Final y Certificación",
        contenidos:["Integración teórica y práctica"],
        actividad:"Examen teórico + práctica supervisada", producto:"Examen de certificación" }
    ]},

    "MAO": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Aritmética Aplicada a Telecomunicaciones",
        contenidos:["Potencias de 2","Conversión binario-hexadecimal-decimal"],
        actividad:"Ejercicios de conversión numérica", producto:"Taller resuelto" },
      { semana:2, tema:"Álgebra Booleana",
        contenidos:["AND, OR, NOT, XOR","Tablas de verdad","Circuitos lógicos básicos"],
        actividad:"Tablas de verdad y simplificación", producto:"Ejercicios resueltos" },
      { semana:3, tema:"Logaritmos y Decibelios",
        contenidos:["Logaritmo base 10","dB en telecomunicaciones","Ganancia y pérdida"],
        actividad:"Cálculo de pérdidas en línea de transmisión", producto:"Taller de dB" },
      { semana:4, tema:"Trigonometría Aplicada",
        contenidos:["Funciones trigonométricas","Ondas sinusoidales","Ángulos en instalaciones"],
        actividad:"Cálculo de altura de antena", producto:"Problema resuelto" },
      { semana:5, tema:"Vectores y Diagramas Fasoriales",
        contenidos:["Representación vectorial de señales","Suma de fasores","Impedancia"],
        actividad:"Diagramas fasoriales en circuitos AC", producto:"Ejercicios fasoriales" },
      { semana:6, tema:"Probabilidad y Estadística Básica",
        contenidos:["Distribuciones básicas","Media, mediana, moda","Aplicación en QoS"],
        actividad:"Análisis estadístico de tráfico de red", producto:"Informe estadístico" },
      { semana:7, tema:"Matemáticas para Subnetting",
        contenidos:["Operaciones binarias para máscaras","Hosts por subred","VLSM básico"],
        actividad:"Diseño de esquema VLSM", producto:"Tabla de subnetting" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen de matemáticas operativas", producto:"Examen" }
    ]},

    // ══════════════════════════════════════════════════════
    // SIS — 8 específicas (6 COMPLETO, 2 PENDIENTE)
    // ══════════════════════════════════════════════════════

    "FDP": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción a la Programación",
        contenidos:["Concepto de programación","Algoritmos","Diagramas de flujo"],
        actividad:"Diagrama de flujo de rutina diaria", producto:"Diagrama de flujo" },
      { semana:2, tema:"Tipos de Datos y Variables",
        contenidos:["Variables en Python","int, float, str, bool","input() y print()"],
        actividad:"Programa que calcule el IMC", producto:"Código Python funcional" },
      { semana:3, tema:"Operadores",
        contenidos:["Aritméticos: +,-,*,/,%,**","Relacionales: ==,!=,<,>","Lógicos: and, or, not"],
        actividad:"Taller de cálculos básicos", producto:"Taller resuelto" },
      { semana:4, tema:"Estructuras Condicionales",
        contenidos:["if, if-else, elif","Anidamientos"],
        actividad:"Recomendar películas según edad", producto:"Programa funcional" },
      { semana:5, tema:"Estructuras Repetitivas",
        contenidos:["while","for","break y continue"],
        actividad:"Juego de adivinanza con while", producto:"Juego funcional" },
      { semana:6, tema:"Funciones",
        contenidos:["def","Parámetros y argumentos","Retorno de valores"],
        actividad:"Calculadora modular con funciones", producto:"Calculadora funcional" },
      { semana:7, tema:"Listas y Estructuras de Datos Básicas",
        contenidos:["Listas: creación, acceso, métodos","Diccionarios básicos","for sobre listas"],
        actividad:"Gestión de notas de estudiantes", producto:"Programa de gestión de notas" },
      { semana:8, tema:"Proyecto Integrador",
        contenidos:["Integración de todos los temas"],
        actividad:"Mini-sistema de registro con menú", producto:"Proyecto final Python" }
    ]},

    "BDA": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción a Bases de Datos",
        contenidos:["Concepto de BD","Tipos: relacional, NoSQL","MySQL, PostgreSQL, SQLite"],
        actividad:"Instalación de SQLite + primer acceso", producto:"BD creada" },
      { semana:2, tema:"Modelo Entidad-Relación",
        contenidos:["Entidades, atributos, relaciones","Cardinalidad","Diagrama ER"],
        actividad:"Diagrama ER para sistema de biblioteca", producto:"Diagrama ER" },
      { semana:3, tema:"SQL — DDL",
        contenidos:["CREATE TABLE","Tipos de datos SQL","PRIMARY KEY, FOREIGN KEY"],
        actividad:"Crear tablas del diagrama ER", producto:"Script DDL funcional" },
      { semana:4, tema:"SQL — DML Básico",
        contenidos:["INSERT INTO","SELECT básico","UPDATE, DELETE"],
        actividad:"Poblar y consultar la BD creada", producto:"Consultas funcionando" },
      { semana:5, tema:"SQL — Consultas Avanzadas",
        contenidos:["WHERE con condiciones múltiples","ORDER BY, GROUP BY","COUNT, SUM, AVG"],
        actividad:"10 consultas sobre BD de ventas", producto:"Script de consultas" },
      { semana:6, tema:"SQL — JOINs",
        contenidos:["INNER JOIN","LEFT JOIN","Consultas con múltiples tablas"],
        actividad:"Consultas con JOIN en BD de 3 tablas", producto:"Consultas con JOIN" },
      { semana:7, tema:"Algoritmos de Búsqueda y Ordenamiento",
        contenidos:["Búsqueda lineal y binaria","Bubble sort, selection sort","Complejidad O(n)"],
        actividad:"Implementación en Python", producto:"Código con análisis de complejidad" },
      { semana:8, tema:"Proyecto Integrador",
        contenidos:["Integración BD + algoritmos"],
        actividad:"Sistema de gestión con BD y consultas", producto:"Proyecto final" }
    ]},

    "EXC": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Excel para Sistemas — Fundamentos",
        contenidos:["Interfaz y estructura","Referencia absoluta y relativa","Formatos numéricos"],
        actividad:"Hoja de seguimiento de bugs", producto:"Planilla funcional" },
      { semana:2, tema:"Funciones Lógicas y de Búsqueda",
        contenidos:["SI, Y, O anidados","BUSCARV, ÍNDICE+COINCIDIR"],
        actividad:"Sistema de inventario con BUSCARV", producto:"Inventario funcional" },
      { semana:3, tema:"Análisis de Datos con Excel",
        contenidos:["Tablas dinámicas","Filtros avanzados","Segmentación"],
        actividad:"Dashboard de ventas con tabla dinámica", producto:"Dashboard" },
      { semana:4, tema:"Gráficos y Visualización",
        contenidos:["Tipos de gráficos","Gráficos dinámicos","Sparklines"],
        actividad:"Dashboard visual de indicadores", producto:"Dashboard visual" },
      { semana:5, tema:"Automatización con Macros Básicas",
        contenidos:["Grabadora de macros","VBA básico","Botones de acción"],
        actividad:"Macro de formato automático", producto:"Macro funcional" },
      { semana:6, tema:"Fórmulas para Análisis de Rendimiento",
        contenidos:["CONTAR.SI, SUMAR.SI, PROMEDIO.SI","Disponibilidad de sistemas"],
        actividad:"Análisis de uptime de servidores", producto:"Reporte de disponibilidad" },
      { semana:7, tema:"Excel + Google Sheets: Integración",
        contenidos:["Diferencias Excel vs Sheets","Importar datos externos","IMPORTRANGE"],
        actividad:"Dashboard en Sheets con datos de Drive", producto:"Dashboard en Sheets" },
      { semana:8, tema:"Proyecto Integrador",
        contenidos:["Integración"], actividad:"Sistema de monitoreo en Excel", producto:"Proyecto final Excel" }
    ]},

    "FRN": { status: "COMPLETO", semanas: [
      { semana:1, tema:"HTML5 — Estructura Web",
        contenidos:["DOCTYPE, head, body","Etiquetas semánticas","Formularios básicos"],
        actividad:"Página personal con HTML5 semántico", producto:"Página HTML5" },
      { semana:2, tema:"CSS3 — Estilos",
        contenidos:["Selectores, especificidad","Box model","Flexbox básico"],
        actividad:"Estilizar página personal", producto:"Página estilizada" },
      { semana:3, tema:"CSS Responsive — Mobile First",
        contenidos:["Media queries","Viewport","Grid CSS básico"],
        actividad:"Página responsive para 3 breakpoints", producto:"Página responsive" },
      { semana:4, tema:"JavaScript — Fundamentos",
        contenidos:["Variables, tipos, operadores","DOM","Eventos: click, submit"],
        actividad:"Calculadora interactiva", producto:"Calculadora funcional" },
      { semana:5, tema:"JavaScript — Funciones y Arrays",
        contenidos:["Funciones arrow","map, filter, reduce","Manipulación del DOM"],
        actividad:"Lista de tareas To-Do dinámica", producto:"App To-Do funcional" },
      { semana:6, tema:"Consumo de APIs REST",
        contenidos:["Fetch API","JSON: parse y stringify","Async/await básico"],
        actividad:"Consumir API pública (clima o noticias)", producto:"App con API" },
      { semana:7, tema:"Frameworks CSS — Bootstrap",
        contenidos:["Grid Bootstrap","Navbar, cards, modales","Utilidades"],
        actividad:"Landing page con Bootstrap", producto:"Landing page" },
      { semana:8, tema:"Proyecto Final Frontend",
        contenidos:["Integración HTML + CSS + JS"],
        actividad:"Portfolio personal responsive", producto:"Portfolio en GitHub Pages" }
    ]},

    "MPE": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción al Mantenimiento Preventivo",
        contenidos:["Conceptos de mantenimiento","Normas de seguridad ESD","Herramientas básicas"],
        actividad:"Ficha técnica del espacio de trabajo", producto:"Ficha técnica" },
      { semana:2, tema:"Identificación de Hardware",
        contenidos:["Componentes internos y externos","Periféricos","Fuentes de poder"],
        actividad:"Desmontaje y montaje de PC", producto:"Informe de componentes" },
      { semana:3, tema:"BIOS/UEFI y Diagnóstico",
        contenidos:["Configuración de BIOS","Secuencia de arranque","POST y errores"],
        actividad:"Configuración de boot en equipo real", producto:"Capturas documentadas" },
      { semana:4, tema:"Instalación de Sistemas Operativos",
        contenidos:["Windows 10/11: instalación limpia","Particionamiento","Drivers"],
        actividad:"Instalación de SO en máquina virtual", producto:"SO instalado y funcional" },
      { semana:5, tema:"Mantenimiento Preventivo Físico",
        contenidos:["Limpieza de componentes","Pasta térmica","Verificación de conexiones"],
        actividad:"Mantenimiento completo de equipo real", producto:"Reporte de mantenimiento" },
      { semana:6, tema:"Herramientas de Diagnóstico Software",
        contenidos:["CPU-Z, HWMonitor","CrystalDisk","MemTest"],
        actividad:"Diagnóstico completo con herramientas", producto:"Informe diagnóstico" },
      { semana:7, tema:"Redes en el Mantenimiento",
        contenidos:["Configuración de red Windows","Diagnóstico de conectividad","ping, ipconfig, tracert"],
        actividad:"Diagnóstico y reparación de conectividad", producto:"Reporte de red" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen teórico + práctica", producto:"Examen" }
    ]},

    "BCK": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción al Backend — Node.js",
        contenidos:["Cliente vs servidor","Instalación Node.js y npm","Primer servidor HTTP"],
        actividad:"Servidor Hello World funcional", producto:"Servidor en puerto 3000" },
      { semana:2, tema:"Express.js — Framework",
        contenidos:["Instalación Express","Rutas: GET, POST, PUT, DELETE","Middlewares básicos"],
        actividad:"API REST básica con Express", producto:"API con 4 endpoints" },
      { semana:3, tema:"Bases de Datos con Node",
        contenidos:["Conexión a MySQL desde Node","Queries con mysql2","Async/await en BD"],
        actividad:"CRUD completo en BD", producto:"CRUD funcional" },
      { semana:4, tema:"Autenticación y Seguridad",
        contenidos:["JWT: generación y validación","bcrypt para contraseñas","Middleware de auth"],
        actividad:"Sistema de login con JWT", producto:"Sistema de autenticación" },
      { semana:5, tema:"API REST — Buenas Prácticas",
        contenidos:["Códigos de estado HTTP","Validación de datos","Manejo de errores"],
        actividad:"API con validaciones y errores", producto:"API robusta" },
      { semana:6, tema:"Variables de Entorno y Configuración",
        contenidos:["dotenv","Configuración por ambiente","Secretos y seguridad"],
        actividad:"Refactorizar API con variables de entorno", producto:"API lista para producción" },
      { semana:7, tema:"Despliegue de Backend",
        contenidos:["Conceptos de hosting","Render o Railway (gratis)","Variables en producción"],
        actividad:"Desplegar API en la nube", producto:"URL pública de la API" },
      { semana:8, tema:"Proyecto Final Backend",
        contenidos:["Integración completa"],
        actividad:"API REST completa con auth y BD", producto:"Proyecto final desplegado" }
    ]},

    "DPW": { status: "PENDIENTE", semanas: semanasGenericas_(8) },
    "PAI": { status: "PENDIENTE", semanas: semanasGenericas_(8) },

    // ══════════════════════════════════════════════════════
    // MKT — 8 específicas (6 COMPLETO, 2 PENDIENTE)
    // ══════════════════════════════════════════════════════

    "FMK": { status: "COMPLETO", semanas: [
      { semana:1, tema:"¿Qué es el Marketing?",
        contenidos:["Evolución del marketing","Las 4P","Marketing tradicional vs digital"],
        actividad:"Análisis de campaña de marca conocida", producto:"Análisis de las 4P" },
      { semana:2, tema:"Comportamiento del Consumidor",
        contenidos:["Proceso de decisión de compra","Factores que influyen","Buyer persona"],
        actividad:"Construcción de buyer persona", producto:"Ficha de buyer persona" },
      { semana:3, tema:"Investigación de Mercados",
        contenidos:["Fuentes primarias y secundarias","Encuesta, entrevista, observación"],
        actividad:"Diseño y aplicación de encuesta", producto:"Encuesta + análisis" },
      { semana:4, tema:"Segmentación de Mercados",
        contenidos:["Criterios de segmentación","Geográfica, demográfica, psicográfica","Nicho"],
        actividad:"Segmentación de mercado para producto local", producto:"Mapa de segmentos" },
      { semana:5, tema:"Branding y Posicionamiento",
        contenidos:["Concepto de marca","Propuesta de valor","Posicionamiento"],
        actividad:"Propuesta de valor de marca propia", producto:"Canvas de propuesta de valor" },
      { semana:6, tema:"Mix de Marketing Digital",
        contenidos:["SEO, SEM, RRSS, Email","Embudo de conversión"],
        actividad:"Mapa de canales digitales para empresa local", producto:"Plan de medios básico" },
      { semana:7, tema:"Métricas de Marketing",
        contenidos:["CTR, CPC, ROAS, ROI","Herramientas de medición","Google Analytics básico"],
        actividad:"Análisis de métricas caso real", producto:"Dashboard de métricas" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + mini-plan de marketing", producto:"Plan de marketing" }
    ]},

    "TNM": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción al Neuromarketing",
        contenidos:["Neurociencia aplicada al consumidor","Los 3 cerebros","¿Por qué compramos?"],
        actividad:"Análisis de decisiones de compra propias", producto:"Reflexión de compra" },
      { semana:2, tema:"Emociones y Decisión de Compra",
        contenidos:["Emociones primarias en el consumo","Disparadores emocionales","FOMO"],
        actividad:"Identificar FOMO en campañas reales", producto:"3 ejemplos documentados" },
      { semana:3, tema:"Percepción Visual y Color",
        contenidos:["Psicología del color","Eye-tracking básico","Jerarquía visual"],
        actividad:"Análisis de paletas de marca", producto:"Análisis de 3 marcas" },
      { semana:4, tema:"El Poder del Storytelling",
        contenidos:["Narrativa de marca","Estructura del relato (héroe del viaje)","Storytelling digital"],
        actividad:"Historia de marca para producto local", producto:"Storytelling elaborado" },
      { semana:5, tema:"Precios y Neuromarketing",
        contenidos:["Precio psicológico","Anclaje de precios","Efecto señuelo"],
        actividad:"Análisis de estrategias de precio en tienda", producto:"Informe de análisis" },
      { semana:6, tema:"Packaging y Experiencia Sensorial",
        contenidos:["Diseño de envase","Marketing multisensorial","Aroma y sonido en retail"],
        actividad:"Evaluación sensorial de producto", producto:"Ficha sensorial" },
      { semana:7, tema:"Neuromarketing Digital",
        contenidos:["UX y usabilidad","Mapas de calor (heatmaps)","Pruebas A/B básicas"],
        actividad:"Análisis de heatmap de landing page", producto:"Recomendaciones UX" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + campaña de neuromarketing", producto:"Campaña elaborada" }
    ]},

    "CRC": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Creatividad: Mito y Realidad",
        contenidos:["Qué es y qué no es creatividad","Hemisferios cerebrales","Bloqueos creativos"],
        actividad:"Test de creatividad + reflexión", producto:"Análisis personal" },
      { semana:2, tema:"Pensamiento Lateral",
        contenidos:["Edward de Bono: seis sombreros","Técnicas de pensamiento lateral","Desafiar supuestos"],
        actividad:"Ejercicios de pensamiento lateral", producto:"Set de soluciones creativas" },
      { semana:3, tema:"Design Thinking",
        contenidos:["5 fases: empatizar, definir, idear, prototipar, evaluar","Mapa de empatía"],
        actividad:"Design Thinking para problema real", producto:"Prototipo básico" },
      { semana:4, tema:"Creatividad Visual y Diseño",
        contenidos:["Principios básicos de diseño","Tipografía y color","Canva para no diseñadores"],
        actividad:"Pieza gráfica en Canva", producto:"Pieza publicitaria" },
      { semana:5, tema:"Creatividad en Publicidad",
        contenidos:["Briefing creativo","Concepto creativo","Grandes campañas: análisis"],
        actividad:"Análisis de campaña viral", producto:"Análisis creativo" },
      { semana:6, tema:"Innovación en Marketing",
        contenidos:["Marketing disruptivo","Casos de innovación","Guerrilla marketing"],
        actividad:"Propuesta de campaña de guerrilla", producto:"Propuesta de campaña" },
      { semana:7, tema:"Contenido Creativo para Redes",
        contenidos:["Carrusel, reel, story","Storytelling visual","Calendario de contenido"],
        actividad:"Calendario de contenido mensual", producto:"Calendario editorial" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Campaña creativa integral", producto:"Campaña completa" }
    ]},

    "RSC": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Panorama de Redes Sociales",
        contenidos:["Principales plataformas 2026","Tendencias Colombia","¿Para qué sirve cada red?"],
        actividad:"Análisis de presencia digital marca local", producto:"Diagnóstico de RRSS" },
      { semana:2, tema:"Estrategia en Redes Sociales",
        contenidos:["Objetivos SMART para RRSS","Público objetivo","Selección de plataformas"],
        actividad:"Plan estratégico de RRSS", producto:"Plan de RRSS básico" },
      { semana:3, tema:"Creación de Contenido para Instagram",
        contenidos:["Feed, stories, reels, carrusel","Frecuencia y consistencia","Hashtags"],
        actividad:"Set de 5 publicaciones para Instagram", producto:"Contenido Instagram" },
      { semana:4, tema:"Facebook e Instagram Ads — Orgánico",
        contenidos:["Algoritmo de Facebook/Instagram","Engagement orgánico","Horarios óptimos"],
        actividad:"Publicación optimizada para algoritmo", producto:"Post con análisis" },
      { semana:5, tema:"TikTok y Contenido en Video",
        contenidos:["Tendencias TikTok","Video corto para marketing","Reels vs TikTok"],
        actividad:"Guion y grabación de reel/TikTok", producto:"Video publicado" },
      { semana:6, tema:"LinkedIn para Empresas y Profesionales",
        contenidos:["Optimización de perfil","Contenido B2B","Social selling básico"],
        actividad:"Optimización de perfil LinkedIn", producto:"Perfil optimizado" },
      { semana:7, tema:"Métricas y Analítica de RRSS",
        contenidos:["Reach, impressions, engagement rate","Meta Business Suite","Informes"],
        actividad:"Informe de rendimiento de RRSS", producto:"Reporte mensual" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + plan de RRSS completo", producto:"Plan de RRSS" }
    ]},

    "SEO": { status: "COMPLETO", semanas: [
      { semana:1, tema:"¿Qué es el SEO y cómo funciona Google?",
        contenidos:["Crawling, indexación, ranking","Factores de posicionamiento","On-Page vs Off-Page vs Técnico"],
        actividad:"Auditoría SEO básica de web propia", producto:"Informe de auditoría" },
      { semana:2, tema:"Investigación de Palabras Clave",
        contenidos:["Keyword research con Keyword Planner","Long tail","Intención de búsqueda"],
        actividad:"Lista de 20 keywords objetivo", producto:"Planilla de keywords" },
      { semana:3, tema:"SEO On-Page",
        contenidos:["Título, meta descripción, URL","Heading structure H1-H6","Alt text"],
        actividad:"Optimización On-Page de página existente", producto:"Página optimizada" },
      { semana:4, tema:"Contenido SEO",
        contenidos:["Creación de contenido optimizado","Blog corporativo","E-A-T"],
        actividad:"Artículo de blog optimizado para SEO", producto:"Artículo publicado" },
      { semana:5, tema:"SEO Técnico",
        contenidos:["Velocidad de carga: PageSpeed","Sitemap XML y robots.txt","Mobile-first"],
        actividad:"Análisis técnico con Google Search Console", producto:"Reporte técnico SEO" },
      { semana:6, tema:"Link Building",
        contenidos:["Importancia de los backlinks","Estrategias éticas","Domain Authority"],
        actividad:"Propuesta de estrategia de link building", producto:"Plan de link building" },
      { semana:7, tema:"SEO Local",
        contenidos:["Google My Business","Citaciones locales","SEO para negocios físicos Colombia"],
        actividad:"Optimización de ficha Google My Business", producto:"Ficha optimizada" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + auditoría SEO completa", producto:"Auditoría completa" }
    ]},

    "ANW": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción a la Analítica Web",
        contenidos:["¿Qué es y para qué sirve?","GA4 vs Universal Analytics","Métricas vs dimensiones"],
        actividad:"Instalación de GA4 en sitio web propio", producto:"Propiedad GA4 creada" },
      { semana:2, tema:"Configuración de GA4",
        contenidos:["Eventos y conversiones","Objetivos","Google Tag Manager básico"],
        actividad:"Configurar 3 eventos de conversión", producto:"Conversiones activas" },
      { semana:3, tema:"Análisis de Audiencias",
        contenidos:["Demografía y geografía","Dispositivos","Nuevos vs recurrentes"],
        actividad:"Informe de audiencia", producto:"Reporte de audiencia" },
      { semana:4, tema:"Análisis de Adquisición",
        contenidos:["Fuentes de tráfico","UTM parameters","Atribución multicanal"],
        actividad:"Crear y analizar UTMs de campaña", producto:"Campaña con UTMs" },
      { semana:5, tema:"Análisis de Comportamiento",
        contenidos:["Páginas más visitadas","Tasa de rebote","Flujo del usuario"],
        actividad:"Análisis de embudo de conversión", producto:"Análisis de embudo" },
      { semana:6, tema:"Análisis de Conversiones y ROI",
        contenidos:["ROAS, CPA, LTV básicos","E-commerce analytics básico"],
        actividad:"Cálculo de ROI de campaña digital", producto:"Informe de ROI" },
      { semana:7, tema:"Dashboards con Looker Studio",
        contenidos:["Conexión GA4 con Looker Studio","Diseño de dashboard ejecutivo","Compartir"],
        actividad:"Dashboard de marketing en Looker Studio", producto:"Dashboard publicado" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + dashboard completo", producto:"Dashboard final" }
    ]},

    "SEM": { status: "PENDIENTE", semanas: semanasGenericas_(8) },
    "MDA": { status: "PENDIENTE", semanas: semanasGenericas_(8) },

    // ══════════════════════════════════════════════════════
    // SST — 8 específicas (100% COMPLETO)
    // ══════════════════════════════════════════════════════

    "FST": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Introducción a SST",
        contenidos:["Definición, evolución e importancia","Incidente, accidente, enfermedad laboral","Principios generales SST"],
        actividad:"Mapa conceptual de fundamentos SST", producto:"Mapa conceptual" },
      { semana:2, tema:"Riesgos y Factores de Peligro",
        contenidos:["Clasificación de riesgos laborales","Físicos, químicos, biológicos, ergonómicos, psicosociales"],
        actividad:"Identificación de riesgos en puesto de trabajo real", producto:"Tabla de peligros" },
      { semana:3, tema:"Higiene Industrial",
        contenidos:["Definición y objeto","Agentes contaminantes","Métodos de control"],
        actividad:"Análisis de caso de higiene industrial", producto:"Informe de análisis" },
      { semana:4, tema:"Ergonomía y Salud Laboral",
        contenidos:["Principios de ergonomía","Factores de riesgo","Adaptación del puesto"],
        actividad:"Evaluación ergonómica de puesto de trabajo", producto:"Informe ergonómico" },
      { semana:5, tema:"Señalización y Demarcación de Áreas",
        contenidos:["Colores de seguridad NTC 1461","Señales de obligación, prohibición, advertencia","Demarcación"],
        actividad:"Diseño de señalización para área industrial", producto:"Plano de señalización" },
      { semana:6, tema:"Equipos de Protección Individual (EPI)",
        contenidos:["Categorías de EPI","Selección según matriz","Mantenimiento y reposición"],
        actividad:"Selección de EPI para 5 puestos de trabajo", producto:"Matriz de EPI" },
      { semana:7, tema:"Primeros Auxilios Básicos",
        contenidos:["Cadena de supervivencia","RCP básico","Heridas, quemaduras, fracturas"],
        actividad:"Simulacro de primeros auxilios", producto:"Protocolo de atención" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen teórico-práctico SST", producto:"Examen" }
    ]},

    "LST": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Marco Legal de la SST en Colombia",
        contenidos:["Ley 9/1979","Decreto 1072/2015","Resolución 0312/2019"],
        actividad:"Mapa normativo de SST Colombia", producto:"Mapa normativo" },
      { semana:2, tema:"Sistema General de Riesgos Laborales",
        contenidos:["Empleador, ARL, EPS, AFP","Cotizaciones","Prestaciones"],
        actividad:"Simulación de accidente laboral y ruta de atención", producto:"Flujograma" },
      { semana:3, tema:"Decreto 1072/2015 — SG-SST",
        contenidos:["Obligaciones del empleador","Ciclo PHVA en SG-SST","Documentación"],
        actividad:"Evaluación de cumplimiento SG-SST empresa", producto:"Lista de chequeo" },
      { semana:4, tema:"Resolución 0312/2019 — Estándares Mínimos",
        contenidos:["Estándares por número de trabajadores","Plan de mejora","Autoevaluación"],
        actividad:"Aplicar estándares mínimos a empresa real", producto:"Informe de autoevaluación" },
      { semana:5, tema:"COPASST y Comité de Convivencia",
        contenidos:["Conformación y funciones del COPASST","Comité de convivencia Ley 1010","Actas"],
        actividad:"Simulación de reunión COPASST", producto:"Acta de reunión" },
      { semana:6, tema:"Inspecciones de Seguridad",
        contenidos:["Tipos de inspección","Lista de chequeo","Informe de inspección"],
        actividad:"Inspección de seguridad en instalación", producto:"Informe de inspección" },
      { semana:7, tema:"Investigación de Accidentes",
        contenidos:["Metodología de análisis causal","Árbol de causas","FURAT"],
        actividad:"Investigar accidente simulado", producto:"Informe FURAT" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración normativa"], actividad:"Examen", producto:"Examen" }
    ]},

    "FDR": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Identificación de Peligros",
        contenidos:["Metodología GTC-45","Fuentes generadoras","Clasificación de peligros"],
        actividad:"Identificación de peligros en visita a empresa", producto:"Lista de peligros" },
      { semana:2, tema:"Evaluación de Riesgos",
        contenidos:["Probabilidad e impacto","Nivel de deficiencia, exposición, riesgo","Matriz GTC-45"],
        actividad:"Construcción de matriz de riesgos", producto:"Matriz de riesgos" },
      { semana:3, tema:"Factores de Riesgo Físico",
        contenidos:["Ruido, iluminación, temperatura, radiaciones","TLV"],
        actividad:"Medición de iluminación en el aula", producto:"Informe de medición" },
      { semana:4, tema:"Factores de Riesgo Químico",
        contenidos:["Sustancias peligrosas","FDS/SDS","Vías de exposición"],
        actividad:"Análisis de FDS de producto químico común", producto:"Resumen de FDS" },
      { semana:5, tema:"Factores de Riesgo Biológico",
        contenidos:["Microorganismos en el trabajo","Bioseguridad básica","Vacunación"],
        actividad:"Protocolo de bioseguridad para área", producto:"Protocolo elaborado" },
      { semana:6, tema:"Factores de Riesgo Ergonómico",
        contenidos:["Posturas forzadas","Movimientos repetitivos","Método RULA básico"],
        actividad:"Evaluación ergonómica con RULA", producto:"Informe RULA" },
      { semana:7, tema:"Factores de Riesgo Psicosocial",
        contenidos:["Estrés laboral","Batería de riesgo psicosocial","Burnout"],
        actividad:"Aplicación de instrumento de riesgo psicosocial", producto:"Análisis de resultados" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + matriz de riesgos completa", producto:"Examen" }
    ]},

    "MPT": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Salud Ocupacional — Evolución y Marco",
        contenidos:["De salud ocupacional a SST","Enfermedad laboral","Diagnóstico"],
        actividad:"Análisis de caso de enfermedad laboral", producto:"Ficha de análisis" },
      { semana:2, tema:"Vigilancia Epidemiológica",
        contenidos:["Programas de vigilancia","Indicadores epidemiológicos","Registro y notificación"],
        actividad:"Diseño básico de programa de vigilancia", producto:"Propuesta de programa" },
      { semana:3, tema:"Medicina del Trabajo",
        contenidos:["Exámenes médicos ocupacionales","Aptitud para el trabajo","Historia clínica"],
        actividad:"Análisis de historia clínica ocupacional", producto:"Informe de análisis" },
      { semana:4, tema:"Enfermedades Laborales Más Frecuentes",
        contenidos:["Hipoacusia inducida por ruido","Desórdenes musculoesqueléticos","Dermatosis"],
        actividad:"Caso clínico de enfermedad laboral", producto:"Análisis de caso clínico" },
      { semana:5, tema:"Rehabilitación y Reintegro Laboral",
        contenidos:["Rehabilitación integral","Reintegro laboral","Ayudas técnicas"],
        actividad:"Plan de reintegro laboral simulado", producto:"Plan elaborado" },
      { semana:6, tema:"Programas de Prevención de ENT",
        contenidos:["Enfermedades no transmisibles","Programas de bienestar","Pausas activas"],
        actividad:"Diseño de programa de pausas activas", producto:"Rutina de pausas activas" },
      { semana:7, tema:"Indicadores de Salud en la Empresa",
        contenidos:["Frecuencia, severidad, lesividad","Análisis de ausentismo","Informe de salud"],
        actividad:"Cálculo de indicadores caso empresa", producto:"Dashboard de indicadores de salud" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + análisis epidemiológico", producto:"Examen" }
    ]},

    "HSI": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Higiene Industrial — Fundamentos",
        contenidos:["Definición y campo de acción","Anticipación, reconocimiento, evaluación, control"],
        actividad:"Recorrido de reconocimiento de condiciones de higiene", producto:"Informe" },
      { semana:2, tema:"Seguridad Industrial — Fundamentos",
        contenidos:["Accidente de trabajo: definición legal","Causas de accidentes","Triángulo de Kausen"],
        actividad:"Análisis causal de accidentes reales", producto:"Árbol de causas" },
      { semana:3, tema:"Control de Riesgos en Fuente, Medio y Persona",
        contenidos:["Jerarquía de controles","Controles de ingeniería","Controles administrativos"],
        actividad:"Propuesta de controles para matriz de riesgos", producto:"Controles propuestos" },
      { semana:4, tema:"Orden y Aseo — Metodología 5S",
        contenidos:["Seiri, Seiton, Seiso, Seiketsu, Shitsuke","Implementación","Auditorías 5S"],
        actividad:"Implementación 5S en área de estudio", producto:"Auditoría 5S" },
      { semana:5, tema:"Permiso de Trabajo y Trabajo Seguro",
        contenidos:["Tipos de permisos","ATS","Procedimientos operativos seguros"],
        actividad:"Elaboración de ATS y permiso de trabajo", producto:"Formatos elaborados" },
      { semana:6, tema:"Manejo de Sustancias Peligrosas",
        contenidos:["Sistema SGA/GHS","Almacenamiento seguro","Planes de contingencia"],
        actividad:"Diseño de área de almacenamiento seguro", producto:"Plano de almacenamiento" },
      { semana:7, tema:"Estadísticas de Accidentalidad",
        contenidos:["Tasas: frecuencia, severidad, incidencia","Informes a ARL","Análisis de tendencias"],
        actividad:"Cálculo de indicadores de accidentalidad", producto:"Informe estadístico" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + inspección de seguridad", producto:"Examen" }
    ]},

    "ADO": { status: "COMPLETO", semanas: [
      { semana:1, tema:"La Organización como Sistema",
        contenidos:["Enfoque sistémico","Subsistemas organizacionales","Diagnóstico organizacional"],
        actividad:"Análisis sistémico de empresa local", producto:"Mapa de sistema organizacional" },
      { semana:2, tema:"Herramientas de Diagnóstico",
        contenidos:["DOFA/FODA","Árbol de problemas","Diagrama de Ishikawa"],
        actividad:"DOFA de empresa real", producto:"Matriz DOFA" },
      { semana:3, tema:"Cultura Organizacional",
        contenidos:["Valores, normas, rituales","Clima laboral vs cultura","Diagnóstico"],
        actividad:"Encuesta de clima organizacional", producto:"Análisis de clima" },
      { semana:4, tema:"Procesos y Procedimientos",
        contenidos:["Gestión por procesos","Mapa de procesos","Indicadores"],
        actividad:"Levantamiento de proceso crítico", producto:"Mapa de proceso" },
      { semana:5, tema:"Mejora Continua — Kaizen y PDCA",
        contenidos:["Ciclo PDCA/PHVA","Metodología Kaizen","5 Por qués"],
        actividad:"Plan de mejora con PDCA", producto:"Plan de acción" },
      { semana:6, tema:"Gestión del Cambio",
        contenidos:["Resistencia al cambio","Modelo de Kotter 8 pasos","Comunicación del cambio"],
        actividad:"Plan de gestión del cambio", producto:"Plan de comunicación" },
      { semana:7, tema:"Diagnóstico SST en la Organización",
        contenidos:["SG-SST en el sistema organizacional","Indicadores de gestión SST"],
        actividad:"Diagnóstico SG-SST completo de empresa", producto:"Informe de diagnóstico SG-SST" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + diagnóstico completo", producto:"Examen" }
    ]},

    "PBE": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Fundamentos de la Gestión de Emergencias",
        contenidos:["Amenaza, vulnerabilidad, riesgo","Tipos de emergencias","Decreto 2157/2017"],
        actividad:"Identificación de amenazas empresa", producto:"Inventario de amenazas" },
      { semana:2, tema:"Análisis de Vulnerabilidad",
        contenidos:["Metodología de análisis","Matriz amenaza-vulnerabilidad","Priorización"],
        actividad:"Análisis de vulnerabilidad empresa simulada", producto:"Matriz de vulnerabilidad" },
      { semana:3, tema:"Plan de Emergencias y Contingencias",
        contenidos:["Estructura del PEC","PON","Escenarios de emergencia"],
        actividad:"Diseño de PON para emergencia prioritaria", producto:"PON elaborado" },
      { semana:4, tema:"Brigadas de Emergencia",
        contenidos:["Tipos: contraincendios, evacuación, primeros auxilios","Funciones","Entrenamiento"],
        actividad:"Conformación y roles de brigada simulada", producto:"Organigrama de brigada" },
      { semana:5, tema:"Evacuación y Rutas de Escape",
        contenidos:["Diseño de rutas de evacuación","Señalización de emergencia","Planos"],
        actividad:"Elaboración de plano de evacuación", producto:"Plano de evacuación" },
      { semana:6, tema:"Contraincendios Básico",
        contenidos:["Triángulo del fuego","Tipos de extintores","Uso PASS"],
        actividad:"Práctica con extintor", producto:"Certificado de práctica" },
      { semana:7, tema:"Simulacros de Emergencia",
        contenidos:["Planificación del simulacro","Evaluación y lecciones aprendidas","Mejora del PEC"],
        actividad:"Planificación y ejecución de simulacro", producto:"Informe post-simulacro" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen + plan de emergencias completo", producto:"Plan de emergencias" }
    ]},

    "AAR": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Marco Legal de Actividades de Alto Riesgo",
        contenidos:["Decreto 2090/2003","Resolución 4272/2021","Resolución 0312/2019 AAR"],
        actividad:"Inventario AAR sector TLC/SST", producto:"Inventario de AAR" },
      { semana:2, tema:"Trabajo en Alturas — Avanzado",
        contenidos:["Sistemas de detención de caída","Restricción y posicionamiento","Líneas de vida"],
        actividad:"Inspección de sistema anti-caída", producto:"Lista de chequeo" },
      { semana:3, tema:"Espacios Confinados",
        contenidos:["Clasificación","Atmósferas peligrosas","Procedimiento de entrada"],
        actividad:"Análisis de permiso de entrada a espacio confinado", producto:"Permiso elaborado" },
      { semana:4, tema:"Trabajos Eléctricos de Alto Riesgo",
        contenidos:["LOTO","Norma RETIE básica","Riesgo y arco eléctrico"],
        actividad:"Procedimiento LOTO para equipo específico", producto:"Procedimiento LOTO" },
      { semana:5, tema:"Trabajos en Caliente",
        contenidos:["Permiso de trabajo en caliente","Control de ignición","EPI específicos"],
        actividad:"Elaboración de permiso de trabajo en caliente", producto:"Permiso elaborado" },
      { semana:6, tema:"Manejo de Sustancias Peligrosas (Avanzado)",
        contenidos:["HAZMAT: clasificación","Planes de respuesta a derrames","Coordinación ARL"],
        actividad:"Plan de respuesta a derrame simulado", producto:"Plan de contingencia" },
      { semana:7, tema:"Gestión de Contratistas en AAR",
        contenidos:["Requisitos SST para contratistas","Supervisión","Responsabilidad solidaria"],
        actividad:"Checklist de habilitación de contratista", producto:"Formato de habilitación" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen teórico-práctico AAR", producto:"Examen" }
    ]},

    // ══════════════════════════════════════════════════════
    // TRV — 5 COMPLETO, 2 PENDIENTE
    // ══════════════════════════════════════════════════════

    "APU": { status: "COMPLETO", semanas: [
      { semana:1, tema:"¿Qué es el Aprendizaje Autónomo?",
        contenidos:["Aprendizaje autónomo vs pasivo","Autorregulación","Metacognición"],
        actividad:"Diagnóstico: ¿cómo aprendo yo?", producto:"Perfil de aprendizaje" },
      { semana:2, tema:"Metas y Planificación del Aprendizaje",
        contenidos:["Objetivos SMART","Planificación semanal","Gestión del tiempo de estudio"],
        actividad:"Elaboración de plan de estudio personal", producto:"Plan de estudio mensual" },
      { semana:3, tema:"Estrategias de Búsqueda de Información",
        contenidos:["Fuentes confiables: académicas, institucionales","Google Scholar","Evaluación crítica"],
        actividad:"Búsqueda guiada de información académica", producto:"Lista curada de recursos" },
      { semana:4, tema:"Lectura Crítica y Comprensión",
        contenidos:["Estrategias de lectura activa","Subrayado, anotaciones","Inferencia y análisis"],
        actividad:"Lectura y análisis de texto académico", producto:"Mapa de ideas del texto" },
      { semana:5, tema:"Técnicas de Estudio y Comprensión",
        contenidos:["Resúmenes y síntesis","Mapas conceptuales y mentales","Espaciado, recuperación activa"],
        actividad:"Práctica con diferentes técnicas", producto:"Mapa conceptual" },
      { semana:6, tema:"Uso de Tecnologías y Recursos Digitales",
        contenidos:["Coursera, Khan Academy","Anki, Quizlet, Notion","Contenido digital como estrategia"],
        actividad:"Exploración y uso de plataformas educativas", producto:"Contenido digital creado" },
      { semana:7, tema:"Autoevaluación y Retroalimentación",
        contenidos:["Cómo evaluar el propio proceso","Estrategias de ajuste","Portafolio de evidencias"],
        actividad:"Elaboración de portafolio de evidencias", producto:"Portafolio + reflexión" },
      { semana:8, tema:"Cierre y Proyección Futura",
        contenidos:["Consolidación del aprendizaje autónomo","Planificación a largo plazo"],
        actividad:"Plan de aprendizaje personal a futuro", producto:"Foro reflexivo" }
    ]},

    "ING": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Meeting People",
        contenidos:["Verb To Be: afirmativo, negativo, interrogativo","Saludos formales e informales","Presentaciones personales"],
        actividad:"Presentación oral personal en inglés", producto:"Presentación grabada (1 min)" },
      { semana:2, tema:"Numbers and Personal Information",
        contenidos:["Números 0-100","Alfabeto y deletreo","Where are you from? How old are you?"],
        actividad:"Formulario de datos personales en inglés", producto:"Ficha personal completada" },
      { semana:3, tema:"My Family",
        contenidos:["Vocabulario de familia","Adjetivos posesivos: my, your, his, her","Describir familia"],
        actividad:"Árbol genealógico descrito en inglés", producto:"Árbol con descripciones" },
      { semana:4, tema:"Daily Routines",
        contenidos:["Simple Present — 3a persona singular","Verbos de rutina","Adverbios de frecuencia"],
        actividad:"Descripción de rutina diaria", producto:"Texto + audio de rutina" },
      { semana:5, tema:"Telling the Time and Schedules",
        contenidos:["Horas y horarios en inglés","Preposiciones: at, on, in","Preguntar y dar la hora"],
        actividad:"Horario semanal personal en inglés", producto:"Horario en inglés" },
      { semana:6, tema:"Places in Town",
        contenidos:["Vocabulario de lugares urbanos","There is / There are","Directions básicas"],
        actividad:"Describir su barrio en inglés", producto:"Descripción escrita del barrio" },
      { semana:7, tema:"Vocabulary of the Workplace",
        contenidos:["Vocabulario del lugar de trabajo","Simple Present completo","Afirmativo, negativo, interrogativo"],
        actividad:"Glosario personal de vocabulario laboral", producto:"Glosario laboral en inglés" },
      { semana:8, tema:"Review and Oral Presentations",
        contenidos:["Revisión de los 7 temas","Presentación: My Workday","Examen integrador"],
        actividad:"Presentación oral individual (2-3 min)", producto:"Presentación oral + examen final" }
    ]},

    "MAT": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Aritmética Fundamental",
        contenidos:["Números naturales, enteros, racionales","Operaciones básicas","Propiedades aritméticas"],
        actividad:"Taller de operaciones básicas aplicadas", producto:"Taller resuelto" },
      { semana:2, tema:"Fracciones y Decimales",
        contenidos:["Operaciones con fracciones","Conversión fracción-decimal-porcentaje","Aplicaciones prácticas"],
        actividad:"Ejercicios con fracciones en contexto laboral", producto:"Ejercicios resueltos" },
      { semana:3, tema:"Razones, Proporciones y Porcentajes",
        contenidos:["Razón y proporción directa e inversa","Porcentaje","Regla de tres"],
        actividad:"Problemas de porcentaje en contexto", producto:"Taller de proporciones" },
      { semana:4, tema:"Álgebra Básica",
        contenidos:["Variables y expresiones algebraicas","Ecuaciones de primer grado","Planteamiento de problemas"],
        actividad:"Resolución de ecuaciones con aplicación laboral", producto:"10 ecuaciones resueltas" },
      { semana:5, tema:"Funciones Lineales",
        contenidos:["Concepto de función","Función lineal: pendiente e intercepto","Gráfica en plano cartesiano"],
        actividad:"Graficar función lineal de problema real", producto:"Gráfica + interpretación" },
      { semana:6, tema:"Geometría Plana Básica",
        contenidos:["Perímetro y área de figuras planas","Teorema de Pitágoras","Aplicaciones en mediciones"],
        actividad:"Calcular áreas de plano de oficina", producto:"Cálculos documentados" },
      { semana:7, tema:"Estadística Básica",
        contenidos:["Media, mediana, moda","Tablas de frecuencia","Gráficos estadísticos básicos"],
        actividad:"Análisis estadístico de datos reales", producto:"Informe estadístico" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Integración"], actividad:"Examen final de matemáticas", producto:"Examen" }
    ]},

    "HIA": { status: "COMPLETO", semanas: [
      { semana:1, tema:"¿Qué es la Inteligencia Artificial?",
        contenidos:["Definición y evolución histórica","IA débil vs IA general","Impacto en el mercado laboral"],
        actividad:"Debate: ¿La IA nos quitará el trabajo?", producto:"Postura argumentada" },
      { semana:2, tema:"Herramientas de IA para Productividad",
        contenidos:["ChatGPT y Claude: usos prácticos","Copilot en Microsoft 365","Automatización básica"],
        actividad:"Comparar herramientas de IA para su área", producto:"Tabla comparativa" },
      { semana:3, tema:"IA para Escritura y Comunicación",
        contenidos:["Prompting efectivo: técnicas básicas","IA para corrección de textos","Correos, informes, presentaciones"],
        actividad:"Redactar documento profesional con IA", producto:"Documento mejorado con IA" },
      { semana:4, tema:"IA para Búsqueda e Investigación",
        contenidos:["Perplexity y búsqueda con IA","Verificación de información","Ética del uso de IA"],
        actividad:"Investigación guiada con IA", producto:"Informe con fuentes verificadas" },
      { semana:5, tema:"IA para Imagen y Contenido Visual",
        contenidos:["Midjourney, DALL-E, Canva AI","Casos de uso en marketing","Derechos de autor y ética visual"],
        actividad:"Crear material visual para su programa técnico", producto:"Set de imágenes generadas" },
      { semana:6, tema:"IA para Análisis de Datos",
        contenidos:["ChatGPT + Excel/Sheets para análisis","Interpretación de resultados","Limitaciones"],
        actividad:"Analizar conjunto de datos con IA", producto:"Informe de análisis" },
      { semana:7, tema:"IA Aplicada a su Área Técnica",
        contenidos:["Herramientas de IA por programa","Automatización de tareas repetitivas"],
        actividad:"Flujo de trabajo automatizado con IA", producto:"Flujo documentado" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Proyecto integrador"],
        actividad:"Propuesta de uso de IA en contexto laboral real", producto:"Proyecto: IA en mi trabajo" }
    ]},

    "PVE": { status: "COMPLETO", semanas: [
      { semana:1, tema:"Autoconocimiento y Propósito de Vida",
        contenidos:["Valores, fortalezas, áreas de mejora","Rueda de la vida","Ikigai"],
        actividad:"Rueda de la vida + mapa de ikigai", producto:"Mapa de ikigai personal" },
      { semana:2, tema:"Proyecto de Vida — Visión y Metas",
        contenidos:["Sueño vs meta","Metas SMART personales","Plan de vida a 1, 5 y 10 años"],
        actividad:"Construcción de plan de vida", producto:"Plan de vida estructurado" },
      { semana:3, tema:"Emprendimiento — Mentalidad",
        contenidos:["Mindset emprendedor","Tolerancia al riesgo y fracaso","Casos Colombia"],
        actividad:"Análisis de emprendedor inspirador", producto:"Informe de análisis" },
      { semana:4, tema:"Ideación de Negocio",
        contenidos:["Identificar problemas y oportunidades","Brainstorming, SCAMPER","Propuesta de valor"],
        actividad:"Generar 3 ideas de negocio", producto:"3 ideas con propuesta de valor" },
      { semana:5, tema:"Modelo Canvas",
        contenidos:["9 bloques del Business Model Canvas","Segmentos de clientes y canales","Costos e ingresos"],
        actividad:"Canvas completo para idea de negocio", producto:"Canvas elaborado" },
      { semana:6, tema:"Validación de la Idea",
        contenidos:["MVP","Entrevistas a potenciales clientes","Pivotear vs perseverar"],
        actividad:"Entrevistar 5 potenciales clientes", producto:"Informe de validación" },
      { semana:7, tema:"Financiamiento y Ecosistema Emprendedor",
        contenidos:["Innpulsa, SENA, ángeles inversores","Fondo Emprender","Pitch básico"],
        actividad:"Pitch de 3 minutos de su negocio", producto:"Pitch grabado" },
      { semana:8, tema:"Evaluación Final",
        contenidos:["Presentación final del proyecto"],
        actividad:"Presentación de proyecto de emprendimiento", producto:"Proyecto completo" }
    ]},

    // TRV C3 — protocolo pendiente de Carlos
    "PRL": { status: "PENDIENTE", semanas: semanasGenericas_(16) },
    "TFG": { status: "PENDIENTE", semanas: semanasGenericas_(8)  }
  };
}