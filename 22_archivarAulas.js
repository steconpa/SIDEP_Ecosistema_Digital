/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 22_archivarAulas.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Archivar y restaurar aulas de Google Classroom por ventana
 *   (CohortCode + MomentCode). Inverso de 14_crearAulas.js.
 *   Cambia courseState ACTIVE ↔ ARCHIVED y ScriptStatusCode CREATED ↔ ARCHIVED.
 *
 * REGLA DE ORO:
 *   NUNCA usar Classroom.Courses.delete() — archivado es la ÚNICA vía de cierre.
 *   Archivar es reversible vía restaurarAulas(). Eliminar es IRREVERSIBLE.
 *
 * FUNCIONES PÚBLICAS:
 *   archivarAulas(opts)        → CREATED → ARCHIVED en Classroom + MasterDeployments
 *   restaurarAulas(opts)       → ARCHIVED → CREATED (rollback del archivado)
 *   diagnosticoArchivado(opts) → estado de archivado de la ventana (solo lectura)
 *   previewArchivado(opts)     → alias de archivarAulas con dryRun:true
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.js  → SIDEP_CONFIG, nowSIDEP(), uuid()
 *   02_SIDEP_HELPERS.js → getSpreadsheetByName()
 *   14_crearAulas.js    → COL_DEP (índices de columna de MasterDeployments)
 *   Google Classroom API v1 (habilitar en Editor → ➕ Servicios avanzados)
 *
 * PATRÓN MEMORY-FIRST:
 *   Lee MasterDeployments completa en memoria (1 llamada).
 *   Filtra en JS sin llamadas adicionales a Sheets.
 *   EXCEPCIÓN DOCUMENTADA: la escritura de ScriptStatusCode es individual por fila,
 *   igual que crearAulas(). Si el script falla a mitad del batch, la siguiente
 *   ejecución reintenta solo las CREATED restantes. El estado en Sheets refleja
 *   exactamente lo que está en Classroom en cada momento.
 *
 * LOCKING: LockService en archivarAulas() y restaurarAulas().
 *
 * IDEMPOTENCIA: re-ejecutar sobre aulas ya ARCHIVED las reporta como ya procesadas,
 *   sin error ni llamada duplicada a la API.
 *
 * VERSIÓN: 1.0.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-05-23
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// FUNCIONES PÚBLICAS
// ─────────────────────────────────────────────────────────────

/**
 * Preview: muestra qué aulas se archivarían sin ejecutar nada.
 * Alias de archivarAulas({ ..., dryRun: true }).
 *
 * @param {Object}  opts
 * @param {string}  opts.cohortCode    — ventana (OBLIGATORIO)
 * @param {string}  [opts.momentCode]  — filtrar por momento
 * @param {string}  [opts.programCode] — filtrar por programa
 */
function previewArchivado(opts) {
  var options   = opts || {};
  options.dryRun = true;
  archivarAulas(options);
}


/**
 * Archiva las aulas de una ventana en Google Classroom.
 * Cambia courseState ACTIVE → ARCHIVED y ScriptStatusCode CREATED → ARCHIVED.
 *
 * Solo procesa aulas con ScriptStatusCode=CREATED y ClassroomID definido.
 * Las aulas en ERROR, PENDING o ya ARCHIVED se reportan pero no se tocan.
 *
 * @param {Object}  opts
 * @param {string}  opts.cohortCode    — ventana a archivar (OBLIGATORIO)
 * @param {string}  [opts.momentCode]  — filtrar por momento (default: todos)
 * @param {string}  [opts.programCode] — filtrar por programa
 * @param {boolean} [opts.dryRun]      — true: preview sin ejecutar
 * @param {boolean} [opts.confirmar]   — true: ejecutar real (requiere dryRun=false)
 */
function archivarAulas(opts) {
  var options     = opts || {};
  var cohortCode  = options.cohortCode;
  var momentCode  = options.momentCode  || null;
  var programCode = options.programCode || null;
  var dryRun      = options.dryRun      === true;
  var confirmar   = options.confirmar   === true;
  var ahora       = nowSIDEP();
  var ejecutor    = Session.getEffectiveUser().getEmail();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — archivarAulas v1.0.0" + (dryRun ? " [DRY RUN]" : ""));
  Logger.log("   cohort  : " + (cohortCode  || "⚠️  OBLIGATORIO"));
  Logger.log("   momento : " + (momentCode  || "todos"));
  Logger.log("   programa: " + (programCode || "todos"));
  Logger.log("════════════════════════════════════════════════");

  if (!cohortCode) {
    Logger.log("🛑 cohortCode es OBLIGATORIO.");
    Logger.log("   Ejemplo: archivarAulas({ cohortCode: 'MR26', momentCode: 'C1M2', confirmar: true })");
    return;
  }

  if (!dryRun && !confirmar) {
    Logger.log("⚠️  Para ejecutar en real: archivarAulas({..., confirmar: true})");
    Logger.log("   Para preview:            archivarAulas({..., dryRun: true})");
    return;
  }

  if (typeof Classroom === "undefined") {
    Logger.log("❌ Classroom API no habilitada.");
    Logger.log("   Editor GAS → ➕ Servicios → Google Classroom API v1 → Agregar");
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    Logger.log("⚠️  Lock ocupado — otra ejecución está activa. Espera 30s e intenta de nuevo.");
    return;
  }
  Logger.log("🔐 Lock adquirido");

  try {
    var coreSS  = getSpreadsheetByName("core");
    var hojaDep = coreSS.getSheetByName("MasterDeployments");
    var lastRow = hojaDep.getLastRow();

    if (lastRow <= 1) {
      Logger.log("⚠️  MasterDeployments vacía.");
      return;
    }

    // Leer en memoria — 1 llamada a Sheets API
    var allData = hojaDep.getRange(2, 1, lastRow - 1, 17).getValues();

    var candidatas = [];
    allData.forEach(function(row, idx) {
      var cohort  = row[COL_DEP.CohortCode];
      var moment  = row[COL_DEP.MomentCode];
      var prog    = row[COL_DEP.ProgramCode];
      if (cohort  !== cohortCode)                       return;
      if (momentCode  && moment  !== momentCode)         return;
      if (programCode && prog    !== programCode)        return;
      candidatas.push({
        rowIndex: idx,
        sheetRow: idx + 2,
        nomenc:   row[COL_DEP.GeneratedNomenclature],
        classId:  row[COL_DEP.ClassroomID],
        status:   row[COL_DEP.ScriptStatusCode]
      });
    });

    Logger.log("   Aulas en la ventana    : " + candidatas.length);

    var aArchivar = candidatas.filter(function(c) { return c.status === "CREATED"; });
    var yaArch    = candidatas.filter(function(c) { return c.status === "ARCHIVED"; });
    var otras     = candidatas.filter(function(c) {
      return c.status !== "CREATED" && c.status !== "ARCHIVED";
    });

    Logger.log("   → CREATED (a archivar) : " + aArchivar.length);
    Logger.log("   → ARCHIVED (ya hechas) : " + yaArch.length);
    Logger.log("   → Otras (PENDING/ERROR): " + otras.length);

    if (aArchivar.length === 0) {
      Logger.log("ℹ️  Nada que archivar — todas ya están ARCHIVED o sin ClassroomID.");
      return;
    }

    Logger.log("\n   Plan de archivado:");
    aArchivar.forEach(function(item) {
      Logger.log("   " + (dryRun ? "[DRY] " : "→ ") + item.nomenc);
    });

    if (dryRun) {
      Logger.log("\n[DRY RUN] — Sin cambios. Para ejecutar: archivarAulas({..., confirmar:true})");
      return;
    }

    var archivadas = 0, errores = 0;

    aArchivar.forEach(function(item) {
      if (!item.classId) {
        Logger.log("  ⚠️  Sin ClassroomID: " + item.nomenc + " — omitida");
        errores++;
        return;
      }

      try {
        // Classroom.Courses.patch actualiza solo los campos del updateMask — no Courses.delete
        Classroom.Courses.patch(
          { courseState: "ARCHIVED" },
          item.classId,
          { updateMask: "courseState" }
        );

        // Escritura individual — excepción documentada al patrón memory-first.
        // Si el script falla a mitad del batch, la siguiente ejecución reintenta
        // solo las CREATED restantes (las ya ARCHIVED están protegidas).
        hojaDep.getRange(item.sheetRow, COL_DEP.ScriptStatusCode + 1).setValue("ARCHIVED");
        hojaDep.getRange(item.sheetRow, COL_DEP.Notes + 1).setValue(
          "ARCHIVED " + Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "yyyy-MM-dd HH:mm") +
          " por " + ejecutor
        );

        archivadas++;
        Logger.log("  ✔  Archivada: " + item.nomenc);
        Utilities.sleep(200);

      } catch (apiErr) {
        errores++;
        try {
          hojaDep.getRange(item.sheetRow, COL_DEP.Notes + 1).setValue(
            "ERROR ARCHIVE " + apiErr.message.substring(0, 150)
          );
        } catch (_) {}
        Logger.log("  ❌ " + item.nomenc + " → " + apiErr.message);
      }
    });

    Logger.log("\n──────────────────────────────────────────────");
    Logger.log("  ✅ Archivadas : " + archivadas);
    Logger.log("  ❌ Errores    : " + errores);
    if (errores > 0) {
      Logger.log("  ⚠️  Para reintentar: volver a ejecutar archivarAulas({..., confirmar:true})");
    }

  } catch (e) {
    Logger.log("❌ ERROR CRÍTICO en archivarAulas: " + e.message);
    throw e;
  } finally {
    lock.releaseLock();
    Logger.log("🔓 Lock liberado");
  }
}


/**
 * Restaura aulas archivadas a estado ACTIVE/CREATED (rollback del archivado).
 * Cambia courseState ARCHIVED → ACTIVE y ScriptStatusCode ARCHIVED → CREATED.
 * Después de restaurar, el Semáforo vuelve a procesar estas aulas.
 *
 * @param {Object}  opts
 * @param {string}  opts.cohortCode    — ventana (OBLIGATORIO)
 * @param {string}  [opts.momentCode]  — filtrar por momento
 * @param {string}  [opts.programCode] — filtrar por programa
 * @param {boolean} [opts.dryRun]      — true: preview sin ejecutar
 * @param {boolean} [opts.confirmar]   — true: ejecutar real
 */
function restaurarAulas(opts) {
  var options     = opts || {};
  var cohortCode  = options.cohortCode;
  var momentCode  = options.momentCode  || null;
  var programCode = options.programCode || null;
  var dryRun      = options.dryRun      === true;
  var confirmar   = options.confirmar   === true;
  var ahora       = nowSIDEP();
  var ejecutor    = Session.getEffectiveUser().getEmail();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — restaurarAulas v1.0.0" + (dryRun ? " [DRY RUN]" : ""));
  Logger.log("   cohort  : " + (cohortCode  || "⚠️  OBLIGATORIO"));
  Logger.log("   momento : " + (momentCode  || "todos"));
  Logger.log("════════════════════════════════════════════════");

  if (!cohortCode) {
    Logger.log("🛑 cohortCode es OBLIGATORIO.");
    return;
  }

  if (!dryRun && !confirmar) {
    Logger.log("⚠️  Para ejecutar: restaurarAulas({..., confirmar: true})");
    return;
  }

  if (typeof Classroom === "undefined") {
    Logger.log("❌ Classroom API no habilitada.");
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    Logger.log("⚠️  Lock ocupado. Espera 30s e intenta de nuevo.");
    return;
  }
  Logger.log("🔐 Lock adquirido");

  try {
    var coreSS  = getSpreadsheetByName("core");
    var hojaDep = coreSS.getSheetByName("MasterDeployments");
    var lastRow = hojaDep.getLastRow();

    if (lastRow <= 1) {
      Logger.log("⚠️  MasterDeployments vacía.");
      return;
    }

    var allData    = hojaDep.getRange(2, 1, lastRow - 1, 17).getValues();
    var aRestaurar = [];

    allData.forEach(function(row, idx) {
      if (row[COL_DEP.CohortCode]       !== cohortCode)  return;
      if (momentCode  && row[COL_DEP.MomentCode]  !== momentCode)  return;
      if (programCode && row[COL_DEP.ProgramCode] !== programCode) return;
      if (row[COL_DEP.ScriptStatusCode] !== "ARCHIVED")  return;
      aRestaurar.push({
        sheetRow: idx + 2,
        nomenc:   row[COL_DEP.GeneratedNomenclature],
        classId:  row[COL_DEP.ClassroomID]
      });
    });

    Logger.log("   Aulas ARCHIVED a restaurar: " + aRestaurar.length);
    aRestaurar.forEach(function(item) {
      Logger.log("   " + (dryRun ? "[DRY] " : "→ ") + item.nomenc);
    });

    if (aRestaurar.length === 0) {
      Logger.log("ℹ️  Sin aulas ARCHIVED para restaurar en esta ventana.");
      return;
    }

    if (dryRun) {
      Logger.log("\n[DRY RUN] — Sin cambios.");
      return;
    }

    var restauradas = 0, errores = 0;

    aRestaurar.forEach(function(item) {
      if (!item.classId) {
        Logger.log("  ⚠️  Sin ClassroomID: " + item.nomenc);
        errores++;
        return;
      }

      try {
        Classroom.Courses.patch(
          { courseState: "ACTIVE" },
          item.classId,
          { updateMask: "courseState" }
        );
        hojaDep.getRange(item.sheetRow, COL_DEP.ScriptStatusCode + 1).setValue("CREATED");
        hojaDep.getRange(item.sheetRow, COL_DEP.Notes + 1).setValue(
          "RESTORED " + Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "yyyy-MM-dd HH:mm") +
          " por " + ejecutor
        );
        restauradas++;
        Logger.log("  ✔  Restaurada: " + item.nomenc);
        Utilities.sleep(200);
      } catch (apiErr) {
        errores++;
        Logger.log("  ❌ " + item.nomenc + " → " + apiErr.message);
      }
    });

    Logger.log("\n──────────────────────────────────────────────");
    Logger.log("  ✅ Restauradas: " + restauradas);
    Logger.log("  ❌ Errores    : " + errores);
    Logger.log("  ⏭  El Semáforo volverá a procesar estas aulas en la próxima ejecución.");

  } catch (e) {
    Logger.log("❌ ERROR en restaurarAulas: " + e.message);
    throw e;
  } finally {
    lock.releaseLock();
    Logger.log("🔓 Lock liberado");
  }
}


/**
 * Diagnóstico de estado de archivado para una ventana.
 * Solo lectura — no modifica nada.
 *
 * @param {Object}  opts
 * @param {string}  [opts.cohortCode]  — filtrar por ventana (default: todas)
 * @param {string}  [opts.momentCode]  — filtrar por momento
 */
function diagnosticoArchivado(opts) {
  var options    = opts || {};
  var cohortCode = options.cohortCode || null;
  var momentCode = options.momentCode || null;

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔍 SIDEP — diagnosticoArchivado v1.0.0");
  Logger.log("   cohort : " + (cohortCode || "todos"));
  Logger.log("   momento: " + (momentCode || "todos"));
  Logger.log("════════════════════════════════════════════════");

  try {
    var coreSS  = getSpreadsheetByName("core");
    var hojaDep = coreSS.getSheetByName("MasterDeployments");
    var lastRow = hojaDep.getLastRow();

    if (lastRow <= 1) {
      Logger.log("⚠️  MasterDeployments vacía.");
      return;
    }

    var allData = hojaDep.getRange(2, 1, lastRow - 1, 17).getValues();
    var conteo  = {};
    var porProg = {};

    allData.forEach(function(row) {
      if (cohortCode && row[COL_DEP.CohortCode] !== cohortCode) return;
      if (momentCode && row[COL_DEP.MomentCode] !== momentCode) return;

      var sc   = row[COL_DEP.ScriptStatusCode] || "UNKNOWN";
      var prog = row[COL_DEP.ProgramCode]      || "?";
      conteo[sc] = (conteo[sc] || 0) + 1;
      if (!porProg[prog]) porProg[prog] = {};
      porProg[prog][sc] = (porProg[prog][sc] || 0) + 1;
    });

    var total = Object.keys(conteo).reduce(function(s, k) { return s + conteo[k]; }, 0);

    Logger.log("\nRESUMEN:");
    Logger.log("   Total    : " + total);
    Logger.log("   CREATED  : " + (conteo.CREATED  || 0) + " (activas — procesadas por el Semáforo)");
    Logger.log("   ARCHIVED : " + (conteo.ARCHIVED || 0) + " (archivadas — excluidas del Semáforo)");
    Logger.log("   PENDING  : " + (conteo.PENDING  || 0));
    Logger.log("   ERROR    : " + (conteo.ERROR    || 0));

    Logger.log("\nPOR PROGRAMA:");
    Object.keys(porProg).sort().forEach(function(prog) {
      var p = porProg[prog];
      Logger.log("   " + prog + ": " +
        (p.CREATED  || 0) + " CREATED | " +
        (p.ARCHIVED || 0) + " ARCHIVED | " +
        (p.PENDING  || 0) + " PENDING | " +
        (p.ERROR    || 0) + " ERROR");
    });

    if ((conteo.CREATED || 0) > 0) {
      Logger.log("\n→ Hay " + conteo.CREATED + " aula(s) CREATED.");
      Logger.log("  Para archivarlas: archivarAulas({ cohortCode: '" + (cohortCode || "XX26") + "', confirmar: true })");
    } else if ((conteo.ARCHIVED || 0) > 0) {
      Logger.log("\n✅ Todas las aulas de la ventana están ARCHIVED.");
      Logger.log("  Para restaurarlas: restaurarAulas({ cohortCode: '" + (cohortCode || "XX26") + "', confirmar: true })");
    }

    Logger.log("\n════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("❌ ERROR en diagnosticoArchivado: " + e.message);
  }
}
