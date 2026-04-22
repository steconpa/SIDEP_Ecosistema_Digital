/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 21_panelAcademico.js
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Panel académico interactivo para seguimiento de calificaciones.
 *   Genera y mantiene el spreadsheet SIDEP_PANEL_ACADEMICO:
 *     - INGRESO_NOTAS: plantilla editable para registro manual de notas
 *     - SEMAFORO_RESUMEN: dashboard ejecutivo por estudiante
 *     - DETALLE_{PROG}: vista matricial por programa
 *     - BOLETIN: informe individual por estudiante
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
 * VERSIÓN: 1.0.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-04-16
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// CONSTANTES GLOBALES DEL PANEL
// ─────────────────────────────────────────────────────────────

const PANEL_CONFIG = {
  NOMBRE:    "SIDEP_PANEL_ACADEMICO",
  PROP_KEY:  "sidep_panelAcademicoId",
  PROGRAMAS: ["CTB", "ADM", "SIS", "MKT", "SST"],
  COLOR: {
    GREEN:    "#b7e1cd",
    YELLOW:   "#fce8b2",
    RED:      "#f4c7c3",
    GREY:     "#eeeeee",
    HEADER:   "#1a3c5e",
    LOCKED:   "#f8f9fa",
    EDITABLE: "#e6f4ea",
    TRV:      "#e8eaf6"
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
 *   ├── 🚦 Refrescar semáforo
 *
 *   — SALIDA —
 *   └── 📄 Generar boletín
 */
function onOpenPanel(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || ss.getName() !== PANEL_CONFIG.NOMBRE) return;

  SpreadsheetApp.getUi()
    .createMenu("Panel Académico")

    // — BOOTSTRAP —
    .addItem("🧱 Recrear estructura del panel",  "setupPanelAcademico")
    .addSeparator()

    // — ENTRADA DE NOTAS —
    .addItem("📝 Generar plantilla de notas",    "generarPlantillaNotas")
    .addItem("💾 Cargar notas a GradeHistory",   "cargarNotasAGradeHistory")
    .addSeparator()

    // — CÁLCULO ACADÉMICO —
    .addItem("🚦 Refrescar semáforo",            "refrescarSemaforo")
    .addSeparator()

    // — CONSULTAS —
    .addItem("📅 Generar horario semanal",        "generarHorarioSemanal")
    .addSeparator()

    // — SALIDA —
    .addItem("📄 Generar boletín",               "generarBoletin")

    .addToUi();
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
    _crearHojaHorario_(ss);

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
 * Genera la hoja HORARIO_SEMANAL con todas las clases activas
 * ordenadas por día de la semana y hora de inicio.
 *
 * Fuentes: TeacherAssignments (adminSS) + MasterDeployments + Teachers +
 *          _CFG_SUBJECTS (todos en coreSS).
 * Filtros: IsActive=true en TeacherAssignment y ScriptStatusCode=CREATED en MasterDeployments.
 */
function generarHorarioSemanal() {
  var ahora = nowSIDEP();
  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — generarHorarioSemanal");
  Logger.log("════════════════════════════════════════════════");

  try {
    var panelSS = _getPanelSS_();
    var coreSS  = getSpreadsheetByName("core");
    var adminSS = getSpreadsheetByName("admin");

    // ── Leer tablas en memoria ────────────────────────────────
    var memTch  = _leerHoja_(coreSS.getSheetByName("Teachers"));
    var memAsig = _leerHoja_(adminSS.getSheetByName("TeacherAssignments"));
    var memDepl = _leerHoja_(coreSS.getSheetByName("MasterDeployments"));
    var memSubj = _leerHoja_(coreSS.getSheetByName("_CFG_SUBJECTS"));

    var tIdx = memTch.idx;
    var aIdx = memAsig.idx;
    var dIdx = memDepl.idx;
    var sIdx = memSubj.idx;

    // ── Índice de docentes: teacherId → nombre completo ────────
    var teacherMap = {};
    memTch.datos.forEach(function(row) {
      var id = String(row[tIdx["TeacherID"]] || "").trim();
      if (!id) return;
      var first = String(row[tIdx["FirstName"]] || "").trim();
      var last  = String(row[tIdx["LastName"]]  || "").trim();
      teacherMap[id] = (first + " " + last).trim();
    });

    // ── Índice de deployments: deploymentId → metadata ────────
    var deplMap = {};
    memDepl.datos.forEach(function(row) {
      var id = String(row[dIdx["DeploymentID"]] || "").trim();
      if (!id) return;
      deplMap[id] = {
        subjectCode: String(row[dIdx["SubjectCode"]]      || "").trim(),
        programCode: String(row[dIdx["ProgramCode"]]      || "").trim(),
        cohortCode:  String(row[dIdx["CohortCode"]]       || "").trim(),
        momentCode:  String(row[dIdx["MomentCode"]]       || "").trim(),
        classroomURL:String(row[dIdx["ClassroomURL"]]     || "").trim(),
        status:      String(row[dIdx["ScriptStatusCode"]] || "").trim()
      };
    });

    // ── Índice de asignaturas: subjectCode → nombre ────────────
    var subjectMap = {};
    memSubj.datos.forEach(function(row) {
      var code = String(row[sIdx["SubjectCode"]] || "").trim();
      var name = String(row[sIdx["SubjectName"]] || "").trim();
      if (code) subjectMap[code] = name;
    });

    // ── Orden canónico de días ────────────────────────────────
    var DAY_ORDER = {
      LUNES: 1, MARTES: 2, MIERCOLES: 3, MIÉRCOLES: 3,
      JUEVES: 4, VIERNES: 5, SABADO: 6, SÁBADO: 6
    };

    // ── Construir filas del horario ───────────────────────────
    var filas = [];
    memAsig.datos.forEach(function(row) {
      var activo = row[aIdx["IsActive"]];
      if (activo !== true && String(activo).toUpperCase() !== "TRUE") return;

      var teacherId = String(row[aIdx["TeacherID"]]    || "").trim();
      var deployId  = String(row[aIdx["DeploymentID"]] || "").trim();
      var dayOfWeek = String(row[aIdx["DayOfWeek"]]    || "").trim().toUpperCase();
      var startTime = _formatearTiempoPanel_(row[aIdx["StartTime"]]);
      var endTime   = _formatearTiempoPanel_(row[aIdx["EndTime"]]);

      if (!deployId || !dayOfWeek) return;

      var depl = deplMap[deployId];
      if (!depl || depl.status !== "CREATED") return;

      var subjectName = subjectMap[depl.subjectCode] || depl.subjectCode;
      var docente     = teacherMap[teacherId] || "";

      filas.push({
        dayOrder:    DAY_ORDER[dayOfWeek] || 99,
        dayOfWeek:   dayOfWeek,
        startTime:   startTime,
        endTime:     endTime,
        subjectName: subjectName,
        subjectCode: depl.subjectCode,
        programCode: depl.programCode,
        cohortCode:  depl.cohortCode,
        momentCode:  depl.momentCode,
        classroomURL:depl.classroomURL,
        docente:     docente
      });
    });

    // Ordenar por día y hora de inicio
    filas.sort(function(a, b) {
      if (a.dayOrder !== b.dayOrder) return a.dayOrder - b.dayOrder;
      return a.startTime.localeCompare(b.startTime);
    });

    _poblarHojaHorario_(panelSS, filas, ahora);

    Logger.log("   Clases activas encontradas: " + filas.length);
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("ERROR en generarHorarioSemanal: " + e.message);
    throw e;
  }
}


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
 * Crea la hoja HORARIO_SEMANAL con headers y formato inicial.
 */
function _crearHojaHorario_(ss) {
  var hoja = ss.insertSheet("HORARIO_SEMANAL");
  hoja.setTabColor("#0097a7"); // cian

  var headers = [
    "Día", "Inicio", "Fin", "Asignatura", "Cód.",
    "Programa", "Cohorte", "Momento", "Docente", "Aula Virtual"
  ];

  hoja.getRange(1, 1, 1, headers.length).setValues([headers])
    .setBackground(PANEL_CONFIG.COLOR.HEADER)
    .setFontColor("#ffffff")
    .setFontWeight("bold");

  var anchos = [90, 70, 70, 240, 70, 90, 90, 90, 200, 120];
  anchos.forEach(function(ancho, i) {
    hoja.setColumnWidth(i + 1, ancho);
  });

  hoja.setFrozenRows(1);
  hoja.setFrozenColumns(2);
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


// ─────────────────────────────────────────────────────────────
// SECCIÓN 3: CARGA DE CONTEXTO
// ─────────────────────────────────────────────────────────────

/**
 * Carga en memoria todo lo necesario para el panel académico.
 * Abre cada spreadsheet una sola vez.
 *
 * @returns {object} ctx — contexto completo del panel
 */
function _cargarContextoPanel_() {
  var coreSS  = getSpreadsheetByName("core");
  var adminSS = getSpreadsheetByName("admin");
  var biSS    = getSpreadsheetByName("bi");

  // ── CORE: subjects ────────────────────────────────────────────
  var subjectsMem = _leerHoja_(coreSS.getSheetByName("_CFG_SUBJECTS"));
  var subjectsIdx = subjectsMem.idx;

  var subjects         = {};
  var subjectsByProgram= {};
  var trvSubjects      = [];

  subjectsMem.datos.forEach(function(row) {
    var code    = String(row[subjectsIdx["SubjectCode"]] || "").trim();
    var prog    = String(row[subjectsIdx["ProgramCode"]] || "").trim();
    var activo  = row[subjectsIdx["IsActive"]];
    var isActive= (activo === true || String(activo).toUpperCase() === "TRUE");

    if (!code || !isActive) return;

    subjects[code] = row;

    if (prog === "TRV") {
      trvSubjects.push(row);
    } else {
      if (!subjectsByProgram[prog]) subjectsByProgram[prog] = [];
      subjectsByProgram[prog].push(row);
    }
  });

  // Ordenar asignaturas por momento curricular
  var iDirStart = subjectsIdx["DirStartMoment"];
  var iArtStart = subjectsIdx["ArtStartBlock"];

  function sortSubjects(arr) {
    return arr.sort(function(a, b) {
      var kA = _momentSortKey_(String(a[iDirStart] || "")) || _momentSortKey_(String(a[iArtStart] || ""));
      var kB = _momentSortKey_(String(b[iDirStart] || "")) || _momentSortKey_(String(b[iArtStart] || ""));
      return kA - kB;
    });
  }

  Object.keys(subjectsByProgram).forEach(function(prog) {
    subjectsByProgram[prog] = sortSubjects(subjectsByProgram[prog]);
  });
  trvSubjects = sortSubjects(trvSubjects);

  // ── CORE: programas ───────────────────────────────────────────
  var programsMem = _leerHoja_(coreSS.getSheetByName("_CFG_PROGRAMS"));
  var programsIdx = programsMem.idx;
  var programs    = {};
  programsMem.datos.forEach(function(row) {
    var code = String(row[programsIdx["ProgramCode"]] || "").trim();
    if (code) programs[code] = row;
  });

  // ── CORE: cohortes ────────────────────────────────────────────
  var cohortsMem = _leerHoja_(coreSS.getSheetByName("_CFG_COHORTS"));
  var cohortsIdx = cohortsMem.idx;
  var cohorts    = {};
  cohortsMem.datos.forEach(function(row) {
    var code = String(row[cohortsIdx["CohortCode"]] || "").trim();
    if (code) cohorts[code] = row;
  });

  // ── CORE: cfg semaforo ────────────────────────────────────────
  var cfgMem = _leerHoja_(coreSS.getSheetByName("_CFG_SEMAFORO"));
  var cfg    = _resolverCfg_(cfgMem);

  // ── ADMIN: students ───────────────────────────────────────────
  var studentsMem     = _leerHoja_(adminSS.getSheetByName("Students"));
  var studentsIdx     = studentsMem.idx;
  var students        = {};
  var studentsByProgram = {};

  studentsMem.datos.forEach(function(row) {
    var id   = String(row[studentsIdx["StudentID"]]   || "").trim();
    var prog = String(row[studentsIdx["ProgramCode"]] || "").trim();
    if (!id) return;
    students[id] = row;
    if (!studentsByProgram[prog]) studentsByProgram[prog] = [];
    studentsByProgram[prog].push(id);
  });

  // ── ADMIN: GradeHistory ───────────────────────────────────────
  var ghMem     = _leerHoja_(adminSS.getSheetByName("GradeHistory"));
  var ghIdx     = ghMem.idx;
  var gradeHistoryKeys = {};
  var bestGrades       = {};

  ghMem.datos.forEach(function(row) {
    var sid    = String(row[ghIdx["StudentID"]]   || "").trim();
    var subj   = String(row[ghIdx["SubjectCode"]] || "").trim();
    var nota   = Number(row[ghIdx["Nota"]]);
    var nivel  = String(row[ghIdx["Nivel"]]       || "").trim();
    var estado = String(row[ghIdx["Estado"]]      || "").trim();

    if (!sid || !subj) return;

    var key = sid + "|" + subj;
    gradeHistoryKeys[key] = true;

    if (!isNaN(nota)) {
      if (!bestGrades[key] || nota > bestGrades[key].nota) {
        bestGrades[key] = { nota: nota, nivel: nivel, estado: estado };
      }
    }
  });

  // ── BI: GradeAudit ────────────────────────────────────────────
  var gaMem   = _leerHoja_(biSS.getSheetByName("GradeAudit"));
  var gaIdx   = gaMem.idx;
  var gradeAudit = {};

  gaMem.datos.forEach(function(row) {
    var sid  = String(row[gaIdx["StudentID"]]   || "").trim();
    var subj = String(row[gaIdx["SubjectCode"]] || "").trim();
    if (!sid || !subj) return;
    var key = sid + "|" + subj;
    gradeAudit[key] = row;
  });

  // ── ADMIN: Enrollments (ventana actual) ───────────────────────
  var enrollMem   = _leerHoja_(adminSS.getSheetByName("Enrollments"));
  var enrollIdx   = enrollMem.idx;
  var currentWindow = {};

  enrollMem.datos.forEach(function(row) {
    var sid    = String(row[enrollIdx["StudentID"]]            || "").trim();
    var window = String(row[enrollIdx["WindowCohortCode"]]     || "").trim();
    var status = String(row[enrollIdx["EnrollmentStatusCode"]] || "").trim();
    if (sid && status === "ACTIVE" && window) {
      currentWindow[sid] = window;
    }
  });

  return {
    students:         students,
    studentsIdx:      studentsIdx,
    studentsByProgram:studentsByProgram,
    subjects:         subjects,
    subjectsIdx:      subjectsIdx,
    subjectsByProgram:subjectsByProgram,
    trvSubjects:      trvSubjects,
    programs:         programs,
    programsIdx:      programsIdx,
    cohorts:          cohorts,
    cohortsIdx:       cohortsIdx,
    gradeHistoryKeys: gradeHistoryKeys,
    bestGrades:       bestGrades,
    gradeAudit:       gradeAudit,
    currentWindow:    currentWindow,
    cfg:              cfg,
    coreSS:           coreSS,
    adminSS:          adminSS,
    biSS:             biSS
  };
}


/**
 * Retorna un número de ordenación para un código de momento académico.
 * Permite ordenar asignaturas en orden curricular lógico.
 *
 * @param {string} momentCode — C1M1, A1B2, etc.
 * @returns {number}
 */
function _momentSortKey_(momentCode) {
  var mapa = {
    C1M1: 10, C1M2: 20, C2M1: 30, C2M2: 40, C3M1: 50, C3M2: 60,
    A1B1: 110, A1B2: 120, A1B3: 130, A1B4: 140,
    A2B1: 210, A2B2: 220, A2B3: 230, A2B4: 240
  };
  return mapa[String(momentCode).trim()] || 999;
}


// ─────────────────────────────────────────────────────────────
// SECCIÓN 4: FUNCIONES DE DASHBOARD
// ─────────────────────────────────────────────────────────────

/**
 * Pobla la hoja SEMAFORO_RESUMEN con una fila por estudiante activo.
 *
 * @param {Spreadsheet} panelSS — spreadsheet del panel
 * @param {object}      ctx     — contexto del panel
 * @param {Date}        ahora   — timestamp
 */
function _poblarHojaResumen_(panelSS, ctx, ahora) {
  var hoja = panelSS.getSheetByName("SEMAFORO_RESUMEN");
  if (!hoja) return;

  // Limpiar datos (conservar fila 1)
  var lastRow = hoja.getLastRow();
  if (lastRow > 1) {
    hoja.getRange(2, 1, lastRow - 1, 10).clearContent().clearFormat();
  }

  var stIdx   = ctx.studentsIdx;
  var progIdx = ctx.programsIdx;
  var filas   = [];
  var colores = [];

  Object.keys(ctx.students).forEach(function(studentId) {
    var student     = ctx.students[studentId];
    var progCode    = String(student[stIdx["ProgramCode"]]      || "").trim();
    var status      = String(student[stIdx["StudentStatusCode"]]|| "").trim();
    if (status !== "ACTIVE") return;

    var firstName   = String(student[stIdx["FirstName"]] || "").trim();
    var lastName    = String(student[stIdx["LastName"]]  || "").trim();
    var nombre      = (firstName + " " + lastName).trim();
    var cedula      = String(student[stIdx["DocumentNumber"]] || "").trim();
    var tipo        = String(student[stIdx["StudentType"]]    || "").trim();
    var cohort      = String(student[stIdx["CohortCode"]]     || "").trim();
    var ventana     = ctx.currentWindow[studentId] || "";

    var progRow     = ctx.programs[progCode];
    var progNombre  = progRow ? String(progRow[progIdx["ProgramName"]] || progCode).trim() : progCode;

    var credInfo    = _calcularCreditos_(studentId, progCode, ctx);
    var promedio    = _calcularPromedioPanel_(studentId, progCode, ctx);
    var colorSem    = promedio !== null ? _calcularSemaforo_(promedio, ctx.cfg) : "GREY";

    filas.push([
      nombre,
      cedula,
      progNombre,
      tipo,
      cohort,
      ventana,
      credInfo.completados + "/" + credInfo.total,
      credInfo.total > 0 ? Math.round(credInfo.porcentaje) + "%" : "0%",
      promedio !== null ? promedio : "",
      colorSem
    ]);
    colores.push(colorSem);
  });

  if (filas.length === 0) return;

  hoja.getRange(2, 1, filas.length, 10).setValues(filas);

  // Colorear columna de Estado General (col 10)
  colores.forEach(function(color, i) {
    hoja.getRange(i + 2, 10).setBackground(_colorSemaforo_(color));
  });
}


/**
 * Pobla la hoja DETALLE_{programCode} con la vista matricial del programa.
 *
 * @param {Spreadsheet} panelSS     — spreadsheet del panel
 * @param {string}      programCode — código del programa
 * @param {object}      ctx         — contexto del panel
 */
function _poblarHojaDetalle_(panelSS, programCode, ctx) {
  var hoja = panelSS.getSheetByName("DETALLE_" + programCode);
  if (!hoja) return;

  hoja.clear();
  hoja.setTabColor("#ff6d00");

  var subjectsProg = ctx.subjectsByProgram[programCode] || [];
  var trvSubjects  = ctx.trvSubjects;
  var allSubjects  = subjectsProg.concat(trvSubjects);
  var sIdx         = ctx.subjectsIdx;
  var stIdx        = ctx.studentsIdx;

  if (allSubjects.length === 0) return;

  // Construir headers
  var headers = ["Nombre", "Cédula", "Tipo", "Cohorte Entrada", "Ventana Actual"];
  allSubjects.forEach(function(sub) {
    headers.push(String(sub[sIdx["SubjectCode"]] || "").trim());
  });
  headers.push("% Avance", "Promedio Acum.", "Estado General");

  var numCols = headers.length;
  hoja.getRange(1, 1, 1, numCols).setValues([headers])
    .setBackground(PANEL_CONFIG.COLOR.HEADER)
    .setFontColor("#ffffff")
    .setFontWeight("bold");

  // Colorear encabezados TRV
  var offsetTRV = 5 + subjectsProg.length + 1; // 1-indexed
  for (var t = 0; t < trvSubjects.length; t++) {
    hoja.getRange(1, offsetTRV + t).setBackground(PANEL_CONFIG.COLOR.TRV).setFontColor("#1a237e");
  }

  // Obtener estudiantes del programa
  var studentIds = ctx.studentsByProgram[programCode] || [];
  if (studentIds.length === 0) {
    hoja.setFrozenRows(1);
    hoja.setFrozenColumns(2);
    return;
  }

  var filas       = [];
  var bgColors    = [];  // 2D array de backgrounds

  studentIds.forEach(function(studentId) {
    var student = ctx.students[studentId];
    if (!student) return;

    var statusCode = String(student[stIdx["StudentStatusCode"]] || "").trim();
    if (statusCode !== "ACTIVE") return;

    var firstName = String(student[stIdx["FirstName"]] || "").trim();
    var lastName  = String(student[stIdx["LastName"]]  || "").trim();
    var nombre    = (firstName + " " + lastName).trim();
    var cedula    = String(student[stIdx["DocumentNumber"]] || "").trim();
    var tipo      = String(student[stIdx["StudentType"]]    || "").trim();
    var cohort    = String(student[stIdx["CohortCode"]]     || "").trim();
    var ventana   = ctx.currentWindow[studentId] || "";

    var fila   = [nombre, cedula, tipo, cohort, ventana];
    var bgFila = [
      PANEL_CONFIG.COLOR.LOCKED, PANEL_CONFIG.COLOR.LOCKED,
      PANEL_CONFIG.COLOR.LOCKED, PANEL_CONFIG.COLOR.LOCKED,
      PANEL_CONFIG.COLOR.LOCKED
    ];

    allSubjects.forEach(function(sub) {
      var subCode = String(sub[sIdx["SubjectCode"]] || "").trim();
      var info    = _getMejorNotaInfo_(studentId, subCode, ctx);
      fila.push(info.nota !== null ? info.nota : "");
      bgFila.push(_colorSemaforo_(info.color));
    });

    var promedio  = _calcularPromedioPanel_(studentId, programCode, ctx);
    var credInfo  = _calcularCreditos_(studentId, programCode, ctx);
    var colorGral = promedio !== null ? _calcularSemaforo_(promedio, ctx.cfg) : "GREY";

    fila.push(
      credInfo.total > 0 ? Math.round(credInfo.porcentaje) + "%" : "0%",
      promedio !== null ? promedio : "",
      colorGral
    );
    bgFila.push(PANEL_CONFIG.COLOR.LOCKED, PANEL_CONFIG.COLOR.LOCKED, _colorSemaforo_(colorGral));

    filas.push(fila);
    bgColors.push(bgFila);
  });

  if (filas.length > 0) {
    hoja.getRange(2, 1, filas.length, numCols).setValues(filas);
    hoja.getRange(2, 1, filas.length, numCols).setBackgrounds(bgColors);
  }

  hoja.setFrozenRows(1);
  hoja.setFrozenColumns(2);
}


/**
 * Construye la lista de nombres de todos los estudiantes activos
 * y establece un dropdown en la celda B3 del BOLETIN.
 *
 * @param {Spreadsheet} panelSS — spreadsheet del panel
 * @param {object}      ctx     — contexto del panel
 */
function _actualizarListaBoletin_(panelSS, ctx) {
  var hoja = panelSS.getSheetByName("BOLETIN");
  if (!hoja) return;

  var stIdx  = ctx.studentsIdx;
  var nombres = [];

  Object.keys(ctx.students).forEach(function(studentId) {
    var student = ctx.students[studentId];
    var status  = String(student[stIdx["StudentStatusCode"]] || "").trim();
    if (status !== "ACTIVE") return;

    var firstName = String(student[stIdx["FirstName"]] || "").trim();
    var lastName  = String(student[stIdx["LastName"]]  || "").trim();
    nombres.push((firstName + " " + lastName).trim());
  });

  nombres.sort();

  if (nombres.length === 0) return;

  var regla = SpreadsheetApp.newDataValidation()
    .requireValueInList(nombres, true)
    .setAllowInvalid(false)
    .build();

  hoja.getRange("B3").setDataValidation(regla);
}


// ─────────────────────────────────────────────────────────────
// SECCIÓN 5: FUNCIÓN DEL BOLETÍN
// ─────────────────────────────────────────────────────────────

/**
 * Genera el boletín académico individual en la hoja BOLETIN a partir de fila 4.
 *
 * @param {Sheet}   hoja      — hoja BOLETIN
 * @param {string}  studentId — StudentID del estudiante
 * @param {object}  ctx       — contexto del panel
 * @param {Date}    ahora     — timestamp
 */
function _escribirBoletin_(hoja, studentId, ctx, ahora) {
  // Limpiar filas 4+
  var lastRow = hoja.getLastRow();
  if (lastRow >= 4) {
    hoja.getRange(4, 1, lastRow - 3, 6).clearContent().clearFormat();
  }

  var student  = ctx.students[studentId];
  if (!student) return;

  var stIdx    = ctx.studentsIdx;
  var progIdx  = ctx.programsIdx;
  var firstName= String(student[stIdx["FirstName"]]       || "").trim();
  var lastName = String(student[stIdx["LastName"]]        || "").trim();
  var nombre   = (firstName + " " + lastName).trim();
  var cedula   = String(student[stIdx["DocumentNumber"]]  || "").trim();
  var tipo     = String(student[stIdx["StudentType"]]     || "").trim();
  var cohort   = String(student[stIdx["CohortCode"]]      || "").trim();
  var progCode = String(student[stIdx["ProgramCode"]]     || "").trim();
  var ventana  = ctx.currentWindow[studentId] || "N/A";

  var progRow  = ctx.programs[progCode];
  var progNombre = progRow ? String(progRow[progIdx["ProgramName"]] || progCode).trim() : progCode;

  var fechaStr = Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "dd/MM/yyyy");
  var email    = Session.getEffectiveUser().getEmail();

  var fila = 4;

  // Separador visual
  hoja.getRange(fila, 1, 1, 6).merge()
    .setValue("─────────────────────────────────────────────────────────────────────────────────────")
    .setFontColor("#cccccc").setFontSize(8);
  fila++;

  // Ciudad y fecha
  hoja.getRange(fila, 1).setValue("Ciudad:");
  hoja.getRange(fila, 2).setValue("Bogotá D.C. — Colombia");
  hoja.getRange(fila, 4).setValue("Fecha:");
  hoja.getRange(fila, 5).setValue(fechaStr);
  fila++;
  fila++;

  // Sección: Información del Estudiante
  hoja.getRange(fila, 1, 1, 6).merge()
    .setValue("INFORMACIÓN DEL ESTUDIANTE")
    .setBackground("#dae8fc").setFontWeight("bold").setFontColor("#1a3c5e");
  fila++;

  var infoEstudiante = [
    ["Nombre completo:",   nombre,      "Programa:", progNombre],
    ["Cédula:",            cedula,      "Tipo:",     tipo],
    ["Cohorte de entrada:",cohort,      "Ventana actual:", ventana]
  ];

  infoEstudiante.forEach(function(rowData) {
    hoja.getRange(fila, 1).setValue(rowData[0]).setFontWeight("bold");
    hoja.getRange(fila, 2).setValue(rowData[1]);
    if (rowData[2]) {
      hoja.getRange(fila, 4).setValue(rowData[2]).setFontWeight("bold");
      hoja.getRange(fila, 5).setValue(rowData[3]);
    }
    fila++;
  });
  fila++;

  // Sección: Historial Académico
  hoja.getRange(fila, 1, 1, 6).merge()
    .setValue("HISTORIAL ACADÉMICO")
    .setBackground("#dae8fc").setFontWeight("bold").setFontColor("#1a3c5e");
  fila++;

  // Headers de la tabla
  var tableHeaders = ["Asignatura", "Cód.", "Nota", "Nivel", "Estado", "Débito"];
  hoja.getRange(fila, 1, 1, 6).setValues([tableHeaders])
    .setBackground(PANEL_CONFIG.COLOR.HEADER)
    .setFontColor("#ffffff").setFontWeight("bold");
  fila++;

  // Asignaturas del programa + TRV
  var allSubjects = (ctx.subjectsByProgram[progCode] || []).concat(ctx.trvSubjects);
  var sIdx        = ctx.subjectsIdx;

  allSubjects.forEach(function(sub) {
    var subCode  = String(sub[sIdx["SubjectCode"]] || "").trim();
    var subName  = String(sub[sIdx["SubjectName"]] || "").trim();
    var isTRV    = String(sub[sIdx["ProgramCode"]] || "").trim() === "TRV";
    var info     = _getMejorNotaInfo_(studentId, subCode, ctx);

    var nivel    = info.nota !== null ? _calcularNivel_(info.nota, ctx.cfg) : "PENDIENTE";
    var estado   = info.nota !== null
      ? (info.nota >= (ctx.cfg.UMBRAL_APROBACION || 3.0) ? "APROBADO" : "REPROBADO")
      : "PENDIENTE";
    var debito   = (info.nota !== null && info.nota < (ctx.cfg.UMBRAL_APROBACION || 3.0)) ? "SI" : "";

    var rowValues = [subName, subCode, info.nota !== null ? info.nota : "", nivel, estado, debito];
    var rowRange  = hoja.getRange(fila, 1, 1, 6);
    rowRange.setValues([rowValues]);

    if (isTRV) rowRange.setBackground(PANEL_CONFIG.COLOR.TRV);

    // Colorear celda de nota
    if (info.nota !== null) {
      hoja.getRange(fila, 3).setBackground(_colorSemaforo_(info.color));
    }
    // Colorear estado
    hoja.getRange(fila, 5).setBackground(
      estado === "APROBADO" ? PANEL_CONFIG.COLOR.GREEN :
      estado === "REPROBADO" ? PANEL_CONFIG.COLOR.RED : PANEL_CONFIG.COLOR.GREY
    );

    fila++;
  });
  fila++;

  // Sección: Resumen
  hoja.getRange(fila, 1, 1, 6).merge()
    .setValue("RESUMEN")
    .setBackground("#dae8fc").setFontWeight("bold").setFontColor("#1a3c5e");
  fila++;

  var credInfo  = _calcularCreditos_(studentId, progCode, ctx);
  var promedio  = _calcularPromedioPanel_(studentId, progCode, ctx);
  var colorGral = promedio !== null ? _calcularSemaforo_(promedio, ctx.cfg) : "GREY";

  hoja.getRange(fila, 1).setValue("Créditos completados:").setFontWeight("bold");
  hoja.getRange(fila, 2).setValue(
    credInfo.completados + " / " + credInfo.total +
    " (" + (credInfo.total > 0 ? Math.round(credInfo.porcentaje) : 0) + "%)"
  );
  fila++;

  hoja.getRange(fila, 1).setValue("Promedio acumulado:").setFontWeight("bold");
  hoja.getRange(fila, 2).setValue(promedio !== null ? promedio : "Sin datos");
  fila++;

  hoja.getRange(fila, 1).setValue("Estado general:").setFontWeight("bold");
  var estadoGral = hoja.getRange(fila, 2);
  estadoGral.setValue(colorGral !== "GREY" ? _calcularNivel_(promedio, ctx.cfg) : "SIN DATOS");
  estadoGral.setBackground(_colorSemaforo_(colorGral));
  fila++;
  fila++;

  // Footer
  hoja.getRange(fila, 1, 1, 6).merge()
    .setValue("Generado: " + fechaStr + " | " + email)
    .setFontSize(8).setFontStyle("italic").setFontColor("#999999");

  // Ocultar grilla para aspecto limpio al imprimir
  hoja.setHiddenGridlines(true);

  SpreadsheetApp.flush();
}


// ─────────────────────────────────────────────────────────────
// SECCIÓN 6: HELPERS PRIVADOS
// ─────────────────────────────────────────────────────────────

/**
 * Retorna la mejor nota disponible para un estudiante en una asignatura,
 * combinando bestGrades (GradeHistory) y gradeAudit (GradeAudit de BI).
 *
 * @param {string} studentId   — StudentID
 * @param {string} subjectCode — SubjectCode
 * @param {object} ctx         — contexto del panel
 * @returns {{ nota: number|null, color: string }}
 */
function _getMejorNotaInfo_(studentId, subjectCode, ctx) {
  var key         = studentId + "|" + subjectCode;
  var bestHistorico = ctx.bestGrades[key];    // { nota, nivel, estado }
  var auditRow    = ctx.gradeAudit[key];      // fila de GradeAudit
  var gaIdx       = ctx.biSS
    ? null
    : null;  // gaIdx se calcula abajo si es necesario

  var notaHistorica = bestHistorico ? bestHistorico.nota : null;
  var notaAudit     = null;

  if (auditRow) {
    // Necesitamos el índice de Nota en GradeAudit
    var gaMem = _leerHoja_(ctx.biSS.getSheetByName("GradeAudit"));
    var gAIdx = gaMem.idx;
    var rawNota = auditRow[gAIdx["Nota"]];
    notaAudit = (rawNota !== "" && rawNota !== null && !isNaN(Number(rawNota))) ? Number(rawNota) : null;
  }

  var mejorNota = null;
  if (notaHistorica !== null && notaAudit !== null) {
    mejorNota = Math.max(notaHistorica, notaAudit);
  } else if (notaHistorica !== null) {
    mejorNota = notaHistorica;
  } else if (notaAudit !== null) {
    mejorNota = notaAudit;
  }

  var color = mejorNota !== null ? _calcularSemaforo_(mejorNota, ctx.cfg) : "GREY";
  return { nota: mejorNota, color: color };
}


/**
 * Calcula los créditos de un estudiante: total, completados y porcentaje.
 *
 * @param {string} studentId   — StudentID
 * @param {string} programCode — ProgramCode
 * @param {object} ctx         — contexto del panel
 * @returns {{ total: number, completados: number, porcentaje: number }}
 */
function _calcularCreditos_(studentId, programCode, ctx) {
  var sIdx        = ctx.subjectsIdx;
  var umbral      = ctx.cfg.UMBRAL_APROBACION || 3.0;
  var allSubjects = (ctx.subjectsByProgram[programCode] || []).concat(ctx.trvSubjects);

  var total       = 0;
  var completados = 0;

  allSubjects.forEach(function(sub) {
    var subCode  = String(sub[sIdx["SubjectCode"]] || "").trim();
    var credits  = Number(sub[sIdx["Credits"]] || 0);
    if (!subCode || credits <= 0) return;

    total += credits;

    var info = _getMejorNotaInfo_(studentId, subCode, ctx);
    if (info.nota !== null && info.nota >= umbral) {
      completados += credits;
    }
  });

  var porcentaje = total > 0 ? (completados / total) * 100 : 0;
  return { total: total, completados: completados, porcentaje: porcentaje };
}


/**
 * Calcula el promedio aritmético de todas las notas disponibles de un estudiante
 * en las asignaturas de su programa + TRV.
 *
 * @param {string} studentId   — StudentID
 * @param {string} programCode — ProgramCode
 * @param {object} ctx         — contexto del panel
 * @returns {number|null} promedio o null si no hay notas
 */
function _calcularPromedioPanel_(studentId, programCode, ctx) {
  var sIdx        = ctx.subjectsIdx;
  var allSubjects = (ctx.subjectsByProgram[programCode] || []).concat(ctx.trvSubjects);
  var notas       = [];

  allSubjects.forEach(function(sub) {
    var subCode = String(sub[sIdx["SubjectCode"]] || "").trim();
    if (!subCode) return;
    var info = _getMejorNotaInfo_(studentId, subCode, ctx);
    if (info.nota !== null) notas.push(info.nota);
  });

  if (notas.length === 0) return null;
  var suma = notas.reduce(function(a, b) { return a + b; }, 0);
  return Math.round((suma / notas.length) * 100) / 100;
}


/**
 * Convierte un código de color semáforo a su valor hexadecimal.
 *
 * @param {string} color — GREEN | YELLOW | RED | GREY
 * @returns {string} hex color
 */
function _colorSemaforo_(color) {
  switch (String(color).toUpperCase()) {
    case "GREEN":  return PANEL_CONFIG.COLOR.GREEN;
    case "YELLOW": return PANEL_CONFIG.COLOR.YELLOW;
    case "RED":    return PANEL_CONFIG.COLOR.RED;
    default:       return PANEL_CONFIG.COLOR.GREY;
  }
}


// ─────────────────────────────────────────────────────────────
// SECCIÓN 7: HELPERS DEL HORARIO SEMANAL
// ─────────────────────────────────────────────────────────────

/**
 * Escribe las filas del horario en la hoja HORARIO_SEMANAL.
 * Agrupa visualmente por día con fondos alternados y añade
 * un hiperlink en la columna "Aula Virtual".
 *
 * @param {Spreadsheet} panelSS — spreadsheet del panel
 * @param {Array}       filas   — objetos de clase ordenados por dayOrder + startTime
 * @param {Date}        ahora   — timestamp para el pie de página
 */
function _poblarHojaHorario_(panelSS, filas, ahora) {
  var hoja = panelSS.getSheetByName("HORARIO_SEMANAL");
  if (!hoja) return;

  // Limpiar datos anteriores (conservar header)
  var lastRow = hoja.getLastRow();
  if (lastRow > 1) {
    hoja.getRange(2, 1, lastRow - 1, 10).clearContent().clearFormat();
  }

  if (filas.length === 0) {
    hoja.getRange(2, 1).setValue("Sin clases activas registradas.")
      .setFontStyle("italic").setFontColor("#999999");
    return;
  }

  // Paleta de colores por día (alternada para lectura rápida)
  var DAY_COLORS = {
    LUNES:     "#e8f0fe",  // azul claro
    MARTES:    "#e6f4ea",  // verde claro
    MIERCOLES: "#fce8b2",  // amarillo claro
    MIÉRCOLES: "#fce8b2",
    JUEVES:    "#fce5cd",  // naranja claro
    VIERNES:   "#e8d5f0",  // lavanda
    SABADO:    "#fce8f3",  // rosa claro
    SÁBADO:    "#fce8f3"
  };

  var valores   = [];
  var colores   = [];

  filas.forEach(function(f) {
    var bg = DAY_COLORS[f.dayOfWeek] || PANEL_CONFIG.COLOR.GREY;

    valores.push([
      f.dayOfWeek,   // A: Día
      f.startTime,   // B: Inicio
      f.endTime,     // C: Fin
      f.subjectName, // D: Asignatura
      f.subjectCode, // E: Cód.
      f.programCode, // F: Programa
      f.cohortCode,  // G: Cohorte
      f.momentCode,  // H: Momento
      f.docente,     // I: Docente
      f.classroomURL // J: Aula Virtual (URL cruda — se convierte en fórmula abajo)
    ]);

    colores.push(new Array(10).fill(bg));
  });

  var dataRange = hoja.getRange(2, 1, valores.length, 10);
  dataRange.setValues(valores);
  dataRange.setBackgrounds(colores);

  // Convertir columna J (Aula Virtual) a hipervínculo cuando hay URL
  for (var i = 0; i < filas.length; i++) {
    var url = filas[i].classroomURL;
    if (url) {
      var fila = i + 2;
      hoja.getRange(fila, 10)
        .setFormula('=HYPERLINK("' + url + '","Abrir Aula")')
        .setFontColor("#1155cc")
        .setFontStyle("normal");
    }
  }

  // Línea separadora entre grupos de días
  var currentDay = "";
  for (var j = 0; j < filas.length; j++) {
    if (filas[j].dayOfWeek !== currentDay) {
      currentDay = filas[j].dayOfWeek;
      if (j > 0) {
        hoja.getRange(j + 2, 1, 1, 10)
          .setBorder(true, false, false, false, false, false,
                     "#666666", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
      }
    }
  }

  // Pie de actualización
  var piedePagina = hoja.getLastRow() + 2;
  var fechaStr = Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "dd/MM/yyyy HH:mm");
  hoja.getRange(piedePagina, 1, 1, 10).merge()
    .setValue("Actualizado: " + fechaStr + " | " + filas.length + " clases activas")
    .setFontSize(8).setFontStyle("italic").setFontColor("#999999");

  SpreadsheetApp.flush();
}


/**
 * Convierte un valor de tiempo (Date o string) a formato "HH:mm".
 * Sheets devuelve tiempos como Date(1899-12-30 HH:MM:SS).
 *
 * @param {Date|string} val — valor de celda de tiempo
 * @returns {string} "HH:mm" o "" si está vacío
 */
function _formatearTiempoPanel_(val) {
  if (!val && val !== 0) return "";
  if (val instanceof Date) {
    var h = val.getHours();
    var m = val.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  return String(val).trim();
}


/**
 * Busca el StudentID a partir del nombre completo.
 *
 * @param {string} nombre — nombre completo del estudiante
 * @param {object} ctx    — contexto del panel
 * @returns {string|null} StudentID o null si no se encuentra
 */
function _buscarStudentIdPorNombre_(nombre, ctx) {
  var stIdx  = ctx.studentsIdx;
  var nombreBuscado = String(nombre || "").trim().toLowerCase();

  var encontrado = null;
  Object.keys(ctx.students).some(function(studentId) {
    var student   = ctx.students[studentId];
    var firstName = String(student[stIdx["FirstName"]] || "").trim();
    var lastName  = String(student[stIdx["LastName"]]  || "").trim();
    var nombreCmp = (firstName + " " + lastName).trim().toLowerCase();
    if (nombreCmp === nombreBuscado) {
      encontrado = studentId;
      return true;
    }
    return false;
  });

  return encontrado;
}


/**
 * Obtiene el spreadsheet del panel (desde ScriptProperties o búsqueda en Drive).
 *
 * @returns {Spreadsheet}
 */
function _getPanelSS_() {
  var props = PropertiesService.getScriptProperties();
  var id    = props.getProperty(PANEL_CONFIG.PROP_KEY);

  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (_) {
      // ID cacheado inválido — intentar por nombre
    }
  }

  // Buscar por nombre en la carpeta correspondiente
  var carpeta = _getCarpetaPanel_();
  var archivos = carpeta.getFilesByName(PANEL_CONFIG.NOMBRE);
  if (archivos.hasNext()) {
    var archivo = archivos.next();
    props.setProperty(PANEL_CONFIG.PROP_KEY, archivo.getId());
    return SpreadsheetApp.openById(archivo.getId());
  }

  throw new Error("Panel " + PANEL_CONFIG.NOMBRE + " no encontrado. Ejecuta setupPanelAcademico() primero.");
}


/**
 * Obtiene la carpeta stagingAcademicoFolderName dentro de rootFolderName.
 *
 * @returns {Folder}
 */
function _getCarpetaPanel_() {
  var rootName    = SIDEP_CONFIG.rootFolderName;
  var stagingName = SIDEP_CONFIG.stagingAcademicoFolderName;

  // Intentar desde caché de ScriptProperties primero
  var props      = PropertiesService.getScriptProperties();
  var rootId     = props.getProperty(SIDEP_CONFIG.propKeys.rootFolderId);

  var rootFolder;
  if (rootId) {
    try {
      rootFolder = DriveApp.getFolderById(rootId);
    } catch (_) {
      rootFolder = null;
    }
  }

  if (!rootFolder) {
    var rootFolders = DriveApp.getFoldersByName(rootName);
    if (!rootFolders.hasNext()) {
      throw new Error("Carpeta raíz '" + rootName + "' no encontrada en Drive.");
    }
    rootFolder = rootFolders.next();
  }

  var stagingFolders = rootFolder.getFoldersByName(stagingName);
  if (!stagingFolders.hasNext()) {
    throw new Error("Carpeta '" + stagingName + "' no encontrada dentro de '" + rootName + "'.");
  }
  return stagingFolders.next();
}
