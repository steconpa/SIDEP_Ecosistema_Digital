/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 52_menu_staging_docentes.gs
 * Versión: 3.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Menú y trigger onOpen para SIDEP_STG_DOCENTES.
 *
 * MENÚ (en orden de ejecución):
 *
 *   — PREPARACION —
 *   ├── 🔄 Actualizar listados (dropdowns)
 *
 *   — REGISTRO DE DOCENTES —
 *   ├── ✅ Validar docentes (sin escribir)
 *   ├── 👤 Procesar solicitudes de docentes
 *
 *   — ASIGNACIONES A AULAS —
 *   ├── ✅ Validar asignaciones (sin escribir)
 *   ├── 🏫 Procesar asignaciones a aulas
 *
 *   — SEGUIMIENTO DE INVITACIONES —
 *   ├── 🔁 Sincronizar invitaciones (verificar aceptación)
 *   ├── ⏰ Activar sincronización diaria (trigger)
 *   ├── ⏹  Desactivar sincronización diaria
 *
 *   — NOTIFICACIONES —
 *   ├── 📧 Notificar docentes (preview)
 *   ├── 📧 Notificar docentes (enviar)
 *
 *   — DIAGNÓSTICO —
 *   ├── 📋 Ver estado de invitaciones (staging)
 *   └── 🔍 Diagnóstico completo
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs            → SIDEP_CONFIG.files.stagingDocentes
 *   42_job_procesarStgDocentes.gs → procesarStgDocentes(), procesarStgAsignaciones()
 *   24b_repo_staging_academico.gs → leerStgAsignaciones(), getTableData()
 *   16b_notificarDocentes.gs      → notificarDocentes()
 *   16b_sincronizarDocentes.gs    → sincronizarInvitaciones(), configurarTriggerDiario(),
 *                                   eliminarTriggerDiario(), diagnosticoInvitaciones()
 * ============================================================
 */

function stagingDocentesOnOpen(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || ss.getName() !== SIDEP_CONFIG.files.stagingDocentes) return;

  SpreadsheetApp.getUi()
    .createMenu("SIDEP Docentes")

    // — PREPARACION —
    .addItem("🔄 Actualizar listados (dropdowns)",       "menuActualizarListados_")
    .addSeparator()

    // — REGISTRO DE DOCENTES —
    .addItem("✅ Validar docentes (sin escribir)",        "menuValidarDocentes_")
    .addItem("👤 Procesar solicitudes de docentes",       "menuProcesarDocentes_")
    .addSeparator()

    // — ASIGNACIONES A AULAS —
    .addItem("✅ Validar asignaciones (sin escribir)",    "menuValidarAsignaciones_")
    .addItem("🏫 Procesar asignaciones a aulas",          "menuProcesarAsignaciones_")
    .addSeparator()

    // — SEGUIMIENTO DE INVITACIONES —
    .addItem("🔁 Sincronizar invitaciones",               "menuSincronizarInvitaciones_")
    .addItem("⏰ Activar sincronización diaria",           "menuActivarTriggerDiario_")
    .addItem("⏹  Desactivar sincronización diaria",       "menuDesactivarTriggerDiario_")
    .addSeparator()

    // — NOTIFICACIONES —
    .addItem("📧 Notificar docentes (preview)",           "menuNotificarDocentes_dryRun_")
    .addItem("📧 Notificar docentes (enviar)",            "menuNotificarDocentes_")
    .addSeparator()

    // — DIAGNÓSTICO —
    .addItem("📋 Ver estado de invitaciones (staging)",   "menuVerInvitaciones_")
    .addItem("🔍 Diagnóstico completo",                   "menuDiagnosticoStaging_")

    .addToUi();
}


// ── Instalación del trigger onOpen ────────────────────────────

function instalarTriggerStagingDocentes_(ss) {
  const targetId = ss.getId();
  const existe   = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === "stagingDocentesOnOpen" &&
           t.getTriggerSourceId && t.getTriggerSourceId() === targetId;
  });
  if (!existe) {
    ScriptApp.newTrigger("stagingDocentesOnOpen")
      .forSpreadsheet(ss)
      .onOpen()
      .create();
    Logger.log("  ✔  Trigger stagingDocentesOnOpen instalado");
  } else {
    Logger.log("  ⏭  Trigger stagingDocentesOnOpen ya existe");
  }
}


// ════════════════════════════════════════════════════════════
// PREPARACION
// ════════════════════════════════════════════════════════════

function menuActualizarListados_() {
  const ui = SpreadsheetApp.getUi();
  try {
    const ss = getSpreadsheetByName("stagingDocentes");
    aplicarDropdownsCatalogo(ss, STAGING_ACADEMICO_TABLES);
    ui.alert(
      "Listados actualizados.\n\n" +
      "Los dropdowns de TeacherEmail, ProgramCode, SubjectCode, CohortCode\n" +
      "y MomentCode ahora reflejan los datos actuales de las tablas maestras.\n\n" +
      "Ejecuta esta opcion cada vez que registres nuevos docentes o cambies catalogo.",
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert("Error al actualizar listados:\n" + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// REGISTRO DE DOCENTES
// ════════════════════════════════════════════════════════════

function menuValidarDocentes_() {
  try {
    procesarStgDocentes({ dryRun: true });
    SpreadsheetApp.getUi().alert(
      "Validacion OK — sin errores.\n" +
      "Revisa el Logger (Extensiones -> Apps Script -> Registros) para el detalle.\n\n" +
      "Puedes continuar con 'Procesar solicitudes de docentes'.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    SpreadsheetApp.getUi().alert("Validacion fallida:\n" + e.message);
  }
}

function menuProcesarDocentes_() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert(
    "SIDEP — Procesar solicitudes de docentes",
    "Procesa todas las filas de STG_DOCENTES con:\n" +
    "  ApprovalStatus = APPROVED\n" +
    "  StageStatus    = PENDING (o vacio)\n\n" +
    "Acciones:\n" +
    "  REGISTER   -> crea el docente en la tabla maestra Teachers\n" +
    "  UPDATE     -> actualiza sus datos en Teachers\n" +
    "  DEACTIVATE -> marca al docente como inactivo\n\n" +
    "Tip: ejecuta 'Actualizar listados' despues para que el\n" +
    "nuevo docente aparezca en el dropdown de STG_ASIGNACIONES.\n\n" +
    "Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    procesarStgDocentes();
    ui.alert("Proceso completado.\nRevisa STG_DOCENTES_LOG para el detalle.", ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// ASIGNACIONES A AULAS
// ════════════════════════════════════════════════════════════

function menuValidarAsignaciones_() {
  try {
    procesarStgAsignaciones({ dryRun: true });
    SpreadsheetApp.getUi().alert(
      "Validacion OK — sin errores.\n" +
      "Revisa el Logger para el detalle.\n\n" +
      "Puedes continuar con 'Procesar asignaciones a aulas'.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    SpreadsheetApp.getUi().alert("Validacion fallida:\n" + e.message);
  }
}

function menuProcesarAsignaciones_() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert(
    "SIDEP — Procesar asignaciones a aulas",
    "Procesa todas las filas de STG_ASIGNACIONES con:\n" +
    "  ApprovalStatus = APPROVED\n" +
    "  StageStatus    = PENDING (o vacio)\n\n" +
    "Acciones:\n" +
    "  ASSIGN -> inserta en TeacherAssignments + envia invitacion Classroom\n" +
    "  REMOVE -> remueve al docente del aula\n\n" +
    "Al finalizar envia automaticamente el correo de horario\n" +
    "a cada docente con invitacion nueva.\n\n" +
    "El docente debe aceptar la invitacion de Classroom por email.\n\n" +
    "Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    procesarStgAsignaciones();
    ui.alert("Proceso completado.\nRevisa STG_DOCENTES_LOG para el detalle.", ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// SEGUIMIENTO DE INVITACIONES
// ════════════════════════════════════════════════════════════

function menuSincronizarInvitaciones_() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert(
    "SIDEP — Sincronizar invitaciones de Classroom",
    "Verifica via Classroom API si cada docente con\n" +
    "InvitationStatus = TEACHER_INVITED ya respondio:\n\n" +
    "  Invitacion consumida + docente en el aula  -> TEACHER_ACCEPTED\n" +
    "  Invitacion consumida + no esta en el aula  -> TEACHER_DECLINED\n" +
    "  Invitacion aun activa                      -> sigue TEACHER_INVITED\n\n" +
    "Actualiza TeacherAssignments: IsActive = true para aceptados.\n\n" +
    "Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    sincronizarInvitaciones();
    ui.alert("Sincronizacion completada.\nRevisa el Logger para el detalle.", ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}

function menuActivarTriggerDiario_() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert(
    "SIDEP — Activar sincronizacion diaria",
    "Instala un trigger automatico que ejecuta\n" +
    "'Sincronizar invitaciones' todos los dias a las 7 AM.\n\n" +
    "Util mientras haya docentes con TEACHER_INVITED pendientes.\n" +
    "Desactivalo cuando todos hayan aceptado.\n\n" +
    "Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    configurarTriggerDiario();
    ui.alert(
      "Trigger diario activado.\n" +
      "'Sincronizar invitaciones' se ejecutara cada dia a las 7 AM (Bogota).\n\n" +
      "Desactivalo con 'Desactivar sincronizacion diaria' cuando todos\n" +
      "los docentes hayan aceptado la invitacion.",
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}

function menuDesactivarTriggerDiario_() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert(
    "SIDEP — Desactivar sincronizacion diaria",
    "Elimina el trigger automatico de sincronizacion.\n\n" +
    "Hazlo solo cuando todos los docentes hayan aceptado\n" +
    "la invitacion (InvitationStatus = TEACHER_ACCEPTED).\n\n" +
    "Puedes verificar el estado con 'Diagnostico completo'.\n\n" +
    "Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    eliminarTriggerDiario();
    ui.alert("Trigger diario desactivado.", ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// NOTIFICACIONES
// ════════════════════════════════════════════════════════════

function menuNotificarDocentes_dryRun_() {
  try {
    notificarDocentes({ dryRun: true });
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

function menuNotificarDocentes_() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert(
    "SIDEP — Notificar docentes",
    "Envia un email a cada docente con InvitationStatus = TEACHER_INVITED\n" +
    "con su horario completo y links directos a sus aulas.\n\n" +
    "Este correo se envia automaticamente al procesar asignaciones.\n" +
    "Usa esta opcion solo para reenvios manuales.\n\n" +
    "Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    notificarDocentes();
    ui.alert("Notificaciones enviadas.\nRevisa el Logger para el detalle.", ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("Error:\n" + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// DIAGNOSTICO
// ════════════════════════════════════════════════════════════

function menuVerInvitaciones_() {
  try {
    const mem     = leerStgAsignaciones();
    const iStatus = mem.idx["StageStatus"];
    const iEmail  = mem.idx["TeacherEmail"];
    const iProg   = mem.idx["ProgramCode"];
    const iSubj   = mem.idx["SubjectCode"];
    const cuentas = { PROMOTED: [], ERROR: [], PENDING: [], VALIDATED: [], OTROS: [] };

    mem.datos.forEach(function(row) {
      const st    = String(row[iStatus] || "").trim() || "OTROS";
      const linea = String(row[iEmail] || "") + " -> " +
                    String(row[iProg]  || "") + "-" + String(row[iSubj] || "");
      if (cuentas[st]) cuentas[st].push(linea);
      else             cuentas["OTROS"].push(linea);
    });

    const lineas = [
      "STG_ASIGNACIONES — Estado",
      "",
      "PROMOTED  (" + cuentas.PROMOTED.length  + "): procesadas correctamente",
      "PENDING   (" + cuentas.PENDING.length   + "): pendientes de aprobar",
      "VALIDATED (" + cuentas.VALIDATED.length + "): en proceso",
      "ERROR     (" + cuentas.ERROR.length     + "): fallaron — revisar STG_DOCENTES_LOG"
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

function menuDiagnosticoStaging_() {
  try {
    const memDoc  = leerStgDocentes();
    const memAsig = leerStgAsignaciones();
    const memLog  = getTableData("stagingDocentes", "STG_DOCENTES_LOG");

    const contarStatus = function(rows, idx) {
      const c = {};
      rows.forEach(function(r) {
        const v = String(r[idx["StageStatus"]] || "VACIO").trim();
        c[v] = (c[v] || 0) + 1;
      });
      return Object.keys(c).sort().map(function(k) { return "  " + k + ": " + c[k]; }).join("\n");
    };

    // Estado de invitaciones en TeacherAssignments
    const adminSS    = getSpreadsheetByName("admin");
    const hojaAsig   = adminSS.getSheetByName("TeacherAssignments");
    let   invResumen = "";
    if (hojaAsig && hojaAsig.getLastRow() > 1) {
      const enc     = hojaAsig.getRange(1, 1, 1, hojaAsig.getLastColumn()).getValues()[0];
      const iInvSt  = enc.indexOf("InvitationStatus");
      const datos   = hojaAsig.getRange(2, 1, hojaAsig.getLastRow() - 1,
                                        hojaAsig.getLastColumn()).getValues();
      const porSt   = {};
      datos.forEach(function(f) {
        const st = String(f[iInvSt] || "SIN_STATUS").trim();
        porSt[st] = (porSt[st] || 0) + 1;
      });
      invResumen = "\nTeacherAssignments — InvitationStatus:\n" +
        Object.keys(porSt).sort().map(function(k) { return "  " + k + ": " + porSt[k]; }).join("\n");
    }

    // Trigger diario
    const triggerActivo = ScriptApp.getProjectTriggers().some(function(t) {
      return t.getHandlerFunction() === "sincronizarInvitaciones";
    });

    const msg = [
      "STG_DOCENTES (" + memDoc.datos.length + " filas)",
      contarStatus(memDoc.datos, memDoc.idx),
      "",
      "STG_ASIGNACIONES (" + memAsig.datos.length + " filas)",
      contarStatus(memAsig.datos, memAsig.idx),
      invResumen,
      "",
      "STG_DOCENTES_LOG: " + memLog.datos.length + " entradas",
      "Trigger sincronizacion diaria: " + (triggerActivo ? "ACTIVO (7 AM)" : "inactivo")
    ].join("\n");

    SpreadsheetApp.getUi().alert("SIDEP — Diagnostico Docentes", msg,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    SpreadsheetApp.getUi().alert("Error:\n" + e.message);
  }
}
