/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 52_menu_staging_docentes.gs
 * Versión: 2.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Menú y trigger onOpen para SIDEP_STG_DOCENTES.
 *
 * MENÚ:
 *   SIDEP Docentes
 *   ├── 👤 Procesar solicitudes de docentes   → procesarStgDocentes()
 *   ├── 🏫 Procesar asignaciones a aulas      → procesarStgAsignaciones()
 *   ├── ─────────────────────────
 *   ├── ✅ Validar docentes (dry-run)
 *   ├── ✅ Validar asignaciones (dry-run)
 *   ├── ─────────────────────────
 *   ├── 📋 Ver estado de invitaciones
 *   └── 🔍 Diagnóstico staging
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs            → SIDEP_CONFIG.files.stagingDocentes
 *   42_job_procesarStgDocentes.gs → procesarStgDocentes(), procesarStgAsignaciones()
 *   24b_repo_staging_academico.gs → leerStgAsignaciones(), getTableData()
 * ============================================================
 */

function stagingDocentesOnOpen(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || ss.getName() !== SIDEP_CONFIG.files.stagingDocentes) return;

  SpreadsheetApp.getUi()
    .createMenu("SIDEP Docentes")
    .addItem("👤 Procesar solicitudes de docentes",  "menuProcesarDocentes_")
    .addItem("🏫 Procesar asignaciones a aulas",     "menuProcesarAsignaciones_")
    .addSeparator()
    .addItem("✅ Validar docentes (sin escribir)",   "menuValidarDocentes_")
    .addItem("✅ Validar asignaciones (sin escribir)","menuValidarAsignaciones_")
    .addSeparator()
    .addItem("📋 Ver estado de invitaciones",        "menuVerInvitaciones_")
    .addItem("🔍 Diagnóstico staging",               "menuDiagnosticoStaging_")
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

function menuProcesarDocentes_() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert(
    "SIDEP — Procesar solicitudes de docentes",
    "Procesa todas las filas de STG_DOCENTES con:\n" +
    "  ApprovalStatus = APPROVED\n" +
    "  StageStatus    = PENDING\n\n" +
    "Acciones:\n" +
    "  REGISTER   → crea el docente en la tabla maestra Teachers\n" +
    "  UPDATE     → actualiza sus datos en Teachers\n" +
    "  DEACTIVATE → marca al docente como inactivo\n\n" +
    "¿Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    procesarStgDocentes();
    ui.alert("✅ Proceso completado.\nRevisa STG_DOCENTES_LOG para el detalle.", ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("❌ Error:\n" + e.message);
  }
}

function menuProcesarAsignaciones_() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert(
    "SIDEP — Procesar asignaciones a aulas",
    "Procesa todas las filas de STG_ASIGNACIONES con:\n" +
    "  ApprovalStatus = APPROVED\n" +
    "  StageStatus    = PENDING\n\n" +
    "Acciones:\n" +
    "  ASSIGN → crea la asignación y envía invitación al aula vía Classroom\n" +
    "  REMOVE → remueve al docente del aula\n\n" +
    "⚠️  El docente debe aceptar la invitación por email.\n\n" +
    "¿Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    procesarStgAsignaciones();
    ui.alert("✅ Proceso completado.\nRevisa STG_DOCENTES_LOG para el detalle.", ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("❌ Error:\n" + e.message);
  }
}

function menuValidarDocentes_() {
  try {
    procesarStgDocentes({ dryRun: true });
    SpreadsheetApp.getUi().alert(
      "✅ Validación OK — sin errores.\nRevisa el Logger (Ver → Registros) para el detalle.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    SpreadsheetApp.getUi().alert("❌ Validación fallida:\n" + e.message);
  }
}

function menuValidarAsignaciones_() {
  try {
    procesarStgAsignaciones({ dryRun: true });
    SpreadsheetApp.getUi().alert(
      "✅ Validación OK — sin errores.\nRevisa el Logger (Ver → Registros) para el detalle.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    SpreadsheetApp.getUi().alert("❌ Validación fallida:\n" + e.message);
  }
}

function menuVerInvitaciones_() {
  try {
    const mem        = leerStgAsignaciones();
    const iStatus    = mem.idx["StageStatus"];
    const iEmail     = mem.idx["TeacherEmail"];
    const iProg      = mem.idx["ProgramCode"];
    const iSubj      = mem.idx["SubjectCode"];
    const cuentas    = { PROMOTED: [], ERROR: [], PENDING: [], VALIDATED: [], OTROS: [] };

    mem.datos.forEach(function(row) {
      const st    = String(row[iStatus] || "").trim() || "OTROS";
      const linea = String(row[iEmail] || "") + " → " +
                    String(row[iProg]  || "") + "-" + String(row[iSubj] || "");
      if (cuentas[st]) cuentas[st].push(linea);
      else             cuentas["OTROS"].push(linea);
    });

    const lineas = [
      "STG_ASIGNACIONES — Estado de invitaciones",
      "",
      "PROMOTED  (" + cuentas.PROMOTED.length  + "): enviadas y aceptadas o procesadas",
      "PENDING   (" + cuentas.PENDING.length   + "): pendientes de aprobar",
      "VALIDATED (" + cuentas.VALIDATED.length + "): aprobadas, en proceso",
      "ERROR     (" + cuentas.ERROR.length     + "): fallaron — revisar STG_DOCENTES_LOG"
    ];

    if (cuentas.ERROR.length > 0) {
      lineas.push("", "Con ERROR:");
      cuentas.ERROR.forEach(function(l) { lineas.push("  " + l); });
    }

    SpreadsheetApp.getUi().alert(lineas.join("\n"), SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    SpreadsheetApp.getUi().alert("❌ Error:\n" + e.message);
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
        const v = String(r[idx["StageStatus"]] || "VACÍO").trim();
        c[v] = (c[v] || 0) + 1;
      });
      return Object.keys(c).sort().map(function(k) { return "  " + k + ": " + c[k]; }).join("\n");
    };

    const msg = [
      "STG_DOCENTES (" + memDoc.datos.length + " filas)",
      contarStatus(memDoc.datos, memDoc.idx),
      "",
      "STG_ASIGNACIONES (" + memAsig.datos.length + " filas)",
      contarStatus(memAsig.datos, memAsig.idx),
      "",
      "STG_DOCENTES_LOG: " + memLog.datos.length + " entradas"
    ].join("\n");

    SpreadsheetApp.getUi().alert("SIDEP — Diagnóstico Staging Docentes", msg,
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    SpreadsheetApp.getUi().alert("❌ Error:\n" + e.message);
  }
}
