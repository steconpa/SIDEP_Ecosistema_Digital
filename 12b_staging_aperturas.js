/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 12b_staging_aperturas.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * PROPÓSITO:
 *   Gestionar el spreadsheet SIDEP_STAGING_APERTURAS — punto de entrada
 *   donde Carlos registra las decisiones de apertura de cada período,
 *   sin tocar jamás las hojas maestras (SIDEP_01_CORE, SIDEP_02_ADMIN).
 *
 * ARQUITECTURA:
 *   SIDEP_STAGING_APERTURAS es un spreadsheet SEPARADO de las maestras.
 *   El proyecto GAS instala un trigger onOpen en él (una sola vez).
 *   Cuando Carlos lo abre, aparece el menú SIDEP con las opciones.
 *   Al ejecutar "Iniciar apertura", este script lee el staging,
 *   valida, y llama poblarAperturas({ planExterno: [...] }) —
 *   la lógica de negocio existente permanece INTACTA.
 *
 * QUIÉN PUEDE EDITAR QUÉ:
 *   Carlos → columnas A-F, filas 3 en adelante (datos de apertura)
 *   Script → columna G únicamente (Estado: Pendiente/Procesado/Error)
 *   Nadie  → fila 1 (encabezados), fila 2 (instrucciones)
 *   Nadie  → SIDEP_01_CORE ni SIDEP_02_ADMIN (jamás aparecen ante Carlos)
 *
 * FLUJO POR PERÍODO:
 *   1. Carlos abre SIDEP_STAGING_APERTURAS
 *   2. Borra los datos del período anterior (o usa "Limpiar procesados")
 *   3. Completa filas: CohortCode, Moment, Subject, Program, Transversal, Notes
 *   4. Clic en SIDEP → "Iniciar apertura"
 *   5. El script valida, llama poblarAperturas(), actualiza col G (Estado)
 *   6. Carlos ve confirmación en pantalla. Nunca toca nada más.
 *
 * SETUP (ejecutar UNA SOLA VEZ por Stevens):
 *   1. configurarStagingAperturas()  → crea el SS, lo formatea, guarda ID
 *   2. instalarTriggerStaging()      → instala onOpen en el staging SS
 *   3. Compartir el SS con Carlos (Drive → Compartir → Editor)
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs v4.2.0+ → SIDEP_CONFIG, TODOS_LOS_PROGRAMAS, MOMENT_ORDER
 *   01_SIDEP_TABLES.gs         → MOMENTOS_DIR, MOMENTOS_ART
 *   02_SIDEP_HELPERS.gs        → getSpreadsheetByName(), getTableData(), nowSIDEP()
 *   12b_poblarAperturas.gs v1.3 → poblarAperturas({ planExterno })
 *                                  REQUIERE v1.3 (soporte planExterno — 2026-03-31)
 *
 * PROPIEDAD EN SCRIPTPROPERTIES:
 *   "sidep_stagingAperturasId" → ID del spreadsheet de staging
 *   Se escribe en configurarStagingAperturas() y se lee en todas las demás.
 *
 * CORRECCIONES v1.0.0 (aplicadas antes de crear el archivo):
 *   - FIX: const en lugar de var para todas las constantes top-level.
 *   - FIX: nowSIDEP().toISOString() reemplazado por Utilities.formatDate()
 *     para evitar desfase UTC al generar notas de apertura después de las 7PM.
 *   - FIX: leerCohortesActivos_() y leerMateriasActivas_() usan getTableData()
 *     en lugar del patrón headers.indexOf() duplicado (reduce 2 API calls a 1).
 *   - FIX: validación de TRV auto-corrige IsTransversal=FALSE cuando ProgramCode=TRV.
 *   - FIX: comentario de onOpenStaging_ corregido — los installable triggers sí
 *     pueden llamar funciones con guión bajo (la restricción aplica solo a
 *     simple triggers nativos de GAS).
 *   - FIX: referencia de dependencia actualizada a v1.3 (no v1.2).
 *
 * VERSIÓN: 1.0.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-31
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// CONSTANTES LOCALES
// ─────────────────────────────────────────────────────────────

const STAGING_PROP_KEY   = "sidep_stagingAperturasId";
const STAGING_SS_NAME    = "SIDEP_STAGING_APERTURAS";
const STAGING_SHEET_NAME = "Aperturas";

// Columnas del staging (índice 1-based, para getRange)
const COL_COHORT  = 1;  // A — CohortCode
const COL_MOMENT  = 2;  // B — MomentCode
const COL_SUBJECT = 3;  // C — SubjectCode
const COL_PROGRAM = 4;  // D — ProgramCode
const COL_TRV     = 5;  // E — IsTransversal (checkbox)
const COL_NOTES   = 6;  // F — Notes
const COL_ESTADO  = 7;  // G — Estado (escrito por el script)
const TOTAL_COLS  = 7;

// Filas reservadas
const FILA_HEADERS = 1;
const FILA_INSTRUC = 2;
const FILA_DATOS   = 3;   // filas 3 en adelante son de Carlos


// ─────────────────────────────────────────────────────────────
// SETUP — ejecutar UNA SOLA VEZ
// ─────────────────────────────────────────────────────────────

/**
 * Crea y configura SIDEP_STAGING_APERTURAS.
 * Guarda el ID en ScriptProperties para uso posterior.
 * Idempotente: si ya existe, solo actualiza el formato y los dropdowns.
 *
 * PASO 1 del setup. Ejecutar desde el editor GAS.
 */
function configurarStagingAperturas() {
  const inicio = Date.now();
  Logger.log("════════════════════════════════════════════════");
  Logger.log("🗂  SIDEP — configurarStagingAperturas v1.0");
  Logger.log("════════════════════════════════════════════════");

  try {
    // Obtener o crear el spreadsheet de staging
    const ss = obtenerOCrearStagingSS_();
    const id = ss.getId();

    // Guardar ID en ScriptProperties
    PropertiesService.getScriptProperties().setProperty(STAGING_PROP_KEY, id);
    Logger.log("  ✅ ID guardado en ScriptProperties: " + id);

    // Configurar la hoja principal
    const hoja = obtenerOCrearHojaStaging_(ss);

    // Aplicar encabezados, instrucciones, formato y protecciones
    aplicarEncabezados_(hoja);
    aplicarFormatoStaging_(hoja);
    aplicarProteccionesStaging_(hoja);
    actualizarDropdownsStaging_();   // carga listas desde _CFG_*

    const dur = ((Date.now() - inicio) / 1000).toFixed(1);
    Logger.log("════════════════════════════════════════════════");
    Logger.log("✅ configurarStagingAperturas completado en " + dur + "s");
    Logger.log("   URL: " + ss.getUrl());
    Logger.log("⏭  SIGUIENTE: instalarTriggerStaging() — luego compartir con Carlos");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("❌ ERROR en configurarStagingAperturas: " + e.message);
    throw e;
  }
}

/**
 * Instala el trigger onOpen en SIDEP_STAGING_APERTURAS.
 * PASO 2 del setup. Ejecutar UNA SOLA VEZ desde el editor GAS.
 * Si se ejecuta dos veces, crea dos triggers — usar limpiarTriggerStaging() primero.
 */
function instalarTriggerStaging() {
  try {
    const ss = getStagingSS_();

    // Verificar si ya existe un trigger onOpen para este SS
    const triggers = ScriptApp.getProjectTriggers();
    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i];
      if (t.getHandlerFunction() === "onOpenStaging_" &&
          t.getTriggerSourceId() === ss.getId()) {
        Logger.log("⚠️  Trigger onOpen ya existe para SIDEP_STAGING_APERTURAS.");
        Logger.log("   Si necesitas reinstalarlo: limpiarTriggerStaging() primero.");
        return;
      }
    }

    ScriptApp.newTrigger("onOpenStaging_")
      .forSpreadsheet(ss)
      .onOpen()
      .create();

    Logger.log("✅ Trigger onOpen instalado en: " + STAGING_SS_NAME);
    Logger.log("   El menú SIDEP aparecerá automáticamente cuando Carlos abra el sheet.");
    Logger.log("⏭  SIGUIENTE: compartir el spreadsheet con Carlos desde Drive.");
    Logger.log("   URL: " + ss.getUrl());

  } catch (e) {
    Logger.log("❌ ERROR en instalarTriggerStaging: " + e.message);
    throw e;
  }
}

/**
 * Elimina el trigger onOpen del staging (para reinstalar limpio).
 * Usar antes de instalarTriggerStaging() si hay duplicados.
 */
function limpiarTriggerStaging() {
  const ss       = getStagingSS_();
  const triggers = ScriptApp.getProjectTriggers();
  let eliminados = 0;
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === "onOpenStaging_" &&
        t.getTriggerSourceId() === ss.getId()) {
      ScriptApp.deleteTrigger(t);
      eliminados++;
    }
  });
  Logger.log(eliminados > 0
    ? "✅ " + eliminados + " trigger(s) eliminados."
    : "⚠️  No se encontraron triggers de staging para eliminar.");
}


// ─────────────────────────────────────────────────────────────
// TRIGGER — SE EJECUTA AUTOMÁTICAMENTE AL ABRIR EL STAGING SS
// ─────────────────────────────────────────────────────────────

/**
 * Instalado por instalarTriggerStaging() vía ScriptApp.newTrigger().
 * Se dispara automáticamente cuando Carlos abre SIDEP_STAGING_APERTURAS.
 * Agrega el menú SIDEP con las opciones de apertura.
 *
 * NOTA: el guión bajo final es convención interna de SIDEP (función privada
 * del módulo), NO un problema para GAS. Los installable triggers creados con
 * ScriptApp.newTrigger() SÍ pueden llamar funciones con guión bajo. La
 * restricción de "solo funciones públicas" aplica únicamente a los simple
 * triggers nativos (onOpen, onEdit reservados por GAS).
 */
function onOpenStaging_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ui = ss.getUi();

    ui.createMenu("SIDEP")
      .addItem("Iniciar apertura",   "iniciarAperturaDesdeStaging_")
      .addSeparator()
      .addItem("Actualizar listas",  "actualizarDropdownsStaging_")
      .addItem("Limpiar procesados", "limpiarStagingProcesados_")
      .addSeparator()
      .addItem("Ver diagnóstico",    "diagnosticoStaging_")
      .addToUi();

  } catch (e) {
    // Si falla el menú, no bloquear la apertura del SS
    Logger.log("⚠️  onOpenStaging_: error agregando menú — " + e.message);
  }
}


// ─────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL — LLAMADA DESDE EL MENÚ
// ─────────────────────────────────────────────────────────────

/**
 * Lee el staging, valida las filas, y llama poblarAperturas({ planExterno }).
 * Escribe el resultado en la columna G (Estado) de cada fila.
 *
 * Llamada desde el menú: SIDEP → Iniciar apertura.
 * También puede llamarse directamente desde el editor para pruebas.
 */
function iniciarAperturaDesdeStaging_() {
  const ss = getStagingSS_();
  const ui = ss.getUi();

  try {
    Logger.log("════════════════════════════════════════════════");
    Logger.log("📋 SIDEP — iniciarAperturaDesdeStaging_ v1.0");
    Logger.log("   Ejecutor: " + Session.getEffectiveUser().getEmail());
    Logger.log("════════════════════════════════════════════════");

    const hoja = ss.getSheetByName(STAGING_SHEET_NAME);
    if (!hoja) {
      throw new Error("Hoja '" + STAGING_SHEET_NAME + "' no encontrada.");
    }

    // ── FASE 1: Leer datos del staging en memoria (1 llamada) ─────────────
    const lastRow = hoja.getLastRow();
    if (lastRow < FILA_DATOS) {
      ui.alert("Sin datos", "No hay filas de apertura para procesar. " +
               "Completar las columnas A-F desde la fila 3.", ui.ButtonSet.OK);
      return;
    }

    const numFilas = lastRow - FILA_DATOS + 1;
    const datos    = hoja.getRange(FILA_DATOS, 1, numFilas, TOTAL_COLS).getValues();

    // ── FASE 2: Validar y construir plan en memoria ───────────────────────
    const resultado = construirPlanDesdeStaging_(datos);

    if (resultado.plan.length === 0) {
      const msg = "No hay filas válidas para procesar.\n\nErrores encontrados:\n" +
                  resultado.errores.join("\n");
      ui.alert("Sin aperturas válidas", msg, ui.ButtonSet.OK);
      escribirEstadosBatch_(hoja, resultado.estadosPorFila, numFilas);
      return;
    }

    // ── FASE 3: Confirmar con el usuario ──────────────────────────────────
    const cohortesUnicos = [];
    resultado.plan.forEach(function(a) {
      if (cohortesUnicos.indexOf(a.cohortCode) === -1) {
        cohortesUnicos.push(a.cohortCode);
      }
    });

    let resumen = resultado.plan.length + " apertura(s) para: " + cohortesUnicos.join(", ");
    if (resultado.errores.length > 0) {
      resumen += "\n\n⚠️  " + resultado.errores.length + " fila(s) con error (ver columna G).";
    }

    const confirmar = ui.alert(
      "Confirmar apertura",
      resumen + "\n\n¿Continuar?",
      ui.ButtonSet.YES_NO
    );

    if (confirmar !== ui.Button.YES) {
      Logger.log("  Usuario canceló la apertura.");
      return;
    }

    // ── FASE 4: Llamar poblarAperturas con el plan del staging ────────────
    Logger.log("  📤 Enviando " + resultado.plan.length + " apertura(s) a poblarAperturas...");
    poblarAperturas({
      planExterno: resultado.plan,
      cohortCode:  cohortesUnicos.length === 1 ? cohortesUnicos[0] : null,
      force:       false
    });

    // ── FASE 5: Marcar filas procesadas en col G (1 escritura batch) ──────
    resultado.estadosPorFila.forEach(function(e) {
      if (e.valida) e.estado = "Procesado ✓";
    });
    escribirEstadosBatch_(hoja, resultado.estadosPorFila, numFilas);

    Logger.log("✅ iniciarAperturaDesdeStaging_ completado.");
    ui.alert("Apertura completada",
             resultado.plan.length + " apertura(s) registradas en APERTURA_PLAN.\n" +
             "Verificar con: SIDEP → Ver diagnóstico.",
             ui.ButtonSet.OK);

  } catch (e) {
    Logger.log("❌ ERROR en iniciarAperturaDesdeStaging_: " + e.message);
    ui.alert("Error en apertura",
             "Ocurrió un error:\n\n" + e.message +
             "\n\nRevisa el Logger en el editor GAS para más detalle.",
             ui.ButtonSet.OK);
  }
}

/**
 * Refresca los dropdowns de las columnas A, B, C, D
 * leyendo los catálogos activos desde _CFG_COHORTS y _CFG_SUBJECTS.
 * Llamada desde el menú y desde configurarStagingAperturas().
 */
function actualizarDropdownsStaging_() {
  try {
    Logger.log("  🔄 Actualizando dropdowns de staging...");

    const ss   = getStagingSS_();
    const hoja = ss.getSheetByName(STAGING_SHEET_NAME);
    if (!hoja) throw new Error("Hoja '" + STAGING_SHEET_NAME + "' no encontrada.");

    // Filas de datos: desde FILA_DATOS hasta el máximo de la hoja
    const maxRow = Math.max(hoja.getMaxRows() - FILA_DATOS + 1, 100);

    // ── A: CohortCode — leer cohortes activos de _CFG_COHORTS ────────────
    const cohortes = leerCohortesActivos_();
    setDropdown_(hoja, FILA_DATOS, COL_COHORT, maxRow, cohortes);

    // ── B: MomentCode — lista fija de MOMENTOS_DIR + MOMENTOS_ART ────────
    const momentos = MOMENTOS_DIR.concat(MOMENTOS_ART);
    setDropdown_(hoja, FILA_DATOS, COL_MOMENT, maxRow, momentos);

    // ── C: SubjectCode — leer materias activas de _CFG_SUBJECTS ──────────
    const materias = leerMateriasActivas_();
    setDropdown_(hoja, FILA_DATOS, COL_SUBJECT, maxRow, materias);

    // ── D: ProgramCode — lista fija TODOS_LOS_PROGRAMAS ──────────────────
    setDropdown_(hoja, FILA_DATOS, COL_PROGRAM, maxRow, TODOS_LOS_PROGRAMAS);

    // ── E: IsTransversal — checkbox nativo (aplicarFormatoStaging_ ya lo hace) ─
    // No requiere data validation adicional — ya es checkbox

    Logger.log("  ✅ Dropdowns actualizados.");
    Logger.log("     Cohortes: " + cohortes.length + " | Materias: " + materias.length);

  } catch (e) {
    Logger.log("  ❌ ERROR en actualizarDropdownsStaging_: " + e.message);
    throw e;
  }
}

/**
 * Limpia las filas que ya fueron procesadas (Estado = "Procesado ✓").
 * Preserva las filas con error o sin procesar.
 * Llamada desde el menú: SIDEP → Limpiar procesados.
 */
function limpiarStagingProcesados_() {
  const ss = getStagingSS_();
  const ui = ss.getUi();

  try {
    const hoja    = ss.getSheetByName(STAGING_SHEET_NAME);
    const lastRow = hoja.getLastRow();
    if (lastRow < FILA_DATOS) {
      ui.alert("Sin datos", "No hay filas de datos para limpiar.", ui.ButtonSet.OK);
      return;
    }

    const numFilas = lastRow - FILA_DATOS + 1;
    const datos    = hoja.getRange(FILA_DATOS, 1, numFilas, TOTAL_COLS).getValues();

    // Filtrar filas que NO están procesadas (conservar)
    const conservar = datos.filter(function(fila) {
      const estado = String(fila[COL_ESTADO - 1] || "");
      return !estado.startsWith("Procesado");
    });

    const eliminadas = numFilas - conservar.length;
    if (eliminadas === 0) {
      ui.alert("Sin procesadas", "No hay filas marcadas como 'Procesado' para limpiar.",
               ui.ButtonSet.OK);
      return;
    }

    // Confirmar
    const conf = ui.alert("Confirmar limpieza",
                           "Se eliminarán " + eliminadas + " fila(s) procesadas. ¿Continuar?",
                           ui.ButtonSet.YES_NO);
    if (conf !== ui.Button.YES) return;

    // Reescribir la hoja (patrón memory-first)
    hoja.getRange(FILA_DATOS, 1, numFilas, TOTAL_COLS).clearContent();
    if (conservar.length > 0) {
      hoja.getRange(FILA_DATOS, 1, conservar.length, TOTAL_COLS).setValues(conservar);
    }

    ui.alert("Listo", eliminadas + " fila(s) procesadas eliminadas.", ui.ButtonSet.OK);

  } catch (e) {
    Logger.log("❌ ERROR en limpiarStagingProcesados_: " + e.message);
    ui.alert("Error", e.message, ui.ButtonSet.OK);
  }
}

/**
 * Muestra un resumen del estado del staging en el Logger.
 * Solo lectura — no modifica nada.
 * Llamada desde el menú: SIDEP → Ver diagnóstico.
 */
function diagnosticoStaging_() {
  try {
    const ss      = getStagingSS_();
    const hoja    = ss.getSheetByName(STAGING_SHEET_NAME);
    const lastRow = hoja.getLastRow();

    Logger.log("════════════════════════════════════════════════");
    Logger.log("🔍 SIDEP — Diagnóstico STAGING_APERTURAS");
    Logger.log("════════════════════════════════════════════════");

    if (lastRow < FILA_DATOS) {
      Logger.log("  Sin filas de datos (vacío).");
      return;
    }

    const numFilas = lastRow - FILA_DATOS + 1;
    const datos    = hoja.getRange(FILA_DATOS, 1, numFilas, TOTAL_COLS).getValues();
    const conteo   = { pendiente: 0, procesado: 0, error: 0, vacia: 0 };

    datos.forEach(function(fila) {
      if (!fila[0]) { conteo.vacia++; return; }
      const estado = String(fila[COL_ESTADO - 1] || "").toLowerCase();
      if (estado.startsWith("procesado"))  conteo.procesado++;
      else if (estado.startsWith("error")) conteo.error++;
      else                                  conteo.pendiente++;
    });

    Logger.log("  Total filas  : " + numFilas);
    Logger.log("  Pendientes   : " + conteo.pendiente);
    Logger.log("  Procesadas   : " + conteo.procesado);
    Logger.log("  Con error    : " + conteo.error);
    Logger.log("  Vacías       : " + conteo.vacia);
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("❌ ERROR en diagnosticoStaging_: " + e.message);
  }
}


// ─────────────────────────────────────────────────────────────
// HELPERS PRIVADOS — SETUP
// ─────────────────────────────────────────────────────────────

function obtenerOCrearStagingSS_() {
  // Intentar recuperar por ID guardado
  const props       = PropertiesService.getScriptProperties();
  const idExistente = props.getProperty(STAGING_PROP_KEY);
  if (idExistente) {
    try {
      const ssExistente = SpreadsheetApp.openById(idExistente);
      Logger.log("  ♻️  Staging SS existente encontrado: " + ssExistente.getName());
      return ssExistente;
    } catch (e) {
      Logger.log("  ⚠️  ID cacheado inválido — creando nuevo staging SS...");
      props.deleteProperty(STAGING_PROP_KEY);
    }
  }
  // Crear nuevo
  const ss = SpreadsheetApp.create(STAGING_SS_NAME);
  Logger.log("  ➕ Staging SS creado: " + STAGING_SS_NAME);
  Logger.log("     ID: " + ss.getId());
  return ss;
}

function obtenerOCrearHojaStaging_(ss) {
  let hoja = ss.getSheetByName(STAGING_SHEET_NAME);
  if (!hoja) {
    // Renombrar la hoja por defecto "Hoja 1"
    const primera = ss.getSheets()[0];
    primera.setName(STAGING_SHEET_NAME);
    hoja = primera;
    Logger.log("  ✏️  Hoja renombrada a: " + STAGING_SHEET_NAME);
  }
  return hoja;
}

function aplicarEncabezados_(hoja) {
  // Fila 1: encabezados
  const headers = [
    "CohortCode", "MomentCode", "SubjectCode",
    "ProgramCode", "IsTransversal", "Notes", "Estado"
  ];
  hoja.getRange(1, 1, 1, TOTAL_COLS).setValues([headers]);

  // Fila 2: instrucciones (merged)
  const instruccion = [
    "→ Completar filas desde la fila 3. Usar los dropdowns de cada columna. " +
    "Cuando termine ir a: SIDEP → Iniciar apertura.",
    "", "", "", "", "", ""
  ];
  hoja.getRange(2, 1, 1, TOTAL_COLS).setValues([instruccion]);

  // Congelar filas 1 y 2
  hoja.setFrozenRows(2);
  Logger.log("  📝 Encabezados e instrucciones aplicados.");
}

function aplicarFormatoStaging_(hoja) {
  const maxRows = Math.max(hoja.getMaxRows(), 200);

  // ── Fila 1: encabezados ───────────────────────────────────────────────
  hoja.getRange(1, 1, 1, TOTAL_COLS)
    .setBackground("#1a3c5e")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setFontSize(11);

  // ── Fila 2: instrucciones ─────────────────────────────────────────────
  hoja.getRange(2, 1, 1, TOTAL_COLS)
    .setBackground("#F1EFE8")
    .setFontColor("#5F5E5A")
    .setFontStyle("italic")
    .setFontSize(10)
    .mergeAcross();

  // ── Columna G (Estado): color de fondo diferenciado ──────────────────
  hoja.getRange(FILA_DATOS, COL_ESTADO, maxRows - 2, 1)
    .setBackground("#F8F8F5")
    .setFontColor("#5F5E5A")
    .setFontSize(10);

  // ── Checkbox en columna E (IsTransversal) ────────────────────────────
  hoja.getRange(FILA_DATOS, COL_TRV, maxRows - 2, 1).insertCheckboxes();

  // ── Formato condicional: fila verde cuando IsTransversal = TRUE ───────
  const reglaTRV = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied("=$E3=TRUE")
    .setBackground("#E1F5EE")
    .setRanges([hoja.getRange("A3:G" + maxRows)])
    .build();

  const reglasActuales = hoja.getConditionalFormatRules();
  reglasActuales.push(reglaTRV);
  hoja.setConditionalFormatRules(reglasActuales);

  // ── Anchos de columna ─────────────────────────────────────────────────
  hoja.setColumnWidth(COL_COHORT,   110);
  hoja.setColumnWidth(COL_MOMENT,   100);
  hoja.setColumnWidth(COL_SUBJECT,  110);
  hoja.setColumnWidth(COL_PROGRAM,  110);
  hoja.setColumnWidth(COL_TRV,       90);
  hoja.setColumnWidth(COL_NOTES,    260);
  hoja.setColumnWidth(COL_ESTADO,   120);

  Logger.log("  🎨 Formato aplicado al staging.");
}

function aplicarProteccionesStaging_(hoja) {
  const ejecutor = Session.getEffectiveUser().getEmail();

  // Proteger fila 1 y 2 (encabezados + instrucciones)
  const protHeader = hoja.getRange(1, 1, 2, TOTAL_COLS).protect();
  protHeader.setDescription("Encabezados e instrucciones — solo Stevens");
  protHeader.removeEditors(protHeader.getEditors());
  protHeader.addEditor(ejecutor);

  // Proteger columna G (Estado) — solo el script escribe aquí
  const protEstado = hoja.getRange(FILA_DATOS, COL_ESTADO, hoja.getMaxRows() - 2, 1).protect();
  protEstado.setDescription("Estado — solo el script escribe aquí");
  protEstado.removeEditors(protEstado.getEditors());
  protEstado.addEditor(ejecutor);

  Logger.log("  🔒 Protecciones aplicadas a filas 1-2 y columna G.");
}


// ─────────────────────────────────────────────────────────────
// HELPERS PRIVADOS — DROPDOWNS
// ─────────────────────────────────────────────────────────────

function setDropdown_(hoja, filaInicio, col, numFilas, lista) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(lista, true)
    .setAllowInvalid(false)
    .setHelpText("Seleccionar de la lista. Valor inválido será rechazado por el script.")
    .build();
  hoja.getRange(filaInicio, col, numFilas, 1).setDataValidation(rule);
}

/**
 * Lee cohortes activos de _CFG_COHORTS usando getTableData().
 * Retorna fallback hardcodeado si la tabla no está disponible.
 */
function leerCohortesActivos_() {
  try {
    const { datos, idx } = getTableData("core", "_CFG_COHORTS");
    const iCode   = idx["CohortCode"];
    const iActive = idx["IsActive"];

    if (iCode === undefined) throw new Error("Columna CohortCode no encontrada en _CFG_COHORTS");

    const cohortes = [];
    datos.forEach(function(fila) {
      const code   = String(fila[iCode]   || "").trim();
      const active = iActive !== undefined ? fila[iActive] : true;
      if (code && active) cohortes.push(code);
    });

    return cohortes.length > 0
      ? cohortes
      : ["AB26", "EN26", "MR26", "MY26", "AG26", "SP26"];

  } catch (e) {
    Logger.log("  ⚠️  leerCohortesActivos_: usando fallback — " + e.message);
    return ["AB26", "EN26", "MR26", "MY26", "AG26", "SP26"];
  }
}

/**
 * Lee materias activas de _CFG_SUBJECTS usando getTableData().
 * Retorna array vacío si la tabla no está disponible.
 */
function leerMateriasActivas_() {
  try {
    const { datos, idx } = getTableData("core", "_CFG_SUBJECTS");
    const iCode   = idx["SubjectCode"];
    const iActive = idx["IsActive"];

    if (iCode === undefined) throw new Error("Columna SubjectCode no encontrada en _CFG_SUBJECTS");

    const materias = [];
    datos.forEach(function(fila) {
      const code   = String(fila[iCode]   || "").trim();
      const active = iActive !== undefined ? fila[iActive] : true;
      if (code && active && materias.indexOf(code) < 0) materias.push(code);
    });

    return materias.sort();

  } catch (e) {
    Logger.log("  ⚠️  leerMateriasActivas_: error — " + e.message);
    return [];
  }
}


// ─────────────────────────────────────────────────────────────
// HELPERS PRIVADOS — PROCESAMIENTO DEL STAGING
// ─────────────────────────────────────────────────────────────

/**
 * Valida cada fila del staging y construye el plan de aperturas.
 * Retorna { plan: [...], errores: [...], estadosPorFila: [...] }
 * Toda la lógica es en memoria — cero llamadas a la API.
 *
 * VALIDACIONES:
 *   - Campos obligatorios presentes (cohort, moment, subject, program)
 *   - MomentCode válido (en MOMENTOS_DIR o MOMENTOS_ART)
 *   - ProgramCode válido (en TODOS_LOS_PROGRAMAS)
 *   - IsTransversal=TRUE solo si ProgramCode=TRV
 *   - Auto-corrección: ProgramCode=TRV con IsTransversal=FALSE → fuerza TRUE
 */
function construirPlanDesdeStaging_(datos) {
  const plan           = [];
  const errores        = [];
  const estadosPorFila = [];
  const momentosValidos = MOMENTOS_DIR.concat(MOMENTOS_ART);

  datos.forEach(function(fila, i) {
    const cohort  = String(fila[COL_COHORT  - 1] || "").trim();
    const moment  = String(fila[COL_MOMENT  - 1] || "").trim();
    const subject = String(fila[COL_SUBJECT - 1] || "").trim();
    const program = String(fila[COL_PROGRAM - 1] || "").trim();
    let   trv     = fila[COL_TRV - 1] === true || fila[COL_TRV - 1] === "TRUE";
    const notes   = String(fila[COL_NOTES  - 1] || "").trim();
    const estado  = String(fila[COL_ESTADO - 1] || "").trim();
    const numFila = i + FILA_DATOS;

    // Omitir filas vacías
    if (!cohort && !moment && !subject && !program) {
      estadosPorFila.push({ valida: false, estado: "" });
      return;
    }

    // Omitir filas ya procesadas
    if (estado.startsWith("Procesado")) {
      estadosPorFila.push({ valida: false, estado: estado });
      return;
    }

    // Validar campos obligatorios
    let err = null;
    if (!cohort)  err = "Fila " + numFila + ": CohortCode vacío";
    else if (!moment)  err = "Fila " + numFila + ": MomentCode vacío";
    else if (!subject) err = "Fila " + numFila + ": SubjectCode vacío";
    else if (!program) err = "Fila " + numFila + ": ProgramCode vacío";
    else if (TODOS_LOS_PROGRAMAS.indexOf(program) < 0) {
      err = "Fila " + numFila + ": ProgramCode inválido → '" + program + "'";
    }
    else if (momentosValidos.indexOf(moment) < 0) {
      err = "Fila " + numFila + ": MomentCode inválido → '" + moment + "'";
    }
    else if (trv && program !== "TRV") {
      err = "Fila " + numFila + ": IsTransversal=TRUE pero ProgramCode='" +
            program + "' (debe ser TRV)";
    }

    if (err) {
      errores.push(err);
      estadosPorFila.push({ valida: false, estado: "Error: " + err.split(": ")[1] });
      Logger.log("  ⛔ " + err);
      return;
    }

    // Auto-corrección: ProgramCode=TRV implica IsTransversal=TRUE
    // Si Carlos olvidó marcar el checkbox, el script lo fuerza silenciosamente.
    if (program === "TRV" && !trv) {
      trv = true;
      Logger.log("  ⚠️  Fila " + numFila + ": ProgramCode=TRV → IsTransversal auto-corregido a TRUE");
    }

    // Fila válida — agregar al plan
    plan.push({
      cohortCode:    cohort,
      momentCode:    moment,
      subjectCode:   subject,
      programCode:   program,
      isTransversal: trv,
      // FIX: usar Utilities.formatDate para obtener fecha en Bogotá (no UTC)
      notes: notes || ("Staging " + Utilities.formatDate(nowSIDEP(), SIDEP_CONFIG.timezone, "yyyy-MM-dd"))
    });
    estadosPorFila.push({ valida: true, estado: "Pendiente" });
    Logger.log("  ✓ Fila " + numFila + ": " +
               cohort + "/" + moment + "/" + subject + "/" + program +
               (trv ? " [TRV]" : ""));
  });

  Logger.log("  📊 Plan: " + plan.length + " válidas | " + errores.length + " errores");
  return { plan: plan, errores: errores, estadosPorFila: estadosPorFila };
}

/**
 * Escribe los estados en la columna G en una sola llamada a la API.
 * Patrón memory-first: construye el array en memoria, escribe en batch.
 */
function escribirEstadosBatch_(hoja, estadosPorFila, numFilas) {
  let valores = estadosPorFila.map(function(e) { return [e.estado]; });

  // Asegurar que el array tiene el mismo largo que las filas del staging
  while (valores.length < numFilas) valores.push([""]);
  valores = valores.slice(0, numFilas);

  hoja.getRange(FILA_DATOS, COL_ESTADO, numFilas, 1).setValues(valores);
}

/**
 * Obtiene el spreadsheet de staging por ID guardado en ScriptProperties.
 * Lanza error descriptivo si no está configurado o si el SS fue eliminado.
 */
function getStagingSS_() {
  const id = PropertiesService.getScriptProperties().getProperty(STAGING_PROP_KEY);
  if (!id) {
    throw new Error(
      "Staging SS no configurado. Ejecutar configurarStagingAperturas() primero."
    );
  }
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    throw new Error(
      "No se pudo abrir el staging SS (ID: " + id + ").\n" +
      "Puede haberse eliminado. Ejecutar configurarStagingAperturas() de nuevo."
    );
  }
}
