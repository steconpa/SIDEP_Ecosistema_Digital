/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 43_job_procesarStgEstudiantes.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Dos jobs independientes con LockService propio:
 *
 *   procesarStgEstudiantes()  → STG_ESTUDIANTES → Students
 *     REGISTER  : INSERT en Students
 *     UPDATE    : UPDATE en Students
 *     DEACTIVATE: StudentStatusCode → STUDENT_INACTIVE
 *
 *   procesarStgMatriculas()   → STG_MATRICULAS → Enrollments + Classroom
 *     ENROLL: Enrollment + Classroom.Invitations.create(role=STUDENT) + notificarEstudiantes()
 *     DROP  : EnrollmentStatusCode=DROPPED + Classroom.Courses.Students.remove()
 *
 * DEPENDE DE:
 *   24c_repo_staging_estudiantes.gs  → leerStgEstudiantes(), leerStgMatriculas(),
 *                                      actualizarStgEstudiante(), actualizarStgMatricula(),
 *                                      registrarStgEstudiantesLog()
 *   33_service_estudiantes_staging.gs → procesarEstudiantesDesdeStaging(),
 *                                       procesarMatriculasDesdeStaging(),
 *                                       validarEstudiantesStaging(), validarMatriculasStaging()
 *   18b_notificarEstudiantes.gs      → notificarEstudiantes()
 * ============================================================
 */


// ════════════════════════════════════════════════════════════
// JOB 1 — Procesar STG_ESTUDIANTES → Students
// ════════════════════════════════════════════════════════════

/**
 * Lee STG_ESTUDIANTES con ApprovalStatus=APPROVED y StageStatus=PENDING,
 * valida y promueve a Students.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] — valida sin escribir
 */
function procesarStgEstudiantes(options) {
  var opts    = options || {};
  var dryRun  = opts.dryRun === true;
  var ahora   = nowSIDEP();
  var usuario = Session.getEffectiveUser().getEmail() || "script@sidep";

  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — procesarStgEstudiantes");
  Logger.log("   Modo   : " + (dryRun ? "DRY-RUN" : "EJECUTAR"));
  Logger.log("   Usuario: " + usuario);
  Logger.log("════════════════════════════════════════════════");

  var lock = _adquirirLock_("procesarStgEstudiantes");
  if (!lock) return;

  try {
    var mem  = leerStgEstudiantes();
    var rows = mem.datos.filter(function(row) {
      var approval = String(row[mem.idx["ApprovalStatus"]] || "").trim();
      var stage    = String(row[mem.idx["StageStatus"]]    || "").trim();
      return approval === "APPROVED" && (stage === "PENDING" || stage === "");
    });

    // Autogenerar StageEstudianteID si está vacío
    rows.forEach(function(row) {
      if (!String(row[mem.idx["StageEstudianteID"]] || "").trim()) {
        row[mem.idx["StageEstudianteID"]] = uuid("stgest");
      }
    });

    // Auto-rellenar RequestedBy / RequestedAt si el staff los dejó vacíos
    rows.forEach(function(row) {
      if (!String(row[mem.idx["RequestedBy"]] || "").trim()) row[mem.idx["RequestedBy"]] = usuario;
      if (!String(row[mem.idx["RequestedAt"]] || "").trim()) row[mem.idx["RequestedAt"]] = ahora;
    });

    // Persistir IDs antes de usarlos como clave
    _escribirEnBatch_(mem.hoja, mem);

    Logger.log("  STG_ESTUDIANTES APPROVED/PENDING: " + rows.length);
    if (rows.length === 0) {
      Logger.log("  Sin filas pendientes.");
      registrarStgEstudiantesLog({ stageEntityType: "ESTUDIANTE", stageRecordId: "BATCH",
        action: "PROCESS", result: "SKIPPED", message: "Sin filas APPROVED/PENDING." });
      return;
    }

    // Validación
    try {
      validarEstudiantesStaging(rows, mem.idx);
      Logger.log("  OK Validacion: " + rows.length + " filas");
    } catch (eVal) {
      Logger.log("  ERROR Validacion: " + eVal.message);
      registrarStgEstudiantesLog({ stageEntityType: "ESTUDIANTE", stageRecordId: "BATCH",
        action: "VALIDATE", result: "ERROR", message: eVal.message });
      return;
    }

    if (dryRun) {
      Logger.log("  DRY-RUN: validacion OK — sin escritura.");
      return;
    }

    // Marcar VALIDATED
    _marcarStatus_(rows, mem.idx, "StageEstudianteID", "VALIDATED", actualizarStgEstudiante);

    // Promoción
    var res = procesarEstudiantesDesdeStaging({ rows: rows, idx: mem.idx, ahora: ahora, usuario: usuario });

    // Actualizar StageStatus por fila
    rows.forEach(function(row) {
      var id    = String(row[mem.idx["StageEstudianteID"]] || "").trim();
      var email = String(row[mem.idx["Email"]]             || "").trim().toLowerCase();
      var ok    = res.errores.every(function(e) { return e.indexOf(email) === -1; });
      if (id) {
        try {
          actualizarStgEstudiante(id, {
            StageStatus:       ok ? "PROMOTED" : "ERROR",
            ValidationMessage: ok ? "" : res.errores.filter(function(e) {
              return e.indexOf(email) !== -1;
            }).join(" | "),
            TargetStudentID:   res.emailToNewId[email] || "",
            ProcessedAt:       ahora,
            ProcessedBy:       usuario
          });
        } catch (e) { Logger.log("  Aviso: No se pudo actualizar " + id + ": " + e.message); }
      }
    });

    var logResult = res.errores.length > 0 ? "PARTIAL" : "SUCCESS";
    var logMsg    = "Registrados: " + res.insertados + " | Actualizados: " + res.actualizados +
                    " | Desactivados: " + res.desactivados + " | Errores: " + res.errores.length;

    registrarStgEstudiantesLog({ stageEntityType: "ESTUDIANTE", stageRecordId: "BATCH",
      action: "PROMOTE", result: logResult, message: logMsg });

    Logger.log("\nOK procesarStgEstudiantes completado");
    Logger.log("   " + logMsg);

  } catch (e) {
    Logger.log("\nERROR FATAL: " + e.message);
    registrarStgEstudiantesLog({ stageEntityType: "ESTUDIANTE", stageRecordId: "BATCH",
      action: "PROCESS", result: "ERROR", message: e.message });
    throw e;
  } finally {
    lock.releaseLock();
    Logger.log("Lock liberado");
  }
}


// ════════════════════════════════════════════════════════════
// JOB 2 — Procesar STG_MATRICULAS → Enrollments + Classroom
// ════════════════════════════════════════════════════════════

/**
 * Lee STG_MATRICULAS con ApprovalStatus=APPROVED y StageStatus=PENDING,
 * valida y promueve a Enrollments + Classroom API.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.skipNotify] — omite notificarEstudiantes() al final.
 *   Usar cuando se reintenta un lote parcial para evitar emails duplicados.
 *   Enviar la notificación manualmente después desde el menú.
 */
function procesarStgMatriculas(options) {
  var opts       = options || {};
  var dryRun     = opts.dryRun     === true;
  var skipNotify = opts.skipNotify === true;
  var ahora   = nowSIDEP();
  var usuario = Session.getEffectiveUser().getEmail() || "script@sidep";

  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — procesarStgMatriculas");
  Logger.log("   Modo   : " + (dryRun ? "DRY-RUN" : "EJECUTAR"));
  Logger.log("   Usuario: " + usuario);
  Logger.log("════════════════════════════════════════════════");

  var lock = _adquirirLock_("procesarStgMatriculas");
  if (!lock) return;

  try {
    var mem  = leerStgMatriculas();
    var rows = mem.datos.filter(function(row) {
      var approval = String(row[mem.idx["ApprovalStatus"]] || "").trim();
      var stage    = String(row[mem.idx["StageStatus"]]    || "").trim();
      return approval === "APPROVED" && (stage === "PENDING" || stage === "");
    });

    // Autogenerar StageMatriculaID si está vacío
    rows.forEach(function(row) {
      if (!String(row[mem.idx["StageMatriculaID"]] || "").trim()) {
        row[mem.idx["StageMatriculaID"]] = uuid("stgmat");
      }
    });

    // Persistir IDs antes de usarlos como clave
    _escribirEnBatch_(mem.hoja, mem);

    Logger.log("  STG_MATRICULAS APPROVED/PENDING: " + rows.length);
    if (rows.length === 0) {
      Logger.log("  Sin filas pendientes.");
      registrarStgEstudiantesLog({ stageEntityType: "MATRICULA", stageRecordId: "BATCH",
        action: "PROCESS", result: "SKIPPED", message: "Sin filas APPROVED/PENDING." });
      return;
    }

    // Validación
    try {
      validarMatriculasStaging(rows, mem.idx);
      Logger.log("  OK Validacion: " + rows.length + " filas");
    } catch (eVal) {
      Logger.log("  ERROR Validacion: " + eVal.message);
      registrarStgEstudiantesLog({ stageEntityType: "MATRICULA", stageRecordId: "BATCH",
        action: "VALIDATE", result: "ERROR", message: eVal.message });
      return;
    }

    if (dryRun) {
      Logger.log("  DRY-RUN: validacion OK — sin escritura.");
      return;
    }

    // Marcar VALIDATED
    _marcarStatus_(rows, mem.idx, "StageMatriculaID", "VALIDATED", actualizarStgMatricula);

    // Promoción
    var res = procesarMatriculasDesdeStaging({ rows: rows, idx: mem.idx, ahora: ahora, usuario: usuario });

    // Actualizar StageStatus por fila
    rows.forEach(function(row) {
      var id    = String(row[mem.idx["StageMatriculaID"]] || "").trim();
      var email = String(row[mem.idx["StudentEmail"]]     || "").trim().toLowerCase();
      var subj  = String(row[mem.idx["SubjectCode"]]      || "").trim();
      var ok    = res.errores.every(function(e) { return e.indexOf(email) === -1 || e.indexOf(subj) === -1; });
      if (id) {
        try {
          actualizarStgMatricula(id, {
            StageStatus:       ok ? "PROMOTED" : "ERROR",
            ValidationMessage: ok ? "" : "Revisar log",
            ProcessedAt:       ahora,
            ProcessedBy:       usuario
          });
        } catch (e) { Logger.log("  Aviso: No se pudo actualizar " + id + ": " + e.message); }
      }
    });

    var logResult = res.errores.length > 0 ? "PARTIAL" : "SUCCESS";
    var logMsg    = "Matriculados: " + res.matriculados + " | Dados de baja: " + res.dados_de_baja +
                    " | Invitaciones nuevas: " + res.invitacionesOk +
                    " | Ya existian: " + res.invitacionesYaExistian +
                    " | Errores: " + res.errores.length;

    registrarStgEstudiantesLog({ stageEntityType: "MATRICULA", stageRecordId: "BATCH",
      action: "PROMOTE", result: logResult, message: logMsg });

    Logger.log("\nOK procesarStgMatriculas completado");
    Logger.log("   " + logMsg);

    // Notificar estudiantes recién matriculados
    if (res.invitacionesOk > 0 && !skipNotify) {
      Logger.log("\n-- Notificando estudiantes (" + res.invitacionesOk + " matriculas nuevas) --");
      try {
        notificarEstudiantes();
      } catch (eNotif) {
        Logger.log("  Aviso: notificarEstudiantes fallo: " + eNotif.message);
        registrarStgEstudiantesLog({ stageEntityType: "MATRICULA", stageRecordId: "BATCH",
          action: "NOTIFY", result: "ERROR", message: eNotif.message });
      }
    } else if (res.invitacionesOk > 0 && skipNotify) {
      Logger.log("\n-- skipNotify=true: notificacion omitida. Enviar manualmente desde el menu. --");
    }

  } catch (e) {
    Logger.log("\nERROR FATAL: " + e.message);
    registrarStgEstudiantesLog({ stageEntityType: "MATRICULA", stageRecordId: "BATCH",
      action: "PROCESS", result: "ERROR", message: e.message });
    throw e;
  } finally {
    lock.releaseLock();
    Logger.log("Lock liberado");
  }
}
