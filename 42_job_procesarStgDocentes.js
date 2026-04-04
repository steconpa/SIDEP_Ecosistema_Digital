/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 42_job_procesarStgDocentes.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Orquestar el procesamiento de STG_DOCENTES y STG_ASIGNACIONES.
 *   Lee staging → valida → delega al servicio → actualiza estados.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs              → SIDEP_CONFIG
 *   02_SIDEP_HELPERS.gs             → nowSIDEP(), uuid()
 *   24b_repo_staging_academico.gs   → leerStgDocentes(), leerStgAsignaciones(),
 *                                     actualizarStgDocente(), actualizarStgAsignacion(),
 *                                     registrarStgDocentesLog()
 *   32_service_docentes_staging.gs  → validarDocentesStaging(),
 *                                     validarAsignacionesStaging(),
 *                                     procesarDocentesDesdeStaging()
 *
 * FLUJO:
 *   1. Adquiere LockService (previene concurrencia)
 *   2. Lee STG_DOCENTES con ApprovalStatus=APPROVED y StageStatus=PENDING
 *   3. Lee STG_ASIGNACIONES con ApprovalStatus=APPROVED y StageStatus=PENDING
 *   4. Valida → marca StageStatus=ERROR si falla por fila
 *   5. Delega a procesarDocentesDesdeStaging() (32_service)
 *   6. Actualiza StageStatus=PROMOTED / ERROR en cada fila de staging
 *   7. Escribe en STG_DOCENTES_LOG
 *   8. Libera Lock
 *
 * USO:
 *   procesarStgDocentes()               → procesa APPROVED/PENDING
 *   procesarStgDocentes({dryRun:true})  → valida sin escribir
 * ============================================================
 */

function procesarStgDocentes(options) {
  const opts    = options || {};
  const dryRun  = opts.dryRun === true;
  const ahora   = nowSIDEP();
  const usuario = Session.getEffectiveUser().getEmail() || "script@sidep";
  const t0      = Date.now();
  let   lock    = null;

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🚀 SIDEP — procesarStgDocentes");
  Logger.log("   Modo   : " + (dryRun ? "DRY-RUN" : "EJECUTAR"));
  Logger.log("   Usuario: " + usuario);
  Logger.log("   Fecha  : " + ahora);
  Logger.log("════════════════════════════════════════════════");

  // ── Lock ──────────────────────────────────────────────────
  try {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) {
      Logger.log("⚠️  Lock ocupado — procesarStgDocentes ya está corriendo. Espera ~30s.");
      return;
    }
    Logger.log("🔐 Lock adquirido");
  } catch (eLock) {
    Logger.log("⚠️  No se pudo adquirir lock: " + eLock.message);
    return;
  }

  try {
    // ── FASE 1: Lectura de staging ─────────────────────────
    Logger.log("\n── FASE 1/4 · Lectura de staging ──");

    const memDoc  = leerStgDocentes({ stageStatus: "PENDING" });
    const memAsig = leerStgAsignaciones({ stageStatus: "PENDING" });

    // Filtrar solo las aprobadas
    const docentesAprobados    = memDoc.datos.filter(function(row) {
      return String(row[memDoc.idx["ApprovalStatus"]] || "").trim() === "APPROVED";
    });
    const asignacionesAprobadas = memAsig.datos.filter(function(row) {
      return String(row[memAsig.idx["ApprovalStatus"]] || "").trim() === "APPROVED";
    });

    Logger.log("  STG_DOCENTES    APPROVED/PENDING: " + docentesAprobados.length);
    Logger.log("  STG_ASIGNACIONES APPROVED/PENDING: " + asignacionesAprobadas.length);

    if (docentesAprobados.length === 0 && asignacionesAprobadas.length === 0) {
      Logger.log("  ℹ️  Sin filas pendientes — nada que procesar.");
      registrarStgDocentesLog({
        stageEntityType: "DOCENTE",
        stageRecordId:   "BATCH",
        action:          "PROCESS",
        result:          "SKIPPED",
        message:         "Sin filas APPROVED/PENDING."
      });
      return;
    }

    // ── FASE 2: Validación ────────────────────────────────
    Logger.log("\n── FASE 2/4 · Validación ──");

    const docentesArr    = _buildDocentesArr_(docentesAprobados, memDoc.idx);
    const asignacionesArr = _buildAsignacionesArr_(asignacionesAprobadas, memAsig.idx);

    const errValidacion = [];

    try {
      validarDocentesStaging(docentesArr);
      Logger.log("  ✅ Docentes válidos: " + docentesArr.length);
    } catch (eValDoc) {
      errValidacion.push("DOCENTES: " + eValDoc.message);
    }

    try {
      validarAsignacionesStaging(asignacionesArr);
      Logger.log("  ✅ Asignaciones válidas: " + asignacionesArr.length);
    } catch (eValAsig) {
      errValidacion.push("ASIGNACIONES: " + eValAsig.message);
    }

    if (errValidacion.length > 0) {
      const msgErr = errValidacion.join(" | ");
      Logger.log("  ❌ Validación fallida: " + msgErr);
      registrarStgDocentesLog({
        stageEntityType: "DOCENTE",
        stageRecordId:   "BATCH",
        action:          "VALIDATE",
        result:          "ERROR",
        message:         msgErr
      });
      return;
    }

    if (dryRun) {
      Logger.log("\n── DRY-RUN: validación OK — sin escritura ──");
      Logger.log("  Docentes listos para promover    : " + docentesArr.length);
      Logger.log("  Asignaciones listas para promover: " + asignacionesArr.length);
      return;
    }

    // ── FASE 3: Marcar StageStatus = VALIDATED ────────────
    Logger.log("\n── FASE 3/4 · Marcar VALIDATED ──");
    _marcarStageStatus_(docentesAprobados, memDoc.idx, "VALIDATED",
                         "actualizarStgDocente", "StageDocenteID");
    _marcarStageStatus_(asignacionesAprobadas, memAsig.idx, "VALIDATED",
                         "actualizarStgAsignacion", "StageAsignacionID");

    // ── FASE 4: Promoción ─────────────────────────────────
    Logger.log("\n── FASE 4/4 · Promoción ──");

    const resultado = procesarDocentesDesdeStaging({
      docentesRows:     docentesAprobados,
      docentesIdx:      memDoc.idx,
      asignacionesRows: asignacionesAprobadas,
      asignacionesIdx:  memAsig.idx,
      ahora:   ahora,
      usuario: usuario
    });

    // ── Actualizar StageStatus según resultado ────────────
    docentesAprobados.forEach(function(row) {
      const id         = String(row[memDoc.idx["StageDocenteID"]] || "").trim();
      const email      = String(row[memDoc.idx["Email"]]          || "").trim().toLowerCase();
      const promovido  = resultado.docentesPromovidos.indexOf(email) !== -1 ||
                         resultado.docentesPromovidos.indexOf(email.toLowerCase()) !== -1;
      const nuevoStatus = promovido ? "PROMOTED" : "ERROR";
      if (id) {
        try {
          actualizarStgDocente(id, {
            StageStatus:       nuevoStatus,
            ValidationMessage: promovido ? "" : "No promovido — revisar log",
            ProcessedAt:       ahora,
            ProcessedBy:       usuario
          });
        } catch (e) {
          Logger.log("  ⚠️  No se pudo actualizar StageDocenteID " + id + ": " + e.message);
        }
      }
    });

    asignacionesAprobadas.forEach(function(row) {
      const id        = String(row[memAsig.idx["StageAsignacionID"]] || "").trim();
      const email     = String(row[memAsig.idx["TeacherEmail"]]      || "").trim().toLowerCase();
      const prog      = String(row[memAsig.idx["ProgramCode"]]       || "").trim();
      const subj      = String(row[memAsig.idx["SubjectCode"]]       || "").trim();
      const coh       = String(row[memAsig.idx["CohortCode"]]        || "").trim();
      const mom       = String(row[memAsig.idx["MomentCode"]]        || "").trim();
      const logKey    = email + "→" + prog + "-" + subj + " [" + coh + " " + mom + "]";
      const promovida = resultado.asignacionesPromovidas &&
                        resultado.asignacionesPromovidas.some(function(p) {
                          return p.toLowerCase().indexOf(email) !== -1 &&
                                 p.indexOf(subj) !== -1;
                        });
      const nuevoStatus = promovida ? "PROMOTED" : "ERROR";
      if (id) {
        try {
          actualizarStgAsignacion(id, {
            StageStatus:       nuevoStatus,
            ValidationMessage: promovida ? "" : "No promovida — revisar log",
            ProcessedAt:       ahora,
            ProcessedBy:       usuario
          });
        } catch (e) {
          Logger.log("  ⚠️  No se pudo actualizar StageAsignacionID " + id + ": " + e.message);
        }
      }
    });

    // ── Log de batch ──────────────────────────────────────
    const duracion = ((Date.now() - t0) / 1000).toFixed(1);
    const logResult = resultado.erroresClassroom > 0 ? "PARTIAL" : "SUCCESS";
    const logMsg = [
      "Docentes: +" + resultado.teachersInsertados + " / ~" + resultado.teachersActualizados,
      "Invitaciones: " + resultado.invitacionesOk + " nuevas / " + resultado.invitacionesYaExistian + " ya existían",
      "Asignaciones: " + resultado.asignacionesEscritas,
      "Errores API: " + resultado.erroresClassroom,
      "Omitidas: " + resultado.aulasOmitidas,
      duracion + "s"
    ].join(" | ");

    registrarStgDocentesLog({
      stageEntityType: "DOCENTE",
      stageRecordId:   "BATCH",
      action:          "PROMOTE",
      result:          logResult,
      message:         logMsg
    });

    Logger.log("\n════════════════════════════════════════════════");
    Logger.log("✅ procesarStgDocentes completado en " + duracion + "s");
    Logger.log("   " + logMsg);
    Logger.log("   ⚠️  Los docentes deben ACEPTAR la invitación por email.");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("\n❌ ERROR FATAL: " + e.message);
    try {
      registrarStgDocentesLog({
        stageEntityType: "DOCENTE",
        stageRecordId:   "BATCH",
        action:          "PROCESS",
        result:          "ERROR",
        message:         e.message
      });
    } catch (eLog) {
      Logger.log("⚠️  No se pudo escribir log: " + eLog.message);
    }
    throw e;

  } finally {
    if (lock) {
      lock.releaseLock();
      Logger.log("🔓 Lock liberado");
    }
  }
}


// ── Helpers privados del job ──────────────────────────────────

function _buildDocentesArr_(rows, idx) {
  return rows.map(function(row) {
    return [
      String(row[idx["FirstName"]]      || "").trim(),
      String(row[idx["LastName"]]       || "").trim(),
      String(row[idx["Email"]]          || "").trim(),
      String(row[idx["Phone"]]          || "").trim(),
      String(row[idx["DocumentType"]]   || "").trim(),
      String(row[idx["DocumentNumber"]] || "").trim(),
      row[idx["HireDate"]]   || "",
      String(row[idx["ContractType"]]   || "").trim(),
      String(row[idx["Notes"]]          || "").trim()
    ];
  });
}

function _buildAsignacionesArr_(rows, idx) {
  return rows.map(function(row) {
    return [
      String(row[idx["TeacherEmail"]]  || "").trim(),
      String(row[idx["ProgramCode"]]   || "").trim(),
      String(row[idx["SubjectCode"]]   || "").trim(),
      String(row[idx["CohortCode"]]    || "").trim(),
      String(row[idx["MomentCode"]]    || "").trim(),
      Number(row[idx["WeeklyHours"]]   || 0),
      row[idx["StartDate"]]            || "",
      row[idx["EndDate"]]              || ""
    ];
  });
}

/**
 * Actualiza StageStatus en batch para un grupo de filas de staging.
 * Una falla individual no aborta el lote — se registra en Logger.
 */
function _marcarStageStatus_(rows, idx, nuevoStatus, fnActualizar, idCol) {
  const fn = fnActualizar === "actualizarStgDocente"
    ? actualizarStgDocente
    : actualizarStgAsignacion;

  rows.forEach(function(row) {
    const id = String(row[idx[idCol]] || "").trim();
    if (!id) return;
    try {
      fn(id, { StageStatus: nuevoStatus });
    } catch (e) {
      Logger.log("  ⚠️  No se pudo marcar " + nuevoStatus + " en " + id + ": " + e.message);
    }
  });
  Logger.log("  ✔  " + rows.length + " filas → StageStatus=" + nuevoStatus);
}
