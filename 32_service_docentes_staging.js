/**
 * ============================================================
 * SIDEP ECOSISTEMA DIGITAL — Proyecto Google Apps Script
 * Archivo: 32_service_docentes_staging.gs
 * Versión: 2.0.0
 * ============================================================
 *
 * RESPONSABILIDAD ÚNICA:
 *   Lógica de negocio para promover desde staging a maestras.
 *   Dos servicios independientes:
 *
 *   procesarDocentesDesdeStaging()    → STG_DOCENTES → Teachers
 *     REGISTER  : INSERT en Teachers
 *     UPDATE    : UPDATE en Teachers
 *     DEACTIVATE: TeacherStatusCode → TEACHER_INACTIVE
 *     ⚠️  Sin Classroom — el docente se registra como persona, nada más.
 *
 *   procesarAsignacionesDesdeStaging() → STG_ASIGNACIONES → TeacherAssignments + Classroom
 *     ASSIGN: busca TeacherID en Teachers → crea TeacherAssignment → invita vía Classroom
 *     REMOVE: remueve del aula (Courses.Teachers.delete) + marca IsActive=false
 *
 * DEPENDE DE:
 *   00_SIDEP_CONFIG.gs  → SIDEP_CONFIG, TODOS_LOS_PROGRAMAS, MOMENT_ORDER
 *   02_SIDEP_HELPERS.gs → getSpreadsheetByName(), uuid(), nowSIDEP()
 * ============================================================
 */


// ── Constantes del servicio ───────────────────────────────────

const CONTRATOS_VALIDOS_STG    = ["PLANTA", "CONTRATISTA", "HORA_CATEDRA"];
const TIPOS_DOC_VALIDOS_STG    = ["CC", "CE", "PA", "NIT", "OTRO"];
const ACCIONES_DOCENTE_VALIDAS = ["REGISTER", "UPDATE", "DEACTIVATE"];
const ACCIONES_ASIG_VALIDAS    = ["ASSIGN", "REMOVE"];

const COLS_TEACHERS_STG = [
  "TeacherID", "FirstName", "LastName", "Email", "Phone",
  "DocumentType", "DocumentNumber", "CampusCode", "TeacherStatusCode",
  "HireDate", "Notes", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy"
];

const COLS_ASSIGNMENTS_STG = [
  "AssignmentID", "TeacherID", "DeploymentID", "CampusCode",
  "WeeklyHours", "StartDate", "EndDate", "ContractTypeCode",
  "IsActive", "CreatedAt", "CreatedBy",
  "InvitationID", "InvitationStatus"
];


// ════════════════════════════════════════════════════════════
// SERVICIO 1 — STG_DOCENTES → Teachers
// ════════════════════════════════════════════════════════════

/**
 * Promueve filas de STG_DOCENTES a la tabla maestra Teachers.
 * Sin ninguna llamada a Classroom API.
 *
 * @param {object} opts
 * @param {Array}  opts.rows  — filas de STG_DOCENTES (ApprovalStatus=APPROVED, StageStatus=PENDING)
 * @param {object} opts.idx   — índice de columnas de STG_DOCENTES
 * @param {string} opts.ahora
 * @param {string} opts.usuario
 * @returns {{ insertados, actualizados, desactivados, errores: string[] }}
 */
function procesarDocentesDesdeStaging(opts) {
  const ahora   = opts.ahora   || nowSIDEP();
  const usuario = opts.usuario || Session.getEffectiveUser().getEmail();

  const coreSS = getSpreadsheetByName("core");
  const mem    = _leerHojaCompletaSrv_(coreSS, "Teachers");
  _verificarColumnasSrv_(mem, COLS_TEACHERS_STG);

  // Índice email → posición en mem.datos para O(1)
  const emailIdx = {};
  mem.datos.forEach(function(fila, i) {
    const email = String(fila[mem.colIdx["Email"]] || "").toLowerCase().trim();
    if (email) emailIdx[email] = i;
  });

  const inserts       = [];
  const errores       = [];
  const emailToNewId  = {};   // email → TeacherID generado (solo REGISTER exitosos)
  let   actualizados  = 0;
  let   desactivados  = 0;

  opts.rows.forEach(function(row) {
    const accion = String(row[opts.idx["RequestedAction"]] || "").trim().toUpperCase();
    const email  = String(row[opts.idx["Email"]]           || "").trim().toLowerCase();
    const ctx    = accion + " " + email;

    try {
      if (accion === "REGISTER") {
        if (emailIdx.hasOwnProperty(email)) {
          throw new Error("Email ya existe en Teachers — usar UPDATE.");
        }
        const newId = uuid("tch");
        const nueva = _construirFilaTeacher_(row, opts.idx, mem, newId, ahora, usuario);
        _validarFilaMaestra_("Teachers", nueva, mem.colIdx);  // lanza Error si hay campo obligatorio vacío
        inserts.push(nueva);
        mem.datos.push(nueva);
        emailIdx[email] = mem.datos.length - 1;
        emailToNewId[email] = newId;
        Logger.log("  + REGISTER: " + email + " → " + newId);

      } else if (accion === "UPDATE") {
        if (!emailIdx.hasOwnProperty(email)) {
          throw new Error("Email no encontrado en Teachers — usar REGISTER.");
        }
        _actualizarFilaTeacher_(mem, emailIdx[email], row, opts.idx, ahora, usuario);
        actualizados++;
        Logger.log("  ~ UPDATE: " + email);

      } else if (accion === "DEACTIVATE") {
        if (!emailIdx.hasOwnProperty(email)) {
          throw new Error("Email no encontrado en Teachers.");
        }
        const i = emailIdx[email];
        mem.datos[i][mem.colIdx["TeacherStatusCode"]] = "TEACHER_INACTIVE";
        mem.datos[i][mem.colIdx["UpdatedAt"]]         = ahora;
        mem.datos[i][mem.colIdx["UpdatedBy"]]         = usuario;
        desactivados++;
        Logger.log("  ✕ DEACTIVATE: " + email);

      } else {
        throw new Error("RequestedAction inválida: '" + accion + "'.");
      }
    } catch (e) {
      errores.push(ctx + ": " + e.message);
      Logger.log("  ⛔ " + ctx + ": " + e.message);
    }
  });

  // Escritura batch — máximo 2 llamadas setValues
  if (actualizados > 0 || desactivados > 0) {
    _escribirUpdatesSrv_(mem);
  }
  if (inserts.length > 0) {
    _escribirInsertsSrv_(mem.hoja, inserts);
  }

  _registrarLogMaestra_(getSpreadsheetByName("admin"),
    errores.length > 0 ? "PARTIAL" : "SUCCESS",
    inserts.length + actualizados + desactivados,
    errores.join(" | "), ahora, usuario
  );

  return {
    insertados:   inserts.length,
    actualizados: actualizados,
    desactivados: desactivados,
    errores:      errores,
    emailToNewId: emailToNewId   // { email → TeacherID } para escribir TargetTeacherID en staging
  };
}


// ════════════════════════════════════════════════════════════
// SERVICIO 2 — STG_ASIGNACIONES → TeacherAssignments + Classroom
// ════════════════════════════════════════════════════════════

/**
 * Promueve filas de STG_ASIGNACIONES.
 * ASSIGN: TeacherAssignments + Classroom.Invitations.create()
 * REMOVE: Classroom.Courses.Teachers.delete() + IsActive=false en TeacherAssignments
 *
 * @param {object} opts
 * @param {Array}  opts.rows  — filas de STG_ASIGNACIONES (ApprovalStatus=APPROVED, StageStatus=PENDING)
 * @param {object} opts.idx   — índice de columnas de STG_ASIGNACIONES
 * @param {string} opts.ahora
 * @param {string} opts.usuario
 * @returns {{ asignados, removidos, invitacionesOk, invitacionesYaExistian, errores: string[] }}
 */
function procesarAsignacionesDesdeStaging(opts) {
  const ahora   = opts.ahora   || nowSIDEP();
  const usuario = opts.usuario || Session.getEffectiveUser().getEmail();

  const coreSS  = getSpreadsheetByName("core");
  const adminSS = getSpreadsheetByName("admin");

  const memTeachers = _leerHojaCompletaSrv_(coreSS,  "Teachers");
  const memDepl     = _leerHojaCompletaSrv_(coreSS,  "MasterDeployments");
  const memAsig     = _leerHojaCompletaSrv_(adminSS, "TeacherAssignments");
  _verificarColumnasSrv_(memAsig, COLS_ASSIGNMENTS_STG);

  const emailToId  = _construirEmailTeacherIdxSrv_(memTeachers);
  const deplIdx    = _indexarDeploymentsSrv_(memDepl);
  const asigExist  = _indexarAsignacionesExistentesSrv_(memAsig);

  const filasNuevas   = [];
  const errores       = [];
  let   removidos     = 0;
  let   invOk         = 0;
  let   invYaExistia  = 0;

  opts.rows.forEach(function(row) {
    const accion  = String(row[opts.idx["RequestedAction"]] || "").trim().toUpperCase();
    const email   = String(row[opts.idx["TeacherEmail"]]    || "").trim().toLowerCase();
    const prog    = String(row[opts.idx["ProgramCode"]]     || "").trim();
    const subj    = String(row[opts.idx["SubjectCode"]]     || "").trim();
    const coh     = String(row[opts.idx["CohortCode"]]      || "").trim();
    const mom     = String(row[opts.idx["MomentCode"]]      || "").trim();
    const logKey  = prog + "-" + subj + " [" + coh + " " + mom + "]";
    const ctx     = accion + " " + email + " → " + logKey;

    try {
      const teacherId = emailToId[email];
      if (!teacherId) throw new Error("Docente no encontrado en Teachers: " + email);

      const deplKey = prog + "-" + coh + "-" + mom + "-" + subj;
      const depl    = deplIdx[deplKey];
      if (!depl)                       throw new Error("Aula no encontrada: " + deplKey);
      if (depl.status !== "CREATED")   throw new Error("Aula no CREATED: " + deplKey + " (" + depl.status + ")");

      if (accion === "ASSIGN") {
        const asigKey = teacherId + "_" + depl.id;
        if (asigExist[asigKey]) {
          Logger.log("  ~  Ya asignado: " + ctx);
          invYaExistia++;
          return;
        }

        const resultado = _invitarCoTeacherConRetrySrv_(depl.classroomId, email, logKey);
        if (resultado.estado === "ERROR") throw new Error("Classroom API error en: " + logKey);

        // Determinar si ya es miembro activo (owner o invitación previa aceptada)
        let invStatus = "TEACHER_INVITED";
        let isActive  = false;
        if (resultado.estado === "YA_EXISTIA") {
          // Verificar si ya está en el aula como teacher
          try {
            Classroom.Courses.Teachers.get(depl.classroomId, email);
            invStatus = "TEACHER_ACCEPTED";
            isActive  = true;
            invYaExistia++;
            Logger.log("  ✔  Ya miembro (owner/aceptado): " + email);
          } catch (eCheck) {
            // No está en el aula — invitación anterior pendiente
            invYaExistia++;
          }
        } else {
          invOk++;
        }

        const contrato   = _leerContratoDocente_(memTeachers, email);
        const filaAsig   = [
          uuid("asg"), teacherId, depl.id, SIDEP_CONFIG.defaultCampus,
          Number(row[opts.idx["WeeklyHours"]] || 0),
          _parseFechaSrv_(row[opts.idx["StartDate"]]),
          _parseFechaSrv_(row[opts.idx["EndDate"]]),
          contrato,
          isActive,
          ahora, usuario,
          resultado.invitationId,
          invStatus,
          String(row[opts.idx["DayOfWeek"]]  || "").trim(),
          _parseTiempoSrv_(row[opts.idx["StartTime"]]),
          _parseTiempoSrv_(row[opts.idx["EndTime"]])
        ];
        _validarFilaMaestra_("TeacherAssignments", filaAsig, memAsig.colIdx);
        filasNuevas.push(filaAsig);
        asigExist[teacherId + "_" + depl.id] = true;
        Logger.log("  ✉️  ASSIGN: " + ctx);

      } else if (accion === "REMOVE") {
        _removerDocteaherClassroom_(depl.classroomId, email, logKey);
        _desactivarAsignacionSrv_(memAsig, teacherId, depl.id, ahora, usuario);
        removidos++;
        Logger.log("  ✕ REMOVE: " + ctx);

      } else {
        throw new Error("RequestedAction inválida: '" + accion + "'.");
      }
    } catch (e) {
      errores.push(ctx + ": " + e.message);
      Logger.log("  ⛔ " + ctx + ": " + e.message);
    }
  });

  // Escritura batch
  if (removidos > 0) {
    _escribirUpdatesSrv_(memAsig);
  }
  if (filasNuevas.length > 0) {
    _escribirInsertsSrv_(memAsig.hoja, filasNuevas);
  }

  _registrarLogMaestra_(adminSS,
    errores.length > 0 ? "PARTIAL" : "SUCCESS",
    invOk + invYaExistia + removidos,
    errores.join(" | "), ahora, usuario
  );

  return {
    asignados:             invOk + invYaExistia,
    removidos:             removidos,
    invitacionesOk:        invOk,
    invitacionesYaExistian: invYaExistia,
    errores:               errores
  };
}


// ════════════════════════════════════════════════════════════
// VALIDACIONES
// ════════════════════════════════════════════════════════════

function validarDocentesStaging(rows, idx) {
  if (!rows || rows.length === 0) throw new Error("Sin filas APPROVED/PENDING en STG_DOCENTES.");
  const emailsVistos = {};
  rows.forEach(function(row, i) {
    const accion = String(row[idx["RequestedAction"]] || "").trim();
    const email  = String(row[idx["Email"]]           || "").trim();
    const ctx    = "STG_DOCENTES[" + i + "] (" + email + ")";

    if (ACCIONES_DOCENTE_VALIDAS.indexOf(accion) === -1) {
      throw new Error(ctx + ": RequestedAction inválida → '" + accion + "'. " +
                      "Valores: " + ACCIONES_DOCENTE_VALIDAS.join(", "));
    }
    if (!email) throw new Error(ctx + ": Email vacío.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(ctx + ": Email inválido.");
    if (emailsVistos[email.toLowerCase()]) throw new Error(ctx + ": Email duplicado en el lote.");
    emailsVistos[email.toLowerCase()] = true;

    if (accion === "REGISTER" || accion === "UPDATE") {
      if (!row[idx["FirstName"]] || !row[idx["LastName"]]) {
        throw new Error(ctx + ": FirstName o LastName vacío.");
      }
      const contrato = String(row[idx["ContractType"]] || "").trim();
      if (contrato && CONTRATOS_VALIDOS_STG.indexOf(contrato) === -1) {
        throw new Error(ctx + ": ContractType inválido → '" + contrato + "'.");
      }
      const docType = String(row[idx["DocumentType"]] || "").trim();
      if (docType && TIPOS_DOC_VALIDOS_STG.indexOf(docType) === -1) {
        throw new Error(ctx + ": DocumentType inválido → '" + docType + "'.");
      }
    }
  });
}

function validarAsignacionesStaging(rows, idx) {
  if (!rows || rows.length === 0) return;
  rows.forEach(function(row, i) {
    const accion = String(row[idx["RequestedAction"]] || "").trim();
    const email  = String(row[idx["TeacherEmail"]]    || "").trim();
    const ctx    = "STG_ASIGNACIONES[" + i + "] (" + email + ")";

    if (ACCIONES_ASIG_VALIDAS.indexOf(accion) === -1) {
      throw new Error(ctx + ": RequestedAction inválida → '" + accion + "'. " +
                      "Valores: " + ACCIONES_ASIG_VALIDAS.join(", "));
    }
    if (!email) throw new Error(ctx + ": TeacherEmail vacío.");

    if (accion === "ASSIGN") {
      const prog = String(row[idx["ProgramCode"]] || "").trim();
      const mom  = String(row[idx["MomentCode"]]  || "").trim();
      if (!prog || TODOS_LOS_PROGRAMAS.indexOf(prog) === -1) {
        throw new Error(ctx + ": ProgramCode inválido → '" + prog + "'.");
      }
      if (!row[idx["SubjectCode"]]) throw new Error(ctx + ": SubjectCode vacío.");
      if (!row[idx["CohortCode"]])  throw new Error(ctx + ": CohortCode vacío.");
      if (!mom || MOMENT_ORDER[mom] === undefined) {
        throw new Error(ctx + ": MomentCode inválido → '" + mom + "'.");
      }
      const horas = Number(row[idx["WeeklyHours"]] || 0);
      if (isNaN(horas) || horas < 1) throw new Error(ctx + ": WeeklyHours inválidas.");
      const dia = String(row[idx["DayOfWeek"]] || "").trim();
      if (!dia) throw new Error(ctx + ": DayOfWeek vacío.");
      if (!row[idx["StartTime"]]) throw new Error(ctx + ": StartTime vacío.");
      if (!row[idx["EndTime"]])   throw new Error(ctx + ": EndTime vacío.");
    }
  });
}


// ════════════════════════════════════════════════════════════
// HELPERS — Lectura de maestras
// ════════════════════════════════════════════════════════════

function _leerHojaCompletaSrv_(ss, nombreHoja) {
  const hoja = ss.getSheetByName(nombreHoja);
  if (!hoja) throw new Error("Hoja '" + nombreHoja + "' no encontrada en '" + ss.getName() + "'.");
  const lastRow = hoja.getLastRow();
  const lastCol = hoja.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    return { hoja: hoja, nombreHoja: nombreHoja, encabezado: [], datos: [], colIdx: {}, datosOriginalesCount: 0 };
  }
  const todo       = hoja.getRange(1, 1, lastRow, lastCol).getValues();
  const encabezado = todo[0];
  let   datos      = lastRow > 1 ? todo.slice(1) : [];
  datos = datos.filter(function(f) { return f.some(function(c) { return c !== ""; }); });
  const colIdx = {};
  encabezado.forEach(function(n, i) { if (n !== "") colIdx[String(n)] = i; });
  return { hoja: hoja, nombreHoja: nombreHoja, encabezado: encabezado, datos: datos, colIdx: colIdx, datosOriginalesCount: datos.length };
}

function _verificarColumnasSrv_(mem, cols) {
  const faltantes = cols.filter(function(c) { return mem.colIdx[c] === undefined; });
  if (faltantes.length > 0) throw new Error("Columnas faltantes en '" + mem.nombreHoja + "': " + faltantes.join(", "));
}

function _construirEmailTeacherIdxSrv_(mem) {
  const idx = {};
  mem.datos.forEach(function(f) {
    const email = String(f[mem.colIdx["Email"]]     || "").toLowerCase().trim();
    const id    = String(f[mem.colIdx["TeacherID"]] || "").trim();
    if (email && id) idx[email] = id;
  });
  return idx;
}

function _indexarDeploymentsSrv_(mem) {
  const iId  = mem.colIdx["DeploymentID"];
  const iNom = mem.colIdx["GeneratedNomenclature"];
  const iCid = mem.colIdx["ClassroomID"];
  const iSt  = mem.colIdx["ScriptStatusCode"];
  if ([iId, iNom, iCid, iSt].some(function(c) { return c === undefined; })) {
    throw new Error("MasterDeployments: columnas requeridas faltantes.");
  }
  const idx = {};
  mem.datos.forEach(function(f) {
    const nom = String(f[iNom] || "").trim();
    const id  = String(f[iId]  || "").trim();
    if (!nom || !id) return;
    const s = nom.split("-");
    if (s.length >= 5) {
      idx[s[0] + "-" + s[2] + "-" + s[3] + "-" + s[4]] =
        { id: id, classroomId: String(f[iCid] || "").trim(), status: String(f[iSt] || "").trim() };
    }
  });
  return idx;
}

function _indexarAsignacionesExistentesSrv_(mem) {
  const idx    = {};
  const iTch   = mem.colIdx["TeacherID"];
  const iDep   = mem.colIdx["DeploymentID"];
  if (iTch === undefined || iDep === undefined) return idx;
  mem.datos.forEach(function(f) {
    const t = String(f[iTch] || "").trim();
    const d = String(f[iDep] || "").trim();
    if (t && d) idx[t + "_" + d] = true;
  });
  return idx;
}

function _leerContratoDocente_(memTeachers, email) {
  // TeacherAssignments guarda ContractTypeCode — lo sacamos de STG_DOCENTES vía mem si existe,
  // sino dejamos vacío y el staff lo corrige en la maestra.
  return "";
}


// ════════════════════════════════════════════════════════════
// HELPERS — Construcción y escritura de filas
// ════════════════════════════════════════════════════════════

function _construirFilaTeacher_(row, idx, mem, newId, ahora, usuario) {
  const c        = mem.colIdx;
  const nuevaFila = new Array(mem.encabezado.length).fill("");
  nuevaFila[c["TeacherID"]]         = newId;
  nuevaFila[c["FirstName"]]         = String(row[idx["FirstName"]]      || "").trim();
  nuevaFila[c["LastName"]]          = String(row[idx["LastName"]]       || "").trim();
  nuevaFila[c["Email"]]             = String(row[idx["Email"]]          || "").trim();
  nuevaFila[c["Phone"]]             = String(row[idx["Phone"]]          || "").trim();
  nuevaFila[c["DocumentType"]]      = String(row[idx["DocumentType"]]   || "").trim();
  nuevaFila[c["DocumentNumber"]]    = String(row[idx["DocumentNumber"]] || "").trim();
  nuevaFila[c["CampusCode"]]        = SIDEP_CONFIG.defaultCampus;
  nuevaFila[c["TeacherStatusCode"]] = "TEACHER_ACTIVE";
  nuevaFila[c["HireDate"]]          = _parseFechaSrv_(row[idx["HireDate"]]);
  nuevaFila[c["Notes"]]             = String(row[idx["Notes"]]          || "").trim();
  nuevaFila[c["CreatedAt"]]         = ahora;
  nuevaFila[c["CreatedBy"]]         = usuario;
  nuevaFila[c["UpdatedAt"]]         = ahora;
  nuevaFila[c["UpdatedBy"]]         = usuario;
  return nuevaFila;
}

function _actualizarFilaTeacher_(mem, filaIdx, row, idx, ahora, usuario) {
  const c = mem.colIdx;
  const f = mem.datos[filaIdx];
  if (row[idx["FirstName"]])      f[c["FirstName"]]      = String(row[idx["FirstName"]]      || "").trim();
  if (row[idx["LastName"]])       f[c["LastName"]]       = String(row[idx["LastName"]]       || "").trim();
  if (row[idx["Phone"]])          f[c["Phone"]]          = String(row[idx["Phone"]]          || "").trim();
  if (row[idx["DocumentType"]])   f[c["DocumentType"]]   = String(row[idx["DocumentType"]]   || "").trim();
  if (row[idx["DocumentNumber"]]) f[c["DocumentNumber"]] = String(row[idx["DocumentNumber"]] || "").trim();
  if (row[idx["ContractType"]])   f[c["ContractType"]]   = String(row[idx["ContractType"]]   || "").trim();
  if (row[idx["HireDate"]])       f[c["HireDate"]]       = _parseFechaSrv_(row[idx["HireDate"]]);
  if (row[idx["Notes"]])          f[c["Notes"]]          = String(row[idx["Notes"]]          || "").trim();
  f[c["UpdatedAt"]] = ahora;
  f[c["UpdatedBy"]] = usuario;
}

function _desactivarAsignacionSrv_(mem, teacherId, deplId, ahora, usuario) {
  const iTch   = mem.colIdx["TeacherID"];
  const iDep   = mem.colIdx["DeploymentID"];
  const iAct   = mem.colIdx["IsActive"];
  const iUpdAt = mem.colIdx["UpdatedAt"];
  const iUpdBy = mem.colIdx["UpdatedBy"];
  mem.datos.forEach(function(f) {
    if (String(f[iTch] || "").trim() === teacherId &&
        String(f[iDep] || "").trim() === deplId) {
      if (iAct   !== undefined) f[iAct]   = false;
      if (iUpdAt !== undefined) f[iUpdAt] = ahora;
      if (iUpdBy !== undefined) f[iUpdBy] = usuario;
    }
  });
}

function _escribirUpdatesSrv_(mem) {
  if (mem.datosOriginalesCount > 0) {
    mem.hoja.getRange(2, 1, mem.datosOriginalesCount, mem.encabezado.length)
            .setValues(mem.datos.slice(0, mem.datosOriginalesCount));
  }
}

function _escribirInsertsSrv_(hoja, filas) {
  const ultima = hoja.getLastRow();
  hoja.getRange(ultima + 1, 1, filas.length, filas[0].length).setValues(filas);
}


// ════════════════════════════════════════════════════════════
// CLASSROOM API — Invitaciones y remoción
// ════════════════════════════════════════════════════════════

/**
 * Envía invitación de co-teacher. 3 intentos, backoff 5/10/20s.
 * @returns {{ estado: "OK"|"YA_EXISTIA"|"ERROR", invitationId: string }}
 */
function _invitarCoTeacherConRetrySrv_(classroomId, email, logKey) {
  const esperas = [5000, 10000, 20000];
  for (let i = 1; i <= 3; i++) {
    try {
      const inv = Classroom.Invitations.create({ courseId: classroomId, userId: email, role: "TEACHER" });
      return { estado: "OK", invitationId: inv.id };
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.indexOf("409") !== -1 || msg.toLowerCase().indexOf("already") !== -1) {
        return { estado: "YA_EXISTIA", invitationId: "" };
      }
      if (msg.indexOf("403") !== -1 || msg.toLowerCase().indexOf("permission") !== -1) {
        Logger.log("  ⛔ 403 sin permiso: " + email + " → " + logKey);
        return { estado: "ERROR", invitationId: "" };
      }
      if (msg.indexOf("429") !== -1 || msg.toLowerCase().indexOf("quota") !== -1) {
        if (i < 3) { Utilities.sleep(esperas[i - 1]); continue; }
        return { estado: "ERROR", invitationId: "" };
      }
      Logger.log("  ⚠️  Intento " + i + "/3 [" + logKey + "]: " + msg);
      if (i < 3) Utilities.sleep(esperas[i - 1]);
    }
  }
  return { estado: "ERROR", invitationId: "" };
}

/**
 * Remueve un co-teacher del aula. No lanza Error si ya no existe (404 = ok).
 */
function _removerDocteaherClassroom_(classroomId, email, logKey) {
  try {
    Classroom.Courses.Teachers.remove(classroomId, email);
    Logger.log("  ✕ Removido de Classroom: " + email + " → " + logKey);
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.indexOf("404") !== -1) {
      Logger.log("  ℹ️  Docente ya no estaba en el aula: " + email + " → " + logKey);
    } else {
      throw new Error("Classroom remove error [" + logKey + "]: " + msg);
    }
  }
}


// ════════════════════════════════════════════════════════════
// HELPERS — Utilidades
// ════════════════════════════════════════════════════════════

/**
 * Valida que todos los campos obligatorios de una fila maestra tengan valor.
 * Compara contra MAESTRA_REQUIRED_COLS[tableName] (definido en 04_SIDEP_STAGING_TABLES).
 * Lanza Error con la lista de columnas vacías — el servicio lo captura por fila
 * y lo escribe en ValidationMessage de staging sin abortar el lote completo.
 *
 * @param {string}   tableName — "Teachers" | "TeacherAssignments"
 * @param {Array}    fila      — array de valores ya construido
 * @param {object}   colIdx    — { colName: colIndex } de la tabla maestra
 */
function _validarFilaMaestra_(tableName, fila, colIdx) {
  const requeridas = (typeof MAESTRA_REQUIRED_COLS !== "undefined" &&
                      MAESTRA_REQUIRED_COLS[tableName]) || [];
  const vacias = requeridas.filter(function(col) {
    const i = colIdx[col];
    if (i === undefined) return true;                    // columna no existe en la hoja — bug de schema
    const val = fila[i];
    return val === null || val === undefined || String(val).trim() === "";
  });
  if (vacias.length > 0) {
    throw new Error(
      "Campos obligatorios vacíos en " + tableName + ": " + vacias.join(", ")
    );
  }
}


/**
 * Convierte un valor de tiempo (Date de Sheets o string) a formato "HH:mm".
 * Sheets almacena "7:30 PM" como Date con fecha base 1899-12-30 19:30:00.
 */
function _parseTiempoSrv_(val) {
  if (!val && val !== 0) return "";
  if (val instanceof Date) {
    var h = val.getHours();
    var m = val.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  return String(val).trim();
}

function _parseFechaSrv_(fechaStr) {
  if (!fechaStr) return "";
  // Sheets entrega fechas como objetos Date — devolverlos directamente
  if (fechaStr instanceof Date) return isNaN(fechaStr.getTime()) ? "" : fechaStr;
  try {
    const str = String(fechaStr).trim();
    if (!str) return "";
    // Intentar yyyy-MM-dd (ISO)
    var d = Utilities.parseDate(str, SIDEP_CONFIG.timezone, "yyyy-MM-dd");
    if (!isNaN(d.getTime())) return d;
    // Intentar M/d/yyyy (formato US que muestra Sheets al convertir a string)
    d = Utilities.parseDate(str, SIDEP_CONFIG.timezone, "M/d/yyyy");
    if (!isNaN(d.getTime())) return d;
    // Intentar dd/MM/yyyy (formato colombiano)
    d = Utilities.parseDate(str, SIDEP_CONFIG.timezone, "dd/MM/yyyy");
    return isNaN(d.getTime()) ? "" : d;
  } catch (e) { return ""; }
}

function _registrarLogMaestra_(adminSS, resultado, registros, errorMsg, ahora, usuario) {
  try {
    const hoja = adminSS.getSheetByName("AutomationLogs");
    if (!hoja) return;
    hoja.appendRow([uuid("log"), "SHEETS", "IMPORT_TEACHERS", "procesarStgDocentes",
                    resultado, registros, errorMsg || "", ahora, usuario]);
  } catch (e) {
    Logger.log("⚠️  No se pudo escribir AutomationLog: " + e.message);
  }
}
