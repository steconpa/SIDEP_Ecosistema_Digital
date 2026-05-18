/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 53_menu_staging_estudiantes.gs
 * Versión: 1.1.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Menu y trigger onOpen para SIDEP_STG_ESTUDIANTES.
 *
 * MENÚ (en orden de ejecucion):
 *
 *   — PREPARACION —
 *   ├── Actualizar listados (dropdowns)
 *
 *   — REGISTRO DE ESTUDIANTES —
 *   ├── Validar estudiantes (sin escribir)
 *   ├── Procesar solicitudes de estudiantes
 *
 *   — MATRICULAS A AULAS —
 *   ├── Validar matriculas (sin escribir)
 *   ├── Procesar matriculas a aulas
 *   ├── Procesar matriculas (sin notificar)
 *
 *   — NOTIFICACIONES —
 *   ├── Notificar estudiantes (preview)
 *   ├── Notificar estudiantes — TODAS las ventanas ACTIVE
 *   ├── Notificar estudiantes por ventana...   [v1.1.0]
 *   ├── Notificar ultimo lote procesado        [v1.1.0]
 *
 *   — CIERRE DE COHORTE —                     [v1.1.0]
 *   ├── Diagnostico de cierre por ventana...
 *   ├── Cerrar cohorte para estudiantes...
 *   └── Reabrir cohorte academico (rollback)...
 *
 *   — DIAGNOSTICO —
 *   ├── Ver estado de matriculas (staging)
 *   └── Diagnostico completo
 *
 * DEPENDE DE:
 *   43_job_procesarStgEstudiantes.gs → procesarStgEstudiantes(), procesarStgMatriculas()
 *   24c_repo_staging_estudiantes.gs  → leerStgEstudiantes(), leerStgMatriculas()
 *   18b_notificarEstudiantes.gs      → notificarEstudiantes()
 *   54_cerrarCohorteAcademico.gs     → cerrarCohorteAcademico(), reabrirCohorteAcademico(),
 *                                      diagnosticoCierreCohorte()
 *
 * CHANGELOG v1.1.0 (2026-05-18):
 *   - Renombrado item 'Notificar estudiantes (enviar)' a '...TODAS las ventanas ACTIVE'
 *     para hacer explicito que esa opcion no filtra por ventana.
 *   - NUEVO: 'Notificar estudiantes por ventana...' — filtra por windowCohortCode/momentCode.
 *   - NUEVO: 'Notificar ultimo lote procesado' — reenvio de las ventanas del ultimo lote.
 *   - NUEVO bloque CIERRE DE COHORTE con 3 opciones.
 *   - Ref: DEC-2026-015 — Separacion de cierre academico vs administrativo.
 * ============================================================
 */

function stagingEstudiantesOnOpen(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || ss.getName() !== SIDEP_CONFIG.files.stagingEstudiantes) return;

  SpreadsheetApp.getUi()
    .createMenu("SIDEP Estudiantes")

    // — PREPARACION —
    .addItem("Actualizar listados (dropdowns)",          "menuActualizarListadosEst_")
    .addSeparator()

    // — REGISTRO DE ESTUDIANTES —
    .addItem("Validar estudiantes (sin escribir)",        "menuValidarEstudiantes_")
    .addItem("Procesar solicitudes de estudiantes",       "menuProcesarEstudiantes_")
    .addSeparator()

    // — MATRICULAS A AULAS —
    .addItem("Validar matriculas (sin escribir)",         "menuValidarMatriculas_")
    .addItem("Procesar matriculas a aulas",               "menuProcesarMatriculas_")
    .addItem("Procesar matriculas (sin notificar)",       "menuProcesarMatriculasSinNotificar_")
    .addSeparator()

    // — NOTIFICACIONES —
    .addItem("Notificar estudiantes (preview)",                    "menuNotificarEstudiantes_dryRun_")
    .addItem("Notificar estudiantes — TODAS las ventanas ACTIVE",  "menuNotificarEstudiantes_")
    .addItem("Notificar estudiantes por ventana...",               "menuNotificarEstudiantesPorVentana_")
    .addItem("Notificar ultimo lote procesado",                    "menuNotificarUltimoLote_")
    .addSeparator()

    // — CIERRE DE COHORTE —
    .addItem("Diagnostico de cierre por ventana...",               "menuDiagnosticoCierre_")
    .addItem("Cerrar cohorte para estudiantes...",                 "menuCerrarCohorteAcademico_")
    .addItem("Reabrir cohorte academico (rollback)...",            "menuReabrirCohorteAcademico_")
    .addSeparator()

    // — DIAGNOSTICO —
    .addItem("Ver estado de matriculas (staging)",                 "menuVerMatriculas_")
    .addItem("Diagnostico completo",                               "menuDiagnosticoStagingEst_")

    .addToUi();
}


// ── Instalación del trigger onOpen ────────────────────────────

function instalarTriggerStagingEstudiantes_(ss) {
  var targetId = ss.getId();
  var existe   = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === "stagingEstudiantesOnOpen" &&
           t.getTriggerSourceId && t.getTriggerSourceId() === targetId;
  });
  if (!existe) {
    ScriptApp.newTrigger("stagingEstudiantesOnOpen")
      .forSpreadsheet(ss)
      .onOpen()
      .create();
    Logger.log("  OK  Trigger stagingEstudiantesOnOpen instalado");
  } else {
    Logger.log("  --  Trigger stagingEstudiantesOnOpen ya existe");
  }
}


// ════════════════════════════════════════════════════════════
// PREPARACION
// ════════════════════════════════════════════════════════════

function menuActualizarListadosEst_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var ss = getSpreadsheetByName("stagingEstudiantes");
    aplicarDropdownsCatalogo(ss, STAGING_ESTUDIANTES_TABLES);
    ui.alert(
      "Listados actualizados.\n\n" +
      "Los dropdowns de StudentEmail, ProgramCode, SubjectCode, CohortCode\n" +
      "y MomentCode ahora reflejan los datos actuales de las tablas maestras.\n\n" +
      "Ejecuta esta opcion cada vez que registres nuevos estudiantes o cambies catalogo.",
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert("Error al actualizar listados:\n" + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// REGISTRO DE ESTUDIANTES
// ════════════════════════════════════════════════════════════

function menuValidarEstudiantes_() {
  try {
    procesarStgEstudiantes({ dryRun: true });
    SpreadsheetApp.getUi().alert(
      "Validacion OK — sin errores.\n" +
      "Revisa el Logger (Extensiones -> Apps Script -> Registros) para el detalle.\n\n" +
      "Puedes continuar con 'Procesar solicitudes de estudiantes'.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    SpreadsheetApp.getUi().alert("Validacion fallida:\n" + e.message);
  }
}

function menuProcesarEstudiantes_() {
  var ui   = SpreadsheetApp.getUi();
  var resp = ui.alert(
    "SIDEP — Procesar solicitudes de estudiantes",
    "Procesa todas las filas de STG_ESTUDIANTES con:\n" +
    "  ApprovalStatus = APPROVED\n" +
    "  StageStatus    = PENDING (o vacio)\n\n" +
    "Acciones:\n" +
    "  REGISTER   -> crea el estudiante en la tabla maestra Students\n" +
    "  UPDATE     -> actualiza sus datos en Students\n" +
    "  DEACTIVATE -> marca al estudiante como inactivo\n\n" +
    "Tip: ejecuta 'Actualizar listados' despues para que el\n" +
    "nuevo estudiante aparezca en el dropdown de STG_MATRICULAS.\n\n" +
    "Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    procesarStgEstudiantes();
    ui.alert("Proceso completado.\nRevisa STG_ESTUDIANTES_LOG para el detalle.", ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// MATRICULAS A AULAS
// ════════════════════════════════════════════════════════════

function menuValidarMatriculas_() {
  try {
    procesarStgMatriculas({ dryRun: true });
    SpreadsheetApp.getUi().alert(
      "Validacion OK — sin errores.\n" +
      "Revisa el Logger para el detalle.\n\n" +
      "Puedes continuar con 'Procesar matriculas a aulas'.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    SpreadsheetApp.getUi().alert("Validacion fallida:\n" + e.message);
  }
}

function menuProcesarMatriculas_() {
  var ui   = SpreadsheetApp.getUi();
  var resp = ui.alert(
    "SIDEP — Procesar matriculas a aulas",
    "Procesa todas las filas de STG_MATRICULAS con:\n" +
    "  ApprovalStatus = APPROVED\n" +
    "  StageStatus    = PENDING (o vacio)\n\n" +
    "Acciones:\n" +
    "  ENROLL -> inserta en Enrollments + envia invitacion de Classroom al estudiante\n" +
    "  DROP   -> marca EnrollmentStatusCode=DROPPED + remueve del aula\n\n" +
    "Al finalizar envia automaticamente el correo con horario y links\n" +
    "a cada estudiante matriculado.\n\n" +
    "El estudiante debe usar el link del correo para unirse al aula.\n\n" +
    "Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    procesarStgMatriculas();
    ui.alert("Proceso completado.\nRevisa STG_ESTUDIANTES_LOG para el detalle.", ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


function menuProcesarMatriculasSinNotificar_() {
  var ui   = SpreadsheetApp.getUi();
  var resp = ui.alert(
    "SIDEP — Procesar matriculas (sin notificar)",
    "Igual que 'Procesar matriculas a aulas' pero SIN enviar el\n" +
    "correo de bienvenida al finalizar.\n\n" +
    "Usa esta opcion cuando:\n" +
    "  - Estas reprocesando un lote parcial (filas que fallaron antes)\n" +
    "  - El primer lote ya envio el correo y no quieres duplicarlo\n\n" +
    "Despues de procesar, envia el correo manualmente con:\n" +
    "  'Notificar estudiantes (enviar)'\n\n" +
    "Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    procesarStgMatriculas({ skipNotify: true });
    ui.alert(
      "Proceso completado.\n\n" +
      "Notificacion NO enviada (skipNotify=true).\n" +
      "Envia el correo manualmente con 'Notificar estudiantes (enviar)'.\n\n" +
      "Revisa STG_ESTUDIANTES_LOG para el detalle.",
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// NOTIFICACIONES
// ════════════════════════════════════════════════════════════

function menuNotificarEstudiantes_dryRun_() {
  try {
    notificarEstudiantes({ dryRun: true });
    SpreadsheetApp.getUi().alert(
      "Preview completado.\n" +
      "Revisa el Logger (Extensiones -> Apps Script -> Registros)\n" +
      "para ver los emails que se enviarian.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    SpreadsheetApp.getUi().alert("Error:\n" + e.message);
  }
}

function menuNotificarEstudiantes_() {
  var ui   = SpreadsheetApp.getUi();
  var resp = ui.alert(
    "SIDEP — Notificar estudiantes",
    "Envia un email a cada estudiante con EnrollmentStatusCode = ACTIVE\n" +
    "con su programa, cohorte, asignaturas, horarios y links de acceso a las aulas.\n\n" +
    "Este correo se envia automaticamente al procesar matriculas.\n" +
    "Usa esta opcion solo para reenvios manuales.\n\n" +
    "Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    notificarEstudiantes();
    ui.alert("Notificaciones enviadas.\nRevisa el Logger para el detalle.", ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// NOTIFICACIONES FILTRADAS (v1.1.0)
// ════════════════════════════════════════════════════════════

function menuNotificarEstudiantesPorVentana_() {
  var ui = SpreadsheetApp.getUi();

  var respWin = ui.prompt(
    "Notificar por ventana",
    "Codigo de ventana (ej. MR26, MY26):",
    ui.ButtonSet.OK_CANCEL
  );
  if (respWin.getSelectedButton() !== ui.Button.OK) return;
  var win = respWin.getResponseText().trim().toUpperCase();
  if (!win) { ui.alert("Ventana vacia — operacion cancelada."); return; }

  var respMom = ui.prompt(
    "Notificar por ventana",
    "Codigo de momento (ej. C1M2, A1B1) — opcional, vacio = todos:",
    ui.ButtonSet.OK_CANCEL
  );
  if (respMom.getSelectedButton() !== ui.Button.OK) return;
  var mom = respMom.getResponseText().trim().toUpperCase();

  var conf = ui.alert(
    "Confirmar",
    "Enviar correo a estudiantes con matriculas ACTIVE en ventana " + win +
    (mom ? " / momento " + mom : " (todos los momentos)") + "?",
    ui.ButtonSet.YES_NO
  );
  if (conf !== ui.Button.YES) return;

  try {
    var opts = { windowCohortCode: win };
    if (mom) opts.momentCode = mom;
    notificarEstudiantes(opts);
    ui.alert("Notificaciones enviadas. Revisa el Logger para el detalle.");
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


function menuNotificarUltimoLote_() {
  var ui = SpreadsheetApp.getUi();

  // Lee STG_MATRICULAS y busca filas PROMOTED en los ultimos 60 minutos
  var mem;
  try {
    mem = leerStgMatriculas();
  } catch (e) {
    ui.alert("Error al leer STG_MATRICULAS:\n" + e.message);
    return;
  }

  var iStage  = mem.idx["StageStatus"];
  var iProcAt = mem.idx["ProcessedAt"];
  var iWin    = mem.idx["CohortCode"];
  var iMom    = mem.idx["MomentCode"];

  var ahora  = new Date();
  var combos = {};

  mem.datos.forEach(function(row) {
    if (String(row[iStage] || "").trim() !== "PROMOTED") return;
    var procAt = row[iProcAt];
    if (typeof procAt === "string") {
      try { procAt = new Date(procAt); } catch (e) { return; }
    }
    if (!(procAt instanceof Date) || isNaN(procAt.getTime())) return;
    if ((ahora - procAt) > 60 * 60 * 1000) return;
    var win = String(row[iWin] || "").trim().toUpperCase();
    var mom = String(row[iMom] || "").trim().toUpperCase();
    if (!win || !mom) return;
    combos[win + "|" + mom] = { windowCohortCode: win, momentCode: mom };
  });

  var lista = Object.keys(combos).map(function(k) { return combos[k]; });

  if (lista.length === 0) {
    ui.alert("No se encontro lote procesado en los ultimos 60 minutos.");
    return;
  }

  var resumen = lista.map(function(c) {
    return c.windowCohortCode + "/" + c.momentCode;
  }).join(", ");

  var conf = ui.alert(
    "Confirmar",
    "Re-enviar notificacion para combos: " + resumen + "?",
    ui.ButtonSet.YES_NO
  );
  if (conf !== ui.Button.YES) return;

  lista.forEach(function(c) {
    try {
      notificarEstudiantes({
        windowCohortCode: c.windowCohortCode,
        momentCode      : c.momentCode
      });
    } catch (e) {
      Logger.log("Error en combo " + c.windowCohortCode + "/" +
                 c.momentCode + ": " + e.message);
    }
  });

  ui.alert("Re-envio completado. Revisa el Logger para el detalle.");
}


// ════════════════════════════════════════════════════════════
// CIERRE DE COHORTE (v1.1.0)
// ════════════════════════════════════════════════════════════

function menuDiagnosticoCierre_() {
  var ui = SpreadsheetApp.getUi();

  var resp = ui.prompt(
    "Diagnostico de cierre",
    "Codigo de ventana (ej. MR26):",
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var win = resp.getResponseText().trim().toUpperCase();
  if (!win) return;

  try {
    diagnosticoCierreCohorte(win);
    ui.alert("Diagnostico completado. Revisa el Logger (Extensiones -> Apps Script -> Registros).");
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


function menuCerrarCohorteAcademico_() {
  var ui = SpreadsheetApp.getUi();

  var respWin = ui.prompt(
    "Cerrar cohorte academico",
    "Codigo de ventana a cerrar (ej. MR26):",
    ui.ButtonSet.OK_CANCEL
  );
  if (respWin.getSelectedButton() !== ui.Button.OK) return;
  var win = respWin.getResponseText().trim().toUpperCase();
  if (!win) return;

  var respMom = ui.prompt(
    "Cerrar cohorte academico",
    "Codigo de momento (opcional, vacio = todos los momentos):",
    ui.ButtonSet.OK_CANCEL
  );
  if (respMom.getSelectedButton() !== ui.Button.OK) return;
  var mom = respMom.getResponseText().trim().toUpperCase();

  // DRY-RUN OBLIGATORIO primero — el coordinador debe ver el preview antes del cierre real
  try {
    cerrarCohorteAcademico(win, { dryRun: true, momentCode: mom || null });
  } catch (e) {
    ui.alert("Error en dry-run:\n" + e.message);
    return;
  }

  var conf = ui.alert(
    "Confirmar cierre academico",
    "Se ejecuto el DRY-RUN. Revisa el Logger para ver las matriculas afectadas.\n\n" +
    "Proceder con el cierre REAL de ventana " + win +
    (mom ? " / momento " + mom : " (todos los momentos)") + "?\n\n" +
    "Accion: ACTIVE → IN_GRADING\n" +
    "Reversible: usa 'Reabrir cohorte academico' si necesitas deshacer.",
    ui.ButtonSet.YES_NO
  );
  if (conf !== ui.Button.YES) return;

  try {
    cerrarCohorteAcademico(win, { momentCode: mom || null });
    ui.alert(
      "Cierre academico completado.\n" +
      "Revisa el Logger y STG_ESTUDIANTES_LOG para el detalle.\n\n" +
      "Las aulas Classroom siguen abiertas para que los docentes carguen notas."
    );
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


function menuReabrirCohorteAcademico_() {
  var ui = SpreadsheetApp.getUi();

  var respWin = ui.prompt(
    "Reabrir cohorte academico (rollback)",
    "Codigo de ventana a reabrir (ej. MR26):",
    ui.ButtonSet.OK_CANCEL
  );
  if (respWin.getSelectedButton() !== ui.Button.OK) return;
  var win = respWin.getResponseText().trim().toUpperCase();
  if (!win) return;

  var conf = ui.alert(
    "Confirmar rollback",
    "Reabrir matriculas IN_GRADING → ACTIVE para ventana " + win + "?\n\n" +
    "Esta accion revierte el cierre academico. Usa solo si el cierre fue un error.",
    ui.ButtonSet.YES_NO
  );
  if (conf !== ui.Button.YES) return;

  try {
    reabrirCohorteAcademico(win);
    ui.alert("Rollback completado. Revisa el Logger para el detalle.");
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// DIAGNOSTICO
// ════════════════════════════════════════════════════════════

function menuVerMatriculas_() {
  try {
    var mem     = leerStgMatriculas();
    var iStatus = mem.idx["StageStatus"];
    var iEmail  = mem.idx["StudentEmail"];
    var iProg   = mem.idx["ProgramCode"];
    var iSubj   = mem.idx["SubjectCode"];
    var cuentas = { PROMOTED: [], ERROR: [], PENDING: [], VALIDATED: [], OTROS: [] };

    mem.datos.forEach(function(row) {
      var st    = String(row[iStatus] || "").trim() || "OTROS";
      var linea = String(row[iEmail] || "") + " -> " +
                  String(row[iProg]  || "") + "-" + String(row[iSubj] || "");
      if (cuentas[st]) cuentas[st].push(linea);
      else             cuentas["OTROS"].push(linea);
    });

    var lineas = [
      "STG_MATRICULAS — Estado",
      "",
      "PROMOTED  (" + cuentas.PROMOTED.length  + "): procesadas correctamente",
      "PENDING   (" + cuentas.PENDING.length   + "): pendientes de aprobar",
      "VALIDATED (" + cuentas.VALIDATED.length + "): en proceso",
      "ERROR     (" + cuentas.ERROR.length     + "): fallaron — revisar STG_ESTUDIANTES_LOG"
    ];

    if (cuentas.ERROR.length > 0) {
      lineas.push("", "Con ERROR:");
      cuentas.ERROR.forEach(function(l) { lineas.push("  " + l); });
    }

    SpreadsheetApp.getUi().alert(lineas.join("\n"), SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    SpreadsheetApp.getUi().alert("Error:\n" + e.message);
  }
}

function menuDiagnosticoStagingEst_() {
  try {
    var memEst  = leerStgEstudiantes();
    var memMat  = leerStgMatriculas();
    var memLog  = getTableData("stagingEstudiantes", "STG_ESTUDIANTES_LOG");

    var contarStatus = function(rows, idx) {
      var c = {};
      rows.forEach(function(r) {
        var v = String(r[idx["StageStatus"]] || "VACIO").trim();
        c[v] = (c[v] || 0) + 1;
      });
      return Object.keys(c).sort().map(function(k) { return "  " + k + ": " + c[k]; }).join("\n");
    };

    // Estado de matrículas en Enrollments
    var adminSS = getSpreadsheetByName("admin");
    var hojaEnr = adminSS.getSheetByName("Enrollments");
    var enrResumen = "";
    if (hojaEnr && hojaEnr.getLastRow() > 1) {
      var enc   = hojaEnr.getRange(1, 1, 1, hojaEnr.getLastColumn()).getValues()[0];
      var iSt   = enc.indexOf("EnrollmentStatusCode");
      var datos = hojaEnr.getRange(2, 1, hojaEnr.getLastRow() - 1,
                                   hojaEnr.getLastColumn()).getValues();
      var porSt = {};
      datos.forEach(function(f) {
        var st = String(f[iSt] || "SIN_STATUS").trim();
        porSt[st] = (porSt[st] || 0) + 1;
      });
      enrResumen = "\nEnrollments — EnrollmentStatusCode:\n" +
        Object.keys(porSt).sort().map(function(k) { return "  " + k + ": " + porSt[k]; }).join("\n");
    }

    var msg = [
      "STG_ESTUDIANTES (" + memEst.datos.length + " filas)",
      contarStatus(memEst.datos, memEst.idx),
      "",
      "STG_MATRICULAS (" + memMat.datos.length + " filas)",
      contarStatus(memMat.datos, memMat.idx),
      enrResumen,
      "",
      "STG_ESTUDIANTES_LOG: " + memLog.datos.length + " entradas"
    ].join("\n");

    SpreadsheetApp.getUi().alert("SIDEP — Diagnostico Estudiantes", msg,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    SpreadsheetApp.getUi().alert("Error:\n" + e.message);
  }
}
