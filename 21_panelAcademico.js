/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 21_panelAcademico.js
 * Versión: 1.1.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   API pública del Panel Académico: PANEL_CONFIG + todas las
 *   funciones de menú y orquestación del spreadsheet
 *   SIDEP_PANEL_ACADEMICO. La lógica interna vive en los
 *   archivos hermanos 21b/21c/21d.
 *
 * ARCHIVOS HERMANOS:
 *   21b_panelAcademico_setup.js   → _crearHoja*_ (setup del spreadsheet)
 *   21c_panelAcademico_datos.js   → _cargarContextoPanel_,
 *                                    _poblarHoja*_ (dashboard + detalle)
 *   21d_panelAcademico_boletin.js → _escribirBoletin_,
 *                                    _getMejorNotaInfo_, _calcularCreditos_,
 *                                    _calcularPromedioPanel_, _colorSemaforo_,
 *                                    _buscarStudentIdPorNombre_,
 *                                    _getPanelSS_, _getCarpetaPanel_
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.js  → SIDEP_CONFIG, nowSIDEP(), uuid()
 *   02_SIDEP_HELPERS.js → getSpreadsheetByName(), _leerHoja_(), _escribirEnBatch_()
 *   20_semaforo.js      → _resolverCfg_(), _calcularSemaforo_(), _calcularNivel_()
 *
 * FLUJO DE USO:
 *   1. setupPanelAcademico()      → crear estructura del spreadsheet
 *   2. generarPlantillaNotas()    → llenar plantilla con estudiantes y asignaturas
 *   3. (usuario completa notas en col I)
 *   4. cargarNotasAGradeHistory() → escribir notas en GradeHistory
 *   5. refrescarSemaforo()        → actualizar dashboard y detalles
 *   6. generarBoletin()           → imprimir boletín individual
 *
 * VERSIÓN: 1.1.0  — refactor: fragmentado en 21b / 21c / 21d
 * AUTOR: Stevens Contreras
 * FECHA: 2026-05-24
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// CONSTANTES GLOBALES DEL PANEL
// ─────────────────────────────────────────────────────────────

const PANEL_CONFIG = {
  NOMBRE:           "SIDEP_PANEL_ACADEMICO",
  PROP_KEY:         "sidep_panelAcademicoId",
  PROGRAMAS:        ["CTB", "ADM", "SIS", "MKT", "SST"],
  HOJA_PENDIENTES:  "PENDIENTES_POR_PROGRAMA",
  COLOR: {
    GREEN:       "#b7e1cd",
    YELLOW:      "#fce8b2",
    RED:         "#f4c7c3",
    GREY:        "#eeeeee",
    HEADER:      "#1a3c5e",
    LOCKED:      "#f8f9fa",
    EDITABLE:    "#e6f4ea",
    TRV:         "#e8eaf6",
    IN_PROGRESS: "#cfe2f3"  // azul claro — notas en curso (Classroom)
  },
  COL_INGRESO: {
    STUDENT_ID:   1,
    NOMBRE:       2,
    CEDULA:       3,
    PROGRAMA:     4,
    TIPO:         5,
    COHORT:       6,
    SUBJECT_CODE: 7,
    SUBJECT_NAME: 8,
    NOTA:         9,
    WINDOW_COHORT:10,
    MOMENT_CODE:  11,
    OBSERVACIONES:12,
    ESTADO:       13,
    COLOR_SEM:    14,
    DEBITO:       15,
    CARGADO:      16
  }
};


// ─────────────────────────────────────────────────────────────
// SECCIÓN 1: FUNCIONES PÚBLICAS
// ─────────────────────────────────────────────────────────────

/**
 * Menú del spreadsheet SIDEP_PANEL_ACADEMICO.
 * Se dispara por un installable trigger onOpen instalado desde
 * setupPanelAcademico() vía instalarTriggerPanel_().
 *
 * MENÚ (en orden de ejecución del flujo académico):
 *
 *   — BOOTSTRAP —
 *   ├── 🧱 Recrear estructura del panel
 *
 *   — ENTRADA DE NOTAS —
 *   ├── 📝 Generar plantilla de notas
 *   ├── 💾 Cargar notas a GradeHistory
 *
 *   — CÁLCULO ACADÉMICO —
 *   ├── 🔄 Refrescar notas Classroom (on-demand)
 *   ├── 🚦 Refrescar semáforo (solo repinta)
 *
 *   — SALIDA —
 *   ├── 📄 Generar boletín
 *   └── 📊 Generar resumen pendientes
 *
 *   — CIERRE DE VENTANA (23_cierreVentana.js) —
 *   ├── 🔍 Preview cierre de ventana
 *   ├── 🔒 Ejecutar cierre de ventana
 *   └── 📦 Diagnóstico de archivado
 */
function onOpenPanel(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || ss.getName() !== PANEL_CONFIG.NOMBRE) return;

  SpreadsheetApp.getUi()
    .createMenu("Panel Académico")

    // — BOOTSTRAP —
    .addItem("🧱 Recrear estructura del panel",      "setupPanelAcademico")
    .addSeparator()

    // — ENTRADA DE NOTAS —
    .addItem("📝 Generar plantilla de notas",         "generarPlantillaNotas")
    .addItem("💾 Cargar notas a GradeHistory",        "cargarNotasAGradeHistory")
    .addSeparator()

    // — CÁLCULO ACADÉMICO —
    .addItem("🔄 Refrescar notas Classroom",          "refrescarNotasClassroom")
    .addItem("🚦 Refrescar semáforo (solo repintar)", "refrescarSemaforo")
    .addSeparator()

    // — SALIDA —
    .addItem("📄 Generar boletín",                   "generarBoletin")
    .addItem("📊 Generar resumen pendientes",         "generarResumenPendientes")
    .addSeparator()

    // — CIERRE DE VENTANA (23_cierreVentana.js) —
    // FLUJO: Preview → verificar gates → Ejecutar cierre
    // Preview muestra en Logger si las gates pasan sin modificar nada.
    // Ejecutar cierre archiva aulas, registra en CIERRE_LOG y (opcional) envía boletín.
    .addItem("🔍 Preview cierre de ventana",          "menuPreviewCierreVentana")
    .addItem("🔒 Ejecutar cierre de ventana",         "menuEjecutarCierreVentana")
    .addItem("📦 Diagnóstico de archivado",           "menuDiagnosticoArchivado")

    .addToUi();
}


/**
 * Wrapper de menú para diagnosticoArchivado() de 22_archivarAulas.js.
 * Pide cohortCode/momentCode y muestra el estado de archivado en Logger.
 */
function menuDiagnosticoArchivado() {
  var ui = SpreadsheetApp.getUi();

  var rCohort = ui.prompt(
    "Diagnóstico de Archivado",
    "Código de ventana (ej. MR26) — dejar vacío para todos:",
    ui.ButtonSet.OK_CANCEL
  );
  if (rCohort.getSelectedButton() !== ui.Button.OK) return;
  var cohortCode = rCohort.getResponseText().trim().toUpperCase() || null;

  var rMoment = ui.prompt(
    "Diagnóstico de Archivado",
    "Código de momento (ej. C1M2) — dejar vacío para todos:",
    ui.ButtonSet.OK_CANCEL
  );
  if (rMoment.getSelectedButton() !== ui.Button.OK) return;
  var momentCode = rMoment.getResponseText().trim() || null;

  ui.alert("Ejecutando diagnóstico — revise el Log de Ejecución (menú Ver → Registros).");

  diagnosticoArchivado({
    cohortCode: cohortCode,
    momentCode: momentCode
  });
}


// ── Instalación del trigger onOpen ────────────────────────────

/**
 * Instala (idempotente) el trigger onOpen sobre el spreadsheet del panel.
 * Se llama automáticamente desde setupPanelAcademico() al crear el panel.
 * Si ya existe un trigger onOpenPanel apuntando al mismo SS, no hace nada.
 */
function instalarTriggerPanel_(ss) {
  var targetId = ss.getId();
  var existe = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === "onOpenPanel" &&
           t.getTriggerSourceId && t.getTriggerSourceId() === targetId;
  });
  if (!existe) {
    ScriptApp.newTrigger("onOpenPanel")
      .forSpreadsheet(ss)
      .onOpen()
      .create();
    Logger.log("  ✔  Trigger onOpenPanel instalado");
  } else {
    Logger.log("  ⏭  Trigger onOpenPanel ya existe");
  }
}

/**
 * Elimina todos los triggers onOpenPanel del proyecto (para reinstalar limpio).
 * Úsalo antes de instalarTriggerPanel_ si sospechas duplicados.
 */
function limpiarTriggerPanel_() {
  var triggers  = ScriptApp.getProjectTriggers();
  var eliminados = 0;
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === "onOpenPanel") {
      ScriptApp.deleteTrigger(t);
      eliminados++;
    }
  });
  Logger.log("  ✔  Triggers onOpenPanel eliminados: " + eliminados);
}


/**
 * Crea el spreadsheet SIDEP_PANEL_ACADEMICO en la carpeta stagingAcademicoFolderName.
 * Si ya existe uno con ese nombre, lo mueve a papelera primero.
 * Crea todas las hojas necesarias y cachea el ID en ScriptProperties.
 */
function setupPanelAcademico() {
  var ahora = nowSIDEP();
  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — setupPanelAcademico v1.0.0");
  Logger.log("   Hora: " + Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "yyyy-MM-dd HH:mm:ss"));
  Logger.log("════════════════════════════════════════════════");

  try {
    var carpeta = _getCarpetaPanel_();
    Logger.log("   Carpeta destino: " + carpeta.getName());

    // Mover a papelera si ya existe
    var archivos = carpeta.getFilesByName(PANEL_CONFIG.NOMBRE);
    while (archivos.hasNext()) {
      var archivo = archivos.next();
      archivo.setTrashed(true);
      Logger.log("   Panel anterior movido a papelera: " + archivo.getId());
    }

    // Crear nuevo spreadsheet
    var ss = SpreadsheetApp.create(PANEL_CONFIG.NOMBRE);
    var fileId = ss.getId();

    // Mover a la carpeta correcta
    var fileObj = DriveApp.getFileById(fileId);
    carpeta.addFile(fileObj);
    DriveApp.getRootFolder().removeFile(fileObj);

    Logger.log("   Spreadsheet creado: " + fileId);

    // Cachear ID en ScriptProperties
    PropertiesService.getScriptProperties().setProperty(PANEL_CONFIG.PROP_KEY, fileId);

    // Crear hojas
    _crearHojaInstrucciones_(ss);
    _crearHojaIngresoNotas_(ss);
    _crearHojaResumen_(ss);
    PANEL_CONFIG.PROGRAMAS.forEach(function(prog) {
      _crearHojaDetallePlaceholder_(ss, prog);
    });
    _crearHojaBoletin_(ss);
    _crearHojaResumenPendientes_(ss);

    // Eliminar hoja por defecto si existe
    ["Sheet1", "Hoja 1", "Hoja1"].forEach(function(nombre) {
      var hoja = ss.getSheetByName(nombre);
      if (hoja) {
        try { ss.deleteSheet(hoja); } catch (_) {}
      }
    });

    // Instalar trigger onOpen para que el menú "Panel Académico"
    // aparezca automáticamente al abrir el spreadsheet.
    instalarTriggerPanel_(ss);

    Logger.log("════════════════════════════════════════════════");
    Logger.log("   Panel creado exitosamente.");
    Logger.log("   URL: " + ss.getUrl());
    Logger.log("   Menú: abrir el spreadsheet → aparecerá 'Panel Académico'.");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("ERROR en setupPanelAcademico: " + e.message);
    throw e;
  }
}


/**
 * Genera la plantilla de ingreso de notas en la hoja INGRESO_NOTAS.
 *
 * - Lee Students (activos), _CFG_SUBJECTS, GradeHistory
 * - Por cada estudiante activo: una fila por asignatura de su programa + TRV
 * - Omite pares que ya tienen entrada en GradeHistory
 * - Columnas A-H bloqueadas (fondo gris visual)
 * - Columna I (NOTA) editable (fondo verde claro)
 * - Fórmulas en M (Estado), N (SemaforoColor), O (Débito)
 * - Formato condicional en columna I
 */
function generarPlantillaNotas() {
  var ahora = nowSIDEP();
  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — generarPlantillaNotas");
  Logger.log("════════════════════════════════════════════════");

  try {
    var panelSS = _getPanelSS_();
    var hoja    = panelSS.getSheetByName("INGRESO_NOTAS");
    if (!hoja) throw new Error("Hoja INGRESO_NOTAS no encontrada. Ejecuta setupPanelAcademico() primero.");

    var ctx = _cargarContextoPanel_();
    var filas = [];

    // Iterar por todos los estudiantes activos
    var stIdx = ctx.studentsIdx;
    Object.keys(ctx.students).forEach(function(studentId) {
      var student     = ctx.students[studentId];
      var programCode = String(student[stIdx["ProgramCode"]]     || "").trim();
      var studentStatus = String(student[stIdx["StudentStatusCode"]] || "").trim();

      // Solo estudiantes activos
      if (studentStatus !== "ACTIVE") return;

      var firstName = String(student[stIdx["FirstName"]] || "").trim();
      var lastName  = String(student[stIdx["LastName"]]  || "").trim();
      var nombre    = (firstName + " " + lastName).trim();
      var cedula    = String(student[stIdx["DocumentNumber"]] || "").trim();
      var tipo      = String(student[stIdx["StudentType"]]    || "").trim();
      var cohort    = String(student[stIdx["CohortCode"]]     || "").trim();

      // Determinar ventana actual del estudiante
      var windowCohort = ctx.currentWindow[studentId] || "";

      // Asignaturas del programa + TRV
      var asignaturas = (ctx.subjectsByProgram[programCode] || []).concat(ctx.trvSubjects);

      asignaturas.forEach(function(subjectRow) {
        var subjectCode = String(subjectRow[ctx.subjectsIdx["SubjectCode"]] || "").trim();
        var subjectName = String(subjectRow[ctx.subjectsIdx["SubjectName"]] || "").trim();
        var momentCode  = String(subjectRow[ctx.subjectsIdx["DirStartMoment"]] || "").trim();

        // Determinar momentCode correcto según tipo de estudiante
        if (tipo === "ARTICULADO") {
          momentCode = String(subjectRow[ctx.subjectsIdx["ArtStartBlock"]] || "").trim();
        }

        // Omitir si ya existe en GradeHistory
        var ghKey = studentId + "|" + subjectCode;
        if (ctx.gradeHistoryKeys[ghKey]) return;

        filas.push([
          studentId,     // A: StudentID
          nombre,        // B: Nombre
          cedula,        // C: Cédula
          programCode,   // D: Programa
          tipo,          // E: Tipo
          cohort,        // F: Cohort
          subjectCode,   // G: SubjectCode
          subjectName,   // H: SubjectName
          "",            // I: Nota (editable)
          windowCohort,  // J: WindowCohort
          momentCode,    // K: MomentCode
          "",            // L: Observaciones
          "",            // M: Estado (fórmula)
          "",            // N: SemaforoColor (fórmula)
          "",            // O: Débito (fórmula)
          false          // P: Cargado
        ]);
      });
    });

    if (filas.length === 0) {
      Logger.log("   No hay filas nuevas para generar (todas tienen GradeHistory o sin activos).");
      return;
    }

    // Limpiar datos anteriores (mantener header)
    var lastRow = hoja.getLastRow();
    if (lastRow > 1) {
      hoja.getRange(2, 1, lastRow - 1, 16).clearContent();
      hoja.getRange(2, 1, lastRow - 1, 16).clearFormat();
    }

    // Escribir filas de datos
    var dataRange = hoja.getRange(2, 1, filas.length, 16);
    dataRange.setValues(filas);

    // Fondo gris en columnas A-H (bloqueadas visual)
    hoja.getRange(2, 1, filas.length, 8).setBackground(PANEL_CONFIG.COLOR.LOCKED);

    // Fondo verde claro en columna I (editable)
    hoja.getRange(2, 9, filas.length, 1).setBackground(PANEL_CONFIG.COLOR.EDITABLE);

    // Fondo gris en columnas J-P (bloqueadas visual)
    hoja.getRange(2, 10, filas.length, 7).setBackground(PANEL_CONFIG.COLOR.LOCKED);

    // Fórmulas en columna M (Estado) — usando umbral 4.5/4.0/3.0
    for (var i = 0; i < filas.length; i++) {
      var fila = i + 2;
      hoja.getRange(fila, 13).setFormula(
        '=IF(I' + fila + '="","",IF(I' + fila + '>=4.5,"EXCELENTE",IF(I' + fila + '>=4,"BUENO",IF(I' + fila + '>=3,"ACEPTABLE","INSUFICIENTE"))))'
      );
      hoja.getRange(fila, 14).setFormula(
        '=IF(I' + fila + '="","GREY",IF(I' + fila + '>=4.1,"GREEN",IF(I' + fila + '>=3,"YELLOW","RED")))'
      );
      hoja.getRange(fila, 15).setFormula(
        '=IF(AND(ISNUMBER(I' + fila + '),I' + fila + '<3),"SI","")'
      );
    }

    // Formato condicional en columna I (fondo según nota)
    var reglas = hoja.getConditionalFormatRules();
    var notaRange = hoja.getRange(2, 9, filas.length, 1);

    var reglaGreen = SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThanOrEqualTo(4.1)
      .setBackground(PANEL_CONFIG.COLOR.GREEN)
      .setRanges([notaRange])
      .build();

    var reglaYellow = SpreadsheetApp.newConditionalFormatRule()
      .whenNumberBetween(3.0, 4.099)
      .setBackground(PANEL_CONFIG.COLOR.YELLOW)
      .setRanges([notaRange])
      .build();

    var reglaRed = SpreadsheetApp.newConditionalFormatRule()
      .whenNumberBetween(1.0, 2.999)
      .setBackground(PANEL_CONFIG.COLOR.RED)
      .setRanges([notaRange])
      .build();

    reglas.push(reglaGreen, reglaYellow, reglaRed);
    hoja.setConditionalFormatRules(reglas);

    SpreadsheetApp.flush();

    Logger.log("   Plantilla generada: " + filas.length + " filas.");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("ERROR en generarPlantillaNotas: " + e.message);
    throw e;
  }
}


/**
 * Lee INGRESO_NOTAS y carga las notas válidas a GradeHistory.
 *
 * Para cada fila con Nota numérica válida (1.0-5.0) y Cargado≠TRUE:
 *   - Escribe en GradeHistory (Fuente=MANUAL)
 *   - Crea AcademicDebt si nota < 3.0 (DebtStatusCode=DEBT_PENDING)
 *   - Marca columna P=TRUE
 *   - Pinta la fila en gris
 */
function cargarNotasAGradeHistory() {
  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — cargarNotasAGradeHistory");
  Logger.log("   Ejecutor: " + ejecutor);
  Logger.log("════════════════════════════════════════════════");

  try {
    var panelSS  = _getPanelSS_();
    var hojaIngr = panelSS.getSheetByName("INGRESO_NOTAS");
    if (!hojaIngr) throw new Error("Hoja INGRESO_NOTAS no encontrada.");

    var lastRow = hojaIngr.getLastRow();
    if (lastRow <= 1) {
      Logger.log("   INGRESO_NOTAS vacía — nada que cargar.");
      return;
    }

    var datos = hojaIngr.getRange(2, 1, lastRow - 1, 16).getValues();

    var adminSS   = getSpreadsheetByName("admin");
    var ghHoja    = adminSS.getSheetByName("GradeHistory");
    var debtHoja  = adminSS.getSheetByName("AcademicDebts");
    var ghMem     = _leerHoja_(ghHoja);
    var debtMem   = _leerHoja_(debtHoja);

    var cfg = _resolverCfg_(_leerHoja_(getSpreadsheetByName("core").getSheetByName("_CFG_SEMAFORO")));

    var cargadas = 0, debitos = 0, omitidas = 0, errores = 0;
    var filasParaGray = [];

    datos.forEach(function(fila, idx) {
      var C = PANEL_CONFIG.COL_INGRESO;
      var studentId   = String(fila[C.STUDENT_ID   - 1] || "").trim();
      var subjectCode = String(fila[C.SUBJECT_CODE - 1] || "").trim();
      var subjectName = String(fila[C.SUBJECT_NAME - 1] || "").trim();
      var programCode = String(fila[C.PROGRAMA     - 1] || "").trim();
      var cohort      = String(fila[C.COHORT       - 1] || "").trim();
      var windowCohort= String(fila[C.WINDOW_COHORT- 1] || "").trim();
      var momentCode  = String(fila[C.MOMENT_CODE  - 1] || "").trim();
      var notaRaw     = fila[C.NOTA - 1];
      var cargado     = fila[C.CARGADO - 1];

      // Omitir ya cargadas
      if (cargado === true || String(cargado).toUpperCase() === "TRUE") {
        omitidas++;
        return;
      }

      // Validar nota
      var nota = Number(notaRaw);
      if (isNaN(nota) || nota < 1.0 || nota > 5.0) {
        if (notaRaw !== "" && notaRaw !== null) errores++;
        return;
      }

      if (!studentId || !subjectCode) {
        errores++;
        return;
      }

      // Calcular nivel y estado
      var nivel  = _calcularNivel_(nota, cfg);
      var estado = nota >= (cfg.UMBRAL_APROBACION || 3.0) ? "APROBADO" : "REPROBADO";

      // Agregar a GradeHistory
      var ghRow = new Array(ghMem.encabezado.length).fill("");
      var gIdx  = ghMem.idx;
      if (gIdx["GradeHistoryID"]   !== undefined) ghRow[gIdx["GradeHistoryID"]]   = uuid("ghi");
      if (gIdx["StudentID"]        !== undefined) ghRow[gIdx["StudentID"]]        = studentId;
      if (gIdx["SubjectCode"]      !== undefined) ghRow[gIdx["SubjectCode"]]      = subjectCode;
      if (gIdx["SubjectName"]      !== undefined) ghRow[gIdx["SubjectName"]]      = subjectName;
      if (gIdx["ProgramCode"]      !== undefined) ghRow[gIdx["ProgramCode"]]      = programCode;
      if (gIdx["EntryCohortCode"]  !== undefined) ghRow[gIdx["EntryCohortCode"]]  = cohort;
      if (gIdx["WindowCohortCode"] !== undefined) ghRow[gIdx["WindowCohortCode"]] = windowCohort || cohort;
      if (gIdx["MomentCode"]       !== undefined) ghRow[gIdx["MomentCode"]]       = momentCode;
      if (gIdx["Nota"]             !== undefined) ghRow[gIdx["Nota"]]             = nota;
      if (gIdx["Nivel"]            !== undefined) ghRow[gIdx["Nivel"]]            = nivel;
      if (gIdx["Estado"]           !== undefined) ghRow[gIdx["Estado"]]           = estado;
      if (gIdx["Fuente"]           !== undefined) ghRow[gIdx["Fuente"]]           = "MANUAL";
      if (gIdx["CreatedAt"]        !== undefined) ghRow[gIdx["CreatedAt"]]        = ahora;
      if (gIdx["CreatedBy"]        !== undefined) ghRow[gIdx["CreatedBy"]]        = ejecutor;

      ghMem.datos.push(ghRow);
      cargadas++;

      // Crear deuda académica si reprobó
      if (nota < (cfg.UMBRAL_APROBACION || 3.0)) {
        var dIdx   = debtMem.idx;
        var debtRow = new Array(debtMem.encabezado.length).fill("");
        if (dIdx["DebtID"]             !== undefined) debtRow[dIdx["DebtID"]]             = uuid("dbt");
        if (dIdx["StudentID"]          !== undefined) debtRow[dIdx["StudentID"]]          = studentId;
        if (dIdx["SubjectCode"]        !== undefined) debtRow[dIdx["SubjectCode"]]        = subjectCode;
        if (dIdx["OriginalMoment"]     !== undefined) debtRow[dIdx["OriginalMoment"]]     = momentCode;
        if (dIdx["OriginalDeploymentID"]!== undefined) debtRow[dIdx["OriginalDeploymentID"]] = "";
        if (dIdx["RetryDeploymentID"]  !== undefined) debtRow[dIdx["RetryDeploymentID"]]  = "";
        if (dIdx["DebtStatusCode"]     !== undefined) debtRow[dIdx["DebtStatusCode"]]     = "DEBT_PENDING";
        if (dIdx["CreatedAt"]          !== undefined) debtRow[dIdx["CreatedAt"]]          = ahora;
        if (dIdx["CreatedBy"]          !== undefined) debtRow[dIdx["CreatedBy"]]          = ejecutor;
        debtMem.datos.push(debtRow);
        debitos++;
      }

      filasParaGray.push(idx + 2); // fila en la hoja (1-indexed + header)
    });

    // Escribir en batch
    if (cargadas > 0) {
      _escribirEnBatch_(ghHoja, ghMem);
      if (debitos > 0) _escribirEnBatch_(debtHoja, debtMem);

      // Marcar columna P=TRUE y pintar gris
      filasParaGray.forEach(function(rowNum) {
        hojaIngr.getRange(rowNum, 16).setValue(true);
        hojaIngr.getRange(rowNum, 1, 1, 16).setBackground(PANEL_CONFIG.COLOR.GREY);
      });

      SpreadsheetApp.flush();
    }

    Logger.log("════════════════════════════════════════════════");
    Logger.log("   Cargadas : " + cargadas);
    Logger.log("   Débitos  : " + debitos);
    Logger.log("   Omitidas : " + omitidas);
    Logger.log("   Errores  : " + errores);
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("ERROR en cargarNotasAGradeHistory: " + e.message);
    throw e;
  }
}


/**
 * Refresca el semáforo del panel:
 * - Pobla SEMAFORO_RESUMEN con resumen por estudiante
 * - Pobla cada DETALLE_{PROG} con la vista matricial
 * - Actualiza el dropdown del boletín
 */
function refrescarSemaforo() {
  var ahora = nowSIDEP();
  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — refrescarSemaforo (Panel)");
  Logger.log("   Hora: " + Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "yyyy-MM-dd HH:mm:ss"));
  Logger.log("════════════════════════════════════════════════");

  try {
    var ctx     = _cargarContextoPanel_();
    var panelSS = _getPanelSS_();

    _poblarHojaResumen_(panelSS, ctx, ahora);

    PANEL_CONFIG.PROGRAMAS.forEach(function(prog) {
      _poblarHojaDetalle_(panelSS, prog, ctx);
    });

    _actualizarListaBoletin_(panelSS, ctx);

    Logger.log("   Semáforo del panel actualizado.");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("ERROR en refrescarSemaforo: " + e.message);
    throw e;
  }
}


/**
 * Orquestador on-demand: trae notas en curso desde Classroom y repinta el panel.
 *
 * PASO 1 — ejecutarSemaforo() (de 20_semaforo.js):
 *   • Itera Enrollments ACTIVE × MasterDeployments con StatusCode=CREATED.
 *   • Por cada par, llama Classroom API (CourseWork + StudentSubmissions).
 *   • Aplica políticas D2 (solo assignedGrade RETURNED) + B2 (vencidas sin
 *     nota cuentan como 0) + escala 1-5 nativa (DEC-2026-015).
 *   • Sobrescribe BI/GradeAudit con Fuente=CLASSROOM.
 *   • NO toca GradeHistory ni AcademicDebts (esas son decisiones definitivas).
 *
 * PASO 2 — refrescarSemaforo() (este archivo):
 *   • Repinta SEMAFORO_RESUMEN, DETALLE_*, BOLETIN dropdown.
 *   • Las notas definitivas (GradeHistory) tienen prioridad sobre las en curso.
 *   • Las notas en curso se marcan visualmente con color azul claro (#cfe2f3).
 *
 * Esta función NO instala triggers — es 100% on-demand desde el menú del panel.
 */
function refrescarNotasClassroom() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — refrescarNotasClassroom (orquestador)");
  Logger.log("   PASO 1/2: ejecutarSemaforo() → pull desde Classroom");
  Logger.log("════════════════════════════════════════════════");

  try {
    ejecutarSemaforo();

    Logger.log("════════════════════════════════════════════════");
    Logger.log("   PASO 2/2: refrescarSemaforo() → repintar panel");
    Logger.log("════════════════════════════════════════════════");

    refrescarSemaforo();

    Logger.log("════════════════════════════════════════════════");
    Logger.log("   refrescarNotasClassroom — COMPLETADO");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("ERROR en refrescarNotasClassroom: " + e.message);
    throw e;
  }
}


/**
 * Genera el boletín individual del estudiante seleccionado en B3 de BOLETIN.
 */
function generarBoletin() {
  var ahora = nowSIDEP();
  Logger.log("SIDEP — generarBoletin");

  try {
    var panelSS = _getPanelSS_();
    var hoja    = panelSS.getSheetByName("BOLETIN");
    if (!hoja) throw new Error("Hoja BOLETIN no encontrada.");

    var nombre     = String(hoja.getRange("B3").getValue() || "").trim();
    if (!nombre) {
      Logger.log("   Celda B3 vacía — selecciona un estudiante en el dropdown.");
      return;
    }

    var ctx       = _cargarContextoPanel_();
    var studentId = _buscarStudentIdPorNombre_(nombre, ctx);

    if (!studentId) {
      Logger.log("   Estudiante no encontrado: " + nombre);
      return;
    }

    _escribirBoletin_(hoja, studentId, ctx, ahora);
    Logger.log("   Boletín generado para: " + nombre);

  } catch (e) {
    Logger.log("ERROR en generarBoletin: " + e.message);
    throw e;
  }
}


/**
 * Genera el resumen global de asignaturas pendientes por programa.
 *
 * Lee la celda B3 de la hoja PENDIENTES_POR_PROGRAMA (dropdown con
 * "Todos" | "DIRECTO" | "ARTICULADO") y reconstruye la tabla agregada.
 *
 * Para cada (programa, asignatura) cuenta:
 *   • Aprobados   = Estudiantes con GradeHistory.Estado=APROBADO
 *   • Con débito  = Estudiantes con AcademicDebts.DebtStatusCode=DEBT_PENDING
 *   • Pendientes  = N − Aprobados − ConDébito
 *   • Total       = Pendientes + ConDébito (los que aún deben aprobarla)
 *
 * Las asignaturas con Total = 0 se ocultan (Opción A — foco en lo accionable).
 * Las TRV se agrupan al final, aplican a todos los estudiantes del filtro.
 */
function generarResumenPendientes() {
  var ahora = nowSIDEP();
  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — generarResumenPendientes");
  Logger.log("════════════════════════════════════════════════");

  try {
    var panelSS = _getPanelSS_();
    var hoja    = panelSS.getSheetByName(PANEL_CONFIG.HOJA_PENDIENTES);
    if (!hoja) throw new Error(
      "Hoja " + PANEL_CONFIG.HOJA_PENDIENTES + " no encontrada. " +
      "Ejecuta setupPanelAcademico() primero."
    );

    // Leer filtro de B3 (default = "Todos" si está vacío)
    var filtro = String(hoja.getRange("B3").getValue() || "").trim();
    if (!filtro) filtro = "Todos";
    Logger.log("   Filtro modalidad: " + filtro);

    var ctx = _cargarContextoPanel_();
    _poblarHojaResumenPendientes_(panelSS, hoja, ctx, filtro, ahora);

    Logger.log("   Resumen generado.");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("ERROR en generarResumenPendientes: " + e.message);
    throw e;
  }
}

// Secciones 2-6 movidas a: 21b_panelAcademico_setup.js,
//                           21c_panelAcademico_datos.js,
//                           21d_panelAcademico_boletin.js
