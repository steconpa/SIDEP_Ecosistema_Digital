/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 42_job_procesarStgDocentes.gs
 * Versión: 2.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Dos jobs independientes con LockService propio:
 *
 *   procesarStgDocentes()     → STG_DOCENTES → Teachers
 *     REGISTER  : INSERT en Teachers
 *     UPDATE    : UPDATE en Teachers
 *     DEACTIVATE: TeacherStatusCode → TEACHER_INACTIVE
 *
 *   procesarStgAsignaciones() → STG_ASIGNACIONES → TeacherAssignments + Classroom
 *     ASSIGN: TeacherAssignment + Classroom.Invitations.create() + notificarDocentes()
 *     REMOVE: Courses.Teachers.delete() + IsActive=false
 *
 * DEPENDE DE:
 *   24b_repo_staging_academico.gs   → leerStgDocentes(), leerStgAsignaciones(),
 *                                     actualizarStgDocente(), actualizarStgAsignacion(),
 *                                     registrarStgDocentesLog()
 *   32_service_docentes_staging.gs  → procesarDocentesDesdeStaging(),
 *                                     procesarAsignacionesDesdeStaging(),
 *                                     validarDocentesStaging(), validarAsignacionesStaging()
 * ============================================================
 */


// ════════════════════════════════════════════════════════════
// JOB 1 — Procesar STG_DOCENTES → Teachers
// ════════════════════════════════════════════════════════════

/**
 * Lee STG_DOCENTES con ApprovalStatus=APPROVED y StageStatus=PENDING,
 * valida y promueve a Teachers.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] — valida sin escribir
 */
function procesarStgDocentes(options) {
  const opts    = options || {};
  const dryRun  = opts.dryRun === true;
  const ahora   = nowSIDEP();
  const usuario = Session.getEffectiveUser().getEmail() || "script@sidep";

  Logger.log("════════════════════════════════════════════════");
  Logger.log("👤 SIDEP — procesarStgDocentes");
  Logger.log("   Modo   : " + (dryRun ? "DRY-RUN" : "EJECUTAR"));
  Logger.log("   Usuario: " + usuario);
  Logger.log("════════════════════════════════════════════════");

  const lock = _adquirirLock_("procesarStgDocentes");
  if (!lock) return;

  try {
    // Leer todas las filas — el filtro incluye StageStatus vacío (filas nuevas)
    // y PENDING. Excluye VALIDATED, PROMOTED y ERROR (ya procesadas).
    const mem  = leerStgDocentes();
    const rows = mem.datos.filter(function(row) {
      const approval = String(row[mem.idx["ApprovalStatus"]] || "").trim();
      const stage    = String(row[mem.idx["StageStatus"]]    || "").trim();
      return approval === "APPROVED" && (stage === "PENDING" || stage === "");
    });

    // Autogenerar StageDocenteID si el staff lo dejó vacío
    rows.forEach(function(row) {
      if (!String(row[mem.idx["StageDocenteID"]] || "").trim()) {
        row[mem.idx["StageDocenteID"]] = uuid("stgdoc");
      }
    });

    Logger.log("  STG_DOCENTES APPROVED/PENDING: " + rows.length);
    if (rows.length === 0) {
      Logger.log("  ℹ️  Sin filas pendientes.");
      registrarStgDocentesLog({ stageEntityType: "DOCENTE", stageRecordId: "BATCH",
        action: "PROCESS", result: "SKIPPED", message: "Sin filas APPROVED/PENDING." });
      return;
    }

    // Validación
    try {
      validarDocentesStaging(rows, mem.idx);
      Logger.log("  ✅ Validación OK: " + rows.length + " filas");
    } catch (eVal) {
      Logger.log("  ❌ Validación fallida: " + eVal.message);
      registrarStgDocentesLog({ stageEntityType: "DOCENTE", stageRecordId: "BATCH",
        action: "VALIDATE", result: "ERROR", message: eVal.message });
      return;
    }

    if (dryRun) {
      Logger.log("  DRY-RUN: validación OK — sin escritura.");
      return;
    }

    // Marcar VALIDATED
    _marcarStatus_(rows, mem.idx, "StageDocenteID", "VALIDATED", actualizarStgDocente);

    // Promoción
    const res = procesarDocentesDesdeStaging({ rows: rows, idx: mem.idx, ahora: ahora, usuario: usuario });

    // Actualizar StageStatus por fila
    rows.forEach(function(row) {
      const id    = String(row[mem.idx["StageDocenteID"]] || "").trim();
      const email = String(row[mem.idx["Email"]]          || "").trim().toLowerCase();
      const ok    = res.errores.every(function(e) { return e.indexOf(email) === -1; });
      if (id) {
        try {
          actualizarStgDocente(id, {
            StageStatus:       ok ? "PROMOTED" : "ERROR",
            ValidationMessage: ok ? "" : res.errores.filter(function(e) { return e.indexOf(email) !== -1; }).join(" | "),
            ProcessedAt:       ahora,
            ProcessedBy:       usuario
          });
        } catch (e) { Logger.log("  ⚠️  No se pudo actualizar " + id + ": " + e.message); }
      }
    });

    const logResult = res.errores.length > 0 ? "PARTIAL" : "SUCCESS";
    const logMsg    = "Registrados: " + res.insertados + " | Actualizados: " + res.actualizados +
                      " | Desactivados: " + res.desactivados + " | Errores: " + res.errores.length;

    registrarStgDocentesLog({ stageEntityType: "DOCENTE", stageRecordId: "BATCH",
      action: "PROMOTE", result: logResult, message: logMsg });

    Logger.log("\n✅ procesarStgDocentes completado");
    Logger.log("   " + logMsg);

  } catch (e) {
    Logger.log("\n❌ ERROR FATAL: " + e.message);
    registrarStgDocentesLog({ stageEntityType: "DOCENTE", stageRecordId: "BATCH",
      action: "PROCESS", result: "ERROR", message: e.message });
    throw e;
  } finally {
    lock.releaseLock();
    Logger.log("🔓 Lock liberado");
  }
}


// ════════════════════════════════════════════════════════════
// JOB 2 — Procesar STG_ASIGNACIONES → TeacherAssignments + Classroom
// ════════════════════════════════════════════════════════════

/**
 * Lee STG_ASIGNACIONES con ApprovalStatus=APPROVED y StageStatus=PENDING,
 * valida y promueve a TeacherAssignments + Classroom API.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 */
function procesarStgAsignaciones(options) {
  const opts    = options || {};
  const dryRun  = opts.dryRun === true;
  const ahora   = nowSIDEP();
  const usuario = Session.getEffectiveUser().getEmail() || "script@sidep";

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🏫 SIDEP — procesarStgAsignaciones");
  Logger.log("   Modo   : " + (dryRun ? "DRY-RUN" : "EJECUTAR"));
  Logger.log("   Usuario: " + usuario);
  Logger.log("════════════════════════════════════════════════");

  const lock = _adquirirLock_("procesarStgAsignaciones");
  if (!lock) return;

  try {
    // Leer todas las filas — el filtro incluye StageStatus vacío (filas nuevas) y PENDING.
    const mem  = leerStgAsignaciones();
    const rows = mem.datos.filter(function(row) {
      const approval = String(row[mem.idx["ApprovalStatus"]] || "").trim();
      const stage    = String(row[mem.idx["StageStatus"]]    || "").trim();
      return approval === "APPROVED" && (stage === "PENDING" || stage === "");
    });

    // Autogenerar StageAsignacionID si está vacío
    rows.forEach(function(row) {
      if (!String(row[mem.idx["StageAsignacionID"]] || "").trim()) {
        row[mem.idx["StageAsignacionID"]] = uuid("stgasig");
      }
    });

    Logger.log("  STG_ASIGNACIONES APPROVED/PENDING: " + rows.length);
    if (rows.length === 0) {
      Logger.log("  ℹ️  Sin filas pendientes.");
      registrarStgDocentesLog({ stageEntityType: "ASIGNACION", stageRecordId: "BATCH",
        action: "PROCESS", result: "SKIPPED", message: "Sin filas APPROVED/PENDING." });
      return;
    }

    // Validación
    try {
      validarAsignacionesStaging(rows, mem.idx);
      Logger.log("  ✅ Validación OK: " + rows.length + " filas");
    } catch (eVal) {
      Logger.log("  ❌ Validación fallida: " + eVal.message);
      registrarStgDocentesLog({ stageEntityType: "ASIGNACION", stageRecordId: "BATCH",
        action: "VALIDATE", result: "ERROR", message: eVal.message });
      return;
    }

    if (dryRun) {
      Logger.log("  DRY-RUN: validación OK — sin escritura.");
      return;
    }

    // Marcar VALIDATED
    _marcarStatus_(rows, mem.idx, "StageAsignacionID", "VALIDATED", actualizarStgAsignacion);

    // Promoción
    const res = procesarAsignacionesDesdeStaging({ rows: rows, idx: mem.idx, ahora: ahora, usuario: usuario });

    // Actualizar StageStatus por fila
    rows.forEach(function(row) {
      const id    = String(row[mem.idx["StageAsignacionID"]] || "").trim();
      const email = String(row[mem.idx["TeacherEmail"]]      || "").trim().toLowerCase();
      const subj  = String(row[mem.idx["SubjectCode"]]       || "").trim();
      const ok    = res.errores.every(function(e) { return e.indexOf(email) === -1 || e.indexOf(subj) === -1; });
      if (id) {
        try {
          actualizarStgAsignacion(id, {
            StageStatus:       ok ? "PROMOTED" : "ERROR",
            ValidationMessage: ok ? "" : "Revisar log",
            ProcessedAt:       ahora,
            ProcessedBy:       usuario
          });
        } catch (e) { Logger.log("  ⚠️  No se pudo actualizar " + id + ": " + e.message); }
      }
    });

    const logResult = res.errores.length > 0 ? "PARTIAL" : "SUCCESS";
    const logMsg    = "Asignados: " + res.asignados + " | Removidos: " + res.removidos +
                      " | Invitaciones nuevas: " + res.invitacionesOk +
                      " | Ya existían: " + res.invitacionesYaExistian +
                      " | Errores: " + res.errores.length;

    registrarStgDocentesLog({ stageEntityType: "ASIGNACION", stageRecordId: "BATCH",
      action: "PROMOTE", result: logResult, message: logMsg });

    Logger.log("\n✅ procesarStgAsignaciones completado");
    Logger.log("   " + logMsg);
    if (res.asignados > 0) {
      Logger.log("   ⚠️  Los docentes deben ACEPTAR la invitación por email para aparecer en el aula.");
    }

    // Notificar docentes recién invitados — NO esperar a que acepten
    if (res.invitacionesOk > 0) {
      Logger.log("\n── Notificando docentes (" + res.invitacionesOk + " invitaciones nuevas) ──");
      try {
        notificarDocentes();
      } catch (eNotif) {
        // No abortar el job si la notificación falla
        Logger.log("  ⚠️  notificarDocentes falló: " + eNotif.message);
        registrarStgDocentesLog({ stageEntityType: "ASIGNACION", stageRecordId: "BATCH",
          action: "NOTIFY", result: "ERROR", message: eNotif.message });
      }
    }

  } catch (e) {
    Logger.log("\n❌ ERROR FATAL: " + e.message);
    registrarStgDocentesLog({ stageEntityType: "ASIGNACION", stageRecordId: "BATCH",
      action: "PROCESS", result: "ERROR", message: e.message });
    throw e;
  } finally {
    lock.releaseLock();
    Logger.log("🔓 Lock liberado");
  }
}


// ── Helpers privados del job ──────────────────────────────────

function _adquirirLock_(fnName) {
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) {
      Logger.log("⚠️  Lock ocupado — " + fnName + " ya está corriendo. Espera ~30s.");
      return null;
    }
    Logger.log("🔐 Lock adquirido");
    return lock;
  } catch (e) {
    Logger.log("⚠️  No se pudo adquirir lock: " + e.message);
    return null;
  }
}

function _marcarStatus_(rows, idx, idCol, nuevoStatus, fnActualizar) {
  rows.forEach(function(row) {
    const id = String(row[idx[idCol]] || "").trim();
    if (!id) return;
    try { fnActualizar(id, { StageStatus: nuevoStatus }); }
    catch (e) { Logger.log("  ⚠️  No se pudo marcar " + nuevoStatus + " en " + id); }
  });
  Logger.log("  ✔  " + rows.length + " filas → StageStatus=" + nuevoStatus);
}
