/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 12b_poblarAperturas.gs
 * Versión: 1.1
 * ============================================================
 *
 * PROPÓSITO:
 *   Registrar en APERTURA_PLAN las decisiones de Carlos sobre qué
 *   asignaturas abrir en cada cohorte y momento académico.
 *   SIN lógica de Classroom — solo escribe en Google Sheets.
 *
 * RESPONSABILIDAD ÚNICA:
 *   Este script ES el punto de contacto entre la decisión humana
 *   (Carlos confirma qué abre) y el sistema automatizado
 *   (04_crearAulas_v2.gs ejecuta lo que APERTURA_PLAN indica).
 *   Sin este paso, 04_crearAulas_v2 no tiene nada que crear.
 *
 * CUÁNDO EJECUTAR:
 *   Al inicio de cada período, DESPUÉS de que Carlos confirme
 *   cuáles asignaturas se dictan ese momento y ANTES de ejecutar
 *   04_crearAulas_v2.gs.
 *
 * FLUJO COMPLETO POR PERÍODO (en orden):
 *   1. Carlos confirma lista (WhatsApp, reunión de planeación)
 *   2. Stevens actualiza obtenerPlanDeAperturas_() en este archivo
 *   3. Ejecutar: poblarAperturas({ cohortCode: 'XX26' })
 *   4. Verificar en Sheets → APERTURA_PLAN debe mostrar filas PENDIENTE
 *   5. Ejecutar: 04_crearAulas_v2.gs → planificarDesdeAperturaPlan() / planificarYCrear()
 *   6. Carlos ve las aulas en Classroom ✅
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs v4.0.0+ → APERTURA_PLAN en CORE_TABLES,
 *                                  getSpreadsheetByName(), nowSIDEP(),
 *                                  escribirDatos()
 *   11_setupSidepTables.gs     → tabla APERTURA_PLAN debe existir.
 *                                  Si no existe: setupSidepTables() primero.
 *
 * NO DEPENDE DE:
 *   Classroom API — este script no la usa en absoluto.
 *   _CFG_SUBJECTS — no valida si los SubjectCodes existen.
 *     La validación ocurre en 04_crearAulas_v2 → leerSubjectsMap_().
 *     Razón: separación de responsabilidades. Este script es rápido
 *     y ligero; la validación pesada le corresponde al creador de aulas.
 *
 * IMPORTANTE — MODELO FLEXIBLE (v4.0.0):
 *   Las asignaturas registradas aquí NO tienen que coincidir con
 *   DirStartMoment de la malla oficial. Eso es intencional.
 *   Si Carlos decide abrir FUC en C2M1 (fuera de la secuencia usual),
 *   simplemente se registra aquí y el sistema lo ejecuta sin restricciones.
 *   La malla oficial es referencia informativa, no un filtro de control.
 *   Ver documentación de APERTURA_PLAN en 00_SIDEP_CONFIG.gs.
 *
 * COHORTES ACTIVOS (mar 2026):
 *   EN26 — DIR — en C1M2, avanzando a C2M1 (confirmar con Carlos)
 *   MR26 — DIR — ABRIENDO C1M2 el lunes 17 mar 2026 ← PRIORIDAD ACTUAL
 *   FB26 — ART — fechas pendientes de confirmación por Carlos
 *
 * MATERIAS TRANSVERSALES (IsTransversal = true en _CFG_SUBJECTS):
 *   APU, ING, MAT, HIA, PVE — UNA sola aula compartida por todos los
 *   programas del mismo cohorte/momento. ProgramCode = 'TRV'.
 *   04_crearAulas_v2 detecta IsTransversal y crea solo UNA aula TRV,
 *   aunque el código aparezca en múltiples entradas de programas.
 *   Registrar con programCode='TRV' e isTransversal=true en el plan.
 *
 * CUOTAS Y TIEMPOS:
 *   Este script solo usa Sheets API (sin Classroom).
 *   Tiempo estimado de ejecución: 2–5 segundos para 10–20 aperturas.
 *   Máx. aperturas por período: sin límite práctico en Fase 1 (~20).
 *   El patrón memory-first garantiza UNA sola llamada de lectura y
 *   UNA sola llamada de escritura a Sheets API, independiente del
 *   número de filas procesadas.
 *
 * PATRÓN MEMORY-FIRST (aplicado en todo el script):
 *   NUNCA modificar Sheets fila por fila en un loop.
 *   SIEMPRE: leer todo en memoria → procesar en JS → escribir en batch.
 *   Razón: cada llamada a la API de Sheets consume cuota de ejecución.
 *   El script anterior (v1.0) usaba deleteRow() en un loop — eso eran
 *   N llamadas a la API para N filas. La v1.1 reemplaza eso con:
 *     1. leer todas las filas en un array
 *     2. filtrar en memoria (JS puro, sin API)
 *     3. clearContent() una sola vez
 *     4. setValues() una sola vez
 *
 * LOCKING (LockService):
 *   El modo FORCE adquiere LockService para prevenir condición de carrera
 *   si dos usuarios ejecutan simultáneamente en modo force.
 *   Escenario problemático sin lock: usuario A lee 8 filas, usuario B lee
 *   8 filas, A limpia y escribe, B limpia y escribe → datos de A perdidos.
 *   Con lock: B espera a que A termine antes de ejecutar.
 *   Modo SAFE (default): no requiere lock — solo hace appends.
 *
 * VERSIÓN: 1.2
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-14
 *
 * CAMBIOS v1.2 vs v1.1:
 *   - NUEVO: gestionarApertura(opts) — función pública para modificar
 *     APERTURA_PLAN con trazabilidad completa. Resuelve el gap de auditoría:
 *     hasta v1.1, los cambios post-carga (cancelaciones, reemplazos, adiciones
 *     fuera de malla) se hacían editando Sheets directamente sin registrar
 *     quién hizo el cambio ni cuándo.
 *   - NUEVO: acciones CANCELAR, AGREGAR y REEMPLAZAR (CANCELAR + AGREGAR
 *     atómico). Toda modificación pasa por gestionarApertura() y escribe
 *     UpdatedAt + UpdatedBy en la fila afectada.
 *   - NUEVO: notes obligatorio en CANCELAR y REEMPLAZAR — fuerza documentar
 *     la razón de cualquier desviación de la malla oficial.
 *   - NUEVO: LockService en gestionarApertura() — siempre, no solo en force.
 *     Cualquier modificación puede tener condición de carrera.
 *   - NUEVO: atajos de conveniencia cancelar_(), agregar_(), reemplazar_()
 *     para llamadas rápidas sin escribir el objeto completo.
 *   - NUEVO: helper buscarFila_() — busca una fila por clave compuesta
 *     {cohort+moment+subject+program} en memoria (sin API).
 *   - Documentación al nivel de v3.6.1/v4.0.0 del proyecto.
 *
 * CAMBIOS v1.1 vs v1.0:
 *   - CRÍTICO FIX: limpiarAperturasPorCohorte_() reemplazado por
 *     reconstruirHojaEnMemoria_(). v1.0 usaba deleteRow() en un loop
 *     (N llamadas a la API). v1.1 usa clearContent + setValues (2 llamadas).
 *   - NUEVO: LockService en modo force — previene condición de carrera.
 *   - FIX idempotencia: clave ahora valida que los 4 componentes sean
 *     no-vacíos. v1.0 tenía `clave !== "___"` que solo cubría el caso
 *     de 4 vacíos simultáneos — dejaba pasar filas con 1–3 vacíos.
 *   - NUEVO: Logger registra usuario ejecutor al inicio (trazabilidad).
 *   - NUEVO: try/catch en obtenerPlanDeAperturas_() — si hay un error
 *     de sintaxis en la configuración, el mensaje es legible.
 *   - MEJORADO: modo force sin cohortCode muestra advertencia explícita
 *     antes de proceder (borra TODA la tabla).
 *   - MEJORADO: Logger detalla filas_conservadas + filas_nuevas en force.
 *   - Documentación al nivel de v3.6.1/v4.0.0 del proyecto.
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * Registra en APERTURA_PLAN las decisiones de Carlos sobre qué aulas abrir.
 * Lee obtenerPlanDeAperturas_() como fuente de verdad y escribe en Sheets.
 *
 * MODOS DE EJECUCIÓN:
 *   SAFE  (default) → agrega filas nuevas, nunca duplica, preserva historial.
 *                     Seguro de re-ejecutar en cualquier momento.
 *   FORCE           → limpia las filas del cohorte indicado y reescribe desde cero.
 *                     Adquiere LockService para prevenir condición de carrera.
 *                     Usar solo al corregir un período ya registrado.
 *
 * USO DIRECTO:
 *   poblarAperturas({ cohortCode: 'MR26' })          — SAFE para MR26
 *   poblarAperturas({ cohortCode: 'EN26' })          — SAFE para EN26
 *   poblarAperturas({ cohortCode: 'MR26', force: true }) — FORCE para MR26
 *   poblarAperturas({ force: true })                 — FORCE para TODOS ⚠️
 *   poblarAperturas()                                — SAFE para todos (agrega)
 *
 * VÍA ORQUESTADOR (recomendado):
 *   paso2b_aperturas('MR26')       → SAFE via 99_orquestador.gs
 *   paso2b_aperturas_force('MR26') → FORCE via 99_orquestador.gs
 *
 * @param {Object}  options
 * @param {string}  [options.cohortCode] — filtrar por cohorte (omitir = todos)
 * @param {boolean} [options.force]      — true: limpia y reescribe. Default: false
 */
function poblarAperturas(options) {
  var opts = options || { cohortCode: 'MR26' };
  var force = opts.force === true;
  var filtro = opts.cohortCode || null;
  var inicio = Date.now();
  var ejecutor = Session.getEffectiveUser().getEmail();

  // LockService: previene condición de carrera en ejecuciones force concurrentes.
  // Modo SAFE no requiere lock — solo hace appends que no interfieren entre sí.
  var lock = null;
  if (force) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) {
      throw new Error(
        "⚠️  Lock ocupado — otro usuario está ejecutando force en este momento. " +
        "Espera 30s e intenta de nuevo."
      );
    }
    Logger.log("🔐 Lock adquirido");
  }

  try {
    Logger.log("════════════════════════════════════════════════");
    Logger.log("📋 SIDEP — poblarAperturas v1.1");
    Logger.log("   Ejecutor : " + ejecutor);
    Logger.log("   Cohorte  : " + (filtro || "todos"));
    Logger.log("   Modo     : " + (force ? "FORCE ⚠️  (limpia y reescribe)" : "SAFE (agrega sin duplicar)"));
    Logger.log("════════════════════════════════════════════════");

    // Advertencia explícita para force sin filtro
    if (force && !filtro) {
      Logger.log("  ⚠️  FORCE sin cohortCode — se borrarán TODAS las filas de APERTURA_PLAN.");
      Logger.log("  ⚠️  Esto afecta todos los cohortes registrados.");
    }

    var coreSS = getSpreadsheetByName("core");
    var hoja = coreSS.getSheetByName("APERTURA_PLAN");

    if (!hoja) {
      throw new Error(
        "Tabla APERTURA_PLAN no encontrada en SIDEP_01_CORE_ACADEMICO. " +
        "Ejecutar setupSidepTables() con 00_SIDEP_CONFIG.gs v4.0.0+ primero."
      );
    }

    // ── PASO 1: Leer datos existentes en memoria (UNA llamada a Sheets) ──────
    // Pattern memory-first: leer todo en array, procesar en JS, escribir en batch.
    // Nunca leer fila por fila en un loop.
    var filasExistentes = leerTodasLasFilas_(hoja);

    // ── PASO 2: Construir mapa de idempotencia en memoria (sin API) ───────────
    var existentes = construirMapaIdempotencia_(filasExistentes);

    // ── PASO 3: Obtener plan de aperturas y filtrar ───────────────────────────
    var plan;
    try {
      plan = obtenerPlanDeAperturas_();
    } catch (e) {
      throw new Error(
        "Error en obtenerPlanDeAperturas_(): " + e.message + "\n" +
        "Verificar sintaxis del plan de aperturas en este archivo."
      );
    }

    var aRegistrar = filtro
      ? plan.filter(function (a) { return a.cohortCode === filtro; })
      : plan;

    if (aRegistrar.length === 0) {
      // FIX-AUDIT C-3: diferenciar "cohorte no en plan" de "array plan vacío"
      var todosLosCodes = plan.map(function (a) { return a.cohortCode; });
      var cohorteEnPlan = filtro && todosLosCodes.indexOf(filtro) !== -1;
      Logger.log("⚠️  No hay aperturas para: " + (filtro || "todos"));
      if (filtro && !cohorteEnPlan) {
        Logger.log("   → El cohorte '" + filtro + "' NO está definido en obtenerPlanDeAperturas_().");
        Logger.log("   → Agregar el bloque del cohorte en este archivo antes de re-ejecutar.");
        Logger.log("   → Cohortes activos en el plan: [" + todosLosCodes.filter(function (c, i) {
          return todosLosCodes.indexOf(c) === i; // únicos
        }).join(", ") + "]");
      } else {
        Logger.log("   → Revisar obtenerPlanDeAperturas_() en este archivo.");
      }
      return;
    }

    // ── PASO 4: Construir filas nuevas en memoria (sin API) ───────────────────
    var ahora = nowSIDEP();
    var nuevasFilas = [];
    var omitidas = 0;
    var sinCodigo = [];

    aRegistrar.forEach(function (a) {
      // Validar campos obligatorios antes de intentar registrar
      if (!a.cohortCode || !a.momentCode || !a.subjectCode || !a.programCode) {
        sinCodigo.push(JSON.stringify(a));
        return;
      }

      // Clave de idempotencia: 4 componentes, todos no-vacíos.
      // FIX v1.1: v1.0 usaba `clave !== "___"` que solo detectaba 4 vacíos
      // simultáneos. Esta versión valida todos los campos individualmente.
      var clave = a.cohortCode + "_" + a.momentCode + "_" + a.subjectCode + "_" + a.programCode;

      if (!force && existentes[clave]) {
        omitidas++;
        return;
      }

      nuevasFilas.push([
        "apr_" + Utilities.getUuid().replace(/-/g, "").substring(0, 12),
        a.cohortCode,
        a.momentCode,
        a.subjectCode,
        a.programCode,
        a.isTransversal === true,   // BOOLEAN explícito — no confiar en truthiness de JS
        "PENDIENTE",                // AperturaStatus — 04_crearAulas_v2 lo actualiza a CREADA
        "",                         // DeploymentID — vacío hasta que crearAulas() procese
        ejecutor,                   // PlannedBy — trazabilidad de quién registró
        ahora,                      // PlannedAt
        a.notes || "",              // Notes — razón de excepción si aplica
        ahora,                      // CreatedAt
        ejecutor,                   // CreatedBy
        "",                         // UpdatedAt — vacío hasta primera actualización
        ""                          // UpdatedBy
      ]);
    });

    // Informar materias con datos incompletos antes de escribir
    if (sinCodigo.length > 0) {
      Logger.log("  ⚠️  " + sinCodigo.length + " entradas con campos vacíos — omitidas:");
      sinCodigo.forEach(function (s) { Logger.log("     " + s); });
    }

    if (nuevasFilas.length === 0 && !force) {
      Logger.log("  ⏭  Todas las aperturas ya estaban registradas (modo SAFE).");
      Logger.log("     Usa force:true para reescribir el cohorte.");
      return;
    }

    // ── PASO 5: Reconstruir la hoja en memoria y escribir en batch ───────────
    // FIX v1.1: v1.0 usaba deleteRow() en un loop = N llamadas a la API.
    // v1.1: todo se resuelve en memoria; la escritura a Sheets es UNA operación.
    //
    // Lógica de reconstrucción:
    //   SAFE:  filasExistentes + nuevasFilas → escribir todo de vuelta
    //   FORCE con filtro: filtrar_en_JS(filasExistentes, cohort) + nuevasFilas
    //   FORCE sin filtro: solo nuevasFilas (borra todo el historial previo)
    var filasAConservar;
    if (!force) {
      // SAFE: conservar todo lo existente, solo agregar nuevas
      filasAConservar = filasExistentes;
    } else if (filtro) {
      // FORCE con cohorte: conservar los OTROS cohortes, reemplazar el indicado
      filasAConservar = filasExistentes.filter(function (row) {
        return row[1] !== filtro; // columna 1 = CohortCode
      });
      Logger.log("  📊 Filas conservadas (otros cohortes): " + filasAConservar.length);
    } else {
      // FORCE sin filtro: borrar todo
      filasAConservar = [];
      Logger.log("  📊 Borrando todas las filas previas (force sin filtro)");
    }

    var filasFinales = filasAConservar.concat(nuevasFilas);

    // Escribir en batch: clearContent + setValues = 2 llamadas a la API
    escribirHojaCompleta_(hoja, filasFinales);

    // ── PASO 6: Resumen ───────────────────────────────────────────────────────
    var dur = ((Date.now() - inicio) / 1000).toFixed(1);
    Logger.log("════════════════════════════════════════════════");
    Logger.log("✅ poblarAperturas completado en " + dur + "s");
    Logger.log("   Registradas nuevas  : " + nuevasFilas.length);
    Logger.log("   Omitidas (ya exist) : " + omitidas);
    Logger.log("   Con errores         : " + sinCodigo.length);
    Logger.log("   Total en tabla      : " + filasFinales.length);
    Logger.log("⏭  SIGUIENTE: planificarDesdeAperturaPlan({ cohortCode: '" +
      (filtro || "XX26") + "', momentCode: '...' }) en 04_crearAulas_v2.gs");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("❌ ERROR en poblarAperturas: " + e.message);
    throw e;
  } finally {
    // Siempre liberar el lock, incluso si hubo error
    if (lock) {
      lock.releaseLock();
      Logger.log("🔓 Lock liberado");
    }
  }
}


// ─────────────────────────────────────────────────────────────
// ★ FUENTE DE VERDAD — PLAN DE APERTURAS
// ─────────────────────────────────────────────────────────────
//
// INSTRUCCIÓN DE USO:
//   Actualizar este array al inicio de cada período, basándose en lo
//   que Carlos confirme. Re-ejecutar poblarAperturas() después.
//   NO editar APERTURA_PLAN directamente en Sheets — se sobreescribirá
//   en la siguiente ejecución con force:true.
//
// ESTRUCTURA DE CADA OBJETO:
//   cohortCode:    'MR26'   — cohorte que ABRE el aula (ventana)
//   momentCode:    'C1M2'   — momento académico
//   subjectCode:   'SPC'    — código de asignatura (ref _CFG_SUBJECTS)
//   programCode:   'CTB'    — programa (usar 'TRV' para transversales)
//   isTransversal: false    — true = UNA sola aula compartida todos los programas
//   notes:         ''       — razón de excepción si no sigue la malla oficial.
//                             Dejar vacío si es apertura normal.
//
// PARA AGREGAR UN PERÍODO NUEVO:
//   1. Copiar el bloque del cohorte más reciente como plantilla
//   2. Cambiar cohortCode y momentCode al nuevo período
//   3. Ajustar subjectCode según lo que Carlos confirme
//   4. Cambiar el estado del bloque de "PENDIENTE DE CONFIRMACIÓN" a "CONFIRMADO"
//   5. Ejecutar poblarAperturas({ cohortCode: 'NUEVO' })
//
// PARA CANCELAR UNA APERTURA YA REGISTRADA:
//   No hay función de cancelación automática en v1.1.
//   Cambiar manualmente AperturaStatus = 'CANCELADA' en Sheets.
//   Alternativa: force:true sobre el cohorte, con el plan corregido.
//
// VALIDACIÓN DE CÓDIGOS:
//   Los SubjectCodes (SPC, HID, FOT...) se validan en 04_crearAulas_v2.
//   Si un código no existe en _CFG_SUBJECTS, el script de aulas lo reportará
//   como "SubjectCode desconocido" sin detener el resto del batch.
// ─────────────────────────────────────────────────────────────

/**
 * Retorna el array de aperturas planificadas para todos los cohortes activos.
 * Esta es la ÚNICA fuente de datos para poblarAperturas() — nunca leer
 * desde Sheets ni desde otra función para poblar este array.
 *
 * @returns {Array<Object>} — array de objetos de apertura
 */
function obtenerPlanDeAperturas_() {
  var plan = [];

  // ══════════════════════════════════════════════════════════
  // MR26 — C1M2 (abre lunes 17 marzo 2026)
  //
  // Estado: CONFIRMADO por Carlos (confirmación: 14-mar-2026)
  // Aulas a crear: 6 específicas + 2 transversales = 8 total
  // Docentes: pendiente asignación vía 06_importarDocentes.gs
  //
  // Según malla oficial C1M2:
  //   CTB → SPC  | ADM → HID  | TLC → FOT
  //   SIS → EXC  | MKT → CRC  | SST → FDR
  //   TRV → MAT (compartida) | TRV → HIA (compartida)
  // ══════════════════════════════════════════════════════════

  plan.push({
    cohortCode: "MR26", momentCode: "C1M2", subjectCode: "SPC", programCode: "CTB",
    isTransversal: false, notes: "Soportes Contables — malla oficial C1M2"
  });

  plan.push({
    cohortCode: "MR26", momentCode: "C1M2", subjectCode: "HID", programCode: "ADM",
    isTransversal: false, notes: "Herramientas Informáticas — malla oficial C1M2"
  });

  plan.push({
    cohortCode: "MR26", momentCode: "C1M2", subjectCode: "FOT", programCode: "TLC",
    isTransversal: false, notes: "Fibra Óptica — malla oficial C1M2"
  });

  plan.push({
    cohortCode: "MR26", momentCode: "C1M2", subjectCode: "EXC", programCode: "SIS",
    isTransversal: false, notes: "Excel — malla oficial C1M2"
  });

  plan.push({
    cohortCode: "MR26", momentCode: "C1M2", subjectCode: "CRC", programCode: "MKT",
    isTransversal: false, notes: "Cultura Creatividad — malla oficial C1M2"
  });

  plan.push({
    cohortCode: "MR26", momentCode: "C1M2", subjectCode: "FDR", programCode: "SST",
    isTransversal: false, notes: "Factores de Riesgo — malla oficial C1M2"
  });

  // Transversales MR26: UNA sola aula compartida por todos los programas
  plan.push({
    cohortCode: "MR26", momentCode: "C1M2", subjectCode: "MAT", programCode: "TRV",
    isTransversal: true, notes: "Matemáticas Básicas — 1 aula compartida todos los programas"
  });

  plan.push({
    cohortCode: "MR26", momentCode: "C1M2", subjectCode: "HIA", programCode: "TRV",
    isTransversal: true, notes: "Herramientas IA — 1 aula compartida todos los programas"
  });


  // ══════════════════════════════════════════════════════════
  // EN26 — C2M1 (avanzando desde C1M2)
  //
  // Estado: PENDIENTE DE CONFIRMACIÓN por Carlos
  // Descomentar cuando Carlos confirme qué abre EN26 en C2M1.
  //
  // Según malla oficial C2M1:
  //   CTB → IBF + SIC (2 materias)  | ADM → BFA + GSC (2 materias)
  //   TLC → IRA       | SIS → FRN
  //   MKT → RSC       | SST → MPT
  //   TRV → PVE (compartida)
  // NOTA: CTB y ADM tienen 2 materias en C2M1 según la malla.
  //       Confirmar con Carlos si se abren ambas o solo una.
  // ══════════════════════════════════════════════════════════

  /*
  plan.push({ cohortCode:"EN26", momentCode:"C2M1", subjectCode:"IBF", programCode:"CTB",
              isTransversal:false, notes:"Balances Financieros NIIF" });
  plan.push({ cohortCode:"EN26", momentCode:"C2M1", subjectCode:"SIC", programCode:"CTB",
              isTransversal:false, notes:"Sistemas de Información Contable — CTB tiene 2 materias en C2M1" });
  plan.push({ cohortCode:"EN26", momentCode:"C2M1", subjectCode:"BFA", programCode:"ADM",
              isTransversal:false, notes:"Balances Financieros y Análisis" });
  plan.push({ cohortCode:"EN26", momentCode:"C2M1", subjectCode:"GSC", programCode:"ADM",
              isTransversal:false, notes:"Gestión del Servicio al Cliente — ADM tiene 2 materias en C2M1" });
  plan.push({ cohortCode:"EN26", momentCode:"C2M1", subjectCode:"IRA", programCode:"TLC",
              isTransversal:false, notes:"Redes Inalámbricas y Administración" });
  plan.push({ cohortCode:"EN26", momentCode:"C2M1", subjectCode:"FRN", programCode:"SIS",
              isTransversal:false, notes:"Frontend" });
  plan.push({ cohortCode:"EN26", momentCode:"C2M1", subjectCode:"RSC", programCode:"MKT",
              isTransversal:false, notes:"Redes Sociales" });
  plan.push({ cohortCode:"EN26", momentCode:"C2M1", subjectCode:"MPT", programCode:"SST",
              isTransversal:false, notes:"Medicina Preventiva del Trabajo" });
  plan.push({ cohortCode:"EN26", momentCode:"C2M1", subjectCode:"PVE", programCode:"TRV",
              isTransversal:true,  notes:"Proyecto de Vida — 1 aula compartida todos los programas" });
  */


  // ══════════════════════════════════════════════════════════
  // AB26 — A1B2 (Abre 7 de abr 2026 - Articulados)
  //
  // Estado: PENDIENTE DE CONFIRMACIÓN DE MATERIAS
  // Descomentar y completar los SubjectCode / ProgramCode a abrir,
  // según defina Carlos para los colegios articulados.
  //
  // NOTA ARQUITECTURAL: 
  //   Para aperturas individuales sin editar este array, usar:
  //   agregar_('AB26', 'A1B2', 'SPC', 'CTB', false, 'Apertura normal AB26/A1B2')
  // ══════════════════════════════════════════════════════════

  /*
  plan.push({ cohortCode:"AB26", momentCode:"A1B2", subjectCode:"XXX", programCode:"YYY",
              isTransversal:false, notes:"Materia específica de articulados AB26" });
  plan.push({ cohortCode:"AB26", momentCode:"A1B2", subjectCode:"ZZZ", programCode:"TRV",
              isTransversal:true, notes:"Materia transversal compartida" });
  */



  // ══════════════════════════════════════════════════════════
  // PLANTILLA PARA PRÓXIMOS PERÍODOS
  // Copiar este bloque y ajustar para MY26, AG26, SP26, etc.
  //
  // plan.push({
  //   cohortCode:    "MY26",
  //   momentCode:    "C2M1",   // MY26 entra en C2M1 según conveyor belt
  //   subjectCode:   "XXX",    // confirmar con Carlos
  //   programCode:   "YYY",    // o "TRV" si es transversal
  //   isTransversal: false,
  //   notes:         "Razón o excepción si no sigue malla oficial"
  // });
  // ══════════════════════════════════════════════════════════

  return plan;
}


// ─────────────────────────────────────────────────────────────
// HELPERS PRIVADOS — sufijo _ indica uso exclusivo de este archivo
// ─────────────────────────────────────────────────────────────

/**
 * Lee TODAS las filas de datos de APERTURA_PLAN en una sola llamada a la API.
 * Excluye el encabezado (fila 1). Retorna array vacío si la tabla está vacía.
 *
 * Por qué una sola llamada:
 *   getValues() sobre un rango completo es O(1) en cuota de API.
 *   Leer fila por fila sería O(n) — prohibido por el patrón del proyecto.
 *
 * @param  {Sheet}    hoja — hoja APERTURA_PLAN
 * @returns {Array[]} filas de datos (sin encabezado), o [] si vacía
 */
function leerTodasLasFilas_(hoja) {
  var lastRow = hoja.getLastRow();
  if (lastRow <= 1) return []; // solo encabezado o vacía
  return hoja.getRange(2, 1, lastRow - 1, hoja.getLastColumn()).getValues();
}

/**
 * Construye un mapa de idempotencia a partir de filas existentes.
 * Clave: "CohortCode_MomentCode_SubjectCode_ProgramCode"
 *
 * FIX v1.1 vs v1.0:
 *   v1.0 usaba `clave !== "___"` — solo detectaba filas donde los 4 campos
 *   eran vacíos simultáneamente. Una fila con 1–3 campos vacíos tenía una
 *   clave tipo "MR26_C1M2__" que pasaba el filtro incorrectamente.
 *   v1.1 valida explícitamente que todos los 4 campos sean no-vacíos.
 *
 * @param  {Array[]} filas — resultado de leerTodasLasFilas_()
 * @returns {Object}  { clave → true }
 */
function construirMapaIdempotencia_(filas) {
  var mapa = {};
  filas.forEach(function (row) {
    var cohort = row[1]; // CohortCode
    var momento = row[2]; // MomentCode
    var materia = row[3]; // SubjectCode
    var prog = row[4]; // ProgramCode
    // Solo indexar filas con los 4 campos de clave completos y no vacíos
    if (cohort && momento && materia && prog) {
      mapa[cohort + "_" + momento + "_" + materia + "_" + prog] = true;
    }
  });
  return mapa;
}

/**
 * Reescribe APERTURA_PLAN con el conjunto completo de filas dado.
 * Operación: clearContent (preserva formatos) + setValues en batch.
 * Total: 2 llamadas a la API de Sheets, independiente del número de filas.
 *
 * Por qué clearContent y no deleteRows:
 *   deleteRow() en un loop = N llamadas a la API (patrón prohibido).
 *   clearContent() sobre un rango = 1 llamada (patrón correcto).
 *   clearContent preserva el formato de celdas (checkboxes, fechas).
 *   deleteRows destruiría los formatos aplicados por aplicarFormatosHoja_().
 *
 * Si filasFinales está vacío: solo limpia la hoja (queda con encabezado).
 *
 * @param {Sheet}    hoja        — hoja APERTURA_PLAN
 * @param {Array[]}  filasFinales — todas las filas a escribir (sin encabezado)
 */
function escribirHojaCompleta_(hoja, filasFinales) {
  var lastRow = hoja.getLastRow();

  // Paso 1: limpiar datos existentes (preservar encabezado y formatos)
  if (lastRow > 1) {
    hoja.getRange(2, 1, lastRow - 1, hoja.getLastColumn()).clearContent();
  }

  // Paso 2: escribir todas las filas en una sola llamada
  if (filasFinales.length > 0) {
    hoja.getRange(2, 1, filasFinales.length, filasFinales[0].length)
      .setValues(filasFinales);
  }

  Logger.log("    💾 APERTURA_PLAN → " + filasFinales.length + " filas escritas en batch");
}

/**
 * Busca el índice (0-base en el array, no en Sheets) de una fila de APERTURA_PLAN
 * que coincida con la clave compuesta {cohort + moment + subject + program}.
 * Opera en memoria — no hace llamadas a la API.
 * Retorna -1 si no se encuentra ninguna coincidencia.
 *
 * @param  {Array[]} filas        — resultado de leerTodasLasFilas_()
 * @param  {string}  cohortCode
 * @param  {string}  momentCode
 * @param  {string}  subjectCode
 * @param  {string}  programCode
 * @returns {number} índice en el array (0-base), o -1 si no existe
 */
function buscarFila_(filas, cohortCode, momentCode, subjectCode, programCode) {
  for (var i = 0; i < filas.length; i++) {
    if (filas[i][1] === cohortCode &&
      filas[i][2] === momentCode &&
      filas[i][3] === subjectCode &&
      filas[i][4] === programCode) {
      return i;
    }
  }
  return -1;
}


// ─────────────────────────────────────────────────────────────
// FUNCIÓN PÚBLICA — GESTIONAR APERTURA (v1.2)
// ─────────────────────────────────────────────────────────────

/**
 * Modifica APERTURA_PLAN con trazabilidad completa.
 * Es la ÚNICA función autorizada para cambiar filas ya registradas.
 * Toda modificación queda firmada: quién (UpdatedBy) y cuándo (UpdatedAt).
 *
 * PROBLEMA QUE RESUELVE:
 *   Hasta v1.1, los cambios post-carga se hacían editando Sheets directamente.
 *   Sheets no registra el usuario ni el timestamp del cambio en las celdas.
 *   Resultado: en un mes nadie sabe quién canceló FOT ni por qué.
 *   Con esta función, todo cambio pasa por aquí y queda en la tabla.
 *
 * ACCIONES DISPONIBLES:
 *
 *   'CANCELAR'
 *     Marca una apertura PENDIENTE o CREADA como CANCELADA.
 *     Requiere notes — documenta la razón (docente, estudiantes, etc.).
 *     No elimina la fila — queda como registro de auditoría permanente.
 *     04_crearAulas_v2 nunca procesa filas CANCELADAS.
 *     Ejemplo: Carlos confirma que no habrá docente para TLC/FOT este período.
 *
 *   'AGREGAR'
 *     Agrega una nueva apertura PENDIENTE fuera del plan original.
 *     Equivale a llamar poblarAperturas() para una sola materia, pero
 *     con validación de duplicados y firma de auditoría.
 *     Ejemplo: abrir MDA para estudiantes rezagados de EN26 que no cursaron
 *     en su momento original.
 *     Requiere: subjectCode, programCode, isTransversal (opcional, default false).
 *
 *   'REEMPLAZAR'
 *     Combina CANCELAR + AGREGAR en una sola operación atómica.
 *     Cancela subjectCodeAnterior y agrega subjectCode en su lugar.
 *     Usa una sola lectura y una sola escritura — no dos operaciones separadas.
 *     Ejemplo: Carlos decide no abrir CRC en MKT y en su lugar abrir SEM.
 *     Requiere: subjectCodeAnterior (la que se cancela) + subjectCode (la nueva).
 *
 *   'REACTIVAR'
 *     Revierte una CANCELADA a PENDIENTE. Útil si Carlos cambia de opinión.
 *     Requiere notes — documenta por qué se reactiva.
 *
 * LOCKING:
 *   Siempre adquiere LockService — cualquier modificación puede tener
 *   condición de carrera si dos sesiones del editor GAS están abiertas.
 *
 * PATRÓN MEMORY-FIRST:
 *   Lee toda APERTURA_PLAN (1 llamada) → modifica en memoria → escribe en
 *   batch (clearContent + setValues = 2 llamadas). Total: 3 llamadas fijas.
 *
 * USO DIRECTO:
 *   gestionarApertura({
 *     accion:      'CANCELAR',
 *     cohortCode:  'MR26',  momentCode:  'C1M2',
 *     subjectCode: 'CRC',   programCode: 'MKT',
 *     notes:       'Carlos: no abre CRC. Se abrirá SEM en su lugar.'
 *   });
 *
 *   gestionarApertura({
 *     accion:      'REEMPLAZAR',
 *     cohortCode:  'MR26',  momentCode:  'C1M2',
 *     programCode: 'MKT',
 *     subjectCodeAnterior: 'CRC',   // se cancela
 *     subjectCode:         'SEM',   // se agrega
 *     isTransversal: false,
 *     notes: 'CRC → SEM por decisión de Carlos 14-mar-2026'
 *   });
 *
 *   gestionarApertura({
 *     accion:      'AGREGAR',
 *     cohortCode:  'MR26',  momentCode:  'C1M2',
 *     subjectCode: 'MDA',   programCode: 'MKT',
 *     isTransversal: false,
 *     notes: 'Fuera de malla — estudiantes MKT rezagados de EN26'
 *   });
 *
 * USO VÍA ATAJOS (más rápido para casos comunes):
 *   cancelar_('MR26', 'C1M2', 'CRC', 'MKT', 'Docente no disponible')
 *   agregar_('MR26', 'C1M2', 'MDA', 'MKT', false, 'Fuera de malla')
 *   reemplazar_('MR26', 'C1M2', 'MKT', 'CRC', 'SEM', false, 'Motivo')
 *
 * @param {Object}  opts
 * @param {string}  opts.accion             — 'CANCELAR'|'AGREGAR'|'REEMPLAZAR'|'REACTIVAR'
 * @param {string}  opts.cohortCode         — ref _CFG_COHORTS
 * @param {string}  opts.momentCode         — ref _CFG_MOMENTS
 * @param {string}  opts.subjectCode        — asignatura objetivo (nueva en AGREGAR/REEMPLAZAR)
 * @param {string}  opts.programCode        — ref _CFG_PROGRAMS
 * @param {string}  [opts.subjectCodeAnterior] — solo en REEMPLAZAR: asignatura a cancelar
 * @param {boolean} [opts.isTransversal]    — solo en AGREGAR/REEMPLAZAR (default: false)
 * @param {string}  opts.notes              — OBLIGATORIO en CANCELAR, REEMPLAZAR, REACTIVAR
 */
function gestionarApertura(opts) {
  var options = opts || {};
  var accion = (options.accion || '').toUpperCase();
  var cohort = options.cohortCode;
  var momento = options.momentCode;
  var subject = options.subjectCode;
  var prog = options.programCode;
  var notes = options.notes || '';
  var isTRV = options.isTransversal === true;
  var ahora = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();
  var inicio = Date.now();

  Logger.log('════════════════════════════════════════════════');
  Logger.log('✏️  SIDEP — gestionarApertura v1.2');
  Logger.log('   Ejecutor : ' + ejecutor);
  Logger.log('   Acción   : ' + accion);
  Logger.log('   Cohorte  : ' + cohort + ' · ' + momento);
  Logger.log('   Materia  : ' + subject + ' (' + prog + ')');
  Logger.log('   Notes    : ' + (notes || '(vacío)'));
  Logger.log('════════════════════════════════════════════════');

  // ── Validaciones de entrada ───────────────────────────────────────────────
  var accionesValidas = ['CANCELAR', 'AGREGAR', 'REEMPLAZAR', 'REACTIVAR'];
  if (accionesValidas.indexOf(accion) === -1) {
    throw new Error(
      'Acción inválida: "' + accion + '". ' +
      'Usar: ' + accionesValidas.join(' | ')
    );
  }

  if (!cohort || !momento || !prog) {
    throw new Error('cohortCode, momentCode y programCode son OBLIGATORIOS.');
  }

  // subject es obligatorio en todas las acciones excepto cuando solo se
  // indica subjectCodeAnterior para REEMPLAZAR — pero el nuevo también es req.
  if (!subject) {
    throw new Error(
      'subjectCode es OBLIGATORIO. ' +
      'En REEMPLAZAR: subjectCode = la nueva materia, ' +
      'subjectCodeAnterior = la que se cancela.'
    );
  }

  // Notes obligatorio en acciones con impacto (no en AGREGAR — puede ser vacío)
  if ((accion === 'CANCELAR' || accion === 'REEMPLAZAR' || accion === 'REACTIVAR') && !notes) {
    throw new Error(
      'notes es OBLIGATORIO en ' + accion + '. ' +
      'Documenta la razón del cambio para trazabilidad.'
    );
  }

  // REEMPLAZAR requiere la materia anterior
  if (accion === 'REEMPLAZAR' && !options.subjectCodeAnterior) {
    throw new Error(
      'subjectCodeAnterior es OBLIGATORIO en REEMPLAZAR. ' +
      'Indica la materia que se cancela. ' +
      'Ejemplo: { subjectCodeAnterior: "CRC", subjectCode: "SEM" }'
    );
  }

  // LockService: siempre en gestionarApertura — cualquier modificación es crítica
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error(
      '⚠️  Lock ocupado — otro proceso está modificando APERTURA_PLAN. ' +
      'Espera 30s e intenta de nuevo.'
    );
  }
  Logger.log('  🔐 Lock adquirido');

  try {
    var coreSS = getSpreadsheetByName('core');
    var hoja = coreSS.getSheetByName('APERTURA_PLAN');

    if (!hoja) {
      throw new Error(
        'Tabla APERTURA_PLAN no encontrada. ' +
        'Ejecutar setupSidepTables() con 00_SIDEP_CONFIG.gs v4.0.0+ primero.'
      );
    }

    // ── PASO 1: Leer toda la tabla en memoria — 1 llamada a la API ───────────
    var filas = leerTodasLasFilas_(hoja);

    // ── PASO 2: Modificar en memoria según la acción ──────────────────────────
    // Todo el procesamiento ocurre en JS puro, sin llamadas a la API.
    // Solo al final se escribe todo de una vez.

    var accionesRealizadas = [];

    if (accion === 'CANCELAR' || accion === 'REACTIVAR') {
      // ── Buscar la fila objetivo ─────────────────────────────────────────────
      var idx = buscarFila_(filas, cohort, momento, subject, prog);

      if (idx === -1) {
        throw new Error(
          'No se encontró la apertura: ' +
          [cohort, momento, subject, prog].join(' / ') + '. ' +
          'Verificar con diagnosticoAperturas() los valores exactos.'
        );
      }

      // FIX-AUDIT C-5: eliminada variable statusActual (1+5 — número mágico) que nunca se usaba.
      // AperturaStatus = índice 6 (0-base) según CORE_TABLES["APERTURA_PLAN"]
      var statusActualVal = filas[idx][6];

      if (accion === 'CANCELAR') {
        if (statusActualVal === 'CANCELADA') {
          Logger.log('  ⚠️  La apertura ya está CANCELADA. Nada que hacer.');
          return;
        }
        if (statusActualVal === 'CREADA') {
          Logger.log('  ⚠️  La apertura ya fue procesada (CREADA). ' +
            'El aula ya existe en MasterDeployments. ' +
            'Cancelar solo afecta APERTURA_PLAN — el aula en Classroom ' +
            'debe archivarse manualmente si es necesario.');
        }
        filas[idx][6] = 'CANCELADA';
        filas[idx][10] = notes;    // Notes
        filas[idx][13] = ahora;    // UpdatedAt
        filas[idx][14] = ejecutor; // UpdatedBy
        accionesRealizadas.push('CANCELADA: ' + subject + ' (' + prog + ')');

      } else { // REACTIVAR
        if (statusActualVal !== 'CANCELADA') {
          throw new Error(
            'Solo se pueden reactivar aperturas CANCELADAS. ' +
            'Estado actual: ' + statusActualVal
          );
        }
        filas[idx][6] = 'PENDIENTE';
        filas[idx][10] = notes + ' [REACTIVADA por ' + ejecutor + ']';
        filas[idx][13] = ahora;
        filas[idx][14] = ejecutor;
        accionesRealizadas.push('REACTIVADA: ' + subject + ' (' + prog + ')');
      }

    } else if (accion === 'AGREGAR') {
      // ── Verificar que no exista ya (idempotencia) ───────────────────────────
      var idxExistente = buscarFila_(filas, cohort, momento, subject, prog);
      if (idxExistente !== -1) {
        var estadoExistente = filas[idxExistente][6];
        if (estadoExistente !== 'CANCELADA') {
          throw new Error(
            'Ya existe una apertura activa para: ' +
            [cohort, momento, subject, prog].join(' / ') +
            ' (Status: ' + estadoExistente + '). ' +
            'Usa REEMPLAZAR si quieres cambiar otra materia por esta, ' +
            'o REACTIVAR si la apertura estaba CANCELADA.'
          );
        }
        // Si estaba CANCELADA, reactivar en lugar de duplicar
        Logger.log('  ℹ️  Apertura CANCELADA existente — reactivando en lugar de duplicar.');
        filas[idxExistente][6] = 'PENDIENTE';
        filas[idxExistente][10] = (notes || 'Reactivada vía AGREGAR') +
          ' [por ' + ejecutor + ']';
        filas[idxExistente][13] = ahora;
        filas[idxExistente][14] = ejecutor;
        accionesRealizadas.push('REACTIVADA (era CANCELADA): ' + subject + ' (' + prog + ')');
      } else {
        // Construir nueva fila en memoria
        var nuevaFila = [
          'apr_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12),
          cohort,
          momento,
          subject,
          prog,
          isTRV,
          'PENDIENTE',
          '',        // DeploymentID — vacío hasta planificarDesdeAperturaPlan()
          ejecutor,  // PlannedBy
          ahora,     // PlannedAt
          notes,     // Notes
          ahora,     // CreatedAt
          ejecutor,  // CreatedBy
          '',        // UpdatedAt
          ''         // UpdatedBy
        ];
        filas.push(nuevaFila);
        accionesRealizadas.push('AGREGADA: ' + subject + ' (' + prog + ')');
      }

    } else if (accion === 'REEMPLAZAR') {
      // ── Parte 1: Cancelar la materia anterior ──────────────────────────────
      var subjAnterior = options.subjectCodeAnterior;
      var idxAnterior = buscarFila_(filas, cohort, momento, subjAnterior, prog);

      if (idxAnterior === -1) {
        throw new Error(
          'No se encontró la apertura a cancelar: ' +
          [cohort, momento, subjAnterior, prog].join(' / ') + '. ' +
          'Verificar subjectCodeAnterior con diagnosticoAperturas().'
        );
      }

      filas[idxAnterior][6] = 'CANCELADA';
      filas[idxAnterior][10] = 'REEMPLAZADA por ' + subject + '. ' + notes;
      filas[idxAnterior][13] = ahora;
      filas[idxAnterior][14] = ejecutor;
      accionesRealizadas.push('CANCELADA: ' + subjAnterior + ' (' + prog + ')');

      // ── Parte 2: Agregar la materia nueva ───────────────────────────────────
      var idxNueva = buscarFila_(filas, cohort, momento, subject, prog);
      if (idxNueva !== -1 && filas[idxNueva][6] !== 'CANCELADA') {
        throw new Error(
          'La materia nueva ' + subject + ' ya existe como apertura activa (' +
          filas[idxNueva][6] + '). No se puede agregar un duplicado.'
        );
      }
      // Si existía CANCELADA, reactivar; si no existía, crear nueva
      if (idxNueva !== -1) {
        filas[idxNueva][6] = 'PENDIENTE';
        filas[idxNueva][10] = 'Reemplaza ' + subjAnterior + '. ' + notes;
        filas[idxNueva][13] = ahora;
        filas[idxNueva][14] = ejecutor;
      } else {
        filas.push([
          'apr_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12),
          cohort, momento, subject, prog, isTRV,
          'PENDIENTE', '',
          ejecutor, ahora,
          'Reemplaza ' + subjAnterior + '. ' + notes,
          ahora, ejecutor, '', ''
        ]);
      }
      accionesRealizadas.push('AGREGADA: ' + subject + ' (' + prog + ')');
    }

    // ── PASO 3: Escribir en batch — 2 llamadas a la API ─────────────────────
    escribirHojaCompleta_(hoja, filas);

    var dur = ((Date.now() - inicio) / 1000).toFixed(1);
    Logger.log('════════════════════════════════════════════════');
    Logger.log('✅ gestionarApertura completado en ' + dur + 's');
    accionesRealizadas.forEach(function (a) { Logger.log('   → ' + a); });
    Logger.log('   Ejecutor : ' + ejecutor);
    Logger.log('   Timestamp: ' + Utilities.formatDate(ahora, 'America/Bogota', 'yyyy-MM-dd HH:mm'));
    if (accion === 'CANCELAR' || accion === 'REEMPLAZAR') {
      Logger.log('⚠️  Si el aula ya estaba CREADA en Classroom, archivarla manualmente.');
    }
    if (accion === 'AGREGAR' || accion === 'REEMPLAZAR') {
      Logger.log('⏭  SIGUIENTE: planificarDesdeAperturaPlan({ cohortCode: \'' +
        cohort + '\', momentCode: \'' + momento + '\' })');
    }
    Logger.log('════════════════════════════════════════════════');

  } catch (e) {
    Logger.log('❌ ERROR en gestionarApertura: ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
    Logger.log('  🔓 Lock liberado');
  }
}


// ─────────────────────────────────────────────────────────────
// ATAJOS DE CONVENIENCIA — para los casos más frecuentes
// Llaman gestionarApertura() internamente con la firma correcta.
// ─────────────────────────────────────────────────────────────

/**
 * Cancela una apertura con un solo argumento por campo.
 * Más rápido que escribir el objeto completo.
 * Ejemplo: cancelar_('MR26','C1M2','CRC','MKT','Docente no disponible este período')
 *
 * @param {string} cohortCode
 * @param {string} momentCode
 * @param {string} subjectCode
 * @param {string} programCode
 * @param {string} notes     — OBLIGATORIO: razón de la cancelación
 */
function cancelar_(cohortCode, momentCode, subjectCode, programCode, notes) {
  gestionarApertura({
    accion: 'CANCELAR',
    cohortCode: cohortCode,
    momentCode: momentCode,
    subjectCode: subjectCode,
    programCode: programCode,
    notes: notes
  });
}

/**
 * Agrega una apertura nueva con un solo argumento por campo.
 * Útil para materias fuera de la malla oficial o excepciones por estudiante.
 * Ejemplo: agregar_('MR26','C1M2','MDA','MKT',false,'Estudiantes EN26 rezagados')
 *
 * @param {string}  cohortCode
 * @param {string}  momentCode
 * @param {string}  subjectCode
 * @param {string}  programCode
 * @param {boolean} isTransversal — true si es materia TRV compartida
 * @param {string}  [notes]       — razón o contexto de la adición
 */
function agregar_(cohortCode, momentCode, subjectCode, programCode, isTransversal, notes) {
  gestionarApertura({
    accion: 'AGREGAR',
    cohortCode: cohortCode,
    momentCode: momentCode,
    subjectCode: subjectCode,
    programCode: programCode,
    isTransversal: isTransversal === true,
    notes: notes || ''
  });
}

/**
 * Reemplaza una materia por otra en una sola operación atómica.
 * Cancela subjectCodeAnterior y agrega subjectCode con la misma firma.
 * Ejemplo: reemplazar_('MR26','C1M2','MKT','CRC','SEM',false,'Carlos: SEM reemplaza CRC')
 *
 * @param {string}  cohortCode
 * @param {string}  momentCode
 * @param {string}  programCode
 * @param {string}  subjectCodeAnterior — materia que se cancela
 * @param {string}  subjectCode         — materia nueva que se abre
 * @param {boolean} isTransversal       — true si la nueva es TRV compartida
 * @param {string}  notes               — OBLIGATORIO: razón del reemplazo
 */
function reemplazar_(cohortCode, momentCode, programCode,
  subjectCodeAnterior, subjectCode, isTransversal, notes) {
  gestionarApertura({
    accion: 'REEMPLAZAR',
    cohortCode: cohortCode,
    momentCode: momentCode,
    programCode: programCode,
    subjectCodeAnterior: subjectCodeAnterior,
    subjectCode: subjectCode,
    isTransversal: isTransversal === true,
    notes: notes
  });
}


// ─────────────────────────────────────────────────────────────
// DIAGNÓSTICO DE APERTURA_PLAN
// ─────────────────────────────────────────────────────────────

/**
 * Muestra el estado actual de APERTURA_PLAN agrupado por cohorte.
 * Solo lectura — no modifica nada. Útil para:
 *   - Verificar qué cambios hizo gestionarApertura()
 *   - Ver qué aperturas siguen PENDIENTE antes de planificar
 *   - Identificar quién y cuándo modificó cada fila (UpdatedBy/UpdatedAt)
 */
function diagnosticoAperturas() {
  Logger.log('════════════════════════════════════════════════');
  Logger.log('🔍 SIDEP — Diagnóstico APERTURA_PLAN v1.2');
  Logger.log('════════════════════════════════════════════════');

  try {
    var coreSS = getSpreadsheetByName('core');
    var hoja = coreSS.getSheetByName('APERTURA_PLAN');

    if (!hoja || hoja.getLastRow() <= 1) {
      Logger.log('⬜ APERTURA_PLAN vacía — ejecutar poblarAperturas() primero.');
      return;
    }

    var filas = leerTodasLasFilas_(hoja);

    // Agrupar por cohorte → momento → estado
    var resumen = {};
    filas.forEach(function (row) {
      var cohort = row[1];  // CohortCode
      var momento = row[2];  // MomentCode
      var subject = row[3];  // SubjectCode
      var prog = row[4];  // ProgramCode
      var status = row[6];  // AperturaStatus
      var notes = row[10]; // Notes
      var updBy = row[14]; // UpdatedBy
      var updAt = row[13]; // UpdatedAt

      var key = cohort + '_' + momento;
      if (!resumen[key]) resumen[key] = { PENDIENTE: [], CREADA: [], CANCELADA: [] };
      var entrada = subject + ' (' + prog + ')';
      if (updBy) entrada += ' ← ' + updBy;
      if (notes) entrada += ' | "' + String(notes).substring(0, 60) + '"';
      resumen[key][status] = (resumen[key][status] || []);
      resumen[key][status].push(entrada);
    });

    Object.keys(resumen).sort().forEach(function (key) {
      var g = resumen[key];
      Logger.log('\n📋 ' + key.replace('_', ' · '));
      if ((g.PENDIENTE || []).length) {
        Logger.log('   ⬜ PENDIENTE  (' + g.PENDIENTE.length + '):');
        g.PENDIENTE.forEach(function (e) { Logger.log('      ' + e); });
      }
      if ((g.CREADA || []).length) {
        Logger.log('   ✅ CREADA     (' + g.CREADA.length + '):');
        g.CREADA.forEach(function (e) { Logger.log('      ' + e); });
      }
      if ((g.CANCELADA || []).length) {
        Logger.log('   ❌ CANCELADA  (' + g.CANCELADA.length + '):');
        g.CANCELADA.forEach(function (e) { Logger.log('      ' + e); });
      }
    });

    Logger.log('\n════════════════════════════════════════════════');
    Logger.log('   Total filas: ' + filas.length);
    Logger.log('════════════════════════════════════════════════');

  } catch (e) {
    Logger.log('❌ ERROR en diagnosticoAperturas: ' + e.message);
  }
}