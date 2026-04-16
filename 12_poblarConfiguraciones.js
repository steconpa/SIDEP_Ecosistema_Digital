/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL
 * Archivo: 12_poblarConfiguraciones.gs
 * Versión: 2.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Poblar las tablas _CFG_* con los catálogos base del sistema.
 *   CERO lógica de estructura — solo datos de configuración.
 *   Los datos de temarios van en 13_poblarSyllabus.gs.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs v3.6.1+  → getSpreadsheetByName(), escribirDatos()
 *   11_setupSidepTables.gs      → debe haberse ejecutado primero (crea las hojas)
 *
 * USO DIRECTO:
 *   poblarConfiguraciones()              — SAFE: salta tablas que ya tienen datos
 *   poblarConfiguraciones({force:true}) — FORCE: limpia y reescribe todo
 *
 * VÍA ORQUESTADOR (recomendado):
 *   paso2_configuraciones()        → SAFE via 99_orquestador.gs
 *   paso2_configuraciones_force()  → FORCE via 99_orquestador.gs
 *
 * CUÁNDO EJECUTAR EN FORCE:
 *   → Al agregar una cohorte nueva (MY26, AG26, SP26 cuando abran)
 *   → Al corregir fechas del calendario académico
 *   → Al agregar materias o programas nuevos
 *   NOTA: force limpia SOLO las tablas _CFG_*, no MasterDeployments ni Teachers.
 *
 * DETECCIÓN DE DATOS EXISTENTES (modo SAFE):
 *   Usa _CFG_STATUSES como proxy — si tiene filas, asume que todas las
 *   tablas _CFG_* están pobladas. Una sola llamada a la API en lugar de
 *   verificar cada tabla individualmente. Ver tablasVacias_().
 *
 * TABLAS QUE PUEBLA (todas en SIDEP_01_CORE_ACADEMICO):
 *   _CFG_MONTH_CODES     → 12 meses (código SP para Septiembre — ver deuda técnica)
 *   _CFG_COHORTS         → 4 activos (EN26/FB26/MR26/AB26) + 3 futuros (MY26/AG26/SP26)
 *   _CFG_PROGRAMS        → 6 programas técnicos + TRV (transversal)
 *   _CFG_MODALITIES      → DIR (Directo ~14 meses) + ART (Articulado ~2 años)
 *   _CFG_MOMENTS         → 6 momentos DIR + 8 bloques ART = 14 total
 *   _CFG_CAMPUSES        → 1 sede (Bogotá) — expandir en Fase 2
 *   _CFG_STATUSES        → 45 estados en 14 tipos (ver detalle abajo)
 *   _CFG_SUBJECTS        → 57 materias (50 COMPLETO + 7 PENDIENTE — ver syllabus)
 *   _CFG_COHORT_CALENDAR → 38 períodos (36 confirmados + 2 FB26 pendientes)
 *   _CFG_RECESSES        → 6 recesos 2026-2027 (5 confirmados + 1 aprox)
 *
 * DETALLE _CFG_STATUSES — 45 estados en 14 tipos:
 *   DEPLOYMENT    (4): PENDING, CREATED, ERROR, ARCHIVED
 *   RISK          (3): GREEN, YELLOW, RED
 *   ENROLLMENT    (7): ACTIVE, DROPPED, COMPLETED, GRADUATED, WITHDRAWN,
 *                       FAILED, PENDING_RETRY
 *   DEBT          (3): DEBT_PENDING, DEBT_IN_RETRY, DEBT_CLEARED
 *   CONTRACT      (2): HORA_CATEDRA, PLANTA
 *   PRIORITY      (3): HIGH, MEDIUM, LOW
 *   TASK          (3): TASK_PENDING, TASK_IN_PROGRESS, TASK_DONE
 *   INTERVENTION  (4): CALL, MEETING, EMAIL, ACADEMIC_SUPPORT
 *   TEACHER_STATUS(3): TEACHER_ACTIVE, TEACHER_INACTIVE, TEACHER_ON_LEAVE
 *   CONTACT_TYPE  (3): GUARDIAN, EMERGENCY, PARENT
 *   RECOGNITION_TYPE(3): CONVALIDACION, HOMOLOGACION, TRANSFERENCIA  ← STUB Fase 2
 *   STRUCTURE     (4): TOPICS_CREATED, FULL, STRUCTURE_ERROR, STRUCTURE_PENDING
 *   APERTURA      (3): APR_PENDIENTE, APR_CREADA, APR_CANCELADA        ← v4.0.0
 *   INVITATION    (3): TEACHER_INVITED, TEACHER_ACCEPTED, TEACHER_DECLINED ← v4.1.0
 *
 * HELPER DE FECHAS — función d_(year, month, day):
 *   Crea fechas en America/Bogota vía Utilities.parseDate() en lugar de
 *   new Date(year, month-1, day). Sin este helper, si el proyecto GAS corre
 *   en servidor UTC, las fechas del Semáforo quedan un día antes de lo esperado.
 *   month es 1-based (3 = marzo), no 0-based como en JS nativo.
 *
 * PENDIENTES ACTIVOS (bloquean funcionalidad en producción):
 *   FB26 _CFG_COHORT_CALENDAR: 8 períodos con IsActive=false y fechas "PENDIENTE".
 *   Carlos Triviño debe confirmar el calendario ART antes de activar FB26.
 *   Semana Santa 2027: fecha aproximada — confirmar con MEN antes de feb-2027.
 *
 * DEUDA TÉCNICA:
 *   SP vs SE: este script usa "SP" para Septiembre (estándar del sistema).
 *   Los JSONs del proyecto usan "SE". Unificar en Fase 2 para evitar
 *   discrepancias al cruzar datos entre el script y los JSONs.
 *
 * CAMBIOS v2.0 vs v1.9 — PARCHE _CFG_SUBJECTS (columnas CicloDir + CicloArt):
 *   - poblarSubjects_: PARCHE v4.0 aplicado — escribe 19 columnas (antes 17).
 *     Corrige la desalineación introducida por 00_SIDEP_CONFIG.gs v4.0.0 que
 *     agregó CicloDir y CicloArt entre ProgramCode y DirStartMoment.
 *     01_setupSidepTables ya creaba el header con 19 cols pero poblarSubjects_
 *     solo escribía 17 valores → todo desde col 5 quedaba corrido 2 posiciones.
 *     Síntoma visible: ArtStartBlock mostraba Credits (ej: "2" en vez de "A2B3").
 *     Columnas:
 *       CicloDir = C1 | C2 | C3 — ciclo al que pertenece la materia en ruta DIR
 *       CicloArt = A1 | A2       — año al que pertenece la materia en ruta ART
 *     ⚠️  IMPACTO EN PRODUCCIÓN: ninguno. Los campos afectados son INFORMATIVOS
 *       en v4.0 — APERTURA_PLAN controla las aperturas, no _CFG_SUBJECTS.
 *       Students, Enrollments, MasterDeployments, APERTURA_PLAN: intactos.
 *   - Diagnóstico: corrige check de estados (45→48) y búsqueda de
 *     MasterDeployments en coreSS (no adminSS).
 *   ✅  Acción requerida: poblarConfiguraciones({force:true})
 *
 * CAMBIOS v1.9 vs v1.8 — FB26 calendario ART completo año 1:
 *   - poblarCohortCalendar_: FB26/A1B3 y A1B4 ahora tienen fechas reales.
 *       A1B3: 4-ago-2026 → 25-sep-2026 | ventana AG26 (compartida con DIR C2M2)
 *       A1B4: 29-sep-2026 → 27-nov-2026 | ventana SP26 (compartida con DIR C1M1)
 *              Receso interno: 6-oct → 9-oct (1 semana)
 *   - MODELO POOL documentado: a cada apertura de ventana, Carlos decide
 *     qué asignaturas abrir. ART y DIR pueden compartir la misma aula física
 *     si coinciden en ventana Y materia. El mecanismo es APERTURA_PLAN +
 *     paso2b_cambios_*() — sin cambios de arquitectura.
 *   - Total confirmados: 32→36 (A1B3 + A1B4 de FB26 ahora tienen fechas).
 *     Pendientes: A2B1..A2B4 (año 2027 — 4 bloques).
 *   ✅  Acción requerida: poblarConfiguraciones({force:true})
 *
 * CAMBIOS v1.8 vs v1.6 — AB26 (Articulados Abril 2026 · A1B2):
 *   - poblarCohorts_: +1 cohorte ART activo: AB26 (Abril 2026, ART, IsActive=true).
 *     Ventana que abre las aulas ART-2026-A1B2. Articulados 2026 (ART10+ART11).
 *   - poblarCohortCalendar_: +1 período confirmado:
 *       cal_AB26_A1B2: 7-abr-2026 → 29-may-2026, 8 sem efectivas, sin recesos.
 *       IsActive=true — ya confirmado, no requiere aprobación adicional.
 *     Total períodos: 38→40 (33 confirmados + 6 FB26 pendientes).
 *     FB26/A1B1 y A1B2 ahora tienen fechas reales (históricas y confirmadas).
 *     cal_AB26_A1B2 ELIMINADO — arquitecturalmente incorrecto (AB26 no es cohorte de entrada).
 *   ⚠️  NOTA TRV_Biblia: el archivo SIDEP_TRV_Biblia_v2.json dice ING→A1B1,
 *     pero SIDEP_Contexto_Matriculas_v2.1.json y el mapeo ADM confirman ING→A1B2.
 *     Este script usa A1B2 para ING (fuentes mayoritarias). Corregir TRV_Biblia.
 *   ✅  Acción requerida: poblarConfiguraciones({force:true})
 *       NO toca Students, Enrollments, MasterDeployments ni APERTURA_PLAN.
 *
 * CAMBIOS v1.6 vs v1.5:
 *   - poblarStatuses_: +3 estados tipo INVITATION para TeacherAssignments (v4.1.0).
 *     TEACHER_INVITED, TEACHER_ACCEPTED, TEACHER_DECLINED
 *     Ref: 06_importarDocentes.gs v8 usa Invitations.create() en lugar de
 *     Teachers.create() (no requiere permisos de domain admin).
 *     Total: 42→45 estados, 13→14 tipos.
 *     Acción requerida: poblarConfiguraciones({force:true}).
 *
 * CAMBIOS v1.5 vs v1.4:
 *   - poblarStatuses_: +3 estados tipo APERTURA para APERTURA_PLAN (v4.0.0).
 *     APR_PENDIENTE, APR_CREADA, APR_CANCELADA — referencia canónica para
 *     dropdowns AppSheet (Valid_If WHERE StatusType='APERTURA').
 *     Total: 39→42 estados, 12→13 tipos.
 *     Acción requerida tras este cambio: poblarConfiguraciones({force:true}).
 *
 * CAMBIOS v1.4 vs v1.3:
 *   - nowSIDEP() reemplaza new Date() en el timestamp de ejecución.
 *     new Date() podía registrar UTC en lugar de America/Bogota.
 *   - limpiarTablasConfig_() usa clearContent() (no deleteRows) para
 *     preservar formatos y anchos de columna al hacer force.
 *   - Logger muestra conteo de registros por tabla al terminar.
 *
 * CAMBIOS v1.3 vs v1.2:
 *   - MODELO CONVEYOR BELT ACTIVADO — fechas verificadas vs Cronología_de_grupos.xlsx.
 *   - poblarCohortCalendar_: corrección mayor MR26 + 3 cohortes nuevas (MY26/AG26/SP26).
 *     MR26 tenía C3M1/C3M2 en fechas incorrectas; ahora tiene la nivelación C1M1 en sep-26.
 *   - Total períodos: 38 (antes 19). Eliminada nota "Opción C" en MR26.
 *
 * CAMBIOS v1.2 vs v1.1:
 *   - poblarStatuses_: +4 estados tipo STRUCTURE para DeploymentTopics (05_estructurarAulas).
 *
 * CAMBIOS v1.1 vs v1.0:
 *   - FIX: eliminada variable 'nota' declarada pero nunca usada.
 *   - poblarCohorts_: MR26 IsActive = true (abre 17-mar-2026).
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * Siembra (o re-siembra) ÚNICAMENTE la tabla _CFG_SEMAFORO.
 * No toca ninguna otra tabla _CFG_* ni datos de producción.
 *
 * Úsala cuando poblarConfiguraciones() saltó en modo SAFE porque
 * las otras tablas _CFG_* ya tienen datos, pero _CFG_SEMAFORO está
 * vacía (escenario normal al actualizar el modelo de v4.3.0 a v4.4.0).
 *
 * @param {Object}  [options]
 * @param {boolean} [options.force=false] — true: limpia y reescribe aunque ya tenga datos
 */
function inicializarSemaforoConfig(options) {
  var opts     = options || {};
  var force    = opts.force === true;
  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("⚙️  SIDEP — inicializarSemaforoConfig");
  Logger.log("   Ejecutor : " + ejecutor);
  Logger.log("   Modo     : " + (force ? "FORCE (reescribe)" : "SAFE (salta si existe)"));
  Logger.log("════════════════════════════════════════════════");

  try {
    var coreSS = getSpreadsheetByName("core");
    var hoja   = coreSS.getSheetByName("_CFG_SEMAFORO");

    if (!hoja) {
      Logger.log("❌ Hoja _CFG_SEMAFORO no encontrada.");
      Logger.log("   Ejecuta setupSidepTables() primero (modelo v4.4.0).");
      return;
    }

    // getLastRow() devuelve el total de filas físicas de la hoja aunque estén vacías
    // (Google Sheets crea hojas con 1000 filas por defecto). Se necesita verificar
    // que haya contenido real en ConfigKey (col 2), no solo que existan filas.
    var primeraConfigKey = hoja.getLastRow() > 1
      ? String(hoja.getRange(2, 2).getValue()).trim()
      : "";
    var tieneData = primeraConfigKey !== "";

    if (tieneData && !force) {
      // Leer solo las filas con ConfigKey no vacío para el reporte
      var todasLasFilas = hoja.getRange(2, 1, hoja.getLastRow() - 1, 4).getValues();
      var filasReales   = todasLasFilas.filter(function(r) { return String(r[1]).trim() !== ""; });
      Logger.log("⏭  _CFG_SEMAFORO ya tiene " + filasReales.length + " umbrales — sin cambios.");
      Logger.log("   Umbrales actuales (editar directamente en Sheets si necesitas cambiarlos):");
      filasReales.forEach(function(r) {
        Logger.log("     " + r[1] + " = " + r[2] + "  (" + r[3] + ")");
      });
      Logger.log("   Usa inicializarSemaforoConfig({force:true}) solo si quieres resetear a los defaults.");
      return;
    }

    if (tieneData && force) {
      hoja.getRange(2, 1, hoja.getLastRow() - 1, hoja.getLastColumn()).clearContent();
      Logger.log("  🗑  _CFG_SEMAFORO limpiada.");
    }

    poblarSemaforoConfig_(coreSS, ahora, ejecutor);

    Logger.log("════════════════════════════════════════════════");
    Logger.log("✅ _CFG_SEMAFORO lista — 7 umbrales sembrados.");
    Logger.log("   SIGUIENTE PASO: ejecutar diagnosticarSemaforo()");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("❌ ERROR: " + e.message);
    throw e;
  }
}


/**
 * Pobla todas las tablas _CFG_* del SIDEP_01_CORE_ACADEMICO.
 * @param {Object}  options
 * @param {boolean} options.force — true: limpia y reescribe. Default: false
 */
function poblarConfiguraciones(options) {
  var opts     = options || {};
  var force    = opts.force === true;
  var inicio   = Date.now();
  var ahora    = new Date();
  var ejecutor = Session.getEffectiveUser().getEmail();

  Logger.log("════════════════════════════════════════════════");
  Logger.log("🌱 SIDEP — poblarConfiguraciones v2.0");
  Logger.log("   Ejecutor : " + ejecutor);
  Logger.log("   Modo     : " + (force ? "FORCE (reescribe todo)" : "SAFE (salta si existe)"));
  Logger.log("════════════════════════════════════════════════");

  try {
    var coreSS = getSpreadsheetByName("core");
    Logger.log("📂 Spreadsheet: " + coreSS.getName());

    // Verificar si ya tiene datos (modo seguro)
    if (!force && !tablasVacias_(coreSS)) {
      Logger.log("⏭  Las tablas _CFG_* ya tienen datos.");
      Logger.log("   Usa poblarConfiguraciones({force:true}) para reescribir.");
      return;
    }

    if (force) limpiarTablasConfig_(coreSS);

    // ── Poblar cada tabla ─────────────────────────────────
    poblarMonthCodes_(coreSS, ahora, ejecutor);
    poblarCohorts_(coreSS, ahora, ejecutor);
    poblarPrograms_(coreSS, ahora, ejecutor);
    poblarModalities_(coreSS, ahora, ejecutor);
    poblarMoments_(coreSS, ahora, ejecutor);
    poblarCampuses_(coreSS, ahora, ejecutor);
    poblarStatuses_(coreSS, ahora, ejecutor);
    poblarSubjects_(coreSS, ahora, ejecutor);
    poblarCohortCalendar_(coreSS, ahora, ejecutor);
    poblarRecesses_(coreSS, ahora, ejecutor);
    poblarSemaforoConfig_(coreSS, ahora, ejecutor);

    var duracion = ((Date.now() - inicio) / 1000).toFixed(1);
    Logger.log("════════════════════════════════════════════════");
    Logger.log("✅ poblarConfiguraciones completado en " + duracion + "s");
    Logger.log("⏭  SIGUIENTE PASO: ejecutar poblarSyllabus()");
    Logger.log("════════════════════════════════════════════════");

  } catch (e) {
    Logger.log("❌ ERROR en poblarConfiguraciones: " + e.message);
    throw e;
  }
}


// ─────────────────────────────────────────────────────────────
// HELPER LOCAL — Timezone
// ─────────────────────────────────────────────────────────────

/**
 * Crea un Date en America/Bogota para evitar desfase de 5h con UTC.
 * Problema: new Date(year, month-1, day) usa el timezone del proyecto GAS.
 * Si el proyecto está en UTC, las fechas del Semáforo quedan un día antes.
 * @param {number} year  — ej: 2026
 * @param {number} month — ej: 3 (marzo, NO base-0)
 * @param {number} day   — ej: 17
 */
function d_(year, month, day) {
  var isoLocal = year + "-" +
    (month < 10 ? "0" : "") + month + "-" +
    (day   < 10 ? "0" : "") + day  + "T00:00:00";
  return Utilities.parseDate(isoLocal, "America/Bogota", "yyyy-MM-dd'T'HH:mm:ss");
}


// ─────────────────────────────────────────────────────────────
// HELPERS PRIVADOS DE ESTE SCRIPT
// ─────────────────────────────────────────────────────────────

/**
 * Proxy de detección de datos existentes — verifica solo _CFG_STATUSES.
 * Razón: _CFG_STATUSES siempre se puebla en la misma llamada que el resto.
 * Si tiene filas, es seguro asumir que todas las _CFG_* están pobladas.
 * Una sola llamada a la API de Sheets en lugar de verificar cada tabla.
 * Retorna true si la tabla está vacía (o no existe) → safe para poblar.
 */
function tablasVacias_(ss) {
  var hoja = ss.getSheetByName("_CFG_STATUSES");
  return !hoja || hoja.getLastRow() <= 1;
}

/**
 * Limpia el contenido de todas las hojas _CFG_* del Spreadsheet.
 * Usa clearContent() (no deleteRows): preserva formatos, anchos de columna
 * y checkboxes — solo borra los valores. Seguro de llamar en modo force
 * sin perder la configuración visual de las hojas.
 * Preserva siempre fila 1 (encabezado).
 * NO toca MasterDeployments, Teachers ni ninguna tabla sin prefijo _CFG_.
 */
function limpiarTablasConfig_(ss) {
  ss.getSheets().forEach(function(hoja) {
    if (hoja.getName().indexOf("_CFG_") !== 0) return;
    var lastRow = hoja.getLastRow();
    if (lastRow > 1) {
      hoja.getRange(2, 1, lastRow - 1, hoja.getLastColumn()).clearContent();
      Logger.log("  🗑  Limpiada: " + hoja.getName());
    }
  });
}


// ─────────────────────────────────────────────────────────────
// POBLADORES INDIVIDUALES
// ─────────────────────────────────────────────────────────────

function poblarMonthCodes_(ss, ahora, ejecutor) {
  // SP = Septiembre — estándar del script (JSONs del proyecto usan SE → Fase 2)
  escribirDatos(ss, "_CFG_MONTH_CODES", [
    ["mon_01","EN", 1, "Enero",      true],
    ["mon_02","FB", 2, "Febrero",    true],
    ["mon_03","MR", 3, "Marzo",      true],
    ["mon_04","AB", 4, "Abril",      true],
    ["mon_05","MY", 5, "Mayo",       true],
    ["mon_06","JN", 6, "Junio",      true],
    ["mon_07","JL", 7, "Julio",      true],
    ["mon_08","AG", 8, "Agosto",     true],
    ["mon_09","SP", 9, "Septiembre", true],
    ["mon_10","OC",10, "Octubre",    true],
    ["mon_11","NV",11, "Noviembre",  true],
    ["mon_12","DC",12, "Diciembre",  true]
  ]);
}

function poblarCohorts_(ss, ahora, ejecutor) {
  // VENTANAS 2026 — DIR y ART:
  //   EN26 (DIR): C1M1 desde 20-ene. Activo.
  //   FB26 (ART): ventana A1B1 desde 3-feb. Activo.
  //   MR26 (DIR): C1M2 desde 17-mar. Activo.
  //   AB26 (ART): ventana A1B2 desde 7-abr. Activo.
  //   MY26 (DIR): C2M1 desde 19-may. Inactivo hasta apertura.
  //   AG26 (DIR+ART): C2M2 DIR + A1B3 ART desde 4-ago. Activo — ventana compartida.
  //   SP26 (DIR+ART): C1M1 DIR + A1B4 ART desde 29-sep. Activo — ventana compartida.
  //                  Pool: Carlos decide si ART comparte aulas con DIR.
  escribirDatos(ss, "_CFG_COHORTS", [
    ["coh_FB25","FB25","Febrero 2025",    2025,"DIR",true, "","",ahora,ejecutor,"",""],
    ["coh_EN26","EN26","Enero 2026",      2026,"DIR",true, "","",ahora,ejecutor,"",""],
    ["coh_FB26","FB26","Febrero 2026",    2026,"ART",true, "","",ahora,ejecutor,"",""],
    ["coh_MR26","MR26","Marzo 2026",      2026,"DIR",true, "","",ahora,ejecutor,"",""],
    ["coh_AB26","AB26","Abril 2026",      2026,"ART",true, "","",ahora,ejecutor,"",""],  // ventana aulas ART-2026-A1B2
    ["coh_MY26","MY26","Mayo 2026",       2026,"DIR",false,"","",ahora,ejecutor,"",""],
    ["coh_AG26","AG26","Agosto 2026",     2026,"DIR",true, "","",ahora,ejecutor,"",""],  // ART A1B3 (4-ago) + DIR C2M2 (4-ago) — ventana compartida
    ["coh_SP26","SP26","Septiembre 2026", 2026,"DIR",true, "","",ahora,ejecutor,"",""]   // ART A1B4 (29-sep) + DIR C1M1 (29-sep) — ventana compartida. Pool: Carlos decide aulas comunes.
  ]);
}

function poblarPrograms_(ss, ahora, ejecutor) {
  escribirDatos(ss, "_CFG_PROGRAMS", [
    ["prg_CTB","CTB","Técnico Laboral Auxiliar Contable",                          true,ahora,ejecutor,"",""],
    ["prg_ADM","ADM","Técnico Laboral Auxiliar Administrativo",                     true,ahora,ejecutor,"",""],
    ["prg_TLC","TLC","Técnico Laboral en Telecomunicaciones",                       true,ahora,ejecutor,"",""],
    ["prg_SIS","SIS","Técnico Laboral en Sistemas con Énfasis en Programación",    true,ahora,ejecutor,"",""],
    ["prg_MKT","MKT","Técnico Laboral en Marketing Digital",                       true,ahora,ejecutor,"",""],
    ["prg_SST","SST","Técnico Laboral en Seguridad y Salud en el Trabajo",        true,ahora,ejecutor,"",""],
    ["prg_TRV","TRV","Transversal (compartida todos los programas)",               true,ahora,ejecutor,"",""]
  ]);
}

function poblarModalities_(ss, ahora, ejecutor) {
  escribirDatos(ss, "_CFG_MODALITIES", [
    ["mod_DIR","DIR","Directo (~14 meses)", true,ahora,ejecutor,"",""],
    ["mod_ART","ART","Articulado (~2 años)",true,ahora,ejecutor,"",""]
  ]);
}

function poblarMoments_(ss, ahora, ejecutor) {
  // 6 momentos DIR + 8 bloques ART = 14 filas
  // Mapeo equivalencia DIR ↔ ART:
  //   C1M1 ↔ A1B1+A1B2  |  C1M2 ↔ A1B3+A1B4
  //   C2M1 ↔ A2B1+A2B2  |  C2M2 ↔ A2B3+A2B4
  //   C3   ↔ A2B4 (PRL/TFG)
  escribirDatos(ss, "_CFG_MOMENTS", [
    ["mom_C1M1","C1M1","Cuatrimestre 1 Momento 1",1,"DIR",true,ahora,ejecutor,"",""],
    ["mom_C1M2","C1M2","Cuatrimestre 1 Momento 2",2,"DIR",true,ahora,ejecutor,"",""],
    ["mom_C2M1","C2M1","Cuatrimestre 2 Momento 1",3,"DIR",true,ahora,ejecutor,"",""],
    ["mom_C2M2","C2M2","Cuatrimestre 2 Momento 2",4,"DIR",true,ahora,ejecutor,"",""],
    ["mom_C3M1","C3M1","Cuatrimestre 3 Momento 1",5,"DIR",true,ahora,ejecutor,"",""],
    ["mom_C3M2","C3M2","Cuatrimestre 3 Momento 2",6,"DIR",true,ahora,ejecutor,"",""],
    ["mom_A1B1","A1B1","Año 1 · Bloque 1",        1,"ART",true,ahora,ejecutor,"",""],
    ["mom_A1B2","A1B2","Año 1 · Bloque 2",        2,"ART",true,ahora,ejecutor,"",""],
    ["mom_A1B3","A1B3","Año 1 · Bloque 3",        3,"ART",true,ahora,ejecutor,"",""],
    ["mom_A1B4","A1B4","Año 1 · Bloque 4",        4,"ART",true,ahora,ejecutor,"",""],
    ["mom_A2B1","A2B1","Año 2 · Bloque 1",        5,"ART",true,ahora,ejecutor,"",""],
    ["mom_A2B2","A2B2","Año 2 · Bloque 2",        6,"ART",true,ahora,ejecutor,"",""],
    ["mom_A2B3","A2B3","Año 2 · Bloque 3",        7,"ART",true,ahora,ejecutor,"",""],
    ["mom_A2B4","A2B4","Año 2 · Bloque 4",        8,"ART",true,ahora,ejecutor,"",""]
  ]);
}

function poblarCampuses_(ss, ahora, ejecutor) {
  escribirDatos(ss, "_CFG_CAMPUSES", [
    ["cmp_BOG","BOGOTA","Sede Bogotá","Bogotá D.C.",true,ahora,ejecutor,"",""]
  ]);
}

function poblarStatuses_(ss, ahora, ejecutor) {
  // 42 estados en 13 tipos (39 originales + 3 APERTURA añadidos en v4.0.0)
  // NOTA: PENDING_RETRY aparece en ENROLLMENT (estado de matrícula)
  //       DEBT_PENDING es el equivalente en tipo DEBT (estado de la deuda)
  //       Son conceptos distintos con IDs distintos
  escribirDatos(ss, "_CFG_STATUSES", [
    // ── DEPLOYMENT — estados de creación de aulas ──────────────
    ["sts_PEND", "PENDING",          "Pendiente de crear",       "DEPLOYMENT",      1,true,ahora,ejecutor,"",""],
    ["sts_CREA", "CREATED",          "Aula creada OK",           "DEPLOYMENT",      2,true,ahora,ejecutor,"",""],
    ["sts_ERR",  "ERROR",            "Error al crear",           "DEPLOYMENT",      3,true,ahora,ejecutor,"",""],
    ["sts_ARCH", "ARCHIVED",         "Aula archivada",           "DEPLOYMENT",      4,true,ahora,ejecutor,"",""],
    // ── RISK — semáforo académico ──────────────────────────────
    ["sts_GRN",  "GREEN",            "Sin riesgo",               "RISK",            1,true,ahora,ejecutor,"",""],
    ["sts_YLW",  "YELLOW",           "Riesgo moderado",          "RISK",            2,true,ahora,ejecutor,"",""],
    ["sts_RED",  "RED",              "Riesgo alto",              "RISK",            3,true,ahora,ejecutor,"",""],
    // ── ENROLLMENT — estado de matrícula ──────────────────────
    ["sts_ACT",  "ACTIVE",           "Activo",                   "ENROLLMENT",      1,true,ahora,ejecutor,"",""],
    ["sts_DRP",  "DROPPED",          "Retirado",                 "ENROLLMENT",      2,true,ahora,ejecutor,"",""],
    ["sts_CMP",  "COMPLETED",        "Completado",               "ENROLLMENT",      3,true,ahora,ejecutor,"",""],
    ["sts_GRAD", "GRADUATED",        "Graduado",                 "ENROLLMENT",      4,true,ahora,ejecutor,"",""],
    ["sts_With", "WITHDRAWN",        "Retirado voluntario",      "ENROLLMENT",      5,true,ahora,ejecutor,"",""],
    ["sts_FAIL", "FAILED",           "Reprobada",                "ENROLLMENT",      6,true,ahora,ejecutor,"",""],
    ["sts_ENPR", "PENDING_RETRY",    "Pendiente de reintento",   "ENROLLMENT",      7,true,ahora,ejecutor,"",""],
    // ── DEBT — estado de deuda académica ──────────────────────
    // DEBT_PENDING:  reprobó, sin aula de reintento asignada aún
    // DEBT_IN_RETRY: ya matriculado en aula de reintento
    // DEBT_CLEARED:  aprobó el reintento — deuda saldada
    ["sts_DBPR", "DEBT_PENDING",     "Sin aula de reintento",    "DEBT",            1,true,ahora,ejecutor,"",""],
    ["sts_DBIR", "DEBT_IN_RETRY",    "En reintento activo",      "DEBT",            2,true,ahora,ejecutor,"",""],
    ["sts_DBCL", "DEBT_CLEARED",     "Deuda saldada",            "DEBT",            3,true,ahora,ejecutor,"",""],
    // ── CONTRACT — tipo de contrato docente ───────────────────
    ["sts_HORA", "HORA_CATEDRA",     "Hora cátedra",             "CONTRACT",        1,true,ahora,ejecutor,"",""],
    ["sts_PLAN", "PLANTA",           "Planta",                   "CONTRACT",        2,true,ahora,ejecutor,"",""],
    // ── PRIORITY — prioridad de tareas admin ──────────────────
    ["sts_HIGH", "HIGH",             "Alta",                     "PRIORITY",        1,true,ahora,ejecutor,"",""],
    ["sts_MED",  "MEDIUM",           "Media",                    "PRIORITY",        2,true,ahora,ejecutor,"",""],
    ["sts_LOW",  "LOW",              "Baja",                     "PRIORITY",        3,true,ahora,ejecutor,"",""],
    // ── TASK — estado de tareas administrativas ────────────────
    ["sts_TPND", "TASK_PENDING",     "Pendiente",                "TASK",            1,true,ahora,ejecutor,"",""],
    ["sts_TINP", "TASK_IN_PROGRESS", "En progreso",              "TASK",            2,true,ahora,ejecutor,"",""],
    ["sts_TDNE", "TASK_DONE",        "Completada",               "TASK",            3,true,ahora,ejecutor,"",""],
    // ── INTERVENTION — tipo de intervención de riesgo ─────────
    ["sts_ICLL", "CALL",             "Llamada telefónica",       "INTERVENTION",    1,true,ahora,ejecutor,"",""],
    ["sts_IMET", "MEETING",          "Reunión presencial",       "INTERVENTION",    2,true,ahora,ejecutor,"",""],
    ["sts_IEMA", "EMAIL",            "Correo electrónico",       "INTERVENTION",    3,true,ahora,ejecutor,"",""],
    ["sts_ISUP", "ACADEMIC_SUPPORT", "Apoyo académico",          "INTERVENTION",    4,true,ahora,ejecutor,"",""],
    // ── TEACHER_STATUS — estado del docente ───────────────────
    ["sts_TACT", "TEACHER_ACTIVE",   "Docente activo",           "TEACHER_STATUS",  1,true,ahora,ejecutor,"",""],
    ["sts_TINA", "TEACHER_INACTIVE", "Docente inactivo",         "TEACHER_STATUS",  2,true,ahora,ejecutor,"",""],
    ["sts_TOLV", "TEACHER_ON_LEAVE", "En licencia",              "TEACHER_STATUS",  3,true,ahora,ejecutor,"",""],
    // ── CONTACT_TYPE — tipo de contacto estudiantil ───────────
    ["sts_CGUN", "GUARDIAN",         "Acudiente legal",          "CONTACT_TYPE",    1,true,ahora,ejecutor,"",""],
    ["sts_CEMG", "EMERGENCY",        "Contacto de emergencia",   "CONTACT_TYPE",    2,true,ahora,ejecutor,"",""],
    ["sts_CPAR", "PARENT",           "Padre / Madre",            "CONTACT_TYPE",    3,true,ahora,ejecutor,"",""],
    // ── RECOGNITION_TYPE — tipo de convalidación (STUB Fase 2) ─
    ["sts_RCON", "CONVALIDACION",    "Convalidación",            "RECOGNITION_TYPE",1,true,ahora,ejecutor,"",""],
    ["sts_RHOM", "HOMOLOGACION",     "Homologación",             "RECOGNITION_TYPE",2,true,ahora,ejecutor,"",""],
    ["sts_RTRA", "TRANSFERENCIA",    "Transferencia externa",    "RECOGNITION_TYPE",3,true,ahora,ejecutor,"",""],
    // ── STRUCTURE — estado de estructura pedagógica del aula ───
    // Usados por DeploymentTopics (05_estructurarAulas.gs)
    // Fase 1: TOPICS_CREATED es el estado final esperado
    // Fase 2: FULL cuando CourseWork y Materials también están cargados
    ["sts_STOP", "TOPICS_CREATED",   "Topics creados (Fase 1)",  "STRUCTURE",       1,true,ahora,ejecutor,"",""],
    ["sts_SFULL","FULL",             "Estructura completa (F2)", "STRUCTURE",       2,true,ahora,ejecutor,"",""],
    ["sts_SERR", "STRUCTURE_ERROR",  "Error al crear estructura","STRUCTURE",       3,true,ahora,ejecutor,"",""],
    ["sts_SPND", "STRUCTURE_PENDING","Pendiente de estructurar", "STRUCTURE",       4,true,ahora,ejecutor,"",""],
    // ── APERTURA — estado de decisiones en APERTURA_PLAN (v4.0.0) ─
    // Usados por 12b_poblarAperturas.gs y 14_crearAulas.gs.
    // Los scripts escriben 'PENDIENTE'/'CREADA'/'CANCELADA' directamente
    // en APERTURA_PLAN.AperturaStatus. Estos StatusCodes con prefijo APR_
    // son la referencia canónica para dropdowns en AppSheet (Valid_If sobre
    // _CFG_STATUSES WHERE StatusType='APERTURA').
    ["sts_APRP", "APR_PENDIENTE",    "Apertura pendiente",       "APERTURA",        1,true,ahora,ejecutor,"",""],
    ["sts_APRC", "APR_CREADA",       "Apertura creada",          "APERTURA",        2,true,ahora,ejecutor,"",""],
    ["sts_APRX", "APR_CANCELADA",    "Apertura cancelada",       "APERTURA",        3,true,ahora,ejecutor,"",""],
    // ── INVITATION — estado de invitaciones a docentes (v4.1.0) ───
    // Usados por TeacherAssignments.InvitationStatus (06_importarDocentes.gs v8+).
    // Google Workspace sin permisos de domain admin no permite Teachers.create()
    // directo — se usa Invitations.create() y el docente debe aceptar por email.
    // TEACHER_INVITED:  invitación enviada, docente no ha respondido aún.
    // TEACHER_ACCEPTED: docente aceptó — actualizar manualmente en Fase 1.
    // TEACHER_DECLINED: docente rechazó — reenviar o asignar otro docente.
    ["sts_INVT", "TEACHER_INVITED",  "Invitación enviada",       "INVITATION",      1,true,ahora,ejecutor,"",""],
    ["sts_INVA", "TEACHER_ACCEPTED", "Invitación aceptada",      "INVITATION",      2,true,ahora,ejecutor,"",""],
    ["sts_INVD", "TEACHER_DECLINED", "Invitación rechazada",     "INVITATION",      3,true,ahora,ejecutor,"",""]
  ]);
  Logger.log("    📊 _CFG_STATUSES → 45 estados en 14 tipos (INVITATION añadido v4.1.0)");
}

function poblarSubjects_(ss, ahora, ejecutor) {
  // 57 materias validadas contra MALLA_CURRICULAR_2026_.xlsx
  // Columnas: [SubjectID, SubjectCode, SubjectName, ProgramCode,
  //   DirStartMoment, DirEndMoment, ArtStartBlock, ArtEndBlock,
  //   Credits, Hours, IsTransversal, IsActive, Notes,
  //   CreatedAt, CreatedBy, UpdatedAt, UpdatedBy]
  var N = "";
  var rows = [
    // ── CTB — 9 específicas ───────────────────────────────────────────────────────
    ["sbj_CTB_FUC","FUC","Fundamentos en Contabilidad",                   "CTB","C1","A1","C1M1","C1M1","A1B1","A1B1",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_CTB_NLV","NLV","Normatividad Legal Vigente en Materia Contable","CTB","C1","A1","C1M1","C1M1","A1B2","A1B2",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_CTB_SPC","SPC","Soportes Contables, Transacc., Codif. y Org.", "CTB","C1","A1","C1M2","C1M2","A1B3","A1B4",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_CTB_IBF","IBF","Introducción a los Balances Financieros NIIF",  "CTB","C2","A2","C2M1","C2M1","A2B1","A2B1",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_CTB_SIC","SIC","Sistemas de Información Contable",              "CTB","C2","A2","C2M1","C2M1","A2B1","A2B1",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_CTB_COP","COP","Costos y Presupuestos",                         "CTB","C2","A2","C2M1","C2M1","A2B2","A2B2",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_CTB_DTI","DTI","Declaraciones Tributarias (Impuestos)",         "CTB","C2","A2","C2M2","C2M2","A2B3","A2B3",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_CTB_LNG","LNG","Liquidación de Nómina y Gestión Documental",   "CTB","C2","A2","C2M2","C2M2","A2B3","A2B3",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_CTB_CET","CET","Contabilidad y Ética",                          "CTB","C2","A2","C2M2","C2M2","A2B4","A2B4",2,32,false,true,N,ahora,ejecutor,"",""],
    // ── ADM — 9 específicas ───────────────────────────────────────────────────────
    ["sbj_ADM_FUA","FUA","Fundamentos de la Administración",              "ADM","C1","A1","C1M1","C1M1","A1B1","A1B1",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_ADM_HCD","HCD","Habilidades Comunicativas y de Dirección",      "ADM","C1","A1","C1M1","C1M1","A1B2","A1B2",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_ADM_HID","HID","Herramientas Informáticas para Gestión Datos",  "ADM","C1","A1","C1M2","C1M2","A1B3","A1B3",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_ADM_BFA","BFA","Balances Financieros y Análisis de Resultados", "ADM","C2","A2","C2M1","C2M1","A2B1","A2B1",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_ADM_GSC","GSC","Gestión del Servicio al Cliente",               "ADM","C2","A2","C2M1","C2M1","A2B1","A2B1",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_ADM_CYP","CYP","Costos y Presupuestos",                         "ADM","C2","A2","C2M1","C2M1","A2B2","A2B2",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_ADM_GDR","GDR","Gestión Documental",                            "ADM","C2","A2","C2M2","C2M2","A2B3","A2B3",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_ADM_RIN","RIN","Registros de Info., Normativa y Proced. Admin.","ADM","C2","A2","C2M2","C2M2","A2B3","A2B3",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_ADM_GEN","GEN","Generación de Nómina",                          "ADM","C2","A2","C2M2","C2M2","A2B4","A2B4",2,32,false,true,N,ahora,ejecutor,"",""],
    // ── TLC — 8 específicas ───────────────────────────────────────────────────────
    ["sbj_TLC_FUT","FUT","Fundamentos de las Telecomunicaciones",         "TLC","C1","A1","C1M1","C1M1","A1B1","A1B1",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_TLC_CAB","CAB","Cableado Estructurado e Inst. de Redes",        "TLC","C1","A1","C1M1","C1M1","A1B2","A1B2",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_TLC_FOT","FOT","Instalación de Redes de Fibra Óptica",          "TLC","C1","A1","C1M2","C1M2","A1B3","A1B4",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_TLC_IRA","IRA","Inst. Redes Inalámbricas y Admin. de Redes",   "TLC","C2","A2","C2M1","C2M1","A2B1","A2B1",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_TLC_PRE","PRE","Principios de Enrutamiento y Redes Comunic.",   "TLC","C2","A2","C2M1","C2M1","A2B2","A2B2",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_TLC_ITS","ITS","Infraestructura Telecom. y Servicio Satelital", "TLC","C2","A2","C2M2","C2M2","A2B3","A2B3",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_TLC_TAL","TAL","Trabajo en Alturas (Técnicas)",                 "TLC","C2","A2","C2M2","C2M2","A2B3","A2B3",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_TLC_MAO","MAO","Matemáticas Operativas",                        "TLC","C2","A2","C2M2","C2M2","A2B4","A2B4",3,48,false,true,N,ahora,ejecutor,"",""],
    // ── SIS — 8 específicas ───────────────────────────────────────────────────────
    ["sbj_SIS_FDP","FDP","Fundamentos de Programación",                   "SIS","C1","A1","C1M1","C1M1","A1B1","A1B1",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SIS_BDA","BDA","Bases de Datos — Algoritmos",                   "SIS","C1","A1","C1M1","C1M1","A1B2","A1B2",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SIS_EXC","EXC","Herramientas Informáticas Excel",               "SIS","C1","A1","C1M2","C1M2","A1B3","A1B4",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SIS_FRN","FRN","Frontend",                                      "SIS","C2","A2","C2M1","C2M1","A2B1","A2B1",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SIS_DPW","DPW","Desarrollo Página Web",                         "SIS","C2","A2","C2M1","C2M1","A2B2","A2B2",3,48,false,true,"[SYLLABUS PENDIENTE]",ahora,ejecutor,"",""],
    ["sbj_SIS_MPE","MPE","Mantenimiento Preventivo de Equipos",           "SIS","C2","A2","C2M2","C2M2","A2B3","A2B3",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SIS_PAI","PAI","Programación Aplicada en la Industria",         "SIS","C2","A2","C2M2","C2M2","A2B3","A2B3",2,32,false,true,"[SYLLABUS PENDIENTE]",ahora,ejecutor,"",""],
    ["sbj_SIS_BCK","BCK","Backend",                                       "SIS","C2","A2","C2M2","C2M2","A2B4","A2B4",3,48,false,true,N,ahora,ejecutor,"",""],
    // ── MKT — 8 específicas ───────────────────────────────────────────────────────
    ["sbj_MKT_FMK","FMK","Fundamentos del Marketing",                     "MKT","C1","A1","C1M1","C1M1","A1B1","A1B1",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_MKT_TNM","TNM","Técnicas de Neuromarketing",                    "MKT","C1","A1","C1M1","C1M1","A1B2","A1B2",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_MKT_CRC","CRC","Cultura de la Creatividad",                     "MKT","C1","A1","C1M2","C1M2","A1B3","A1B4",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_MKT_RSC","RSC","Redes Sociales",                                "MKT","C2","A2","C2M1","C2M1","A2B1","A2B1",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_MKT_SEO","SEO","SEO — Optimización para Motores de Búsqueda",  "MKT","C2","A2","C2M1","C2M1","A2B2","A2B2",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_MKT_ANW","ANW","Analítica Web",                                 "MKT","C2","A2","C2M2","C2M2","A2B3","A2B3",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_MKT_SEM","SEM","SEM — Marketing en Motores de Búsqueda",       "MKT","C2","A2","C2M2","C2M2","A2B3","A2B3",2,32,false,true,"[SYLLABUS PENDIENTE]",ahora,ejecutor,"",""],
    ["sbj_MKT_MDA","MDA","Marketing Digital Avanzado",                    "MKT","C2","A2","C2M2","C2M2","A2B4","A2B4",3,48,false,true,"[SYLLABUS PENDIENTE]",ahora,ejecutor,"",""],
    // ── SST — 8 específicas ───────────────────────────────────────────────────────
    ["sbj_SST_FST","FST","Fundamentos de SST",                            "SST","C1","A1","C1M1","C1M1","A1B1","A1B1",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SST_LST","LST","Legislación en SST",                            "SST","C1","A1","C1M1","C1M1","A1B2","A1B2",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SST_FDR","FDR","Factores de Riesgos",                           "SST","C1","A1","C1M2","C1M2","A1B3","A1B4",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SST_MPT","MPT","Medicina Preventiva del Trabajo y Enf. Laboral","SST","C2","A2","C2M1","C2M1","A2B1","A2B1",3,48,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SST_HSI","HSI","Higiene y Seguridad Industrial",                "SST","C2","A2","C2M1","C2M1","A2B2","A2B2",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SST_ADO","ADO","Análisis y Diagnóstico Organizacional",         "SST","C2","A2","C2M2","C2M2","A2B3","A2B3",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SST_PBE","PBE","Planes y Brigadas de Emergencia SG-SST",       "SST","C2","A2","C2M2","C2M2","A2B3","A2B3",2,32,false,true,N,ahora,ejecutor,"",""],
    ["sbj_SST_AAR","AAR","Actividades de Alto Riesgo en SST",            "SST","C2","A2","C2M2","C2M2","A2B4","A2B4",3,48,false,true,N,ahora,ejecutor,"",""],
    // ── TRV — 5 completas + 2 pendientes ─────────────────────────────────────────
    ["sbj_TRV_APU","APU","Aprendizaje Autónomo",                          "TRV","C1","A1","C1M1","C1M1","A1B1","A1B1",2,32,true,true,N,ahora,ejecutor,"",""],
    ["sbj_TRV_ING","ING","Inglés Básico (A1 MCER)",                      "TRV","C1","A1","C1M1","C1M1","A1B2","A1B2",3,48,true,true,N,ahora,ejecutor,"",""],
    ["sbj_TRV_MAT","MAT","Matemáticas Básicas",                           "TRV","C1","A1","C1M2","C1M2","A1B3","A1B3",3,48,true,true,N,ahora,ejecutor,"",""],
    ["sbj_TRV_HIA","HIA","Herramientas de IA Aplicadas al Ámbito Laboral","TRV","C1","A1","C1M2","C1M2","A1B4","A1B4",2,32,true,true,N,ahora,ejecutor,"",""],
    ["sbj_TRV_PVE","PVE","Proyecto de Vida y Emprendimiento",             "TRV","C2","A2","C2M1","C2M1","A2B2","A2B2",2,32,true,true,N,ahora,ejecutor,"",""],
    ["sbj_TRV_PRL","PRL","Práctica Laboral",              "TRV","C3","A2","C3M1","C3M2","A2B4","A2B4",6,96,true,true,"[PROTOCOLO PENDIENTE]",ahora,ejecutor,"",""],
    ["sbj_TRV_TFG","TFG","Trabajo Final (Opción de Grado)","TRV","C3","A2","C3M1","C3M2","A2B4","A2B4",2,32,true,true,"[PROTOCOLO PENDIENTE]",ahora,ejecutor,"",""]
  ];
  escribirDatos(ss, "_CFG_SUBJECTS", rows);
  Logger.log("    📚 _CFG_SUBJECTS → " + rows.length + " materias");
}

function poblarCohortCalendar_(ss, ahora, ejecutor) {
  // REGLA DEL SEMÁFORO:
  //   Para derivar el período activo de un estudiante HOY:
  //   → Buscar usando Students.CohortCode (cohorte de ENTRADA — inmutable)
  //   → Filtrar: StartDate <= HOY <= EndDate AND IsActive = true
  //   → El MomentCode resultante es el período activo del estudiante
  //
  // IMPORTANTE — cohorte de entrada vs ventana del aula:
  //   CohortCode aquí = cohorte de ENTRADA del estudiante (EN26, MR26...).
  //   CohortCode en MasterDeployments = ventana que ABRIÓ el classroom.
  //   Son distintos: un estudiante EN26 puede estar cursando en un aula MR26.
  //   El Semáforo usa esta tabla (entrada) para saber en qué momento está,
  //   luego busca el deployment correcto en MasterDeployments.
  //
  // COHORTES QUE COMPARTEN FECHAS:
  //   MY26, AG26 y SP26 coinciden en algunas fechas con cohortes anteriores
  //   (ej: MY26 y MR26 comparten inicio de C2M1 el 19-may-2026).
  //   Esto es correcto: comparten CALENDARIO pero cada uno tiene sus propias aulas.
  //
  // SECUENCIA CONVEYOR BELT confirmada vs Cronología_de_grupos.xlsx:
  //   EN26: C1M1 → C1M2 → C2M1 → C2M2 → C3M1 → C3M2
  //   MR26: C1M2 → C2M1 → C2M2 → C1M1(nivelación) → C3M1 → C3M2
  //   MY26: C2M1 → C2M2 → C1M1(nivel) → C1M2(nivel) → C3M1 → C3M2
  //   AG26: C2M2 → C1M1(nivel) → C1M2(nivel) → C2M1 → C3M1 → C3M2
  //   SP26: C1M1 → C1M2 → C2M1 → C2M2 → C3M1 → C3M2 (igual que EN26)
  //   FB26: ART — A1B1…A2B4 (fechas pendientes — Carlos confirma)

  var rows = [
    // ── EN26 DIR — 6 períodos ────────────────────────────────────────────────────
    ["cal_EN26_C1M1","EN26","C1M1","C1 Momento 1",         d_(2026,1,20), d_(2026,3,13),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_EN26_C1M2","EN26","C1M2","C1 Momento 2",         d_(2026,3,16), d_(2026,5,15),  8,false,true, "Receso: Semana Santa",   ahora,ejecutor,"",""],
    ["cal_EN26_C2M1","EN26","C2M1","C2 Momento 1",         d_(2026,5,19), d_(2026,7,31),  8,false,true, "Receso: Vac. mitad año", ahora,ejecutor,"",""],
    ["cal_EN26_C2M2","EN26","C2M2","C2 Momento 2",         d_(2026,8,3),  d_(2026,9,25),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_EN26_C3M1","EN26","C3M1","C3 Momento 1",         d_(2026,9,28), d_(2026,11,27), 8,false,true, "Receso: Oct 5-9",        ahora,ejecutor,"",""],
    ["cal_EN26_C3M2","EN26","C3M2","C3 Momento 2 (cierre)",d_(2027,1,19), d_(2027,3,12),  8,true, true, "CIERRE PROGRAMA EN26",   ahora,ejecutor,"",""],

    // ── MR26 DIR — 6 períodos ────────────────────────────────────────────────────
    // MR26 entra en C1M2 (no tiene C1M1 en su ventana de entrada).
    // En Sep-2026 hace C1M1 como nivelación (completa lo que no cursó al entrar).
    // C3 solo después de completar C1+C2.
    ["cal_MR26_C1M2","MR26","C1M2","C1 Momento 2",         d_(2026,3,17), d_(2026,5,15),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_MR26_C2M1","MR26","C2M1","C2 Momento 1",         d_(2026,5,19), d_(2026,7,31),  8,false,true, "Receso: Vac. mitad año", ahora,ejecutor,"",""],
    ["cal_MR26_C2M2","MR26","C2M2","C2 Momento 2",         d_(2026,8,4),  d_(2026,9,25),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_MR26_C1M1","MR26","C1M1","C1 Momento 1 (nivel)", d_(2026,9,29), d_(2026,11,27), 8,false,true, "Nivelación | Receso: Oct 5-9", ahora,ejecutor,"",""],
    ["cal_MR26_C3M1","MR26","C3M1","C3 Momento 1",         d_(2027,1,19), d_(2027,3,12),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_MR26_C3M2","MR26","C3M2","C3 Momento 2 (cierre)",d_(2027,3,16), d_(2027,5,14),  8,true, true, "CIERRE PROGRAMA MR26",   ahora,ejecutor,"",""],

    // ── MY26 DIR — 6 períodos ────────────────────────────────────────────────────
    // MY26 entra en C2M1. Luego C2M2, C1M1 y C1M2 (nivelación C1), luego C3.
    ["cal_MY26_C2M1","MY26","C2M1","C2 Momento 1",         d_(2026,5,19), d_(2026,7,31),  8,false,true, "Receso: Vac. mitad año", ahora,ejecutor,"",""],
    ["cal_MY26_C2M2","MY26","C2M2","C2 Momento 2",         d_(2026,8,4),  d_(2026,9,25),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_MY26_C1M1","MY26","C1M1","C1 Momento 1 (nivel)", d_(2026,9,29), d_(2026,11,27), 8,false,true, "Nivelación | Receso: Oct 5-9", ahora,ejecutor,"",""],
    ["cal_MY26_C1M2","MY26","C1M2","C1 Momento 2 (nivel)", d_(2027,1,19), d_(2027,3,12),  8,false,true, "Nivelación C1",          ahora,ejecutor,"",""],
    ["cal_MY26_C3M1","MY26","C3M1","C3 Momento 1",         d_(2027,3,16), d_(2027,5,14),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_MY26_C3M2","MY26","C3M2","C3 Momento 2 (cierre)",d_(2027,5,18), d_(2027,7,30),  8,true, true, "CIERRE PROGRAMA MY26",   ahora,ejecutor,"",""],

    // ── AG26 DIR — 6 períodos ────────────────────────────────────────────────────
    // AG26 entra en C2M2. Luego C1M1+C1M2 (nivelación), C2M1, luego C3.
    ["cal_AG26_C2M2","AG26","C2M2","C2 Momento 2",         d_(2026,8,4),  d_(2026,9,25),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_AG26_C1M1","AG26","C1M1","C1 Momento 1 (nivel)", d_(2026,9,29), d_(2026,11,27), 8,false,true, "Nivelación | Receso: Oct 5-9", ahora,ejecutor,"",""],
    ["cal_AG26_C1M2","AG26","C1M2","C1 Momento 2 (nivel)", d_(2027,1,19), d_(2027,3,12),  8,false,true, "Nivelación C1",          ahora,ejecutor,"",""],
    ["cal_AG26_C2M1","AG26","C2M1","C2 Momento 1",         d_(2027,3,16), d_(2027,5,14),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_AG26_C3M1","AG26","C3M1","C3 Momento 1",         d_(2027,5,18), d_(2027,7,30),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_AG26_C3M2","AG26","C3M2","C3 Momento 2 (cierre)",d_(2027,8,3),  d_(2027,9,24),  8,true, true, "CIERRE PROGRAMA AG26",   ahora,ejecutor,"",""],

    // ── SP26 DIR — 6 períodos ────────────────────────────────────────────────────
    // SP26 entra en C1M1 (igual que EN26 pero 8 meses después).
    ["cal_SP26_C1M1","SP26","C1M1","C1 Momento 1",         d_(2026,9,29), d_(2026,11,27), 8,false,true, "Receso: Oct 5-9",        ahora,ejecutor,"",""],
    ["cal_SP26_C1M2","SP26","C1M2","C1 Momento 2",         d_(2027,1,19), d_(2027,3,12),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_SP26_C2M1","SP26","C2M1","C2 Momento 1",         d_(2027,3,16), d_(2027,5,14),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_SP26_C2M2","SP26","C2M2","C2 Momento 2",         d_(2027,5,18), d_(2027,7,30),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_SP26_C3M1","SP26","C3M1","C3 Momento 1",         d_(2027,8,3),  d_(2027,9,24),  8,false,true, "",                       ahora,ejecutor,"",""],
    ["cal_SP26_C3M2","SP26","C3M2","C3 Momento 2 (cierre)",d_(2027,9,28), d_(2027,11,26), 8,true, true, "CIERRE PROGRAMA SP26",   ahora,ejecutor,"",""],

    // ── FB26 ART — 8 bloques (Año 1 completo confirmado) ────────────────────────────
    //
    // ARQUITECTURA CohortCode:
    //   CohortCode aquí = cohorte de ENTRADA del estudiante = FB26 (siempre).
    //   Las ventanas que CREAN las aulas (FB26, AB26, AG26, SP26) viven en
    //   _CFG_COHORTS y MasterDeployments — NUNCA en este calendario.
    //   El Semáforo busca: WHERE CohortCode=FB26 AND StartDate<=HOY<=EndDate.
    //
    // MODELO POOL (confirmado 25-mar-2026):
    //   A cada ventana, Carlos decide qué asignaturas abrir.
    //   ART y DIR pueden compartir la misma aula física cuando coinciden
    //   en ventana Y materia. El mecanismo es APERTURA_PLAN + paso2b_cambios_*.
    //
    // CALENDARIO AÑO 1 (A1) — COMPLETO:
    //   A1B1: 3-feb → 27-mar-2026 | ventana FB26 | sin recesos
    //         Semana Santa (30-mar→3-abr) en el hueco entre A1B1 y A1B2 — no es receso del bloque
    //   A1B2: 7-abr → 29-may-2026 | ventana AB26 | sin recesos
    //         (vacaciones escolares 2-jun→31-jul en el hueco A1B2→A1B3)
    //   A1B3: 4-ago → 25-sep-2026 | ventana AG26 (compartida DIR C2M2)
    //   A1B4: 29-sep → 27-nov-2026 | ventana SP26 (compartida DIR C1M1)
    //         (receso 6-oct→9-oct dentro del bloque)
    //
    // CALENDARIO AÑO 2 (A2) — PENDIENTE:
    //   A2B1..A2B4: 2027 — fechas pendientes de confirmación.
    ["cal_FB26_A1B1","FB26","A1B1","Año 1 Bloque 1", d_(2026,2,3), d_(2026,3,27), 8,false,true,
     "A1B1 — 3 feb al 27 mar 2026. Sin recesos internos. Semana Santa (30-mar→3-abr) queda en el hueco entre A1B1 y A1B2. Registro histórico — sistema no existía aún.",
     ahora,ejecutor,"",""],
    ["cal_FB26_A1B2","FB26","A1B2","Año 1 Bloque 2", d_(2026,4,7), d_(2026,5,29), 8,false,true,  "A1B2 — 7 abr al 29 may 2026. Sin recesos. Aulas creadas por ventana AB26. Confirmado 25-mar-2026.",         ahora,ejecutor,"",""],
    ["cal_FB26_A1B3","FB26","A1B3","Año 1 Bloque 3", d_(2026,8,4), d_(2026,9,25), 8,false,true,
     "A1B3 — 4 ago al 25 sep 2026. Sin recesos. Ventana AG26 (compartida DIR C2M2). Pool: Carlos decide si ART comparte aula con DIR.",
     ahora,ejecutor,"",""],
    ["cal_FB26_A1B4","FB26","A1B4","Año 1 Bloque 4", d_(2026,9,29), d_(2026,11,27), 8,false,true,
     "A1B4 — 29 sep al 27 nov 2026. Receso: 6-oct→9-oct (1 sem). Ventana SP26 (compartida DIR C1M1). Pool: Carlos decide si ART comparte aula con DIR.",
     ahora,ejecutor,"",""],
    ["cal_FB26_A2B1","FB26","A2B1","Año 2 Bloque 1","PENDIENTE","PENDIENTE",8,false,false,"Año 2027 — pendiente",              ahora,ejecutor,"",""],
    ["cal_FB26_A2B2","FB26","A2B2","Año 2 Bloque 2","PENDIENTE","PENDIENTE",8,false,false,"Año 2027 — pendiente",              ahora,ejecutor,"",""],
    ["cal_FB26_A2B3","FB26","A2B3","Año 2 Bloque 3","PENDIENTE","PENDIENTE",8,false,false,"Año 2027 — pendiente",              ahora,ejecutor,"",""],
    ["cal_FB26_A2B4","FB26","A2B4","Año 2 Bloque 4","PENDIENTE","PENDIENTE",8,true, false,"CIERRE PROGRAMA FB26 — pendiente",  ahora,ejecutor,"",""]
  ];
  escribirDatos(ss, "_CFG_COHORT_CALENDAR", rows);
  Logger.log("    📅 _CFG_COHORT_CALENDAR → " + rows.length +
             " períodos (EN26×6 + MR26×6 + MY26×6 + AG26×6 + SP26×6 + FB26×8: A1×4 confirmados + A2×4 pendientes)");
}

function poblarRecesses_(ss, ahora, ejecutor) {
  // COMPORTAMIENTO DEL SEMÁFORO durante receso activo:
  //   Si HOY cae entre StartDate y EndDate de un receso IsActive=true:
  //   → NO recalcula estados de riesgo
  //   → NO marca rojo por inactividad en el aula
  //   → Mantiene el último estado calculado antes del receso
  //   AppliesTo="ALL" significa que aplica a todos los cohortes activos.
  //   En Fase 2 se puede segmentar por cohorte específico.
  //
  // IsActive=false en rec_2027_SS: fecha aproximada — activar solo tras
  // confirmación oficial del MEN (Ministerio de Educación Nacional).
  var rows = [
    ["rec_2026_SS",     "Semana Santa 2026",           d_(2026,3,30), d_(2026,4,3),  "ALL",true, "Aplica EN26/MR26 C1M2",         ahora,ejecutor,"",""],
    ["rec_2026_VAC_MID","Vacaciones Mitad de Año 2026", d_(2026,6,25), d_(2026,7,10), "ALL",true, "Aplica EN26/MR26/MY26 C2M1",    ahora,ejecutor,"",""],
    ["rec_2026_OCT",    "Receso Octubre 2026",          d_(2026,10,5), d_(2026,10,9), "ALL",true, "Aplica cohortes en C1M1/C3M1",  ahora,ejecutor,"",""],
    ["rec_2026_DIC",    "Vacaciones Diciembre 2026",    d_(2026,12,1), d_(2026,12,31),"ALL",true, "Primera parte receso dic-ene",   ahora,ejecutor,"",""],
    ["rec_2027_ENE",    "Reintegro Enero 2027",         d_(2027,1,1),  d_(2027,1,15), "ALL",true, "Segunda parte receso dic-ene",   ahora,ejecutor,"",""],
    ["rec_2027_SS",     "Semana Santa 2027",            d_(2027,3,29), d_(2027,4,2),  "ALL",false,"Fecha aprox — confirmar con MEN",ahora,ejecutor,"",""]
  ];
  escribirDatos(ss, "_CFG_RECESSES", rows);
  Logger.log("    🗓  _CFG_RECESSES → " + rows.length + " recesos (5 confirmados + 1 aprox)");
}

function poblarSemaforoConfig_(ss, ahora, ejecutor) {
  // Parámetros de la política de evaluación institucional (DEC-2026-015).
  //
  // CÓMO CAMBIAR UN UMBRAL SIN TOCAR CÓDIGO:
  //   1. Abrir SIDEP_01_CORE_ACADEMICO → hoja _CFG_SEMAFORO
  //   2. Editar ConfigValue de la clave correspondiente
  //   3. El próximo lunes 20_semaforo.js usará el nuevo valor automáticamente
  //
  // ESCALA:
  //   Nota válida: ESCALA_MIN (1.0) a ESCALA_MAX (5.0)
  //   Nota fuera de rango → marcada NOTA_INVALIDA, no entra al promedio
  //
  // NIVELES:
  //   EXCELENTE:   nota >= NIVEL_EXCELENTE_MIN (4.5)
  //   BUENO:       nota >= NIVEL_BUENO_MIN     (4.0) y < NIVEL_EXCELENTE_MIN
  //   ACEPTABLE:   nota >= UMBRAL_APROBACION   (3.0) y < NIVEL_BUENO_MIN
  //   INSUFICIENTE:nota <  UMBRAL_APROBACION   (3.0)
  //
  // SEMÁFORO:
  //   GREEN:  nota >= UMBRAL_GREEN  (4.1)   ← BUENO o EXCELENTE
  //   YELLOW: nota >= UMBRAL_YELLOW (3.0)   ← ACEPTABLE
  //   RED:    nota <  UMBRAL_YELLOW (3.0)   ← INSUFICIENTE
  //   GREY:   sin datos (todo PENDIENTE o materia SIN_SYLLABUS)
  //
  // NOTA: UMBRAL_GREEN (4.1) y NIVEL_BUENO_MIN (4.0) son distintos.
  //   BUENO empieza en 4.0 pero el semáforo se vuelve VERDE solo en 4.1
  //   — margen de 0.1 punto para evitar verde por nota "justa de bueno".
  var rows = [
    ["csf_01","ESCALA_MIN",         1.0,"Nota mínima válida",              "Valor mínimo aceptable en la escala institucional. Notas por debajo son NOTA_INVALIDA.",          true, ahora,ejecutor,"",""],
    ["csf_02","ESCALA_MAX",         5.0,"Nota máxima válida",              "Valor máximo aceptable en la escala institucional. Notas por encima son NOTA_INVALIDA.",          true, ahora,ejecutor,"",""],
    ["csf_03","UMBRAL_GREEN",       4.1,"Umbral mínimo semáforo VERDE",    "Nota mínima para que el semáforo muestre VERDE. Por debajo es AMARILLO.",                        true, ahora,ejecutor,"",""],
    ["csf_04","UMBRAL_YELLOW",      3.0,"Umbral mínimo semáforo AMARILLO", "Nota mínima para AMARILLO. Por debajo es ROJO (INSUFICIENTE).",                                  true, ahora,ejecutor,"",""],
    ["csf_05","UMBRAL_APROBACION",  3.0,"Nota mínima aprobatoria",         "Nota mínima para aprobar una asignatura. Coincide con UMBRAL_YELLOW en la política actual.",     true, ahora,ejecutor,"",""],
    ["csf_06","NIVEL_EXCELENTE_MIN",4.5,"Nota mínima para EXCELENTE",      "Nota >= este valor → nivel EXCELENTE en el reporte de Carlos.",                                  true, ahora,ejecutor,"",""],
    ["csf_07","NIVEL_BUENO_MIN",    4.0,"Nota mínima para BUENO",          "Nota >= este valor y < NIVEL_EXCELENTE_MIN → nivel BUENO. El semáforo es VERDE desde 4.1.",      true, ahora,ejecutor,"",""]
  ];
  escribirDatos(ss, "_CFG_SEMAFORO", rows);
  Logger.log("    ⚙️  _CFG_SEMAFORO → " + rows.length + " parámetros (escala + umbrales)");
}