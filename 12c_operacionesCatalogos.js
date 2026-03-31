/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 12c_operacionesCatalogos.gs
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Lógica de negocio para operaciones de mantenimiento sobre
 *   las tablas _CFG_* sin necesidad de correr poblarConfiguraciones({force:true}).
 *
 *   Complementa 02_poblarConfiguraciones.gs (bootstrap inicial).
 *   NO lo reemplaza. El bootstrap sigue siendo necesario la primera vez.
 *
 * REGLA DE ORO — SRP por archivo:
 *   00_SIDEP_CONFIG.gs  → parámetros del sistema
 *   01_SIDEP_TABLES.gs  → modelo de datos (tablas + constantes)
 *   02_SIDEP_HELPERS.gs → infraestructura reutilizable (Drive, Sheets, utils)
 *   12c_operacionesCatalogos.gs → lógica de negocio sobre catálogos  ← este archivo
 *
 * CUÁNDO USAR ESTE ARCHIVO vs poblarConfiguraciones({force:true}):
 *   ┌─────────────────────────────────────┬────────────────────────────┐
 *   │ Situación                           │ Usar                       │
 *   ├─────────────────────────────────────┼────────────────────────────┤
 *   │ Primera vez (entorno vacío)         │ poblarConfiguraciones()    │
 *   │ Agregar un cohorte nuevo            │ agregarCohorte()           │
 *   │ Agregar un período a un cohorte     │ agregarPeriodo()           │
 *   │ Reescribir una sola tabla _CFG_*    │ repoblarTabla()            │
 *   │ Corregir datos en múltiples tablas  │ repoblarTabla() × N        │
 *   │ Schema cambió (+ columnas nuevas)   │ poblarConfiguraciones()    │
 *   └─────────────────────────────────────┴────────────────────────────┘
 *
 * PRINCIPIOS DE DISEÑO:
 *
 *   1. ATOMICIDAD POR TABLA:
 *      repoblarTabla() usa backup en memoria vía _backupHoja_() / _restaurarHoja_()
 *      (definidos en 02_SIDEP_HELPERS.gs). Si falla la escritura, restaura el backup.
 *
 *   2. PROTECCIÓN B:
 *      agregarCohorte() / agregarPeriodo() verifican si el cohorte ya existe
 *      Y tiene deployments / matrículas activos antes de permitir cambios.
 *      → Con datos activos: LANZA ERROR (requiere force explícito)
 *      → Sin datos activos: actualiza libremente
 *      → No existe: crea sin restricciones
 *
 *   3. SIN HARDCODING DE COHORTES:
 *      Las funciones reciben config como parámetro.
 *      Las llamadas con datos concretos viven en 99_orquestador.gs.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs  → SIDEP_CONFIG
 *   01_SIDEP_TABLES.gs  → CORE_TABLES, ADMIN_TABLES, BI_TABLES, COLUMN_TYPES
 *   02_SIDEP_HELPERS.gs → getSpreadsheetByName(), nowSIDEP(), uuid(),
 *                         _leerHoja_(), _escribirEnBatch_(),
 *                         _backupHoja_(), _restaurarHoja_(),
 *                         aplicarDropdownsCatalogo()  ← genérico, vive en helpers
 *   12_poblarConfiguraciones.gs → debe haberse ejecutado antes (bootstrap)
 *
 * FUNCIONES PÚBLICAS:
 *   repoblarTabla(tableName)      → reescribe 1 tabla con rollback
 *   agregarCohorte(config)        → upsert cohorte con protección B
 *   agregarPeriodo(config)        → upsert período con protección B
 *   aplicarTiposPostBootstrap()   → aplica DROPDOWN_CAT a los 3 SS del ecosistema
 *   diagnosticoCohorte(code)      → estado completo de un cohorte
 *   listarCohortes()              → todos los cohortes en el sistema
 *   listarPeriodos(cohortCode)    → períodos de un cohorte
 *
 * VÍA ORQUESTADOR (recomendado):
 *   paso_agregarCohorte_MY26()  → en 99_orquestador.gs
 *   paso_agregarCohorte_AG26()  → en 99_orquestador.gs
 *
 * VERSIÓN: 1.2.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-27
 *
 * CAMBIOS v1.2.0 vs v1.1.0:
 *   - NUEVO aplicarTiposPostBootstrap(): orquestador de post-bootstrap.
 *     Itera los 3 SS y llama aplicarDropdownsCatalogo() (02_SIDEP_HELPERS.gs)
 *     sobre cada uno. Es el paso que completa el tipado de columnas después
 *     de que poblarConfiguraciones() ha llenado los catálogos _CFG_*.
 *     Llamar desde 99_orquestador.gs como paso 2.5 del onboarding.
 *   - Actualizado DEPENDE DE: lista COLUMN_TYPES y aplicarDropdownsCatalogo()
 *     explícitamente para dejar claro que esta función vive en helpers,
 *     no aquí. 12c es el orquestador de negocio; helpers tiene la lógica.
 *
 * CAMBIOS v1.1.0 vs v1.0.0 — Refactoring SRP v4.2.0:
 *   - ELIMINADOS helpers genéricos de Sheet a 02_SIDEP_HELPERS.gs:
 *       _leerHoja_(), _escribirEnBatch_(), _backupHoja_(), _restaurarHoja_()
 *   - Sección 5 conserva solo helpers de negocio de catálogos.
 * ============================================================
 */


// ═══════════════════════════════════════════════════════════════
// SECCIÓN 0 — aplicarTiposPostBootstrap: tipado completo post-bootstrap
// ═══════════════════════════════════════════════════════════════

/**
 * Aplica tipos de columna completos (CHECKBOX + DATE + DROPDOWN_INLINE + DROPDOWN_CAT)
 * a los 3 Spreadsheets del ecosistema SIDEP.
 *
 * CUÁNDO EJECUTAR:
 *   Inmediatamente después de poblarConfiguraciones() en el onboarding.
 *   Los catálogos _CFG_* deben estar poblados para que los DROPDOWN_CAT
 *   tengan valores. Sin datos en catálogos → dropdowns omitidos silenciosamente.
 *
 *   Orden recomendado en 99_orquestador.gs:
 *     paso 1:   setupSidepTables()          → crea hojas + tablas + tipos simples
 *     paso 2:   poblarConfiguraciones()     → llena catálogos _CFG_*
 *     paso 2.5: aplicarTiposPostBootstrap() ← este paso
 *     paso 3:   poblarSyllabus()
 *     ...
 *
 * IDEMPOTENTE: se puede re-ejecutar si cambian los catálogos (ej: nuevo cohorte).
 *   Reemplaza columnProperties completas — no acumula.
 *
 * IMPLEMENTACIÓN:
 *   La lógica de tipado vive en aplicarDropdownsCatalogo() en 02_SIDEP_HELPERS.gs.
 *   Esta función es el orquestador que itera los 3 SS con sus tablas correspondientes.
 *   Separación SRP: helpers tiene la lógica, 12c tiene el conocimiento de qué
 *   tablas van en qué Spreadsheet.
 */
function aplicarTiposPostBootstrap() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔤 aplicarTiposPostBootstrap — ecosistema completo");
  Logger.log("════════════════════════════════════════════════");

  const tiempoInicio = Date.now();

  const FILE_MAP = [
    { key: "core",  tables: CORE_TABLES  },
    { key: "admin", tables: ADMIN_TABLES },
    { key: "bi",    tables: BI_TABLES    }
  ];

  FILE_MAP.forEach(function(f) {
    const ss = getSpreadsheetByName(f.key);
    aplicarDropdownsCatalogo(ss, f.tables);
  });

  const dur = ((Date.now() - tiempoInicio) / 1000).toFixed(1);
  Logger.log("\n════════════════════════════════════════════════");
  Logger.log("✅ Tipos aplicados en " + dur + "s");
  Logger.log("⏭  SIGUIENTE: poblarSyllabus()");
  Logger.log("════════════════════════════════════════════════");
}


// ═══════════════════════════════════════════════════════════════
// SECCIÓN 1 — repoblarTabla: reescritura atómica con rollback
// ═══════════════════════════════════════════════════════════════

/**
 * Reescribe UNA tabla _CFG_* con protección de rollback.
 *
 * Usa _backupHoja_() y _restaurarHoja_() de 02_SIDEP_HELPERS.gs.
 *
 * Flujo:
 *   1. Lee datos actuales → backup en memoria (_backupHoja_)
 *   2. Llama a la función poblar* correspondiente (_ejecutarPoblar_)
 *   3. Si falla → restaura backup automáticamente (_restaurarHoja_)
 *   4. Si ok   → log de éxito
 *
 * TABLAS SOPORTADAS:
 *   _CFG_COHORTS | _CFG_COHORT_CALENDAR | _CFG_SUBJECTS |
 *   _CFG_STATUSES | _CFG_RECESSES | _CFG_PROGRAMS |
 *   _CFG_MOMENTS  | _CFG_MODALITIES | _CFG_CAMPUSES | _CFG_MONTH_CODES
 *
 * @param {string} tableName — nombre exacto de la tabla (ej: "_CFG_COHORTS")
 *
 * EJEMPLOS:
 *   repoblarTabla("_CFG_COHORTS")          // solo cohorts
 *   repoblarTabla("_CFG_COHORT_CALENDAR")  // solo calendario
 *   repoblarTabla("_CFG_SUBJECTS")         // solo materias
 */
function repoblarTabla(tableName) {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔄 repoblarTabla: " + tableName);
  Logger.log("════════════════════════════════════════════════");

  const TABLAS_SOPORTADAS = [
    "_CFG_COHORTS", "_CFG_COHORT_CALENDAR", "_CFG_SUBJECTS",
    "_CFG_STATUSES", "_CFG_RECESSES",       "_CFG_PROGRAMS",
    "_CFG_MOMENTS",  "_CFG_MODALITIES",     "_CFG_CAMPUSES",
    "_CFG_MONTH_CODES"
  ];

  if (TABLAS_SOPORTADAS.indexOf(tableName) === -1) {
    throw new Error(
      "repoblarTabla: tabla no soportada → '" + tableName + "'.\n" +
      "Soportadas: " + TABLAS_SOPORTADAS.join(", ")
    );
  }

  const ahora    = nowSIDEP();
  const ejecutor = Session.getEffectiveUser().getEmail();
  const coreSS   = getSpreadsheetByName("core");
  const hoja     = coreSS.getSheetByName(tableName);

  if (!hoja) {
    throw new Error(
      "repoblarTabla: hoja '" + tableName + "' no encontrada.\n" +
      "¿Ejecutaste setupSidepTables() primero?"
    );
  }

  // ── 1. Backup en memoria (02_SIDEP_HELPERS.gs) ───────────────
  const backup = _backupHoja_(hoja);
  Logger.log("  💾 Backup: " + backup.datos.length + " filas guardadas");

  // ── 2. Limpiar tabla ─────────────────────────────────────────
  if (hoja.getLastRow() > 1) {
    hoja.getRange(2, 1, hoja.getLastRow() - 1, hoja.getLastColumn()).clearContent();
    Logger.log("  🗑  Limpiada: " + tableName);
  }

  // ── 3. Intentar escribir nuevos datos ────────────────────────
  try {
    _ejecutarPoblar_(tableName, coreSS, ahora, ejecutor);
    Logger.log("  ✅ " + tableName + " repoblada exitosamente");

  } catch (e) {
    // ── 4. Rollback (02_SIDEP_HELPERS.gs) ────────────────────
    Logger.log("  ❌ ERROR al escribir: " + e.message);
    Logger.log("  🔄 Restaurando backup...");
    _restaurarHoja_(hoja, backup);
    Logger.log("  ✅ Backup restaurado — " + tableName + " intacta");
    throw new Error(
      "repoblarTabla fallida en " + tableName + ": " + e.message +
      "\nDatos originales restaurados correctamente."
    );
  }
}


// ═══════════════════════════════════════════════════════════════
// SECCIÓN 2 — agregarCohorte: upsert con protección B
// ═══════════════════════════════════════════════════════════════

/**
 * Agrega o actualiza un cohorte en _CFG_COHORTS con protección B.
 *
 * PROTECCIÓN B:
 *   → Cohorte NO existe          → CREA sin restricciones ✅
 *   → Cohorte existe, SIN deployments → ACTUALIZA libremente ✅
 *   → Cohorte existe, CON deployments → LANZA ERROR 🛑
 *     Para forzar: agregarCohorte(config, { forceUpdate: true })
 *
 * @param {Object} config
 *   config.code       {string}  — "MY26" | "AG26" | "SP26" | "AB26"...
 *   config.label      {string}  — "Mayo 2026"
 *   config.year       {number}  — 2026
 *   config.modality   {string}  — "DIR" | "ART"
 *   config.isActive   {boolean} — true si ya abre este período
 *   config.notes      {string}  — opcional
 *
 * @param {Object} opts
 *   opts.forceUpdate  {boolean} — true para actualizar incluso con deployments
 */
function agregarCohorte(config, opts) {
  opts = opts || {};
  const forceUpdate = opts.forceUpdate === true;

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔄 agregarCohorte: " + (config.code || "?"));
  Logger.log("════════════════════════════════════════════════");

  _validarConfigCohorte_(config);

  const ahora    = nowSIDEP();
  const ejecutor = Session.getEffectiveUser().getEmail();
  const coreSS   = getSpreadsheetByName("core");
  const hoja     = coreSS.getSheetByName("_CFG_COHORTS");

  if (!hoja) throw new Error("agregarCohorte: hoja _CFG_COHORTS no encontrada.");

  // ── Leer estado actual ────────────────────────────────────────
  const mem      = _leerHoja_(hoja);
  const iCode    = mem.idx["CohortCode"];
  let existente  = null;
  let filaIdx    = -1;

  for (let i = 0; i < mem.datos.length; i++) {
    if (String(mem.datos[i][iCode]).trim().toUpperCase() === config.code.toUpperCase()) {
      existente = mem.datos[i];
      filaIdx   = i;
      break;
    }
  }

  // ── Protección B ─────────────────────────────────────────────
  if (existente && !forceUpdate) {
    const deployments = _contarDeploymentsPorCohorte_(coreSS, config.code);
    if (deployments > 0) {
      throw new Error(
        "🛑 PROTECCIÓN B — agregarCohorte abortado.\n" +
        "El cohorte '" + config.code + "' ya tiene " + deployments + " deployment(s) activo(s).\n" +
        "Actualizar fechas o estado de un cohorte en producción puede romper el Semáforo.\n\n" +
        "OPCIONES:\n" +
        "  1. Si el cambio es solo activar (IsActive false→true):\n" +
        "     → agregarCohorte(config, { forceUpdate: true })\n" +
        "  2. Si necesitas cambiar fechas del calendario:\n" +
        "     → agregarPeriodo() para el período específico\n" +
        "  3. Si el cohorte entero es incorrecto:\n" +
        "     → Revisar con diagnosticoCohorte('" + config.code + "') primero"
      );
    }
    Logger.log("  ℹ️  Cohorte existe sin deployments — actualizando libremente");
  }

  // ── Construir fila ────────────────────────────────────────────
  const iCohortID = mem.idx["CohortID"];
  const iLabel    = mem.idx["CohortLabel"];
  const iYear     = mem.idx["AcademicYear"];
  const iModal    = mem.idx["ModalityCode"];
  const iActive   = mem.idx["IsActive"];
  const iNotes    = mem.idx["Notes"];
  const iCreatedAt= mem.idx["CreatedAt"];
  const iCreatedBy= mem.idx["CreatedBy"];
  const iUpdatedAt= mem.idx["UpdatedAt"];
  const iUpdatedBy= mem.idx["UpdatedBy"];

  if (existente) {
    // UPDATE — preservar CohortID y CreatedAt/By originales
    existente[iLabel]    = config.label;
    existente[iYear]     = config.year;
    existente[iModal]    = config.modality;
    existente[iActive]   = config.isActive;
    existente[iNotes]    = config.notes || existente[iNotes] || "";
    existente[iUpdatedAt]= ahora;
    existente[iUpdatedBy]= ejecutor;
    Logger.log("  ↺ Actualizado: " + config.code);

  } else {
    // INSERT — nueva fila
    const nuevaFila = new Array(mem.encabezado.length).fill("");
    nuevaFila[iCohortID] = "coh_" + config.code.toLowerCase();
    nuevaFila[iCode]     = config.code;
    nuevaFila[iLabel]    = config.label;
    nuevaFila[iYear]     = config.year;
    nuevaFila[iModal]    = config.modality;
    nuevaFila[iActive]   = config.isActive;
    nuevaFila[iNotes]    = config.notes || "";
    nuevaFila[iCreatedAt]= ahora;
    nuevaFila[iCreatedBy]= ejecutor;
    nuevaFila[iUpdatedAt]= ahora;
    nuevaFila[iUpdatedBy]= ejecutor;
    mem.datos.push(nuevaFila);
    Logger.log("  + Insertado: " + config.code);
  }

  // ── Escribir en batch (02_SIDEP_HELPERS.gs) ──────────────────
  _escribirEnBatch_(hoja, mem);
  Logger.log("  ✅ _CFG_COHORTS actualizada (" + mem.datos.length + " cohortes)");
}


// ═══════════════════════════════════════════════════════════════
// SECCIÓN 3 — agregarPeriodo: upsert de calendario con protección B
// ═══════════════════════════════════════════════════════════════

/**
 * Agrega o actualiza un período en _CFG_COHORT_CALENDAR con protección B.
 *
 * PROTECCIÓN B:
 *   → Período NO existe              → CREA sin restricciones ✅
 *   → Período existe, SIN matrículas → ACTUALIZA fechas libremente ✅
 *   → Período existe, CON matrículas → LANZA ERROR 🛑
 *     Para forzar: agregarPeriodo(config, { forceUpdate: true })
 *
 * NOTA: config.cohortCode = cohorte de ENTRADA del estudiante.
 * La ventana que creó las aulas (MR26, AB26...) vive en MasterDeployments.
 *
 * @param {Object} config
 *   config.cohortCode     {string}  — cohorte de ENTRADA (FB26, EN26, MR26...)
 *   config.momentCode     {string}  — A1B1|A1B2|C1M1|C1M2|...
 *   config.periodLabel    {string}  — "Año 1 Bloque 2" | "C1 Momento 1"
 *   config.startDate      {Date}    — usar d_(year, month, day)
 *   config.endDate        {Date}    — usar d_(year, month, day)
 *   config.weeksEffective {number}  — semanas reales descontando recesos
 *   config.isFinalPeriod  {boolean} — true solo en el último período del programa
 *   config.isActive       {boolean} — true si el período ya inició
 *   config.notes          {string}  — opcional
 *
 * @param {Object} opts
 *   opts.forceUpdate {boolean} — true para actualizar aunque haya matrículas
 */
function agregarPeriodo(config, opts) {
  opts = opts || {};
  const forceUpdate = opts.forceUpdate === true;

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔄 agregarPeriodo: " + config.cohortCode + "/" + config.momentCode);
  Logger.log("════════════════════════════════════════════════");

  _validarConfigPeriodo_(config);

  const ahora    = nowSIDEP();
  const ejecutor = Session.getEffectiveUser().getEmail();
  const coreSS   = getSpreadsheetByName("core");
  const adminSS  = getSpreadsheetByName("admin");
  const hoja     = coreSS.getSheetByName("_CFG_COHORT_CALENDAR");

  if (!hoja) throw new Error("agregarPeriodo: hoja _CFG_COHORT_CALENDAR no encontrada.");

  if (!_cohortExiste_(coreSS, config.cohortCode)) {
    throw new Error(
      "agregarPeriodo: el cohorte '" + config.cohortCode + "' no existe en _CFG_COHORTS.\n" +
      "Ejecuta agregarCohorte() primero."
    );
  }

  // ── Leer estado actual ────────────────────────────────────────
  const mem      = _leerHoja_(hoja);
  const iCohort  = mem.idx["CohortCode"];
  const iMoment  = mem.idx["MomentCode"];
  let existente  = null;

  for (let i = 0; i < mem.datos.length; i++) {
    const matchCohort = String(mem.datos[i][iCohort]).trim() === config.cohortCode;
    const matchMoment = String(mem.datos[i][iMoment]).trim() === config.momentCode;
    if (matchCohort && matchMoment) {
      existente = mem.datos[i];
      break;
    }
  }

  // ── Protección B ─────────────────────────────────────────────
  if (existente && !forceUpdate) {
    const matriculas = _contarMatriculasPorPeriodo_(adminSS, config.cohortCode, config.momentCode);
    if (matriculas > 0) {
      throw new Error(
        "🛑 PROTECCIÓN B — agregarPeriodo abortado.\n" +
        "El período " + config.cohortCode + "/" + config.momentCode +
        " ya tiene " + matriculas + " matrícula(s) activa(s).\n" +
        "Modificar fechas de un período con estudiantes activos puede romper el Semáforo.\n\n" +
        "OPCIONES:\n" +
        "  1. Si solo cambias IsActive o Notes:\n" +
        "     → agregarPeriodo(config, { forceUpdate: true })\n" +
        "  2. Si cambias fechas con estudiantes activos:\n" +
        "     → Revisar impacto con diagnosticoCohorte('" + config.cohortCode + "') primero\n" +
        "     → Luego: agregarPeriodo(config, { forceUpdate: true })"
      );
    }
    Logger.log("  ℹ️  Período existe sin matrículas — actualizando libremente");
  }

  // ── Construir fila ────────────────────────────────────────────
  const iCalID    = mem.idx["CalendarID"];
  const iLabel    = mem.idx["PeriodLabel"];
  const iStart    = mem.idx["StartDate"];
  const iEnd      = mem.idx["EndDate"];
  const iWeeks    = mem.idx["WeeksEffective"];
  const iFinal    = mem.idx["IsFinalPeriod"];
  const iActive   = mem.idx["IsActive"];
  const iNotes    = mem.idx["Notes"];
  const iCreatedAt= mem.idx["CreatedAt"];
  const iCreatedBy= mem.idx["CreatedBy"];
  const iUpdatedAt= mem.idx["UpdatedAt"];
  const iUpdatedBy= mem.idx["UpdatedBy"];

  if (existente) {
    // UPDATE — preservar CalendarID y CreatedAt/By
    existente[iLabel]    = config.periodLabel;
    existente[iStart]    = config.startDate;
    existente[iEnd]      = config.endDate;
    existente[iWeeks]    = config.weeksEffective;
    existente[iFinal]    = config.isFinalPeriod;
    existente[iActive]   = config.isActive;
    existente[iNotes]    = config.notes || "";
    existente[iUpdatedAt]= ahora;
    existente[iUpdatedBy]= ejecutor;
    Logger.log("  ↺ Actualizado: " + config.cohortCode + "/" + config.momentCode);

  } else {
    // INSERT — nueva fila
    const nuevaFila = new Array(mem.encabezado.length).fill("");
    nuevaFila[iCalID]    = "cal_" + config.cohortCode + "_" + config.momentCode;
    nuevaFila[iCohort]   = config.cohortCode;
    nuevaFila[iMoment]   = config.momentCode;
    nuevaFila[iLabel]    = config.periodLabel;
    nuevaFila[iStart]    = config.startDate;
    nuevaFila[iEnd]      = config.endDate;
    nuevaFila[iWeeks]    = config.weeksEffective;
    nuevaFila[iFinal]    = config.isFinalPeriod;
    nuevaFila[iActive]   = config.isActive;
    nuevaFila[iNotes]    = config.notes || "";
    nuevaFila[iCreatedAt]= ahora;
    nuevaFila[iCreatedBy]= ejecutor;
    nuevaFila[iUpdatedAt]= ahora;
    nuevaFila[iUpdatedBy]= ejecutor;
    mem.datos.push(nuevaFila);
    Logger.log("  + Insertado: " + config.cohortCode + "/" + config.momentCode);
  }

  // ── Escribir en batch (02_SIDEP_HELPERS.gs) ──────────────────
  _escribirEnBatch_(hoja, mem);
  Logger.log("  ✅ _CFG_COHORT_CALENDAR actualizada");
}


// ═══════════════════════════════════════════════════════════════
// SECCIÓN 4 — Funciones de diagnóstico (solo lectura)
// ═══════════════════════════════════════════════════════════════

/**
 * Estado completo de un cohorte: períodos, deployments, matrículas.
 * Solo lectura — no modifica nada.
 *
 * @param {string} cohortCode — ej: "MR26", "FB26", "MY26"
 */
function diagnosticoCohorte(cohortCode) {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔍 diagnosticoCohorte: " + cohortCode);
  Logger.log("════════════════════════════════════════════════");

  const coreSS  = getSpreadsheetByName("core");
  const adminSS = getSpreadsheetByName("admin");

  if (!_cohortExiste_(coreSS, cohortCode)) {
    Logger.log("  ❌ Cohorte '" + cohortCode + "' no existe en _CFG_COHORTS");
    return;
  }

  // ── Períodos en _CFG_COHORT_CALENDAR ─────────────────────────
  const hojaCal  = coreSS.getSheetByName("_CFG_COHORT_CALENDAR");
  const calData  = hojaCal ? hojaCal.getDataRange().getValues() : [];
  const calHead  = calData.length > 0 ? calData[0] : [];
  const iCohort  = calHead.indexOf("CohortCode");
  const iMoment  = calHead.indexOf("MomentCode");
  const iStart   = calHead.indexOf("StartDate");
  const iEnd     = calHead.indexOf("EndDate");
  const iActive  = calHead.indexOf("IsActive");
  const periodos = [];

  for (let r = 1; r < calData.length; r++) {
    if (String(calData[r][iCohort]).trim() === cohortCode) {
      periodos.push({
        moment: calData[r][iMoment],
        start:  calData[r][iStart],
        end:    calData[r][iEnd],
        active: calData[r][iActive]
      });
    }
  }

  Logger.log("\n📅 Períodos (" + periodos.length + "):");
  periodos.forEach(function(p) {
    const fechaStr = p.start === "PENDIENTE" ? "PENDIENTE" :
      (p.start instanceof Date ? Utilities.formatDate(p.start, "America/Bogota", "dd-MMM-yyyy") : String(p.start))
      + " → " +
      (p.end instanceof Date ? Utilities.formatDate(p.end, "America/Bogota", "dd-MMM-yyyy") : String(p.end));
    Logger.log("  " + (p.active ? "✅" : "⏳") + " " + p.moment + " | " + fechaStr);
  });

  // ── Deployments en MasterDeployments ─────────────────────────
  const hojaDepl  = coreSS.getSheetByName("MasterDeployments");
  const deplData  = hojaDepl ? hojaDepl.getDataRange().getValues() : [];
  const deplHead  = deplData.length > 0 ? deplData[0] : [];
  const iNom      = deplHead.indexOf("GeneratedNomenclature");
  const iStatus   = deplHead.indexOf("ScriptStatusCode");
  const deplCount = { CREATED: 0, PENDING: 0, ERROR: 0, total: 0 };

  for (let d = 1; d < deplData.length; d++) {
    const nom = String(deplData[d][iNom] || "");
    if (nom.indexOf(cohortCode) !== -1) {
      const st = String(deplData[d][iStatus] || "UNKNOWN");
      deplCount[st] = (deplCount[st] || 0) + 1;
      deplCount.total++;
    }
  }

  Logger.log("\n🏫 Deployments: " + deplCount.total + " total");
  if (deplCount.CREATED) Logger.log("   CREATED: " + deplCount.CREATED);
  if (deplCount.PENDING) Logger.log("   PENDING: " + deplCount.PENDING);
  if (deplCount.ERROR)   Logger.log("   ERROR:   " + deplCount.ERROR);

  // ── Matrículas en Enrollments ─────────────────────────────────
  const hojaEnr   = adminSS.getSheetByName("Enrollments");
  const enrData   = hojaEnr ? hojaEnr.getDataRange().getValues() : [];
  const enrHead   = enrData.length > 0 ? enrData[0] : [];
  const iEntryC   = enrHead.indexOf("EntryCohortCode");
  const iWindowC  = enrHead.indexOf("WindowCohortCode");
  const iEnrSt    = enrHead.indexOf("EnrollmentStatusCode");
  let enrCount    = 0;
  let enrActivos  = 0;

  for (let e = 1; e < enrData.length; e++) {
    const entryMatch  = String(enrData[e][iEntryC]  || "").trim() === cohortCode;
    const windowMatch = String(enrData[e][iWindowC] || "").trim() === cohortCode;
    if (entryMatch || windowMatch) {
      enrCount++;
      if (String(enrData[e][iEnrSt]).trim() === "ACTIVE") enrActivos++;
    }
  }

  Logger.log("\n👥 Matrículas: " + enrCount + " total | " + enrActivos + " activas");

  Logger.log("\n🛡️  Estado Protección B:");
  if (deplCount.total > 0) {
    Logger.log("   agregarCohorte() → BLOQUEADO (tiene " + deplCount.total + " deployments)");
    Logger.log("   agregarPeriodo() → BLOQUEADO si el período tiene matrículas");
  } else {
    Logger.log("   agregarCohorte() → LIBRE (sin deployments)");
    Logger.log("   agregarPeriodo() → LIBRE (sin deployments)");
  }
  Logger.log("════════════════════════════════════════════════");
}


/**
 * Lista todos los cohortes registrados en el sistema. Solo lectura.
 */
function listarCohortes() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("📋 listarCohortes — estado actual");
  Logger.log("════════════════════════════════════════════════");

  const coreSS = getSpreadsheetByName("core");
  const hoja   = coreSS.getSheetByName("_CFG_COHORTS");
  if (!hoja) { Logger.log("❌ _CFG_COHORTS no encontrada"); return; }

  const data    = hoja.getDataRange().getValues();
  const head    = data[0];
  const iCode   = head.indexOf("CohortCode");
  const iLabel  = head.indexOf("CohortLabel");
  const iModal  = head.indexOf("ModalityCode");
  const iActive = head.indexOf("IsActive");

  Logger.log("\nCódigo  Modalidad  Activo  Nombre");
  Logger.log("──────  ─────────  ──────  ──────────────────────");

  for (let r = 1; r < data.length; r++) {
    const code   = String(data[r][iCode]   || "").padEnd(7);
    const modal  = String(data[r][iModal]  || "").padEnd(10);
    const active = data[r][iActive] ? "✅" : "⏳";
    const label  = String(data[r][iLabel]  || "");
    Logger.log(code + " " + modal + " " + active + "     " + label);
  }

  Logger.log("\nTotal: " + (data.length - 1) + " cohortes");
  Logger.log("════════════════════════════════════════════════");
}


/**
 * Lista los períodos de un cohorte con sus fechas y estado. Solo lectura.
 *
 * @param {string} cohortCode — ej: "FB26"
 */
function listarPeriodos(cohortCode) {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("📅 listarPeriodos: " + cohortCode);
  Logger.log("════════════════════════════════════════════════");

  const coreSS  = getSpreadsheetByName("core");
  const hoja    = coreSS.getSheetByName("_CFG_COHORT_CALENDAR");
  if (!hoja) { Logger.log("❌ _CFG_COHORT_CALENDAR no encontrada"); return; }

  const data    = hoja.getDataRange().getValues();
  const head    = data[0];
  const iCohort = head.indexOf("CohortCode");
  const iMoment = head.indexOf("MomentCode");
  const iStart  = head.indexOf("StartDate");
  const iEnd    = head.indexOf("EndDate");
  const iWeeks  = head.indexOf("WeeksEffective");
  const iActive = head.indexOf("IsActive");
  const iNotes  = head.indexOf("Notes");
  let count     = 0;

  for (let r = 1; r < data.length; r++) {
    if (String(data[r][iCohort]).trim() !== cohortCode) continue;
    count++;
    const moment  = String(data[r][iMoment] || "?");
    const start   = data[r][iStart];
    const end     = data[r][iEnd];
    const weeks   = data[r][iWeeks];
    const active  = data[r][iActive];
    const notes   = String(data[r][iNotes]  || "");

    const startStr = start === "PENDIENTE" ? "PENDIENTE" :
      (start instanceof Date
        ? Utilities.formatDate(start, "America/Bogota", "dd-MMM-yy")
        : String(start));
    const endStr   = end === "PENDIENTE" ? "PENDIENTE" :
      (end instanceof Date
        ? Utilities.formatDate(end, "America/Bogota", "dd-MMM-yy")
        : String(end));

    const icon = active ? "✅" : (start === "PENDIENTE" ? "❓" : "⏳");
    Logger.log(icon + " " + moment.padEnd(5) + " | " +
      startStr.padEnd(11) + " → " + endStr.padEnd(11) +
      " | " + weeks + " sem" +
      (notes ? " | " + notes.substring(0, 50) : ""));
  }

  if (count === 0) Logger.log("  No se encontraron períodos para " + cohortCode);
  else Logger.log("\nTotal: " + count + " períodos");
  Logger.log("════════════════════════════════════════════════");
}


// ═══════════════════════════════════════════════════════════════
// SECCIÓN 5 — Helpers privados de negocio (sufijo _ = uso interno)
// ═══════════════════════════════════════════════════════════════
//
// IMPORTANTE — separación de responsabilidades:
//   Los helpers GENÉRICOS de Sheet (_leerHoja_, _escribirEnBatch_,
//   _backupHoja_, _restaurarHoja_) viven en 02_SIDEP_HELPERS.gs.
//   Los helpers listados aquí son ESPECÍFICOS de la lógica de negocio
//   de catálogos — no tienen utilidad fuera de este archivo.

/**
 * Redirige la ejecución a la función poblar* correcta según el nombre de tabla.
 * Solo usada por repoblarTabla(). Centraliza el mapeo tabla → función.
 */
function _ejecutarPoblar_(tableName, ss, ahora, ejecutor) {
  const mapa = {
    "_CFG_MONTH_CODES":     poblarMonthCodes_,
    "_CFG_COHORTS":         poblarCohorts_,
    "_CFG_PROGRAMS":        poblarPrograms_,
    "_CFG_MODALITIES":      poblarModalities_,
    "_CFG_MOMENTS":         poblarMoments_,
    "_CFG_CAMPUSES":        poblarCampuses_,
    "_CFG_STATUSES":        poblarStatuses_,
    "_CFG_SUBJECTS":        poblarSubjects_,
    "_CFG_COHORT_CALENDAR": poblarCohortCalendar_,
    "_CFG_RECESSES":        poblarRecesses_
  };
  const fn = mapa[tableName];
  if (!fn) throw new Error("_ejecutarPoblar_: función no encontrada para " + tableName);
  fn(ss, ahora, ejecutor);
}


/**
 * Cuenta cuántos deployments tiene un cohorte (como ventana en GeneratedNomenclature).
 * Usado por la protección B de agregarCohorte().
 */
function _contarDeploymentsPorCohorte_(coreSS, cohortCode) {
  const hoja = coreSS.getSheetByName("MasterDeployments");
  if (!hoja) return 0;
  const data = hoja.getDataRange().getValues();
  const head = data[0];
  const iNom = head.indexOf("GeneratedNomenclature");
  if (iNom === -1) return 0;
  let count = 0;
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][iNom] || "").indexOf(cohortCode) !== -1) count++;
  }
  return count;
}


/**
 * Cuenta matrículas activas de un cohorte y momento específico.
 * Usado por la protección B de agregarPeriodo().
 */
function _contarMatriculasPorPeriodo_(adminSS, cohortCode, momentCode) {
  const hoja = adminSS.getSheetByName("Enrollments");
  if (!hoja) return 0;
  const data    = hoja.getDataRange().getValues();
  const head    = data[0];
  const iEntry  = head.indexOf("EntryCohortCode");
  const iMoment = head.indexOf("MomentCode");
  const iStatus = head.indexOf("EnrollmentStatusCode");
  if (iEntry === -1 || iMoment === -1) return 0;
  let count = 0;
  for (let r = 1; r < data.length; r++) {
    const matchCohort = String(data[r][iEntry]  || "").trim() === cohortCode;
    const matchMoment = String(data[r][iMoment] || "").trim() === momentCode;
    const esActiva    = String(data[r][iStatus] || "").trim() === "ACTIVE";
    if (matchCohort && matchMoment && esActiva) count++;
  }
  return count;
}


/**
 * Verifica si un cohorte existe en _CFG_COHORTS.
 */
function _cohortExiste_(coreSS, cohortCode) {
  const hoja = coreSS.getSheetByName("_CFG_COHORTS");
  if (!hoja) return false;
  const data  = hoja.getDataRange().getValues();
  const iCode = data[0].indexOf("CohortCode");
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][iCode] || "").trim() === cohortCode) return true;
  }
  return false;
}


/**
 * Valida el objeto config de agregarCohorte().
 */
function _validarConfigCohorte_(config) {
  if (!config)           throw new Error("agregarCohorte: config es obligatorio");
  if (!config.code)      throw new Error("agregarCohorte: config.code es obligatorio");
  if (!config.label)     throw new Error("agregarCohorte: config.label es obligatorio");
  if (!config.year)      throw new Error("agregarCohorte: config.year es obligatorio");
  if (!config.modality)  throw new Error("agregarCohorte: config.modality es obligatorio (DIR|ART)");
  if (["DIR","ART"].indexOf(config.modality) === -1) {
    throw new Error("agregarCohorte: config.modality inválido → '" + config.modality +
                    "'. Válidos: DIR | ART");
  }
  if (typeof config.isActive !== "boolean") {
    throw new Error("agregarCohorte: config.isActive debe ser true o false");
  }
}


/**
 * Valida el objeto config de agregarPeriodo().
 */
function _validarConfigPeriodo_(config) {
  if (!config)                     throw new Error("agregarPeriodo: config es obligatorio");
  if (!config.cohortCode)          throw new Error("agregarPeriodo: config.cohortCode es obligatorio");
  if (!config.momentCode)          throw new Error("agregarPeriodo: config.momentCode es obligatorio");
  if (!config.periodLabel)         throw new Error("agregarPeriodo: config.periodLabel es obligatorio");
  if (!config.startDate)           throw new Error("agregarPeriodo: config.startDate es obligatorio (usar d_())");
  if (!config.endDate)             throw new Error("agregarPeriodo: config.endDate es obligatorio (usar d_())");
  if (!config.weeksEffective)      throw new Error("agregarPeriodo: config.weeksEffective es obligatorio");
  if (typeof config.isFinalPeriod !== "boolean") {
    throw new Error("agregarPeriodo: config.isFinalPeriod debe ser true o false");
  }
  if (typeof config.isActive !== "boolean") {
    throw new Error("agregarPeriodo: config.isActive debe ser true o false");
  }
}