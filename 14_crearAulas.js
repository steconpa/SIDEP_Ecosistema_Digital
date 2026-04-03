/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 14_crearAulas.gs
 * Versión: 2.1
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Leer APERTURA_PLAN (decisiones de Carlos), generar filas PENDING
 *   en MasterDeployments y crear los cursos en Google Classroom.
 *   CERO lógica de estudiantes, docentes ni contenido pedagógico.
 *
 * CAMBIO ARQUITECTURAL v2.0 (respecto a v1.x):
 *   ANTES (v1.x): el sistema decidía qué aulas crear filtrando
 *     _CFG_SUBJECTS.DirStartMoment === momentCode. Lógica lineal fija.
 *   AHORA (v2.x): Carlos decide qué abre. Su decisión se registra en
 *     APERTURA_PLAN (via 12b_poblarAperturas.gs). Este script lee
 *     APERTURA_PLAN y ejecuta exactamente esas aperturas.
 *
 *   Consecuencias del cambio:
 *     - planificarDesdeAperturaPlan() es la función principal v4.
 *     - planificarDeployments() se conserva como @deprecated para
 *       compatibilidad con 99_orquestador.gs mientras se migra.
 *     - leerSubjectsMap_() usa headers dinámicos (no índices fijos)
 *       → inmune a cambios de schema entre v3.6.1 y v4.0.0.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs v4.0.0+ → SIDEP_CONFIG, getSpreadsheetByName(),
 *                                  nowSIDEP(), uuid(), MOMENT_ORDER,
 *                                  MOMENTOS_DIR, MOMENTOS_ART,
 *                                  PROGRAMAS_ESPECIFICOS
 *   02_poblarConfiguraciones.gs → _CFG_SUBJECTS poblada
 *   12b_poblarAperturas.gs      → APERTURA_PLAN con filas PENDIENTE
 *   Google Classroom API v1     → Editor GAS → ➕ Servicios →
 *                                  "Google Classroom API" → Agregar
 *
 * PRERREQUISITOS (en orden):
 *   ✅ setupSidepTables()          — hojas creadas, incluida APERTURA_PLAN
 *   ✅ poblarConfiguraciones()     — _CFG_SUBJECTS poblada
 *   ✅ poblarAperturas(cohort)     — APERTURA_PLAN con Status=PENDIENTE
 *   ✅ Classroom API habilitada    — el script la detecta si falta
 *
 * FUNCIONES PÚBLICAS:
 *   planificarDesdeAperturaPlan(opts) → PRINCIPAL v4: lee APERTURA_PLAN
 *   planificarYCrear(opts)            → ejecuta planificar + crearAulas
 *   crearAulas(opts)                  → procesa PENDING → Classroom API
 *   diagnosticoAulas()               → estado de MasterDeployments y APERTURA_PLAN
 *   planificarDeployments(opts)       → @deprecated (v1.x, conservada temporalmente)
 *   dryRunMR26_C1M2()                 → preview MR26/C1M2 sin ejecutar
 *   planificarYCrearMR26_C1M2()       → atajo lunes 17-mar-2026
 *
 * FLUJO COMPLETO POR PERÍODO:
 *   1. Carlos confirma asignaturas (WhatsApp/reunión)
 *   2. Stevens actualiza 12b_poblarAperturas.gs
 *   3. poblarAperturas({ cohortCode: 'MR26' })
 *   4. dryRunMR26_C1M2()                       ← preview sin tocar nada
 *   5. planificarYCrearMR26_C1M2()              ← ejecuta real
 *   6. diagnosticoAulas()                       ← verificar 8 CREATED
 *   7. estructurarAulas({ cohortCode: 'MR26' }) ← 05_estructurarAulas.gs
 *
 * MODELO CONVEYOR BELT (sin cambios desde v3.6.0):
 *   CohortCode en MasterDeployments = ventana que ABRIÓ el aula,
 *   no el cohorte de entrada del estudiante. Ver 00_SIDEP_CONFIG.gs.
 *   Secuencia 2026:
 *     EN26 abre C1M1 → planificarYCrear({cohortCode:'EN26', momentCode:'C1M1'})
 *     MR26 abre C1M2 → planificarYCrear({cohortCode:'MR26', momentCode:'C1M2'})
 *     MY26 abre C2M1 → planificarYCrear({cohortCode:'MY26', momentCode:'C2M1'})
 *     AG26 abre C2M2 → planificarYCrear({cohortCode:'AG26', momentCode:'C2M2'})
 *     SP26 abre C1M1 → planificarYCrear({cohortCode:'SP26', momentCode:'C1M1'})
 *
 * MATERIAS TRANSVERSALES (IsTransversal = true en _CFG_SUBJECTS):
 *   UNA sola aula TRV por materia y ventana — fuera del loop de programas.
 *   ProgramCode = 'TRV'. Nomenclatura: TRV-DIR-MR26-C1M2-MAT-001.
 *   Todos los estudiantes del momento se matriculan en esa aula compartida.
 *   APERTURA_PLAN registra transversales con IsTransversal=true y programCode='TRV'.
 *   planificarDesdeAperturaPlan() detecta duplicados TRV y crea solo una aula.
 *
 * CUOTAS Y TIEMPOS:
 *   Classroom API: ~500 cursos/día por cuenta de Google Workspace.
 *   GAS timeout:   6 minutos por ejecución.
 *   batchSize=20 + sleep(250ms) ≈ 80s → seguro dentro del timeout.
 *   SIDEP Fase 1: ~8 aulas por ventana → un solo batch alcanza para todo.
 *   Si hay errores: cambiar ScriptStatusCode a PENDING y re-ejecutar crearAulas().
 *
 * PATRÓN MEMORY-FIRST (aplicado en planificarDesdeAperturaPlan):
 *   Lee _CFG_SUBJECTS (1) + MasterDeployments (1) + APERTURA_PLAN (1)
 *   → procesa todo en memoria (JS puro, sin API)
 *   → escribe MasterDeployments en batch (1)
 *   → actualiza APERTURA_PLAN en batch: clearContent (1) + setValues (1)
 *   = 6 llamadas a Sheets fijas independiente del número de aperturas.
 *
 *   EXCEPCIÓN DOCUMENTADA en crearAulas():
 *   La escritura de ClassroomID/ClassroomURL/Status es individual por fila.
 *   Ver JSDoc de crearAulas() para la justificación completa.
 *
 * LOCKING (LockService):
 *   planificarDesdeAperturaPlan(force=true) adquiere lock.
 *   crearAulas() siempre adquiere lock — previene que dos ejecuciones
 *   concurrentes lean el mismo PENDING y creen el mismo curso dos veces.
 *   Timeout: 15s. Liberación garantizada en finally, incluso ante errores.
 *
 * ANTI-DUPLICACIÓN EN CLASSROOM:
 *   La GeneratedNomenclature (CTB-DIR-MR26-C1M2-SPC-001) es la clave
 *   de idempotencia. leerNomenclaturas_() construye un mapa O(1).
 *   planificarDesdeAperturaPlan() salta nomenclaturas existentes (salvo force).
 *   Re-ejecutar nunca crea cursos duplicados en Classroom.
 *
 * NOMENCLATURA CANÓNICA:
 *   Formato : {PROG}-{MODAL}-{COHORT}-{MOMENT}-{SUBJ}-{GROUP}
 *   Ejemplo : CTB-DIR-MR26-C1M2-SPC-001
 *   Classroom: [CTB] Soportes Contables | C1M2 · MR26
 *   SubjectName truncado a 50 chars si excede (límite UI Classroom ~80 chars).
 *
 * VERSIÓN: 2.1
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-14
 *
 * CAMBIOS v2.1 vs v2.0:
 *   CRÍTICOS (bugs corregidos):
 *   - NUEVO: planificarDesdeAperturaPlan() — función principal v4.
 *     Lee APERTURA_PLAN en lugar de recibir un config hardcodeado.
 *     Elimina la segunda fuente de verdad (MR26_C1M2_PLAN como var global).
 *   - NUEVO: LockService en planificarDesdeAperturaPlan(force) y crearAulas().
 *   - FIX: APERTURA_PLAN.AperturaStatus actualiza a CREADA en batch
 *     (clearContent + setValues). Antes nunca se actualizaba.
 *   - FIX: APERTURA_PLAN.DeploymentID se llena al planificar. Antes vacío.
 *   - FIX: new Date() → nowSIDEP() en todos los timestamps de crearAulas().
 *   - FIX: buildFila_() recibe depID explícito para vincular con APERTURA_PLAN.
 *     Antes generaba su propio ID internamente sin devolvérselo al llamador.
 *   FUNCIONALIDAD:
 *   - RESTAURADO: diagnosticoAulas() incluye porMom, trvCount, ARCHIVED
 *     y ordenación cronológica por MOMENT_ORDER. Todo esto existía en v1.4
 *     pero se perdió en v2.0.
 *   - MEJORADO: diagnosticoAulas() muestra estado de APERTURA_PLAN además
 *     de MasterDeployments.
 *   - NUEVO: constantes COL_APR y COL_DEP — índices de columna con nombre,
 *     eliminan índices mágicos dispersos en el código.
 *   DOCUMENTACIÓN:
 *   - JSDoc completo en todas las funciones: públicas y privadas.
 *   - Changelog completo con historia v1.0→v2.1.
 *   - Notas de cuotas, memory-first, locking y anti-duplicación en encabezado.
 *   COMPATIBILIDAD:
 *   - planificarDeployments() @deprecated pero conservada para 99_orquestador.gs.
 *   - leerSubjectsMap_() con headers dinámicos (ya desde v2.0) — compatible
 *     con _CFG_SUBJECTS v3.6.1 (17 cols) y v4.0.0 (19 cols).
 *
 * CAMBIOS v2.0 vs v1.4:
 *   - NUEVO modelo flexible: planificarManual(config) reemplazó
 *     planificarDeployments() como función principal.
 *     El config especifica qué materias abrir en lugar de derivarlas
 *     de DirStartMoment. (En v2.1 este rol pasó a planificarDesdeAperturaPlan.)
 *   - leerSubjectsMap_() con headers dinámicos reemplaza leerSubjects_()
 *     con índices fijos — resuelve incompatibilidad con schema v4.0.0.
 *   - Atajos dryRunMR26_C1M2() y planificarYCrearMR26_C1M2().
 *
 * CAMBIOS v1.4 vs v1.3:
 *   - nowSIDEP() en timestamps de MasterDeployments y Notes.
 *   - Comentario inline explica escritura individual post-Classroom.create().
 *
 * CAMBIOS v1.3 vs v1.2:
 *   - Conveyor Belt activado: eliminada COHORT_VENTANA_DIR_2026.
 *     cohortCode es obligatorio. Default "EN26" es solo fallback.
 *
 * CAMBIOS v1.2 vs v1.1:
 *   - Pipeline actualizado: 05_estructurarAulas antes de 06_importarDocentes.
 *
 * CAMBIOS v1.1 vs v1.0:
 *   FIX-1: Transversales ya no se duplican — una sola aula TRV por ventana.
 *   FIX-2: Sin momentCode bloquea ejecución (previene crear programa completo).
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// CONSTANTES DE COLUMNA (0-base)
// Mantener sincronizadas con los schemas en 00_SIDEP_CONFIG.gs.
// Si cambia el schema de APERTURA_PLAN o MasterDeployments, actualizar aquí.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// CONSTANTES DE COLUMNA (0-base)
// FIX-AUDIT C-4: Estos mapas now se validan en runtime contra los headers
// reales de Sheets al inicio de planificarDesdeAperturaPlan().
// Si hay desincronización, el script aborta con un mensaje claro.
// ─────────────────────────────────────────────────────────────

/**
 * Índices de columna de APERTURA_PLAN (0-base).
 * Espeja CORE_TABLES["APERTURA_PLAN"] en 00_SIDEP_CONFIG.gs.
 */
var COL_APR = {
  AperturaID:     0,
  CohortCode:     1,
  MomentCode:     2,
  SubjectCode:    3,
  ProgramCode:    4,
  IsTransversal:  5,
  AperturaStatus: 6,
  DeploymentID:   7,
  PlannedBy:      8,
  PlannedAt:      9,
  Notes:          10,
  CreatedAt:      11,
  CreatedBy:      12,
  UpdatedAt:      13,
  UpdatedBy:      14
};

/**
 * Índices de columna de MasterDeployments (0-base).
 * Espeja CORE_TABLES["MasterDeployments"] en 00_SIDEP_CONFIG.gs.
 */
var COL_DEP = {
  DeploymentID:           0,
  ProgramCode:            1,
  ModalityCode:           2,
  CohortCode:             3,
  MomentCode:             4,
  SubjectCode:            5,
  GroupCode:              6,
  SubjectName:            7,
  GeneratedNomenclature:  8,
  GeneratedClassroomName: 9,
  ClassroomID:            10,
  ClassroomURL:           11,
  ScriptStatusCode:       12,
  CampusCode:             13,
  CreatedAt:              14,
  CreatedBy:              15,
  Notes:                  16
};

/**
 * Valida que los índices de COL_APR y COL_DEP coincidan con los headers reales de Sheets.
 * FIX-AUDIT C-4: previene escritura silenciosa en columnas equivocadas si el schema cambia.
 *
 * @param {Sheet} hojaApr  - hoja APERTURA_PLAN
 * @param {Sheet} hojaDep  - hoja MasterDeployments
 * @throws {Error} si algún índice no coincide con el header real
 */
function validarColumnas_(hojaApr, hojaDep) {
  var errores = [];

  // Leer headers en una sola llamada por hoja
  var headersApr = hojaApr.getRange(1, 1, 1, hojaApr.getLastColumn()).getValues()[0];
  var headersDep = hojaDep.getRange(1, 1, 1, hojaDep.getLastColumn()).getValues()[0];

  Object.keys(COL_APR).forEach(function(col) {
    var esperado = COL_APR[col];
    var real     = headersApr[esperado];
    if (String(real || '').trim() !== col) {
      errores.push(
        'APERTURA_PLAN col ' + esperado + ': esperada "' + col +
        '", encontrada "' + real + '". ' +
        '¿Se agregó una columna antes de "' + col + '"? Actualizar COL_APR en este archivo.'
      );
    }
  });

  Object.keys(COL_DEP).forEach(function(col) {
    var esperado = COL_DEP[col];
    var real     = headersDep[esperado];
    if (String(real || '').trim() !== col) {
      errores.push(
        'MasterDeployments col ' + esperado + ': esperada "' + col +
        '", encontrada "' + real + '". ' +
        '¿Se agregó una columna antes de "' + col + '"? Actualizar COL_DEP en este archivo.'
      );
    }
  });

  if (errores.length > 0) {
    throw new Error(
      '[C-4 Schema Mismatch] Los índices de columna no coinciden con Sheets:\n  ' +
      errores.join('\n  ')
    );
  }
  Logger.log('  ✅ Columnas validadas: COL_APR y COL_DEP coinciden con los headers reales.');
}


// ─────────────────────────────────────────────────────────────
// ATAJOS — LUNES 17-MAR-2026 (MR26 · C1M2)
// Ejecutar en este orden:
//   1. dryRunMR26_C1M2()           → preview, no escribe nada
//   2. planificarYCrearMR26_C1M2() → ejecuta real
//   3. diagnosticoAulas()          → verificar 8 CREATED
// ─────────────────────────────────────────────────────────────

/**
 * Preview de MR26/C1M2 — muestra qué se crearía sin escribir ni llamar API.
 * Lee APERTURA_PLAN. Si no hay filas PENDIENTE para MR26/C1M2, indica que
 * hay que ejecutar poblarAperturas({cohortCode:'MR26'}) primero.
 */
function dryRunMR26_C1M2() {
  Logger.log('▶ DRY RUN MR26 · C1M2 — solo preview, no escribe nada');
  planificarDesdeAperturaPlan({ cohortCode: 'MR26', momentCode: 'C1M2', dryRun: true });
}

/**
 * Ejecución real MR26/C1M2.
 * Prerrequisito: poblarAperturas({cohortCode:'MR26'}) ya ejecutado.
 * Ejecutar DESPUÉS de validar el dryRun.
 */
function planificarYCrearMR26_C1M2() {
  Logger.log('▶ EJECUTANDO: planificarYCrear MR26 · C1M2');
  planificarYCrear({ cohortCode: 'MR26', momentCode: 'C1M2' });
}


// ─────────────────────────────────────────────────────────────
// FUNCIÓN 1 — PUNTO DE ENTRADA COMBINADO
// ─────────────────────────────────────────────────────────────

/**
 * Ejecuta planificarDesdeAperturaPlan() + crearAulas() en secuencia.
 * Punto de entrada recomendado para el flujo completo de apertura.
 *
 * EJEMPLOS:
 *   planificarYCrear({ cohortCode:'MR26', momentCode:'C1M2' })
 *   planificarYCrear({ cohortCode:'EN26', momentCode:'C2M1' })
 *   planificarYCrear({ cohortCode:'MR26', momentCode:'C1M2', dryRun:true })
 *
 * @param {Object}  opts
 * @param {string}  opts.cohortCode    — ventana que abre (OBLIGATORIO)
 * @param {string}  [opts.momentCode]  — filtro de momento (recomendado)
 * @param {boolean} [opts.dryRun]      — true: preview sin ejecutar (default: false)
 * @param {boolean} [opts.force]       — true: replanifica aunque ya exista
 * @param {number}  [opts.batchSize]   — aulas por batch de Classroom (default: 20)
 */
function planificarYCrear(opts) {
  var options = opts || {};
  var t0      = Date.now();

  Logger.log('════════════════════════════════════════════════');
  Logger.log('🏫 SIDEP — planificarYCrear v2.1');
  Logger.log('   cohort  : ' + (options.cohortCode || '⚠️  sin cohort'));
  Logger.log('   momento : ' + (options.momentCode || 'todos'));
  Logger.log('   dryRun  : ' + (options.dryRun === true ? 'SÍ — solo preview' : 'NO'));
  Logger.log('════════════════════════════════════════════════');

  planificarDesdeAperturaPlan(options);

  // Solo ejecutar crearAulas si no es dryRun
  if (options.dryRun !== true) {
    crearAulas(options);
  }

  var dur = ((Date.now() - t0) / 1000).toFixed(1);
  Logger.log('════════════════════════════════════════════════');
  Logger.log('✅ planificarYCrear completado en ' + dur + 's');
  Logger.log('⏭  VERIFICAR : diagnosticoAulas()');
  Logger.log('⏭  SIGUIENTE : estructurarAulas({ cohortCode: \'' +
             (options.cohortCode || 'XX26') + '\' }) en 05_estructurarAulas.gs');
  Logger.log('════════════════════════════════════════════════');
}


// ─────────────────────────────────────────────────────────────
// FUNCIÓN 2 — PLANIFICAR DESDE APERTURA_PLAN (FUNCIÓN PRINCIPAL v4)
// ─────────────────────────────────────────────────────────────

/**
 * Lee APERTURA_PLAN (Status=PENDIENTE) y genera filas en MasterDeployments.
 * NO llama Classroom API — solo escribe en Sheets.
 * Actualiza APERTURA_PLAN en batch: Status → CREADA, DeploymentID → depID.
 *
 * PATRÓN MEMORY-FIRST — 6 llamadas fijas a Sheets API:
 *   1. leer _CFG_SUBJECTS
 *   2. leer MasterDeployments (idempotencia)
 *   3. leer APERTURA_PLAN
 *   4. escribir MasterDeployments (batch)
 *   5. clearContent APERTURA_PLAN
 *   6. setValues APERTURA_PLAN (batch)
 *   Sin importar cuántas aperturas haya, siempre son 6 llamadas.
 *
 * LOCKING: force=true adquiere LockService para prevenir condición de
 *   carrera si dos usuarios ejecutan force simultáneamente.
 *
 * @param {Object}  opts
 * @param {string}  opts.cohortCode    — cohorte a procesar (OBLIGATORIO)
 * @param {string}  [opts.momentCode]  — filtrar por momento (default: todos)
 * @param {boolean} [opts.dryRun]      — true: preview sin escribir (default: false)
 * @param {boolean} [opts.force]       — true: replanifica aunque ya exista
 */
function planificarDesdeAperturaPlan(opts) {
  var options  = opts || {};
  var dryRun   = options.dryRun  === true;
  var force    = options.force   === true;
  var cohort   = options.cohortCode;
  var momento  = options.momentCode || null;
  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();

  Logger.log('\n📋 planificarDesdeAperturaPlan v2.1' + (dryRun ? ' [DRY RUN]' : ''));

  if (!cohort) {
    Logger.log('  🛑 cohortCode es OBLIGATORIO.');
    Logger.log('     Ejemplo: planificarDesdeAperturaPlan({ cohortCode:\'MR26\', momentCode:\'C1M2\' })');
    return;
  }

  // LockService: solo en force — previene condición de carrera al reescribir
  var lock = null;
  if (force) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) {
      throw new Error(
        '⚠️  Lock ocupado — otro usuario está ejecutando force. ' +
        'Espera 30s e intenta de nuevo.'
      );
    }
    Logger.log('  🔐 Lock adquirido');
  }

  try {
    var coreSS   = getSpreadsheetByName('core');
    var modalidad = (cohort === 'FB26') ? 'ART' : 'DIR';

    // ── PASO 1: Leer catálogos en memoria — una llamada por tabla ────────────
    var subjects   = leerSubjectsMap_(coreSS);    // { SubjectCode → objeto }
    var existentes = leerNomenclaturas_(coreSS);  // { GeneratedNomenclature → true }

    var hojaApr = coreSS.getSheetByName('APERTURA_PLAN');
    if (!hojaApr) {
      throw new Error(
        'Tabla APERTURA_PLAN no encontrada en SIDEP_01_CORE_ACADEMICO. ' +
        'Ejecutar setupSidepTables() con 00_SIDEP_CONFIG.gs v4.0.0+ primero.'
      );
    }

    var hojaDep = coreSS.getSheetByName('MasterDeployments');
    if (!hojaDep) throw new Error('MasterDeployments no encontrada.');

    // FIX-AUDIT C-4: validar que COL_APR/COL_DEP coincidan con los headers reales
    // antes de leer o escribir datos. Aborta con mensaje claro si hay desincronización.
    validarColumnas_(hojaApr, hojaDep);


    var lastApr  = hojaApr.getLastRow();
    var filasApr = lastApr > 1
      ? hojaApr.getRange(2, 1, lastApr - 1, hojaApr.getLastColumn()).getValues()
      : [];

    if (filasApr.length === 0) {
      Logger.log('  ⚠️  APERTURA_PLAN vacía para ' + cohort + '.');
      Logger.log('     Ejecutar poblarAperturas({ cohortCode: \'' + cohort + '\' }) primero.');
      return;
    }

    // ── PASO 3: Procesar en memoria — sin llamadas a la API ──────────────────
    // Copia profunda de filasApr para modificar Status en memoria
    // sin tocar Sheets hasta que todo esté validado.
    var filasAprMod = filasApr.map(function(r) { return r.slice(); });
    var nuevasMD    = []; // filas para MasterDeployments
    var omitidas    = 0;
    var sinMateria  = [];
    var trvVistos   = {}; // { subjectCode → true } — evita aulas TRV duplicadas

    filasAprMod.forEach(function(row, idx) {
      // Filtrar por status, cohorte y momento
      var status = row[COL_APR.AperturaStatus];
      if (status === 'CANCELADA') return; // nunca procesar canceladas
      if (status !== 'PENDIENTE' && !force) return;
      if (row[COL_APR.CohortCode] !== cohort) return;
      if (momento && row[COL_APR.MomentCode] !== momento) return;

      var subjectCode = row[COL_APR.SubjectCode];
      var progCode    = row[COL_APR.ProgramCode];
      var isTRV       = row[COL_APR.IsTransversal] === true;
      var momentCode  = row[COL_APR.MomentCode];

      // Validar en catálogo
      var subj = subjects[subjectCode];
      if (!subj) {
        sinMateria.push(subjectCode + ' (' + progCode + ')');
        Logger.log('  ⚠️  SubjectCode no en _CFG_SUBJECTS: ' + subjectCode);
        return;
      }

      if (!subj.IsActive) {
        Logger.log('  ⏭  Inactiva: ' + subjectCode);
        return;
      }

      // Una sola aula TRV por código en este batch
      var progFinal = isTRV ? 'TRV' : progCode;
      if (isTRV) {
        if (trvVistos[subjectCode]) return;
        trvVistos[subjectCode] = true;
      }

      var nomenc = generarNomenclatura_(progFinal, modalidad, cohort, momentCode, subjectCode, '001');

      if (!force && existentes[nomenc]) {
        omitidas++;
        Logger.log('  ⏭  Ya existe: ' + nomenc);
        return;
      }

      // Generar depID aquí para vincularlo con APERTURA_PLAN en memoria
      var depID = uuid('dep');

      nuevasMD.push(buildFila_(
        progFinal, modalidad, cohort, momentCode, subjectCode,
        subj, nomenc, depID, ahora, ejecutor
      ));

      // Actualizar fila de APERTURA_PLAN EN MEMORIA — se escribe en batch al final
      filasAprMod[idx][COL_APR.AperturaStatus] = 'CREADA';
      filasAprMod[idx][COL_APR.DeploymentID]   = depID;
      filasAprMod[idx][COL_APR.UpdatedAt]       = ahora;
      filasAprMod[idx][COL_APR.UpdatedBy]       = ejecutor;
    });

    // Mostrar plan antes de escribir cualquier cosa
    Logger.log('\n  📋 Aulas a planificar (' + nuevasMD.length + '):');
    nuevasMD.forEach(function(f) {
      Logger.log('     ' + (dryRun ? '[DRY] ' : '+ ') +
                 f[COL_DEP.GeneratedNomenclature] + '  →  ' + f[COL_DEP.GeneratedClassroomName]);
    });
    if (omitidas > 0)      Logger.log('  ⏭  Omitidas (ya existen): ' + omitidas);
    if (sinMateria.length) Logger.log('  ⚠️  Sin catálogo: ' + sinMateria.join(', '));

    if (nuevasMD.length === 0) {
      Logger.log('\n  ℹ️  Nada nuevo que planificar.');
      if (omitidas > 0) Logger.log('     Usa force:true para replanificar las existentes.');
      return;
    }

    if (dryRun) {
      Logger.log('\n  [DRY RUN] — Nada escrito. Quitar dryRun:true para ejecutar.');
      return;
    }

    // ── PASO 4: Escribir MasterDeployments en batch — 1 llamada ──────────────
    var hojaDep = coreSS.getSheetByName('MasterDeployments');
    hojaDep.getRange(hojaDep.getLastRow() + 1, 1, nuevasMD.length, nuevasMD[0].length)
           .setValues(nuevasMD);
    Logger.log('\n  ✅ ' + nuevasMD.length + ' filas PENDING escritas en MasterDeployments');

    // ── PASO 5: Actualizar APERTURA_PLAN en batch — 2 llamadas ───────────────
    // clearContent preserva formatos (checkboxes, fechas aplicados por aplicarFormatosHoja_).
    // NO usar deleteRows — destruiría los formatos. NO actualizar fila por fila — N llamadas.
    hojaApr.getRange(2, 1, lastApr - 1, hojaApr.getLastColumn()).clearContent();
    hojaApr.getRange(2, 1, filasAprMod.length, filasAprMod[0].length)
           .setValues(filasAprMod);
    Logger.log('  ✅ APERTURA_PLAN actualizada en batch: PENDIENTE → CREADA');

  } catch (e) {
    Logger.log('  ❌ ERROR en planificarDesdeAperturaPlan: ' + e.message);
    throw e;
  } finally {
    if (lock) {
      lock.releaseLock();
      Logger.log('  🔓 Lock liberado');
    }
  }
}


// ─────────────────────────────────────────────────────────────
// FUNCIÓN 3 — CREAR AULAS EN CLASSROOM
// ─────────────────────────────────────────────────────────────

/**
 * Lee filas PENDING de MasterDeployments y crea los cursos en Classroom.
 * Llamada automáticamente por planificarYCrear(). También ejecutable sola
 * para reintentar ERRORs o procesar el siguiente batch.
 *
 * EXCEPCIÓN AL PATRÓN MEMORY-FIRST (documentada):
 *   La escritura de ClassroomID/ClassroomURL/Status es INDIVIDUAL por fila,
 *   no en batch. Justificación: el ClassroomID solo existe DESPUÉS de la
 *   respuesta de Classroom.Courses.create(). Si acumuláramos todos los IDs
 *   y escribiéramos al final, un timeout de GAS a mitad del batch dejaría
 *   filas marcadas PENDING aunque el curso ya existe en Classroom, causando
 *   duplicados en la siguiente ejecución. El trade-off (N writes individuales)
 *   está justificado por esta razón específica.
 *   El sleep(250ms) entre llamadas absorbe el costo y evita throttling.
 *
 * LOCKING: adquiere LockService — previene que dos ejecuciones concurrentes
 *   lean el mismo PENDING y creen el mismo aula dos veces en Classroom.
 *
 * @param {Object}  opts
 * @param {string}  [opts.cohortCode]  — filtrar PENDING por cohorte
 * @param {string}  [opts.momentCode]  — filtrar PENDING por momento
 * @param {string}  [opts.programCode] — filtrar PENDING por programa
 * @param {boolean} [opts.dryRun]      — true: preview sin llamar API (default: false)
 * @param {number}  [opts.batchSize]   — aulas por ejecución (default: 20)
 */
function crearAulas(opts) {
  var options   = opts || {};
  var dryRun    = options.dryRun    === true;
  var batchSize = options.batchSize || 20;

  Logger.log('\n🏫 crearAulas v2.1' + (dryRun ? ' [DRY RUN]' : ''));

  if (typeof Classroom === 'undefined') {
    Logger.log('  ❌ CLASSROOM API NO HABILITADA');
    Logger.log('  → Editor GAS → ➕ Servicios → Google Classroom API v1 → Agregar');
    return;
  }

  // LockService: previene que dos ejecuciones concurrentes procesen el mismo PENDING
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    Logger.log('  ⚠️  Lock ocupado — otra ejecución de crearAulas está activa.');
    Logger.log('     Espera 30s e intenta de nuevo.');
    return;
  }
  Logger.log('  🔐 Lock adquirido');

  try {
    var coreSS  = getSpreadsheetByName('core');
    var hoja    = coreSS.getSheetByName('MasterDeployments');
    var lastRow = hoja.getLastRow();

    if (lastRow <= 1) {
      Logger.log('  ⚠️  MasterDeployments vacía. Ejecutar planificarDesdeAperturaPlan() primero.');
      return;
    }

    // Leer MasterDeployments completa en memoria — 1 llamada
    var allData = hoja.getRange(2, 1, lastRow - 1, 17).getValues();

    // Filtrar PENDING en memoria — sin llamadas a la API
    var pendientes = allData.reduce(function(acc, row, idx) {
      if (row[COL_DEP.ScriptStatusCode] !== 'PENDING') return acc;
      if (options.cohortCode  && row[COL_DEP.CohortCode]  !== options.cohortCode)  return acc;
      if (options.momentCode  && row[COL_DEP.MomentCode]  !== options.momentCode)  return acc;
      if (options.programCode && row[COL_DEP.ProgramCode] !== options.programCode) return acc;
      acc.push({ rowIndex: idx, data: row });
      return acc;
    }, []);

    if (pendientes.length === 0) {
      Logger.log('  ⏭  Sin filas PENDING con los filtros indicados.');
      Logger.log('     → Verificar con diagnosticoAulas().');
      return;
    }

    var lote    = pendientes.slice(0, batchSize);
    var creadas = 0;
    var errores = 0;

    Logger.log('  📊 PENDING totales : ' + pendientes.length);
    Logger.log('  📊 Este batch      : ' + lote.length +
      (pendientes.length > batchSize
        ? ' (faltan ' + (pendientes.length - batchSize) + ' para el siguiente batch)'
        : ''));

    lote.forEach(function(item) {
      var row      = item.data;
      var sheetRow = item.rowIndex + 2; // +2: fila 1 = encabezado, rowIndex = 0-base
      var nomenc   = row[COL_DEP.GeneratedNomenclature];

      if (dryRun) {
        Logger.log('  🔍 [DRY] ' + nomenc);
        return;
      }

      try {
        var course = Classroom.Courses.create({
          name:        row[COL_DEP.GeneratedClassroomName],
          section:     row[COL_DEP.MomentCode] + ' · ' + row[COL_DEP.CohortCode] + ' · 2026',
          room:        SIDEP_CONFIG.defaultCampus,
          ownerId:     'me',
          courseState: 'ACTIVE',
          description: 'SIDEP Ecosistema Digital | ' + nomenc
        });

        // Escritura individual — excepción documentada al patrón memory-first.
        // ClassroomID solo existe tras la respuesta de la API.
        // Si fallamos a mitad del batch y no escribimos inmediatamente,
        // la siguiente ejecución duplicaría cursos ya creados en Classroom.
        hoja.getRange(sheetRow, COL_DEP.ClassroomID      + 1).setValue(course.id);
        hoja.getRange(sheetRow, COL_DEP.ClassroomURL     + 1).setValue(course.alternateLink);
        hoja.getRange(sheetRow, COL_DEP.ScriptStatusCode + 1).setValue('CREATED');
        hoja.getRange(sheetRow, COL_DEP.Notes            + 1).setValue(
          'OK ' + Utilities.formatDate(nowSIDEP(), 'America/Bogota', 'yyyy-MM-dd HH:mm')
        );

        creadas++;
        Logger.log('  ✔  [' + creadas + '] ' + nomenc);
        Utilities.sleep(250); // pausa cortés — evita throttling de la API

      } catch (apiErr) {
        errores++;
        // Registrar el error sin detener el batch — las demás aulas continúan
        try {
          hoja.getRange(sheetRow, COL_DEP.ScriptStatusCode + 1).setValue('ERROR');
          hoja.getRange(sheetRow, COL_DEP.Notes + 1).setValue(
            apiErr.message.substring(0, 200)
          );
        } catch (writeErr) { /* no bloquear el batch por fallo secundario de escritura */ }
        Logger.log('  ❌ ' + nomenc + ' → ' + apiErr.message);
      }
    });

    Logger.log('\n  ── Resumen ──────────────────────────────');
    Logger.log('  ✅ Creadas : ' + creadas);
    Logger.log('  ❌ Errores : ' + errores);
    if (pendientes.length > batchSize) {
      Logger.log('  ⏭  Quedan ' + (pendientes.length - batchSize) +
                 ' — ejecutar crearAulas() de nuevo para el siguiente batch.');
    }
    if (errores > 0) {
      Logger.log('  ⚠️  Para reintentar: cambiar ScriptStatusCode a PENDING en Sheets.');
    }

  } catch (e) {
    Logger.log('  ❌ ERROR CRÍTICO en crearAulas: ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
    Logger.log('  🔓 Lock liberado');
  }
}


// ─────────────────────────────────────────────────────────────
// FUNCIÓN 4 — DIAGNÓSTICO
// ─────────────────────────────────────────────────────────────

/**
 * Muestra el estado actual de APERTURA_PLAN y MasterDeployments.
 * Solo lectura — no modifica nada. Usar entre pasos del pipeline para verificar.
 */
function diagnosticoAulas() {
  Logger.log('════════════════════════════════════════════════');
  Logger.log('🔍 SIDEP — Diagnóstico de Aulas v2.1');
  Logger.log('════════════════════════════════════════════════');

  try {
    var coreSS = getSpreadsheetByName('core');

    // ── Estado de APERTURA_PLAN ───────────────────────────────────────────────
    var hojaApr = coreSS.getSheetByName('APERTURA_PLAN');
    if (hojaApr && hojaApr.getLastRow() > 1) {
      var aprData   = hojaApr.getRange(2, 1, hojaApr.getLastRow() - 1,
                                       hojaApr.getLastColumn()).getValues();
      var cntPend   = 0; var cntCreada = 0; var cntCancel = 0;
      var aprCohort = {};

      aprData.forEach(function(r) {
        var s = r[COL_APR.AperturaStatus];
        if (s === 'PENDIENTE')  cntPend++;
        else if (s === 'CREADA')    cntCreada++;
        else if (s === 'CANCELADA') cntCancel++;
        var c = r[COL_APR.CohortCode];
        if (!aprCohort[c]) aprCohort[c] = { PENDIENTE: 0, CREADA: 0, CANCELADA: 0 };
        aprCohort[c][s] = (aprCohort[c][s] || 0) + 1;
      });

      Logger.log('\n📋 APERTURA_PLAN:');
      Logger.log('   Total     : ' + aprData.length);
      Logger.log('   PENDIENTE : ' + cntPend + ' (sin planificar)');
      Logger.log('   CREADA    : ' + cntCreada + ' (planificada → Classroom pendiente o CREATED)');
      Logger.log('   CANCELADA : ' + cntCancel);
      Logger.log('   Por cohorte:');
      Object.keys(aprCohort).sort().forEach(function(c) {
        var d = aprCohort[c];
        Logger.log('     ' + c + ': ' + d.CREADA + ' creadas | ' +
                   d.PENDIENTE + ' pendientes | ' + (d.CANCELADA || 0) + ' canceladas');
      });
    } else {
      Logger.log('\n⚠️  APERTURA_PLAN vacía — ejecutar poblarAperturas() primero.');
    }

    // ── Estado de MasterDeployments ───────────────────────────────────────────
    var hojaDep = coreSS.getSheetByName('MasterDeployments');
    var lastRow = hojaDep.getLastRow();

    if (lastRow <= 1) {
      Logger.log('\n⬜ MasterDeployments vacía → ejecutar planificarDesdeAperturaPlan() primero.');
      return;
    }

    var data      = hojaDep.getRange(2, 1, lastRow - 1, 17).getValues();
    var conteo    = {};
    var porProg   = {};
    var porMom    = {};
    var porCohort = {};
    var trvCount  = 0;

    data.forEach(function(row) {
      var status = row[COL_DEP.ScriptStatusCode];
      var prog   = row[COL_DEP.ProgramCode];
      var mom    = row[COL_DEP.MomentCode];
      var cohort = row[COL_DEP.CohortCode];
      conteo[status]    = (conteo[status]    || 0) + 1;
      porProg[prog]     = (porProg[prog]     || 0) + 1;
      porMom[mom]       = (porMom[mom]       || 0) + 1;
      porCohort[cohort] = (porCohort[cohort] || 0) + 1;
      if (prog === 'TRV') trvCount++;
    });

    Logger.log('\n📊 MASTER DEPLOYMENTS:');
    Logger.log('   Total filas  : ' + (lastRow - 1));
    Logger.log('   ✅ CREATED   : ' + (conteo.CREATED  || 0));
    Logger.log('   ⬜ PENDING   : ' + (conteo.PENDING  || 0));
    Logger.log('   ❌ ERROR     : ' + (conteo.ERROR    || 0));
    Logger.log('   📦 ARCHIVED : ' + (conteo.ARCHIVED || 0));
    Logger.log('   🔀 TRV      : ' + trvCount + ' aulas compartidas');

    Logger.log('\n📊 POR VENTANA (CohortCode):');
    Object.keys(porCohort).sort().forEach(function(c) {
      Logger.log('   ' + c + ': ' + porCohort[c]);
    });

    Logger.log('\n📊 POR PROGRAMA:');
    Object.keys(porProg).sort().forEach(function(p) {
      Logger.log('   ' + p + ': ' + porProg[p] + (p === 'TRV' ? ' ← compartidas' : ''));
    });

    Logger.log('\n📊 POR MOMENTO (orden cronológico):');
    Object.keys(porMom)
      .sort(function(a, b) { return (MOMENT_ORDER[a] || 99) - (MOMENT_ORDER[b] || 99); })
      .forEach(function(m) { Logger.log('   ' + m + ': ' + porMom[m]); });

    if ((conteo.ERROR || 0) > 0) {
      Logger.log('\n⚠️  ERRORES (primeras 10):');
      var n = 0;
      data.forEach(function(row) {
        if (row[COL_DEP.ScriptStatusCode] === 'ERROR' && n++ < 10) {
          Logger.log('   ❌ ' + row[COL_DEP.GeneratedNomenclature] +
                     ' → ' + String(row[COL_DEP.Notes]).substring(0, 80));
        }
      });
      Logger.log('   → Reintentar: cambiar ScriptStatusCode a PENDING y ejecutar crearAulas()');
    }

    Logger.log('\n════════════════════════════════════════════════');

  } catch (e) {
    Logger.log('❌ ERROR en diagnosticoAulas: ' + e.message);
  }
}


// ─────────────────────────────────────────────────────────────
// FUNCIÓN 5 — @deprecated (v1.x — conservada para 99_orquestador.gs)
// ─────────────────────────────────────────────────────────────

/**
 * @deprecated desde v2.0 — usar planificarDesdeAperturaPlan() en su lugar.
 *
 * Conservada para compatibilidad con 99_orquestador.gs (paso4_planificar,
 * paso4_planificarYCrear y similares) mientras se migra el orquestador.
 *
 * ADVERTENCIA: esta función NO lee ni actualiza APERTURA_PLAN.
 *   En un entorno v4.0.0 con APERTURA_PLAN activa, usarla dejará
 *   APERTURA_PLAN desincronizada (AperturaStatus permanecerá PENDIENTE
 *   aunque el aula ya exista en MasterDeployments).
 *   Migrar 99_orquestador.gs a planificarDesdeAperturaPlan() para poder
 *   eliminar esta función en v3.0.
 *
 * Lógica original v1.x: filtra _CFG_SUBJECTS.DirStartMoment === momentCode.
 * En v4.0, DirStartMoment es informativo — esta función lo sigue usando
 * pero con leerSubjectsMap_() (headers dinámicos) para compatibilidad.
 *
 * @param {Object}  options
 * @param {string}  options.cohortCode    — ventana que abre (OBLIGATORIO en producción)
 * @param {string}  [options.momentCode]  — momento a planificar
 * @param {boolean} [options.confirmarTodos] — true: todos los momentos sin filtro
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.force]
 * @param {string}  [options.programCode]
 */
function planificarDeployments(options) {
  var opts     = options || {};
  var dryRun   = opts.dryRun  === true;
  var force    = opts.force   === true;
  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();

  Logger.log('\n⚠️  ════════════════════════════════════════════════');
  Logger.log('⚠️  planificarDeployments() @DEPRECATED desde v2.0');
  Logger.log('⚠️  Usar: planificarDesdeAperturaPlan({ cohortCode, momentCode })');
  Logger.log('⚠️  Esta función NO actualiza APERTURA_PLAN (dejará filas PENDIENTE');
  Logger.log('⚠️  aunque el aula ya exista). Migrar 99_orquestador si es posible.');
  Logger.log('⚠️  ════════════════════════════════════════════════');

  if (!opts.momentCode && !opts.confirmarTodos) {
    Logger.log('  🛑 BLOQUEADO — falta momentCode.');
    Logger.log('     Recomendado: planificarDesdeAperturaPlan({ cohortCode:\'MR26\', momentCode:\'C1M2\' })');
    return;
  }

  try {
    var coreSS   = getSpreadsheetByName('core');
    var subjects = leerSubjectsMap_(coreSS);
    var existing = leerNomenclaturas_(coreSS);

    var cohorteWindow   = opts.cohortCode || 'EN26';
    var modalidad       = cohorteWindow === 'FB26' ? 'ART' : 'DIR';
    var momentosActivos = modalidad === 'DIR' ? MOMENTOS_DIR : MOMENTOS_ART;
    var momentosAProcesar = opts.momentCode ? [opts.momentCode] : momentosActivos;

    momentosAProcesar = momentosAProcesar.filter(function(m) {
      return momentosActivos.indexOf(m) !== -1;
    });

    if (momentosAProcesar.length === 0) {
      Logger.log('  ⚠️  Momento inválido para modalidad ' + modalidad);
      return;
    }

    var progsFiltro  = opts.programCode ? [opts.programCode] : PROGRAMAS_ESPECIFICOS;
    var nuevasFilas  = [];
    var omitidas     = 0;
    var subjectCodes = Object.keys(subjects);

    // BLOQUE A — Específicos por programa (lógica v1.x con DirStartMoment)
    progsFiltro.forEach(function(progCode) {
      momentosAProcesar.forEach(function(momentCode) {
        subjectCodes
          .filter(function(code) {
            var s = subjects[code];
            if (!s.IsActive || s.IsTransversal) return false;
            if (s.ProgramCode !== progCode)     return false;
            var start = modalidad === 'DIR' ? s.DirStartMoment : s.ArtStartBlock;
            return start === momentCode;
          })
          .forEach(function(subjectCode) {
            var nomenc = generarNomenclatura_(progCode, modalidad, cohorteWindow, momentCode, subjectCode, '001');
            if (!force && existing[nomenc]) { omitidas++; return; }
            nuevasFilas.push(buildFila_(
              progCode, modalidad, cohorteWindow, momentCode, subjectCode,
              subjects[subjectCode], nomenc, uuid('dep'), ahora, ejecutor
            ));
          });
      });
    });

    // BLOQUE B — Transversales
    if (!opts.programCode) {
      momentosAProcesar.forEach(function(momentCode) {
        subjectCodes
          .filter(function(code) {
            var s = subjects[code];
            if (!s.IsActive || !s.IsTransversal) return false;
            var start = modalidad === 'DIR' ? s.DirStartMoment : s.ArtStartBlock;
            return start === momentCode;
          })
          .forEach(function(subjectCode) {
            var nomenc = generarNomenclatura_('TRV', modalidad, cohorteWindow, momentCode, subjectCode, '001');
            if (!force && existing[nomenc]) { omitidas++; return; }
            nuevasFilas.push(buildFila_(
              'TRV', modalidad, cohorteWindow, momentCode, subjectCode,
              subjects[subjectCode], nomenc, uuid('dep'), ahora, ejecutor
            ));
          });
      });
    }

    if (!dryRun && nuevasFilas.length > 0) {
      var hoja = coreSS.getSheetByName('MasterDeployments');
      hoja.getRange(hoja.getLastRow() + 1, 1, nuevasFilas.length, nuevasFilas[0].length)
          .setValues(nuevasFilas);
    }

    Logger.log('  ✅ Nuevas PENDING : ' + nuevasFilas.length);
    Logger.log('  ⏭  Omitidas      : ' + omitidas);
    nuevasFilas.slice(0, dryRun ? 999 : 12).forEach(function(f) {
      Logger.log('     ' + f[COL_DEP.GeneratedNomenclature]);
    });

  } catch (e) {
    Logger.log('  ❌ ERROR en planificarDeployments: ' + e.message);
    throw e;
  }
}


// ─────────────────────────────────────────────────────────────
// HELPERS PRIVADOS — sufijo _ indica uso exclusivo de este archivo
// ─────────────────────────────────────────────────────────────

/**
 * Lee _CFG_SUBJECTS en batch y retorna { SubjectCode → objeto }.
 * Una sola llamada a la API — nunca itera fila por fila.
 *
 * DETECCIÓN POR HEADERS (no índices fijos):
 *   Busca cada columna por nombre de header en fila 1. Inmune a cambios
 *   de schema entre v3.6.1 (17 cols) y v4.0.0 (19 cols con CicloDir/CicloArt).
 *   Si el header no existe, el índice queda -1 y el campo queda vacío ('').
 *   Los campos opcionales (DirStartMoment...) son informativos en v4.0
 *   — solo los usa planificarDeployments() @deprecated.
 *
 * @param  {Spreadsheet} coreSS — SIDEP_01_CORE_ACADEMICO
 * @returns {Object} { SubjectCode → { SubjectCode, SubjectName, ProgramCode,
 *                     DirStartMoment, ArtStartBlock, IsTransversal, IsActive } }
 */
function leerSubjectsMap_(coreSS) {
  var hoja = coreSS.getSheetByName('_CFG_SUBJECTS');
  if (!hoja || hoja.getLastRow() <= 1) {
    throw new Error('_CFG_SUBJECTS vacía. Ejecutar poblarConfiguraciones() primero.');
  }

  var headers = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  var data    = hoja.getRange(2, 1, hoja.getLastRow() - 1, hoja.getLastColumn()).getValues();
  var map     = {};

  var iCode = headers.indexOf('SubjectCode');
  var iName = headers.indexOf('SubjectName');
  var iProg = headers.indexOf('ProgramCode');
  var iDirS = headers.indexOf('DirStartMoment'); // informativo en v4.0
  var iArtS = headers.indexOf('ArtStartBlock');  // informativo en v4.0
  var iTRV  = headers.indexOf('IsTransversal');
  var iAct  = headers.indexOf('IsActive');

  if (iCode === -1 || iName === -1 || iTRV === -1 || iAct === -1) {
    throw new Error(
      '_CFG_SUBJECTS no tiene las columnas requeridas (SubjectCode / SubjectName / ' +
      'IsTransversal / IsActive). Verificar schema en 00_SIDEP_CONFIG.gs ' +
      'y re-ejecutar setupSidepTables().'
    );
  }

  data.forEach(function(row) {
    if (!row[iCode]) return; // saltar filas vacías
    map[row[iCode]] = {
      SubjectCode:    row[iCode],
      SubjectName:    row[iName],
      ProgramCode:    row[iProg],
      DirStartMoment: iDirS !== -1 ? row[iDirS] : '',
      ArtStartBlock:  iArtS !== -1 ? row[iArtS] : '',
      IsTransversal:  row[iTRV],
      IsActive:       row[iAct]
    };
  });
  return map;
}

/**
 * Lee MasterDeployments y retorna { GeneratedNomenclature → true } para O(1).
 * Una sola llamada a la API. Retorna {} en primera ejecución (tabla vacía).
 * Usada por planificarDesdeAperturaPlan() y planificarDeployments() para
 * verificar si una nomenclatura ya existe antes de crearla.
 *
 * @param  {Spreadsheet} coreSS
 * @returns {Object} { GeneratedNomenclature → true }
 */
function leerNomenclaturas_(coreSS) {
  var hoja = coreSS.getSheetByName('MasterDeployments');
  if (!hoja || hoja.getLastRow() <= 1) return {};
  // Solo necesitamos hasta la columna 9 (GeneratedNomenclature en índice 8)
  var data = hoja.getRange(2, 1, hoja.getLastRow() - 1, 9).getValues();
  var map  = {};
  data.forEach(function(row) { if (row[8]) map[row[8]] = true; });
  return map;
}

/**
 * Genera la nomenclatura canónica de un deployment.
 * Esta cadena es la CLAVE DE IDEMPOTENCIA del sistema — identifica
 * unívocamente un aula en todo SIDEP.
 *
 * Formato  : {PROG}-{MODAL}-{COHORT}-{MOMENT}-{SUBJ}-{GROUP}
 * Ejemplo  : CTB-DIR-MR26-C1M2-SPC-001
 *
 * @param {string} prog    — ProgramCode
 * @param {string} modal   — ModalityCode (DIR | ART)
 * @param {string} cohort  — CohortCode de la ventana
 * @param {string} moment  — MomentCode
 * @param {string} subject — SubjectCode
 * @param {string} group   — GroupCode (001)
 * @returns {string}
 */
function generarNomenclatura_(prog, modal, cohort, moment, subject, group) {
  return [prog, modal, cohort, moment, subject, group].join('-');
}

/**
 * Genera el nombre visible del aula en Google Classroom.
 * SubjectName truncado a 50 chars para respetar el límite UI (~80 chars total).
 *
 * Formato  : [PROG] SubjectName | MOMENT · COHORT
 * Ejemplo  : [CTB] Soportes Contables | C1M2 · MR26
 *
 * @param {string} prog        — ProgramCode
 * @param {string} subjectName — nombre completo de la materia
 * @param {string} moment      — MomentCode
 * @param {string} cohort      — CohortCode
 * @returns {string}
 */
function generarNombreAula_(prog, subjectName, moment, cohort) {
  var nombre = subjectName.length > 50 ? subjectName.substring(0, 47) + '…' : subjectName;
  return '[' + prog + '] ' + nombre + ' | ' + moment + ' · ' + cohort;
}

/**
 * Construye la fila completa para MasterDeployments.
 * Centraliza el schema — garantiza coherencia entre todos los flujos de
 * creación (planificarDesdeAperturaPlan, planificarDeployments @deprecated).
 *
 * ClassroomID y ClassroomURL quedan vacíos hasta que crearAulas() los llene.
 * ScriptStatusCode = PENDING — crearAulas() lo cambia a CREATED o ERROR.
 *
 * depID se recibe como parámetro (no se genera aquí) para que el llamador
 * pueda escribir el mismo ID en APERTURA_PLAN.DeploymentID antes de
 * llamar a Sheets — garantiza trazabilidad entre las dos tablas.
 *
 * @param {string}   prog        — ProgramCode
 * @param {string}   modal       — ModalityCode
 * @param {string}   cohort      — CohortCode
 * @param {string}   moment      — MomentCode
 * @param {string}   subjectCode — SubjectCode
 * @param {Object}   subj        — objeto de leerSubjectsMap_()
 * @param {string}   nomenc      — GeneratedNomenclature
 * @param {string}   depID       — DeploymentID generado por el llamador
 * @param {Date}     ahora       — nowSIDEP()
 * @param {string}   ejecutor    — email del ejecutor
 * @returns {Array}  fila lista para setValues()
 */
function buildFila_(prog, modal, cohort, moment, subjectCode, subj, nomenc, depID, ahora, ejecutor) {
  return [
    depID,                                           // DeploymentID — generado por el llamador
    prog,
    modal,
    cohort,
    moment,
    subjectCode,
    '001',
    subj.SubjectName,
    nomenc,
    generarNombreAula_(prog, subj.SubjectName, moment, cohort),
    '',          // ClassroomID  — vacío hasta crearAulas()
    '',          // ClassroomURL — vacío hasta crearAulas()
    'PENDING',   // ScriptStatusCode — crearAulas() marca CREATED o ERROR
    SIDEP_CONFIG.defaultCampus,
    ahora,
    ejecutor,
    ''           // Notes — crearAulas() escribe "OK yyyy-MM-dd HH:mm" o error
  ];
}