/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 21b_panelAcademico_setup.js
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Funciones privadas de creación de estructura del Panel Académico.
 *   Crea y formatea cada hoja del spreadsheet SIDEP_PANEL_ACADEMICO.
 *   Llamadas SOLO desde setupPanelAcademico() en 21_panelAcademico.js.
 *
 * FUNCIONES:
 *   _crearHojaInstrucciones_(ss)          → hoja INSTRUCCIONES
 *   _crearHojaIngresoNotas_(ss)           → hoja INGRESO_NOTAS
 *   _crearHojaResumen_(ss)                → hoja SEMAFORO_RESUMEN
 *   _crearHojaDetallePlaceholder_(ss, p)  → hoja DETALLE_{PROG}
 *   _crearHojaBoletin_(ss)                → hoja BOLETIN
 *   _crearHojaResumenPendientes_(ss)      → hoja PENDIENTES_POR_PROGRAMA
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.js  → SIDEP_CONFIG
 *   21_panelAcademico.js → PANEL_CONFIG (scope global GAS)
 *
 * VERSIÓN: 1.0.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-05-24
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// SECCIÓN 2: FUNCIONES PRIVADAS DE SETUP
// ─────────────────────────────────────────────────────────────

/**
 * Crea la hoja INSTRUCCIONES con documentación del flujo.
 */
function _crearHojaInstrucciones_(ss) {
  var hoja = ss.insertSheet("INSTRUCCIONES");
  hoja.setTabColor("#4a86e8");

  hoja.getRange("A1").setValue("SIDEP ECOSISTEMA DIGITAL — PANEL ACADÉMICO")
    .setFontSize(16).setFontWeight("bold").setFontColor("#1a3c5e");
  hoja.getRange("A2").setValue("Guía de uso del Panel de Ingreso y Seguimiento de Calificaciones");
  hoja.getRange("A1:F1").merge().setBackground("#e8f0fe");
  hoja.getRange("A2:F2").merge();

  var instrucciones = [
    ["", ""],
    ["PROPÓSITO DEL DOCUMENTO", ""],
    ["", "Este panel permite registrar notas manuales de estudiantes en asignaturas"],
    ["", "que cursaron antes de que existiera Google Classroom, y visualizar el"],
    ["", "estado académico de cada estudiante mediante el semáforo institucional."],
    ["", ""],
    ["FLUJO DE 5 PASOS", ""],
    ["Paso 1", "Ejecutar: Panel Académico → Generar plantilla de notas"],
    ["", "→ Se llena INGRESO_NOTAS con los estudiantes y asignaturas pendientes."],
    ["Paso 2", "Completar la columna NOTA (columna I, fondo verde) con las calificaciones."],
    ["", "→ Escala válida: 1.0 a 5.0. Dejar vacía si no aplica."],
    ["Paso 3", "Ejecutar: Panel Académico → Cargar notas a GradeHistory"],
    ["", "→ Las notas válidas se escriben en GradeHistory. Las filas cargadas quedan grises."],
    ["Paso 4", "Ejecutar: Panel Académico → Refrescar semáforo"],
    ["", "→ Se actualizan SEMAFORO_RESUMEN, DETALLE_* y el dropdown de BOLETIN."],
    ["Paso 5", "En BOLETIN: seleccionar estudiante en B3 y ejecutar Generar boletín."],
    ["", "→ Se imprime el historial académico completo del estudiante."],
    ["", ""],
    ["COLORES DEL SEMÁFORO", ""],
    ["Verde (#b7e1cd)",  "Nota ≥ 4.1 — Bueno o Excelente"],
    ["Amarillo (#fce8b2)", "Nota ≥ 3.0 y < 4.1 — Aceptable"],
    ["Rojo (#f4c7c3)",   "Nota < 3.0 — Insuficiente (genera deuda académica)"],
    ["Gris (#eeeeee)",   "Sin datos — materia pendiente o sin nota registrada"],
    ["", ""],
    ["NOTA IMPORTANTE", ""],
    ["", "⚠  Este documento es de uso EXCLUSIVO del equipo académico."],
    ["", "   NO compartir con estudiantes."],
    ["", "   Las notas cargadas son definitivas — coordininar con el director académico"],
    ["", "   antes de registrar cualquier modificación."]
  ];

  hoja.getRange(3, 1, instrucciones.length, 2).setValues(instrucciones);

  // Formato de secciones
  [4, 9, 19, 27].forEach(function(row) {
    hoja.getRange(row, 1, 1, 2)
      .setBackground(PANEL_CONFIG.COLOR.HEADER)
      .setFontColor("#ffffff")
      .setFontWeight("bold");
  });

  // Formato de colores del semáforo
  hoja.getRange(21, 1).setBackground(PANEL_CONFIG.COLOR.GREEN);
  hoja.getRange(22, 1).setBackground(PANEL_CONFIG.COLOR.YELLOW);
  hoja.getRange(23, 1).setBackground(PANEL_CONFIG.COLOR.RED);
  hoja.getRange(24, 1).setBackground(PANEL_CONFIG.COLOR.GREY);

  hoja.setColumnWidth(1, 200);
  hoja.setColumnWidth(2, 600);
  hoja.hideColumns(3, hoja.getMaxColumns() - 2);
}


/**
 * Crea la hoja INGRESO_NOTAS con headers y formatos iniciales.
 */
function _crearHojaIngresoNotas_(ss) {
  var hoja = ss.insertSheet("INGRESO_NOTAS");
  hoja.setTabColor("#34a853");

  var headers = [
    "StudentID", "Nombre Completo", "Cédula", "Programa", "Tipo",
    "Cohorte Entrada", "Código Materia", "Nombre Materia",
    "NOTA", "Ventana Aula", "Momento", "Observaciones",
    "Estado", "SemaforoColor", "Débito", "Cargado"
  ];

  hoja.getRange(1, 1, 1, headers.length).setValues([headers])
    .setBackground(PANEL_CONFIG.COLOR.HEADER)
    .setFontColor("#ffffff")
    .setFontWeight("bold");

  // Columna NOTA destacada
  hoja.getRange(1, 9).setBackground("#1e7e34").setFontColor("#ffffff");

  // Anchos de columna
  var anchos = [100, 200, 100, 80, 90, 100, 110, 220, 70, 100, 90, 200, 120, 110, 80, 80];
  anchos.forEach(function(ancho, i) {
    hoja.setColumnWidth(i + 1, ancho);
  });

  // Freeze fila 1 y columnas A-B
  hoja.setFrozenRows(1);
  hoja.setFrozenColumns(2);
}


/**
 * Crea la hoja SEMAFORO_RESUMEN con headers para el dashboard ejecutivo.
 */
function _crearHojaResumen_(ss) {
  var hoja = ss.insertSheet("SEMAFORO_RESUMEN");
  hoja.setTabColor("#4285f4");

  var headers = [
    "Nombre", "Cédula", "Programa", "Tipo (ART/DIR)",
    "Cohorte Entrada", "Ventana Actual", "Créditos",
    "% Avance", "Promedio Acum.", "Estado General"
  ];

  hoja.getRange(1, 1, 1, headers.length).setValues([headers])
    .setBackground(PANEL_CONFIG.COLOR.HEADER)
    .setFontColor("#ffffff")
    .setFontWeight("bold");

  var anchos = [220, 110, 80, 100, 120, 110, 80, 80, 110, 130];
  anchos.forEach(function(ancho, i) {
    hoja.setColumnWidth(i + 1, ancho);
  });

  hoja.setFrozenRows(1);
}


/**
 * Crea una hoja DETALLE_{PROG} placeholder con instrucciones iniciales.
 */
function _crearHojaDetallePlaceholder_(ss, programCode) {
  var hoja = ss.insertSheet("DETALLE_" + programCode);
  hoja.setTabColor("#ff6d00"); // naranja

  hoja.getRange("A1").setValue("DETALLE_" + programCode)
    .setFontSize(14).setFontWeight("bold").setFontColor("#1a3c5e");
  hoja.getRange("A2").setValue(
    "Ejecuta Panel Académico → Refrescar semáforo para poblar esta hoja."
  ).setFontStyle("italic").setFontColor("#666666");
}


/**
 * Crea la hoja BOLETIN con la estructura visual del informe.
 */
function _crearHojaBoletin_(ss) {
  var hoja = ss.insertSheet("BOLETIN");
  hoja.setTabColor("#9c27b0");

  // Fila 1: título institucional
  hoja.getRange("A1:F1").merge()
    .setValue("SIDEP ECOSISTEMA DIGITAL")
    .setFontSize(16).setFontWeight("bold").setFontColor("#ffffff")
    .setBackground(PANEL_CONFIG.COLOR.HEADER)
    .setHorizontalAlignment("center");

  // Fila 2: subtítulo
  hoja.getRange("A2:F2").merge()
    .setValue("BOLETÍN ACADÉMICO INDIVIDUAL")
    .setFontSize(13).setFontWeight("bold")
    .setBackground("#d0e4f7")
    .setHorizontalAlignment("center");

  // Fila 3: selector de estudiante
  hoja.getRange("A3").setValue("Estudiante:").setFontWeight("bold");
  hoja.getRange("B3").setBackground(PANEL_CONFIG.COLOR.EDITABLE)
    .setNote("Selecciona el estudiante del dropdown o escribe el nombre exacto.");

  // Anchos de columna
  hoja.setColumnWidth(1, 180);
  hoja.setColumnWidth(2, 250);
  hoja.setColumnWidth(3, 100);
  hoja.setColumnWidth(4, 120);
  hoja.setColumnWidth(5, 130);
  hoja.setColumnWidth(6, 130);

  // Freeze primeras 3 filas
  hoja.setFrozenRows(3);
}


/**
 * Crea la hoja PENDIENTES_POR_PROGRAMA con cabecera fija y dropdown
 * de filtro en B3 (Todos | DIRECTO | ARTICULADO).
 *
 * El contenido a partir de la fila 5 lo escribe _poblarHojaResumenPendientes_
 * cada vez que se ejecuta generarResumenPendientes() desde el menú.
 */
function _crearHojaResumenPendientes_(ss) {
  var hoja = ss.insertSheet(PANEL_CONFIG.HOJA_PENDIENTES);
  hoja.setTabColor("#ff9800");

  // Fila 1: título institucional
  hoja.getRange("A1:F1").merge()
    .setValue("RESUMEN GLOBAL DE ASIGNATURAS PENDIENTES POR PROGRAMA")
    .setFontSize(14).setFontWeight("bold").setFontColor("#ffffff")
    .setBackground(PANEL_CONFIG.COLOR.HEADER)
    .setHorizontalAlignment("center");

  // Fila 3: filtro por modalidad
  hoja.getRange("A3").setValue("Filtrar por modalidad:")
    .setFontWeight("bold").setBackground("#dae8fc").setFontColor("#1a3c5e");
  hoja.getRange("B3").setValue("Todos")
    .setBackground(PANEL_CONFIG.COLOR.EDITABLE).setFontWeight("bold");

  var regla = SpreadsheetApp.newDataValidation()
    .requireValueInList(["Todos", "DIRECTO", "ARTICULADO"], true)
    .setAllowInvalid(false)
    .build();
  hoja.getRange("B3").setDataValidation(regla);

  hoja.getRange("D3").setValue("→ Menú: Panel Académico → 📊 Generar resumen pendientes")
    .setFontStyle("italic").setFontColor("#666666");

  // Anchos de columna
  var anchos = [80, 280, 100, 130, 80, 180];
  anchos.forEach(function(ancho, i) { hoja.setColumnWidth(i + 1, ancho); });

  hoja.setFrozenRows(4);
}
