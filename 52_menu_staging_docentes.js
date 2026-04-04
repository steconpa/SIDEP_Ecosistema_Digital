/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 52_menu_staging_docentes.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Menú y trigger de apertura para SIDEP_STG_DOCENTES.
 *   Expone al equipo SIDEP las operaciones de carga de docentes.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs            → SIDEP_CONFIG.files.stagingDocentes
 *   42_job_procesarStgDocentes.gs → procesarStgDocentes()
 *   19_setupStagingSheets.gs      → instalarTriggerStagingDocentes_()
 * ============================================================
 */

function stagingDocentesOnOpen(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || ss.getName() !== SIDEP_CONFIG.files.stagingDocentes) return;

  SpreadsheetApp.getUi()
    .createMenu("SIDEP Docentes")
    .addItem("✅ Validar lote (sin escribir)",  "menuValidarDocentes_")
    .addItem("🚀 Importar lote APPROVED",       "menuImportarDocentes_")
    .addSeparator()
    .addItem("📋 Ver estado de invitaciones",   "menuVerInvitaciones_")
    .addSeparator()
    .addItem("🔍 Diagnóstico staging",          "menuDiagnosticoStaging_")
    .addToUi();
}


// ── Instalación del trigger ───────────────────────────────────

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


// ── Items de menú ─────────────────────────────────────────────

/** Valida el lote sin promover ni escribir en maestras. */
function menuValidarDocentes_() {
  try {
    procesarStgDocentes({ dryRun: true });
    SpreadsheetApp.getUi().alert(
      "SIDEP — Validación",
      "Validación completada. Revisa el Logger (Ver → Registros) para el detalle.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    SpreadsheetApp.getUi().alert("Error en validación:\n" + e.message);
  }
}

/**
 * Importa el lote: promueve todas las filas con ApprovalStatus=APPROVED
 * y StageStatus=PENDING a las tablas maestras.
 */
function menuImportarDocentes_() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert(
    "SIDEP — Importar docentes",
    "¿Importar todas las filas APPROVED/PENDING a las tablas maestras?\n\n" +
    "Esta acción NO se puede deshacer.\n" +
    "Los docentes recibirán una invitación por email para aceptar.",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  try {
    procesarStgDocentes();
    ui.alert(
      "SIDEP — Importación completada",
      "Proceso finalizado. Revisa el Logger (Ver → Registros) y la hoja " +
      "STG_DOCENTES_LOG para el detalle.",
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert("Error en importación:\n" + e.message);
  }
}

/**
 * Muestra un resumen del estado de invitaciones pendientes
 * leyendo STG_ASIGNACIONES con StageStatus=PROMOTED.
 */
function menuVerInvitaciones_() {
  try {
    const mem = leerStgAsignaciones({ stageStatus: "PROMOTED" });
    let invPendientes = 0;
    let invAceptadas  = 0;

    mem.datos.forEach(function(row) {
      const invStatus = String(row[mem.idx["TargetAssignmentID"]] || "").trim();
      invPendientes++;
    });

    SpreadsheetApp.getUi().alert(
      "SIDEP — Estado de invitaciones",
      "Asignaciones promovidas: " + invPendientes + "\n\n" +
      "Nota: para ver el estado detallado (TEACHER_INVITED / TEACHER_ACCEPTED),\n" +
      "consulta la hoja TeacherAssignments en SIDEP_02_GESTION_ADMIN\n" +
      "o ejecuta 16b_sincronizarDocentes().",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    SpreadsheetApp.getUi().alert("Error al leer estado:\n" + e.message);
  }
}

/** Diagnóstico básico del estado del spreadsheet de staging. */
function menuDiagnosticoStaging_() {
  try {
    const memDoc  = leerStgDocentes();
    const memAsig = leerStgAsignaciones();
    const memLog  = getTableData("stagingDocentes", "STG_DOCENTES_LOG");

    const cuentaStatus = function(rows, idx, col) {
      const cuentas = {};
      rows.forEach(function(row) {
        const v = String(row[idx[col]] || "VACÍO").trim();
        cuentas[v] = (cuentas[v] || 0) + 1;
      });
      return Object.keys(cuentas).sort().map(function(k) {
        return k + ": " + cuentas[k];
      }).join("\n  ");
    };

    const msg = [
      "STG_DOCENTES (" + memDoc.datos.length + " filas):",
      "  StageStatus:\n  " + cuentaStatus(memDoc.datos, memDoc.idx, "StageStatus"),
      "",
      "STG_ASIGNACIONES (" + memAsig.datos.length + " filas):",
      "  StageStatus:\n  " + cuentaStatus(memAsig.datos, memAsig.idx, "StageStatus"),
      "",
      "STG_DOCENTES_LOG: " + memLog.datos.length + " entradas"
    ].join("\n");

    SpreadsheetApp.getUi().alert("SIDEP — Diagnóstico Staging Docentes", msg,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    SpreadsheetApp.getUi().alert("Error en diagnóstico:\n" + e.message);
  }
}
