/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 21c_panelAcademico_datos.js
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Carga de contexto (datos) y funciones de dashboard del Panel Académico.
 *   Contiene el cargador de memoria (_cargarContextoPanel_) y todas las
 *   funciones privadas que escriben las vistas del panel.
 *
 * FUNCIONES:
 *   _cargarContextoPanel_()                         → carga datos en memoria (1 llamada por SS)
 *   _momentSortKey_(momentCode)                     → key de ordenación curricular
 *   _poblarHojaResumen_(panelSS, ctx, ahora)        → escribe SEMAFORO_RESUMEN
 *   _poblarHojaDetalle_(panelSS, programCode, ctx)  → escribe DETALLE_{PROG}
 *   _actualizarListaBoletin_(panelSS, ctx)          → dropdown de estudiantes en BOLETIN
 *   _poblarHojaResumenPendientes_(panelSS, hoja, ctx, filtro, ahora) → PENDIENTES_POR_PROGRAMA
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.js  → SIDEP_CONFIG, nowSIDEP()
 *   02_SIDEP_HELPERS.js → getSpreadsheetByName(), _leerHoja_()
 *   20_semaforo.js      → _resolverCfg_(), _calcularSemaforo_(), _calcularNivel_()
 *   21_panelAcademico.js → PANEL_CONFIG (scope global GAS)
 *   21d_panelAcademico_boletin.js → _getMejorNotaInfo_(), _calcularCreditos_(),
 *                                    _calcularPromedioPanel_(), _colorSemaforo_()
 *
 * VERSIÓN: 1.0.0
 * AUTOR: Stevens Contreras
 * FECHA: 2026-05-24
 * ============================================================
 */


// ─────────────────────────────────────────────────────────────
// SECCIÓN 3: CARGA DE CONTEXTO
// ─────────────────────────────────────────────────────────────

/**
 * Carga en memoria todo lo necesario para el panel académico.
 * Abre cada spreadsheet una sola vez.
 *
 * @returns {object} ctx — contexto completo del panel
 */
function _cargarContextoPanel_() {
  var coreSS  = getSpreadsheetByName("core");
  var adminSS = getSpreadsheetByName("admin");
  var biSS    = getSpreadsheetByName("bi");

  // ── CORE: subjects ────────────────────────────────────────────
  var subjectsMem = _leerHoja_(coreSS.getSheetByName("_CFG_SUBJECTS"));
  var subjectsIdx = subjectsMem.idx;

  var subjects         = {};
  var subjectsByProgram= {};
  var trvSubjects      = [];

  subjectsMem.datos.forEach(function(row) {
    var code    = String(row[subjectsIdx["SubjectCode"]] || "").trim();
    var prog    = String(row[subjectsIdx["ProgramCode"]] || "").trim();
    var activo  = row[subjectsIdx["IsActive"]];
    var isActive= (activo === true || String(activo).toUpperCase() === "TRUE");

    if (!code || !isActive) return;

    subjects[code] = row;

    if (prog === "TRV") {
      trvSubjects.push(row);
    } else {
      if (!subjectsByProgram[prog]) subjectsByProgram[prog] = [];
      subjectsByProgram[prog].push(row);
    }
  });

  // Ordenar asignaturas por momento curricular
  var iDirStart = subjectsIdx["DirStartMoment"];
  var iArtStart = subjectsIdx["ArtStartBlock"];

  function sortSubjects(arr) {
    return arr.sort(function(a, b) {
      var kA = _momentSortKey_(String(a[iDirStart] || "")) || _momentSortKey_(String(a[iArtStart] || ""));
      var kB = _momentSortKey_(String(b[iDirStart] || "")) || _momentSortKey_(String(b[iArtStart] || ""));
      return kA - kB;
    });
  }

  Object.keys(subjectsByProgram).forEach(function(prog) {
    subjectsByProgram[prog] = sortSubjects(subjectsByProgram[prog]);
  });
  trvSubjects = sortSubjects(trvSubjects);

  // ── CORE: programas ───────────────────────────────────────────
  var programsMem = _leerHoja_(coreSS.getSheetByName("_CFG_PROGRAMS"));
  var programsIdx = programsMem.idx;
  var programs    = {};
  programsMem.datos.forEach(function(row) {
    var code = String(row[programsIdx["ProgramCode"]] || "").trim();
    if (code) programs[code] = row;
  });

  // ── CORE: cohortes ────────────────────────────────────────────
  var cohortsMem = _leerHoja_(coreSS.getSheetByName("_CFG_COHORTS"));
  var cohortsIdx = cohortsMem.idx;
  var cohorts    = {};
  cohortsMem.datos.forEach(function(row) {
    var code = String(row[cohortsIdx["CohortCode"]] || "").trim();
    if (code) cohorts[code] = row;
  });

  // ── CORE: cfg semaforo ────────────────────────────────────────
  var cfgMem = _leerHoja_(coreSS.getSheetByName("_CFG_SEMAFORO"));
  var cfg    = _resolverCfg_(cfgMem);

  // ── ADMIN: students ───────────────────────────────────────────
  var studentsMem     = _leerHoja_(adminSS.getSheetByName("Students"));
  var studentsIdx     = studentsMem.idx;
  var students        = {};
  var studentsByProgram = {};

  studentsMem.datos.forEach(function(row) {
    var id   = String(row[studentsIdx["StudentID"]]   || "").trim();
    var prog = String(row[studentsIdx["ProgramCode"]] || "").trim();
    if (!id) return;
    students[id] = row;
    if (!studentsByProgram[prog]) studentsByProgram[prog] = [];
    studentsByProgram[prog].push(id);
  });

  // ── ADMIN: GradeHistory ───────────────────────────────────────
  var ghMem     = _leerHoja_(adminSS.getSheetByName("GradeHistory"));
  var ghIdx     = ghMem.idx;
  var gradeHistoryKeys = {};
  var bestGrades       = {};

  ghMem.datos.forEach(function(row) {
    var sid    = String(row[ghIdx["StudentID"]]   || "").trim();
    var subj   = String(row[ghIdx["SubjectCode"]] || "").trim();
    var nota   = Number(row[ghIdx["Nota"]]);
    var nivel  = String(row[ghIdx["Nivel"]]       || "").trim();
    var estado = String(row[ghIdx["Estado"]]      || "").trim();

    if (!sid || !subj) return;

    var key = sid + "|" + subj;
    gradeHistoryKeys[key] = true;

    if (!isNaN(nota)) {
      if (!bestGrades[key] || nota > bestGrades[key].nota) {
        bestGrades[key] = { nota: nota, nivel: nivel, estado: estado };
      }
    }
  });

  // ── BI: GradeAudit ────────────────────────────────────────────
  var gaMem   = _leerHoja_(biSS.getSheetByName("GradeAudit"));
  var gaIdx   = gaMem.idx;
  var gradeAudit = {};

  gaMem.datos.forEach(function(row) {
    var sid  = String(row[gaIdx["StudentID"]]   || "").trim();
    var subj = String(row[gaIdx["SubjectCode"]] || "").trim();
    if (!sid || !subj) return;
    var key = sid + "|" + subj;
    gradeAudit[key] = row;
  });

  // ── CORE: MasterDeployments (para resolver SubjectCode de aulas activas) ──
  // Indexamos solo deployments con ScriptStatusCode = "CREATED" — el resto
  // (PENDING/ARCHIVED/ERROR) no se considera aula activa para clasificar
  // matrículas como "EN CURSO" en el boletín.
  var deployMem = _leerHoja_(coreSS.getSheetByName("MasterDeployments"));
  var depIdx    = deployMem.idx;
  var deployToSubject = {};   // { deploymentId: subjectCode }

  deployMem.datos.forEach(function(row) {
    var depId  = String(row[depIdx["DeploymentID"]]      || "").trim();
    var subj   = String(row[depIdx["SubjectCode"]]       || "").trim();
    var status = String(row[depIdx["ScriptStatusCode"]]  || "").trim();
    if (depId && subj && status === "CREATED") {
      deployToSubject[depId] = subj;
    }
  });

  // ── ADMIN: Enrollments (ventana actual + asignaturas en curso) ────
  // currentWindow[studentId]    = WindowCohortCode (uno solo, la ventana activa)
  // currentSubjects[studentId]  = { subjectCode: true } — asignaturas que el
  //   estudiante está cursando AHORA (Enrollment ACTIVE × Deployment CREATED).
  //   Se usa en el boletín y DETALLE_* para clasificar como EN CURSO sin
  //   importar si la materia ya tiene nota provisional o no.
  var enrollMem      = _leerHoja_(adminSS.getSheetByName("Enrollments"));
  var enrollIdx      = enrollMem.idx;
  var currentWindow  = {};
  var currentSubjects= {};

  enrollMem.datos.forEach(function(row) {
    var sid    = String(row[enrollIdx["StudentID"]]            || "").trim();
    var window = String(row[enrollIdx["WindowCohortCode"]]     || "").trim();
    var status = String(row[enrollIdx["EnrollmentStatusCode"]] || "").trim();
    var depId  = String(row[enrollIdx["DeploymentID"]]         || "").trim();

    if (!sid || status !== "ACTIVE") return;

    if (window) currentWindow[sid] = window;

    var subj = deployToSubject[depId];   // solo definido si Deployment está CREATED
    if (subj) {
      if (!currentSubjects[sid]) currentSubjects[sid] = {};
      currentSubjects[sid][subj] = true;
    }
  });

  return {
    students:         students,
    studentsIdx:      studentsIdx,
    studentsByProgram:studentsByProgram,
    subjects:         subjects,
    subjectsIdx:      subjectsIdx,
    subjectsByProgram:subjectsByProgram,
    trvSubjects:      trvSubjects,
    programs:         programs,
    programsIdx:      programsIdx,
    cohorts:          cohorts,
    cohortsIdx:       cohortsIdx,
    gradeHistoryKeys: gradeHistoryKeys,
    bestGrades:       bestGrades,
    gradeAudit:       gradeAudit,
    gradeAuditIdx:    gaIdx,         // índices de columnas de GradeAudit (cache)
    currentWindow:    currentWindow,
    currentSubjects:  currentSubjects, // { studentId: { subjectCode: true } } — matrículas activas
    cfg:              cfg,
    coreSS:           coreSS,
    adminSS:          adminSS,
    biSS:             biSS
  };
}


/**
 * Retorna un número de ordenación para un código de momento académico.
 * Permite ordenar asignaturas en orden curricular lógico.
 *
 * @param {string} momentCode — C1M1, A1B2, etc.
 * @returns {number}
 */
function _momentSortKey_(momentCode) {
  var mapa = {
    C1M1: 10, C1M2: 20, C2M1: 30, C2M2: 40, C3M1: 50, C3M2: 60,
    A1B1: 110, A1B2: 120, A1B3: 130, A1B4: 140,
    A2B1: 210, A2B2: 220, A2B3: 230, A2B4: 240
  };
  return mapa[String(momentCode).trim()] || 999;
}


// ─────────────────────────────────────────────────────────────
// SECCIÓN 4: FUNCIONES DE DASHBOARD
// ─────────────────────────────────────────────────────────────

/**
 * Pobla la hoja SEMAFORO_RESUMEN con una fila por estudiante activo.
 *
 * @param {Spreadsheet} panelSS — spreadsheet del panel
 * @param {object}      ctx     — contexto del panel
 * @param {Date}        ahora   — timestamp
 */
function _poblarHojaResumen_(panelSS, ctx, ahora) {
  var hoja = panelSS.getSheetByName("SEMAFORO_RESUMEN");
  if (!hoja) return;

  // Limpiar datos (conservar fila 1)
  var lastRow = hoja.getLastRow();
  if (lastRow > 1) {
    hoja.getRange(2, 1, lastRow - 1, 10).clearContent().clearFormat();
  }

  var stIdx   = ctx.studentsIdx;
  var progIdx = ctx.programsIdx;
  var filas   = [];
  var colores = [];

  Object.keys(ctx.students).forEach(function(studentId) {
    var student     = ctx.students[studentId];
    var progCode    = String(student[stIdx["ProgramCode"]]      || "").trim();
    var status      = String(student[stIdx["StudentStatusCode"]]|| "").trim();
    if (status !== "ACTIVE") return;

    var firstName   = String(student[stIdx["FirstName"]] || "").trim();
    var lastName    = String(student[stIdx["LastName"]]  || "").trim();
    var nombre      = (firstName + " " + lastName).trim();
    var cedula      = String(student[stIdx["DocumentNumber"]] || "").trim();
    var tipo        = String(student[stIdx["StudentType"]]    || "").trim();
    var cohort      = String(student[stIdx["CohortCode"]]     || "").trim();
    var ventana     = ctx.currentWindow[studentId] || "";

    var progRow     = ctx.programs[progCode];
    var progNombre  = progRow ? String(progRow[progIdx["ProgramName"]] || progCode).trim() : progCode;

    var credInfo    = _calcularCreditos_(studentId, progCode, ctx);
    var promedio    = _calcularPromedioPanel_(studentId, progCode, ctx);
    var colorSem    = promedio !== null ? _calcularSemaforo_(promedio, ctx.cfg) : "GREY";

    filas.push([
      nombre,
      cedula,
      progNombre,
      tipo,
      cohort,
      ventana,
      credInfo.completados + "/" + credInfo.total,
      credInfo.total > 0 ? Math.round(credInfo.porcentaje) + "%" : "0%",
      promedio !== null ? promedio : "",
      colorSem
    ]);
    colores.push(colorSem);
  });

  if (filas.length === 0) return;

  hoja.getRange(2, 1, filas.length, 10).setValues(filas);

  // Colorear columna de Estado General (col 10)
  colores.forEach(function(color, i) {
    hoja.getRange(i + 2, 10).setBackground(_colorSemaforo_(color));
  });
}


/**
 * Pobla la hoja DETALLE_{programCode} con la vista matricial del programa.
 *
 * @param {Spreadsheet} panelSS     — spreadsheet del panel
 * @param {string}      programCode — código del programa
 * @param {object}      ctx         — contexto del panel
 */
function _poblarHojaDetalle_(panelSS, programCode, ctx) {
  var hoja = panelSS.getSheetByName("DETALLE_" + programCode);
  if (!hoja) return;

  hoja.clear();
  hoja.setTabColor("#ff6d00");

  var subjectsProg = ctx.subjectsByProgram[programCode] || [];
  var trvSubjects  = ctx.trvSubjects;
  var allSubjects  = subjectsProg.concat(trvSubjects);
  var sIdx         = ctx.subjectsIdx;
  var stIdx        = ctx.studentsIdx;

  if (allSubjects.length === 0) return;

  // Construir headers
  var headers = ["Nombre", "Cédula", "Tipo", "Cohorte Entrada", "Ventana Actual"];
  allSubjects.forEach(function(sub) {
    headers.push(String(sub[sIdx["SubjectCode"]] || "").trim());
  });
  headers.push("% Avance", "Promedio Acum.", "Estado General");

  var numCols = headers.length;
  hoja.getRange(1, 1, 1, numCols).setValues([headers])
    .setBackground(PANEL_CONFIG.COLOR.HEADER)
    .setFontColor("#ffffff")
    .setFontWeight("bold");

  // Colorear encabezados TRV
  var offsetTRV = 5 + subjectsProg.length + 1; // 1-indexed
  for (var t = 0; t < trvSubjects.length; t++) {
    hoja.getRange(1, offsetTRV + t).setBackground(PANEL_CONFIG.COLOR.TRV).setFontColor("#1a237e");
  }

  // Obtener estudiantes del programa
  var studentIds = ctx.studentsByProgram[programCode] || [];
  if (studentIds.length === 0) {
    hoja.setFrozenRows(1);
    hoja.setFrozenColumns(2);
    return;
  }

  var filas       = [];
  var bgColors    = [];  // 2D array de backgrounds

  studentIds.forEach(function(studentId) {
    var student = ctx.students[studentId];
    if (!student) return;

    var statusCode = String(student[stIdx["StudentStatusCode"]] || "").trim();
    if (statusCode !== "ACTIVE") return;

    var firstName = String(student[stIdx["FirstName"]] || "").trim();
    var lastName  = String(student[stIdx["LastName"]]  || "").trim();
    var nombre    = (firstName + " " + lastName).trim();
    var cedula    = String(student[stIdx["DocumentNumber"]] || "").trim();
    var tipo      = String(student[stIdx["StudentType"]]    || "").trim();
    var cohort    = String(student[stIdx["CohortCode"]]     || "").trim();
    var ventana   = ctx.currentWindow[studentId] || "";

    var fila   = [nombre, cedula, tipo, cohort, ventana];
    var bgFila = [
      PANEL_CONFIG.COLOR.LOCKED, PANEL_CONFIG.COLOR.LOCKED,
      PANEL_CONFIG.COLOR.LOCKED, PANEL_CONFIG.COLOR.LOCKED,
      PANEL_CONFIG.COLOR.LOCKED
    ];

    var enCursoMap = ctx.currentSubjects[studentId] || {};
    allSubjects.forEach(function(sub) {
      var subCode = String(sub[sIdx["SubjectCode"]] || "").trim();
      var info    = _getMejorNotaInfo_(studentId, subCode, ctx);
      var enCurso = enCursoMap[subCode] === true;

      // Valor de la celda
      fila.push(info.nota !== null ? info.nota : "");

      // Color de fondo — semántica triple:
      //   • Definitiva (MANUAL): color del semáforo según nota
      //   • En curso (matrícula activa, con o sin nota): azul claro
      //   • Sin datos (no la cursa, no la ha cursado): gris
      var bg;
      if (info.fuente === "MANUAL")             bg = _colorSemaforo_(info.color);
      else if (info.isInProgress || enCurso)    bg = PANEL_CONFIG.COLOR.IN_PROGRESS;
      else                                      bg = PANEL_CONFIG.COLOR.GREY;
      bgFila.push(bg);
    });

    var promedio  = _calcularPromedioPanel_(studentId, programCode, ctx);
    var credInfo  = _calcularCreditos_(studentId, programCode, ctx);
    var colorGral = promedio !== null ? _calcularSemaforo_(promedio, ctx.cfg) : "GREY";

    fila.push(
      credInfo.total > 0 ? Math.round(credInfo.porcentaje) + "%" : "0%",
      promedio !== null ? promedio : "",
      colorGral
    );
    bgFila.push(PANEL_CONFIG.COLOR.LOCKED, PANEL_CONFIG.COLOR.LOCKED, _colorSemaforo_(colorGral));

    filas.push(fila);
    bgColors.push(bgFila);
  });

  if (filas.length > 0) {
    hoja.getRange(2, 1, filas.length, numCols).setValues(filas);
    hoja.getRange(2, 1, filas.length, numCols).setBackgrounds(bgColors);
  }

  hoja.setFrozenRows(1);
  hoja.setFrozenColumns(2);
}


/**
 * Construye la lista de nombres de todos los estudiantes activos
 * y establece un dropdown en la celda B3 del BOLETIN.
 *
 * @param {Spreadsheet} panelSS — spreadsheet del panel
 * @param {object}      ctx     — contexto del panel
 */
function _actualizarListaBoletin_(panelSS, ctx) {
  var hoja = panelSS.getSheetByName("BOLETIN");
  if (!hoja) return;

  var stIdx  = ctx.studentsIdx;
  var nombres = [];

  Object.keys(ctx.students).forEach(function(studentId) {
    var student = ctx.students[studentId];
    var status  = String(student[stIdx["StudentStatusCode"]] || "").trim();
    if (status !== "ACTIVE") return;

    var firstName = String(student[stIdx["FirstName"]] || "").trim();
    var lastName  = String(student[stIdx["LastName"]]  || "").trim();
    nombres.push((firstName + " " + lastName).trim());
  });

  nombres.sort();

  if (nombres.length === 0) return;

  var regla = SpreadsheetApp.newDataValidation()
    .requireValueInList(nombres, true)
    .setAllowInvalid(false)
    .build();

  hoja.getRange("B3").setDataValidation(regla);
}


/**
 * Pobla la hoja PENDIENTES_POR_PROGRAMA con un bloque por programa más una
 * sección final con asignaturas TRV. Aplica el filtro de modalidad recibido.
 *
 * Filtro de modalidad y aplicabilidad de asignatura (B/B):
 *   • "Todos"      → cuenta DIR + ART. Asignatura aplica si tiene DirStartMoment
 *                     o ArtStartBlock — se filtran estudiantes elegibles por
 *                     cada subconjunto (un DIR no se cuenta en una asignatura
 *                     que solo tiene ArtStartBlock, y viceversa).
 *   • "DIRECTO"    → solo StudentType=DIRECTO. Solo asignaturas con DirStartMoment.
 *   • "ARTICULADO" → solo StudentType=ARTICULADO. Solo asignaturas con ArtStartBlock.
 *
 * @param {Spreadsheet} panelSS
 * @param {Sheet}       hoja
 * @param {object}      ctx
 * @param {string}      filtro — "Todos" | "DIRECTO" | "ARTICULADO"
 * @param {Date}        ahora
 */
function _poblarHojaResumenPendientes_(panelSS, hoja, ctx, filtro, ahora) {
  // ── Limpiar contenido a partir de fila 5 (preservar cabecera + B3) ──
  var lastRow = hoja.getLastRow();
  if (lastRow >= 5) {
    hoja.getRange(5, 1, lastRow - 4, 6).clearContent().clearFormat();
  }

  var stIdx   = ctx.studentsIdx;
  var sIdx    = ctx.subjectsIdx;
  var progIdx = ctx.programsIdx;

  // ── Cargar AcademicDebts una sola vez e indexar por (StudentID, SubjectCode) ──
  var debtsMem = _leerHoja_(ctx.adminSS.getSheetByName("AcademicDebts"));
  var dIdx     = debtsMem.idx;
  var debtSet  = {};   // { studentId|subjectCode: true } — solo DEBT_PENDING

  debtsMem.datos.forEach(function(row) {
    var sid    = String(row[dIdx["StudentID"]]      || "").trim();
    var subj   = String(row[dIdx["SubjectCode"]]    || "").trim();
    var status = String(row[dIdx["DebtStatusCode"]] || "").trim();
    if (sid && subj && status === "DEBT_PENDING") {
      debtSet[sid + "|" + subj] = true;
    }
  });

  // ── Helper: ¿el estudiante coincide con el filtro de modalidad? ──
  function cumpleFiltro_(studentType) {
    if (filtro === "Todos")      return true;
    return studentType === filtro;
  }

  // ── Helper: ¿la asignatura aplica a un StudentType dado? ──
  // Se determina por la presencia de DirStartMoment / ArtStartBlock en _CFG_SUBJECTS.
  function asignaturaAplicaAEstudiante_(subRow, studentType) {
    var dirMom = String(subRow[sIdx["DirStartMoment"]] || "").trim();
    var artMom = String(subRow[sIdx["ArtStartBlock"]]  || "").trim();
    if (studentType === "DIRECTO")    return dirMom !== "";
    if (studentType === "ARTICULADO") return artMom !== "";
    return false;
  }

  // ── Helper: ¿la asignatura debe aparecer del todo bajo el filtro actual? ──
  function asignaturaVisible_(subRow) {
    var dirMom = String(subRow[sIdx["DirStartMoment"]] || "").trim();
    var artMom = String(subRow[sIdx["ArtStartBlock"]]  || "").trim();
    if (filtro === "DIRECTO")    return dirMom !== "";
    if (filtro === "ARTICULADO") return artMom !== "";
    return dirMom !== "" || artMom !== "";   // "Todos"
  }

  // ── Construir índice rápido: estudiante aprobado en (subjectCode) ──
  // Se basa en bestGrades (que ya es una agregación de GradeHistory por mejor nota).
  // Aprobado = nota ≥ UMBRAL_APROBACION.
  var umbralAprob = ctx.cfg.UMBRAL_APROBACION || 3.0;
  function estaAprobada_(studentId, subjectCode) {
    var bg = ctx.bestGrades[studentId + "|" + subjectCode];
    return bg && bg.nota !== null && !isNaN(bg.nota) && bg.nota >= umbralAprob;
  }

  // ── Pre-clasificar estudiantes activos por programa y modalidad ──────
  var estudiantesActivos = {};   // { programCode: [{ id, type } ...] }
  Object.keys(ctx.students).forEach(function(sid) {
    var st     = ctx.students[sid];
    var status = String(st[stIdx["StudentStatusCode"]] || "").trim();
    if (status !== "ACTIVE") return;

    var stype  = String(st[stIdx["StudentType"]]  || "").trim();
    if (!cumpleFiltro_(stype)) return;

    var prog   = String(st[stIdx["ProgramCode"]] || "").trim();
    if (!prog) return;

    if (!estudiantesActivos[prog]) estudiantesActivos[prog] = [];
    estudiantesActivos[prog].push({ id: sid, type: stype });
  });

  // ── Procesar cada programa ───────────────────────────────────────────
  var fila    = 5;
  var totalProgramas    = 0;
  var totalAsigVisibles = 0;

  PANEL_CONFIG.PROGRAMAS.forEach(function(progCode) {
    var subjectsProg = (ctx.subjectsByProgram[progCode] || []).filter(asignaturaVisible_);
    var alumnos      = estudiantesActivos[progCode] || [];

    if (subjectsProg.length === 0 || alumnos.length === 0) return;

    var progRow    = ctx.programs[progCode];
    var progNombre = progRow ? String(progRow[progIdx["ProgramName"]] || progCode).trim() : progCode;

    // Calcular filas de cada asignatura para este programa
    var filasProg = [];
    subjectsProg.forEach(function(subRow) {
      var subCode = String(subRow[sIdx["SubjectCode"]] || "").trim();
      var subName = String(subRow[sIdx["SubjectName"]] || "").trim();

      // N = alumnos del programa elegibles para esta asignatura
      var elegibles = alumnos.filter(function(a) {
        return asignaturaAplicaAEstudiante_(subRow, a.type);
      });
      if (elegibles.length === 0) return;

      var aprobados = 0, conDebito = 0;
      elegibles.forEach(function(a) {
        if (estaAprobada_(a.id, subCode))                    aprobados++;
        else if (debtSet[a.id + "|" + subCode] === true)     conDebito++;
      });
      var pendientes = elegibles.length - aprobados - conDebito;
      var total      = pendientes + conDebito;

      // Opción A: ocultar asignaturas con Total = 0 (todos aprobaron)
      if (total <= 0) return;

      filasProg.push({
        code: subCode, name: subName,
        pendientes: pendientes, conDebito: conDebito, total: total
      });
    });

    if (filasProg.length === 0) return;
    totalProgramas++;
    totalAsigVisibles += filasProg.length;

    // ── Cabecera del programa ──
    hoja.getRange(fila, 1, 1, 6).merge()
      .setValue("▼ PROGRAMA: " + progNombre.toUpperCase() + " (" + progCode + ")" +
                "    ·    " + alumnos.length + " estudiantes activos" +
                (filtro !== "Todos" ? " (" + filtro + ")" : ""))
      .setBackground(PANEL_CONFIG.COLOR.HEADER)
      .setFontColor("#ffffff").setFontWeight("bold");
    fila++;

    // ── Headers de la tabla ──
    var headers = ["Código", "Asignatura", "Pendiente", "Débito académico", "Total", ""];
    hoja.getRange(fila, 1, 1, 6).setValues([headers])
      .setBackground("#cfd8dc").setFontWeight("bold").setFontColor("#1a3c5e");
    fila++;

    // ── Filas ──
    filasProg.forEach(function(f) {
      var rowVals = [f.code, f.name, f.pendientes, f.conDebito, f.total, ""];
      hoja.getRange(fila, 1, 1, 6).setValues([rowVals]);

      // Coloreado: débito > 0 → fondo rojo claro en col D
      if (f.conDebito > 0) {
        hoja.getRange(fila, 4).setBackground(PANEL_CONFIG.COLOR.RED);
      }
      // Pendientes alto (>50% de elegibles) → fondo amarillo claro en col C
      if (f.pendientes > 0 && f.pendientes > (f.total * 0.5)) {
        hoja.getRange(fila, 3).setBackground(PANEL_CONFIG.COLOR.YELLOW);
      }
      fila++;
    });

    fila++;   // espacio entre programas
  });

  // ── Sección TRV (asignaturas transversales) ──────────────────────────
  if (ctx.trvSubjects.length > 0) {
    var trvVisibles = ctx.trvSubjects.filter(asignaturaVisible_);

    // Universo de estudiantes para TRV = todos los activos que cumplen el filtro
    var alumnosTRV = [];
    Object.keys(estudiantesActivos).forEach(function(p) {
      alumnosTRV = alumnosTRV.concat(estudiantesActivos[p]);
    });

    var filasTRV = [];
    trvVisibles.forEach(function(subRow) {
      var subCode = String(subRow[sIdx["SubjectCode"]] || "").trim();
      var subName = String(subRow[sIdx["SubjectName"]] || "").trim();

      var elegibles = alumnosTRV.filter(function(a) {
        return asignaturaAplicaAEstudiante_(subRow, a.type);
      });
      if (elegibles.length === 0) return;

      var aprobados = 0, conDebito = 0;
      elegibles.forEach(function(a) {
        if (estaAprobada_(a.id, subCode))                    aprobados++;
        else if (debtSet[a.id + "|" + subCode] === true)     conDebito++;
      });
      var pendientes = elegibles.length - aprobados - conDebito;
      var total      = pendientes + conDebito;
      if (total <= 0) return;

      filasTRV.push({
        code: subCode, name: subName,
        pendientes: pendientes, conDebito: conDebito, total: total
      });
    });

    if (filasTRV.length > 0) {
      totalAsigVisibles += filasTRV.length;

      hoja.getRange(fila, 1, 1, 6).merge()
        .setValue("▼ ASIGNATURAS TRANSVERSALES (TRV)    ·    " +
                  alumnosTRV.length + " estudiantes activos" +
                  (filtro !== "Todos" ? " (" + filtro + ")" : ""))
        .setBackground("#1a237e")
        .setFontColor("#ffffff").setFontWeight("bold");
      fila++;

      var headersTRV = ["Código", "Asignatura", "Pendiente", "Débito académico", "Total", ""];
      hoja.getRange(fila, 1, 1, 6).setValues([headersTRV])
        .setBackground(PANEL_CONFIG.COLOR.TRV).setFontWeight("bold").setFontColor("#1a237e");
      fila++;

      filasTRV.forEach(function(f) {
        var rowVals = [f.code, f.name, f.pendientes, f.conDebito, f.total, ""];
        hoja.getRange(fila, 1, 1, 6).setValues([rowVals])
          .setBackground(PANEL_CONFIG.COLOR.TRV);
        if (f.conDebito > 0) {
          hoja.getRange(fila, 4).setBackground(PANEL_CONFIG.COLOR.RED);
        }
        if (f.pendientes > 0 && f.pendientes > (f.total * 0.5)) {
          hoja.getRange(fila, 3).setBackground(PANEL_CONFIG.COLOR.YELLOW);
        }
        fila++;
      });
      fila++;
    }
  }

  // ── Footer con timestamp y resumen ──
  var fechaStr = Utilities.formatDate(ahora, SIDEP_CONFIG.timezone, "dd/MM/yyyy HH:mm");
  hoja.getRange(fila, 1, 1, 6).merge()
    .setValue("Generado: " + fechaStr + "   ·   " +
              "Filtro: " + filtro + "   ·   " +
              totalProgramas + " programa(s) · " +
              totalAsigVisibles + " asignatura(s) con pendientes")
    .setFontStyle("italic").setFontColor("#666666").setFontSize(9);

  SpreadsheetApp.flush();
}
