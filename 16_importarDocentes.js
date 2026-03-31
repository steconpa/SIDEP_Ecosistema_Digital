// ============================================================
// SIDEP Ecosistema Digital — 06_importarDocentes.gs
// Versión : 8.0.0
// Autor   : Stevens Contreras
// Fecha   : 2026-03-17
//
// CAMBIOS v8 vs v7
// ────────────────────────────────────────────────────────────
// FIX-H (Permisos Classroom — CRÍTICO):
//   Classroom.Courses.Teachers.create() requiere ser domain admin
//   en Google Workspace. La cuenta scontreras@sidep.edu.co no tiene
//   ese permiso → devolvía 403 en toda asignación.
//   Reemplazado por Classroom.Invitations.create({ courseId, userId,
//   role:'TEACHER' }). No requiere permisos de administrador.
//   El docente recibe un email con la invitación y debe ACEPTARLA.
//   Hasta que acepta, el aula no lo muestra como co-teacher activo.
//
// FIX-I (Schema TeacherAssignments — modelo invitaciones):
//   +2 columnas al final del schema (v4.1.0 en 00_SIDEP_CONFIG.gs):
//     InvitationID    — ID retornado por Invitations.create()
//     InvitationStatus — TEACHER_INVITED | TEACHER_ACCEPTED | TEACHER_DECLINED
//   IsActive ahora se escribe como FALSE (pendiente de aceptación).
//   Antes se escribía TRUE sin verificar si el docente ya estaba en el aula.
//
// FIX-J (ASIGNACIONES_DATA — sincronización con cambios MR26/C1M2):
//   Las asignaciones originales referenciaban HID, CRC y EXC — materias
//   ahora CANCELADAS en APERTURA_PLAN. Actualizadas a GDR, SEM y PAI.
//   Las 4 materias fuera de malla (MDA, GEN, RIN, DPW) tienen sección
//   TODO — confirmar docentes con Carlos antes de agregar.
//   El script omite graciosamente cualquier materia sin aula CREATED.
//
// COMPORTAMIENTO POST-INVITACIÓN:
//   1. Este script envía la invitación y registra en TeacherAssignments.
//   2. El docente recibe email → debe click en "Aceptar invitación".
//   3. Una vez aceptada, Classroom lo muestra como co-teacher.
//   4. Actualizar manualmente InvitationStatus → TEACHER_ACCEPTED en Sheets.
//      (Fase 2: trigger automático vía Classroom.Invitations.get(id).)
//   5. Re-ejecutar este script es seguro: 409 de Classroom = ya invitado.
//
// NO CAMBIA vs v7:
//   Arquitectura de fases, memory-first, LockService, retry backoff,
//   _validarEntrada_, _parseFecha_, _leerHojaCompleta_, _escribirTeachers_.
// ============================================================


/**
 * @fileoverview 06_importarDocentes.gs — Importación de docentes y asignaciones.
 *
 * Scopes OAuth requeridos (GAS los detecta automáticamente desde las llamadas
 * a la API, pero se declaran aquí explícitamente para documentación y para
 * forzar su inclusión si el token fue generado antes de agregar Classroom API):
 *
 * @see https://www.googleapis.com/auth/spreadsheets
 * @see https://www.googleapis.com/auth/classroom.courses
 * @see https://www.googleapis.com/auth/classroom.rosters
 * @see https://www.googleapis.com/auth/script.scriptapp
 */

// ════════════════════════════════════════════════════════════
// CONSTANTES LOCALES
// ════════════════════════════════════════════════════════════

// Valores válidos de _CFG_STATUSES WHERE StatusType = 'CONTRACT'
// Fuente: 02_poblarConfiguraciones.gs → poblarStatuses_()
var CONTRATOS_VALIDOS = ["HORA_CATEDRA", "PLANTA"];

// Tipos de documento válidos (definidos en schema de Teachers y Students)
var TIPOS_DOC_VALIDOS = ["CC", "CE", "PAS", "TI"];

// Columnas requeridas en Teachers (CORE) — espeja exactamente CORE_TABLES["Teachers"]
// ContractTypeCode NO existe aquí — vive en TeacherAssignments (ADMIN)
var COLS_REQUERIDAS_TEACHERS = [
  "TeacherID", "FirstName", "LastName", "Email", "Phone",
  "DocumentType", "DocumentNumber", "CampusCode", "TeacherStatusCode",
  "HireDate", "Notes", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy"
];

// Columnas requeridas en TeacherAssignments (ADMIN) — espeja ADMIN_TABLES["TeacherAssignments"]
// v4.1.0: +InvitationID, +InvitationStatus al final
var COLS_REQUERIDAS_ASSIGNMENTS = [
  "AssignmentID", "TeacherID", "DeploymentID", "CampusCode",
  "WeeklyHours", "StartDate", "EndDate", "ContractTypeCode",
  "IsActive", "CreatedAt", "CreatedBy",
  "InvitationID", "InvitationStatus"
];


// ════════════════════════════════════════════════════════════
// DATOS — actualizar y re-ejecutar para futuras cargas
// ════════════════════════════════════════════════════════════

// [Nombres, Apellidos, Email, Teléfono, TipoDoc, NúmDoc, FechaVinc, Contrato, Notas]
var DOCENTES_DATA = [
  ["Carlos Julio",   "Triviño Bohórquez", "carlostrivino@sidep.edu.co",  "+57 314 8770783", "CC", "3109677",    "2025-08-15", "PLANTA",       "CTB, SST, TFG"],
  ["Lady Carolina",  "Restrepo Alfonso",  "crestrepo@sidep.edu.co",      "+57 322 5869643", "CC", "1032420458", "2025-08-15", "HORA_CATEDRA", "MKT"],
  ["Henry Fernando", "Pelayo Arenales",   "henryp@sidep.edu.co",         "+57 324 6671263", "CC", "1005480401", "2025-08-15", "HORA_CATEDRA", "SIS, TRV"],
  ["Martha Cecilia", "Rivera Arévalo",    "mrivera@sidep.edu.co",        "+57 318 5327382", "CC", "51812116",   "2025-08-15", "HORA_CATEDRA", "ADM"],
  ["Natalia Elvira", "Ríos Brissaud",     "nrios@sidep.edu.co",          "+57 310 2793194", "CC", "1032456556", "2025-08-15", "PLANTA",       "TRV"],
  ["Víctor Hugo",    "Bastidas Poveda",   "victorbastidas@sidep.edu.co", "+57 320 8912030", "CC", "80815814",   "2025-08-15", "PLANTA",       "SIS"],
  // NUEVO v8.1 — Yadira Moreno, docente SST (confirmado Carlos 17-mar-2026)
  ["Clara Yadira",   "Moreno Vega",        "clara.moreno@sidep.edu.co",        "+57 312 5599311", "CC", "46373003",   "2026-03-17", "HORA_CATEDRA", "SST"]
];

// [EmailDocente, Programa, CódMateria, Cohorte, Momento, Horas/Sem, FechaInicio, FechaFin]
//
// ACTUALIZADO v8.1 — MR26/C1M2 horario completo confirmado por Carlos (17-mar-2026):
//
//   CORRECCIONES DE HORAS (créditos reales vs lo que teníamos):
//     CTB/SPC: 4h → 3h  |  ADM/GDR: 4h → 2h  |  TRV/MAT: 2h → 3h
//
//   FUERA DE MALLA — docentes confirmados en el horario:
//     ADM/RIN (Martha Rivera, 2h)      ADM/GEN (Carlos Triviño, 2h)
//     SIS/DPW (Henry Pelayo, 3h)       MKT/MDA (Carolina Restrepo, 3h)
//
//   CAMBIO DE DOCENTE:
//     SST/FDR: carlostrivino → ymoreno (Yadira Moreno, nueva docente)
//
//   NUEVA MATERIA COMPARTIDA (tipo TRV):
//     TFG: Carlos Triviño | Miércoles 6-7:30PM | 3 programas (MKT, ADM, SIS)
//     ⚠️  PREREQUISITO: agregar TFG a APERTURA_PLAN antes de importar.
//          Ejecutar paso2b_cambios_MR26_C1M2() (ya incluye la apertura TFG).
//          Si el aula no está CREATED, el script omite esta línea sin error.
//
//   PENDIENTE:
//     TLC/FOT — sin docente asignado en el horario. Confirmar con Carlos.
//
// ► Para agregar futuras asignaciones: agregar fila y re-ejecutar importarDocentes().
//   El script omite graciosamente asignaciones donde el aula no sea CREATED.
var ASIGNACIONES_DATA = [
  // ── CTB ──────────────────────────────────────────────────────────────────
  ["carlostrivino@sidep.edu.co", "CTB", "SPC", "MR26", "C1M2", 3, "2026-03-17", "2026-05-15"],
  // ── ADM ──────────────────────────────────────────────────────────────────
  ["mrivera@sidep.edu.co",       "ADM", "GDR", "MR26", "C1M2", 2, "2026-03-17", "2026-05-15"],
  ["mrivera@sidep.edu.co",       "ADM", "RIN", "MR26", "C1M2", 2, "2026-03-17", "2026-05-15"],  // fuera de malla
  ["carlostrivino@sidep.edu.co", "ADM", "GEN", "MR26", "C1M2", 2, "2026-03-17", "2026-05-15"],  // fuera de malla
  // ── TLC — CANCELADA: no abre en MR26/C1M2 por falta de estudiantes ─────
  // (FOT cancelada en paso2b_cambios_MR26_C1M2 — no agregar asignación)
  // ── SIS ──────────────────────────────────────────────────────────────────
  ["henryp@sidep.edu.co",        "SIS", "PAI", "MR26", "C1M2", 2, "2026-03-17", "2026-05-15"],
  ["henryp@sidep.edu.co",        "SIS", "DPW", "MR26", "C1M2", 3, "2026-03-17", "2026-05-15"],  // fuera de malla
  // ── MKT ──────────────────────────────────────────────────────────────────
  ["crestrepo@sidep.edu.co",     "MKT", "SEM", "MR26", "C1M2", 2, "2026-03-17", "2026-05-15"],
  ["crestrepo@sidep.edu.co",     "MKT", "MDA", "MR26", "C1M2", 3, "2026-03-17", "2026-05-15"],  // fuera de malla
  // ── SST — Yadira Moreno reemplaza a Carlos Triviño ───────────────────────
  ["clara.moreno@sidep.edu.co",       "SST", "FDR", "MR26", "C1M2", 2, "2026-03-17", "2026-05-15"],
  // ── TRV — compartidas todos los programas ────────────────────────────────
  ["nrios@sidep.edu.co",         "TRV", "HIA", "MR26", "C1M2", 2, "2026-03-17", "2026-05-15"],
  ["henryp@sidep.edu.co",        "TRV", "MAT", "MR26", "C1M2", 3, "2026-03-17", "2026-05-15"],
  // TFG — aula compartida (tipo TRV) para MKT + ADM + SIS
  // PREREQUISITO: ejecutar paso2b_cambios_MR26_C1M2() para crear el aula primero.
  ["carlostrivino@sidep.edu.co", "TRV", "TFG", "MR26", "C1M2", 2, "2026-03-17", "2026-05-15"]
  // ► Agregar futuras asignaciones aquí y re-ejecutar
];


// ════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════════════════════

function importarDocentes() {
  var ahora    = nowSIDEP();   // helper de CONFIG — timestamp Bogotá
  // FIX-A: getEffectiveUser — patrón del proyecto en 01→05
  // getActiveUser() puede retornar vacío en triggers o workspace con políticas.
  var usuario  = Session.getEffectiveUser().getEmail() || "script@sidep";
  var tiempoI  = Date.now();
  var lock     = null;
  var logResult = "ERROR";
  var logMsg    = "";
  var conteoFinal = {};

  // ── Lock — previene ejecuciones concurrentes ──────────────
  try {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) {
      Logger.log("⚠️  Lock ocupado — otro usuario está ejecutando importarDocentes(). " +
                 "Espera ~30s e intenta de nuevo.");
      return;
    }
    Logger.log("🔐 Lock adquirido");
  } catch (eLock) {
    Logger.log("⚠️  No se pudo adquirir lock: " + eLock.message);
    return;
  }

  var coreSS, adminSS;
  try {
    Logger.log("══════════════════════════════════════════════");
    Logger.log(" SIDEP · importarDocentes() v7.0 · " + ahora);
    Logger.log("══════════════════════════════════════════════");

    coreSS  = getSpreadsheetByName("core");   // helper de CONFIG
    adminSS = getSpreadsheetByName("admin");  // helper de CONFIG

    // ── FASE 1: Validación de entrada ─────────────────────
    Logger.log("\n── FASE 1/4 · Validación de entrada ──");
    _validarEntrada_();

    // ── FASE 2: Lectura total — 4 llamadas Sheets ─────────
    Logger.log("\n── FASE 2/4 · Lectura en memoria ──");
    var memTeachers = _leerHojaCompleta_(coreSS,  "Teachers");
    var memDepl     = _leerHojaCompleta_(coreSS,  "MasterDeployments");
    var memAsig     = _leerHojaCompleta_(adminSS, "TeacherAssignments");
    var memLogs     = _leerHojaCompleta_(adminSS, "AutomationLogs");
    Logger.log("  Teachers cargados       : " + memTeachers.datos.length);
    Logger.log("  Deployments cargados    : " + memDepl.datos.length);
    Logger.log("  Asignaciones existentes : " + memAsig.datos.length);

    _verificarColumnas_(memTeachers, COLS_REQUERIDAS_TEACHERS);
    _verificarColumnas_(memAsig,     COLS_REQUERIDAS_ASSIGNMENTS);

    // ── FASE 3: Procesamiento en memoria — 0 llamadas API ─
    Logger.log("\n── FASE 3/4 · Procesamiento en memoria ──");

    var planTeachers = _planificarTeachers_(memTeachers, ahora, usuario);
    Logger.log("  Teachers a insertar     : " + planTeachers.inserts.length);
    Logger.log("  Teachers a actualizar   : " + planTeachers.updates.length);

    var emailToId = _construirEmailTeacherIdx_(memTeachers);
    var deplIdx   = _indexarDeployments_(memDepl);
    var asigExist = _indexarAsignacionesExistentes_(memAsig);
    var planAsig  = _planificarAsignaciones_(emailToId, deplIdx, asigExist, ahora, usuario);
    Logger.log("  Asignaciones a crear    : " + planAsig.porCrear.length);
    Logger.log("  Asignaciones duplicadas : " + planAsig.duplicadas);
    Logger.log("  Aulas no CREATED        : " + planAsig.omitidas);

    // ── FASE 4: Escritura ──────────────────────────────────
    Logger.log("\n── FASE 4/4 · Escritura ──");
    _escribirTeachers_(memTeachers, planTeachers);
    var resAsig = _ejecutarAsignaciones_(memAsig, planAsig);

    // ── Resumen ────────────────────────────────────────────
    var duracion = ((Date.now() - tiempoI) / 1000).toFixed(1);
    conteoFinal = {
      teachersInsertados  : planTeachers.inserts.length,
      teachersActualizados: planTeachers.updates.length,
      classroomOk         : resAsig.classroomOk,
      classroomYaExistia  : resAsig.yaExistia,
      asignacionesEscritas: resAsig.escritas,
      asignacionesDupl    : planAsig.duplicadas,
      aulasOmitidas       : planAsig.omitidas,
      erroresClassroom    : resAsig.errores,
      duracionSeg         : duracion
    };

    Logger.log("\n══════════════════════════════════════════════");
    Logger.log(" RESUMEN (" + duracion + "s)");
    Logger.log("  Teachers insertados     : " + conteoFinal.teachersInsertados);
    Logger.log("  Teachers actualizados   : " + conteoFinal.teachersActualizados);
    Logger.log("  Invitaciones enviadas   : " + conteoFinal.classroomOk + " nuevas");
    Logger.log("  Invitaciones ya existían: " + conteoFinal.classroomYaExistia);
    Logger.log("  Asignaciones escritas   : " + conteoFinal.asignacionesEscritas);
    Logger.log("  Asignaciones duplicadas : " + conteoFinal.asignacionesDupl);
    Logger.log("  Aulas omitidas          : " + conteoFinal.aulasOmitidas);
    Logger.log("  Errores Classroom API   : " + conteoFinal.erroresClassroom);
    Logger.log("══════════════════════════════════════════════");
    Logger.log("  ⚠️  SIGUIENTE: los docentes deben ACEPTAR la invitación por email.");
    Logger.log("     Una vez aceptada, actualizar InvitationStatus → TEACHER_ACCEPTED en Sheets.");

    logResult = resAsig.errores > 0 ? "PARTIAL" : "SUCCESS";
    logMsg    = resAsig.errores > 0
      ? resAsig.errores + " asignación(es) fallaron en Classroom API — revisar log"
      : "";

  } catch (e) {
    logResult = "ERROR";
    logMsg    = e.message || String(e);
    Logger.log("\n❌ ERROR FATAL: " + logMsg);
    throw e;

  } finally {
    if (adminSS) {
      try {
        _registrarLog_(adminSS, "SHEETS", "IMPORT_TEACHERS", "importarDocentes",
                       logResult, conteoFinal.asignacionesEscritas || 0, logMsg, ahora, usuario);
      } catch (eLog) {
        Logger.log("⚠️  No se pudo escribir AutomationLog: " + eLog.message);
      }
    }
    if (lock) {
      lock.releaseLock();
      Logger.log("🔓 Lock liberado");
    }
  }
}


// ════════════════════════════════════════════════════════════
// HELPER DE FECHAS
// ════════════════════════════════════════════════════════════

/**
 * Convierte "yyyy-MM-dd" a Date en timezone Bogotá.
 *
 * Usa Utilities.parseDate() + SIDEP_CONFIG.timezone — mismo mecanismo
 * que nowSIDEP() en 00_SIDEP_CONFIG.gs.
 * Evita el bug de new Date("2026-03-17") que en servidores GAS UTC
 * puede retornar el día anterior en Bogotá.
 *
 * NOTA: d_() de 02_poblarConfiguraciones.gs está en scope global pero
 * recibe (year, month, day) por separado — no aplica para strings.
 *
 * @param  {string}  fechaStr    — formato "yyyy-MM-dd"
 * @param  {boolean} obligatoria — si true, lanza Error en vez de retornar ""
 * @returns {Date|string} Date en timezone Bogotá, o "" si fechaStr es vacío
 */
function _parseFecha_(fechaStr, obligatoria) {
  if (!fechaStr) {
    // FIX-G: si la fecha es obligatoria y está vacía, lanzar error explícito
    if (obligatoria) throw new Error("Fecha obligatoria vacía.");
    return "";
  }
  try {
    var d = Utilities.parseDate(
      String(fechaStr).trim(),
      SIDEP_CONFIG.timezone,
      "yyyy-MM-dd"
    );
    if (isNaN(d.getTime())) {
      if (obligatoria) throw new Error("Fecha inválida: '" + fechaStr + "'");
      return "";
    }
    return d;
  } catch (e) {
    if (obligatoria) throw new Error("Error parseando fecha '" + fechaStr + "': " + e.message);
    return "";
  }
}


// ════════════════════════════════════════════════════════════
// FASE 1 — VALIDACIÓN DE ENTRADA
// ════════════════════════════════════════════════════════════

/**
 * Valida DOCENTES_DATA y ASIGNACIONES_DATA antes de tocar Sheets.
 * Si hay cualquier problema lanza Error descriptivo — el script aborta
 * limpiamente y el Lock se libera en el finally.
 *
 * Usa constantes globales del proyecto (00_SIDEP_CONFIG.gs):
 *   TODOS_LOS_PROGRAMAS — programas técnicos activos (incluyendo TRV)
 *   MOMENT_ORDER        — momentos válidos por modalidad
 */
function _validarEntrada_() {
  if (!DOCENTES_DATA || DOCENTES_DATA.length === 0) {
    throw new Error("DOCENTES_DATA está vacío.");
  }
  if (!ASIGNACIONES_DATA || ASIGNACIONES_DATA.length === 0) {
    throw new Error("ASIGNACIONES_DATA está vacío.");
  }

  // ── Validar docentes ──────────────────────────────────────
  var emailsVistos = {};
  DOCENTES_DATA.forEach(function(d, i) {
    var ctx   = "DOCENTES_DATA[" + i + "] (" + (d[2] || "sin email") + ")";
    var email = String(d[2] || "").trim();

    if (!d[0] || !d[1]) {
      throw new Error(ctx + ": Nombres o Apellidos vacíos.");
    }
    if (!email) {
      throw new Error(ctx + ": Email vacío.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(ctx + ": Formato de email inválido.");
    }
    if (emailsVistos[email.toLowerCase()]) {
      throw new Error(ctx + ": Email duplicado en DOCENTES_DATA.");
    }
    emailsVistos[email.toLowerCase()] = true;

    // FIX-C: validar que el tipo de contrato sea uno de los valores definidos
    if (!d[7] || CONTRATOS_VALIDOS.indexOf(d[7]) === -1) {
      throw new Error(ctx + ": Contrato inválido → '" + d[7] + "'. " +
                      "Valores válidos: " + CONTRATOS_VALIDOS.join(", "));
    }
    // Validar tipo de documento
    if (d[4] && TIPOS_DOC_VALIDOS.indexOf(d[4]) === -1) {
      throw new Error(ctx + ": TipoDoc inválido → '" + d[4] + "'. " +
                      "Valores válidos: " + TIPOS_DOC_VALIDOS.join(", "));
    }
    // Validar fecha de vinculación si está presente
    if (d[6] && _parseFecha_(d[6]) === "") {
      throw new Error(ctx + ": FechaVinculación inválida → '" + d[6] + "' (usar yyyy-MM-dd)");
    }
  });

  // ── Validar asignaciones ──────────────────────────────────
  ASIGNACIONES_DATA.forEach(function(a, i) {
    var ctx = "ASIGNACIONES_DATA[" + i + "] (" + (a[0] || "sin email") + ")";

    if (!a[0]) throw new Error(ctx + ": Email vacío.");

    // FIX-D: validar programa contra constante global del proyecto
    if (!a[1] || TODOS_LOS_PROGRAMAS.indexOf(a[1]) === -1) {
      throw new Error(ctx + ": Programa inválido → '" + a[1] + "'. " +
                      "Válidos: " + TODOS_LOS_PROGRAMAS.join(", "));
    }
    if (!a[2]) throw new Error(ctx + ": CódMateria vacío.");
    if (!a[3]) throw new Error(ctx + ": Cohorte vacío.");

    // FIX-D: validar momento contra constante global del proyecto
    if (!a[4] || MOMENT_ORDER[a[4]] === undefined) {
      throw new Error(ctx + ": Momento inválido → '" + a[4] + "'. " +
                      "Válidos: " + Object.keys(MOMENT_ORDER).join(", "));
    }
    if (!a[5] || isNaN(a[5]) || Number(a[5]) < 1) {
      throw new Error(ctx + ": Horas/semana inválidas → '" + a[5] + "'");
    }

    // Validar fechas con _parseFecha_ (timezone seguro)
    var fIni = "", fFin = "";
    if (a[6]) {
      fIni = _parseFecha_(a[6]);
      if (fIni === "") {
        throw new Error(ctx + ": FechaInicio inválida → '" + a[6] + "' (usar yyyy-MM-dd)");
      }
    }
    if (a[7]) {
      fFin = _parseFecha_(a[7]);
      if (fFin === "") {
        throw new Error(ctx + ": FechaFin inválida → '" + a[7] + "' (usar yyyy-MM-dd)");
      }
    }
    // FIX-E: validar rango de fechas
    if (fIni !== "" && fFin !== "" && fFin < fIni) {
      throw new Error(ctx + ": FechaFin (" + a[7] + ") es anterior a FechaInicio (" + a[6] + ")");
    }
  });

  Logger.log("  ✅ Datos válidos (" + DOCENTES_DATA.length +
             " docentes, " + ASIGNACIONES_DATA.length + " asignaciones)");
}

/** Verifica que todas las columnas requeridas existen en la hoja */
function _verificarColumnas_(mem, colsRequeridas) {
  var faltantes = colsRequeridas.filter(function(col) {
    return mem.colIdx[col] === undefined;
  });
  if (faltantes.length > 0) {
    throw new Error(
      "Columnas faltantes en '" + mem.nombreHoja + "': " + faltantes.join(", ") +
      ". ¿Se renombró alguna columna?"
    );
  }
  Logger.log("  ✅ Columnas de Teachers verificadas (" + colsRequeridas.length + " columnas OK)");
}


// ════════════════════════════════════════════════════════════
// FASE 2 — LECTURA
// ════════════════════════════════════════════════════════════

/**
 * Lee toda la hoja en UNA llamada Sheets API.
 * Expone datosOriginalesCount — snapshot antes de cualquier push() posterior.
 *
 * FIX-F: el filtro de filas vacías ahora excluye SOLO filas donde TODAS
 * las celdas son "". La versión anterior usaba `c !== "" && c !== null`,
 * que eliminaba filas válidas con IsActive=false o WeeklyHours=0.
 */
function _leerHojaCompleta_(ss, nombreHoja) {
  var hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) {
    throw new Error(
      "Hoja '" + nombreHoja + "' no encontrada en '" + ss.getName() + "'. " +
      "¿Ejecutaste setupSidepTables()?"
    );
  }

  var lastRow = hoja.getLastRow();
  var lastCol = hoja.getLastColumn();

  if (lastRow === 0 || lastCol === 0) {
    return {
      hoja: hoja, nombreHoja: nombreHoja,
      encabezado: [], datos: [], colIdx: {},
      datosOriginalesCount: 0
    };
  }

  var todo       = hoja.getRange(1, 1, lastRow, lastCol).getValues();
  var encabezado = todo[0];
  var datos      = lastRow > 1 ? todo.slice(1) : [];

  // FIX-F: excluir solo filas donde TODAS las celdas son ""
  // Preserva filas con false, 0, null (valores válidos en columnas bool/num)
  datos = datos.filter(function(fila) {
    return fila.some(function(c) { return c !== ""; });
  });

  var colIdx = {};
  encabezado.forEach(function(nombre, i) {
    if (nombre !== "") colIdx[String(nombre)] = i;
  });

  return {
    hoja: hoja, nombreHoja: nombreHoja,
    encabezado: encabezado, datos: datos, colIdx: colIdx,
    datosOriginalesCount: datos.length   // snapshot inmutable
  };
}


// ════════════════════════════════════════════════════════════
// FASE 3 — PROCESAMIENTO EN MEMORIA
// ════════════════════════════════════════════════════════════

/**
 * Clasifica docentes: UPDATE (modifica mem.datos[]) vs INSERT (acumula inserts).
 * Los inserts se agregan a mem.datos[] con fila COMPLETA (FIX-1 de v6).
 * datosOriginalesCount no se modifica aquí.
 */
function _planificarTeachers_(mem, ahora, usuario) {
  var inserts  = [];
  var updates  = [];
  var emailIdx = {};

  mem.datos.forEach(function(fila, i) {
    var email = String(fila[mem.colIdx["Email"]] || "").toLowerCase().trim();
    if (email) emailIdx[email] = i;
  });

  DOCENTES_DATA.forEach(function(d) {
    var email    = d[2].toLowerCase().trim();
    var hireDate = _parseFecha_(d[6]);

    if (emailIdx.hasOwnProperty(email)) {
      var i = emailIdx[email];
      var c = mem.colIdx;
      mem.datos[i][c["FirstName"]]        = d[0];
      mem.datos[i][c["LastName"]]         = d[1];
      mem.datos[i][c["Phone"]]            = d[3];
      mem.datos[i][c["DocumentType"]]     = d[4];
      mem.datos[i][c["DocumentNumber"]]   = d[5];
      mem.datos[i][c["HireDate"]]         = hireDate;
      mem.datos[i][c["Notes"]]            = d[8];
      mem.datos[i][c["UpdatedAt"]]        = ahora;
      mem.datos[i][c["UpdatedBy"]]        = usuario;
      updates.push({ filaIdx: i, email: d[2] });
      Logger.log("  ↺ (mem) Actualizar : " + d[2]);

    } else {
      var newId    = uuid("tch");
      var c        = mem.colIdx;
      var nuevaFila = new Array(mem.encabezado.length).fill("");
      nuevaFila[c["TeacherID"]]         = newId;
      nuevaFila[c["FirstName"]]         = d[0];
      nuevaFila[c["LastName"]]          = d[1];
      nuevaFila[c["Email"]]             = d[2];
      nuevaFila[c["Phone"]]             = d[3];
      nuevaFila[c["DocumentType"]]      = d[4];
      nuevaFila[c["DocumentNumber"]]    = d[5];
      nuevaFila[c["CampusCode"]]        = SIDEP_CONFIG.defaultCampus;
      nuevaFila[c["TeacherStatusCode"]] = "TEACHER_ACTIVE";
      nuevaFila[c["HireDate"]]          = hireDate;
      nuevaFila[c["Notes"]]             = d[8];
      nuevaFila[c["CreatedAt"]]         = ahora;
      nuevaFila[c["CreatedBy"]]         = usuario;
      nuevaFila[c["UpdatedAt"]]         = ahora;
      nuevaFila[c["UpdatedBy"]]         = usuario;

      inserts.push(nuevaFila);
      mem.datos.push(nuevaFila);   // fila completa en memoria (v6 FIX-1)
      Logger.log("  + (mem) Insertar   : " + d[2]);
    }
  });

  return { inserts: inserts, updates: updates };
}

/** Índice email → teacherId desde datos[] ya modificados */
function _construirEmailTeacherIdx_(mem) {
  var idx = {};
  mem.datos.forEach(function(fila) {
    var email = String(fila[mem.colIdx["Email"]]     || "").toLowerCase().trim();
    var id    = String(fila[mem.colIdx["TeacherID"]] || "").trim();
    if (email && id) idx[email] = id;
  });
  return idx;
}

/**
 * Índice "PROG-COH-MOM-COD" → { id, classroomId, status }
 * Nomenclatura: PROG-DIR|ART-COH-MOM-COD-GRP → segmentos [0,1,2,3,4,5]
 * Clave usa [0],[2],[3],[4] (omite tipo y grupo).
 */
function _indexarDeployments_(mem) {
  var idCol  = mem.colIdx["DeploymentID"];
  var nomCol = mem.colIdx["GeneratedNomenclature"];
  var cidCol = mem.colIdx["ClassroomID"];
  var stCol  = mem.colIdx["ScriptStatusCode"];

  if ([idCol, nomCol, cidCol, stCol].some(function(c) { return c === undefined; })) {
    throw new Error("MasterDeployments: columnas requeridas faltantes — revisar encabezados.");
  }

  var idx = {};
  mem.datos.forEach(function(fila) {
    var nom    = String(fila[nomCol] || "").trim();
    var id     = String(fila[idCol]  || "").trim();
    var cid    = String(fila[cidCol] || "").trim();
    var status = String(fila[stCol]  || "").trim();
    if (!nom || !id) return;
    var segs = nom.split("-");
    if (segs.length >= 5) {
      idx[segs[0] + "-" + segs[2] + "-" + segs[3] + "-" + segs[4]] =
        { id: id, classroomId: cid, status: status };
    }
  });
  return idx;
}

/** Índice "teacherId_deployId" → true para deduplicar asignaciones */
function _indexarAsignacionesExistentes_(mem) {
  var idx    = {};
  var tchCol = mem.colIdx["TeacherID"];
  var depCol = mem.colIdx["DeploymentID"];
  if (tchCol === undefined || depCol === undefined) return idx;
  mem.datos.forEach(function(fila) {
    var t = String(fila[tchCol] || "").trim();
    var d = String(fila[depCol] || "").trim();
    if (t && d) idx[t + "_" + d] = true;
  });
  return idx;
}

/**
 * Clasifica asignaciones: porCrear / duplicadas / omitidas.
 * Pre-construye filaSheets para escritura batch.
 */
function _planificarAsignaciones_(emailToId, deplIdx, asigExist, ahora, usuario) {
  var porCrear   = [];
  var duplicadas = 0;
  var omitidas   = 0;

  // Índice email→contrato para O(1) — evita loop anidado en forEach
  var emailAContrato = {};
  DOCENTES_DATA.forEach(function(d) {
    emailAContrato[d[2].toLowerCase().trim()] = d[7];
  });

  ASIGNACIONES_DATA.forEach(function(a) {
    var email   = a[0].toLowerCase().trim();
    var prog    = a[1], cod = a[2], cohorte = a[3], mom = a[4];

    var teacherId = emailToId[email];
    if (!teacherId) {
      Logger.log("  ⛔ Sin TeacherID: " + a[0] + " — omitida " + prog + "-" + cod);
      omitidas++;
      return;
    }

    var deplKey = prog + "-" + cohorte + "-" + mom + "-" + cod;
    var depl    = deplIdx[deplKey];

    if (!depl) {
      Logger.log("  ⏭  Aula no encontrada  : " + deplKey);
      omitidas++;
      return;
    }
    if (depl.status !== "CREATED") {
      Logger.log("  ⏭  Aula no CREATED     : " + deplKey + " (" + depl.status + ")");
      omitidas++;
      return;
    }

    var asigKey = teacherId + "_" + depl.id;
    if (asigExist[asigKey]) {
      Logger.log("  ~  Duplicada          : " + a[0] + " → " + cod +
                 " [" + cohorte + " " + mom + "]");
      duplicadas++;
      return;
    }

    porCrear.push({
      email       : a[0],
      teacherId   : teacherId,
      deplId      : depl.id,
      classroomId : depl.classroomId,
      logKey      : prog + "-" + cod + " [" + cohorte + " " + mom + "]",
      // filaBase sin InvitationID — se completa en _ejecutarAsignaciones_
      // tras recibir la respuesta de Classroom.Invitations.create().
      // IsActive = false: el docente debe ACEPTAR la invitación por email
      // antes de ser co-teacher activo en el aula.
      filaBase    : [
        uuid("asg"),
        teacherId,
        depl.id,
        SIDEP_CONFIG.defaultCampus,
        a[5],
        _parseFecha_(a[6]),
        _parseFecha_(a[7]),
        emailAContrato[email] || "",
        false,   // IsActive: false hasta aceptación de invitación
        ahora,
        usuario
        // InvitationID e InvitationStatus se agregan en _ejecutarAsignaciones_
      ]
    });
  });

  return { porCrear: porCrear, duplicadas: duplicadas, omitidas: omitidas };
}


// ════════════════════════════════════════════════════════════
// FASE 4 — ESCRITURA
// ════════════════════════════════════════════════════════════

/**
 * Escribe Teachers — máximo 2 llamadas setValues().
 * Usa datosOriginalesCount (snapshot v6 FIX-2) para el rango de updates,
 * independiente de cuántos push() se hayan hecho después.
 */
function _escribirTeachers_(mem, plan) {
  var hoja = mem.hoja;

  if (plan.updates.length > 0 && mem.datosOriginalesCount > 0) {
    try {
      hoja.getRange(2, 1, mem.datosOriginalesCount, mem.encabezado.length)
          .setValues(mem.datos.slice(0, mem.datosOriginalesCount));
      Logger.log("  ✅ Teachers updates: " + plan.updates.length +
                 " (" + mem.datosOriginalesCount + " filas, 1 setValues)");
    } catch (e) {
      throw new Error("Error escribiendo updates en Teachers: " + e.message);
    }
  }

  if (plan.inserts.length > 0) {
    try {
      var ultimaFila = hoja.getLastRow();
      hoja.getRange(ultimaFila + 1, 1, plan.inserts.length, plan.inserts[0].length)
          .setValues(plan.inserts);
      Logger.log("  ✅ Teachers inserts: " + plan.inserts.length + " (1 setValues)");
    } catch (e) {
      throw new Error("Error escribiendo inserts en Teachers: " + e.message);
    }
  }
}

/**
 * Classroom API (Invitations) + escritura batch de TeacherAssignments.
 *
 * Flujo por asignación:
 *   1. Classroom.Invitations.create({ courseId, userId, role:'TEACHER' })
 *   2. El docente recibe email → debe aceptar manualmente.
 *   3. InvitationID se guarda en TeacherAssignments para referencia futura.
 *   4. IsActive = false hasta aceptación (reflejo honesto del estado).
 *
 * Solo escribe en Sheets DESPUÉS de procesar todas las llamadas Classroom.
 * Si setValues() falla, lanza Error con lista de combinaciones ya invitadas
 * para facilitar diagnóstico y recovery.
 * Re-ejecutar es idempotente: 409 de Classroom = invitación ya enviada.
 */
function _ejecutarAsignaciones_(memAsig, plan) {
  var conteo = { classroomOk: 0, yaExistia: 0, escritas: 0, errores: 0 };
  var filasAprobadas         = [];
  var classroomYaProcesados  = [];

  plan.porCrear.forEach(function(asig) {
    var resultado = _invitarCoTeacherConRetry_(asig.classroomId, asig.email, asig.logKey);

    if (resultado.estado === "ERROR") {
      conteo.errores++;
      return;
    }
    if (resultado.estado === "YA_EXISTIA") conteo.yaExistia++;
    else conteo.classroomOk++;

    // Completar filaSheets con InvitationID e InvitationStatus
    var filaCompleta = asig.filaBase.concat([
      resultado.invitationId,    // InvitationID — vacío si YA_EXISTIA
      "TEACHER_INVITED"          // InvitationStatus — ref _CFG_STATUSES (INVITATION)
    ]);

    filasAprobadas.push(filaCompleta);
    classroomYaProcesados.push(asig.email + "→" + asig.logKey);
    Logger.log("  ✉️  " + asig.email + " → " + asig.logKey +
               (resultado.invitationId ? " (inv:" + resultado.invitationId + ")" : " (ya existía)"));
  });

  if (filasAprobadas.length > 0) {
    try {
      var hoja       = memAsig.hoja;
      var ultimaFila = hoja.getLastRow();
      hoja.getRange(ultimaFila + 1, 1, filasAprobadas.length, filasAprobadas[0].length)
          .setValues(filasAprobadas);
      conteo.escritas = filasAprobadas.length;
      Logger.log("  ✅ TeacherAssignments: " + filasAprobadas.length + " filas (1 setValues)");
      Logger.log("  ⚠️  Los docentes deben ACEPTAR la invitación por email.");
      Logger.log("     Hasta que acepten, el aula no los muestra como co-teachers.");
    } catch (e) {
      throw new Error(
        "ESCRITURA PARCIAL: Invitaciones Classroom enviadas para [" +
        classroomYaProcesados.join(" | ") +
        "] pero setValues en TeacherAssignments falló: " + e.message +
        ". Re-ejecutar (409 de Classroom es idempotente — no se duplican invitaciones)."
      );
    }
  }

  return conteo;
}


// ════════════════════════════════════════════════════════════
// CLASSROOM API — Invitaciones con retry y backoff exponencial
// ════════════════════════════════════════════════════════════

/**
 * Envía invitación de co-teacher vía Classroom.Invitations.create().
 * No requiere permisos de domain admin — funciona con cuenta normal.
 *
 * DIFERENCIA VS Teachers.create():
 *   Teachers.create() → agrega directo, requiere admin. 403 sin admin.
 *   Invitations.create() → envía email al docente, él debe ACEPTAR.
 *   El docente NO aparece en el aula hasta que acepta la invitación.
 *
 * Retorna un objeto { estado, invitationId }:
 *   estado = "OK"         → invitación enviada, invitationId válido
 *   estado = "YA_EXISTIA" → ya había invitación pendiente (409), invitationId = ""
 *   estado = "ERROR"      → falló después de 3 intentos, invitationId = ""
 *
 * Intentos: 3. Backoff: 5s → 10s → 20s.
 * Solo reintenta en 429 (rate limit). Otros errores abortan inmediatamente.
 *
 * @param  {string} classroomId — ID del curso en Classroom
 * @param  {string} email       — email del docente a invitar
 * @param  {string} logKey      — etiqueta legible para el Logger
 * @returns {{ estado: string, invitationId: string }}
 */
function _invitarCoTeacherConRetry_(classroomId, email, logKey) {
  var esperas = [5000, 10000, 20000];

  for (var intento = 1; intento <= 3; intento++) {
    try {
      var invitacion = Classroom.Invitations.create({
        courseId : classroomId,
        userId   : email,
        role     : "TEACHER"
      });

      Logger.log("  ✉️  Invitación enviada : " + email + " → " + logKey +
                 " (id:" + invitacion.id + ")");
      return { estado: "OK", invitationId: invitacion.id };

    } catch (e) {
      var msg = e.message || String(e);

      // 409 — ya existe una invitación pendiente para este docente en esta aula.
      // Idempotente: no reintentar. Puede ocurrir si se re-ejecuta el script.
      if (msg.indexOf("409") !== -1 || msg.toLowerCase().indexOf("already") !== -1) {
        Logger.log("  ℹ️  Invitación ya existe: " + email + " → " + logKey);
        return { estado: "YA_EXISTIA", invitationId: "" };
      }

      // 429 — rate limit de la API. Esperar y reintentar.
      if (msg.indexOf("429") !== -1 || msg.toLowerCase().indexOf("quota") !== -1) {
        if (intento < 3) {
          Logger.log("  ⏳ Rate limit — intento " + intento + "/3, esperando " +
                     (esperas[intento - 1] / 1000) + "s...");
          Utilities.sleep(esperas[intento - 1]);
          continue;
        }
        Logger.log("  ⛔ Rate limit agotado: " + email + " → " + logKey);
        return { estado: "ERROR", invitationId: "" };
      }

      // 403 — sin permisos sobre el aula. No tiene sentido reintentar.
      // Causa más común: el aula no fue creada por scontreras@sidep.edu.co.
      if (msg.indexOf("403") !== -1 ||
          msg.toLowerCase().indexOf("does not have permission") !== -1 ||
          msg.toLowerCase().indexOf("permission") !== -1) {
        Logger.log("  ⛔ 403 sin permiso: " + email + " → " + logKey +
                   ". ¿El aula fue creada con scontreras@sidep.edu.co?");
        return { estado: "ERROR", invitationId: "" };
      }

      // Error genérico — reintentar si quedan intentos.
      Logger.log("  ⚠️  Error intento " + intento + "/3 [" + logKey + "]: " + msg);
      if (intento < 3) Utilities.sleep(esperas[intento - 1]);
    }
  }

  Logger.log("  ⛔ Fallaron todos los intentos: " + email + " → " + logKey);
  return { estado: "ERROR", invitationId: "" };
}


// ════════════════════════════════════════════════════════════
// AUTOMATION LOGS
// ════════════════════════════════════════════════════════════

/**
 * Registra el resultado en AutomationLogs (siempre — éxito, parcial o error).
 * Orden exacto de ADMIN_TABLES["AutomationLogs"]:
 *   LogID, System, Action, Origin, Result,
 *   RecordsProcessed, ErrorMessage, ExecutedAt, ExecutedBy
 */
function _registrarLog_(adminSS, sistema, accion, origen, resultado,
                         registros, errorMsg, ahora, usuario) {
  var hoja = adminSS.getSheetByName("AutomationLogs");
  if (!hoja) return;
  hoja.appendRow([
    uuid("log"), sistema, accion, origen,
    resultado, registros, errorMsg || "",
    ahora, usuario
  ]);
}