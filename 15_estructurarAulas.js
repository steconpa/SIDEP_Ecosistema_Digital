/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL
 * Archivo: 05_estructurarAulas.gs
 * Versión: 1.3
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Crear Topics vacíos en cada aula CREATED de Google Classroom,
 *   uno por semana del temario correspondiente a la materia.
 *   Registra cada Topic en DeploymentTopics (CORE).
 *   CERO lógica de estudiantes ni de creación de aulas.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs v3.6.1+ → SIDEP_CONFIG, CORE_TABLES,
 *                                  getSpreadsheetByName(), nowSIDEP()
 *   03_poblarSyllabus.gs       → _CFG_SYLLABUS poblada en ADMIN
 *   04_crearAulas.gs           → MasterDeployments con filas CREATED
 *   Google Classroom API v1    → Editor → ➕ Servicios → Classroom API → Agregar
 *
 * TABLA FUENTE:  MasterDeployments (CORE)   — filas con ScriptStatusCode=CREATED
 * TABLA TEMARIO: _CFG_SYLLABUS (ADMIN)      — { SubjectCode × WeekNumber → Tema }
 * TABLA DESTINO: DeploymentTopics (CORE)    — una fila por aula × semana
 *
 * UBICACIÓN CRÍTICA DE _CFG_SYLLABUS:
 *   _CFG_SYLLABUS vive en SIDEP_02_GESTION_ADMIN, NO en CORE.
 *   03_poblarSyllabus.gs escribe en getSpreadsheetByName("admin").
 *   leerSyllabus_() exige adminSS explícito para evitar ambigüedad.
 *   (FIX-01 v1.1: la v1.0 buscaba en CORE y fallaba silenciosamente.)
 *
 * PREREQUISITOS:
 *   ✅ setupSidepTables()       — recomendado; si DeploymentTopics no existe
 *                                 el script la crea automáticamente (FIX-02)
 *   ✅ poblarConfiguraciones()  — _CFG_STATUSES con tipo STRUCTURE
 *   ✅ poblarSyllabus()         — _CFG_SYLLABUS con temarios por SubjectCode
 *   ✅ crearAulas()             — MasterDeployments con ScriptStatusCode=CREATED
 *   ✅ Classroom API habilitada — Editor → ➕ Servicios → Google Classroom API (v1)
 *
 * FUNCIONES PÚBLICAS:
 *   estructurarAulas(options)  — punto de entrada recomendado
 *   diagnosticoEstructura()    — resumen de progreso, solo lectura
 *
 * OPCIONES (options object):
 *   programCode : 'CTB'|'ADM'|… — filtrar por programa (default: todos)
 *   momentCode  : 'C1M1'|…      — filtrar por momento  (default: todos)
 *   cohortCode  : 'EN26'|…      — filtrar por ventana   (default: todos)
 *   dryRun      : true           — log sin llamar API ni escribir nada
 *   force       : true           — recrea topics aunque ya existan en DeploymentTopics
 *   batchSize   : N              — aulas por ejecución (default: 20)
 *
 * NOMENCLATURA DE TOPICS EN CLASSROOM:
 *   Formato : "Semana {N} · {Tema}"
 *   Ejemplo : "Semana 3 · El Ciclo Contable"
 *   El docente ve esta cadena como encabezado de sección en el Stream del aula.
 *
 * FLUJO POR AULA (dentro del batch):
 *   Para cada deployment CREATED con syllabus disponible:
 *   1. Verifica en DeploymentTopics si la semana ya tiene topic (idempotencia).
 *   2. Llama Classroom.Courses.Topics.create({ name: topicName }, courseID).
 *   3. Acumula la fila resultado en nuevasFilas[] (en memoria).
 *   4. Si error → acumula fila STRUCTURE_ERROR (no detiene el batch).
 *   5. Al terminar el batch: una sola setValues() escribe todo en DeploymentTopics.
 *
 * IDEMPOTENCIA:
 *   leerTopicsExistentes_() construye un mapa { "depID_weekN" → true }.
 *   Antes de llamar la API, se verifica si la clave ya existe en ese mapa.
 *   Si ya existe y force=false → omite sin error.
 *   Re-ejecutar el script nunca crea topics duplicados en Classroom.
 *
 * ESCRITURA EN BATCH (y la excepción):
 *   Todos los topics del batch se acumulan en nuevasFilas[] y se escriben
 *   al final con una sola llamada setValues(). Esto incluye las filas de error.
 *   A diferencia de 04_crearAulas.gs, aquí sí es posible hacer batch porque
 *   el topicId que retorna la API se captura inmediatamente dentro del forEach
 *   y se añade a nuevasFilas[]: si el script falla antes de setValues(),
 *   leerTopicsExistentes_() no encontrará esos topics la próxima vez y los
 *   reintentará. El único riesgo es un topic duplicado en Classroom sin fila
 *   en DeploymentTopics — diagnosticoEstructura() lo detectaría como error.
 *
 * RESILIENCIA ANTE ERRORES DE API:
 *   Un error en un topic no detiene el batch — se registra STRUCTURE_ERROR
 *   en DeploymentTopics y continúa con el siguiente. Al terminar, el Logger
 *   informa cuántos errores hubo. Para reintentar solo los errores:
 *     estructurarAulas({ force: true, programCode: '...', cohortCode: '...' })
 *
 * CREACIÓN AUTOMÁTICA DE DeploymentTopics (FIX-02 v1.2):
 *   obtenerOCrearDeploymentTopics_() verifica si la hoja existe en CORE.
 *   Si no existe (setupSidepTables se ejecutó con un schema anterior a v3.5.0),
 *   la crea con el header y estilo de CORE_TABLES. El script es autónomo.
 *
 * CAMPOS FASE 2 EN DeploymentTopics:
 *   CourseWorkCount, MaterialCount y AssignmentIDs se escriben como 0, 0, "".
 *   El schema ya los tiene — activar Fase 2 NO requiere migración de tabla.
 *   En caso de STRUCTURE_ERROR, AssignmentIDs almacena el mensaje de error
 *   (es el único campo de texto libre disponible en Fase 1).
 *   StructureStatusCode pasará de TOPICS_CREATED a FULL cuando Fase 2 esté lista.
 *
 * CUOTAS Y TIEMPOS:
 *   Classroom Topics.create: ~500 req/día por cuenta.
 *   SIDEP Fase 1: ~110 aulas × ~8 semanas = ~880 topics totales.
 *   batchSize=20 × 8 semanas = 160 topics/corrida → ~5–6 corridas para completar.
 *   Cada corrida: ~2–3 min con sleep de 150ms entre llamadas API.
 *   Si se agota el límite diario: esperar 24h y continuar — el script retoma
 *   desde donde quedó (topics TOPICS_CREATED no se vuelven a crear).
 *
 * CONSTANTES DE COLUMNAS (COL_DEP_ y COL_TOP_):
 *   Definidas al inicio del archivo para evitar índices mágicos.
 *   Si el schema de MasterDeployments o DeploymentTopics cambia en
 *   00_SIDEP_CONFIG.gs, actualizar aquí también.
 *
 * CAMBIOS v1.3 vs v1.2:
 *   - nowSIDEP() reemplaza new Date() para timestamps en America/Bogota.
 *   - Logger en estructurarAulas() muestra "v1.3" (antes decía "v1.0" — bug).
 *   - diagnosticoEstructura() unifica las dos lecturas de MasterDeployments
 *     en una sola llamada getValues() batch.
 *   - Comentario en COL_TOP_.AssignmentIDs documenta uso dual (Fase 2 / error msg).
 *   - JSDoc de leerTopicsExistentes_() corregido: clave real es "depID_weekN".
 *   - Documentación completa de flujo, idempotencia, batch y Fase 2.
 *
 * CAMBIOS v1.2 vs v1.1:
 *   - FIX-02: obtenerOCrearDeploymentTopics_() — crea DeploymentTopics
 *     automáticamente si no existe. Evita TypeError en setups incompletos.
 *
 * CAMBIOS v1.1 vs v1.0:
 *   - FIX-01: leerSyllabus_() recibe adminSS en lugar de coreSS.
 *     _CFG_SYLLABUS vive en ADMIN, no en CORE.
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// CONSTANTES DE COLUMNAS (0-base)
// Mantener sincronizadas con los schemas de 00_SIDEP_CONFIG.gs.
// Si cambia el orden de columnas, actualizar ambos lados.
// ─────────────────────────────────────────────────────────────

/** Índices de columnas de MasterDeployments (0-base) */
var COL_DEP_ = {
  DeploymentID:          0,
  ProgramCode:           1,
  ModalityCode:          2,
  CohortCode:            3,
  MomentCode:            4,
  SubjectCode:           5,
  GroupCode:             6,
  SubjectName:           7,
  GeneratedNomenclature: 8,
  GeneratedClassroomName:9,
  ClassroomID:           10,
  ClassroomURL:          11,
  ScriptStatusCode:      12,
  CampusCode:            13
};

/** Índices de columnas de DeploymentTopics (0-base) */
var COL_TOP_ = {
  TopicRowID:            0,
  DeploymentID:          1,
  ClassroomCourseID:     2,
  ClassroomTopicID:      3,
  SubjectCode:           4,
  WeekNumber:            5,
  TopicName:             6,
  StructureStatusCode:   7,
  CourseWorkCount:       8,   // Fase 2 — 0 en Fase 1
  MaterialCount:         9,   // Fase 2 — 0 en Fase 1
  AssignmentIDs:         10,  // Fase 2: lista de IDs | Fase 1 ERROR: mensaje de error
  CreatedAt:             11,
  CreatedBy:             12,
  UpdatedAt:             13,
  UpdatedBy:             14
};


// ─────────────────────────────────────────────────────────────
// FUNCIÓN 1 — PUNTO DE ENTRADA
// ─────────────────────────────────────────────────────────────

/**
 * Crea Topics vacíos en cada aula CREATED de MasterDeployments
 * que aún no tenga estructura completa en DeploymentTopics.
 *
 * EJEMPLOS:
 *   estructurarAulas({ cohortCode: 'EN26' })                     — todas las aulas EN26
 *   estructurarAulas({ programCode: 'CTB', dryRun: true })       — preview CTB sin escribir
 *   estructurarAulas({ programCode: 'ADM', force: true })        — recrear ADM completo
 *   estructurarAulas({ cohortCode: 'MR26', momentCode: 'C1M2' }) — ventana + momento exacto
 */
function estructurarAulas(options) {
  var opts      = options || {};
  var dryRun    = opts.dryRun    === true;
  var force     = opts.force     === true;
  var batchSize = opts.batchSize || 20;
  var ahora     = nowSIDEP(); // America/Bogota — patrón del proyecto v3.6.1+
  var ejecutor  = Session.getEffectiveUser().getEmail();
  var t0        = Date.now();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🏗  SIDEP — estructurarAulas v1.3");
  Logger.log("   Ejecutor : " + ejecutor);
  Logger.log("   programa : " + (opts.programCode || "todos"));
  Logger.log("   momento  : " + (opts.momentCode  || "todos"));
  Logger.log("   cohorte  : " + (opts.cohortCode  || "todos"));
  Logger.log("   dryRun   : " + (dryRun ? "SÍ — no se escribe nada" : "NO"));
  Logger.log("   force    : " + (force  ? "SÍ — recrea topics existentes" : "NO"));
  Logger.log("   batch    : " + batchSize + " aulas/ejecución");
  Logger.log("════════════════════════════════════════════════");

  try {
    var coreSS  = getSpreadsheetByName("core");
    // _CFG_SYLLABUS vive en ADMIN — leerSyllabus_() exige adminSS explícito (FIX-01)
    var adminSS = getSpreadsheetByName("admin");

    // ── Leer catálogos en memoria — una llamada batch cada uno ─
    var syllabus  = leerSyllabus_(adminSS);        // { SubjectCode → [{semana, tema}] }
    var depTopics = leerTopicsExistentes_(coreSS); // { "depID_weekN" → true }

    // ── Leer deployments CREATED ──────────────────────────────
    var hojaDep = coreSS.getSheetByName("MasterDeployments");
    var lastRow = hojaDep.getLastRow();
    if (lastRow <= 1) {
      Logger.log("⬜ MasterDeployments vacía. Ejecutar crearAulas() primero.");
      return;
    }

    var allDeps = hojaDep.getRange(2, 1, lastRow - 1, 17).getValues();

    // Filtrar: solo CREATED + filtros opcionales de la llamada
    var depsFiltrados = allDeps.filter(function(row) {
      if (row[COL_DEP_.ScriptStatusCode] !== "CREATED") return false;
      if (opts.programCode && row[COL_DEP_.ProgramCode] !== opts.programCode) return false;
      if (opts.momentCode  && row[COL_DEP_.MomentCode]  !== opts.momentCode)  return false;
      if (opts.cohortCode  && row[COL_DEP_.CohortCode]  !== opts.cohortCode)  return false;
      return true;
    });

    Logger.log("  📊 Deployments CREATED encontrados : " + depsFiltrados.length);

    // Separar los que ya tienen todas sus semanas en DeploymentTopics
    var depsPendientes = depsFiltrados.filter(function(row) {
      var depID   = row[COL_DEP_.DeploymentID];
      var semanas = syllabus[row[COL_DEP_.SubjectCode]];
      if (!semanas || semanas.length === 0) return false; // sin syllabus → omitir
      // "completo" = todas las semanas del syllabus ya tienen topic registrado
      var yaCompleto = semanas.every(function(s) {
        return depTopics[depID + "_" + s.semana] === true;
      });
      return force || !yaCompleto;
    });

    Logger.log("  📊 Pendientes de estructurar       : " + depsPendientes.length);
    Logger.log("  📊 Sin syllabus (se omiten)        : " +
      depsFiltrados.filter(function(r) {
        return !syllabus[r[COL_DEP_.SubjectCode]] ||
               syllabus[r[COL_DEP_.SubjectCode]].length === 0;
      }).length);

    if (depsPendientes.length === 0) {
      Logger.log("✅ Todas las aulas ya tienen estructura. Usa force:true para recrear.");
      return;
    }

    // ── Procesar batch ────────────────────────────────────────
    var batch       = depsPendientes.slice(0, batchSize);
    var nuevasFilas = [];
    var creados     = 0;
    var errores     = 0;
    var omitidos    = 0;

    Logger.log("\n🔨 Procesando " + batch.length + " aulas" +
      (depsPendientes.length > batchSize
        ? " (faltan " + (depsPendientes.length - batchSize) + " para el siguiente batch)"
        : "") + "...");

    var hojaTop = obtenerOCrearDeploymentTopics_(coreSS);

    batch.forEach(function(row) {
      var depID       = row[COL_DEP_.DeploymentID];
      var courseID    = row[COL_DEP_.ClassroomID];
      var subjectCode = row[COL_DEP_.SubjectCode];
      var nomencl     = row[COL_DEP_.GeneratedNomenclature];
      var semanas     = syllabus[subjectCode] || [];

      Logger.log("  → " + nomencl + " (" + semanas.length + " semanas)");

      semanas.forEach(function(s) {
        var weekKey   = depID + "_" + s.semana;
        var topicName = "Semana " + s.semana + " · " + s.tema;
        var topicRowID = "top_" + Utilities.getUuid().replace(/-/g, "");

        // Idempotencia: omitir si ya existe y no es force
        if (!force && depTopics[weekKey]) {
          omitidos++;
          return;
        }

        if (dryRun) {
          Logger.log("    [DRY] " + topicName);
          nuevasFilas.push([
            topicRowID, depID, courseID, "DRY_RUN_NO_ID",
            subjectCode, s.semana, topicName, "TOPICS_CREATED",
            0, 0, "",
            ahora, ejecutor, "", ""
          ]);
          creados++;
          return;
        }

        // ── Llamada a Classroom API ──────────────────────────
        try {
          var topic = Classroom.Courses.Topics.create(
            { name: topicName },
            courseID
          );

          nuevasFilas.push([
            topicRowID,
            depID,
            courseID,
            topic.topicId,  // ID devuelto por Classroom — necesario para Fase 2
            subjectCode,
            s.semana,
            topicName,
            "TOPICS_CREATED",
            0, 0, "",       // CourseWorkCount, MaterialCount, AssignmentIDs — Fase 2
            ahora, ejecutor, "", ""
          ]);
          creados++;

          Utilities.sleep(150); // Pausa cortés — evita throttling de la API

        } catch (apiErr) {
          errores++;
          // Registrar error sin detener el batch.
          // AssignmentIDs (col 10) almacena el mensaje de error en Fase 1 —
          // es el único campo de texto libre disponible (ver COL_TOP_.AssignmentIDs).
          nuevasFilas.push([
            topicRowID, depID, courseID, "",
            subjectCode, s.semana, topicName, "STRUCTURE_ERROR",
            0, 0, apiErr.message.substring(0, 200),
            ahora, ejecutor, "", ""
          ]);
          Logger.log("    ❌ Error semana " + s.semana + ": " + apiErr.message);
        }
      });
    });

    // ── Escritura en batch — una sola llamada para todo el batch ─
    // A diferencia de crearAulas(), aquí SÍ podemos hacer batch porque
    // acumulamos topicIds en memoria durante el forEach antes de escribir.
    if (!dryRun && nuevasFilas.length > 0) {
      hojaTop.getRange(hojaTop.getLastRow() + 1, 1, nuevasFilas.length, nuevasFilas[0].length)
             .setValues(nuevasFilas);
    } else if (dryRun && nuevasFilas.length > 0) {
      Logger.log("  [DRY] Se habrían escrito " + nuevasFilas.length + " filas en DeploymentTopics");
    }

    var dur       = ((Date.now() - t0) / 1000).toFixed(1);
    var restantes = depsPendientes.length - batch.length;

    Logger.log("\n════════════════════════════════════════════════");
    Logger.log("✅ estructurarAulas completado en " + dur + "s");
    Logger.log("   Topics creados : " + creados);
    Logger.log("   Errores        : " + errores);
    Logger.log("   Omitidos (OK)  : " + omitidos);
    Logger.log("   Filas escritas : " + nuevasFilas.length);
    if (restantes > 0) {
      Logger.log("   ⏭  Quedan " + restantes + " aulas — ejecutar estructurarAulas() de nuevo");
    } else {
      Logger.log("   🎉 Todas las aulas del batch estructuradas");
    }
    if (errores > 0) {
      Logger.log("   ⚠️  " + errores + " errores — ver DeploymentTopics (STRUCTURE_ERROR)");
      Logger.log("      Reintento: estructurarAulas({ force: true, programCode: '...' })");
    }
    Logger.log("⏭  SIGUIENTE: 06_importarEstudiantes.gs");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("❌ ERROR CRÍTICO en estructurarAulas: " + e.message);
    throw e;
  }
}


// ─────────────────────────────────────────────────────────────
// FUNCIÓN 2 — DIAGNÓSTICO
// ─────────────────────────────────────────────────────────────

/**
 * Muestra el estado actual de estructuración sin modificar nada.
 * Útil para revisar progreso entre corridas y detectar errores pendientes.
 * Lee MasterDeployments y DeploymentTopics en una sola llamada batch cada uno.
 */
function diagnosticoEstructura() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔍 SIDEP — Diagnóstico de Estructura de Aulas");
  Logger.log("════════════════════════════════════════════════");

  try {
    var coreSS = getSpreadsheetByName("core");

    // ── MasterDeployments — lectura única en batch ────────────
    // v1.2 leía MasterDeployments dos veces (totalCreated + sinEstructura).
    // v1.3 la lee una sola vez y acumula ambos conteos en el mismo forEach.
    var hojaDep      = coreSS.getSheetByName("MasterDeployments");
    var lastDep      = hojaDep.getLastRow();
    var totalCreated = 0;
    var conEstructura = {};   // { DeploymentID → true } — se llena con DeploymentTopics abajo

    var depRows = lastDep > 1
      ? hojaDep.getRange(2, 1, lastDep - 1, 13).getValues()
      : [];

    depRows.forEach(function(r) { if (r[12] === "CREATED") totalCreated++; });

    // ── DeploymentTopics — contar por estado ──────────────────
    var hojaTop = coreSS.getSheetByName("DeploymentTopics");
    var lastTop = hojaTop ? hojaTop.getLastRow() : 1;
    var conteo  = { TOPICS_CREATED: 0, FULL: 0, STRUCTURE_ERROR: 0, STRUCTURE_PENDING: 0 };

    if (lastTop > 1) {
      hojaTop.getRange(2, 1, lastTop - 1, 15).getValues()
        .forEach(function(r) {
          var status = r[COL_TOP_.StructureStatusCode];
          conteo[status] = (conteo[status] || 0) + 1;
          conEstructura[r[COL_TOP_.DeploymentID]] = true; // acumular para AVANCE
        });
    }

    Logger.log("\n📊 DEPLOYMENTS:");
    Logger.log("   Aulas CREATED en MasterDeployments : " + totalCreated);

    Logger.log("\n📊 TOPICS EN DeploymentTopics:");
    Logger.log("   Total filas         : " + (lastTop - 1));
    Logger.log("   ✅ TOPICS_CREATED   : " + (conteo.TOPICS_CREATED   || 0));
    Logger.log("   🌟 FULL (Fase 2)    : " + (conteo.FULL             || 0));
    Logger.log("   ❌ STRUCTURE_ERROR  : " + (conteo.STRUCTURE_ERROR  || 0));
    Logger.log("   ⬜ PENDING          : " + (conteo.STRUCTURE_PENDING || 0));

    // ── Avance — usando depRows ya leídas (sin segunda llamada a Sheets) ─
    var sinEstructura = depRows.filter(function(r) {
      return r[12] === "CREATED" && !conEstructura[r[0]];
    }).length;

    Logger.log("\n📊 AVANCE:");
    Logger.log("   Aulas sin estructura aún : " + sinEstructura);
    Logger.log("   Aulas ya estructuradas   : " + (totalCreated - sinEstructura));
    if (totalCreated > 0) {
      var pct = Math.round(((totalCreated - sinEstructura) / totalCreated) * 100);
      Logger.log("   Progreso                 : " + pct + "%");
    }

    // ── Detalle de errores ────────────────────────────────────
    if (conteo.STRUCTURE_ERROR > 0) {
      Logger.log("\n⚠️  TOPICS CON ERROR (primeras 5):");
      var errCount = 0;
      // Reusar los datos de hojaTop ya leídos si el volumen lo permite,
      // o hacer segunda lectura solo cuando hay errores que reportar.
      hojaTop.getRange(2, 1, lastTop - 1, 15).getValues()
        .forEach(function(r) {
          if (r[COL_TOP_.StructureStatusCode] === "STRUCTURE_ERROR" && errCount < 5) {
            // AssignmentIDs (col 10) contiene el mensaje de error en Fase 1
            Logger.log("   ❌ " + r[COL_TOP_.TopicName] + " → " +
                       String(r[COL_TOP_.AssignmentIDs]).substring(0, 80));
            errCount++;
          }
        });
      Logger.log("   → Reintento: estructurarAulas({ force: true })");
    }

    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("❌ ERROR en diagnosticoEstructura: " + e.message);
  }
}


// ─────────────────────────────────────────────────────────────
// HELPERS PRIVADOS
// ─────────────────────────────────────────────────────────────

/**
 * Obtiene la hoja DeploymentTopics de coreSS.
 * Si no existe (setupSidepTables se ejecutó con un schema anterior a v3.5.0),
 * la crea con el header y estilo institucional definidos en CORE_TABLES.
 * El script es autónomo — no requiere re-ejecutar setupSidepTables. (FIX-02 v1.2)
 */
function obtenerOCrearDeploymentTopics_(coreSS) {
  var hoja = coreSS.getSheetByName("DeploymentTopics");
  if (hoja) return hoja;

  Logger.log("  ⚠️  DeploymentTopics no encontrada — creando con schema de CORE_TABLES...");

  hoja     = coreSS.insertSheet("DeploymentTopics");
  var cols = CORE_TABLES["DeploymentTopics"];
  var s    = SIDEP_CONFIG.headerStyle;

  hoja.getRange(1, 1, 1, cols.length)
      .setValues([cols])
      .setBackground(s.background)
      .setFontColor(s.fontColor)
      .setFontWeight(s.fontWeight);
  hoja.setFrozenRows(1);
  hoja.autoResizeColumns(1, cols.length);

  Logger.log("  ✅ DeploymentTopics creada con " + cols.length + " columnas");
  return hoja;
}

/**
 * Lee _CFG_SYLLABUS (en SIDEP_02_GESTION_ADMIN) y retorna el mapa:
 *   { SubjectCode → [ { semana: N, tema: "..." }, ... ] }
 * Ordenado por WeekNumber ASC. Una sola llamada batch a la API de Sheets.
 *
 * ⚠️  RECIBE adminSS (no coreSS) — _CFG_SYLLABUS vive en ADMIN.
 *     03_poblarSyllabus.gs escribe en getSpreadsheetByName("admin"). (FIX-01 v1.1)
 *
 * Columnas de _CFG_SYLLABUS (0-base):
 *   [0] SyllabusID | [1] SubjectCode | [2] WeekNumber | [3] WeekTitle |
 *   [4] Contents   | [5] Activity    | [6] Product    | [7] Status
 */
function leerSyllabus_(adminSS) {
  var hoja = adminSS.getSheetByName("_CFG_SYLLABUS");
  if (!hoja || hoja.getLastRow() <= 1) {
    throw new Error(
      "_CFG_SYLLABUS vacía en SIDEP_02_GESTION_ADMIN. " +
      "Ejecutar poblarSyllabus() primero."
    );
  }
  var data = hoja.getRange(2, 1, hoja.getLastRow() - 1, 8).getValues();
  var map  = {};

  data.forEach(function(row) {
    var code = row[1]; // SubjectCode
    if (!map[code]) map[code] = [];
    map[code].push({ semana: row[2], tema: String(row[3]) });
  });

  // Ordenar ASC por semana — garantía independiente del orden de escritura en Sheets
  Object.keys(map).forEach(function(code) {
    map[code].sort(function(a, b) { return a.semana - b.semana; });
  });

  return map;
}

/**
 * Lee DeploymentTopics y retorna un mapa de claves de idempotencia:
 *   { "depID_weekN" → true }
 * Lookup O(1) para verificar si un topic ya existe antes de llamar la API.
 * La clave combina DeploymentID + WeekNumber — identifica unívocamente un
 * topic dentro de un aula, incluso si el mismo SubjectCode aparece en
 * múltiples deployments de distintas ventanas.
 * Retorna {} si la hoja está vacía o no existe (primera ejecución).
 */
function leerTopicsExistentes_(coreSS) {
  var hoja = coreSS.getSheetByName("DeploymentTopics");
  if (!hoja || hoja.getLastRow() <= 1) return {};
  var data = hoja.getRange(2, 1, hoja.getLastRow() - 1, 6).getValues();
  var set  = {};
  data.forEach(function(row) {
    var depID = row[COL_TOP_.DeploymentID]; // índice 1
    var weekN = row[COL_TOP_.WeekNumber];   // índice 5
    if (depID && weekN) set[depID + "_" + weekN] = true;
  });
  return set;
}