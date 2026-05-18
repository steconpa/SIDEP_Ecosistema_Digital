/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 54_cerrarCohorteAcademico.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Implementar la separacion entre CIERRE ACADEMICO (estudiante termino
 *   clases, deja de cursar) y CIERRE ADMINISTRATIVO (cohorte archivado).
 *
 *   El cierre academico se ejecuta cuando termina la ultima semana de
 *   clases de un cohorte/ventana. Marca las matriculas ACTIVE como
 *   IN_GRADING. Las aulas Classroom siguen abiertas (CREATED) para que
 *   los docentes carguen notas durante ~1 semana adicional.
 *
 *   El cierre administrativo (otro script, futuro) tomara IN_GRADING
 *   y lo convertira en COMPLETED/FAILED segun nota final.
 *
 * REFERENCIA:
 *   Decision Log: DEC-2026-015 — Separacion de cierre academico vs administrativo
 *
 * FUNCIONES PUBLICAS:
 *   cerrarCohorteAcademico(windowCohortCode, opts)   → ACTIVE → IN_GRADING
 *   reabrirCohorteAcademico(windowCohortCode, opts)  → IN_GRADING → ACTIVE (rollback)
 *   diagnosticoCierreCohorte(windowCohortCode)       → cuenta matriculas por estado
 *
 * IDEMPOTENCIA:
 *   Re-ejecutar cerrarCohorteAcademico() no afecta filas que ya estan en
 *   IN_GRADING/COMPLETED/FAILED/DROPPED/WITHDRAWN. Solo afecta ACTIVE.
 *
 * VERSIÓN: 1.0.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-05-18
 * ============================================================
 */


// ── Funcion principal — cierre academico ─────────────────────

/**
 * Transicion ACTIVE → IN_GRADING para todas las matriculas de una ventana.
 *
 * Proposito: marcar que los estudiantes terminaron clases sin esperar a que los
 * docentes carguen las notas finales. Las aulas Classroom siguen abiertas.
 * Resuelve el bug de notificacion cruzada entre cohortes solapados (DEC-2026-015).
 *
 * @param {string} windowCohortCode — codigo de ventana, ej. 'MR26'. Requerido.
 *   Se valida contra _CFG_COHORTS — si no existe, lanza error.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] — preview sin escribir
 * @param {string}  [opts.momentCode]   — si se pasa, solo cierra ese momento
 *
 * Efectos secundarios:
 *   En modo real: actualiza EnrollmentStatusCode=IN_GRADING en Enrollments
 *   (SIDEP_02_GESTION_ADMIN). Registra en STG_ESTUDIANTES_LOG.
 *   Cuota: 1-2 lecturas + 1 escritura batch en Sheets API.
 */
function cerrarCohorteAcademico(windowCohortCode, opts) {
  var options     = opts || {};
  var dryRun      = options.dryRun     === true;
  var momentCode  = options.momentCode ? String(options.momentCode).trim().toUpperCase() : null;
  var ahora       = nowSIDEP();
  var ejecutor    = Session.getEffectiveUser().getEmail();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — cerrarCohorteAcademico v1.0" + (dryRun ? " [DRY RUN]" : ""));
  Logger.log("   Ejecutor : " + ejecutor);
  Logger.log("   Ventana  : " + windowCohortCode);
  if (momentCode) Logger.log("   Momento  : " + momentCode);
  Logger.log("════════════════════════════════════════════════");

  if (!windowCohortCode || typeof windowCohortCode !== "string") {
    throw new Error("cerrarCohorteAcademico: windowCohortCode es requerido (string, ej. 'MR26').");
  }
  var win = windowCohortCode.trim().toUpperCase();

  var lock = _adquirirLock_("cerrarCohorteAcademico");
  if (!lock) return;

  try {
    // Validar que la ventana existe en _CFG_COHORTS
    _validarVentanaEnCfg_(win);

    var adminSS  = getSpreadsheetByName("admin");
    var hojaEnr  = adminSS.getSheetByName("Enrollments");
    if (!hojaEnr) throw new Error("Hoja 'Enrollments' no encontrada en SIDEP_02_GESTION_ADMIN.");

    var mem = _leerHoja_(hojaEnr);
    var c   = mem.idx;

    var iStatus = c["EnrollmentStatusCode"];
    var iWin    = c["WindowCohortCode"];
    var iMom    = c["MomentCode"];
    var iUpAt   = c["UpdatedAt"];
    var iUpBy   = c["UpdatedBy"];

    if (iStatus === undefined) throw new Error("Columna EnrollmentStatusCode no encontrada en Enrollments.");
    if (iWin    === undefined) throw new Error("Columna WindowCohortCode no encontrada en Enrollments.");

    // Identificar filas candidatas
    var candidatas = [];
    mem.datos.forEach(function(row, rowIdx) {
      var status = String(row[iStatus] || "").trim();
      if (status !== "ACTIVE") return;
      var rowWin = String(row[iWin] || "").trim().toUpperCase();
      if (rowWin !== win) return;
      if (momentCode && iMom !== undefined) {
        var rowMom = String(row[iMom] || "").trim().toUpperCase();
        if (rowMom !== momentCode) return;
      }
      candidatas.push({ rowIdx: rowIdx, row: row });
    });

    Logger.log("  Encontradas " + candidatas.length + " matriculas ACTIVE en ventana " + win +
               (momentCode ? " / momento " + momentCode : " (todos los momentos)") + ".");

    if (candidatas.length === 0) {
      Logger.log("  Sin cambios necesarios (idempotente).");
      if (!dryRun) {
        registrarStgEstudiantesLog({
          stageEntityType: "COHORT_CLOSURE",
          stageRecordId  : "BATCH",
          action         : "CLOSE_ACADEMIC",
          result         : "SKIPPED",
          message        : "windowCohortCode=" + win + ", momentCode=" + (momentCode || "ALL") +
                           ", marcadas=0 (ya estaban en otro estado)"
        });
      }
      return;
    }

    if (dryRun) {
      Logger.log("  [DRY RUN] Preview de " + candidatas.length + " matriculas:");
      candidatas.forEach(function(c_) {
        var row = c_.row;
        var stuId  = String(row[mem.idx["StudentID"]]    || "").trim();
        var deplId = String(row[mem.idx["DeploymentID"]] || "").trim();
        Logger.log("    StudentID=" + stuId + " DeploymentID=" + deplId +
                   " ACTIVE → IN_GRADING");
      });
      Logger.log("  [DRY RUN] Sin escritura — pasa {dryRun:false} para ejecutar.");
      return;
    }

    // Modo real: actualizar en memoria y escribir en batch
    candidatas.forEach(function(c_) {
      var row = c_.row;
      row[iStatus] = "IN_GRADING";
      if (iUpAt !== undefined) row[iUpAt] = ahora;
      if (iUpBy !== undefined) row[iUpBy] = ejecutor;
    });

    _escribirEnBatch_(hojaEnr, mem);

    registrarStgEstudiantesLog({
      stageEntityType: "COHORT_CLOSURE",
      stageRecordId  : "BATCH",
      action         : "CLOSE_ACADEMIC",
      result         : "SUCCESS",
      message        : "windowCohortCode=" + win + ", momentCode=" + (momentCode || "ALL") +
                       ", marcadas=" + candidatas.length
    });

    Logger.log("  OK " + candidatas.length + " matriculas ACTIVE → IN_GRADING.");
    Logger.log("  Aulas Classroom siguen abiertas para carga de notas.");
    Logger.log("  Reversible con reabrirCohorteAcademico('" + win + "').");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("ERROR en cerrarCohorteAcademico: " + e.message);
    if (!dryRun) {
      try {
        registrarStgEstudiantesLog({
          stageEntityType: "COHORT_CLOSURE",
          stageRecordId  : "BATCH",
          action         : "CLOSE_ACADEMIC",
          result         : "ERROR",
          message        : e.message
        });
      } catch (eLog) { /* no enmascarar el error original */ }
    }
    throw e;
  } finally {
    lock.releaseLock();
  }
}


// ── Funcion de rollback — reabrir cohorte ────────────────────

/**
 * Transicion IN_GRADING → ACTIVE (rollback de cerrarCohorteAcademico).
 *
 * Proposito: revertir un cierre academico erroneo antes de que los docentes
 * carguen notas. Solo afecta filas IN_GRADING — no toca COMPLETED/FAILED.
 *
 * @param {string} windowCohortCode — codigo de ventana. Requerido.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {string}  [opts.momentCode]
 *
 * Efectos secundarios: igual que cerrarCohorteAcademico pero en direccion inversa.
 */
function reabrirCohorteAcademico(windowCohortCode, opts) {
  var options    = opts || {};
  var dryRun     = options.dryRun    === true;
  var momentCode = options.momentCode ? String(options.momentCode).trim().toUpperCase() : null;
  var ahora      = nowSIDEP();
  var ejecutor   = Session.getEffectiveUser().getEmail();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — reabrirCohorteAcademico v1.0" + (dryRun ? " [DRY RUN]" : ""));
  Logger.log("   Ejecutor : " + ejecutor);
  Logger.log("   Ventana  : " + windowCohortCode);
  if (momentCode) Logger.log("   Momento  : " + momentCode);
  Logger.log("════════════════════════════════════════════════");

  if (!windowCohortCode || typeof windowCohortCode !== "string") {
    throw new Error("reabrirCohorteAcademico: windowCohortCode es requerido (string, ej. 'MR26').");
  }
  var win = windowCohortCode.trim().toUpperCase();

  var lock = _adquirirLock_("reabrirCohorteAcademico");
  if (!lock) return;

  try {
    _validarVentanaEnCfg_(win);

    var adminSS = getSpreadsheetByName("admin");
    var hojaEnr = adminSS.getSheetByName("Enrollments");
    if (!hojaEnr) throw new Error("Hoja 'Enrollments' no encontrada en SIDEP_02_GESTION_ADMIN.");

    var mem = _leerHoja_(hojaEnr);
    var c   = mem.idx;

    var iStatus = c["EnrollmentStatusCode"];
    var iWin    = c["WindowCohortCode"];
    var iMom    = c["MomentCode"];
    var iUpAt   = c["UpdatedAt"];
    var iUpBy   = c["UpdatedBy"];

    if (iStatus === undefined) throw new Error("Columna EnrollmentStatusCode no encontrada en Enrollments.");
    if (iWin    === undefined) throw new Error("Columna WindowCohortCode no encontrada en Enrollments.");

    var candidatas = [];
    mem.datos.forEach(function(row, rowIdx) {
      var status = String(row[iStatus] || "").trim();
      if (status !== "IN_GRADING") return;
      var rowWin = String(row[iWin] || "").trim().toUpperCase();
      if (rowWin !== win) return;
      if (momentCode && iMom !== undefined) {
        var rowMom = String(row[iMom] || "").trim().toUpperCase();
        if (rowMom !== momentCode) return;
      }
      candidatas.push({ rowIdx: rowIdx, row: row });
    });

    Logger.log("  Encontradas " + candidatas.length + " matriculas IN_GRADING en ventana " + win +
               (momentCode ? " / momento " + momentCode : " (todos los momentos)") + ".");

    if (candidatas.length === 0) {
      Logger.log("  Sin cambios necesarios.");
      if (!dryRun) {
        registrarStgEstudiantesLog({
          stageEntityType: "COHORT_CLOSURE",
          stageRecordId  : "BATCH",
          action         : "REOPEN_ACADEMIC",
          result         : "SKIPPED",
          message        : "windowCohortCode=" + win + ", momentCode=" + (momentCode || "ALL") +
                           ", reabiertas=0"
        });
      }
      return;
    }

    if (dryRun) {
      Logger.log("  [DRY RUN] Preview de " + candidatas.length + " matriculas:");
      candidatas.forEach(function(c_) {
        var row = c_.row;
        var stuId  = String(row[mem.idx["StudentID"]]    || "").trim();
        var deplId = String(row[mem.idx["DeploymentID"]] || "").trim();
        Logger.log("    StudentID=" + stuId + " DeploymentID=" + deplId +
                   " IN_GRADING → ACTIVE");
      });
      Logger.log("  [DRY RUN] Sin escritura.");
      return;
    }

    candidatas.forEach(function(c_) {
      var row = c_.row;
      row[iStatus] = "ACTIVE";
      if (iUpAt !== undefined) row[iUpAt] = ahora;
      if (iUpBy !== undefined) row[iUpBy] = ejecutor;
    });

    _escribirEnBatch_(hojaEnr, mem);

    registrarStgEstudiantesLog({
      stageEntityType: "COHORT_CLOSURE",
      stageRecordId  : "BATCH",
      action         : "REOPEN_ACADEMIC",
      result         : "SUCCESS",
      message        : "windowCohortCode=" + win + ", momentCode=" + (momentCode || "ALL") +
                       ", reabiertas=" + candidatas.length
    });

    Logger.log("  OK " + candidatas.length + " matriculas IN_GRADING → ACTIVE (rollback).");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("ERROR en reabrirCohorteAcademico: " + e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}


// ── Funcion de diagnostico — solo lectura ────────────────────

/**
 * Muestra el conteo de matriculas por estado para una ventana dada.
 *
 * Proposito: validar antes y despues de cerrarCohorteAcademico().
 * Solo lectura — no escribe nada.
 *
 * @param {string} windowCohortCode — codigo de ventana. Requerido.
 *
 * Efectos secundarios: ninguno. Solo escribe en Logger.
 * Cuota: 1 lectura en Sheets API.
 */
function diagnosticoCierreCohorte(windowCohortCode) {
  if (!windowCohortCode || typeof windowCohortCode !== "string") {
    throw new Error("diagnosticoCierreCohorte: windowCohortCode es requerido.");
  }
  var win = windowCohortCode.trim().toUpperCase();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — diagnosticoCierreCohorte v1.0");
  Logger.log("   Ventana: " + win);
  Logger.log("════════════════════════════════════════════════");

  try {
    var adminSS = getSpreadsheetByName("admin");
    var hojaEnr = adminSS.getSheetByName("Enrollments");
    if (!hojaEnr) throw new Error("Hoja 'Enrollments' no encontrada.");

    var mem    = _leerHoja_(hojaEnr);
    var iStatus = mem.idx["EnrollmentStatusCode"];
    var iWin    = mem.idx["WindowCohortCode"];

    if (iStatus === undefined) throw new Error("Columna EnrollmentStatusCode no encontrada.");
    if (iWin    === undefined) throw new Error("Columna WindowCohortCode no encontrada.");

    var conteo = {};
    var total  = 0;

    mem.datos.forEach(function(row) {
      var rowWin = String(row[iWin] || "").trim().toUpperCase();
      if (rowWin !== win) return;
      var status = String(row[iStatus] || "SIN_STATUS").trim() || "SIN_STATUS";
      conteo[status] = (conteo[status] || 0) + 1;
      total++;
    });

    Logger.log("  Ventana " + win + " — Enrollments:");
    var estados = ["ACTIVE", "IN_GRADING", "COMPLETED", "FAILED", "DROPPED", "WITHDRAWN",
                   "PENDING_RETRY", "GRADUATED"];
    estados.forEach(function(st) {
      if (conteo[st] || conteo[st] === 0) {
        Logger.log("    " + st + " = " + (conteo[st] || 0));
      }
    });
    // Estados no esperados
    Object.keys(conteo).forEach(function(st) {
      if (estados.indexOf(st) === -1) {
        Logger.log("    " + st + " = " + conteo[st] + " (inesperado)");
      }
    });
    Logger.log("    TOTAL = " + total);
    Logger.log("════════════════════════════════════════════════");

    return conteo;

  } catch (e) {
    Logger.log("ERROR en diagnosticoCierreCohorte: " + e.message);
    throw e;
  }
}


// ── Helper privado — validacion de ventana ───────────────────

/**
 * Valida que windowCohortCode exista en _CFG_COHORTS.
 * Lanza Error si no se encuentra.
 *
 * @param {string} win — codigo de ventana ya normalizado (UPPERCASE)
 */
function _validarVentanaEnCfg_(win) {
  var coreSS    = getSpreadsheetByName("core");
  var hojaCfg   = coreSS.getSheetByName("_CFG_COHORTS");
  if (!hojaCfg) {
    Logger.log("  Aviso: _CFG_COHORTS no encontrada — omitiendo validacion de ventana.");
    return;
  }
  var mem  = _leerHoja_(hojaCfg);
  var iCod = mem.idx["CohortCode"];
  if (iCod === undefined) {
    Logger.log("  Aviso: CohortCode no encontrada en _CFG_COHORTS — omitiendo validacion.");
    return;
  }
  var existe = mem.datos.some(function(row) {
    return String(row[iCod] || "").trim().toUpperCase() === win;
  });
  if (!existe) {
    throw new Error("La ventana '" + win + "' no existe en _CFG_COHORTS. " +
                    "Verifica el codigo o agrega el cohorte primero.");
  }
}
