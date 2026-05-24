/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 23_cierreVentana.gs
 * Versión: 1.1.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Orquestar el Cierre de Ventana Académica — la secuencia de 8 pasos que
 *   verifica el estado académico, auto-promueve notas desde Classroom,
 *   captura evidencia, notifica notas a los estudiantes y archiva las aulas.
 *   Parametrizado por (cohortCode, momentCode) — funciona para CUALQUIER ventana.
 *
 * FLUJO DE CIERRE (modo real — confirmar:true):
 *   PASO 0: Validar parámetros y disponibilidad de APIs
 *   PASO 1: Gate de entregas     — RETURNED + assignedGrade para cada actividad calificable
 *   PASO 2: Ascender notas       — Overall Grade de Classroom → GradeHistory (Fuente=CIERRE)
 *                                  Si ya existe Fuente=MANUAL → conserva el manual
 *   PASO 3: Snapshot             — backup de datos Classroom → hoja en Panel Académico
 *   PASO 4: Gate de notas        — todos los pares (StudentID, SubjectCode) tienen nota en GradeHistory
 *                                  Acepta Fuente=MANUAL (prioridad) o Fuente=CIERRE
 *   PASO 5: Boletín final        — email HTML con notas a cada estudiante (opcional)
 *   PASO 6: Archivar aulas       — CREATED → ARCHIVED (delega a 22_archivarAulas.js)
 *   PASO 7: Registro de cierre   — fila de auditoría permanente en CIERRE_LOG
 *   PASO 8: Resumen en Logger
 *
 * FUENTE EN GRADEHISTORY:
 *   MANUAL  → cargada manualmente desde el Panel (prioridad absoluta — nunca se sobreescribe)
 *   CIERRE  → auto-promovida desde Classroom al ejecutar cerrarVentana() (idempotente)
 *
 * EN MODO DRY RUN (dryRun:true):
 *   Solo ejecuta PASO 1 y PASO 4 (reporte de gates) + muestra el plan.
 *   Sin escrituras, sin emails, sin archivado.
 *
 * CÁLCULO DE NOTA FINAL (PASO 2):
 *   Lee gradebookSettings del curso → soporta dos modos:
 *   TOTAL_POINTS:       promedio ponderado por maxPoints de notas normalizadas a 1-5
 *   WEIGHTED_CATEGORIES: promedio ponderado por peso de categoría
 *   Normalización vía _normalizarNota_() de 20_semaforo.js (scope global GAS).
 *
 * REGLAS CRÍTICAS:
 *   ◆ PROHIBIDO Classroom.Courses.delete() — archivado es la ÚNICA vía de cierre.
 *   ◆ MANUAL > CIERRE: la nota manual nunca se sobreescribe automáticamente.
 *   ◆ NADA hardcodeado — todo parametrizado por (cohortCode, momentCode).
 *   ◆ dryRun en toda operación con efectos secundarios.
 *   ◆ try-catch en TODAS las llamadas a API.
 *   ◆ Idempotencia: re-ejecutar cerrarVentana() es seguro — sobreescribe CIERRE, conserva MANUAL.
 *   ◆ Lock cubre PASOS 1-5. PASO 6 (archivarAulas) tiene su propio lock.
 *
 * FUNCIONES PÚBLICAS:
 *   cerrarVentana(opts)                → orquestador principal
 *   menuPreviewCierreVentana()         → wrapper de menú — dryRun:true con UI prompts
 *   menuEjecutarCierreVentana()        → wrapper de menú — ejecución real con confirmación
 *
 * FUNCIONES PRIVADAS:
 *   _gateRetornadas_(...)              → PASO 1: verifica RETURNED + assignedGrade en Classroom
 *   _ascenderNotasDeClassroom_(...)    → PASO 2: Overall Grade → GradeHistory Fuente=CIERRE
 *   _calcularNotaFinalClassroom_(...)  → helper de cálculo (Total Points / Weighted Categories)
 *   _snapshotSoporte_(...)             → PASO 3: backup Classroom → hoja en Panel
 *   _gateGradeHistory_(...)            → PASO 4: verifica notas MANUAL|CIERRE en GradeHistory
 *   _enviarBoletinFinal_(...)          → PASO 5: email HTML con notas finales
 *   _setupCierreLogHoja_(adminSS)      → crea hoja CIERRE_LOG si no existe
 *   _registrarCierreLog_(...)          → añade fila de auditoría a CIERRE_LOG
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.js  → SIDEP_CONFIG, nowSIDEP(), uuid()
 *   02_SIDEP_HELPERS.js → getSpreadsheetByName()
 *   14_crearAulas.js    → COL_DEP (índices 0-based de MasterDeployments)
 *   20_semaforo.js      → _normalizarNota_(), _calcularNivel_(), CFG_SEMAFORO (scope global)
 *   22_archivarAulas.js → archivarAulas()
 *   Google Classroom API v1 (habilitar en Editor → ➕ Servicios avanzados)
 *   GmailApp (servicio básico de GAS)
 *
 * VERSIÓN: 1.1.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-05-23
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// ÍNDICES DE COLUMNA (0-based, espejo de 01_SIDEP_TABLES.js)
// Solo se declaran las tablas que este archivo lee directamente.
// COL_DEP se importa desde 14_crearAulas.js (scope global GAS).
// ─────────────────────────────────────────────────────────────

// GradeHistory (ADMIN) — 14 columnas
var COL_GH = {
  GradeHistoryID:   0,
  StudentID:        1,
  SubjectCode:      2,
  SubjectName:      3,
  ProgramCode:      4,
  EntryCohortCode:  5,
  WindowCohortCode: 6,
  MomentCode:       7,
  Nota:             8,
  Nivel:            9,
  Estado:           10,
  Fuente:           11,
  CreatedAt:        12,
  CreatedBy:        13
};

// Enrollments (ADMIN) — 13 columnas
var COL_ENR = {
  EnrollmentID:         0,
  StudentID:            1,
  DeploymentID:         2,
  AperturaID:           3,
  EntryCohortCode:      4,
  WindowCohortCode:     5,
  MomentCode:           6,
  AttemptNumber:        7,
  EnrollmentStatusCode: 8,
  CreatedAt:            9,
  CreatedBy:            10,
  UpdatedAt:            11,
  UpdatedBy:            12
};

// Students (ADMIN) — 18 columnas
var COL_STU = {
  StudentID:         0,
  DocumentType:      1,
  DocumentNumber:    2,
  StudentType:       3,
  FirstName:         4,
  LastName:          5,
  Phone:             6,
  Email:             7,
  CohortCode:        8,
  ProgramCode:       9,
  CampusCode:        10,
  StudentStatusCode: 11,
  CompletionStatus:  12,
  GraduationDate:    13,
  CreatedAt:         14,
  CreatedBy:         15,
  UpdatedAt:         16,
  UpdatedBy:         17
};

// Columnas de CIERRE_LOG — tabla de auditoría de cierres
var CIERRE_LOG_COLS = [
  "CierreLogID",        // TEXT — PK — "clg_<uuid>"
  "CohortCode",         // ventana cerrada
  "MomentCode",         // momento cerrado (vacío si se cerró toda la ventana)
  "ProgramCode",        // programa (vacío si se cerró todos los programas)
  "Action",             // FULL_CLOSE | PREVIEW (dryRun)
  "Result",             // OK | GATE1_FAIL | GATE2_FAIL | ERROR | DRY_RUN
  "AulasTarget",        // deployments en scope de la operación
  "AulasArchivadas",    // efectivamente archivadas (0 si gate falló)
  "FaltantesGate1",     // actividades sin RETURNED (0 si gate pasó)
  "FaltantesGate2",     // pares (StudentID, SubjectCode) sin nota MANUAL (0 si gate pasó)
  "BoletinesEnviados",  // emails de boletín enviados
  "Message",            // resumen legible o mensaje de error
  "ExecutedAt",
  "ExecutedBy"
];


// ─────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * Orquestador del Cierre de Ventana Académica.
 * Ejecuta los 8 pasos del cierre en secuencia con compuertas de seguridad.
 *
 * @param {Object}  opts
 * @param {string}  opts.cohortCode       — ventana a cerrar (OBLIGATORIO, ej. "MR26")
 * @param {string}  [opts.momentCode]     — filtrar por momento (default: todos)
 * @param {string}  [opts.programCode]    — filtrar por programa (default: todos)
 * @param {boolean} [opts.dryRun]         — true: reporte de gates sin ejecutar cambios
 * @param {boolean} [opts.confirmar]      — true: ejecutar en real (requerido si dryRun=false)
 * @param {boolean} [opts.enviarBoletin]  — true: enviar email de notas finales (PASO 4)
 */
function cerrarVentana(opts) {
  var options       = opts || {};
  var cohortCode    = options.cohortCode;
  var momentCode    = options.momentCode    || null;
  var programCode   = options.programCode   || null;
  var dryRun        = options.dryRun        === true;
  var confirmar     = options.confirmar     === true;
  var enviarBoletin = options.enviarBoletin === true;
  var ahora         = nowSIDEP();
  var ejecutor      = Session.getEffectiveUser().getEmail();

  Logger.log("╔═══════════════════════════════════════════════╗");
  Logger.log("║  SIDEP — Cierre de Ventana Académica v1.0.0  ║");
  if (dryRun) Logger.log("║  ⚠️  MODO DRY RUN — sin efectos reales         ║");
  Logger.log("╚═══════════════════════════════════════════════╝");
  Logger.log("  cohort   : " + (cohortCode  || "⛔ OBLIGATORIO"));
  Logger.log("  momento  : " + (momentCode  || "todos"));
  Logger.log("  programa : " + (programCode || "todos"));
  Logger.log("  boletín  : " + (enviarBoletin ? "sí" : "no"));
  Logger.log("  ejecutor : " + ejecutor);
  Logger.log("  hora     : " + Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "yyyy-MM-dd HH:mm:ss"));

  // ── PASO 0: Validar parámetros ────────────────────────────────────────────
  if (!cohortCode) {
    Logger.log("\n⛔ cohortCode es OBLIGATORIO.");
    Logger.log("   Ejemplo: cerrarVentana({ cohortCode: 'MR26', momentCode: 'C1M2', confirmar: true })");
    return;
  }

  if (!dryRun && !confirmar) {
    Logger.log("\n⚠️  Para ejecutar en real:  cerrarVentana({..., confirmar: true })");
    Logger.log("   Para preview sin cambios: cerrarVentana({..., dryRun: true })");
    return;
  }

  if (typeof Classroom === "undefined") {
    Logger.log("\n❌ Classroom API no habilitada.");
    Logger.log("   Editor GAS → ➕ Servicios → Google Classroom API v1 → Agregar");
    return;
  }

  // ── Cargar datos maestros en memoria (1 llamada por tabla) ───────────────
  var coreSS  = getSpreadsheetByName("core");
  var adminSS = getSpreadsheetByName("admin");

  var hojaDep = coreSS.getSheetByName("MasterDeployments");
  if (!hojaDep || hojaDep.getLastRow() <= 1) {
    Logger.log("⛔ MasterDeployments vacía o inexistente.");
    return;
  }

  var depData = hojaDep.getRange(2, 1, hojaDep.getLastRow() - 1, 17).getValues();

  // Filtrar deployments en scope de esta operación
  var ventanaDeployments = depData.filter(function(row) {
    if (row[COL_DEP.CohortCode]  !== cohortCode)           return false;
    if (momentCode  && row[COL_DEP.MomentCode]  !== momentCode)  return false;
    if (programCode && row[COL_DEP.ProgramCode] !== programCode) return false;
    return true;
  });

  // Solo las CREATED son candidatas a archivar y a verificar en el gate
  var aulasCreated = ventanaDeployments.filter(function(r) {
    return r[COL_DEP.ScriptStatusCode] === "CREATED";
  });

  Logger.log("\n  Deployments en ventana : " + ventanaDeployments.length);
  Logger.log("  → CREATED (a archivar) : " + aulasCreated.length);
  Logger.log("  → ARCHIVED (ya hechas) : " +
    ventanaDeployments.filter(function(r) { return r[COL_DEP.ScriptStatusCode] === "ARCHIVED"; }).length);

  if (ventanaDeployments.length === 0) {
    Logger.log("\n⚠️  No se encontraron deployments para cohort=" + cohortCode +
      (momentCode ? " momento=" + momentCode : "") + ".");
    return;
  }

  // Variables de estado compartidas entre pasos
  var resultGate1 = null;
  var resultGate2 = null;
  var archivadas  = 0;
  var boletines   = 0;
  var resultFinal = "OK";

  // ── Lock cubre PASOS 1-5 (gates + ascenso + snapshot + gate notas + boletín) ─
  // PASO 6 (archivarAulas) tiene su propio lock — el lock se libera antes de llamarlo.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    Logger.log("\n⚠️  Lock ocupado — otra ejecución está activa. Espera 30s e intenta de nuevo.");
    return;
  }
  Logger.log("\n🔐 Lock adquirido — iniciando secuencia de cierre");

  try {

    // ── PASO 1: Gate de entregas ──────────────────────────────────────────
    Logger.log("\n────────────────────────────────────────────────");
    Logger.log("PASO 1 — Gate de entregas (RETURNED + assignedGrade)");
    Logger.log("────────────────────────────────────────────────");

    resultGate1 = _gateRetornadas_(aulasCreated);

    if (!resultGate1.ok) {
      if (resultGate1.sinRetornar.length > 0) {
        Logger.log("🚧 Gate 1 FALLA — entregas aún no retornadas por el docente (TURNED_IN):");
        resultGate1.sinRetornar.forEach(function(f) {
          Logger.log("   ✗ " + f.nomenc + " | " + f.cwTitle +
            " | sin retornar: " + f.sinRetornar + "/" + f.total);
        });
      }
      if (resultGate1.sinCalificar.length > 0) {
        Logger.log("🚧 Gate 1 FALLA — entregas retornadas pero sin calificación (assignedGrade=null):");
        resultGate1.sinCalificar.forEach(function(f) {
          Logger.log("   ✗ " + f.nomenc + " | " + f.cwTitle +
            " | sin nota: " + f.sinCalificar + "/" + f.total);
        });
      }

      if (!dryRun) {
        resultFinal = "GATE1_FAIL";
        var g1msg = [];
        if (resultGate1.sinRetornar.length)  g1msg.push(resultGate1.sinRetornar.length + " actividad(es) con TURNED_IN");
        if (resultGate1.sinCalificar.length) g1msg.push(resultGate1.sinCalificar.length + " actividad(es) retornadas sin nota");
        Logger.log("\n⛔ Cierre abortado. Docentes deben retornar Y calificar todas las entregas.");
        _registrarCierreLog_(adminSS, {
          cohortCode: cohortCode, momentCode: momentCode, programCode: programCode,
          action: "FULL_CLOSE", result: resultFinal,
          aulasTarget: ventanaDeployments.length, aulasArchivadas: 0,
          faltantesGate1: resultGate1.sinRetornar.length + resultGate1.sinCalificar.length,
          faltantesGate2: 0, boletinesEnviados: 0,
          message: "Gate 1 falló: " + g1msg.join("; "),
          ejecutadoEn: ahora, ejecutadoPor: ejecutor
        });
        return;
      }
    } else {
      Logger.log("✅ Gate 1 OK — " + resultGate1.totalCw + " actividades, " +
        resultGate1.totalSubs + " entregas, todas RETURNED y calificadas.");
    }

    // ── PASO 2: Ascender notas de Classroom → GradeHistory ───────────────
    Logger.log("\n────────────────────────────────────────────────");
    Logger.log("PASO 2 — Ascender notas (Overall Grade → GradeHistory Fuente=CIERRE)");
    Logger.log("────────────────────────────────────────────────");

    var resultAscenso = { ascendidas: 0, omitidas: 0, errores: 0 };
    if (dryRun) {
      Logger.log("[DRY RUN] Se calcularía el Overall Grade de Classroom para cada estudiante");
      Logger.log("  y se escribiría en GradeHistory (Fuente=CIERRE).");
      Logger.log("  Las filas con Fuente=MANUAL existentes se conservarían intactas.");
    } else {
      resultAscenso = _ascenderNotasDeClassroom_(
        aulasCreated, cohortCode, momentCode, programCode, coreSS, adminSS, ahora
      );
      if (resultAscenso.errores > 0) {
        Logger.log("  ⚠️  " + resultAscenso.errores + " estudiante(s) sin nota calculable — Gate 2 los detectará.");
      }
    }

    // ── PASO 3: Snapshot de soporte ───────────────────────────────────────
    Logger.log("\n────────────────────────────────────────────────");
    Logger.log("PASO 3 — Snapshot de soporte (Classroom → Sheet)");
    Logger.log("────────────────────────────────────────────────");

    if (dryRun) {
      Logger.log("[DRY RUN] Snapshot: se crearía hoja SNAPSHOT_" +
        cohortCode + "_" + (momentCode || "ALL") + " en Panel Académico");
    } else {
      _snapshotSoporte_(aulasCreated, cohortCode, momentCode, ahora);
    }

    // ── PASO 4: Gate de notas ─────────────────────────────────────────────
    Logger.log("\n────────────────────────────────────────────────");
    Logger.log("PASO 4 — Gate de notas (GradeHistory Fuente=MANUAL|CIERRE)");
    Logger.log("────────────────────────────────────────────────");

    resultGate2 = _gateGradeHistory_(cohortCode, momentCode, programCode, coreSS, adminSS);

    if (!resultGate2.ok) {
      Logger.log("🚧 Gate 2 FALLA — pares (StudentID, SubjectCode) sin nota en GradeHistory:");
      resultGate2.faltantes.slice(0, 10).forEach(function(f) {
        Logger.log("   ✗ " + f.studentId + " | " + f.subjectCode);
      });
      if (resultGate2.faltantes.length > 10) {
        Logger.log("   ... y " + (resultGate2.faltantes.length - 10) + " más (ver CIERRE_LOG).");
      }

      if (!dryRun) {
        resultFinal = "GATE2_FAIL";
        Logger.log("\n⛔ Cierre abortado. Estudiantes sin nota calculable — verificar que tienen actividades en Classroom.");
        _registrarCierreLog_(adminSS, {
          cohortCode: cohortCode, momentCode: momentCode, programCode: programCode,
          action: "FULL_CLOSE", result: resultFinal,
          aulasTarget: ventanaDeployments.length, aulasArchivadas: 0,
          faltantesGate1: 0, faltantesGate2: resultGate2.faltantes.length,
          boletinesEnviados: 0,
          message: "Gate 2 falló: " + resultGate2.faltantes.length +
            " par(es) sin nota en GradeHistory tras ascenso",
          ejecutadoEn: ahora, ejecutadoPor: ejecutor
        });
        return;
      }
    } else {
      Logger.log("✅ Gate 2 OK — " + resultGate2.esperados +
        " pares (StudentID, SubjectCode) con nota en GradeHistory.");
    }

    // ── Resumen del dry run ───────────────────────────────────────────────
    if (dryRun) {
      Logger.log("\n════════════════════════════════════════════════");
      Logger.log("RESUMEN DRY RUN — " + cohortCode + (momentCode ? " · " + momentCode : ""));
      Logger.log("  Gate 1 (RETURNED+calificado): " +
        (resultGate1.ok
          ? "✅ OK"
          : "🚧 FALLA (TI=" + resultGate1.sinRetornar.length + " | SinNota=" + resultGate1.sinCalificar.length + ")"));
      Logger.log("  Gate 2 (notas GradeHistory):  " +
        (resultGate2.ok ? "✅ OK" : "🚧 FALLA (" + resultGate2.faltantes.length + " par(es) faltante(s))"));
      Logger.log("  Aulas CREATED a archivar      : " + aulasCreated.length);
      Logger.log("  Boletines a enviar            : " +
        (enviarBoletin ? "~" + resultGate2.esperados + " estudiante(s)" : "no solicitado"));
      Logger.log("\n  Para ejecutar el cierre real:");
      Logger.log("  cerrarVentana({");
      Logger.log("    cohortCode: '" + cohortCode + "'" +
        (momentCode  ? ",\n    momentCode: '" + momentCode + "'"   : "") +
        (programCode ? ",\n    programCode: '" + programCode + "'" : "") +
        (enviarBoletin ? ",\n    enviarBoletin: true" : "") + ",");
      Logger.log("    confirmar: true");
      Logger.log("  })");
      Logger.log("════════════════════════════════════════════════");

      _registrarCierreLog_(adminSS, {
        cohortCode: cohortCode, momentCode: momentCode, programCode: programCode,
        action: "PREVIEW", result: "DRY_RUN",
        aulasTarget: ventanaDeployments.length, aulasArchivadas: 0,
        faltantesGate1: resultGate1.sinRetornar.length + resultGate1.sinCalificar.length,
        faltantesGate2: resultGate2.faltantes.length,
        boletinesEnviados: 0,
        message: "Preview: gate1=" + (resultGate1.ok ? "OK" : "FALLA") +
          " gate2=" + (resultGate2.ok ? "OK" : "FALLA"),
        ejecutadoEn: ahora, ejecutadoPor: ejecutor
      });
      return;
    }

    // ── PASO 5: Boletín final ─────────────────────────────────────────────
    Logger.log("\n────────────────────────────────────────────────");
    if (enviarBoletin) {
      Logger.log("PASO 5 — Boletín final (email de notas a estudiantes)");
      Logger.log("────────────────────────────────────────────────");
      boletines = _enviarBoletinFinal_(cohortCode, momentCode, programCode, coreSS, adminSS, ahora);
    } else {
      Logger.log("PASO 5 — Boletín omitido (enviarBoletin no solicitado)");
      Logger.log("  Para enviar: cerrarVentana({..., enviarBoletin: true, confirmar: true })");
    }

  } catch (e) {
    resultFinal = "ERROR";
    Logger.log("\n❌ ERROR en pasos 1-5: " + e.message);
    throw e;
  } finally {
    // Liberar lock antes de archivarAulas — esa función tiene su propio lock.
    lock.releaseLock();
    Logger.log("\n🔓 Lock liberado (preparación completada)");
  }

  // ── PASO 6: Archivar aulas ────────────────────────────────────────────
  // Fuera del lock de cerrarVentana — archivarAulas() adquiere su propio lock.
  Logger.log("\n────────────────────────────────────────────────");
  Logger.log("PASO 6 — Archivar aulas");
  Logger.log("────────────────────────────────────────────────");

  try {
    archivarAulas({
      cohortCode:  cohortCode,
      momentCode:  momentCode,
      programCode: programCode,
      dryRun:      false,
      confirmar:   true
    });

    // Re-leer MasterDeployments para contar las que efectivamente quedaron ARCHIVED
    var hojaDepPost = coreSS.getSheetByName("MasterDeployments");
    var depDataPost = hojaDepPost.getRange(2, 1, hojaDepPost.getLastRow() - 1, 17).getValues();
    archivadas = depDataPost.filter(function(row) {
      if (row[COL_DEP.CohortCode]  !== cohortCode)           return false;
      if (momentCode  && row[COL_DEP.MomentCode]  !== momentCode)  return false;
      if (programCode && row[COL_DEP.ProgramCode] !== programCode) return false;
      return row[COL_DEP.ScriptStatusCode] === "ARCHIVED";
    }).length;

  } catch (archErr) {
    resultFinal = "ERROR";
    Logger.log("❌ Error en archivarAulas: " + archErr.message);
    // Continuar para registrar el log de auditoría
  }

  // ── PASO 7: Registrar en CIERRE_LOG ──────────────────────────────────
  Logger.log("\n────────────────────────────────────────────────");
  Logger.log("PASO 7 — Registro de auditoría (CIERRE_LOG)");
  Logger.log("────────────────────────────────────────────────");

  _registrarCierreLog_(adminSS, {
    cohortCode:        cohortCode,
    momentCode:        momentCode,
    programCode:       programCode,
    action:            "FULL_CLOSE",
    result:            resultFinal,
    aulasTarget:       ventanaDeployments.length,
    aulasArchivadas:   archivadas,
    faltantesGate1:    resultGate1 ? (resultGate1.sinRetornar.length + resultGate1.sinCalificar.length) : 0,
    faltantesGate2:    resultGate2 ? resultGate2.faltantes.length : 0,
    boletinesEnviados: boletines,
    message:           "Cierre " + (resultFinal === "OK" ? "completado" : "con error: " + resultFinal) +
      " — " + archivadas + "/" + ventanaDeployments.length + " aulas archivadas" +
      (boletines > 0 ? ", " + boletines + " boletines enviados" : ""),
    ejecutadoEn:  ahora,
    ejecutadoPor: ejecutor
  });

  // ── PASO 8: Resumen final ─────────────────────────────────────────────
  Logger.log("\n╔═══════════════════════════════════════════════╗");
  Logger.log("║  CIERRE COMPLETADO — " + cohortCode +
    (momentCode ? " · " + momentCode : "               ") + "  ║");
  Logger.log("╚═══════════════════════════════════════════════╝");
  Logger.log("  Aulas archivadas  : " + archivadas + " de " + ventanaDeployments.length);
  Logger.log("  Boletines enviados: " + boletines);
  Logger.log("  Resultado         : " + resultFinal);
  Logger.log("");
  Logger.log("  → El Semáforo ya no procesará estas aulas (ScriptStatusCode=ARCHIVED).");
  Logger.log("  → Los estudiantes conservan acceso de LECTURA al material archivado.");
  Logger.log("  → Para REABRIR la ventana:");
  Logger.log("    restaurarAulas({ cohortCode: '" + cohortCode + "'" +
    (momentCode ? ", momentCode: '" + momentCode + "'" : "") + ", confirmar: true })");
}


// ─────────────────────────────────────────────────────────────
// WRAPPERS DE MENÚ
// ─────────────────────────────────────────────────────────────

/**
 * Wrapper de menú: preview del cierre (dryRun=true).
 * Pide cohortCode y momentCode por UI, muestra reporte de gates en Logger.
 */
function menuPreviewCierreVentana() {
  var ui = SpreadsheetApp.getUi();

  var rCohort = ui.prompt(
    "Preview Cierre de Ventana",
    "Código de ventana (ej. MR26):",
    ui.ButtonSet.OK_CANCEL
  );
  if (rCohort.getSelectedButton() !== ui.Button.OK) return;
  var cohortCode = rCohort.getResponseText().trim().toUpperCase();
  if (!cohortCode) { ui.alert("Código de ventana vacío. Operación cancelada."); return; }

  var rMoment = ui.prompt(
    "Preview Cierre de Ventana",
    "Código de momento (ej. C1M2) — dejar vacío para todos los momentos:",
    ui.ButtonSet.OK_CANCEL
  );
  if (rMoment.getSelectedButton() !== ui.Button.OK) return;
  var momentCode = rMoment.getResponseText().trim() || null;

  ui.alert("Ejecutando preview del cierre de " + cohortCode +
    (momentCode ? " · " + momentCode : "") +
    ".\n\nRevise el Log de Ejecución (menú Ver → Registros) para ver los resultados.");

  cerrarVentana({
    cohortCode: cohortCode,
    momentCode: momentCode,
    dryRun:     true
  });
}

/**
 * Wrapper de menú: ejecución real del cierre con prompts de UI y confirmación explícita.
 */
function menuEjecutarCierreVentana() {
  var ui = SpreadsheetApp.getUi();

  var rCohort = ui.prompt(
    "Cierre de Ventana Académica",
    "Código de ventana (ej. MR26):",
    ui.ButtonSet.OK_CANCEL
  );
  if (rCohort.getSelectedButton() !== ui.Button.OK) return;
  var cohortCode = rCohort.getResponseText().trim().toUpperCase();
  if (!cohortCode) { ui.alert("Código vacío. Operación cancelada."); return; }

  var rMoment = ui.prompt(
    "Cierre de Ventana Académica",
    "Código de momento (ej. C1M2) — dejar vacío para todos los momentos:",
    ui.ButtonSet.OK_CANCEL
  );
  if (rMoment.getSelectedButton() !== ui.Button.OK) return;
  var momentCode = rMoment.getResponseText().trim() || null;

  var rBoletin = ui.alert(
    "Boletín de notas",
    "¿Enviar el email de notas finales a los estudiantes como parte del cierre?",
    ui.ButtonSet.YES_NO
  );
  var enviarBoletin = (rBoletin === ui.Button.YES);

  // Confirmación de seguridad — el usuario escribe el código de ventana para confirmar
  var ventanaDesc = cohortCode + (momentCode ? " · " + momentCode : " (todos los momentos)");
  var rConfirm = ui.prompt(
    "⚠️  CONFIRMAR CIERRE",
    "Está a punto de ARCHIVAR las aulas de la ventana:\n\n" +
    "  " + ventanaDesc + "\n\n" +
    "Esta acción es REVERSIBLE con restaurarAulas().\n" +
    "Para confirmar, escriba el código de ventana (" + cohortCode + "):",
    ui.ButtonSet.OK_CANCEL
  );
  if (rConfirm.getSelectedButton() !== ui.Button.OK) { ui.alert("Cierre cancelado."); return; }
  if (rConfirm.getResponseText().trim().toUpperCase() !== cohortCode) {
    ui.alert("El código no coincide. Cierre cancelado por seguridad.");
    return;
  }

  ui.alert("Ejecutando cierre de " + ventanaDesc +
    ".\n\nRevise el Log de Ejecución (menú Ver → Registros) para ver el progreso.");

  cerrarVentana({
    cohortCode:   cohortCode,
    momentCode:   momentCode,
    dryRun:       false,
    confirmar:    true,
    enviarBoletin: enviarBoletin
  });
}


// ─────────────────────────────────────────────────────────────
// FUNCIONES PRIVADAS
// ─────────────────────────────────────────────────────────────

/**
 * PASO 1 — Gate de entregas.
 * Verifica dos condiciones para que la auto-promoción de notas sea posible:
 *   1. No hay submissions TURNED_IN no excused — el docente retornó todas las entregas.
 *   2. No hay submissions RETURNED sin assignedGrade no excused — el docente calificó todo.
 * Solo evalúa CourseWork PUBLISHED con maxPoints > 0.
 *
 * EXCUSED: la API de Classroom devuelve sub.excused===true para entregas dispensadas.
 *   El docente las marca como "excused" en el gradebook; no bloquean el cierre y
 *   Classroom tampoco las incluye en el cálculo del Overall Grade.
 *
 * @param {Array} aulasCreated — filas de MasterDeployments (CREATED de la ventana)
 * @returns {{ ok: boolean, sinRetornar: Array, sinCalificar: Array, totalCw: number, totalSubs: number, apiErrores: number }}
 *   sinRetornar: actividades con TURNED_IN no excused (docente no retornó)
 *   sinCalificar: actividades con RETURNED sin assignedGrade no excused (docente no calificó)
 */
function _gateRetornadas_(aulasCreated) {
  var sinRetornar  = [];   // TURNED_IN — el docente no retornó
  var sinCalificar = [];   // RETURNED sin assignedGrade — el docente retornó sin calificar
  var apiErrores   = 0;
  var totalCw      = 0;
  var totalSubs    = 0;

  aulasCreated.forEach(function(row) {
    var classId = row[COL_DEP.ClassroomID];
    var nomenc  = row[COL_DEP.GeneratedNomenclature];

    if (!classId) {
      Logger.log("  ⚠️  Sin ClassroomID: " + nomenc + " — omitida del gate");
      return;
    }

    // Leer todas las actividades del aula (con paginación)
    var cwList = [];
    try {
      var pageToken = null;
      do {
        var params = { pageSize: 100 };
        if (pageToken) params.pageToken = pageToken;
        var cwResp = Classroom.Courses.CourseWork.list(classId, params);
        if (cwResp && cwResp.courseWork) cwList = cwList.concat(cwResp.courseWork);
        pageToken = cwResp ? (cwResp.nextPageToken || null) : null;
        if (pageToken) Utilities.sleep(100);
      } while (pageToken);
      Utilities.sleep(100);
    } catch (e) {
      apiErrores++;
      Logger.log("  ⚠️  No se pudo leer CourseWork de " + nomenc + ": " + e.message);
      return;
    }

    // Solo CourseWork PUBLISHED y con puntos contribuyen al Overall Grade
    var cwConPuntos = cwList.filter(function(cw) {
      return cw.state === "PUBLISHED" && (cw.maxPoints || 0) > 0;
    });
    totalCw += cwConPuntos.length;

    cwConPuntos.forEach(function(cw) {
      // Leer todas las entregas de esta actividad (con paginación)
      var subs = [];
      try {
        var subToken = null;
        do {
          var subParams = { pageSize: 100 };
          if (subToken) subParams.pageToken = subToken;
          var subsResp = Classroom.Courses.CourseWork.StudentSubmissions.list(
            classId, cw.id, subParams
          );
          if (subsResp && subsResp.studentSubmissions) subs = subs.concat(subsResp.studentSubmissions);
          subToken = subsResp ? (subsResp.nextPageToken || null) : null;
          if (subToken) Utilities.sleep(100);
        } while (subToken);
        totalSubs += subs.length;
        Utilities.sleep(100);
      } catch (e) {
        Logger.log("  ⚠️  No se pudo leer entregas de " + nomenc + " / " + (cw.title || cw.id) + ": " + e.message);
        apiErrores++;
        return;
      }

      // Verificación 1: submissions aún no retornadas por el docente
      // Se excluyen las marcadas como "excused" en el gradebook de Classroom:
      // la API las devuelve con state=TURNED_IN y sub.excused===true pero
      // no bloquean el cierre porque el docente las dispensó intencionalmente.
      var pendientesRetorno = subs.filter(function(s) {
        return s.state === "TURNED_IN" && !s.excused;
      });
      if (pendientesRetorno.length > 0) {
        sinRetornar.push({
          nomenc:      nomenc,
          cwTitle:     cw.title || cw.id,
          sinRetornar: pendientesRetorno.length,
          total:       subs.length
        });
      }

      // Verificación 2: submissions retornadas pero sin nota asignada
      // El docente puede "retornar" un trabajo sin haber puesto calificación.
      // En ese caso assignedGrade es null y no hay Overall Grade para ese estudiante.
      // Las submissions excused también quedan con assignedGrade=null — se excluyen.
      var returnedSinNota = subs.filter(function(s) {
        return s.state === "RETURNED" && !s.excused &&
               (s.assignedGrade === undefined || s.assignedGrade === null);
      });
      if (returnedSinNota.length > 0) {
        sinCalificar.push({
          nomenc:       nomenc,
          cwTitle:      cw.title || cw.id,
          sinCalificar: returnedSinNota.length,
          total:        subs.length
        });
      }
    });
  });

  var ok = sinRetornar.length === 0 && sinCalificar.length === 0;

  Logger.log("  Aulas verificadas   : " + aulasCreated.length);
  Logger.log("  Actividades (c/pts) : " + totalCw);
  Logger.log("  Entregas totales    : " + totalSubs);
  Logger.log("  Sin retornar (TI)   : " + sinRetornar.length + " actividad(es)");
  Logger.log("  Retornadas sin nota : " + sinCalificar.length + " actividad(es)");
  if (apiErrores > 0) Logger.log("  Errores de API      : " + apiErrores + " — verificar manualmente");

  return {
    ok:           ok,
    sinRetornar:  sinRetornar,
    sinCalificar: sinCalificar,
    totalCw:      totalCw,
    totalSubs:    totalSubs,
    apiErrores:   apiErrores
  };
}


/**
 * Helper para PASO 2 — Calcula la Nota Final de un estudiante en un aula de Classroom.
 * Replica el algoritmo de Overall Grade según gradebookSettings.calculationType.
 *
 * TOTAL_POINTS:
 *   notaFinal = Σ(notaNorm_i × maxPoints_i) / Σ(maxPoints_i)
 *   donde notaNorm_i = _normalizarNota_(assignedGrade_i, maxPoints_i)
 *   Actividades sin entrega calificada (assignedGrade=null) se omiten del cálculo,
 *   igual que hace Classroom.
 *
 * WEIGHTED_CATEGORIES:
 *   Por categoría → promedio ponderado por maxPoints (normalizado 1–5).
 *   notaFinal = Σ(notaCat_k × peso_k) / Σ(peso_k)
 *   Actividades sin categoría se excluyen (Classroom las ignora en este modo).
 *
 * @param {Array}  cwCalificables — CourseWork[] PUBLISHED con maxPoints > 0
 * @param {Array}  studentSubs    — StudentSubmission[] del estudiante en el curso
 * @param {string} calculationType — "TOTAL_POINTS" | "WEIGHTED_CATEGORIES"
 * @param {Object} catById        — { catId: { name, weight } } — índice de gradeCategories
 * @returns {number|null} nota en escala 1.0–5.0 (2 decimales), o null si no calculable
 */
function _calcularNotaFinalClassroom_(cwCalificables, studentSubs, calculationType, catById) {

  // Índice CourseWork ID → assignedGrade del estudiante
  var gradeById = {};
  studentSubs.forEach(function(sub) {
    if (sub.courseWorkId && sub.assignedGrade != null) {
      gradeById[sub.courseWorkId] = Number(sub.assignedGrade);
    }
  });

  if (calculationType === "TOTAL_POINTS") {
    // Promedio ponderado por maxPoints de notas normalizadas a escala 1–5
    var sumPeso = 0;
    var sumPond = 0;

    cwCalificables.forEach(function(cw) {
      var rawGrade = gradeById[cw.id];
      if (rawGrade == null) return; // sin entrega calificada — Classroom tampoco la cuenta

      var notaNorm = _normalizarNota_(rawGrade, cw.maxPoints);
      if (notaNorm == null) return;

      var maxPts = Number(cw.maxPoints);
      sumPond += notaNorm * maxPts;
      sumPeso += maxPts;
    });

    if (sumPeso === 0) return null;
    return Math.round((sumPond / sumPeso) * 100) / 100;

  } else if (calculationType === "WEIGHTED_CATEGORIES") {
    // Paso 1: por categoría, calcular promedio ponderado por maxPoints (normalizado 1–5)
    // Paso 2: ponderar categorías por su weight
    var porCategoria = {}; // catId → { sumPeso, sumPond, weight }

    cwCalificables.forEach(function(cw) {
      var rawGrade = gradeById[cw.id];
      if (rawGrade == null) return;

      var catId = cw.gradeCategoryId || null;
      if (!catId || !catById[catId]) return; // sin categoría → excluir (Classroom las omite)

      var notaNorm = _normalizarNota_(rawGrade, cw.maxPoints);
      if (notaNorm == null) return;

      if (!porCategoria[catId]) {
        porCategoria[catId] = { sumPeso: 0, sumPond: 0, weight: catById[catId].weight || 0 };
      }
      var maxPts = Number(cw.maxPoints);
      porCategoria[catId].sumPeso += maxPts;
      porCategoria[catId].sumPond += notaNorm * maxPts;
    });

    var sumPesoTotal = 0;
    var sumPondTotal = 0;

    Object.keys(porCategoria).forEach(function(catId) {
      var cat = porCategoria[catId];
      if (cat.sumPeso === 0 || cat.weight === 0) return;
      var notaCat = cat.sumPond / cat.sumPeso; // nota de la categoría en escala 1–5
      sumPondTotal += notaCat * cat.weight;
      sumPesoTotal += cat.weight;
    });

    if (sumPesoTotal === 0) return null;
    var notaFinal = sumPondTotal / sumPesoTotal;
    // Clamp por posibles errores de punto flotante en el límite superior/inferior
    notaFinal = Math.max(CFG_SEMAFORO.ESCALA_MIN, Math.min(CFG_SEMAFORO.ESCALA_MAX, notaFinal));
    return Math.round(notaFinal * 100) / 100;

  } else {
    // NO_OVERALL_GRADE u otro tipo no reconocido → sin nota calculable
    return null;
  }
}


/**
 * PASO 2 — Ascender notas desde Classroom hacia GradeHistory (Fuente=CIERRE).
 * Para cada aula CREATED de la ventana:
 *   1. Lee gradebookSettings del curso (calculationType + gradeCategories).
 *   2. Lee CourseWork PUBLISHED con maxPoints > 0.
 *   3. Para cada estudiante matriculado ACTIVE:
 *      a. Lee sus StudentSubmissions en el curso (todas las actividades, 1 llamada).
 *      b. Calcula la Nota Final via _calcularNotaFinalClassroom_().
 *      c. Fuente=MANUAL existente → conservar (nunca sobreescribir).
 *      d. Fuente=CIERRE existente → actualizar (idempotencia del cierre).
 *      e. Sin nota en GradeHistory → acumular para batch insert al final del aula.
 *
 * ⚠️  Cuota Classroom: ~2 + N_estudiantes llamadas por aula (get + list + N×subs).
 *   Para cohortes de <100 estudiantes y <10 aulas queda dentro del timeout de 6 min de GAS.
 *
 * @param {Array}       aulasCreated — filas de MasterDeployments (ScriptStatusCode=CREATED)
 * @param {string}      cohortCode
 * @param {string}      momentCode
 * @param {string}      programCode
 * @param {Spreadsheet} coreSS
 * @param {Spreadsheet} adminSS
 * @param {Date}        ahora
 * @returns {{ ascendidas: number, omitidas: number, errores: number }}
 *   ascendidas: filas insertadas o actualizadas con Fuente=CIERRE
 *   omitidas:   estudiantes con Fuente=MANUAL conservados intactos
 *   errores:    estudiantes sin nota calculable o con error de API
 */
function _ascenderNotasDeClassroom_(aulasCreated, cohortCode, momentCode, programCode, coreSS, adminSS, ahora) {
  var ascendidas = 0;
  var omitidas   = 0;
  var errores    = 0;

  var ejecutor = Session.getEffectiveUser().getEmail();
  var ahoraFmt = Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "yyyy-MM-dd HH:mm:ss");

  // ── Leer Students en memoria — 1 llamada ─────────────────────────────
  var hojaEst = adminSS.getSheetByName("Students");
  if (!hojaEst || hojaEst.getLastRow() <= 1) {
    Logger.log("  ⛔ Students vacía — no se puede ascender notas");
    return { ascendidas: 0, omitidas: 0, errores: 1 };
  }
  var stuData = hojaEst.getRange(2, 1, hojaEst.getLastRow() - 1, 18).getValues();

  // Índice StudentID → email (para userId en la API de Classroom)
  var emailPorStu = {};
  stuData.forEach(function(row) {
    var sid   = row[COL_STU.StudentID];
    var email = row[COL_STU.Email];
    if (sid && email) emailPorStu[sid] = String(email).trim();
  });

  // ── Leer Enrollments en memoria — 1 llamada ───────────────────────────
  var hojaEnr = adminSS.getSheetByName("Enrollments");
  if (!hojaEnr || hojaEnr.getLastRow() <= 1) {
    Logger.log("  ⛔ Enrollments vacía — no se puede ascender notas");
    return { ascendidas: 0, omitidas: 0, errores: 1 };
  }
  var enrData = hojaEnr.getRange(2, 1, hojaEnr.getLastRow() - 1, 13).getValues();

  // Índice DeploymentID → [StudentID, ...] — solo matrículas ACTIVE de la ventana
  var estudiantesPorDep = {};
  enrData.forEach(function(row) {
    if (row[COL_ENR.WindowCohortCode]     !== cohortCode)           return;
    if (momentCode && row[COL_ENR.MomentCode] !== momentCode)       return;
    if (row[COL_ENR.EnrollmentStatusCode] !== "ACTIVE")             return;
    var depId = row[COL_ENR.DeploymentID];
    var stuId = row[COL_ENR.StudentID];
    if (!depId || !stuId) return;
    if (!estudiantesPorDep[depId]) estudiantesPorDep[depId] = [];
    estudiantesPorDep[depId].push(stuId);
  });

  // ── Leer GradeHistory en memoria — 1 llamada ─────────────────────────
  // ghManual: clave → true          (Fuente=MANUAL — nunca sobreescribir)
  // ghCierre: clave → rowIdx 1-based (Fuente=CIERRE — actualizar en el Sheet)
  var hojaGH   = adminSS.getSheetByName("GradeHistory");
  var ghManual = {};
  var ghCierre = {};

  if (hojaGH && hojaGH.getLastRow() > 1) {
    var ghData = hojaGH.getRange(2, 1, hojaGH.getLastRow() - 1, 14).getValues();
    ghData.forEach(function(row, idx) {
      if (row[COL_GH.WindowCohortCode] !== cohortCode)         return;
      if (momentCode && row[COL_GH.MomentCode] !== momentCode) return;
      var clave = row[COL_GH.StudentID] + "|" + row[COL_GH.SubjectCode];
      if      (row[COL_GH.Fuente] === "MANUAL") { ghManual[clave] = true; }
      else if (row[COL_GH.Fuente] === "CIERRE") { ghCierre[clave] = idx + 2; } // +2: 0-based + encabezado
    });
  }

  Logger.log("  Pares MANUAL existentes en GH : " + Object.keys(ghManual).length);
  Logger.log("  Pares CIERRE existentes en GH : " + Object.keys(ghCierre).length);

  // ── Procesar cada aula ───────────────────────────────────────────────
  aulasCreated.forEach(function(depRow) {
    var classId     = depRow[COL_DEP.ClassroomID];
    var depId       = depRow[COL_DEP.DeploymentID];
    var nomenc      = depRow[COL_DEP.GeneratedNomenclature];
    var subjCode    = depRow[COL_DEP.SubjectCode];
    var subjName    = depRow[COL_DEP.SubjectName]     || "";
    var progCode    = depRow[COL_DEP.ProgramCode]     || "";
    var entryCohort = depRow[COL_DEP.EntryCohortCode] || cohortCode;
    var momentDep   = depRow[COL_DEP.MomentCode]      || momentCode || "";

    if (!classId) {
      Logger.log("  ⚠️  Sin ClassroomID: " + nomenc + " — omitida");
      return;
    }

    var estudiantes = estudiantesPorDep[depId] || [];
    if (estudiantes.length === 0) {
      Logger.log("  ℹ️  Sin matrículas ACTIVE: " + nomenc + " — omitida");
      return;
    }

    // ── 1. Leer gradebookSettings del curso ───────────────────────────
    var calculationType = "TOTAL_POINTS";
    var catById = {};
    try {
      var courseInfo = Classroom.Courses.get(classId);
      var gbSettings = courseInfo.gradebookSettings || {};
      calculationType = gbSettings.calculationType || "TOTAL_POINTS";
      (gbSettings.gradeCategories || []).forEach(function(cat) {
        if (cat.id) catById[cat.id] = { name: cat.name || "", weight: cat.weight || 0 };
      });
      if (calculationType === "NO_OVERALL_GRADE") {
        Logger.log("  ⚠️  " + nomenc + ": NO_OVERALL_GRADE — sin nota final para " +
          estudiantes.length + " estudiante(s)");
        errores += estudiantes.length;
        return;
      }
      Utilities.sleep(100);
    } catch (e) {
      Logger.log("  ⚠️  No se pudo leer gradebookSettings de " + nomenc + ": " + e.message);
      errores += estudiantes.length;
      return;
    }

    // ── 2. Leer CourseWork PUBLISHED con maxPoints > 0 ────────────────
    var cwCalificables = [];
    try {
      var pageToken = null;
      do {
        var cwParams = { pageSize: 100 };
        if (pageToken) cwParams.pageToken = pageToken;
        var cwResp = Classroom.Courses.CourseWork.list(classId, cwParams);
        if (cwResp && cwResp.courseWork) cwCalificables = cwCalificables.concat(cwResp.courseWork);
        pageToken = cwResp ? (cwResp.nextPageToken || null) : null;
        if (pageToken) Utilities.sleep(100);
      } while (pageToken);
      cwCalificables = cwCalificables.filter(function(cw) {
        return cw.state === "PUBLISHED" && (cw.maxPoints || 0) > 0;
      });
      Utilities.sleep(100);
    } catch (e) {
      Logger.log("  ⚠️  No se pudo leer CourseWork de " + nomenc + ": " + e.message);
      errores += estudiantes.length;
      return;
    }

    if (cwCalificables.length === 0) {
      Logger.log("  ⚠️  " + nomenc + ": sin actividades calificables — sin nota para " +
        estudiantes.length + " estudiante(s)");
      errores += estudiantes.length;
      return;
    }

    Logger.log("  → " + nomenc + " (" + calculationType + ") | " +
      cwCalificables.length + " actividades | " + estudiantes.length + " estudiantes");

    // Acumular filas nuevas para batch insert al final del aula (minimiza llamadas a Sheets)
    var filasNuevas = [];

    // ── 3. Procesar cada estudiante ───────────────────────────────────
    estudiantes.forEach(function(stuId) {
      var clave = stuId + "|" + subjCode;

      // 3a. Fuente=MANUAL → conservar intacto (prioridad absoluta)
      if (ghManual[clave]) {
        omitidas++;
        return;
      }

      var email = emailPorStu[stuId];
      if (!email) {
        Logger.log("    ⚠️  Sin email para StudentID=" + stuId + " — no puede consultar Classroom");
        errores++;
        return;
      }

      // 3b. Leer submissions del estudiante (todas las actividades del curso — 1 llamada API)
      // userId puede ser email según la API de Classroom v1.
      var studentSubs = [];
      try {
        var subToken = null;
        do {
          var subParams = { userId: email, pageSize: 100 };
          if (subToken) subParams.pageToken = subToken;
          var subsResp = Classroom.Courses.CourseWork.StudentSubmissions.list(
            classId, "-", subParams
          );
          if (subsResp && subsResp.studentSubmissions) {
            studentSubs = studentSubs.concat(subsResp.studentSubmissions);
          }
          subToken = subsResp ? (subsResp.nextPageToken || null) : null;
          if (subToken) Utilities.sleep(100);
        } while (subToken);
        Utilities.sleep(100);
      } catch (e) {
        Logger.log("    ⚠️  No se pudo leer submissions de " + stuId + " en " + nomenc +
          ": " + e.message);
        errores++;
        return;
      }

      // 3c. Calcular Nota Final (Overall Grade en escala 1–5)
      var notaFinal = _calcularNotaFinalClassroom_(
        cwCalificables, studentSubs, calculationType, catById
      );

      if (notaFinal == null) {
        Logger.log("    ⚠️  Nota no calculable para " + stuId + " en " + nomenc +
          " — sin entregas calificadas");
        errores++;
        return;
      }

      var nivel  = _calcularNivel_(notaFinal);
      var estado = notaFinal >= CFG_SEMAFORO.UMBRAL_YELLOW ? "APROBADO" : "REPROBADO";

      // Construir fila de GradeHistory (14 columnas según COL_GH)
      var newRow = [
        uuid("gh"),     // GradeHistoryID
        stuId,          // StudentID
        subjCode,       // SubjectCode
        subjName,       // SubjectName
        progCode,       // ProgramCode
        entryCohort,    // EntryCohortCode
        cohortCode,     // WindowCohortCode
        momentDep,      // MomentCode
        notaFinal,      // Nota
        nivel,          // Nivel
        estado,         // Estado
        "CIERRE",       // Fuente
        ahoraFmt,       // CreatedAt
        ejecutor        // CreatedBy
      ];

      // 3d. Fuente=CIERRE existente → actualizar esa fila (idempotencia)
      if (ghCierre[clave]) {
        try {
          hojaGH.getRange(ghCierre[clave], 1, 1, newRow.length).setValues([newRow]);
          ascendidas++;
        } catch (e) {
          Logger.log("    ⚠️  Error actualizando GradeHistory fila " + ghCierre[clave] +
            ": " + e.message);
          errores++;
        }

      } else {
        // 3e. Sin nota previa → acumular para batch insert
        filasNuevas.push(newRow);
        ascendidas++;
      }
    });

    // ── Batch insert de las filas nuevas de este aula ─────────────────
    if (filasNuevas.length > 0) {
      try {
        if (!hojaGH) {
          // Caso extremo: hoja GradeHistory no existe aún — crearla
          hojaGH = adminSS.insertSheet("GradeHistory");
        }
        var startRow = hojaGH.getLastRow() + 1;
        hojaGH.getRange(startRow, 1, filasNuevas.length, filasNuevas[0].length)
          .setValues(filasNuevas);
      } catch (e) {
        Logger.log("  ❌ Error en batch insert GradeHistory para " + nomenc + ": " + e.message);
        errores    += filasNuevas.length;
        ascendidas -= filasNuevas.length; // descontar las contadas pero no escritas
      }
    }
  });

  Logger.log("  Notas ascendidas (CIERRE)    : " + ascendidas);
  Logger.log("  Omitidas (MANUAL conservado) : " + omitidas);
  Logger.log("  Sin nota calculable (errores): " + errores);

  return { ascendidas: ascendidas, omitidas: omitidas, errores: errores };
}


/**
 * PASO 3 — Snapshot de soporte.
 * Lee datos de Classroom (actividades + métricas de entregas) y los escribe en una hoja
 * "SNAPSHOT_{cohortCode}_{momentCode}" en el Panel Académico.
 * Evidencia permanente del estado del aula al momento del cierre.
 * No-bloqueante: si el Panel no existe, intenta escribir en adminSS como fallback.
 *
 * @param {Array}  aulasCreated — filas de MasterDeployments
 * @param {string} cohortCode
 * @param {string} momentCode
 * @param {Date}   ahora
 */
function _snapshotSoporte_(aulasCreated, cohortCode, momentCode, ahora) {
  var sheetName  = "SNAPSHOT_" + cohortCode + "_" + (momentCode || "ALL");
  var snapshotAt = Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "yyyy-MM-dd HH:mm:ss");
  var encabezados = [
    "CohortCode", "MomentCode", "Nomenclatura", "SubjectCode", "ProgramCode",
    "CourseWorkTitle", "MaxPoints", "TotalEntregas", "Returned", "TurnedIn",
    "Reclaimed", "NotStarted", "AvgGrade", "SnapshotAt"
  ];
  var filas = [];

  aulasCreated.forEach(function(row) {
    var classId  = row[COL_DEP.ClassroomID];
    var nomenc   = row[COL_DEP.GeneratedNomenclature];
    var subjCode = row[COL_DEP.SubjectCode];
    var progCode = row[COL_DEP.ProgramCode];
    var moment   = row[COL_DEP.MomentCode];

    if (!classId) { return; }

    // Leer actividades del aula
    var cwList = [];
    try {
      var pageToken = null;
      do {
        var params = { pageSize: 100 };
        if (pageToken) params.pageToken = pageToken;
        var cwResp = Classroom.Courses.CourseWork.list(classId, params);
        if (cwResp && cwResp.courseWork) cwList = cwList.concat(cwResp.courseWork);
        pageToken = cwResp ? (cwResp.nextPageToken || null) : null;
        if (pageToken) Utilities.sleep(100);
      } while (pageToken);
      Utilities.sleep(100);
    } catch (e) {
      Logger.log("  ⚠️  Snapshot: no se pudo leer CourseWork de " + nomenc + ": " + e.message);
      filas.push([
        cohortCode, moment, nomenc, subjCode, progCode,
        "ERROR_API: " + e.message.substring(0, 100), 0, 0, 0, 0, 0, 0, 0, snapshotAt
      ]);
      return;
    }

    var cwConPuntos = cwList.filter(function(cw) { return (cw.maxPoints || 0) > 0; });

    if (cwConPuntos.length === 0) {
      // Aula sin actividades calificables — dejar constancia
      filas.push([
        cohortCode, moment, nomenc, subjCode, progCode,
        "(sin actividades calificables)", 0, 0, 0, 0, 0, 0, 0, snapshotAt
      ]);
      return;
    }

    cwConPuntos.forEach(function(cw) {
      // Leer todas las entregas de esta actividad
      var subs = [];
      try {
        var subToken = null;
        do {
          var subParams = { pageSize: 100 };
          if (subToken) subParams.pageToken = subToken;
          var subsResp = Classroom.Courses.CourseWork.StudentSubmissions.list(
            classId, cw.id, subParams
          );
          if (subsResp && subsResp.studentSubmissions) subs = subs.concat(subsResp.studentSubmissions);
          subToken = subsResp ? (subsResp.nextPageToken || null) : null;
          if (subToken) Utilities.sleep(100);
        } while (subToken);
        Utilities.sleep(100);
      } catch (e) {
        Logger.log("  ⚠️  Snapshot: entregas no legibles de " + nomenc + "/" + (cw.title || cw.id) + ": " + e.message);
        // Seguir con subs vacío — queda registrado con ceros
      }

      var returned   = subs.filter(function(s) { return s.state === "RETURNED"; }).length;
      var turnedIn   = subs.filter(function(s) { return s.state === "TURNED_IN"; }).length;
      var reclaimed  = subs.filter(function(s) { return s.state === "RECLAIMED_BY_STUDENT"; }).length;
      var notStarted = subs.filter(function(s) { return s.state === "NEW" || s.state === "CREATED"; }).length;

      // Promedio solo de entregas RETURNED con assignedGrade definido
      var notasReturned = subs.filter(function(s) {
        return s.state === "RETURNED" && s.assignedGrade != null;
      }).map(function(s) { return Number(s.assignedGrade); });

      var avgGrade = notasReturned.length > 0
        ? Math.round((notasReturned.reduce(function(a, b) { return a + b; }, 0) / notasReturned.length) * 100) / 100
        : 0;

      filas.push([
        cohortCode, moment, nomenc, subjCode, progCode,
        cw.title || cw.id,
        cw.maxPoints || 0,
        subs.length, returned, turnedIn, reclaimed, notStarted,
        avgGrade,
        snapshotAt
      ]);
    });
  });

  Logger.log("  Filas de snapshot : " + filas.length);

  if (filas.length === 0) {
    Logger.log("  ℹ️  Sin datos para snapshot — no se creó la hoja.");
    return;
  }

  // Determinar dónde escribir el snapshot
  var targetSS = null;
  var panelId  = PropertiesService.getScriptProperties().getProperty("sidep_panelAcademicoId");

  if (panelId) {
    try {
      targetSS = SpreadsheetApp.openById(panelId);
    } catch (e) {
      Logger.log("  ⚠️  Panel Académico no accesible — fallback a adminSS: " + e.message);
    }
  }

  if (!targetSS) {
    Logger.log("  ℹ️  Panel Académico no disponible — snapshot en SIDEP_02_GESTION_ADMIN");
    try {
      targetSS = getSpreadsheetByName("admin");
    } catch (e) {
      Logger.log("  ⚠️  No se pudo escribir snapshot: " + e.message);
      return;
    }
  }

  // Crear o reemplazar hoja de snapshot
  var hojaSnap = targetSS.getSheetByName(sheetName);
  if (hojaSnap) {
    hojaSnap.clearContents();
  } else {
    hojaSnap = targetSS.insertSheet(sheetName);
  }

  // Escribir encabezados + datos en un solo batch
  var allRows = [encabezados].concat(filas);
  hojaSnap.getRange(1, 1, allRows.length, encabezados.length).setValues(allRows);

  hojaSnap.getRange(1, 1, 1, encabezados.length)
    .setFontWeight("bold")
    .setBackground("#1a73e8")
    .setFontColor("#ffffff");
  hojaSnap.setFrozenRows(1);

  Logger.log("  ✅ Snapshot guardado: '" + sheetName + "' en '" + targetSS.getName() + "'");
}


/**
 * PASO 4 — Gate de notas.
 * Verifica que todos los pares (StudentID, SubjectCode) derivados de matrículas ACTIVE
 * de la ventana tengan al menos una entrada en GradeHistory con Fuente=MANUAL o Fuente=CIERRE.
 * Las notas CIERRE son auto-promovidas por _ascenderNotasDeClassroom_() en PASO 2.
 * Las notas MANUAL (cargadas desde el Panel Académico) coexisten con prioridad absoluta.
 *
 * @param {string}      cohortCode
 * @param {string}      momentCode
 * @param {string}      programCode
 * @param {Spreadsheet} coreSS
 * @param {Spreadsheet} adminSS
 * @returns {{ ok: boolean, esperados: number, faltantes: Array }}
 */
function _gateGradeHistory_(cohortCode, momentCode, programCode, coreSS, adminSS) {

  // Leer Enrollments en memoria — 1 llamada
  var hojaEnr = adminSS.getSheetByName("Enrollments");
  if (!hojaEnr || hojaEnr.getLastRow() <= 1) {
    Logger.log("  ⚠️  Enrollments vacía — gate no puede verificar");
    return { ok: false, esperados: 0, faltantes: [{ studentId: "?", subjectCode: "Tabla Enrollments vacía o inexistente" }] };
  }
  var enrData = hojaEnr.getRange(2, 1, hojaEnr.getLastRow() - 1, 13).getValues();

  // Leer MasterDeployments en memoria — 1 llamada
  // Necesario para resolver DeploymentID → SubjectCode y ProgramCode
  var hojaDep = coreSS.getSheetByName("MasterDeployments");
  var depData = hojaDep.getRange(2, 1, hojaDep.getLastRow() - 1, 17).getValues();

  // Índice DeploymentID → { subjectCode, programCode } para lookup O(1)
  var depIdx = {};
  depData.forEach(function(row) {
    var depId = row[COL_DEP.DeploymentID];
    if (depId) {
      depIdx[depId] = {
        subjectCode: row[COL_DEP.SubjectCode],
        programCode: row[COL_DEP.ProgramCode]
      };
    }
  });

  // Construir el conjunto esperado de pares (StudentID, SubjectCode)
  // Clave compuesta: "StudentID|SubjectCode" para lookup O(1)
  var esperados = {};
  enrData.forEach(function(row) {
    if (row[COL_ENR.WindowCohortCode]     !== cohortCode)  return;
    if (momentCode && row[COL_ENR.MomentCode] !== momentCode) return;
    if (row[COL_ENR.EnrollmentStatusCode] !== "ACTIVE")    return;

    var studentId  = row[COL_ENR.StudentID];
    var deployId   = row[COL_ENR.DeploymentID];
    if (!studentId || !deployId) return;

    var depInfo = depIdx[deployId];
    if (!depInfo || !depInfo.subjectCode) return;

    // Si hay filtro de programa, excluir deployments de otros programas
    // (TRV = transversal, compartido por todos — siempre se incluye)
    if (programCode && depInfo.programCode !== programCode && depInfo.programCode !== "TRV") return;

    var clave = studentId + "|" + depInfo.subjectCode;
    esperados[clave] = { studentId: studentId, subjectCode: depInfo.subjectCode };
  });

  var totalEsperados = Object.keys(esperados).length;
  Logger.log("  Pares esperados (StudentID, SubjectCode): " + totalEsperados);

  if (totalEsperados === 0) {
    Logger.log("  ⚠️  No se encontraron matrículas ACTIVE para la ventana — gate no puede verificar.");
    return { ok: false, esperados: 0,
      faltantes: [{ studentId: "?", subjectCode: "Sin matrículas ACTIVE para cohort=" + cohortCode +
        (momentCode ? " momento=" + momentCode : "") }] };
  }

  // Leer GradeHistory en memoria — 1 llamada
  var hojaGH = adminSS.getSheetByName("GradeHistory");
  var ghSet   = {};

  if (hojaGH && hojaGH.getLastRow() > 1) {
    var ghData = hojaGH.getRange(2, 1, hojaGH.getLastRow() - 1, 14).getValues();
    ghData.forEach(function(row) {
      if (row[COL_GH.WindowCohortCode] !== cohortCode)            return;
      if (momentCode && row[COL_GH.MomentCode] !== momentCode)    return;
      if (row[COL_GH.Fuente] !== "MANUAL" && row[COL_GH.Fuente] !== "CIERRE") return;
      var clave = row[COL_GH.StudentID] + "|" + row[COL_GH.SubjectCode];
      ghSet[clave] = true;
    });
  }

  Logger.log("  Pares con Fuente=MANUAL|CIERRE en GradeHistory: " + Object.keys(ghSet).length);

  // Calcular faltantes: pares esperados que no tienen nota MANUAL ni CIERRE
  var faltantes = [];
  var claves = Object.keys(esperados);
  for (var i = 0; i < claves.length; i++) {
    if (!ghSet[claves[i]]) {
      faltantes.push(esperados[claves[i]]);
    }
  }

  Logger.log("  Pares faltantes: " + faltantes.length);

  return { ok: faltantes.length === 0, esperados: totalEsperados, faltantes: faltantes };
}


/**
 * PASO 5 — Boletín final de notas.
 * Envía un email HTML a cada estudiante con su tabla de notas finales del período.
 * Lee de GradeHistory (Fuente=MANUAL o CIERRE) — no envía links de aulas.
 * No-bloqueante por estudiante: si un email falla, se registra y se continúa.
 *
 * @param {string}      cohortCode
 * @param {string}      momentCode
 * @param {string}      programCode
 * @param {Spreadsheet} coreSS
 * @param {Spreadsheet} adminSS
 * @param {Date}        ahora
 * @returns {number} cantidad de emails enviados exitosamente
 */
function _enviarBoletinFinal_(cohortCode, momentCode, programCode, coreSS, adminSS, ahora) {
  var enviados = 0;
  var fechaStr = Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "dd/MM/yyyy");
  var periodoLabel = (momentCode || cohortCode);

  // Leer Students en memoria — 1 llamada
  var hojaEst = adminSS.getSheetByName("Students");
  if (!hojaEst || hojaEst.getLastRow() <= 1) {
    Logger.log("  ⚠️  Students vacía — no se puede enviar boletín");
    return 0;
  }
  var stuData = hojaEst.getRange(2, 1, hojaEst.getLastRow() - 1, 18).getValues();

  // Índice StudentID → { email, nombre }
  var stuIdx = {};
  stuData.forEach(function(row) {
    var sid = row[COL_STU.StudentID];
    if (sid) stuIdx[sid] = {
      email:  row[COL_STU.Email],
      nombre: (row[COL_STU.FirstName] + " " + row[COL_STU.LastName]).trim()
    };
  });

  // Leer GradeHistory en memoria — 1 llamada
  var hojaGH = adminSS.getSheetByName("GradeHistory");
  if (!hojaGH || hojaGH.getLastRow() <= 1) {
    Logger.log("  ⚠️  GradeHistory vacía — no se puede enviar boletín");
    return 0;
  }
  var ghData = hojaGH.getRange(2, 1, hojaGH.getLastRow() - 1, 14).getValues();

  // Agrupar notas por StudentID
  var notasPorEstudiante = {};
  ghData.forEach(function(row) {
    if (row[COL_GH.WindowCohortCode] !== cohortCode)          return;
    if (momentCode && row[COL_GH.MomentCode] !== momentCode)  return;
    if (row[COL_GH.Fuente] !== "MANUAL" && row[COL_GH.Fuente] !== "CIERRE") return;
    if (programCode && row[COL_GH.ProgramCode] !== programCode) return;

    var sid = row[COL_GH.StudentID];
    if (!sid) return;

    if (!notasPorEstudiante[sid]) notasPorEstudiante[sid] = [];
    notasPorEstudiante[sid].push({
      subjectName: row[COL_GH.SubjectName] || row[COL_GH.SubjectCode],
      nota:        row[COL_GH.Nota],
      nivel:       row[COL_GH.Nivel]  || "",
      estado:      row[COL_GH.Estado] || ""
    });
  });

  var totalEstudiantes = Object.keys(notasPorEstudiante).length;
  Logger.log("  Estudiantes con notas (MANUAL|CIERRE): " + totalEstudiantes);

  // Enviar un email por estudiante
  var sids = Object.keys(notasPorEstudiante);
  for (var i = 0; i < sids.length; i++) {
    var sid   = sids[i];
    var stu   = stuIdx[sid];
    var notas = notasPorEstudiante[sid];

    if (!stu || !stu.email) {
      Logger.log("  ⚠️  Sin email para StudentID=" + sid + " — omitido");
      continue;
    }

    var asunto = "Boletin " + periodoLabel + " — tus notas finales · SIDEP";

    // Filas de la tabla de notas en HTML
    var filasHtml = "";
    for (var j = 0; j < notas.length; j++) {
      var n = notas[j];
      var aprobado  = n.estado === "APROBADO";
      var bgColor   = aprobado ? "#e6f4ea" : "#fce8e6";
      var iconEstado = aprobado ? "&#10003;" : "&#10007;";
      filasHtml +=
        "<tr style='background:" + bgColor + "'>" +
          "<td style='padding:10px 8px;border-bottom:1px solid #e0e0e0'>" + n.subjectName + "</td>" +
          "<td style='padding:10px 8px;border-bottom:1px solid #e0e0e0;text-align:center;font-weight:bold'>" +
            (n.nota != null ? Number(n.nota).toFixed(1) : "-") + "</td>" +
          "<td style='padding:10px 8px;border-bottom:1px solid #e0e0e0;text-align:center;font-size:12px'>" +
            (n.nivel || "-") + "</td>" +
          "<td style='padding:10px 8px;border-bottom:1px solid #e0e0e0;text-align:center;color:" +
            (aprobado ? "#137333" : "#c5221f") + ";font-weight:bold'>" +
            iconEstado + " " + (n.estado || "-") + "</td>" +
        "</tr>";
    }

    var aprobadas = 0;
    for (var k = 0; k < notas.length; k++) {
      if (notas[k].estado === "APROBADO") aprobadas++;
    }

    var html =
      "<!DOCTYPE html><html><body style='font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:16px'>" +
      "<div style='max-width:600px;margin:0 auto;background:#fff;border-radius:8px;" +
        "overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)'>" +

      // Encabezado
      "<div style='background:#1a73e8;padding:24px;text-align:center'>" +
        "<h1 style='color:#fff;margin:0;font-size:20px'>Boletin de Notas Finales</h1>" +
        "<p style='color:#e8f0fe;margin:8px 0 0;font-size:14px'>" +
          periodoLabel + " &middot; " + fechaStr + "</p>" +
      "</div>" +

      // Saludo
      "<div style='padding:20px 24px 12px'>" +
        "<p style='font-size:16px;color:#202124;margin:0'>Hola <strong>" + stu.nombre + "</strong>,</p>" +
        "<p style='font-size:14px;color:#5f6368;margin:8px 0 0'>Aqui estan tus notas finales del periodo " +
          "<strong>" + periodoLabel + "</strong>:</p>" +
      "</div>" +

      // Tabla
      "<div style='padding:0 24px 16px'>" +
        "<table style='width:100%;border-collapse:collapse;font-size:14px'>" +
          "<thead><tr style='background:#f1f3f4'>" +
            "<th style='padding:10px 8px;text-align:left;border-bottom:2px solid #1a73e8'>Asignatura</th>" +
            "<th style='padding:10px 8px;text-align:center;border-bottom:2px solid #1a73e8;width:60px'>Nota</th>" +
            "<th style='padding:10px 8px;text-align:center;border-bottom:2px solid #1a73e8;width:100px'>Nivel</th>" +
            "<th style='padding:10px 8px;text-align:center;border-bottom:2px solid #1a73e8;width:110px'>Estado</th>" +
          "</tr></thead>" +
          "<tbody>" + filasHtml + "</tbody>" +
        "</table>" +
      "</div>" +

      // Resumen
      "<div style='padding:12px 24px;background:#f8f9fa;border-top:1px solid #e0e0e0'>" +
        "<p style='margin:0;font-size:13px;color:#5f6368'>" +
          "Asignaturas aprobadas: <strong style='color:#137333'>" + aprobadas + " de " + notas.length + "</strong>" +
        "</p>" +
      "</div>" +

      // Pie
      "<div style='padding:16px 24px;text-align:center'>" +
        "<p style='font-size:12px;color:#bdc1c6;margin:0'>SIDEP Ecosistema Digital &mdash; correo automatico</p>" +
      "</div>" +

      "</div></body></html>";

    // Texto plano de respaldo para clientes sin soporte HTML
    var plain = "Boletin de Notas — " + periodoLabel + "\n" +
      "Hola " + stu.nombre + ",\n\n" +
      "Tus notas finales:\n";
    for (var m = 0; m < notas.length; m++) {
      var n2 = notas[m];
      plain += "  " + n2.subjectName + ": " +
        (n2.nota != null ? Number(n2.nota).toFixed(1) : "-") +
        " — " + (n2.estado || "?") + "\n";
    }
    plain += "\nAprobadas: " + aprobadas + "/" + notas.length + "\n\nSIDP Ecosistema Digital";

    try {
      GmailApp.sendEmail(stu.email, asunto, plain, {
        htmlBody: html,
        name:     "SIDEP Ecosistema Digital"
      });
      enviados++;
      Logger.log("  ✉️  Boletin enviado a " + stu.email +
        " (" + notas.length + " materias, " + aprobadas + " aprobadas)");
      Utilities.sleep(200);
    } catch (e) {
      Logger.log("  ❌ Error enviando boletin a " + stu.email + ": " + e.message);
    }
  }

  Logger.log("  Boletines enviados: " + enviados + "/" + totalEstudiantes);
  return enviados;
}


/**
 * Crea la hoja CIERRE_LOG en adminSS si no existe.
 * Idempotente: si ya existe, la devuelve sin modificar.
 *
 * @param {Spreadsheet} adminSS
 * @returns {Sheet}
 */
function _setupCierreLogHoja_(adminSS) {
  var hoja = adminSS.getSheetByName("CIERRE_LOG");
  if (hoja) return hoja;

  hoja = adminSS.insertSheet("CIERRE_LOG");
  hoja.getRange(1, 1, 1, CIERRE_LOG_COLS.length).setValues([CIERRE_LOG_COLS]);
  hoja.getRange(1, 1, 1, CIERRE_LOG_COLS.length)
    .setFontWeight("bold")
    .setBackground("#ea4335")
    .setFontColor("#ffffff");
  hoja.setFrozenRows(1);
  hoja.setColumnWidth(12, 350); // Message — columna más ancha
  hoja.setColumnWidths(1, 2, 90);

  Logger.log("  ✅ Hoja CIERRE_LOG creada");
  return hoja;
}


/**
 * Agrega una fila de auditoría a CIERRE_LOG.
 * No lanza excepción si falla — el cierre ya se ejecutó y el log es informativo.
 *
 * @param {Spreadsheet} adminSS
 * @param {Object} entry
 */
function _registrarCierreLog_(adminSS, entry) {
  try {
    var hoja = _setupCierreLogHoja_(adminSS);
    var fila = [
      uuid("clg"),
      entry.cohortCode        || "",
      entry.momentCode        || "",
      entry.programCode       || "",
      entry.action            || "",
      entry.result            || "",
      entry.aulasTarget       || 0,
      entry.aulasArchivadas   || 0,
      entry.faltantesGate1    || 0,
      entry.faltantesGate2    || 0,
      entry.boletinesEnviados || 0,
      entry.message           || "",
      entry.ejecutadoEn       || nowSIDEP(),
      entry.ejecutadoPor      || ""
    ];
    hoja.appendRow(fila);
    Logger.log("  ✅ CIERRE_LOG — Action=" + entry.action + " Result=" + entry.result);
  } catch (e) {
    Logger.log("  ⚠️  No se pudo escribir en CIERRE_LOG: " + e.message);
  }
}
