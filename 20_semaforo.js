/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 20_semaforo.js
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Motor de riesgo académico semanal.
 *   Lee calificaciones de Classroom (período actual) + GradeHistory
 *   (historial manual pre-Classroom), calcula semáforo por asignatura,
 *   escribe GradeAudit en BI y actualiza ViewActiveStudents + RiskFlags.
 *
 * DECISIONES DE DISEÑO CONFIRMADAS (DEC-2026-015):
 *   D1 — Historial  : nota final numérica de GradeHistory (Fuente=MANUAL)
 *   D2 — Classroom  : solo assignedGrade publicada (state=RETURNED).
 *                     Actividades sin nota → PENDIENTE (no promedian)
 *   D3 — Vista B    : GradeAudit = detalle por asignatura con columnas
 *                     Nota (período actual) y PromedioAcumulado separadas.
 *                     ViewActiveStudents = resumen ejecutivo (sin cambios estructurales)
 *
 * POLÍTICA DE CALIFICACIÓN (DEC-2026-015 — escala institucional 1.0–5.0):
 *   EXCELENTE    4.5–5.0  → GREEN
 *   BUENO        4.0–4.4  → GREEN
 *   ACEPTABLE    3.0–3.9  → YELLOW
 *   INSUFICIENTE 1.0–2.9  → RED
 *   Umbral semáforo: GREEN ≥ 4.1 | YELLOW ≥ 3.0 | RED < 3.0
 *   GREY = sin datos (todo PENDIENTE o materia SIN_SYLLABUS)
 *
 * HOJAS LEÍDAS:
 *   CORE  → _CFG_SUBJECTS (HasSyllabus), MasterDeployments,
 *            _CFG_RECESSES, _CFG_COHORT_CALENDAR
 *   ADMIN → Students, Enrollments, GradeHistory
 *
 * HOJAS ESCRITAS:
 *   BI    → GradeAudit (reemplazada completa cada ejecución)
 *           ViewActiveStudents (upsert parcial — solo ActiveRiskStatusCode + GeneratedAt)
 *   ADMIN → RiskFlags (upsert — nuevas flags RED, resolución de no-RED)
 *           AutomationLogs (append)
 *
 * FUNCIONES PÚBLICAS:
 *   ejecutarSemaforo(options)    → ciclo completo (manual o trigger)
 *   diagnosticarSemaforo()       → verifica entorno sin modificar nada
 *   configurarTriggerSemanal()   → instala trigger lunes 7am (ejecutar UNA vez)
 *   eliminarTriggerSemanal()     → pausa el trigger
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.js  → SIDEP_CONFIG, nowSIDEP(), uuid()
 *   02_SIDEP_HELPERS.js → getSpreadsheetByName(), getTableData(),
 *                         escribirDatosSeguro(), _leerHoja_(), _escribirEnBatch_()
 *   Google Classroom API v1 (habilitar en Editor GAS → ➕ Servicios avanzados)
 *
 * DEPLOY:
 *   1. diagnosticarSemaforo()          → verificar entorno
 *   2. Poblar GradeHistory             → importar planillas históricas
 *   3. ejecutarSemaforo({ dryRun:true })→ validar sin escribir
 *   4. ejecutarSemaforo()              → primera corrida real
 *   5. configurarTriggerSemanal()      → activar trigger automático
 *
 * VERSIÓN: 1.0.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-04-15
 * ============================================================
 */


// ═════════════════════════════════════════════════════════════════
// CONFIGURACIÓN DEL SEMÁFORO
// ═════════════════════════════════════════════════════════════════

const CFG_SEMAFORO = {
  // Umbrales de calificación (escala 1.0–5.0 — DEC-2026-015)
  UMBRAL_GREEN:      4.1,   // >= 4.1 → GREEN  (BUENO o EXCELENTE)
  UMBRAL_YELLOW:     3.0,   // >= 3.0 → YELLOW (ACEPTABLE) | < 3.0 → RED (INSUFICIENTE)
  ESCALA_MIN:        1.0,
  ESCALA_MAX:        5.0,

  // Materias sin syllabus formal — fallback si HasSyllabus no está poblado en _CFG_SUBJECTS.
  // Actualizar aquí SOLO si no se puede poblar HasSyllabus en Sheets.
  MATERIAS_SIN_SYLLABUS_FALLBACK: ["DPW", "PAI", "SEM", "MDA"],

  // Trigger semanal
  TRIGGER_FUNCTION: "ejecutarSemaforo",
  TRIGGER_HOUR:     7   // 7 AM hora Colombia (America/Bogota)
};


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 1: FUNCIONES PÚBLICAS
// ═════════════════════════════════════════════════════════════════

/**
 * Ciclo completo del semáforo académico.
 * Invocado automáticamente por el trigger (lunes 7am) o manualmente desde el editor.
 *
 * Flujo interno:
 *   1. Lock        → evita ejecuciones concurrentes
 *   2. Receso      → si hay receso activo, omite y registra SKIPPED
 *   3. Contexto    → carga Students, Enrollments, Deployments, subjects, historial
 *   4. Cálculo     → genera filas GradeAudit (Classroom API + GradeHistory)
 *   5. GradeAudit  → reemplaza tabla completa en BI (escribirDatosSeguro)
 *   6. ViewActive  → actualiza ActiveRiskStatusCode + GeneratedAt por estudiante
 *   7. RiskFlags   → upsert: crea flags RED nuevos, resuelve los ya-no-RED
 *   8. Log         → registra resumen en AutomationLogs
 *
 * @param {object}  [options]
 * @param {boolean} [options.dryRun=false] — calcula todo sin escribir en Sheets
 */
function ejecutarSemaforo(options) {
  const opts    = options || {};
  const dryRun  = opts.dryRun === true;
  const ahora   = nowSIDEP();
  const usuario = Session.getEffectiveUser().getEmail() || "semaforo@sidep";

  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — Semáforo Académico v1.0.0");
  Logger.log("   Modo   : " + (dryRun ? "DRY-RUN" : "EJECUTAR"));
  Logger.log("   Usuario: " + usuario);
  Logger.log("   Hora   : " + Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "yyyy-MM-dd HH:mm:ss"));
  Logger.log("════════════════════════════════════════════════");

  const lock = _lockSemaforo_();
  if (!lock) return;

  const resumen = {
    procesados: 0, errores: 0,
    greenCount: 0, yellowCount: 0, redCount: 0, greyCount: 0,
    skipped: false
  };

  try {
    // ── Paso 1: Cargar contexto ───────────────────────────────────
    Logger.log("\n── Paso 1: Cargando contexto...");
    const ctx = _cargarContexto_();
    Logger.log("   Students    : " + Object.keys(ctx.students).length);
    Logger.log("   Enrollments : " + ctx.enrollmentsActivos.length + " activos");
    Logger.log("   Deployments : " + Object.keys(ctx.deployments).length);
    Logger.log("   GradeHistory: " + ctx.gradeHistoryRows.length + " registros");

    // ── Paso 2: Verificar receso ──────────────────────────────────
    if (_estaEnReceso_(ahora, ctx)) {
      Logger.log("\n  Receso académico activo — ejecución omitida.");
      resumen.skipped = true;
      _registrarLogSemaforo_("SKIPPED", "Receso académico activo", resumen, ahora, usuario, ctx);
      return;
    }

    if (ctx.enrollmentsActivos.length === 0) {
      Logger.log("\n  Sin enrollments ACTIVE — nada que procesar.");
      resumen.skipped = true;
      _registrarLogSemaforo_("SKIPPED", "Sin enrollments ACTIVE", resumen, ahora, usuario, ctx);
      return;
    }

    // ── Paso 3: Calcular notas → filas GradeAudit ─────────────────
    Logger.log("\n── Paso 3: Calculando notas por asignatura...");
    const courseWorkCache = {};  // { classroomId: courseWork[] } — cacheado por aula
    const filas = _procesarEnrollments_(ctx, ahora, courseWorkCache, resumen);

    Logger.log("   Filas generadas : " + filas.length);
    Logger.log("   GREEN=" + resumen.greenCount +
               " | YELLOW=" + resumen.yellowCount +
               " | RED=" + resumen.redCount +
               " | GREY=" + resumen.greyCount +
               " | Errores=" + resumen.errores);

    if (dryRun) {
      Logger.log("\n  DRY-RUN: cálculo OK — sin escritura en Sheets.");
      return;
    }

    // ── Paso 4: Escribir GradeAudit en BI ────────────────────────
    Logger.log("\n── Paso 4: Publicando GradeAudit...");
    _publicarGradeAudit_(filas, ctx);

    // ── Paso 5: Actualizar ViewActiveStudents ─────────────────────
    Logger.log("\n── Paso 5: Actualizando ViewActiveStudents...");
    _actualizarViewActiveStudents_(filas, ctx, ahora);

    // ── Paso 6: Upsert RiskFlags ──────────────────────────────────
    Logger.log("\n── Paso 6: Actualizando RiskFlags...");
    _actualizarRiskFlags_(filas, ctx, ahora, usuario);

    // ── Paso 7: Log ───────────────────────────────────────────────
    resumen.procesados = filas.length;
    _registrarLogSemaforo_("SUCCESS", "", resumen, ahora, usuario, ctx);

    Logger.log("\nOK Semáforo completado.");
    Logger.log("   Procesados=" + resumen.procesados + " | Errores=" + resumen.errores);

  } catch (e) {
    Logger.log("\nERROR FATAL: " + e.message);
    Logger.log(e.stack || "");
    resumen.errores++;
    try { _registrarLogSemaforo_("ERROR", e.message, resumen, ahora, usuario, null); } catch (_) {}
    throw e;

  } finally {
    lock.releaseLock();
    Logger.log("Lock liberado");
  }
}


/**
 * Verifica que todas las tablas y servicios requeridos estén disponibles.
 * NO modifica ningún dato. Ejecutar antes del primer deploy.
 */
function diagnosticarSemaforo() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("SIDEP — Diagnóstico Semáforo v1.0.0");
  Logger.log("════════════════════════════════════════════════");

  const checks = [
    { fileKey: "core",  table: "MasterDeployments",   critical: true  },
    { fileKey: "core",  table: "_CFG_SUBJECTS",        critical: true  },
    { fileKey: "core",  table: "_CFG_RECESSES",        critical: false },
    { fileKey: "core",  table: "_CFG_COHORT_CALENDAR", critical: false },
    { fileKey: "core",  table: "_CFG_SEMAFORO",        critical: false },  // ⚠️ nueva en v4.4.0 — opcional: sin datos usa defaults hardcodeados
    { fileKey: "admin", table: "Students",             critical: true  },
    { fileKey: "admin", table: "Enrollments",          critical: true  },
    { fileKey: "admin", table: "GradeHistory",         critical: true  },  // ⚠️ nueva en v4.3.0
    { fileKey: "admin", table: "RiskFlags",            critical: true  },
    { fileKey: "admin", table: "AutomationLogs",       critical: true  },
    { fileKey: "bi",    table: "GradeAudit",           critical: true  },  // ⚠️ nueva en v4.3.0
    { fileKey: "bi",    table: "ViewActiveStudents",   critical: true  }
  ];

  let ok = 0, warn = 0, err = 0;

  checks.forEach(function(c) {
    try {
      const ss   = getSpreadsheetByName(c.fileKey);
      const hoja = ss.getSheetByName(c.table);
      if (!hoja) {
        const tag = c.critical ? "  ERR " : "  WARN";
        Logger.log(tag + " [" + c.fileKey + "] " + c.table +
          " — hoja NO encontrada" + (c.critical ? " — ejecutar setupSidepTables()" : ""));
        c.critical ? err++ : warn++;
      } else {
        const filas = Math.max(0, hoja.getLastRow() - 1);
        Logger.log("  OK   [" + c.fileKey + "] " + c.table + " (" + filas + " filas)");
        ok++;
      }
    } catch (e) {
      Logger.log("  ERR  [" + c.fileKey + "] " + c.table + " — " + e.message);
      err++;
    }
  });

  // Verificar umbrales activos en _CFG_SEMAFORO
  try {
    const ss     = getSpreadsheetByName("core");
    const hoja   = ss.getSheetByName("_CFG_SEMAFORO");
    if (hoja && hoja.getLastRow() > 1) {
      const cfgMem = _leerHoja_(hoja);
      const cfg    = _resolverCfg_(cfgMem);
      Logger.log("  OK   [core] _CFG_SEMAFORO — umbrales activos:");
      Logger.log("         ESCALA: [" + cfg.ESCALA_MIN + " – " + cfg.ESCALA_MAX + "]" +
                 " | GREEN≥" + cfg.UMBRAL_GREEN +
                 " | YELLOW≥" + cfg.UMBRAL_YELLOW +
                 " | APROBACION≥" + cfg.UMBRAL_APROBACION);
      Logger.log("         EXCELENTE≥" + cfg.NIVEL_EXCELENTE_MIN +
                 " | BUENO≥" + cfg.NIVEL_BUENO_MIN);
    } else {
      Logger.log("  WARN [core] _CFG_SEMAFORO vacía — semáforo usará defaults hardcodeados." +
                 " Ejecutar poblarConfiguraciones() para sembrar umbrales.");
      warn++;
    }
  } catch (_) {}

  // Verificar política HasSyllabus en _CFG_SUBJECTS
  try {
    const ss    = getSpreadsheetByName("core");
    const hoja  = ss.getSheetByName("_CFG_SUBJECTS");
    if (hoja) {
      const headers = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
      if (headers.indexOf("HasSyllabus") === -1) {
        Logger.log("  WARN [core] _CFG_SUBJECTS — columna HasSyllabus no encontrada.");
        Logger.log("       Usar fallback MATERIAS_SIN_SYLLABUS_FALLBACK: " +
          CFG_SEMAFORO.MATERIAS_SIN_SYLLABUS_FALLBACK.join(", "));
        warn++;
      } else {
        Logger.log("  OK   [core] _CFG_SUBJECTS.HasSyllabus presente");
        ok++;
      }
    }
  } catch (_) {}

  // Verificar Classroom API habilitada
  try {
    Classroom.Courses.list({ pageSize: 1 });
    Logger.log("  OK   Classroom API disponible");
    ok++;
  } catch (e) {
    Logger.log("  ERR  Classroom API no disponible: " + e.message);
    Logger.log("       Habilitar en: Editor GAS → Servicios → Google Classroom API v1");
    err++;
  }

  Logger.log("════════════════════════════════════════════════");
  Logger.log("Resultado: OK=" + ok + " | WARN=" + warn + " | ERR=" + err);
  if (err > 0) {
    Logger.log("  Corregir ERR antes de ejecutar el semáforo.");
    Logger.log("  Si hay tablas faltantes: ejecutar setupSidepTables() (modelo v4.3.0).");
  }
  if (warn > 0) Logger.log("  WARN: revisar — puede funcionar con limitaciones.");
  if (err === 0 && warn === 0) Logger.log("  Entorno listo para ejecutarSemaforo().");
}


/**
 * Instala el trigger semanal (lunes 7 AM Colombia).
 * Ejecutar UNA sola vez. Si ya existe un trigger para ejecutarSemaforo, no duplica.
 */
function configurarTriggerSemanal() {
  const triggers = ScriptApp.getProjectTriggers();
  const yaExiste = triggers.some(function(t) {
    return t.getHandlerFunction() === CFG_SEMAFORO.TRIGGER_FUNCTION;
  });

  if (yaExiste) {
    Logger.log("  Trigger '" + CFG_SEMAFORO.TRIGGER_FUNCTION + "' ya existe — sin cambios.");
    return;
  }

  ScriptApp.newTrigger(CFG_SEMAFORO.TRIGGER_FUNCTION)
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(CFG_SEMAFORO.TRIGGER_HOUR)
    .inTimezone(SIDEP_CONFIG.timezone)
    .create();

  Logger.log("  OK Trigger instalado: lunes " + CFG_SEMAFORO.TRIGGER_HOUR +
             ":00 " + SIDEP_CONFIG.timezone);
}


/**
 * Elimina el trigger semanal del semáforo.
 * El semáforo deja de ejecutarse automáticamente hasta que se reinstale.
 */
function eliminarTriggerSemanal() {
  let eliminados = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === CFG_SEMAFORO.TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(t);
      eliminados++;
    }
  });
  Logger.log(eliminados > 0
    ? "  OK " + eliminados + " trigger(s) eliminados."
    : "  No se encontró trigger '" + CFG_SEMAFORO.TRIGGER_FUNCTION + "'.");
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 2: CARGA DE CONTEXTO
// ═════════════════════════════════════════════════════════════════

/**
 * Carga todas las tablas necesarias en una sola pasada.
 * Abre los 3 Spreadsheets UNA vez cada uno para minimizar llamadas a Drive.
 *
 * @returns {object} ctx — contexto completo del semáforo:
 *   {
 *     students:            { [studentId]: row }          — indexado por StudentID
 *     studentsIdx:         { [col]: colIndex }
 *     enrollmentsActivos:  row[]                         — solo EnrollmentStatusCode=ACTIVE
 *     enrollmentsIdx:      { [col]: colIndex }
 *     deployments:         { [deploymentId]: row }       — indexado por DeploymentID
 *     deploymentsIdx:      { [col]: colIndex }
 *     subjects:            { [subjectCode]: row }        — indexado por SubjectCode
 *     subjectsIdx:         { [col]: colIndex }
 *     gradeHistoryRows:    row[]
 *     gradeHistoryIdx:     { [col]: colIndex }
 *     recessRows:          row[]
 *     recessIdx:           { [col]: colIndex }
 *     coreSS:              Spreadsheet
 *     adminSS:             Spreadsheet
 *     biSS:                Spreadsheet
 *   }
 */
function _cargarContexto_() {
  const coreSS  = getSpreadsheetByName("core");
  const adminSS = getSpreadsheetByName("admin");
  const biSS    = getSpreadsheetByName("bi");

  // ── CORE ──────────────────────────────────────────────────────
  const subjectsMem  = _leerHoja_(coreSS.getSheetByName("_CFG_SUBJECTS"));
  const deployMem    = _leerHoja_(coreSS.getSheetByName("MasterDeployments"));
  const recessMem    = _leerHoja_(coreSS.getSheetByName("_CFG_RECESSES"));

  // Indexar subjects por SubjectCode
  const subjects     = {};
  const iSubjCode    = subjectsMem.idx["SubjectCode"];
  subjectsMem.datos.forEach(function(row) {
    const code = String(row[iSubjCode] || "").trim();
    if (code) subjects[code] = row;
  });

  // Indexar deployments por DeploymentID
  const deployments  = {};
  const iDepId       = deployMem.idx["DeploymentID"];
  deployMem.datos.forEach(function(row) {
    const id = String(row[iDepId] || "").trim();
    if (id) deployments[id] = row;
  });

  // ── ADMIN ──────────────────────────────────────────────────────
  const studentsMem   = _leerHoja_(adminSS.getSheetByName("Students"));
  const enrollMem     = _leerHoja_(adminSS.getSheetByName("Enrollments"));
  const histMem       = _leerHoja_(adminSS.getSheetByName("GradeHistory"));

  // Indexar students por StudentID
  const students      = {};
  const iStudId       = studentsMem.idx["StudentID"];
  studentsMem.datos.forEach(function(row) {
    const id = String(row[iStudId] || "").trim();
    if (id) students[id] = row;
  });

  // Solo enrollments ACTIVE
  const iEnrollStatus = enrollMem.idx["EnrollmentStatusCode"];
  const enrollmentsActivos = enrollMem.datos.filter(function(row) {
    return String(row[iEnrollStatus] || "").trim() === "ACTIVE";
  });

  // ── _CFG_SEMAFORO: umbrales dinámicos ─────────────────────────
  // Lee la tabla y sobreescribe los defaults de CFG_SEMAFORO.
  // Si la tabla no existe o está vacía, el fallback hardcodeado garantiza
  // que el semáforo nunca quede roto por falta de datos en Sheets.
  const cfgMem = _leerHoja_(coreSS.getSheetByName("_CFG_SEMAFORO"));
  const cfg    = _resolverCfg_(cfgMem);

  return {
    students:           students,
    studentsIdx:        studentsMem.idx,
    enrollmentsActivos: enrollmentsActivos,
    enrollmentsIdx:     enrollMem.idx,
    deployments:        deployments,
    deploymentsIdx:     deployMem.idx,
    subjects:           subjects,
    subjectsIdx:        subjectsMem.idx,
    gradeHistoryRows:   histMem.datos,
    gradeHistoryIdx:    histMem.idx,
    recessRows:         recessMem.datos,
    recessIdx:          recessMem.idx,
    cfg:                cfg,   // umbrales dinámicos (desde _CFG_SEMAFORO o fallback)
    coreSS:             coreSS,
    adminSS:            adminSS,
    biSS:               biSS
  };
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 3: PROCESAMIENTO DE ENROLLMENTS
// ═════════════════════════════════════════════════════════════════

/**
 * Itera sobre los enrollments activos y genera una fila GradeAudit por cada uno.
 *
 * Para cada enrollment ACTIVE:
 *   - Determina si la asignatura tiene syllabus (HasSyllabus en _CFG_SUBJECTS)
 *   - Si tiene syllabus: consulta Classroom API para obtener notas publicadas
 *   - Calcula PromedioAcumulado (GradeHistory + nota período actual)
 *   - Determina Nivel y SemaforoColor
 *
 * @param {object}   ctx              — contexto de _cargarContexto_()
 * @param {Date}     ahora            — timestamp nowSIDEP()
 * @param {object}   courseWorkCache  — { [classroomId]: courseWork[] } — mutado aquí
 * @param {object}   resumen          — contadores (mutado aquí)
 * @returns {Array[]} filas para GradeAudit (sin encabezado, orden = _gaSchema_())
 */
function _procesarEnrollments_(ctx, ahora, courseWorkCache, resumen) {
  const eIdx = ctx.enrollmentsIdx;
  const dIdx = ctx.deploymentsIdx;
  const sIdx = ctx.subjectsIdx;
  const stIdx= ctx.studentsIdx;
  const schema = _gaSchema_();

  const filas = [];

  ctx.enrollmentsActivos.forEach(function(enroll) {
    const deployId     = String(enroll[eIdx["DeploymentID"]]     || "").trim();
    const studentId    = String(enroll[eIdx["StudentID"]]        || "").trim();
    const momentCode   = String(enroll[eIdx["MomentCode"]]       || "").trim();
    const entryCohort  = String(enroll[eIdx["EntryCohortCode"]]  || "").trim();
    const windowCohort = String(enroll[eIdx["WindowCohortCode"]] || "").trim();
    const enrollId     = String(enroll[eIdx["EnrollmentID"]]     || "?");

    const deploy  = ctx.deployments[deployId];
    const student = ctx.students[studentId];

    if (!deploy || !student) {
      Logger.log("  WARN: Deployment/Student no encontrado — EnrollmentID=" + enrollId);
      resumen.errores++;
      return;
    }

    const subjectCode  = String(deploy[dIdx["SubjectCode"]]  || "").trim();
    const subjectName  = String(deploy[dIdx["SubjectName"]]  || "").trim();
    const classroomId  = String(deploy[dIdx["ClassroomID"]]  || "").trim();
    const programCode  = String(deploy[dIdx["ProgramCode"]]  || "").trim();
    const studentEmail = String(student[stIdx["Email"]]      || "").trim();
    const fullName     = (String(student[stIdx["FirstName"]] || "").trim() + " " +
                          String(student[stIdx["LastName"]]  || "").trim()).trim();

    const subjectRow  = ctx.subjects[subjectCode] || null;
    const hasSyllabus = _esSyllabusDisponible_(subjectCode, subjectRow, sIdx);

    let nota, nivel, semaforoColor, fuente, actConNota, actSinNota;

    if (!hasSyllabus) {
      // ── Materia sin syllabus formal ─────────────────────────────
      nota          = null;
      nivel         = "SIN_SYLLABUS";
      semaforoColor = "GREY";
      fuente        = "CLASSROOM";
      actConNota    = 0;
      actSinNota    = 0;

    } else if (!classroomId) {
      // ── Aula aún no creada en Classroom ─────────────────────────
      Logger.log("  WARN: Sin ClassroomID — " + subjectCode + " deploy=" + deployId);
      nota          = null;
      nivel         = "PENDIENTE";
      semaforoColor = "GREY";
      fuente        = "CLASSROOM";
      actConNota    = 0;
      actSinNota    = 0;

    } else {
      // ── Calcular nota desde Classroom API (D2) ───────────────────
      fuente = "CLASSROOM";
      const gr = _obtenerGradesClassroom_(classroomId, studentEmail, courseWorkCache);
      actConNota = gr.actConNota;
      actSinNota = gr.actSinNota;
      nota       = gr.notaPromedio;   // null si todo está PENDIENTE

      if (nota !== null) {
        if (nota < ctx.cfg.ESCALA_MIN || nota > ctx.cfg.ESCALA_MAX) {
          Logger.log("  NOTA_INVALIDA: " + nota + " fuera de escala [" +
                     ctx.cfg.ESCALA_MIN + "," + ctx.cfg.ESCALA_MAX + "] — " +
                     subjectCode + " (" + fullName + ") — ignorada");
          nota          = null;
          nivel         = "PENDIENTE";
          semaforoColor = "GREY";
        } else {
          nivel         = _calcularNivel_(nota, ctx.cfg);
          semaforoColor = _calcularSemaforo_(nota, ctx.cfg);
        }
      } else {
        nivel         = "PENDIENTE";
        semaforoColor = "GREY";
      }
    }

    // ── Promedio acumulado: GradeHistory + nota período actual ──
    const acum = _calcularPromedioAcumulado_(studentId, subjectCode, nota, ctx);

    // ── Contadores para resumen ──────────────────────────────────
    if      (semaforoColor === "GREEN")  resumen.greenCount++;
    else if (semaforoColor === "YELLOW") resumen.yellowCount++;
    else if (semaforoColor === "RED")    resumen.redCount++;
    else                                 resumen.greyCount++;

    // ── Construir fila GradeAudit ────────────────────────────────
    filas.push(_buildGaRow_(schema, {
      GradeAuditID:      uuid("gau"),
      StudentID:         studentId,
      FullName:          fullName,
      ProgramCode:       programCode,
      EntryCohortCode:   entryCohort,
      SubjectCode:       subjectCode,
      SubjectName:       subjectName,
      MomentCode:        momentCode,
      WindowCohortCode:  windowCohort,
      Nota:              nota !== null ? nota : "",
      Nivel:             nivel,
      SemaforoColor:     semaforoColor,
      Fuente:            fuente,
      ActConNota:        actConNota,
      ActSinNota:        actSinNota,
      PromedioAcumulado: acum.promedio !== null ? acum.promedio : "",
      NivelAcumulado:    acum.nivel,
      GeneratedAt:       ahora
    }));
  });

  return filas;
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 4: CLASSROOM API
// ═════════════════════════════════════════════════════════════════

/**
 * Obtiene las calificaciones publicadas de un estudiante en un aula.
 *
 * Implementa D2: solo assignedGrade con state=RETURNED cuenta como nota.
 * Actividades sin assignedGrade → actSinNota (PENDIENTE).
 * CourseWork del aula se cachea para evitar llamadas repetidas por aula.
 *
 * @param {string} classroomId     — ClassroomID del deployment
 * @param {string} studentEmail    — email del estudiante (Students.Email)
 * @param {object} courseWorkCache — { [classroomId]: courseWork[] } — mutado aquí
 * @returns {{ notaPromedio: number|null, actConNota: number, actSinNota: number }}
 */
function _obtenerGradesClassroom_(classroomId, studentEmail, courseWorkCache) {
  try {
    // ── Cargar CourseWork del aula (cacheado — 1 llamada por aula) ──
    if (!courseWorkCache[classroomId]) {
      const cwResp = Classroom.Courses.CourseWork.list(classroomId, { pageSize: 100 });
      courseWorkCache[classroomId] = (cwResp && cwResp.courseWork) ? cwResp.courseWork : [];
    }
    const courseWorkList = courseWorkCache[classroomId];

    if (courseWorkList.length === 0) {
      return { notaPromedio: null, actConNota: 0, actSinNota: 0 };
    }

    // ── Obtener submissions del estudiante (paginado) ───────────────
    let submissions = [];
    let pageToken   = null;
    do {
      const params = { userId: studentEmail, pageSize: 100 };
      if (pageToken) params.pageToken = pageToken;
      const resp = Classroom.Courses.CourseWork.StudentSubmissions.list(
        classroomId, "-", params
      );
      if (resp && resp.studentSubmissions) {
        submissions = submissions.concat(resp.studentSubmissions);
      }
      pageToken = (resp && resp.nextPageToken) ? resp.nextPageToken : null;
    } while (pageToken);

    // ── Indexar submissions por courseWorkId ────────────────────────
    const submByWork = {};
    submissions.forEach(function(sub) {
      submByWork[sub.courseWorkId] = sub;
    });

    // ── Calcular nota (D2: solo assignedGrade publicada) ────────────
    let sumNotas = 0, actConNota = 0, actSinNota = 0;

    courseWorkList.forEach(function(cw) {
      const sub = submByWork[cw.id];

      if (!sub) {
        // El estudiante aún no tiene submission para esta actividad
        actSinNota++;
        return;
      }

      // D2: solo RETURNED con assignedGrade publicada por el docente
      const tieneNota = sub.state === "RETURNED" &&
                        sub.assignedGrade !== undefined &&
                        sub.assignedGrade !== null;

      if (tieneNota) {
        const maxPoints = (cw.maxPoints !== undefined && cw.maxPoints > 0) ? cw.maxPoints : 5;
        const notaNorm  = _normalizarNota_(sub.assignedGrade, maxPoints);
        if (notaNorm !== null) {
          sumNotas += notaNorm;
          actConNota++;
        } else {
          actSinNota++;
        }
      } else {
        actSinNota++;
      }
    });

    const notaPromedio = actConNota > 0
      ? Math.round((sumNotas / actConNota) * 100) / 100
      : null;

    return { notaPromedio: notaPromedio, actConNota: actConNota, actSinNota: actSinNota };

  } catch (e) {
    Logger.log("  WARN Classroom API (" + classroomId + " / " + studentEmail + "): " + e.message);
    return { notaPromedio: null, actConNota: 0, actSinNota: 0 };
  }
}

/**
 * Normaliza una nota de Classroom a la escala institucional 1.0–5.0.
 *
 * POLÍTICA (DEC-2026-015): los docentes DEBEN calificar en escala 1–5
 * configurando maxPoints=5 en Classroom. Esta función solo normaliza como
 * fallback de seguridad para aulas con otras escalas.
 *
 *   maxPoints ≤ 5  → nota ya está en escala 1–5, validar rango
 *   maxPoints > 5  → conversión proporcional: 1 + (nota/maxPoints) × 4
 *
 * @param {number} assignedGrade — nota cruda de Classroom
 * @param {number} maxPoints     — maxPoints del CourseWork
 * @returns {number|null} nota normalizada o null si es inválida
 */
function _normalizarNota_(assignedGrade, maxPoints, cfg) {
  const nota     = Number(assignedGrade);
  if (isNaN(nota)) return null;
  const escMin   = (cfg && cfg.ESCALA_MIN !== undefined) ? cfg.ESCALA_MIN : CFG_SEMAFORO.ESCALA_MIN;
  const escMax   = (cfg && cfg.ESCALA_MAX !== undefined) ? cfg.ESCALA_MAX : CFG_SEMAFORO.ESCALA_MAX;

  if (maxPoints <= escMax) {
    // Ya en escala institucional — solo validar rango
    if (nota < escMin || nota > escMax) {
      Logger.log("  NOTA_INVALIDA: " + nota + " (maxPoints=" + maxPoints +
                 ") fuera de [" + escMin + "," + escMax + "]");
      return null;
    }
    return Math.round(nota * 100) / 100;
  }

  // Conversión proporcional (ej: escala 0–100 → 1–5)
  // Fórmula: nota_institucional = escMin + (nota / maxPoints) × (escMax - escMin)
  const normalizada = escMin + (nota / maxPoints) * (escMax - escMin);
  if (normalizada < escMin || normalizada > escMax) return null;
  return Math.round(normalizada * 100) / 100;
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 5: CÁLCULOS ACADÉMICOS
// ═════════════════════════════════════════════════════════════════

/**
 * Convierte una nota numérica al nivel textual institucional.
 * Usa los umbrales de cfg (leídos de _CFG_SEMAFORO en Sheets).
 * Fallback a CFG_SEMAFORO si cfg no se pasa o falta una clave.
 *
 *   >= NIVEL_EXCELENTE_MIN (4.5) → EXCELENTE
 *   >= NIVEL_BUENO_MIN     (4.0) → BUENO
 *   >= UMBRAL_APROBACION   (3.0) → ACEPTABLE
 *   <  UMBRAL_APROBACION   (3.0) → INSUFICIENTE
 *
 * @param {number|null} nota
 * @param {object}      [cfg] — umbrales dinámicos de ctx.cfg
 * @returns {string}
 */
function _calcularNivel_(nota, cfg) {
  if (nota === null || nota === undefined || isNaN(nota)) return "PENDIENTE";
  const excellente = (cfg && cfg.NIVEL_EXCELENTE_MIN !== undefined) ? cfg.NIVEL_EXCELENTE_MIN : 4.5;
  const bueno      = (cfg && cfg.NIVEL_BUENO_MIN     !== undefined) ? cfg.NIVEL_BUENO_MIN     : 4.0;
  const aprobacion = (cfg && cfg.UMBRAL_APROBACION   !== undefined) ? cfg.UMBRAL_APROBACION   : 3.0;
  if (nota >= excellente) return "EXCELENTE";
  if (nota >= bueno)      return "BUENO";
  if (nota >= aprobacion) return "ACEPTABLE";
  return "INSUFICIENTE";
}

/**
 * Convierte una nota numérica al color del semáforo.
 * Usa los umbrales de cfg (leídos de _CFG_SEMAFORO en Sheets).
 * Fallback a CFG_SEMAFORO si cfg no se pasa o falta una clave.
 *
 *   >= UMBRAL_GREEN  (4.1) → GREEN
 *   >= UMBRAL_YELLOW (3.0) → YELLOW
 *   <  UMBRAL_YELLOW (3.0) → RED
 *   null             → GREY (sin datos)
 *
 * @param {number|null} nota
 * @param {object}      [cfg] — umbrales dinámicos de ctx.cfg
 * @returns {string}
 */
function _calcularSemaforo_(nota, cfg) {
  if (nota === null || nota === undefined || isNaN(nota)) return "GREY";
  const umbralGreen  = (cfg && cfg.UMBRAL_GREEN  !== undefined) ? cfg.UMBRAL_GREEN  : CFG_SEMAFORO.UMBRAL_GREEN;
  const umbralYellow = (cfg && cfg.UMBRAL_YELLOW !== undefined) ? cfg.UMBRAL_YELLOW : CFG_SEMAFORO.UMBRAL_YELLOW;
  if (nota >= umbralGreen)  return "GREEN";
  if (nota >= umbralYellow) return "YELLOW";
  return "RED";
}

/**
 * Calcula el promedio acumulado de un estudiante en una asignatura.
 *
 * Combina:
 *   1. GradeHistory: todas las notas finales de períodos anteriores (Fuente=MANUAL)
 *   2. Nota del período actual (de Classroom API) si ya hay datos publicados
 *
 * Si el estudiante reprobó y está reintentando, ambas notas entran al promedio
 * (aritmético simple). Esto es intencional para Fase 1 — se puede cambiar a
 * "mejor intento" en Fase 2 sin cambiar el schema.
 *
 * @param {string}      studentId   — StudentID
 * @param {string}      subjectCode — SubjectCode
 * @param {number|null} notaActual  — nota del período actual (null si PENDIENTE)
 * @param {object}      ctx         — contexto
 * @returns {{ promedio: number|null, nivel: string }}
 */
function _calcularPromedioAcumulado_(studentId, subjectCode, notaActual, ctx) {
  const hIdx   = ctx.gradeHistoryIdx;
  const iStuId = hIdx["StudentID"];
  const iSubj  = hIdx["SubjectCode"];
  const iNota  = hIdx["Nota"];

  const notas = [];

  // 1. Notas de períodos anteriores (GradeHistory)
  const escMin = (ctx.cfg && ctx.cfg.ESCALA_MIN !== undefined) ? ctx.cfg.ESCALA_MIN : CFG_SEMAFORO.ESCALA_MIN;
  const escMax = (ctx.cfg && ctx.cfg.ESCALA_MAX !== undefined) ? ctx.cfg.ESCALA_MAX : CFG_SEMAFORO.ESCALA_MAX;
  ctx.gradeHistoryRows.forEach(function(row) {
    if (String(row[iStuId] || "").trim() === studentId &&
        String(row[iSubj]  || "").trim() === subjectCode) {
      const n = Number(row[iNota]);
      if (!isNaN(n) && n >= escMin && n <= escMax) {
        notas.push(n);
      }
    }
  });

  // 2. Nota del período actual (si ya es numérica)
  if (notaActual !== null && !isNaN(Number(notaActual))) {
    notas.push(Number(notaActual));
  }

  if (notas.length === 0) return { promedio: null, nivel: "PENDIENTE" };

  const suma     = notas.reduce(function(a, b) { return a + b; }, 0);
  const promedio = Math.round((suma / notas.length) * 100) / 100;
  return { promedio: promedio, nivel: _calcularNivel_(promedio) };
}

/**
 * Determina si una asignatura tiene syllabus formal disponible.
 *
 * Prioridad de decisión:
 *   1. Campo HasSyllabus en _CFG_SUBJECTS → "TRUE" o "FALSE"
 *   2. Si HasSyllabus está vacío → MATERIAS_SIN_SYLLABUS_FALLBACK (lista hardcodeada)
 *
 * @param {string}      subjectCode — código de la asignatura
 * @param {Array|null}  subjectRow  — fila de _CFG_SUBJECTS (null si no existe)
 * @param {object}      sIdx        — índice de columnas de _CFG_SUBJECTS
 * @returns {boolean} true = tiene syllabus formal
 */
function _esSyllabusDisponible_(subjectCode, subjectRow, sIdx) {
  if (subjectRow !== null) {
    const iHasSyll = sIdx["HasSyllabus"];
    if (iHasSyll !== undefined) {
      const val = String(subjectRow[iHasSyll] || "").trim().toUpperCase();
      if (val === "TRUE")  return true;
      if (val === "FALSE") return false;
      // Vacío → caer al fallback
    }
  }
  // Fallback: lista hardcodeada de materias sin syllabus conocidas
  return CFG_SEMAFORO.MATERIAS_SIN_SYLLABUS_FALLBACK.indexOf(subjectCode) === -1;
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 6: ESCRITURA EN SHEETS
// ═════════════════════════════════════════════════════════════════

/**
 * Reemplaza completamente la tabla GradeAudit en BI con las filas calculadas.
 * Usa escribirDatosSeguro() → rollback automático ante fallos de escritura.
 *
 * @param {Array[]} filas — filas GradeAudit (sin encabezado)
 * @param {object}  ctx   — contexto (para acceder a biSS)
 */
function _publicarGradeAudit_(filas, ctx) {
  if (filas.length === 0) {
    Logger.log("  Sin filas para GradeAudit — tabla no modificada.");
    return;
  }
  escribirDatosSeguro(ctx.biSS, "GradeAudit", filas);
  Logger.log("  GradeAudit: " + filas.length + " registros escritos.");
}

/**
 * Actualiza ActiveRiskStatusCode y GeneratedAt en ViewActiveStudents
 * para los estudiantes procesados. Patrón memory-first para no sobrescribir
 * OpenInterventions ni PendingDebts (columnas escritas por otros procesos).
 *
 * Lógica del peor color por estudiante: RED > YELLOW > GREEN > GREY.
 * Un estudiante es RED si cualquiera de sus asignaturas está en RED.
 *
 * @param {Array[]} filas — filas GradeAudit ya calculadas
 * @param {object}  ctx   — contexto
 * @param {Date}    ahora — timestamp
 */
function _actualizarViewActiveStudents_(filas, ctx, ahora) {
  if (filas.length === 0) return;

  const schema    = _gaSchema_();
  const iStud     = schema.indexOf("StudentID");
  const iColor    = schema.indexOf("SemaforoColor");
  const colorPrio = { RED: 4, YELLOW: 3, GREEN: 2, GREY: 1 };

  // Determinar peor color por estudiante
  const worstColor = {};
  filas.forEach(function(fila) {
    const sid   = String(fila[iStud]  || "").trim();
    const color = String(fila[iColor] || "GREY").trim();
    const prio  = colorPrio[color] || 1;
    if (!worstColor[sid] || prio > (colorPrio[worstColor[sid]] || 0)) {
      worstColor[sid] = color;
    }
  });

  // Leer ViewActiveStudents y actualizar solo las columnas del semáforo
  const vasMem = _leerHoja_(ctx.biSS.getSheetByName("ViewActiveStudents"));
  const vIdx   = vasMem.idx;

  let actualizados = 0;
  vasMem.datos.forEach(function(row) {
    const sid = String(row[vIdx["StudentID"]] || "").trim();
    if (worstColor[sid] !== undefined) {
      // Mapear color a StatusCode válido en _CFG_STATUSES (StatusType=RISK)
      row[vIdx["ActiveRiskStatusCode"]] = worstColor[sid];
      row[vIdx["GeneratedAt"]]          = ahora;
      actualizados++;
    }
  });

  _escribirEnBatch_(ctx.biSS.getSheetByName("ViewActiveStudents"), vasMem);
  Logger.log("  ViewActiveStudents: " + actualizados + " estudiantes actualizados.");
}

/**
 * Upsert de RiskFlags para estudiantes RED.
 *
 * Para estudiantes RED:
 *   - Si no existe flag activa (StudentID + SubjectCode) → crea nueva flag
 * Para estudiantes no-RED:
 *   - Si existe flag activa → marca IsActive=false, registra ResolvedAt/ResolvedBy
 *
 * Clave de idempotencia: StudentID + SubjectCode (una flag activa por combinación).
 *
 * @param {Array[]} filas   — filas GradeAudit calculadas
 * @param {object}  ctx     — contexto
 * @param {Date}    ahora   — timestamp
 * @param {string}  usuario — email del ejecutor
 */
function _actualizarRiskFlags_(filas, ctx, ahora, usuario) {
  if (filas.length === 0) return;

  const schema  = _gaSchema_();
  const iStud   = schema.indexOf("StudentID");
  const iSubj   = schema.indexOf("SubjectCode");
  const iColor  = schema.indexOf("SemaforoColor");
  const iMom    = schema.indexOf("MomentCode");
  const iEnt    = schema.indexOf("EntryCohortCode");

  const adminSS = ctx.adminSS;
  const riskMem = _leerHoja_(adminSS.getSheetByName("RiskFlags"));
  const rfIdx   = riskMem.idx;

  // Indexar flags activas por clave StudentID|SubjectCode → posición en datos[]
  const flagsActivas = {};
  riskMem.datos.forEach(function(row, i) {
    const isActive = row[rfIdx["IsActive"]];
    if (isActive === true || String(isActive).toUpperCase() === "TRUE") {
      const key = String(row[rfIdx["StudentID"]]   || "") + "|" +
                  String(row[rfIdx["SubjectCode"]]  || "");
      flagsActivas[key] = i;
    }
  });

  let nuevos = 0, resueltos = 0;

  filas.forEach(function(fila) {
    const studentId   = String(fila[iStud]  || "").trim();
    const subjectCode = String(fila[iSubj]  || "").trim();
    const color       = String(fila[iColor] || "").trim();
    const momentCode  = String(fila[iMom]   || "").trim();
    const entryCohort = String(fila[iEnt]   || "").trim();
    const key         = studentId + "|" + subjectCode;

    if (color === "RED") {
      // Crear flag solo si no existe una activa
      if (flagsActivas[key] === undefined) {
        const newFlag = new Array(riskMem.encabezado.length).fill("");
        if (rfIdx["RiskID"]         !== undefined) newFlag[rfIdx["RiskID"]]         = uuid("rsk");
        if (rfIdx["StudentID"]      !== undefined) newFlag[rfIdx["StudentID"]]      = studentId;
        if (rfIdx["DeploymentID"]   !== undefined) newFlag[rfIdx["DeploymentID"]]   = "";  // v2: resolver via GradeAudit
        if (rfIdx["SubjectCode"]    !== undefined) newFlag[rfIdx["SubjectCode"]]    = subjectCode;
        if (rfIdx["EntryCohortCode"]!== undefined) newFlag[rfIdx["EntryCohortCode"]]= entryCohort;
        if (rfIdx["RiskStatusCode"] !== undefined) newFlag[rfIdx["RiskStatusCode"]] = "RED";
        if (rfIdx["RiskCategory"]   !== undefined) newFlag[rfIdx["RiskCategory"]]   = "ACADEMIC";
        if (rfIdx["Description"]    !== undefined) newFlag[rfIdx["Description"]]    =
          "Semáforo " + momentCode + ": promedio período < 3.0";
        if (rfIdx["FlaggedAt"]      !== undefined) newFlag[rfIdx["FlaggedAt"]]      = ahora;
        if (rfIdx["FlaggedBy"]      !== undefined) newFlag[rfIdx["FlaggedBy"]]      = usuario;
        if (rfIdx["IsActive"]       !== undefined) newFlag[rfIdx["IsActive"]]       = true;
        riskMem.datos.push(newFlag);
        nuevos++;
      }

    } else {
      // Resolver flag activa si el estudiante ya mejoró
      if (flagsActivas[key] !== undefined) {
        const rowIdx = flagsActivas[key];
        if (rfIdx["IsActive"]   !== undefined) riskMem.datos[rowIdx][rfIdx["IsActive"]]   = false;
        if (rfIdx["ResolvedAt"] !== undefined) riskMem.datos[rowIdx][rfIdx["ResolvedAt"]] = ahora;
        if (rfIdx["ResolvedBy"] !== undefined) riskMem.datos[rowIdx][rfIdx["ResolvedBy"]] = usuario;
        if (rfIdx["RiskStatusCode"] !== undefined) riskMem.datos[rowIdx][rfIdx["RiskStatusCode"]] = "GREEN";
        resueltos++;
        delete flagsActivas[key];
      }
    }
  });

  if (nuevos > 0 || resueltos > 0) {
    _escribirEnBatch_(adminSS.getSheetByName("RiskFlags"), riskMem);
    Logger.log("  RiskFlags — Nuevas: " + nuevos + " | Resueltas: " + resueltos);
  } else {
    Logger.log("  RiskFlags — Sin cambios.");
  }
}


// ═════════════════════════════════════════════════════════════════
// SECCIÓN 7: HELPERS PRIVADOS
// ═════════════════════════════════════════════════════════════════

/**
 * Verifica si hoy cae dentro de un receso académico activo.
 * Un receso aplica si IsActive=true y AppliesTo = "ALL" o no está vacío.
 *
 * @param {Date}   ahora — timestamp actual
 * @param {object} ctx   — contexto con recessRows y recessIdx
 * @returns {boolean}
 */
function _estaEnReceso_(ahora, ctx) {
  const rIdx   = ctx.recessIdx;
  const iStart = rIdx["StartDate"];
  const iEnd   = rIdx["EndDate"];
  const iTo    = rIdx["AppliesTo"];
  const iActiv = rIdx["IsActive"];
  const hoy    = ahora.getTime();

  return ctx.recessRows.some(function(row) {
    const activo = row[iActiv];
    if (activo !== true && String(activo).toUpperCase() !== "TRUE") return false;
    const start = new Date(row[iStart]).getTime();
    const end   = new Date(row[iEnd]).getTime();
    if (isNaN(start) || isNaN(end) || hoy < start || hoy > end) return false;
    // AppliesTo=ALL aplica a todos; cualquier otro valor = receso de cohorte específico
    const applyTo = String(row[iTo] || "").trim().toUpperCase();
    return applyTo !== "";  // Cualquier receso con AppliesTo no vacío congela el semáforo
  });
}

/**
 * Registra el resultado de la ejecución en AutomationLogs (append).
 * Falla silenciosamente para no interrumpir el flujo principal.
 *
 * @param {string} result   — "SUCCESS" | "SKIPPED" | "ERROR"
 * @param {string} errorMsg — mensaje de error (vacío si SUCCESS)
 * @param {object} resumen  — contadores del ciclo
 * @param {Date}   ahora    — timestamp
 * @param {string} usuario  — email del ejecutor
 * @param {object|null} ctx — contexto (puede ser null si falló antes de cargar)
 */
function _registrarLogSemaforo_(result, errorMsg, resumen, ahora, usuario, ctx) {
  try {
    const adminSS = ctx ? ctx.adminSS : getSpreadsheetByName("admin");
    const logMem  = _leerHoja_(adminSS.getSheetByName("AutomationLogs"));
    const lIdx    = logMem.idx;

    const msg = resumen.skipped
      ? errorMsg
      : ("Procesados=" + resumen.procesados +
         " | GREEN="   + resumen.greenCount +
         " | YELLOW="  + resumen.yellowCount +
         " | RED="     + resumen.redCount +
         " | GREY="    + resumen.greyCount +
         " | Errores=" + resumen.errores +
         (errorMsg ? " | " + errorMsg : ""));

    const logRow = new Array(logMem.encabezado.length).fill("");
    if (lIdx["LogID"]            !== undefined) logRow[lIdx["LogID"]]            = uuid("log");
    if (lIdx["System"]           !== undefined) logRow[lIdx["System"]]           = "SHEETS";
    if (lIdx["Action"]           !== undefined) logRow[lIdx["Action"]]           = "RISK_SCAN";
    if (lIdx["Origin"]           !== undefined) logRow[lIdx["Origin"]]           = "ejecutarSemaforo";
    if (lIdx["Result"]           !== undefined) logRow[lIdx["Result"]]           = result;
    if (lIdx["RecordsProcessed"] !== undefined) logRow[lIdx["RecordsProcessed"]] = resumen.procesados;
    if (lIdx["ErrorMessage"]     !== undefined) logRow[lIdx["ErrorMessage"]]     =
      result === "SUCCESS" ? "" : errorMsg;
    if (lIdx["ExecutedAt"]       !== undefined) logRow[lIdx["ExecutedAt"]]       = ahora;
    if (lIdx["ExecutedBy"]       !== undefined) logRow[lIdx["ExecutedBy"]]       = usuario;

    logMem.datos.push(logRow);
    _escribirEnBatch_(adminSS.getSheetByName("AutomationLogs"), logMem);

  } catch (eLog) {
    Logger.log("  WARN: No se pudo escribir AutomationLogs: " + eLog.message);
  }
}

/**
 * Adquiere el LockService del script para evitar ejecuciones concurrentes del semáforo.
 * Timeout de 15 segundos — si el semáforo ya está corriendo, retorna null.
 *
 * @returns {Lock|null}
 */
function _lockSemaforo_() {
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) {
      Logger.log("  Lock ocupado — el semáforo ya está en ejecución.");
      return null;
    }
    Logger.log("  Lock adquirido");
    return lock;
  } catch (e) {
    Logger.log("  ERROR al adquirir lock: " + e.message);
    return null;
  }
}

/**
 * Orden canónico de columnas de GradeAudit.
 * Espeja el schema definido en 01_SIDEP_TABLES.js (BI_TABLES.GradeAudit).
 * Centralizado aquí para garantizar que _buildGaRow_() y las lecturas
 * de índice (indexOf) sean siempre consistentes.
 *
 * @returns {string[]}
 */
function _gaSchema_() {
  return [
    "GradeAuditID",     // 0
    "StudentID",        // 1
    "FullName",         // 2
    "ProgramCode",      // 3
    "EntryCohortCode",  // 4
    "SubjectCode",      // 5
    "SubjectName",      // 6
    "MomentCode",       // 7
    "WindowCohortCode", // 8
    "Nota",             // 9
    "Nivel",            // 10
    "SemaforoColor",    // 11
    "Fuente",           // 12
    "ActConNota",       // 13
    "ActSinNota",       // 14
    "PromedioAcumulado",// 15
    "NivelAcumulado",   // 16
    "GeneratedAt"       // 17
  ];
}

/**
 * Construye una fila de GradeAudit en el orden del schema.
 * Cualquier columna ausente en data queda como cadena vacía.
 *
 * @param {string[]} schema — columnas en orden (_gaSchema_())
 * @param {object}   data   — { colName: value }
 * @returns {Array}
 */
function _buildGaRow_(schema, data) {
  return schema.map(function(col) {
    const val = data[col];
    return (val !== undefined && val !== null) ? val : "";
  });
}

/**
 * Convierte las filas de _CFG_SEMAFORO en un objeto de configuración listo para usar.
 *
 * Lee solo los registros con IsActive=TRUE. Por cada ConfigKey conocido toma
 * ConfigValue como número. Si la tabla no existe, está vacía, o falta alguna
 * clave, usa el default hardcodeado de CFG_SEMAFORO — el semáforo nunca queda
 * roto por datos ausentes en Sheets.
 *
 * Claves esperadas en _CFG_SEMAFORO (poblarSemaforoConfig_ las siembra):
 *   ESCALA_MIN, ESCALA_MAX, UMBRAL_GREEN, UMBRAL_YELLOW, UMBRAL_APROBACION,
 *   NIVEL_EXCELENTE_MIN, NIVEL_BUENO_MIN
 *
 * @param {{ datos: Array[], idx: object, encabezado: string[] }} cfgMem
 *        — resultado de _leerHoja_() sobre la hoja _CFG_SEMAFORO.
 *          Si la hoja no existe _leerHoja_() devuelve datos=[] e idx={}.
 * @returns {object} cfg — objeto con los 7 umbrales resueltos
 */
function _resolverCfg_(cfgMem) {
  const cfg = {};

  // Defaults hardcodeados — siempre aplicados primero
  const defaults = {
    ESCALA_MIN:        CFG_SEMAFORO.ESCALA_MIN,
    ESCALA_MAX:        CFG_SEMAFORO.ESCALA_MAX,
    UMBRAL_GREEN:      CFG_SEMAFORO.UMBRAL_GREEN,
    UMBRAL_YELLOW:     CFG_SEMAFORO.UMBRAL_YELLOW,
    UMBRAL_APROBACION: CFG_SEMAFORO.UMBRAL_YELLOW,  // mismo umbral por política v4.3.0
    NIVEL_EXCELENTE_MIN: 4.5,
    NIVEL_BUENO_MIN:     4.0
  };
  Object.keys(defaults).forEach(function(k) { cfg[k] = defaults[k]; });

  // Si la tabla está vacía o no existe, devolver defaults
  if (!cfgMem || !cfgMem.datos || cfgMem.datos.length === 0) {
    Logger.log("  CFG_SEMAFORO: tabla vacía — usando defaults hardcodeados.");
    return cfg;
  }

  const idx      = cfgMem.idx;
  const iKey     = idx["ConfigKey"];
  const iVal     = idx["ConfigValue"];
  const iActive  = idx["IsActive"];

  if (iKey === undefined || iVal === undefined) {
    Logger.log("  CFG_SEMAFORO: columnas ConfigKey/ConfigValue no encontradas — usando defaults.");
    return cfg;
  }

  let leídos = 0;
  cfgMem.datos.forEach(function(row) {
    const active = iActive !== undefined ? row[iActive] : true;
    if (active !== true && String(active || "").toUpperCase() !== "TRUE") return;

    const key = String(row[iKey] || "").trim();
    const val = Number(row[iVal]);

    if (key && !isNaN(val) && defaults.hasOwnProperty(key)) {
      cfg[key] = val;
      leídos++;
    }
  });

  Logger.log("  CFG_SEMAFORO: " + leídos + " umbrales cargados desde Sheets" +
    (leídos < Object.keys(defaults).length
      ? " (" + (Object.keys(defaults).length - leídos) + " usando defaults)"
      : " — todos los umbrales desde Sheets."));

  return cfg;
}
