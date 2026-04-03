/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 17_importarEstudiantes.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Registrar estudiantes en Students + Enrollments (Sheets) y
 *   enviar invitaciones de estudiante a los aulas de Classroom.
 *   CERO lógica de planificación ni de docentes.
 *
 * MODELO DE INVITACIONES (mismo patrón que 06_importarDocentes.gs v8+):
 *   Los estudiantes usan cuentas Gmail personales (@gmail.com).
 *   Students.create() falla con 403 para cuentas externas al dominio.
 *   Solución: Classroom.Invitations.create({ role:'STUDENT' }).
 *   El estudiante recibe email y debe ACEPTAR la invitación.
 *   Hasta que acepta, no aparece en el aula.
 *
 * FORMATO DE ESTUDIANTES_DATA:
 *   [Nombres, Apellidos, Email, TipoDoc, NumDoc, ProgramCode,
 *    CohortEntrada, StudentType, [SubjectCodes]]
 *
 *   CohortEntrada = cohorte en que el estudiante INGRESÓ al programa.
 *     Estudiantes nuevos MR26    → 'MR26'
 *     Estudiantes antiguos EN26  → 'EN26'  (avanzando a C1M2)
 *   Las aulas siempre son de la ventana MR26 (WindowCohortCode='MR26').
 *
 *   SubjectCodes = lista EXPLÍCITA de materias que cursa en C1M2.
 *     Cada estudiante puede tener una lista diferente.
 *     El script busca el deployment programa-DIR-MR26-C1M2-materia-001
 *     y envía la invitación. Si el aula no es CREATED, la omite con log.
 *     Las materias TRV (MAT, HIA, TFG) se resuelven automáticamente:
 *     para TRV el script usa programCode='TRV' en el lookup.
 *
 *   MATERIAS TRV EN LA LISTA:
 *     Incluir 'MAT', 'HIA', 'TFG' si el estudiante debe cursarlas.
 *     El script detecta IsTransversal en _CFG_SUBJECTS y busca
 *     el deployment TRV-DIR-MR26-C1M2-MAT-001 automáticamente.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs v4.1.0+ → getSpreadsheetByName(), nowSIDEP(),
 *                                  uuid(), SIDEP_CONFIG
 *   02_poblarConfiguraciones.gs → _CFG_SUBJECTS poblada
 *   14_crearAulas.gs        → aulas CREATED en MasterDeployments
 *   06_importarDocentes.gs     → docentes ya invitados (orden recomendado)
 *   Google Classroom API v1    → Editor GAS → ➕ Servicios → Agregar
 *
 * PRERREQUISITOS:
 *   ✅ setupSidepTables()     — tablas Students y Enrollments creadas
 *   ✅ crearAulas()           — aulas CREATED en MasterDeployments
 *   ✅ Classroom API habilitada
 *
 * FUNCIONES PÚBLICAS:
 *   importarEstudiantes()     → función principal
 *   diagnosticoEstudiantes()  → estado sin modificar nada
 *
 * ESTRATEGIA DE API:
 *   Sheets lectura  : 3 getValues() al inicio (memoria total)
 *   Procesamiento   : 100% en memoria, 0 llamadas API
 *   Classroom       : 1 Invitations.create() por materia por estudiante
 *   Sheets escritura: 2 setValues() al final (Students + Enrollments batch)
 *   AutomationLogs  : 1 appendRow al finalizar
 *
 * CUOTAS Y TIEMPOS:
 *   Classroom API: ~500 invitaciones/día por cuenta.
 *   Con 20 estudiantes × 4 materias promedio = 80 invitaciones.
 *   batchSize=50 estudiantes por ejecución — ajustar si hay timeout.
 *   GAS timeout: 6 min. Con sleep(200ms): ~300 invitaciones/min — holgado.
 *
 * LOCKING:
 *   Siempre adquiere LockService — previene duplicados si se re-ejecuta
 *   mientras una ejecución previa sigue corriendo.
 *
 * PATRÓN MEMORY-FIRST:
 *   1. Leer Students, Enrollments y MasterDeployments en memoria
 *   2. Construir índices en JS (O(1) lookups)
 *   3. Procesar ESTUDIANTES_DATA en memoria
 *   4. Llamar Classroom API para invitaciones nuevas
 *   5. Escribir Students nuevos en batch (1 setValues)
 *   6. Escribir Enrollments nuevos en batch (1 setValues)
 *
 * VERSIÓN: 1.1.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-03-17
 *
 * CAMBIOS v1.1 vs v1.0:
 *   - ESTUDIANTES_DATA poblada con los 39 estudiantes activos de MR26/C1M2.
 *   - PAS agregado a TIPOS_DOC_EST (fila 40, Lizardo Tenias, pasaporte venezolano).
 *   - Cohortes FB25 (Feb-2025) y AG25 (Ago-2025) referenciados.
 *     ⚠️  Prerrequisito: agregar FB25 y AG25 a _CFG_COHORTS antes de ejecutar.
 *   - Notas de validación inline: SubjectCodes de EN26/FB25/AG25 tienen
 *     solo la materia del programa — confirmar TRV uno a uno con Carlos.
 *   - 5 estudiantes excluidos: 4 INACTIVOS + 1 SUSPENDIDO.
 * ============================================================
 */


// ════════════════════════════════════════════════════════════
// CONSTANTES LOCALES
// ════════════════════════════════════════════════════════════

// ─ Constantes del período activo — ACTUALIZAR en cada apertura ─────────────
// FIX-AUDIT C-1: nombres genéricos para evitar identificadores que mienten
// cuando se cambia de MR26/C1M2 al siguiente período (MY26/C2M1, etc.).
// Solo cambiar los VALORES aquí; el nombre de la constante nunca cambia.
var WINDOW_COHORT_ACTUAL = "MR26";   // ← período activo (ventana que creó las aulas)
var MOMENTO_ACTUAL       = "C1M2";   // ← momento académico activo
var MODALIDAD_ACTUAL     = "DIR";    // ← modalidad activa (DIR | ART)

// Tipos de documento válidos — PAS = pasaporte (incluye PPT venezolano)
var TIPOS_DOC_EST = ["CC", "TI", "CE", "PAS"];

// Tipos de estudiante válidos
var TIPOS_EST_VALIDOS = ["DIRECTO", "ARTICULADO"];


// ════════════════════════════════════════════════════════════
// DATOS — MR26/C1M2 — validados 17-mar-2026
// ════════════════════════════════════════════════════════════
//
// EXCLUIDOS (no se cargan):
//   14 - GARCIA GARZON, DERLY (SST) — INACTIVO
//   15 - AVILA CASTILLO, LAURA (CTB→MKT) — INACTIVO
//   33 - MASMELA FANDIÑO, JEIMMY (CTB) — INACTIVO
//   Articulados nuevos MR26: RUGELES, CORTES, MOJICA, NAVARRO, MORA, GONZALEZ A., MENDOZA
//     → no incluidos en esta carga (articulación pendiente)
//
// ► Re-ejecutar es seguro: 409 de Classroom = ya invitado.
var ESTUDIANTES_DATA = [

  // ── COHORTE FB25 — ingreso Feb-2025 ──────────────────────────────────────
  // #ST-155812 · fila 03
  ["JEIMY ALEJANDRA",  "CHAVES TOBAR",       "chavesjeimyalejandra@gmail.com", "TI", "1025324393",
   "ADM", "FB25", "DIRECTO",    ["GDR", "GEN", "RIN", "TFG"]],
  // #ST-657577 · fila 04
  ["DIANA CATERINE",   "CAICEDO ARIZA",       "lanana1624@gmail.com",           "CC", "1024509035",
   "ADM", "FB25", "DIRECTO",    ["GDR", "GEN", "RIN", "TFG"]],
  // #ST-998950 · fila 07
  ["DAVID SANTIAGO",   "DURAN ESPINOSA",      "mcdavid1209@gmail.com",          "TI", "1028864033",
   "MKT", "FB25", "DIRECTO",    ["SEM", "MDA", "TFG"]],
  // #ST-352487 · fila 08
  ["NICOLAS",          "BUSTAMANTE TIRANO",   "nico.busti08@gmail.com",         "CC", "1032939685",
   "MKT", "FB25", "DIRECTO",    ["SEM", "MDA", "TFG"]],
  // #ST-507343 · fila 12
  ["MIGUEL ANGEL",     "NIÑO CASTRO",         "supremepower4562@gmail.com",     "TI", "1019844441",
   "SIS", "FB25", "DIRECTO",    ["PAI", "DPW", "TFG"]],

  // ── COHORTE EN26 — avanzando a C1M2 ──────────────────────────────────────
  // #ST-864499 · fila 17 — dual AA-MK, programa principal: ADM
  ["TATIANA LORENA",   "RODRIGUEZ SANCHEZ",   "rodriguezt984@gmail.com",        "CC", "1014202331",
   "ADM", "EN26", "DIRECTO",    ["GDR", "MAT", "HIA"]],
  // #ST-484220 · fila 20
  ["JUAN FELIPE",      "NIETO HERRERA",       "juanfelipenietoherrera3@gmail.com","TI","1141117753",
   "MKT", "EN26", "DIRECTO",    ["SEM", "MAT", "HIA"]],
  // #ST-440059 · fila 29
  ["YANET",            "GUAICAL URIEL",       "yanetguaical54@gmail.com",       "CC", "1085348367",
   "CTB", "EN26", "DIRECTO",    ["SPC", "MAT", "HIA"]],
  // #ST-402407 · fila 28 — traslado ART→DIR confirmado Carlos 17-mar-2026
  ["JUAN JOSE",        "LOPEZ NAVARRO",       "lopezjuaj908@gmail.com",         "TI", "1024538508",
   "CTB", "EN26", "DIRECTO",    ["SPC", "MAT", "HIA"]],
  // #ST-072679 · fila 30
  ["DANNA VALENTINA",  "OSORIO AVILA",        "dannaoso231223@gmail.com",       "CC", "1000337713",
   "MKT", "EN26", "DIRECTO",    ["SEM", "MAT", "HIA"]],
  // #ST-661357 · fila 31
  ["JUAN DAVID",       "BURGOS MARTINEZ",     "jdavidburgos27@gmail.com",       "TI", "1025540158",
   "MKT", "EN26", "DIRECTO",    ["SEM", "MAT", "HIA"]],
  // #ST-947125 · fila 32
  ["WILLIAM ESTEBAN",  "MANSO MENDEZ",        "estebanmanso8@gmail.com",        "TI", "1014867644",
   "SIS", "EN26", "DIRECTO",    ["PAI", "MAT", "HIA"]],
  // #ST-985069 · fila 34
  ["JENNY MARCELA",    "MORENO RODRIGUEZ",    "morerodri8223@gmail.com",        "CC", "52821775",
   "SST", "EN26", "DIRECTO",    ["FDR", "MAT", "HIA"]],
  // #ST-101803 · fila 36
  ["JHOSEP",           "GONZALEZ TAPIA",      "jhosepgonzalez2026@gmail.com",   "CC", "1032940233",
   "MKT", "EN26", "DIRECTO",    ["SEM", "MAT", "HIA"]],
  // #ST-754998 · fila 25 — traslado ART→DIR confirmado Carlos 17-mar-2026
  ["DAVID ALEJANDRO",  "GARCIA CASALLAS",     "alegarciacasallas11@gmail.com",  "TI", "1013011105",
   "SST", "EN26", "DIRECTO",    ["FDR", "MAT", "HIA"]],
  // #ST-290917 · fila 19 — REACTIVADA: se comunicó con SIDEP el 17-mar-2026
  // Estaba SUSPENDIDO — Carlos autoriza su ingreso en MR26/C1M2
  ["SANDRA PATRICIA",  "PARGA BELTRAN",       "romapequitas2026@gmail.com",     "CC", "52934599",
   "MKT", "EN26", "DIRECTO",    ["SEM", "MDA", "MAT", "HIA"]],
  // #ST-370533 · fila 37 — traslado ART→DIR confirmado Carlos 17-mar-2026
  ["ANGIE ZARAY",      "CAMACHO LAVERDE",      "zaraycamacho4@gmail.com",        "TI", "1072466747",
   "MKT", "EN26", "DIRECTO",    ["SEM", "MDA", "MAT", "HIA"]],
  // #ST-229200 · fila 27 — reactivada, ingresa MR26/C1M2
  ["NUBIA PATRICIA",   "CIFUENTES MEDINA",     "patricia31medina@gmail.com",     "CC", "1072466292",
   "ADM", "EN26", "DIRECTO",    ["GDR", "MAT", "HIA"]],

  // ── NUEVOS MR26 ★ — inician en C1M2 (solo DIRECTO) ──────────────────────
  // TFG: confirmar con Carlos si aplica desde C1M2. Agregar "TFG" y re-ejecutar.
  // #ST-319581 · fila 38
  ["BIATRIZ ENEIDA",   "VILLALOBO BELENO",    "beavillalobohoz2823@gmail.com",  "CC", "1121306586",
   "ADM", "MR26", "DIRECTO",    ["GDR", "MAT", "HIA"]],
  // #ST-543560 · fila 39 — programa MKT (confirmado Carlos)
  ["JUAN JOSE",        "CHIMA MARTINEZ",      "juanchima69@gmail.com",          "TI", "1067287038",
   "MKT", "MR26", "DIRECTO",    ["SEM", "MDA", "MAT", "HIA"]],
  // #ST-319058 · fila 40 — pasaporte venezolano (PPT → PAS)
  ["JOGRELIZ GABRIELA","LIZARDO TENIAS",      "jogrelizg2@gmail.com",           "PAS","1449830",
   "CTB", "MR26", "DIRECTO",    ["SPC", "MAT", "HIA"]],
  // #ST-471781 · fila 41
  ["DANIS GABRIEL",    "BOCANEGRA PATINO",    "ds9536959@gmail.com",            "CC", "1105780531",
   "ADM", "MR26", "DIRECTO",    ["GDR", "MAT", "HIA"]],
  // #ST-298647 · fila 46
  ["YURANY MARCELA",   "CESPEDES CANON",      "yuranycespedes12@gmail.com",     "CC", "1014232097",
   "ADM", "MR26", "DIRECTO",    ["GDR", "MAT", "HIA"]]

  // ► Para agregar estudiantes: copiar formato y re-ejecutar (idempotente).
];

// ════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════════════════════

/**
 * Importa estudiantes, crea matrículas y envía invitaciones a Classroom.
 * Re-ejecutar es seguro: 409 = ya invitado, estudiantes existentes se
 * actualizan sin duplicar.
 */
function importarEstudiantes() {
  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();
  var inicio   = Date.now();
  var logResult = "ERROR";
  var logMsg    = "";
  var conteo    = {};

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    Logger.log("⚠️  Lock ocupado — importarEstudiantes ya está corriendo. " +
               "Espera 30s e intenta de nuevo.");
    return;
  }
  Logger.log("🔐 Lock adquirido");

  var adminSS;
  try {
    Logger.log("════════════════════════════════════════════════");
    Logger.log("🎓 SIDEP — importarEstudiantes v1.1 · " + ahora);
    Logger.log("   Ejecutor : " + ejecutor);
    Logger.log("   Ventana  : " + WINDOW_COHORT_ACTUAL + " · " + MOMENTO_ACTUAL);
    Logger.log("════════════════════════════════════════════════");

    if (ESTUDIANTES_DATA.length === 0) {
      Logger.log("⚠️  ESTUDIANTES_DATA está vacío.");
      Logger.log("   Completar la lista en este archivo y re-ejecutar.");
      return;
    }

    if (typeof Classroom === "undefined") {
      throw new Error(
        "Classroom API no habilitada. " +
        "Editor GAS → ➕ Servicios → Google Classroom API v1 → Agregar"
      );
    }

    // ── FASE 1: Validación de entrada ─────────────────────────────────────
    Logger.log("\n── FASE 1/4 · Validación ──");
    _validarEstudiantes_();

    // ── FASE 2: Lectura total en memoria — 3 llamadas Sheets ──────────────
    Logger.log("\n── FASE 2/4 · Lectura en memoria ──");
    adminSS        = getSpreadsheetByName("admin");
    var coreSS     = getSpreadsheetByName("core");

    var memStu     = _leerHojaEst_(adminSS, "Students");
    var memEnr     = _leerHojaEst_(adminSS, "Enrollments");
    var memDepl    = _leerHojaEst_(coreSS,  "MasterDeployments");

    Logger.log("  Students existentes    : " + memStu.datos.length);
    Logger.log("  Enrollments existentes : " + memEnr.datos.length);
    Logger.log("  Deployments cargados   : " + memDepl.datos.length);

    // ── FASE 3: Procesamiento en memoria — 0 llamadas API ─────────────────
    Logger.log("\n── FASE 3/4 · Procesamiento en memoria ──");

    // Índices O(1) construidos en memoria
    var emailIdx   = _indexarPorEmail_(memStu);        // email → rowIdx en datos[]
    var deplIdx    = _indexarDeployments_Est_(memDepl); // "PROG-COH-MOM-COD" → {id, classroomId, status}
    var enrIdx     = _indexarEnrollments_(memEnr);     // "studentId_deplId" → true
    var subjTRV    = _indexarTransversales_(coreSS); // subjectCode → true si IsTransversal (A-4: dinámico)

    var planStu    = _planificarStudents_(memStu, emailIdx, ahora, ejecutor);
    Logger.log("  Students a insertar    : " + planStu.inserts.length);
    Logger.log("  Students a actualizar  : " + planStu.updates.length);

    // Construir mapa email → StudentID con los datos ya procesados (incluye nuevos)
    var emailToStudentId = _construirEmailStudentIdx_(memStu);

    var planEnr    = _planificarEnrollments_(
      emailToStudentId, deplIdx, enrIdx, subjTRV, ahora, ejecutor
    );
    Logger.log("  Invitaciones a enviar  : " + planEnr.porInvitar.length);
    Logger.log("  Matrículas duplicadas  : " + planEnr.duplicadas);
    Logger.log("  Aulas no encontradas   : " + planEnr.omitidas);

    if (planEnr.porInvitar.length === 0 && planStu.inserts.length === 0) {
      Logger.log("\n  ⬜ Nada nuevo que procesar.");
      logResult = "SUCCESS";
      return;
    }

    // ── FASE 4: Escritura ──────────────────────────────────────────────────
    Logger.log("\n── FASE 4/4 · Escritura ──");

    // 4a — Guardar Students en Sheets (antes de invitar a Classroom)
    _escribirStudents_(memStu, planStu);

    // 4b — Enviar invitaciones + escribir Enrollments en batch
    var resEnr = _ejecutarEnrollments_(memEnr, planEnr);

    // ── Resumen ────────────────────────────────────────────────────────────
    var dur = ((Date.now() - inicio) / 1000).toFixed(1);
    conteo = {
      studentsInsertados  : planStu.inserts.length,
      studentsActualizados: planStu.updates.length,
      invitacionesEnviadas: resEnr.classroomOk,
      invitacionesExistian: resEnr.yaExistia,
      enrollmentsEscritos : resEnr.escritas,
      duplicadas          : planEnr.duplicadas,
      omitidas            : planEnr.omitidas,
      errores             : resEnr.errores
    };

    Logger.log("\n════════════════════════════════════════════════");
    Logger.log("✅ importarEstudiantes completado en " + dur + "s");
    Logger.log("   Students insertados     : " + conteo.studentsInsertados);
    Logger.log("   Students actualizados   : " + conteo.studentsActualizados);
    Logger.log("   Invitaciones enviadas   : " + conteo.invitacionesEnviadas + " nuevas");
    Logger.log("   Invitaciones ya existían: " + conteo.invitacionesExistian);
    Logger.log("   Enrollments escritos    : " + conteo.enrollmentsEscritos);
    Logger.log("   Duplicados omitidos     : " + conteo.duplicadas);
    Logger.log("   Aulas no encontradas    : " + conteo.omitidas);
    Logger.log("   Errores Classroom API   : " + conteo.errores);
    Logger.log("════════════════════════════════════════════════");
    Logger.log("  ⚠️  Los estudiantes deben ACEPTAR la invitación por email.");
    Logger.log("     Hasta que acepten, no aparecen en el aula.");

    logResult = conteo.errores > 0 ? "PARTIAL" : "SUCCESS";
    logMsg    = conteo.errores > 0
      ? conteo.errores + " invitación(es) fallaron — revisar log"
      : "";

  } catch (e) {
    logResult = "ERROR";
    logMsg    = e.message || String(e);
    Logger.log("❌ ERROR en importarEstudiantes: " + logMsg);
    throw e;

  } finally {
    if (adminSS) {
      try {
        var logHoja = adminSS.getSheetByName("AutomationLogs");
        if (logHoja) {
          logHoja.appendRow([
            uuid("log"), "CLASSROOM", "IMPORT_STUDENTS", "importarEstudiantes",
            logResult, conteo.enrollmentsEscritos || 0, logMsg || "",
            nowSIDEP(), Session.getEffectiveUser().getEmail()
          ]);
        }
      } catch (eLog) {
        Logger.log("⚠️  No se pudo escribir AutomationLog: " + eLog.message);
      }
    }
    lock.releaseLock();
    Logger.log("🔓 Lock liberado");
  }
}


// ════════════════════════════════════════════════════════════
// DIAGNÓSTICO — solo lectura
// ════════════════════════════════════════════════════════════

/**
 * Muestra el estado de Students y Enrollments sin modificar nada.
 * Útil para verificar antes o después de importarEstudiantes().
 */
function diagnosticoEstudiantes() {
  Logger.log("════════════════════════════════════════════════");
  Logger.log("🔍 SIDEP — Diagnóstico de Estudiantes v1.0");
  Logger.log("════════════════════════════════════════════════");

  try {
    var adminSS  = getSpreadsheetByName("admin");

    // ── Students ──────────────────────────────────────────────────────────
    var hojaS  = adminSS.getSheetByName("Students");
    var rowsS  = hojaS ? Math.max(0, hojaS.getLastRow() - 1) : 0;
    Logger.log("\n👤 STUDENTS: " + rowsS + " registros");

    if (rowsS > 0) {
      var dataS   = hojaS.getRange(2, 1, rowsS, hojaS.getLastColumn()).getValues();
      var hS      = hojaS.getRange(1, 1, 1, hojaS.getLastColumn()).getValues()[0];
      var iCohort = hS.indexOf("CohortCode");
      var iProg   = hS.indexOf("ProgramCode");
      var iStatus = hS.indexOf("StudentStatusCode");
      var porCohort = {};
      var porProg   = {};

      dataS.forEach(function(r) {
        var c = String(r[iCohort] || "?");
        var p = String(r[iProg]   || "?");
        porCohort[c] = (porCohort[c] || 0) + 1;
        porProg[p]   = (porProg[p]   || 0) + 1;
      });

      Logger.log("  Por cohorte de entrada:");
      Object.keys(porCohort).sort().forEach(function(c) {
        Logger.log("    " + c + ": " + porCohort[c]);
      });
      Logger.log("  Por programa:");
      Object.keys(porProg).sort().forEach(function(p) {
        Logger.log("    " + p + ": " + porProg[p]);
      });
    }

    // ── Enrollments ───────────────────────────────────────────────────────
    var hojaE  = adminSS.getSheetByName("Enrollments");
    var rowsE  = hojaE ? Math.max(0, hojaE.getLastRow() - 1) : 0;
    Logger.log("\n📋 ENROLLMENTS: " + rowsE + " matrículas");

    if (rowsE > 0) {
      var dataE   = hojaE.getRange(2, 1, rowsE, hojaE.getLastColumn()).getValues();
      var hE      = hojaE.getRange(1, 1, 1, hojaE.getLastColumn()).getValues()[0];
      var iEStat  = hE.indexOf("EnrollmentStatusCode");
      var iWin    = hE.indexOf("WindowCohortCode");
      var iMom    = hE.indexOf("MomentCode");
      var porStat = {};

      dataE.forEach(function(r) {
        var s = String(r[iEStat] || "?");
        porStat[s] = (porStat[s] || 0) + 1;
      });

      Logger.log("  Por estado:");
      Object.keys(porStat).sort().forEach(function(s) {
        Logger.log("    " + s + ": " + porStat[s]);
      });

      // Filtrar MR26/C1M2
      var mr26 = dataE.filter(function(r) {
        return String(r[iWin] || "") === WINDOW_COHORT_ACTUAL &&
               String(r[iMom] || "") === MOMENTO_ACTUAL;
      });
      Logger.log("  MR26/C1M2: " + mr26.length + " matrículas");
    }

    Logger.log("\n════════════════════════════════════════════════");
  } catch (e) {
    Logger.log("❌ ERROR en diagnosticoEstudiantes: " + e.message);
  }
}


// ════════════════════════════════════════════════════════════
// FASE 1 — VALIDACIÓN
// ════════════════════════════════════════════════════════════

/**
 * Valida ESTUDIANTES_DATA antes de tocar Sheets.
 * Lanza Error descriptivo en el primer problema — el script aborta limpiamente.
 */
function _validarEstudiantes_() {
  var emailsVistos = {};

  ESTUDIANTES_DATA.forEach(function(d, i) {
    var ctx   = "ESTUDIANTES_DATA[" + i + "] (" + (d[2] || "sin email") + ")";
    var email = String(d[2] || "").trim().toLowerCase();

    if (!d[0] || !d[1]) throw new Error(ctx + ": Nombres o Apellidos vacíos.");

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(ctx + ": Email vacío o formato inválido.");
    }
    if (emailsVistos[email]) {
      throw new Error(ctx + ": Email duplicado en ESTUDIANTES_DATA.");
    }
    emailsVistos[email] = true;

    if (TIPOS_DOC_EST.indexOf(d[3]) === -1) {
      throw new Error(ctx + ": TipoDoc inválido → '" + d[3] + "'. " +
                      "Válidos: " + TIPOS_DOC_EST.join(", "));
    }
    if (!d[4]) throw new Error(ctx + ": NumDoc vacío.");

    if (TODOS_LOS_PROGRAMAS.indexOf(d[5]) === -1) {
      throw new Error(ctx + ": ProgramCode inválido → '" + d[5] + "'. " +
                      "Válidos: " + TODOS_LOS_PROGRAMAS.join(", "));
    }
    if (!d[6]) throw new Error(ctx + ": CohortEntrada vacío (usar MR26 o EN26).");

    if (TIPOS_EST_VALIDOS.indexOf(d[7]) === -1) {
      throw new Error(ctx + ": StudentType inválido → '" + d[7] + "'. " +
                      "Válidos: DIRECTO | ARTICULADO");
    }
    if (!d[8] || !Array.isArray(d[8]) || d[8].length === 0) {
      throw new Error(ctx + ": SubjectCodes vacío o no es array. " +
                      "Ejemplo: [\"SPC\", \"MAT\", \"HIA\"]");
    }
  });

  Logger.log("  ✅ Datos válidos (" + ESTUDIANTES_DATA.length + " estudiantes)");
}


// ════════════════════════════════════════════════════════════
// FASE 2 — LECTURA
// ════════════════════════════════════════════════════════════

/**
 * Lee una hoja completa en UNA llamada Sheets API.
 *
 * FIX v1.1: separa la lectura de encabezado de la lectura de datos.
 *   La versión anterior retornaba encabezado:[] cuando lastRow <= 1,
 *   lo que rompía _planificarStudents_ cuando la tabla estaba vacía
 *   (solo encabezado) — new Array(0) → setValues con 0 columnas → error.
 *   Ahora siempre lee el encabezado si lastRow >= 1, independientemente
 *   de si hay filas de datos o no.
 *
 * FIX: excluye solo filas donde TODAS las celdas son "".
 */
function _leerHojaEst_(ss, nombreHoja) {
  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) {
    throw new Error("Hoja '" + nombreHoja + "' no encontrada en '" +
                    ss.getName() + "'. ¿Ejecutaste setupSidepTables()?");
  }
  var lastRow = hoja.getLastRow();
  var lastCol = hoja.getLastColumn();

  // Tabla completamente vacía — ni encabezado
  if (lastRow === 0 || lastCol === 0) {
    return { hoja: hoja, nombreHoja: nombreHoja,
             encabezado: [], datos: [], colIdx: {}, datosOriginalesCount: 0 };
  }

  // Siempre leer encabezado (fila 1), aunque no haya datos
  var encabezado = hoja.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIdx     = {};
  encabezado.forEach(function(nombre, i) {
    if (nombre !== "") colIdx[String(nombre)] = i;
  });

  // Leer datos solo si hay filas de datos (lastRow > 1)
  var datos = [];
  if (lastRow > 1) {
    datos = hoja.getRange(2, 1, lastRow - 1, lastCol).getValues()
              .filter(function(fila) {
                return fila.some(function(c) { return c !== ""; });
              });
  }

  return { hoja: hoja, nombreHoja: nombreHoja,
           encabezado: encabezado, datos: datos, colIdx: colIdx,
           datosOriginalesCount: datos.length };
}


// ════════════════════════════════════════════════════════════
// FASE 3 — PROCESAMIENTO EN MEMORIA
// ════════════════════════════════════════════════════════════

/** Índice { email.toLowerCase() → rowIdx en datos[] } */
function _indexarPorEmail_(mem) {
  var idx = {};
  mem.datos.forEach(function(fila, i) {
    var email = String(fila[mem.colIdx["Email"]] || "").toLowerCase().trim();
    if (email) idx[email] = i;
  });
  return idx;
}

/**
 * Índice de deployments: "PROG-COH-MOM-COD" → { id, classroomId, status }
 * Nomenclatura: PROG-DIR-COH-MOM-COD-GRP → segmentos [0,2,3,4]
 * Clave: programa + ventana + momento + materia.
 */
function _indexarDeployments_Est_(mem) {
  var iId  = mem.colIdx["DeploymentID"];
  var iNom = mem.colIdx["GeneratedNomenclature"];
  var iCid = mem.colIdx["ClassroomID"];
  var iSt  = mem.colIdx["ScriptStatusCode"];
  var idx  = {};

  mem.datos.forEach(function(fila) {
    var nom = String(fila[iNom] || "").trim();
    if (!nom) return;
    var segs = nom.split("-");
    if (segs.length >= 5) {
      // clave: PROG-COHORT-MOMENT-SUBJECT (omite modal y group)
      var clave = segs[0] + "-" + segs[2] + "-" + segs[3] + "-" + segs[4];
      idx[clave] = {
        id          : String(fila[iId]  || ""),
        classroomId : String(fila[iCid] || ""),
        status      : String(fila[iSt]  || "")
      };
    }
  });
  return idx;
}

/** Índice de matrículas existentes: "studentId_deploymentId" → true */
function _indexarEnrollments_(mem) {
  var idx    = {};
  var iStu   = mem.colIdx["StudentID"];
  var iDep   = mem.colIdx["DeploymentID"];
  if (iStu === undefined || iDep === undefined) return idx;
  mem.datos.forEach(function(fila) {
    var s = String(fila[iStu] || "").trim();
    var d = String(fila[iDep] || "").trim();
    if (s && d) idx[s + "_" + d] = true;
  });
  return idx;
}

/**
 * Índice de materias transversales: { subjectCode → true }
 *
 * FIX-AUDIT A-4: ahora lee _CFG_SUBJECTS dinámicamente desde Sheets.
 * La lectura dinámica original fallaba porque el schema v4 tiene 19 cols
 * pero los datos tenían 17 valores → índice de IsTransversal incorrecto.
 * Corrección: usar el nombre de la columna del encabezado (idóneo) en vez
 * de un índice fijo, igual que el patrón de _leerHojaEst_().
 *
 * FallBack: si la hoja no existe o la columna no se encuentra,
 * se usa TRV_SUBJECTS como respaldo — el script sigue funcionando.
 *
 * @param {Spreadsheet} coreSS — spreadsheet CORE
 * @returns {Object} { subjectCode → true } para materias con IsTransversal=true
 */
var TRV_SUBJECTS_FALLBACK = {
  "MAT": true,  // Matemáticas Básicas
  "HIA": true,  // Herramientas de IA
  "TFG": true   // Trabajo Final de Grado
};

function _indexarTransversales_(coreSS) {
  // Si no se pasa coreSS, usar fallback
  if (!coreSS) {
    Logger.log('  ⚠️  _indexarTransversales_: sin coreSS — usando lista estática TRV.');
    return TRV_SUBJECTS_FALLBACK;
  }

  try {
    var hoja = coreSS.getSheetByName('_CFG_SUBJECTS');
    if (!hoja || hoja.getLastRow() < 2) {
      Logger.log('  ⚠️  _CFG_SUBJECTS vacía o no encontrada — usando lista estática TRV.');
      return TRV_SUBJECTS_FALLBACK;
    }

    var lastCol = hoja.getLastColumn();
    var headers = hoja.getRange(1, 1, 1, lastCol).getValues()[0];
    var iCode   = headers.indexOf('SubjectCode');
    var iTRV    = headers.indexOf('IsTransversal');

    if (iCode === -1 || iTRV === -1) {
      Logger.log('  ⚠️  Columnas SubjectCode/IsTransversal no encontradas en _CFG_SUBJECTS' +
                 ' — usando lista estática TRV.');
      return TRV_SUBJECTS_FALLBACK;
    }

    var datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, lastCol).getValues();
    var mapa  = {};
    datos.forEach(function(fila) {
      var code = String(fila[iCode] || '').trim();
      var isTRV = fila[iTRV];
      // Aceptar true booléano o string 'TRUE'
      if (code && (isTRV === true || String(isTRV).toUpperCase() === 'TRUE')) {
        mapa[code] = true;
      }
    });

    if (Object.keys(mapa).length === 0) {
      Logger.log('  ⚠️  _CFG_SUBJECTS no tiene filas IsTransversal=true' +
                 ' — usando lista estática TRV.');
      return TRV_SUBJECTS_FALLBACK;
    }

    Logger.log('  ✅ Transversales leídas dinámicamente: [' +
               Object.keys(mapa).join(', ') + ']');
    return mapa;

  } catch (e) {
    Logger.log('  ⚠️  Error leyendo _CFG_SUBJECTS: ' + e.message +
               ' — usando lista estática TRV.');
    return TRV_SUBJECTS_FALLBACK;
  }
}

/**
 * Clasifica estudiantes: INSERT (nuevos) vs UPDATE (actualizar email/datos).
 * Los inserts se agregan a mem.datos[] con fila completa.
 */
function _planificarStudents_(mem, emailIdx, ahora, ejecutor) {
  var inserts = [];
  var updates = [];
  var c       = mem.colIdx;

  ESTUDIANTES_DATA.forEach(function(d) {
    var email = d[2].toLowerCase().trim();

    if (emailIdx.hasOwnProperty(email)) {
      // UPDATE — actualizar datos básicos sin cambiar StudentID ni CohortCode
      var i = emailIdx[email];
      mem.datos[i][c["FirstName"]]     = d[0];
      mem.datos[i][c["LastName"]]      = d[1];
      mem.datos[i][c["DocumentType"]]  = d[3];
      mem.datos[i][c["DocumentNumber"]]= d[4];
      mem.datos[i][c["UpdatedAt"]]     = ahora;
      mem.datos[i][c["UpdatedBy"]]     = ejecutor;
      updates.push({ filaIdx: i, email: d[2] });
      Logger.log("  ↺ Actualizar student : " + d[2]);

    } else {
      // INSERT — nuevo estudiante
      var nuevaFila = new Array(mem.encabezado.length).fill("");
      var newId     = uuid("stu");
      nuevaFila[c["StudentID"]]         = newId;
      nuevaFila[c["DocumentType"]]      = d[3];
      nuevaFila[c["DocumentNumber"]]    = d[4];
      nuevaFila[c["StudentType"]]       = d[7];
      nuevaFila[c["FirstName"]]         = d[0];
      nuevaFila[c["LastName"]]          = d[1];
      nuevaFila[c["Phone"]]             = "";
      nuevaFila[c["Email"]]             = d[2];
      nuevaFila[c["CohortCode"]]        = d[6]; // cohorte de ENTRADA — inmutable
      nuevaFila[c["ProgramCode"]]       = d[5];
      nuevaFila[c["CampusCode"]]        = SIDEP_CONFIG.defaultCampus;
      nuevaFila[c["StudentStatusCode"]] = "ACTIVE";
      nuevaFila[c["CompletionStatus"]]  = "IN_PROGRESS";
      nuevaFila[c["GraduationDate"]]    = "";
      nuevaFila[c["CreatedAt"]]         = ahora;
      nuevaFila[c["CreatedBy"]]         = ejecutor;
      nuevaFila[c["UpdatedAt"]]         = ahora;
      nuevaFila[c["UpdatedBy"]]         = ejecutor;

      inserts.push(nuevaFila);
      mem.datos.push(nuevaFila); // agregar en memoria para que el idx lo encuentre
      Logger.log("  + Insertar student   : " + d[2]);
    }
  });

  return { inserts: inserts, updates: updates };
}

/** Índice actualizado email → StudentID (incluye los recién insertados) */
function _construirEmailStudentIdx_(mem) {
  var idx = {};
  mem.datos.forEach(function(fila) {
    var email = String(fila[mem.colIdx["Email"]]     || "").toLowerCase().trim();
    var id    = String(fila[mem.colIdx["StudentID"]] || "").trim();
    if (email && id) idx[email] = id;
  });
  return idx;
}

/**
 * Clasifica matrículas: porInvitar / duplicadas / omitidas.
 * Por cada estudiante × materia, resuelve el deployment correcto.
 * Las materias TRV siempre usan programCode='TRV' en el lookup.
 */
function _planificarEnrollments_(emailToId, deplIdx, enrIdx, subjTRV, ahora, ejecutor) {
  var porInvitar = [];
  var duplicadas = 0;
  var omitidas   = 0;

  ESTUDIANTES_DATA.forEach(function(d) {
    var email     = d[2].toLowerCase().trim();
    var progCode  = d[5];
    var entryCoh  = d[6];  // cohorte de ENTRADA del estudiante
    var subCodes  = d[8];  // lista explícita de materias

    var studentId = emailToId[email];
    if (!studentId) {
      Logger.log("  ⛔ Sin StudentID para: " + d[2]);
      omitidas += subCodes.length;
      return;
    }

    subCodes.forEach(function(subjectCode) {
      // Determinar programa para el deployment lookup
      // TRV: si la materia es transversal, usar 'TRV' independiente del prog del estudiante
      var deplProg = subjTRV[subjectCode] ? "TRV" : progCode;

      // Clave: PROG-VENTANA-MOMENTO-MATERIA
      var deplKey  = deplProg + "-" + WINDOW_COHORT_ACTUAL + "-" +
                     MOMENTO_ACTUAL + "-" + subjectCode;
      var depl     = deplIdx[deplKey];

      if (!depl || !depl.id) {
        Logger.log("  ⏭  Aula no encontrada : " + deplKey +
                   " — ¿existe en MasterDeployments y está CREATED?");
        omitidas++;
        return;
      }
      if (depl.status !== "CREATED") {
        Logger.log("  ⏭  Aula no CREATED    : " + deplKey + " (" + depl.status + ")");
        omitidas++;
        return;
      }
      if (!depl.classroomId) {
        Logger.log("  ⏭  Sin ClassroomID    : " + deplKey);
        omitidas++;
        return;
      }

      // Verificar matrícula duplicada
      var enrKey = studentId + "_" + depl.id;
      if (enrIdx[enrKey]) {
        duplicadas++;
        return;
      }

      porInvitar.push({
        email       : d[2],
        studentId   : studentId,
        deplId      : depl.id,
        classroomId : depl.classroomId,
        entryCohort : entryCoh,
        logKey      : deplProg + "/" + subjectCode + " [" + WINDOW_COHORT_ACTUAL + "]",
        filaEnr     : [
          uuid("enr"),
          studentId,
          depl.id,
          "",                    // AperturaID — vacío en Fase 1
          entryCoh,              // EntryCohortCode — cohorte de ENTRADA (inmutable)
          WINDOW_COHORT_ACTUAL,    // WindowCohortCode — ventana del aula
          MOMENTO_ACTUAL,
          1,                     // AttemptNumber — primera vez
          "ACTIVE",              // EnrollmentStatusCode
          ahora, ejecutor, ahora, ejecutor
        ]
      });
    });
  });

  return { porInvitar: porInvitar, duplicadas: duplicadas, omitidas: omitidas };
}


// ════════════════════════════════════════════════════════════
// FASE 4 — ESCRITURA
// ════════════════════════════════════════════════════════════

/**
 * Escribe Students — máximo 2 setValues().
 * Usa datosOriginalesCount para el rango de updates (mismo patrón que 06).
 */
function _escribirStudents_(mem, plan) {
  var hoja = mem.hoja;

  if (plan.updates.length > 0 && mem.datosOriginalesCount > 0) {
    hoja.getRange(2, 1, mem.datosOriginalesCount, mem.encabezado.length)
        .setValues(mem.datos.slice(0, mem.datosOriginalesCount));
    Logger.log("  ✅ Students updates : " + plan.updates.length + " (1 setValues)");
  }
  if (plan.inserts.length > 0) {
    var ultima = hoja.getLastRow();
    hoja.getRange(ultima + 1, 1, plan.inserts.length, plan.inserts[0].length)
        .setValues(plan.inserts);
    Logger.log("  ✅ Students inserts : " + plan.inserts.length + " (1 setValues)");
  }
}

/**
 * Classroom API + escritura batch de Enrollments.
 * Acumula filasAprobadas en memoria → escribe todo al final en 1 setValues.
 * Excepción documentada al memory-first (misma razón que 06_importarDocentes):
 * ClassroomID se conoce al crear la invitación, pero aquí el aula YA existe
 * — no hay IDs nuevos. La excepción no aplica: escribimos TODO en batch al final.
 */
function _ejecutarEnrollments_(memEnr, plan) {
  var conteo  = { classroomOk: 0, yaExistia: 0, escritas: 0, errores: 0 };
  var filasOk = [];
  var yaProcesados = [];

  plan.porInvitar.forEach(function(item) {
    var resultado = _invitarEstudianteConRetry_(
      item.classroomId, item.email, item.logKey
    );

    if (resultado === "ERROR") {
      conteo.errores++;
      return;
    }
    if (resultado === "YA_EXISTIA") conteo.yaExistia++;
    else conteo.classroomOk++;

    filasOk.push(item.filaEnr);
    yaProcesados.push(item.email + "→" + item.logKey);
    Logger.log("  ✉️  " + item.email + " → " + item.logKey);
  });

  if (filasOk.length > 0) {
    try {
      var hoja   = memEnr.hoja;
      var ultima = hoja.getLastRow();
      hoja.getRange(ultima + 1, 1, filasOk.length, filasOk[0].length)
          .setValues(filasOk);
      conteo.escritas = filasOk.length;
      Logger.log("  ✅ Enrollments: " + filasOk.length + " filas (1 setValues)");
    } catch (e) {
      throw new Error(
        "ESCRITURA PARCIAL: Invitaciones enviadas para [" +
        yaProcesados.join(" | ") +
        "] pero setValues en Enrollments falló: " + e.message +
        ". Re-ejecutar (409 de Classroom es idempotente)."
      );
    }
  }

  return conteo;
}


// ════════════════════════════════════════════════════════════
// REGISTRO DE MATRÍCULAS SIN CLASSROOM API
// ════════════════════════════════════════════════════════════

/**
 * Escribe las matrículas en Enrollments directamente desde ESTUDIANTES_DATA,
 * SIN llamar a Classroom API ni enviar invitaciones.
 *
 * CUÁNDO USAR:
 *   Cuando la Classroom API falla por restricción de dominio (error
 *   @CannotInviteUserInUntrustedDomain) y se quiere dejar el sistema
 *   en estado consistente para que 18_notificarEstudiantes.gs funcione.
 *   El acceso de los estudiantes al aula se gestiona por link de
 *   enrollmentCode (paso8_notificar), no por invitación API.
 *
 * IDEMPOTENTE: verifica duplicados — re-ejecutar no crea filas repetidas.
 */
function registrarEnrollments() {
  var ahora    = nowSIDEP();
  var ejecutor = Session.getEffectiveUser().getEmail();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    Logger.log("⚠️  Lock ocupado. Espera 30s e intenta de nuevo.");
    return;
  }
  Logger.log("🔐 Lock adquirido");

  var adminSS;
  try {
    Logger.log("════════════════════════════════════════════════");
    Logger.log("📋 SIDEP — registrarEnrollments v1.0");
    Logger.log("   Ejecutor : " + ejecutor);
    Logger.log("════════════════════════════════════════════════");

    adminSS    = getSpreadsheetByName("admin");
    var coreSS = getSpreadsheetByName("core");

    // ── Leer en memoria ───────────────────────────────────────
    var memStu  = _leerHojaEst_(adminSS, "Students");
    var memEnr  = _leerHojaEst_(adminSS, "Enrollments");
    var memDepl = _leerHojaEst_(coreSS,  "MasterDeployments");

    Logger.log("  Students      : " + memStu.datos.length);
    Logger.log("  Enrollments   : " + memEnr.datos.length);
    Logger.log("  Deployments   : " + memDepl.datos.length);

    if (memStu.datos.length === 0) {
      Logger.log("⚠️  Students vacío — ejecutar paso7_importarEstudiantes() primero.");
      return;
    }

    // ── Construir índices ──────────────────────────────────────
    var emailToId  = _construirEmailStudentIdx_(memStu);
    var deplIdx    = _indexarDeployments_Est_(memDepl);
    var enrIdx     = _indexarEnrollments_(memEnr);
    var subjTRV    = _indexarTransversales_();

    // ── Planificar matrículas (mismo algoritmo que _planificarEnrollments_) ──
    var filasNuevas  = [];
    var duplicadas   = 0;
    var omitidas     = 0;

    ESTUDIANTES_DATA.forEach(function(d) {
      var email    = d[2].toLowerCase().trim();
      var progCode = d[5];
      var entryCoh = d[6];
      var subCodes = d[8];

      var studentId = emailToId[email];
      if (!studentId) {
        Logger.log("  ⚠️  Sin StudentID: " + email + " — ¿ejecutaste importarEstudiantes()?");
        omitidas += subCodes.length;
        return;
      }

      subCodes.forEach(function(subjectCode) {
        var deplProg = subjTRV[subjectCode] ? "TRV" : progCode;
        var deplKey  = deplProg + "-" + WINDOW_COHORT_MR26 + "-" +
                       MOMENTO_ACTUAL_MR26 + "-" + subjectCode;
        var depl     = deplIdx[deplKey];

        if (!depl || !depl.id) {
          Logger.log("  ⏭  Aula no encontrada : " + deplKey);
          omitidas++;
          return;
        }
        if (depl.status !== "CREATED") {
          Logger.log("  ⏭  Aula no CREATED    : " + deplKey + " (" + depl.status + ")");
          omitidas++;
          return;
        }

        var enrKey = studentId + "_" + depl.id;
        if (enrIdx[enrKey]) {
          duplicadas++;
          return;
        }

        filasNuevas.push([
          uuid("enr"),
          studentId,
          depl.id,
          "",                  // AperturaID — vacío Fase 1
          entryCoh,            // EntryCohortCode
          WINDOW_COHORT_MR26,  // WindowCohortCode
          MOMENTO_ACTUAL_MR26,
          1,                   // AttemptNumber
          "ACTIVE",
          ahora, ejecutor, ahora, ejecutor
        ]);
      });
    });

    // ── Escribir en batch ──────────────────────────────────────
    if (filasNuevas.length > 0) {
      var hoja   = memEnr.hoja;
      var ultima = hoja.getLastRow();
      hoja.getRange(ultima + 1, 1, filasNuevas.length, filasNuevas[0].length)
          .setValues(filasNuevas);
      Logger.log("  ✅ Enrollments escritas: " + filasNuevas.length + " filas (1 setValues)");
    } else {
      Logger.log("  ⬜ Sin matrículas nuevas que escribir.");
    }

    Logger.log("\n════════════════════════════════════════════════");
    Logger.log("✅ registrarEnrollments completado");
    Logger.log("   Escritas    : " + filasNuevas.length);
    Logger.log("   Duplicadas  : " + duplicadas);
    Logger.log("   Omitidas    : " + omitidas);
    Logger.log("════════════════════════════════════════════════");
    Logger.log("⏭  SIGUIENTE: paso8_notificar() — enviar links a estudiantes");

  } catch (e) {
    Logger.log("❌ ERROR: " + (e.message || String(e)));
    throw e;
  } finally {
    lock.releaseLock();
    Logger.log("🔓 Lock liberado");
  }
}
// ════════════════════════════════════════════════════════════

/**
 * Envía invitación de estudiante vía Classroom.Invitations.create().
 * Mismo patrón que _invitarCoTeacherConRetry_ en 06_importarDocentes.gs.
 * Intentos: 3. Backoff: 5s → 10s → 20s.
 *
 * @returns {string} "OK" | "YA_EXISTIA" | "ERROR"
 */
function _invitarEstudianteConRetry_(classroomId, email, logKey) {
  var esperas = [5000, 10000, 20000];

  for (var intento = 1; intento <= 3; intento++) {
    try {
      Classroom.Invitations.create({
        courseId : classroomId,
        userId   : email,
        role     : "STUDENT"
      });
      return "OK";

    } catch (e) {
      var msg = e.message || String(e);

      // 409 — ya existe invitación o ya es estudiante del aula
      if (msg.indexOf("409") !== -1 || msg.toLowerCase().indexOf("already") !== -1) {
        Logger.log("  ℹ️  Ya invitado/matriculado: " + email + " → " + logKey);
        return "YA_EXISTIA";
      }
      // 429 — rate limit, reintentar
      if (msg.indexOf("429") !== -1 || msg.toLowerCase().indexOf("quota") !== -1) {
        if (intento < 3) {
          Logger.log("  ⏳ Rate limit — intento " + intento + "/3, esperando " +
                     (esperas[intento - 1] / 1000) + "s...");
          Utilities.sleep(esperas[intento - 1]);
          continue;
        }
        Logger.log("  ⛔ Rate limit agotado: " + email + " → " + logKey);
        return "ERROR";
      }
      // 403 — sin permiso sobre el aula
      if (msg.indexOf("403") !== -1 ||
          msg.toLowerCase().indexOf("permission") !== -1) {
        Logger.log("  ⛔ 403 sin permiso: " + email + " → " + logKey +
                   ". ¿El aula fue creada con scontreras@sidep.edu.co?");
        return "ERROR";
      }
      // Error genérico — reintentar
      Logger.log("  ⚠️  Error intento " + intento + "/3 [" + logKey + "]: " + msg);
      if (intento < 3) Utilities.sleep(esperas[intento - 1]);
    }
  }

  Logger.log("  ⛔ Fallaron todos los intentos: " + email + " → " + logKey);
  return "ERROR";
}