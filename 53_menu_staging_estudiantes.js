/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 53_menu_staging_estudiantes.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Menú y trigger onOpen para SIDEP_STG_ESTUDIANTES.
 *
 * MENÚ (en orden de ejecución):
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
 *
 *   — NOTIFICACIONES —
 *   ├── Notificar estudiantes (preview)
 *   ├── Notificar estudiantes (enviar)
 *
 *   — DIAGNOSTICO —
 *   ├── Ver estado de matriculas (staging)
 *   └── Diagnostico completo
 *
 * DEPENDE DE:
 *   43_job_procesarStgEstudiantes.gs → procesarStgEstudiantes(), procesarStgMatriculas()
 *   24c_repo_staging_estudiantes.gs  → leerStgEstudiantes(), leerStgMatriculas()
 *   18b_notificarEstudiantes.gs      → notificarEstudiantes()
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
    .addItem("Notificar estudiantes (preview)",           "menuNotificarEstudiantes_dryRun_")
    .addItem("Notificar estudiantes (enviar)",            "menuNotificarEstudiantes_")
    .addSeparator()

    // — DIAGNOSTICO —
    .addItem("Ver estado de matriculas (staging)",        "menuVerMatriculas_")
    .addItem("Diagnostico completo",                      "menuDiagnosticoStagingEst_")

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
