/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL
 * Archivo: 02c_operacionesCatalogos.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * PROPÓSITO:
 *   Operaciones de mantenimiento sobre las tablas _CFG_* sin
 *   necesidad de correr poblarConfiguraciones({force:true}).
 *
 *   Complementa 02_poblarConfiguraciones.gs (bootstrap inicial).
 *   NO lo reemplaza. El bootstrap sigue siendo necesario la
 *   primera vez. Este archivo gestiona el día a día después.
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
 *      Cada operación hace backup antes de limpiar.
 *      Si falla la escritura, restaura el backup.
 *      Una tabla que falla no afecta el resto.
 *
 *   2. PROTECCIÓN OPCIÓN B:
 *      agregarCohorte() / agregarPeriodo() verifican si el
 *      cohorte ya existe Y tiene deployments activos.
 *      → Si tiene deployments: LANZA ERROR (requiere force explícito)
 *      → Si no tiene deployments: actualiza libremente
 *      → Si no existe: crea sin restricciones
 *      Previene sobreescribir cohortes en producción por accidente.
 *
 *   3. SCHEMA_TYPE (preparación Fase 2):
 *      _CFG_PROGRAMS tiene un campo Notes donde se registra
 *      SchemaType como "schema:DIR_ART" hasta que Fase 2 agregue
 *      la columna formal. Los scripts futuros pueden leer Notes
 *      y extraer el schema con split(':')[1].
 *      Valores actuales: DIR_ART
 *      Valores futuros:  DIPLOMADO | CURSO | BOOTCAMP
 *
 *   4. SIN HARDCODING DE COHORTES EN ESTE ARCHIVO:
 *      agregarCohorte() y agregarPeriodo() reciben config como
 *      parámetro. El orquestador 99_orquestador.gs tiene las
 *      llamadas con los datos — este archivo solo tiene la lógica.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs → getSpreadsheetByName(), nowSIDEP(), uuid()
 *   02_poblarConfiguraciones.gs → debe haberse ejecutado antes
 *
 * FUNCIONES PÚBLICAS:
 *   repoblarTabla(tableName)    → reescribe 1 tabla con rollback
 *   agregarCohorte(config)      → upsert cohorte con protección B
 *   agregarPeriodo(config)      → upsert período con protección B
 *   diagnosticoCohorte(code)    → estado completo de un cohorte
 *   listarCohortes()            → todos los cohortes en el sistema
 *   listarPeriodos(cohortCode)  → períodos de un cohorte
 *
 * VÍA ORQUESTADOR (recomendado):
 *   paso_agregarCohorte_MY26()  → en 99_orquestador.gs
 *   paso_agregarCohorte_AG26()  → en 99_orquestador.gs
 *   etc.
 *
 * VERSIÓN: 1.0.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-25
 * ============================================================
 */


// ═══════════════════════════════════════════════════════════════
// SECCIÓN 1 — repoblarTabla: reescritura atómica con rollback
// ═══════════════════════════════════════════════════════════════

/**
 * Reescribe UNA tabla _CFG_* con protección de rollback.
 *
 * Flujo:
 *   1. Lee datos actuales → backup en memoria
 *   2. Llama a la función poblar* correspondiente
 *   3. Si falla → restaura backup automáticamente
 *   4. Si ok   → log de éxito
 *
 * TABLAS SOPORTADAS:
 *   _CFG_COHORTS | _CFG_COHORT_CALENDAR | _CFG_SUBJECTS |
 *   _CFG_STATUSES | _CFG_RECESSES | _CFG_PROGRAMS |
 *   _CFG_MOMENTS | _CFG_MODALITIES | _CFG_CAMPUSES | _CFG_MONTH_CODES
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

  var TABLAS_SOPORTADAS = [
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

  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();
  var coreSS   = getSpreadsheetByName("core");
  var hoja     = coreSS.getSheetByName(tableName);

  if (!hoja) {
    throw new Error(
      "repoblarTabla: hoja '" + tableName + "' no encontrada.\n" +
      "¿Ejecutaste setupSidepTables() primero?"
    );
  }

  // ── 1. Backup en memoria ──────────────────────────────────────
  var backup = _backupHoja_(hoja);
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
    // ── 4. Rollback si falla ─────────────────────────────────
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
 *     Para forzar actualización con deployments existentes:
 *     agregarCohorte(config, { forceUpdate: true })
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
 *
 * EJEMPLOS:
 *   // Agregar un cohorte nuevo inactivo (aún no abre):
 *   agregarCohorte({ code:"MY26", label:"Mayo 2026", year:2026,
 *                    modality:"DIR", isActive:false })
 *
 *   // Activar un cohorte que ya estaba registrado:
 *   agregarCohorte({ code:"MY26", label:"Mayo 2026", year:2026,
 *                    modality:"DIR", isActive:true })
 *
 *   // Registrar ventana articulada:
 *   agregarCohorte({ code:"AB26", label:"Abril 2026", year:2026,
 *                    modality:"ART", isActive:true,
 *                    notes:"Ventana aulas ART-2026-A1B2" })
 */
function agregarCohorte(config, opts) {
  opts = opts || {};
  var forceUpdate = opts.forceUpdate === true;

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔄 agregarCohorte: " + (config.code || "?"));
  Logger.log("════════════════════════════════════════════════");

  // ── Validar config ────────────────────────────────────────────
  _validarConfigCohorte_(config);

  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();
  var coreSS   = getSpreadsheetByName("core");
  var hoja     = coreSS.getSheetByName("_CFG_COHORTS");

  if (!hoja) throw new Error("agregarCohorte: hoja _CFG_COHORTS no encontrada.");

  // ── Leer estado actual ────────────────────────────────────────
  var mem      = _leerHoja_(hoja);
  var iCode    = mem.idx["CohortCode"];
  var existente = null;
  var filaIdx  = -1;

  for (var i = 0; i < mem.datos.length; i++) {
    if (String(mem.datos[i][iCode]).trim().toUpperCase() === config.code.toUpperCase()) {
      existente = mem.datos[i];
      filaIdx   = i;
      break;
    }
  }

  // ── Protección B ─────────────────────────────────────────────
  if (existente && !forceUpdate) {
    var deployments = _contarDeploymentsPorCohorte_(coreSS, config.code);
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
  var iCohortID = mem.idx["CohortID"];
  var iLabel    = mem.idx["CohortLabel"];
  var iYear     = mem.idx["AcademicYear"];
  var iModal    = mem.idx["ModalityCode"];
  var iActive   = mem.idx["IsActive"];
  var iNotes    = mem.idx["Notes"];
  var iCreatedAt= mem.idx["CreatedAt"];
  var iCreatedBy= mem.idx["CreatedBy"];
  var iUpdatedAt= mem.idx["UpdatedAt"];
  var iUpdatedBy= mem.idx["UpdatedBy"];

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
    var nuevaFila = new Array(mem.encabezado.length).fill("");
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

  // ── Escribir en batch ─────────────────────────────────────────
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
 * NOTA SOBRE COHORTE DE ENTRADA vs VENTANA:
 *   config.cohortCode = cohorte de ENTRADA del estudiante (FB26, EN26...).
 *   La ventana que creó las aulas (AB26, MR26...) es un dato de MasterDeployments,
 *   no de este calendario. Ver documentación de arquitectura en 02_poblarConfiguraciones.gs.
 *
 * @param {Object} config
 *   config.cohortCode    {string}  — cohorte de ENTRADA (FB26, EN26, MR26...)
 *   config.momentCode    {string}  — A1B1|A1B2|C1M1|C1M2|...
 *   config.periodLabel   {string}  — "Año 1 Bloque 2" | "C1 Momento 1"
 *   config.startDate     {Date}    — usar d_(year, month, day) de 02_poblarConfiguraciones.gs
 *   config.endDate       {Date}    — usar d_(year, month, day)
 *   config.weeksEffective {number} — semanas reales descontando recesos
 *   config.isFinalPeriod {boolean} — true solo en el último período del programa
 *   config.isActive      {boolean} — true si el período ya inició
 *   config.notes         {string}  — opcional: info de ventana, recesos, etc.
 *
 * @param {Object} opts
 *   opts.forceUpdate {boolean} — true para actualizar aunque haya matrículas
 *
 * EJEMPLOS:
 *   // Registrar período confirmado:
 *   agregarPeriodo({
 *     cohortCode: "FB26", momentCode: "A1B3",
 *     periodLabel: "Año 1 Bloque 3",
 *     startDate: d_(2026,8,4), endDate: d_(2026,9,25),
 *     weeksEffective: 8, isFinalPeriod: false, isActive: false,
 *     notes: "Ventana AG26 (compartida DIR C2M2)"
 *   });
 *
 *   // Activar un período que ya llegó:
 *   agregarPeriodo({
 *     cohortCode: "MY26", momentCode: "C2M1",
 *     periodLabel: "C2 Momento 1",
 *     startDate: d_(2026,5,19), endDate: d_(2026,7,31),
 *     weeksEffective: 8, isFinalPeriod: false, isActive: true,
 *     notes: "MY26 entra en C2M1"
 *   });
 */
function agregarPeriodo(config, opts) {
  opts = opts || {};
  var forceUpdate = opts.forceUpdate === true;

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔄 agregarPeriodo: " + config.cohortCode + "/" + config.momentCode);
  Logger.log("════════════════════════════════════════════════");

  // ── Validar config ────────────────────────────────────────────
  _validarConfigPeriodo_(config);

  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();
  var coreSS   = getSpreadsheetByName("core");
  var adminSS  = getSpreadsheetByName("admin");
  var hoja     = coreSS.getSheetByName("_CFG_COHORT_CALENDAR");

  if (!hoja) throw new Error("agregarPeriodo: hoja _CFG_COHORT_CALENDAR no encontrada.");

  // ── Verificar que el cohorte existe en _CFG_COHORTS ──────────
  if (!_cohortExiste_(coreSS, config.cohortCode)) {
    throw new Error(
      "agregarPeriodo: el cohorte '" + config.cohortCode + "' no existe en _CFG_COHORTS.\n" +
      "Ejecuta agregarCohorte() primero."
    );
  }

  // ── Leer estado actual del calendario ────────────────────────
  var mem      = _leerHoja_(hoja);
  var iCohort  = mem.idx["CohortCode"];
  var iMoment  = mem.idx["MomentCode"];
  var existente = null;
  var filaIdx  = -1;

  for (var i = 0; i < mem.datos.length; i++) {
    var matchCohort = String(mem.datos[i][iCohort]).trim() === config.cohortCode;
    var matchMoment = String(mem.datos[i][iMoment]).trim() === config.momentCode;
    if (matchCohort && matchMoment) {
      existente = mem.datos[i];
      filaIdx   = i;
      break;
    }
  }

  // ── Protección B ─────────────────────────────────────────────
  if (existente && !forceUpdate) {
    var matriculas = _contarMatriculasPorPeriodo_(adminSS, config.cohortCode, config.momentCode);
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
  var iCalID    = mem.idx["CalendarID"];
  var iLabel    = mem.idx["PeriodLabel"];
  var iStart    = mem.idx["StartDate"];
  var iEnd      = mem.idx["EndDate"];
  var iWeeks    = mem.idx["WeeksEffective"];
  var iFinal    = mem.idx["IsFinalPeriod"];
  var iActive   = mem.idx["IsActive"];
  var iNotes    = mem.idx["Notes"];
  var iCreatedAt= mem.idx["CreatedAt"];
  var iCreatedBy= mem.idx["CreatedBy"];
  var iUpdatedAt= mem.idx["UpdatedAt"];
  var iUpdatedBy= mem.idx["UpdatedBy"];

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
    var nuevaFila = new Array(mem.encabezado.length).fill("");
    nuevaFila[iCalID]   = "cal_" + config.cohortCode + "_" + config.momentCode;
    nuevaFila[iCohort]  = config.cohortCode;
    nuevaFila[iMoment]  = config.momentCode;
    nuevaFila[iLabel]   = config.periodLabel;
    nuevaFila[iStart]   = config.startDate;
    nuevaFila[iEnd]     = config.endDate;
    nuevaFila[iWeeks]   = config.weeksEffective;
    nuevaFila[iFinal]   = config.isFinalPeriod;
    nuevaFila[iActive]  = config.isActive;
    nuevaFila[iNotes]   = config.notes || "";
    nuevaFila[iCreatedAt]= ahora;
    nuevaFila[iCreatedBy]= ejecutor;
    nuevaFila[iUpdatedAt]= ahora;
    nuevaFila[iUpdatedBy]= ejecutor;
    mem.datos.push(nuevaFila);
    Logger.log("  + Insertado: " + config.cohortCode + "/" + config.momentCode);
  }

  // ── Escribir en batch ─────────────────────────────────────────
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

  var coreSS  = getSpreadsheetByName("core");
  var adminSS = getSpreadsheetByName("admin");

  // ── Verificar que existe ──────────────────────────────────────
  if (!_cohortExiste_(coreSS, cohortCode)) {
    Logger.log("  ❌ Cohorte '" + cohortCode + "' no existe en _CFG_COHORTS");
    return;
  }

  // ── Períodos en _CFG_COHORT_CALENDAR ─────────────────────────
  var hojaCal  = coreSS.getSheetByName("_CFG_COHORT_CALENDAR");
  var calData  = hojaCal ? hojaCal.getDataRange().getValues() : [];
  var calHead  = calData.length > 0 ? calData[0] : [];
  var iCohort  = calHead.indexOf("CohortCode");
  var iMoment  = calHead.indexOf("MomentCode");
  var iStart   = calHead.indexOf("StartDate");
  var iEnd     = calHead.indexOf("EndDate");
  var iActive  = calHead.indexOf("IsActive");
  var periodos = [];

  for (var r = 1; r < calData.length; r++) {
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
    var fechaStr = p.start === "PENDIENTE" ? "PENDIENTE" :
      (p.start instanceof Date ? Utilities.formatDate(p.start, "America/Bogota", "dd-MMM-yyyy") : String(p.start))
      + " → " +
      (p.end instanceof Date ? Utilities.formatDate(p.end, "America/Bogota", "dd-MMM-yyyy") : String(p.end));
    Logger.log("  " + (p.active ? "✅" : "⏳") + " " + p.moment + " | " + fechaStr);
  });

  // ── Deployments en MasterDeployments ─────────────────────────
  var hojaDepl = coreSS.getSheetByName("MasterDeployments");
  var deplData = hojaDepl ? hojaDepl.getDataRange().getValues() : [];
  var deplHead = deplData.length > 0 ? deplData[0] : [];
  var iNom     = deplHead.indexOf("GeneratedNomenclature");
  var iStatus  = deplHead.indexOf("ScriptStatusCode");
  var deplCount = { CREATED: 0, PENDING: 0, ERROR: 0, total: 0 };

  for (var d = 1; d < deplData.length; d++) {
    var nom = String(deplData[d][iNom] || "");
    if (nom.indexOf(cohortCode) !== -1) {
      var st = String(deplData[d][iStatus] || "UNKNOWN");
      deplCount[st] = (deplCount[st] || 0) + 1;
      deplCount.total++;
    }
  }

  Logger.log("\n🏫 Deployments: " + deplCount.total + " total");
  if (deplCount.CREATED) Logger.log("   CREATED: " + deplCount.CREATED);
  if (deplCount.PENDING) Logger.log("   PENDING: " + deplCount.PENDING);
  if (deplCount.ERROR)   Logger.log("   ERROR:   " + deplCount.ERROR);

  // ── Matrículas en Enrollments ─────────────────────────────────
  var hojaEnr  = adminSS.getSheetByName("Enrollments");
  var enrData  = hojaEnr ? hojaEnr.getDataRange().getValues() : [];
  var enrHead  = enrData.length > 0 ? enrData[0] : [];
  var iEntryC  = enrHead.indexOf("EntryCohortCode");
  var iWindowC = enrHead.indexOf("WindowCohortCode");
  var iEnrSt   = enrHead.indexOf("EnrollmentStatusCode");
  var enrCount = 0;
  var enrActivos = 0;

  for (var e = 1; e < enrData.length; e++) {
    var entryMatch  = String(enrData[e][iEntryC]  || "").trim() === cohortCode;
    var windowMatch = String(enrData[e][iWindowC] || "").trim() === cohortCode;
    if (entryMatch || windowMatch) {
      enrCount++;
      if (String(enrData[e][iEnrSt]).trim() === "ACTIVE") enrActivos++;
    }
  }

  Logger.log("\n👥 Matrículas: " + enrCount + " total | " + enrActivos + " activas");

  // ── Protección B — resumen ────────────────────────────────────
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
 * Lista todos los cohortes registrados en el sistema.
 * Solo lectura.
 */
function listarCohortes() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("📋 listarCohortes — estado actual");
  Logger.log("════════════════════════════════════════════════");

  var coreSS = getSpreadsheetByName("core");
  var hoja   = coreSS.getSheetByName("_CFG_COHORTS");
  if (!hoja) { Logger.log("❌ _CFG_COHORTS no encontrada"); return; }

  var data = hoja.getDataRange().getValues();
  var head = data[0];
  var iCode   = head.indexOf("CohortCode");
  var iLabel  = head.indexOf("CohortLabel");
  var iModal  = head.indexOf("ModalityCode");
  var iActive = head.indexOf("IsActive");

  Logger.log("\nCódigo  Modalidad  Activo  Nombre");
  Logger.log("──────  ─────────  ──────  ──────────────────────");

  for (var r = 1; r < data.length; r++) {
    var code   = String(data[r][iCode]   || "").padEnd(7);
    var modal  = String(data[r][iModal]  || "").padEnd(10);
    var active = data[r][iActive] ? "✅" : "⏳";
    var label  = String(data[r][iLabel]  || "");
    Logger.log(code + " " + modal + " " + active + "     " + label);
  }

  Logger.log("\nTotal: " + (data.length - 1) + " cohortes");
  Logger.log("════════════════════════════════════════════════");
}


/**
 * Lista los períodos de un cohorte con sus fechas y estado.
 * Solo lectura.
 *
 * @param {string} cohortCode — ej: "FB26"
 */
function listarPeriodos(cohortCode) {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("📅 listarPeriodos: " + cohortCode);
  Logger.log("════════════════════════════════════════════════");

  var coreSS  = getSpreadsheetByName("core");
  var hoja    = coreSS.getSheetByName("_CFG_COHORT_CALENDAR");
  if (!hoja) { Logger.log("❌ _CFG_COHORT_CALENDAR no encontrada"); return; }

  var data    = hoja.getDataRange().getValues();
  var head    = data[0];
  var iCohort = head.indexOf("CohortCode");
  var iMoment = head.indexOf("MomentCode");
  var iStart  = head.indexOf("StartDate");
  var iEnd    = head.indexOf("EndDate");
  var iWeeks  = head.indexOf("WeeksEffective");
  var iActive = head.indexOf("IsActive");
  var iNotes  = head.indexOf("Notes");
  var count   = 0;

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iCohort]).trim() !== cohortCode) continue;
    count++;
    var moment = String(data[r][iMoment] || "?");
    var start  = data[r][iStart];
    var end    = data[r][iEnd];
    var weeks  = data[r][iWeeks];
    var active = data[r][iActive];
    var notes  = String(data[r][iNotes]  || "");

    var startStr = start === "PENDIENTE" ? "PENDIENTE" :
      (start instanceof Date
        ? Utilities.formatDate(start, "America/Bogota", "dd-MMM-yy")
        : String(start));
    var endStr   = end === "PENDIENTE" ? "PENDIENTE" :
      (end instanceof Date
        ? Utilities.formatDate(end, "America/Bogota", "dd-MMM-yy")
        : String(end));

    var icon = active ? "✅" : (start === "PENDIENTE" ? "❓" : "⏳");
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
// SECCIÓN 5 — Helpers privados (sufijo _ = uso interno)
// ═══════════════════════════════════════════════════════════════

/**
 * Lee una hoja completa en memoria con índice de columnas por nombre.
 * Retorna { hoja, encabezado, datos, idx } donde idx[colName] = colIndex.
 */
function _leerHoja_(hoja) {
  var lastRow = hoja.getLastRow();
  var lastCol = hoja.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    return { hoja: hoja, encabezado: [], datos: [], idx: {} };
  }
  var encabezado = hoja.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = {};
  encabezado.forEach(function(col, i) {
    if (col !== "") idx[String(col)] = i;
  });
  var datos = lastRow > 1
    ? hoja.getRange(2, 1, lastRow - 1, lastCol).getValues()
    : [];
  return { hoja: hoja, encabezado: encabezado, datos: datos, idx: idx };
}


/**
 * Escribe todos los datos en memoria de vuelta al Sheet en UN batch.
 * Limpia las filas anteriores primero (evita datos basura).
 */
function _escribirEnBatch_(hoja, mem) {
  if (mem.datos.length === 0) return;
  var lastRow = hoja.getLastRow();
  if (lastRow > 1) {
    hoja.getRange(2, 1, lastRow - 1, hoja.getLastColumn()).clearContent();
  }
  hoja.getRange(2, 1, mem.datos.length, mem.encabezado.length).setValues(mem.datos);
}


/**
 * Guarda el contenido actual de una hoja en memoria para rollback.
 * @returns { encabezado, datos }
 */
function _backupHoja_(hoja) {
  var lastRow = hoja.getLastRow();
  var lastCol = hoja.getLastColumn();
  if (lastRow <= 1 || lastCol < 1) {
    return { encabezado: [], datos: [] };
  }
  var encabezado = hoja.getRange(1, 1, 1, lastCol).getValues()[0];
  var datos = hoja.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return { encabezado: encabezado, datos: datos };
}


/**
 * Restaura el contenido de una hoja desde un backup.
 */
function _restaurarHoja_(hoja, backup) {
  var lastRow = hoja.getLastRow();
  if (lastRow > 1) {
    hoja.getRange(2, 1, lastRow - 1, hoja.getLastColumn()).clearContent();
  }
  if (backup.datos.length > 0) {
    hoja.getRange(2, 1, backup.datos.length, backup.encabezado.length)
        .setValues(backup.datos);
  }
}


/**
 * Redirige la ejecución a la función poblar* correcta según el nombre de tabla.
 * Usada internamente por repoblarTabla().
 */
function _ejecutarPoblar_(tableName, ss, ahora, ejecutor) {
  var mapa = {
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
  var fn = mapa[tableName];
  if (!fn) throw new Error("_ejecutarPoblar_: función no encontrada para " + tableName);
  fn(ss, ahora, ejecutor);
}


/**
 * Cuenta cuántos deployments tiene un cohorte (como ventana en GeneratedNomenclature).
 * Usado por la protección B de agregarCohorte().
 */
function _contarDeploymentsPorCohorte_(coreSS, cohortCode) {
  var hoja = coreSS.getSheetByName("MasterDeployments");
  if (!hoja) return 0;
  var data = hoja.getDataRange().getValues();
  var head = data[0];
  var iNom = head.indexOf("GeneratedNomenclature");
  if (iNom === -1) return 0;
  var count = 0;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][iNom] || "").indexOf(cohortCode) !== -1) count++;
  }
  return count;
}


/**
 * Cuenta matrículas activas de un cohorte y momento específico.
 * Usado por la protección B de agregarPeriodo().
 */
function _contarMatriculasPorPeriodo_(adminSS, cohortCode, momentCode) {
  var hoja = adminSS.getSheetByName("Enrollments");
  if (!hoja) return 0;
  var data = hoja.getDataRange().getValues();
  var head = data[0];
  var iEntry  = head.indexOf("EntryCohortCode");
  var iMoment = head.indexOf("MomentCode");
  var iStatus = head.indexOf("EnrollmentStatusCode");
  if (iEntry === -1 || iMoment === -1) return 0;
  var count = 0;
  for (var r = 1; r < data.length; r++) {
    var matchCohort = String(data[r][iEntry]  || "").trim() === cohortCode;
    var matchMoment = String(data[r][iMoment] || "").trim() === momentCode;
    var esActiva    = String(data[r][iStatus] || "").trim() === "ACTIVE";
    if (matchCohort && matchMoment && esActiva) count++;
  }
  return count;
}


/**
 * Verifica si un cohorte existe en _CFG_COHORTS.
 */
function _cohortExiste_(coreSS, cohortCode) {
  var hoja = coreSS.getSheetByName("_CFG_COHORTS");
  if (!hoja) return false;
  var data  = hoja.getDataRange().getValues();
  var iCode = data[0].indexOf("CohortCode");
  for (var r = 1; r < data.length; r++) {
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