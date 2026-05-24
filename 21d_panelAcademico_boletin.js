/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 21d_panelAcademico_boletin.js
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Generación del boletín académico individual y helpers privados
 *   de cálculo compartidos con el dashboard.
 *   Llamadas SOLO desde funciones del panel (21_panelAcademico.js
 *   y 21c_panelAcademico_datos.js).
 *
 * FUNCIONES:
 *   _escribirBoletin_(hoja, studentId, ctx, ahora) → renderiza BOLETIN
 *   _getMejorNotaInfo_(studentId, subjectCode, ctx) → nota con prioridad
 *   _calcularCreditos_(studentId, programCode, ctx) → créditos completados
 *   _calcularPromedioPanel_(studentId, programCode, ctx) → promedio aritmético
 *   _colorSemaforo_(color)                          → hex del color semáforo
 *   _buscarStudentIdPorNombre_(nombre, ctx)         → StudentID por nombre
 *   _getPanelSS_()                                  → Spreadsheet del panel
 *   _getCarpetaPanel_()                             → Folder en Drive
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.js  → SIDEP_CONFIG
 *   20_semaforo.js      → _calcularSemaforo_(), _calcularNivel_()
 *   21_panelAcademico.js → PANEL_CONFIG (scope global GAS)
 *
 * VERSIÓN: 1.0.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-05-24
 * ============================================================
 */


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

  // ── Clasificar asignaturas en 3 grupos ──────────────────────────
  // FINALIZADAS: tiene nota DEFINITIVA  (Fuente=MANUAL en GradeHistory)
  // EN CURSO   : el estudiante está MATRICULADO ACTIVO en un aula CREATED
  //              de esa asignatura (con o sin nota provisional). Fuente
  //              de verdad: Enrollments ∧ MasterDeployments.ScriptStatusCode.
  // PENDIENTES : asignatura del plan que ni está cerrada ni en curso.
  var allSubjects = (ctx.subjectsByProgram[progCode] || []).concat(ctx.trvSubjects);
  var sIdx        = ctx.subjectsIdx;
  var enCursoMap  = ctx.currentSubjects[studentId] || {};

  var grupoFinal    = [];
  var grupoEnCurso  = [];
  var grupoPendiente= [];

  allSubjects.forEach(function(sub) {
    var subCode = String(sub[sIdx["SubjectCode"]] || "").trim();
    var subName = String(sub[sIdx["SubjectName"]] || "").trim();
    var isTRV   = String(sub[sIdx["ProgramCode"]] || "").trim() === "TRV";
    var info    = _getMejorNotaInfo_(studentId, subCode, ctx);

    var item = { subCode: subCode, subName: subName, isTRV: isTRV, info: info };

    if (info.fuente === "MANUAL")          grupoFinal.push(item);    // nota definitiva
    else if (enCursoMap[subCode] === true) grupoEnCurso.push(item);  // matrícula activa
    else                                   grupoPendiente.push(item);
  });

  // Helper local: pinta una sección de tabla con sus filas.
  // tipoSeccion ∈ { "FINAL", "EN_CURSO", "PENDIENTE" } controla el render
  // para que una asignatura EN CURSO sin nota aún se muestre como "EN CURSO"
  // y no como "PENDIENTE".
  function escribirSeccion_(titulo, items, tipoSeccion) {
    if (items.length === 0) return;

    // Encabezado de la sección (banda gris suave)
    hoja.getRange(fila, 1, 1, 6).merge()
      .setValue(titulo)
      .setBackground("#e0e0e0").setFontWeight("bold").setFontColor("#333333");
    fila++;

    // Headers de la tabla
    var tableHeaders = ["Asignatura", "Cód.", "Nota", "Nivel", "Estado", "Débito"];
    hoja.getRange(fila, 1, 1, 6).setValues([tableHeaders])
      .setBackground(PANEL_CONFIG.COLOR.HEADER)
      .setFontColor("#ffffff").setFontWeight("bold");
    fila++;

    var umbralAprob = ctx.cfg.UMBRAL_APROBACION || 3.0;

    items.forEach(function(it) {
      var info     = it.info;
      var tieneNota= info.nota !== null;
      var notaCell = tieneNota ? info.nota : "";

      // Nivel y Estado — dependen del tipo de sección
      var nivel, estado;
      if (tipoSeccion === "FINAL") {
        // Definitiva: APROBADO/REPROBADO según umbral
        nivel  = _calcularNivel_(info.nota, ctx.cfg);
        estado = info.nota >= umbralAprob ? "APROBADO" : "REPROBADO";
      } else if (tipoSeccion === "EN_CURSO") {
        // En curso: nivel solo si hay nota provisional, estado siempre "EN CURSO"
        nivel  = tieneNota ? _calcularNivel_(info.nota, ctx.cfg) : "—";
        estado = "EN CURSO";
        if (!tieneNota) notaCell = "Sin nota aún";
      } else {
        // Pendiente: ni nivel ni estado significativo
        nivel  = "—";
        estado = "PENDIENTE";
      }

      // Débito: SOLO sobre notas definitivas reprobadas
      var debito = (tipoSeccion === "FINAL" && info.nota < umbralAprob) ? "SI" : "";

      var rowValues = [it.subName, it.subCode, notaCell, nivel, estado, debito];
      var rowRange  = hoja.getRange(fila, 1, 1, 6);
      rowRange.setValues([rowValues]);

      if (it.isTRV) rowRange.setBackground(PANEL_CONFIG.COLOR.TRV);

      // Colorear celda de nota
      if (tieneNota) {
        hoja.getRange(fila, 3).setBackground(
          tipoSeccion === "EN_CURSO"
            ? PANEL_CONFIG.COLOR.IN_PROGRESS
            : _colorSemaforo_(info.color)
        );
      } else if (tipoSeccion === "EN_CURSO") {
        // Celda informativa "Sin nota aún" con fondo azul claro
        hoja.getRange(fila, 3)
          .setBackground(PANEL_CONFIG.COLOR.IN_PROGRESS)
          .setFontStyle("italic").setFontColor("#666666").setFontSize(9);
      }

      // Colorear celda de estado
      var bgEstado;
      if      (estado === "APROBADO")  bgEstado = PANEL_CONFIG.COLOR.GREEN;
      else if (estado === "REPROBADO") bgEstado = PANEL_CONFIG.COLOR.RED;
      else if (estado === "EN CURSO")  bgEstado = PANEL_CONFIG.COLOR.IN_PROGRESS;
      else                             bgEstado = PANEL_CONFIG.COLOR.GREY;
      hoja.getRange(fila, 5).setBackground(bgEstado);

      fila++;
    });
    fila++; // espacio entre secciones
  }

  // ── Escribir las 3 secciones en orden ──────────────────────────
  escribirSeccion_("ASIGNATURAS FINALIZADAS",
                   grupoFinal, "FINAL");
  escribirSeccion_("ASIGNATURAS EN CURSO (matriculadas — notas provisionales)",
                   grupoEnCurso, "EN_CURSO");
  escribirSeccion_("ASIGNATURAS PENDIENTES (sin cursar aún)",
                   grupoPendiente, "PENDIENTE");

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
 * Resuelve la nota a mostrar para un par (estudiante, asignatura) aplicando
 * la prioridad institucional:
 *
 *   1) GradeHistory (Fuente=MANUAL)         → nota DEFINITIVA — gana siempre.
 *   2) GradeAudit   (Fuente=CLASSROOM)      → nota EN CURSO   — solo si no hay definitiva.
 *   3) Sin datos                            → null            — pintado como gris.
 *
 * La definitiva trumpea la en-curso por diseño: si una asignatura ya cerró
 * con una nota final, una calificación parcial posterior en una nueva aula
 * (caso reintento) NO la sobrescribe en la vista. El reintento se ve en
 * GradeAudit y se promueve a GradeHistory cuando se cierre el aula.
 *
 * @returns {{ nota: number|null, color: string, fuente: string|null, isInProgress: boolean }}
 */
function _getMejorNotaInfo_(studentId, subjectCode, ctx) {
  var key      = studentId + "|" + subjectCode;
  var bestHist = ctx.bestGrades[key];   // { nota, nivel, estado } o undefined
  var auditRow = ctx.gradeAudit[key];   // row de GradeAudit o undefined

  // 1) Nota definitiva en GradeHistory — prioridad máxima
  if (bestHist && bestHist.nota !== null && !isNaN(bestHist.nota)) {
    return {
      nota:         bestHist.nota,
      color:        _calcularSemaforo_(bestHist.nota, ctx.cfg),
      fuente:       "MANUAL",
      isInProgress: false
    };
  }

  // 2) Nota en curso desde GradeAudit (Classroom)
  if (auditRow && ctx.gradeAuditIdx) {
    var iNota   = ctx.gradeAuditIdx["Nota"];
    var iFuente = ctx.gradeAuditIdx["Fuente"];
    var rawNota = (iNota   !== undefined) ? auditRow[iNota]   : "";
    var rawFnt  = (iFuente !== undefined) ? auditRow[iFuente] : "";
    var fuente  = String(rawFnt || "").trim() || "CLASSROOM";
    var notaNum = (rawNota !== "" && rawNota !== null && !isNaN(Number(rawNota)))
      ? Number(rawNota)
      : null;
    if (notaNum !== null) {
      return {
        nota:         notaNum,
        color:        _calcularSemaforo_(notaNum, ctx.cfg),
        fuente:       fuente,
        isInProgress: fuente === "CLASSROOM"
      };
    }
  }

  // 3) Sin datos — gris
  return { nota: null, color: "GREY", fuente: null, isInProgress: false };
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

    // Un crédito solo se considera "completado" cuando la nota es DEFINITIVA
    // (Fuente=MANUAL en GradeHistory) y aprueba. Notas EN CURSO (Classroom)
    // pueden cambiar antes del cierre del aula — no inflan el % de avance.
    var info = _getMejorNotaInfo_(studentId, subCode, ctx);
    if (info.fuente === "MANUAL" && info.nota !== null && info.nota >= umbral) {
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
