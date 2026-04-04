/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 33_service_estudiantes_staging.gs
 * Versión: 1.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Lógica de negocio para promover staging de estudiantes a maestras.
 *   Dos servicios independientes:
 *
 *   procesarEstudiantesDesdeStaging()  → STG_ESTUDIANTES → Students
 *     REGISTER  : INSERT en Students
 *     UPDATE    : UPDATE en Students
 *     DEACTIVATE: StudentStatusCode → STUDENT_INACTIVE
 *
 *   procesarMatriculasDesdeStaging()   → STG_MATRICULAS → Enrollments + Classroom
 *     ENROLL: busca StudentID → busca DeploymentID → INSERT Enrollment
 *             + Classroom.Invitations.create({ role: 'STUDENT' })
 *     DROP  : EnrollmentStatusCode → DROPPED + Classroom.Courses.Students.remove()
 *
 * DIFERENCIA VS docentes:
 *   Estudiantes usan cuentas @gmail.com (externas al dominio).
 *   Students.create() no aplica — se usa Classroom.Invitations con role=STUDENT.
 *   La invitación llega al Gmail del estudiante; al aceptarla queda en el aula.
 *   El email de notificación incluye enrollmentCode (?cjc=code) para unirse sin esperar.
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs  → SIDEP_CONFIG, TODOS_LOS_PROGRAMAS, MOMENT_ORDER
 *   02_SIDEP_HELPERS.gs → getSpreadsheetByName(), uuid(), nowSIDEP()
 *   04_SIDEP_STAGING_TABLES.gs → MAESTRA_REQUIRED_COLS
 * ============================================================
 */


// ── Constantes del servicio ───────────────────────────────────

var TIPOS_DOC_EST_VALIDOS  = ["CC", "TI", "CE", "PAS"];
var TIPOS_STUDENT_VALIDOS  = ["DIRECTO", "ARTICULADO"];
var ACCIONES_EST_VALIDAS   = ["REGISTER", "UPDATE", "DEACTIVATE"];
var ACCIONES_MAT_VALIDAS   = ["ENROLL", "DROP"];

var COLS_STUDENTS_STG = [
  "StudentID", "DocumentType", "DocumentNumber", "StudentType",
  "FirstName", "LastName", "Email", "CohortCode", "ProgramCode",
  "CampusCode", "StudentStatusCode", "CompletionStatus",
  "CreatedAt", "CreatedBy"
];

var COLS_ENROLLMENTS_STG = [
  "EnrollmentID", "StudentID", "DeploymentID",
  "EntryCohortCode", "WindowCohortCode", "MomentCode",
  "AttemptNumber", "EnrollmentStatusCode", "CreatedAt", "CreatedBy"
];


// ════════════════════════════════════════════════════════════
// SERVICIO 1 — STG_ESTUDIANTES → Students
// ════════════════════════════════════════════════════════════

/**
 * Promueve filas de STG_ESTUDIANTES a la tabla maestra Students.
 *
 * @param {object} opts
 * @param {Array}  opts.rows
 * @param {object} opts.idx
 * @param {string} opts.ahora
 * @param {string} opts.usuario
 * @returns {{ insertados, actualizados, desactivados, errores: string[], emailToNewId: object }}
 */
function procesarEstudiantesDesdeStaging(opts) {
  var ahora   = opts.ahora   || nowSIDEP();
  var usuario = opts.usuario || Session.getEffectiveUser().getEmail();

  var adminSS = getSpreadsheetByName("admin");
  var mem     = _leerHojaCompletaSrv_(adminSS, "Students");
  _verificarColumnasSrv_(mem, COLS_STUDENTS_STG);

  // Índice email → posición para O(1)
  var emailIdx = {};
  mem.datos.forEach(function(fila, i) {
    var email = String(fila[mem.colIdx["Email"]] || "").toLowerCase().trim();
    if (email) emailIdx[email] = i;
  });

  var inserts       = [];
  var errores       = [];
  var emailToNewId  = {};
  var actualizados  = 0;
  var desactivados  = 0;

  opts.rows.forEach(function(row) {
    var accion = String(row[opts.idx["RequestedAction"]] || "").trim().toUpperCase();
    var email  = String(row[opts.idx["Email"]]           || "").trim().toLowerCase();
    var ctx    = accion + " " + email;

    try {
      if (accion === "REGISTER") {
        if (emailIdx.hasOwnProperty(email)) {
          throw new Error("Email ya existe en Students — usar UPDATE.");
        }
        var newId  = uuid("stu");
        var nueva  = _construirFilaStudent_(row, opts.idx, mem, newId, ahora, usuario);
        _validarFilaMaestra_("Students", nueva, mem.colIdx);
        inserts.push(nueva);
        mem.datos.push(nueva);
        emailIdx[email] = mem.datos.length - 1;
        emailToNewId[email] = newId;
        Logger.log("  + REGISTER: " + email + " -> " + newId);

      } else if (accion === "UPDATE") {
        if (!emailIdx.hasOwnProperty(email)) {
          throw new Error("Email no encontrado en Students — usar REGISTER.");
        }
        _actualizarFilaStudent_(mem, emailIdx[email], row, opts.idx, ahora, usuario);
        actualizados++;
        Logger.log("  ~ UPDATE: " + email);

      } else if (accion === "DEACTIVATE") {
        if (!emailIdx.hasOwnProperty(email)) {
          throw new Error("Email no encontrado en Students.");
        }
        var idx = emailIdx[email];
        mem.datos[idx][mem.colIdx["StudentStatusCode"]] = "STUDENT_INACTIVE";
        mem.datos[idx][mem.colIdx["UpdatedAt"]]         = ahora;
        mem.datos[idx][mem.colIdx["UpdatedBy"]]         = usuario;
        desactivados++;
        Logger.log("  x DEACTIVATE: " + email);

      } else {
        throw new Error("RequestedAction invalida: '" + accion + "'.");
      }
    } catch (e) {
      errores.push(ctx + ": " + e.message);
      Logger.log("  !! " + ctx + ": " + e.message);
    }
  });

  if (actualizados > 0 || desactivados > 0) _escribirUpdatesSrv_(mem);
  if (inserts.length > 0)                   _escribirInsertsSrv_(mem.hoja, inserts);

  _registrarLogMaestraEst_(adminSS,
    errores.length > 0 ? "PARTIAL" : "SUCCESS",
    inserts.length + actualizados + desactivados,
    errores.join(" | "), ahora, usuario
  );

  return {
    insertados:   inserts.length,
    actualizados: actualizados,
    desactivados: desactivados,
    errores:      errores,
    emailToNewId: emailToNewId
  };
}


// ════════════════════════════════════════════════════════════
// SERVICIO 2 — STG_MATRICULAS → Enrollments + Classroom
// ════════════════════════════════════════════════════════════

/**
 * Promueve filas de STG_MATRICULAS.
 * ENROLL: Enrollments INSERT + Classroom.Invitations.create({ role:'STUDENT' })
 * DROP  : Enrollments UPDATE(DROPPED) + Classroom.Courses.Students.remove()
 *
 * @param {object} opts
 * @param {Array}  opts.rows
 * @param {object} opts.idx
 * @param {string} opts.ahora
 * @param {string} opts.usuario
 * @returns {{ matriculados, dados_de_baja, invitacionesOk, invitacionesYaExistian, errores: string[] }}
 */
function procesarMatriculasDesdeStaging(opts) {
  var ahora   = opts.ahora   || nowSIDEP();
  var usuario = opts.usuario || Session.getEffectiveUser().getEmail();

  var coreSS  = getSpreadsheetByName("core");
  var adminSS = getSpreadsheetByName("admin");

  var memStudents   = _leerHojaCompletaSrv_(adminSS, "Students");
  var memDepl       = _leerHojaCompletaSrv_(coreSS,  "MasterDeployments");
  var memEnroll     = _leerHojaCompletaSrv_(adminSS, "Enrollments");
  _verificarColumnasSrv_(memEnroll, COLS_ENROLLMENTS_STG);

  var emailToStudentId = _construirEmailStudentIdxSrv_(memStudents);
  var deplIdx          = _indexarDeploymentsSrv_(memDepl);
  var enrollExist      = _indexarEnrollmentsExistentesSrv_(memEnroll);

  var filasNuevas    = [];
  var errores        = [];
  var dadosDeBaja    = 0;
  var invOk          = 0;
  var invYaExistia   = 0;

  opts.rows.forEach(function(row) {
    var accion    = String(row[opts.idx["RequestedAction"]] || "").trim().toUpperCase();
    var email     = String(row[opts.idx["StudentEmail"]]    || "").trim().toLowerCase();
    var prog      = String(row[opts.idx["ProgramCode"]]     || "").trim();
    var subj      = String(row[opts.idx["SubjectCode"]]     || "").trim();
    var coh       = String(row[opts.idx["CohortCode"]]      || "").trim();
    var mom       = String(row[opts.idx["MomentCode"]]      || "").trim();
    var logKey    = prog + "-" + subj + " [" + coh + " " + mom + "]";
    var ctx       = accion + " " + email + " -> " + logKey;

    try {
      var studentId = emailToStudentId[email];
      if (!studentId) throw new Error("Estudiante no encontrado en Students: " + email);

      var deplKey = prog + "-" + coh + "-" + mom + "-" + subj;
      var depl    = deplIdx[deplKey];
      if (!depl)                      throw new Error("Aula no encontrada: " + deplKey);
      if (depl.status !== "CREATED")  throw new Error("Aula no CREATED: " + deplKey + " (" + depl.status + ")");

      if (accion === "ENROLL") {
        var enrollKey = studentId + "_" + depl.id;
        if (enrollExist[enrollKey]) {
          Logger.log("  ~  Ya matriculado: " + ctx);
          invYaExistia++;
          return;
        }

        // Cohorte de entrada = CohortCode del estudiante en Students
        var entryCohort = _leerCohorteSrv_(memStudents, email);

        // Los estudiantes usan @gmail.com (externo al dominio sidep.edu.co).
        // Classroom.Invitations.create() falla con UntrustedDomain para cuentas
        // externas — no se usa. El estudiante se une al aula con el enrollmentCode
        // link (?cjc=code) que recibe en el email de notificación.
        var attempt = Number(row[opts.idx["AttemptNumber"]] || 1);
        var filaEnr = _construirFilaEnrollment_(
          studentId, depl.id, entryCohort, coh, mom, attempt,
          "ACTIVE", ahora, usuario, memEnroll
        );
        _validarFilaMaestra_("Enrollments", filaEnr, memEnroll.colIdx);
        filasNuevas.push(filaEnr);
        enrollExist[enrollKey] = true;
        invOk++;
        Logger.log("  + ENROLL: " + ctx);

      } else if (accion === "DROP") {
        // Solo marca DROPPED en Enrollments. El estudiante se unió por enrollmentCode
        // (no por invitación API), así que no hay entrada de Classroom que eliminar
        // programáticamente desde este contexto. Si se requiere removerlo del aula,
        // el coordinador lo hace manualmente desde la interfaz de Classroom.
        _darDeBajaEnrollmentSrv_(memEnroll, studentId, depl.id, ahora, usuario);
        dadosDeBaja++;
        Logger.log("  x DROP: " + ctx);

      } else {
        throw new Error("RequestedAction invalida: '" + accion + "'.");
      }
    } catch (e) {
      errores.push(ctx + ": " + e.message);
      Logger.log("  !! " + ctx + ": " + e.message);
    }
  });

  if (dadosDeBaja > 0)         _escribirUpdatesSrv_(memEnroll);
  if (filasNuevas.length > 0)  _escribirInsertsSrv_(memEnroll.hoja, filasNuevas);

  _registrarLogMaestraEst_(adminSS,
    errores.length > 0 ? "PARTIAL" : "SUCCESS",
    invOk + invYaExistia + dadosDeBaja,
    errores.join(" | "), ahora, usuario
  );

  return {
    matriculados:           invOk + invYaExistia,
    dados_de_baja:          dadosDeBaja,
    invitacionesOk:         invOk,
    invitacionesYaExistian: invYaExistia,
    errores:                errores
  };
}


// ════════════════════════════════════════════════════════════
// VALIDACIONES
// ════════════════════════════════════════════════════════════

function validarEstudiantesStaging(rows, idx) {
  if (!rows || rows.length === 0) throw new Error("Sin filas APPROVED/PENDING en STG_ESTUDIANTES.");
  var emailsVistos = {};
  rows.forEach(function(row, i) {
    var accion = String(row[idx["RequestedAction"]] || "").trim();
    var email  = String(row[idx["Email"]]           || "").trim();
    var ctx    = "STG_ESTUDIANTES[" + i + "] (" + email + ")";

    if (ACCIONES_EST_VALIDAS.indexOf(accion) === -1) {
      throw new Error(ctx + ": RequestedAction invalida -> '" + accion + "'. " +
                      "Valores: " + ACCIONES_EST_VALIDAS.join(", "));
    }
    if (!email) throw new Error(ctx + ": Email vacio.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(ctx + ": Email invalido.");
    if (emailsVistos[email.toLowerCase()]) throw new Error(ctx + ": Email duplicado en el lote.");
    emailsVistos[email.toLowerCase()] = true;

    if (accion === "REGISTER" || accion === "UPDATE") {
      if (!row[idx["FirstName"]] || !row[idx["LastName"]]) {
        throw new Error(ctx + ": FirstName o LastName vacio.");
      }
      var docType = String(row[idx["DocumentType"]] || "").trim();
      if (docType && TIPOS_DOC_EST_VALIDOS.indexOf(docType) === -1) {
        throw new Error(ctx + ": DocumentType invalido -> '" + docType + "'.");
      }
      var stType = String(row[idx["StudentType"]] || "").trim();
      if (stType && TIPOS_STUDENT_VALIDOS.indexOf(stType) === -1) {
        throw new Error(ctx + ": StudentType invalido -> '" + stType + "'.");
      }
      if (!row[idx["ProgramCode"]]) throw new Error(ctx + ": ProgramCode vacio.");
      if (!row[idx["CohortCode"]])  throw new Error(ctx + ": CohortCode vacio.");
    }
  });
}

function validarMatriculasStaging(rows, idx) {
  if (!rows || rows.length === 0) return;
  rows.forEach(function(row, i) {
    var accion = String(row[idx["RequestedAction"]] || "").trim();
    var email  = String(row[idx["StudentEmail"]]    || "").trim();
    var ctx    = "STG_MATRICULAS[" + i + "] (" + email + ")";

    if (ACCIONES_MAT_VALIDAS.indexOf(accion) === -1) {
      throw new Error(ctx + ": RequestedAction invalida -> '" + accion + "'. " +
                      "Valores: " + ACCIONES_MAT_VALIDAS.join(", "));
    }
    if (!email) throw new Error(ctx + ": StudentEmail vacio.");

    if (accion === "ENROLL") {
      var prog = String(row[idx["ProgramCode"]] || "").trim();
      var mom  = String(row[idx["MomentCode"]]  || "").trim();
      if (!prog || TODOS_LOS_PROGRAMAS.indexOf(prog) === -1) {
        throw new Error(ctx + ": ProgramCode invalido -> '" + prog + "'.");
      }
      if (!row[idx["SubjectCode"]]) throw new Error(ctx + ": SubjectCode vacio.");
      if (!row[idx["CohortCode"]])  throw new Error(ctx + ": CohortCode vacio.");
      if (!mom || MOMENT_ORDER[mom] === undefined) {
        throw new Error(ctx + ": MomentCode invalido -> '" + mom + "'.");
      }
    }
  });
}


// ════════════════════════════════════════════════════════════
// HELPERS — Lectura e indexación
// ════════════════════════════════════════════════════════════

function _construirEmailStudentIdxSrv_(mem) {
  var idx = {};
  mem.datos.forEach(function(f) {
    var email = String(f[mem.colIdx["Email"]]     || "").toLowerCase().trim();
    var id    = String(f[mem.colIdx["StudentID"]] || "").trim();
    if (email && id) idx[email] = id;
  });
  return idx;
}

function _indexarEnrollmentsExistentesSrv_(mem) {
  var idx  = {};
  var iStu = mem.colIdx["StudentID"];
  var iDep = mem.colIdx["DeploymentID"];
  if (iStu === undefined || iDep === undefined) return idx;
  mem.datos.forEach(function(f) {
    var s = String(f[iStu] || "").trim();
    var d = String(f[iDep] || "").trim();
    if (s && d) idx[s + "_" + d] = true;
  });
  return idx;
}

function _leerCohorteSrv_(memStudents, email) {
  var c     = memStudents.colIdx;
  var fila  = memStudents.datos.find(function(f) {
    return String(f[c["Email"]] || "").toLowerCase().trim() === email;
  });
  return fila ? String(fila[c["CohortCode"]] || "").trim() : "";
}


// ════════════════════════════════════════════════════════════
// HELPERS — Construcción de filas
// ════════════════════════════════════════════════════════════

function _construirFilaStudent_(row, idx, mem, newId, ahora, usuario) {
  var c       = mem.colIdx;
  var nueva   = new Array(mem.encabezado.length).fill("");
  nueva[c["StudentID"]]         = newId;
  nueva[c["DocumentType"]]      = String(row[idx["DocumentType"]]   || "").trim();
  nueva[c["DocumentNumber"]]    = String(row[idx["DocumentNumber"]] || "").trim();
  nueva[c["StudentType"]]       = String(row[idx["StudentType"]]    || "").trim();
  nueva[c["FirstName"]]         = String(row[idx["FirstName"]]      || "").trim();
  nueva[c["LastName"]]          = String(row[idx["LastName"]]       || "").trim();
  nueva[c["Phone"]]             = String(row[idx["Phone"]]          || "").trim();
  nueva[c["Email"]]             = String(row[idx["Email"]]          || "").trim();
  nueva[c["CohortCode"]]        = String(row[idx["CohortCode"]]     || "").trim();
  nueva[c["ProgramCode"]]       = String(row[idx["ProgramCode"]]    || "").trim();
  nueva[c["CampusCode"]]        = SIDEP_CONFIG.defaultCampus;
  nueva[c["StudentStatusCode"]] = "STUDENT_ACTIVE";
  nueva[c["CompletionStatus"]]  = "IN_PROGRESS";
  nueva[c["Notes"]] = c["Notes"] !== undefined ? String(row[idx["Notes"]] || "").trim() : "";
  nueva[c["CreatedAt"]]         = ahora;
  nueva[c["CreatedBy"]]         = usuario;
  if (c["UpdatedAt"] !== undefined) nueva[c["UpdatedAt"]] = ahora;
  if (c["UpdatedBy"] !== undefined) nueva[c["UpdatedBy"]] = usuario;
  return nueva;
}

function _actualizarFilaStudent_(mem, filaIdx, row, idx, ahora, usuario) {
  var c = mem.colIdx;
  var f = mem.datos[filaIdx];
  if (row[idx["FirstName"]])      f[c["FirstName"]]      = String(row[idx["FirstName"]]      || "").trim();
  if (row[idx["LastName"]])       f[c["LastName"]]       = String(row[idx["LastName"]]       || "").trim();
  if (row[idx["Phone"]])          f[c["Phone"]]          = String(row[idx["Phone"]]          || "").trim();
  if (row[idx["DocumentType"]])   f[c["DocumentType"]]   = String(row[idx["DocumentType"]]   || "").trim();
  if (row[idx["DocumentNumber"]]) f[c["DocumentNumber"]] = String(row[idx["DocumentNumber"]] || "").trim();
  if (row[idx["StudentType"]])    f[c["StudentType"]]    = String(row[idx["StudentType"]]    || "").trim();
  if (row[idx["ProgramCode"]])    f[c["ProgramCode"]]    = String(row[idx["ProgramCode"]]    || "").trim();
  if (row[idx["Notes"]])          f[c["Notes"]]          = String(row[idx["Notes"]]          || "").trim();
  if (c["UpdatedAt"] !== undefined) f[c["UpdatedAt"]] = ahora;
  if (c["UpdatedBy"] !== undefined) f[c["UpdatedBy"]] = usuario;
}

function _construirFilaEnrollment_(studentId, deplId, entryCohort, windowCohort,
                                    momentCode, attempt, statusCode, ahora, usuario, mem) {
  var c     = mem.colIdx;
  var nueva = new Array(mem.encabezado.length).fill("");
  nueva[c["EnrollmentID"]]        = uuid("enr");
  nueva[c["StudentID"]]           = studentId;
  nueva[c["DeploymentID"]]        = deplId;
  nueva[c["EntryCohortCode"]]     = entryCohort;
  nueva[c["WindowCohortCode"]]    = windowCohort;
  nueva[c["MomentCode"]]          = momentCode;
  nueva[c["AttemptNumber"]]       = attempt || 1;
  nueva[c["EnrollmentStatusCode"]]= statusCode || "ACTIVE";
  nueva[c["CreatedAt"]]           = ahora;
  nueva[c["CreatedBy"]]           = usuario;
  if (c["UpdatedAt"] !== undefined) nueva[c["UpdatedAt"]] = ahora;
  if (c["UpdatedBy"] !== undefined) nueva[c["UpdatedBy"]] = usuario;
  if (c["AperturaID"] !== undefined) nueva[c["AperturaID"]] = "";
  return nueva;
}

function _darDeBajaEnrollmentSrv_(mem, studentId, deplId, ahora, usuario) {
  var iStu   = mem.colIdx["StudentID"];
  var iDep   = mem.colIdx["DeploymentID"];
  var iSt    = mem.colIdx["EnrollmentStatusCode"];
  var iUpdAt = mem.colIdx["UpdatedAt"];
  var iUpdBy = mem.colIdx["UpdatedBy"];
  mem.datos.forEach(function(f) {
    if (String(f[iStu] || "").trim() === studentId &&
        String(f[iDep] || "").trim() === deplId) {
      if (iSt    !== undefined) f[iSt]    = "DROPPED";
      if (iUpdAt !== undefined) f[iUpdAt] = ahora;
      if (iUpdBy !== undefined) f[iUpdBy] = usuario;
    }
  });
}


// ════════════════════════════════════════════════════════════
// CLASSROOM API — Invitaciones y remoción
// ════════════════════════════════════════════════════════════

/**
 * Envía invitación de estudiante. 3 intentos, backoff 5/10/20s.
 * @returns {{ estado: "OK"|"YA_EXISTIA"|"ERROR", invitationId: string }}
 */
function _invitarEstudianteConRetrySrv_(classroomId, email, logKey) {
  var esperas = [5000, 10000, 20000];
  for (var i = 1; i <= 3; i++) {
    try {
      var inv = Classroom.Invitations.create({ courseId: classroomId, userId: email, role: "STUDENT" });
      return { estado: "OK", invitationId: inv.id };
    } catch (e) {
      var msg = e.message || String(e);
      if (msg.indexOf("409") !== -1 || msg.toLowerCase().indexOf("already") !== -1) {
        return { estado: "YA_EXISTIA", invitationId: "" };
      }
      // Dominio no confiable — falla inmediata, no tiene sentido reintentar.
      // Solución: Admin Console → Classroom → Configuración de uso compartido
      //           → "Quién puede unirse" → "Cualquier usuario de Google"
      if (msg.indexOf("UntrustedDomain") !== -1 || msg.indexOf("untrusted") !== -1) {
        Logger.log("  !! Dominio no confiable (@gmail.com bloqueado por Workspace Admin): " + email);
        return { estado: "DOMINIO_NO_CONFIABLE", invitationId: "" };
      }
      if (msg.indexOf("403") !== -1 || msg.toLowerCase().indexOf("permission") !== -1) {
        Logger.log("  !! 403 sin permiso: " + email + " -> " + logKey);
        return { estado: "ERROR", invitationId: "" };
      }
      if (msg.indexOf("429") !== -1 || msg.toLowerCase().indexOf("quota") !== -1) {
        if (i < 3) { Utilities.sleep(esperas[i - 1]); continue; }
        return { estado: "ERROR", invitationId: "" };
      }
      Logger.log("  Intento " + i + "/3 [" + logKey + "]: " + msg);
      if (i < 3) Utilities.sleep(esperas[i - 1]);
    }
  }
  return { estado: "ERROR", invitationId: "" };
}

function _removerEstudianteClassroom_(classroomId, email, logKey) {
  try {
    Classroom.Courses.Students.remove(classroomId, email);
    Logger.log("  x Removido de Classroom: " + email + " -> " + logKey);
  } catch (e) {
    var msg = e.message || String(e);
    if (msg.indexOf("404") !== -1) {
      Logger.log("  i Estudiante ya no estaba en el aula: " + email + " -> " + logKey);
    } else {
      throw new Error("Classroom remove error [" + logKey + "]: " + msg);
    }
  }
}


// ════════════════════════════════════════════════════════════
// HELPERS — Log
// ════════════════════════════════════════════════════════════

function _registrarLogMaestraEst_(adminSS, resultado, registros, errorMsg, ahora, usuario) {
  try {
    var hoja = adminSS.getSheetByName("AutomationLogs");
    if (!hoja) return;
    hoja.appendRow([uuid("log"), "SHEETS", "IMPORT_STUDENTS", "procesarStgEstudiantes",
                    resultado, registros, errorMsg || "", ahora, usuario]);
  } catch (e) {
    Logger.log("Aviso: No se pudo escribir AutomationLog: " + e.message);
  }
}
